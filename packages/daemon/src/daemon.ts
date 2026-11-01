// 把 PTY、hub 連線、hook socket、approval、資源與用量接在一起。狀態機與 hook 安裝由外部注入。
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  HOOK_ENV,
  MachineOs,
  type DaemonToHub,
  type HookRequest,
  type HubToDaemon,
  type MachineCapabilities,
  type SessionSpec,
} from '@agent-board/protocol';
import pkg from '../package.json' with { type: 'json' };
import { ApprovalManager } from './approvals';
import type { DaemonConfig } from './config';
import { listDirectory } from './fsList';
import { HookServer, type HookOutput } from './hookServer';
import { HubClient } from './hubClient';
import { errorMessage, log } from './log';
import { probeCapabilities, ResourceMonitor, type ResourceMonitorOptions } from './resources';
import { buildClaudeArgs, ManagedSession } from './session';
import type { CreateStatusTracker } from './status/types';
import { SessionStore, type PersistedSession } from './store';
import { summarizeUsage } from './usage';
import { createWorktree, currentBranch, removeWorktree, type WorktreeInfo } from './worktree';

const USAGE_INTERVAL_MS = 15 * 60_000;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** 結束的 session 還留著畫面給人看，超過就丟最舊的。 */
const MAX_ENDED_SESSIONS = 20;
const MAX_EVENT_TEXT = 8_000;
/** 不能讓 claude 及其子程序讀到的環境變數。 */
const SECRET_ENV = ['AGENT_BOARD_MACHINE_TOKEN'];

export interface DaemonDeps {
  config: DaemonConfig;
  createStatusTracker: CreateStatusTracker;
  installHooks: (cwd: string) => Promise<void>;
  /** 給 claude 的基礎環境變數，預設 process.env。 */
  baseEnv?: NodeJS.ProcessEnv;
  resources?: Partial<
    Pick<ResourceMonitorOptions, 'sampleCpuMem' | 'sampleGpu' | 'cpuIntervalMs' | 'gpuIntervalMs'>
  >;
  capabilities?: MachineCapabilities;
  runtimeThrottleMs?: number;
  terminateGraceMs?: number;
  heartbeatMs?: number;
  approvalWaitMs?: number;
}

function assertExecutable(bin: string, env: NodeJS.ProcessEnv): void {
  // Windows 要考慮 PATHEXT，交給 node-pty 自己報錯。
  if (process.platform === 'win32') return;
  const candidates = bin.includes('/')
    ? [bin]
    : (env.PATH ?? '').split(delimiter).map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return;
    } catch {
      // 繼續找
    }
  }
  throw new Error(`找不到可執行的 ${bin}`);
}

function assertDirectory(path: string): void {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    // 下面統一報錯
  }
  if (!isDir) throw new Error(`工作資料夾不存在：${path}`);
}

/** 只保留 session_events 需要的欄位；prompt、工具輸入不進事件。 */
function summarizeHook(event: HookRequest['event'], payload: HookRequest['payload']) {
  const summary: Record<string, unknown> = { event };
  for (const key of ['notification_type', 'source', 'reason', 'error', 'tool_name'] as const) {
    if (typeof payload[key] === 'string') summary[key] = payload[key];
  }
  // 交接摘要的來源（docs/claude-code-notes.md）。
  if (typeof payload.last_assistant_message === 'string') {
    summary.last_assistant_message = payload.last_assistant_message.slice(0, MAX_EVENT_TEXT);
  }
  return summary;
}

export class Daemon {
  private readonly store: SessionStore;
  private readonly hub: HubClient;
  private readonly hookServer: HookServer;
  private readonly approvals: ApprovalManager;
  private readonly resources: ResourceMonitor;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creating = new Map<string, Promise<void>>();
  private readonly accountProfiles = new Set<string>();
  private readonly baseEnv: NodeJS.ProcessEnv;
  private dangerRules: string[];
  private stuckMinutes: number;
  private capabilities: MachineCapabilities | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private usageRunning = false;
  private stopping = false;

  constructor(private readonly deps: DaemonDeps) {
    const { config } = deps;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.store = new SessionStore(config.dataDir);
    // hub 還沒連上時也要擋危險指令：用上次下發的規則，再不然用預設值。
    this.dangerRules = this.store.dangerRules ?? DEFAULT_DANGER_RULES;
    this.stuckMinutes = this.store.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
    this.hub = new HubClient({
      url: config.hubUrl,
      token: config.token,
      heartbeatMs: deps.heartbeatMs,
      buildHello: () => this.buildHello(),
      onMessage: (message) => this.handleHubMessage(message),
      onDisconnected: () => this.handleHubDisconnected(),
    });
    this.approvals = new ApprovalManager({
      send: (message) => this.send(message),
      dangerRules: () => this.dangerRules,
      waitMs: deps.approvalWaitMs,
    });
    this.resources = new ResourceMonitor({
      send: (message) => this.send(message),
      ...deps.resources,
    });
    this.hookServer = new HookServer(config.dataDir, (request, signal) =>
      this.handleHook(request, signal),
    );
  }

  get hookSocketPath(): string {
    return this.hookServer.path;
  }

  async start(): Promise<void> {
    await this.hookServer.start();
    this.capabilities =
      this.deps.capabilities ??
      (await probeCapabilities(this.deps.config.claudeBin, this.childEnv()));
    // 先把 session 接回來（status=starting），第一則 hello 才對得上帳（CONTRACTS §3.2）。
    await this.resumePersistedSessions();
    this.hub.start();
    this.usageTimer = setInterval(() => void this.reportUsage(), USAGE_INTERVAL_MS);
    this.usageTimer.unref();
  }

  /** 關閉 daemon：PTY 一起結束，但本機清單保留，下次啟動用 --resume 接回。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    this.resources.stop();
    await Promise.allSettled(this.creating.values());
    this.approvals.dispose();
    await Promise.all([...this.sessions.values()].map((s) => s.detachAndKill()));
    this.sessions.clear();
    this.hub.stop();
    await this.hookServer.close();
  }

  // ── hub ──────────────────────────────────────────────────

  private send(message: DaemonToHub): void {
    this.hub.send(message);
  }

  private buildHello(): Extract<DaemonToHub, { type: 'daemon.hello' }> {
    if (!this.capabilities) throw new Error('capabilities 尚未就緒');
    return {
      type: 'daemon.hello',
      name: this.deps.config.machineName,
      os: MachineOs.parse(process.platform),
      version: pkg.version,
      capabilities: this.capabilities,
      sessions: [...this.sessions.values()].filter((s) => s.isAlive).map((s) => s.runtime()),
      pendingApprovals: this.approvals.pending(),
    };
  }

  private handleHubDisconnected(): void {
    // hub 重連後會重新訂閱（CONTRACTS §6.1），這裡回到沒人看的狀態。
    this.resources.stop();
    for (const session of this.sessions.values()) session.unsubscribe();
  }

  private handleHubMessage(message: HubToDaemon): void {
    switch (message.type) {
      case 'hub.welcome':
        this.applyHubSettings(message.dangerRules, message.stuckMinutes);
        void this.reportUsage();
        return;
      case 'session.create':
        void this.createSession(message.requestId, message.sessionId, message.spec);
        return;
      case 'session.stop':
        this.withSession(message.sessionId, message.type, (s) => s.terminate());
        return;
      case 'terminal.subscribe':
        this.withSession(message.sessionId, message.type, (s) => s.subscribe());
        return;
      case 'terminal.unsubscribe':
        this.withSession(message.sessionId, message.type, (s) => s.unsubscribe());
        return;
      case 'terminal.input':
        this.withSession(message.sessionId, message.type, (s) => s.write(message.data));
        return;
      case 'terminal.resize':
        this.withSession(message.sessionId, message.type, (s) =>
          s.resize(message.cols, message.rows),
        );
        return;
      case 'terminal.signal':
        this.withSession(message.sessionId, message.type, (s) => {
          if (message.signal === 'escape') s.write('\x1b');
          else if (message.signal === 'ctrl_c') s.write('\x03');
          else s.terminate();
        });
        return;
      case 'approval.decide':
        if (!this.approvals.decide(message.approvalId, message.sessionId, message.decision)) {
          log.warn(`approval ${message.approvalId} 已不在等待，忽略此決定`);
        }
        return;
      case 'resources.watch':
        this.resources.setWatching(message.watching);
        return;
      case 'fs.list':
        void listDirectory(message.requestId, message.path).then((result) => this.send(result));
        return;
      default:
        message satisfies never;
    }
  }

  private withSession(id: string, action: string, fn: (session: ManagedSession) => void): void {
    const session = this.sessions.get(id);
    if (!session) {
      log.warn(`${action}：找不到 session ${id}`);
      return;
    }
    fn(session);
  }

  private applyHubSettings(dangerRules: string[], stuckMinutes: number): void {
    this.dangerRules = dangerRules;
    this.stuckMinutes = stuckMinutes;
    this.store.setHubSettings(dangerRules, stuckMinutes);
    for (const session of this.sessions.values()) session.setStuckMinutes(stuckMinutes);
  }

  // ── session 生命週期 ─────────────────────────────────────

  private createSession(requestId: string, sessionId: string, spec: SessionSpec): Promise<void> {
    // hub 重送同一個 session.create 時不可開第二個 PTY。
    const task = (this.creating.get(sessionId) ?? Promise.resolve()).then(() =>
      this.createSessionOnce(requestId, sessionId, spec),
    );
    const tracked = task.finally(() => {
      if (this.creating.get(sessionId) === tracked) this.creating.delete(sessionId);
    });
    this.creating.set(sessionId, tracked);
    return tracked;
  }

  private async createSessionOnce(
    requestId: string,
    sessionId: string,
    spec: SessionSpec,
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.send({ type: 'session.created', requestId, session: existing.runtime() });
      return;
    }
    let worktree: WorktreeInfo | null = null;
    try {
      if (this.stopping) throw new Error('daemon 正在關閉');
      assertExecutable(this.deps.config.claudeBin, this.childEnv());
      assertDirectory(spec.cwd);
      if (spec.useWorktree) worktree = await createWorktree(spec.cwd, spec.name, sessionId);
      const persisted: PersistedSession = {
        sessionId,
        spec: { ...spec, firstPrompt: null },
        claudeSessionId: spec.resumeClaudeSessionId ?? randomUUID(),
        cwd: worktree?.cwd ?? spec.cwd,
        branch: worktree?.branch ?? (await currentBranch(spec.cwd)),
        worktreePath: worktree?.worktreePath ?? null,
        pendingFirstPrompt: spec.firstPrompt,
        createdAt: new Date().toISOString(),
      };
      const session = await this.launch(
        persisted,
        spec.resumeClaudeSessionId
          ? { resumeId: spec.resumeClaudeSessionId }
          : { newSessionId: persisted.claudeSessionId },
      );
      this.store.upsert(persisted);
      this.send({ type: 'session.created', requestId, session: session.runtime() });
    } catch (error) {
      if (worktree) {
        await removeWorktree(worktree).catch((cleanupError: unknown) =>
          log.warn(`清除 worktree 失敗：${errorMessage(cleanupError)}`),
        );
      }
      this.send({ type: 'session.createFailed', requestId, error: errorMessage(error) });
    }
  }

  private async resumePersistedSessions(): Promise<void> {
    for (const entry of [...this.store.sessions]) {
      try {
        assertExecutable(this.deps.config.claudeBin, this.childEnv());
        assertDirectory(entry.cwd);
        await this.launch(entry, { resumeId: entry.claudeSessionId });
      } catch (error) {
        // 接不回來就從清單移除，否則每次重啟都再失敗一次。hub 由 hello 得知它不在了。
        log.error(`無法接回 session ${entry.sessionId}：${errorMessage(error)}`);
        this.store.remove(entry.sessionId);
      }
    }
  }

  private async launch(
    entry: PersistedSession,
    how: { resumeId: string } | { newSessionId: string },
  ): Promise<ManagedSession> {
    const { spec, sessionId } = entry;
    let hookWarning: string | null = null;
    try {
      await this.deps.installHooks(entry.cwd);
    } catch (error) {
      // 使用者的設定檔可能壞了（不會去動它）：session 照開，但沒有狀態偵測與危險指令攔截。
      hookWarning = errorMessage(error);
    }
    if (spec.accountProfile) this.accountProfiles.add(spec.accountProfile);

    const session = new ManagedSession({
      id: sessionId,
      bin: this.deps.config.claudeBin,
      args: buildClaudeArgs({
        ...how,
        permissionMode: spec.permissionMode,
        model: spec.model,
        name: spec.name,
      }),
      env: this.sessionEnv(sessionId, spec),
      cwd: entry.cwd,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      claudeSessionId: entry.claudeSessionId,
      // 沒裝到 hook 就不會有 SessionStart，下面的警告會說明 firstPrompt 沒送。
      pendingFirstPrompt: entry.pendingFirstPrompt,
      stuckMinutes: this.stuckMinutes,
      createStatusTracker: this.deps.createStatusTracker,
      runtimeThrottleMs: this.deps.runtimeThrottleMs,
      terminateGraceMs: this.deps.terminateGraceMs,
      onRuntime: (session) => this.send({ type: 'session.runtime', session }),
      onStatusChange: (change) =>
        this.emitEvent(sessionId, 'status', {
          from: change.from,
          to: change.to,
          reason: change.reason,
          detail: change.detail,
        }),
      onTerminal: (message) => this.send(message),
      onClaudeSessionId: (claudeSessionId) => this.store.patch(sessionId, { claudeSessionId }),
      onFirstPromptSent: () => this.store.patch(sessionId, { pendingFirstPrompt: null }),
      onExit: (exitCode) => this.handleSessionExit(sessionId, exitCode),
    });
    this.sessions.set(sessionId, session);
    if (hookWarning !== null) {
      this.emitEvent(sessionId, 'warning', {
        code: 'hook_install_failed',
        message: hookWarning,
        firstPromptSkipped: entry.pendingFirstPrompt !== null,
      });
    }
    return session;
  }

  private handleSessionExit(sessionId: string, exitCode: number): void {
    this.approvals.cancelSession(sessionId);
    this.store.remove(sessionId);
    this.emitEvent(sessionId, 'exit', { exitCode });
    this.evictEndedSessions();
  }

  private evictEndedSessions(): void {
    const ended = [...this.sessions.values()].filter((s) => !s.isAlive);
    for (const session of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_SESSIONS))) {
      session.dispose();
      this.sessions.delete(session.id);
    }
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.baseEnv)) {
      if (value !== undefined && !SECRET_ENV.includes(key)) env[key] = value;
    }
    return env;
  }

  private sessionEnv(sessionId: string, spec: SessionSpec): Record<string, string> {
    return {
      ...this.childEnv(),
      [HOOK_ENV.sessionId]: sessionId,
      [HOOK_ENV.socket]: this.hookServer.path,
      TERM: 'xterm-256color',
      ...(spec.accountProfile ? { CLAUDE_CONFIG_DIR: spec.accountProfile } : {}),
    };
  }

  private emitEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.send({
      type: 'session.event',
      event: { id: randomUUID(), sessionId, type, payload, at: new Date().toISOString() },
    });
  }

  // ── hook ─────────────────────────────────────────────────

  private async handleHook(request: HookRequest, signal: AbortSignal): Promise<HookOutput> {
    const { event, sessionId, payload } = request;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.onHook(event, payload);
      this.emitEvent(sessionId, 'hook', summarizeHook(event, payload));
    } else if (event !== 'PreToolUse') {
      return null;
    }
    // 不認得的 session 也照樣比對危險指令，往安全的方向。
    return this.approvals.handleHook(event, sessionId, payload, signal);
  }

  // ── 用量 ─────────────────────────────────────────────────

  private async reportUsage(): Promise<void> {
    if (this.usageRunning || !this.hub.connected) return;
    this.usageRunning = true;
    try {
      const to = new Date();
      const from = new Date(to.getTime() - USAGE_WINDOW_MS);
      const summary = await summarizeUsage(
        [this.deps.config.claudeConfigDir, ...this.accountProfiles],
        from,
        to,
      );
      this.send({ type: 'usage', summary });
    } catch (error) {
      log.warn(`用量統計失敗：${errorMessage(error)}`);
    } finally {
      this.usageRunning = false;
    }
  }
}
