// 把 PTY、hub 連線、hook socket、approval、資源與用量接在一起。狀態機與 hook 安裝由外部注入。
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, resolve } from 'node:path';
import {
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  HOOK_COMMAND,
  HOOK_ENV,
  MachineOs,
  type DaemonToHub,
  type HookRequest,
  type HubToDaemon,
  type MachineCapabilities,
  type SessionRuntime,
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
import {
  createWorktree,
  currentBranch,
  findLinkedWorktree,
  removeWorktree,
  repoInfo,
  type WorktreeInfo,
} from './worktree';

const USAGE_INTERVAL_MS = 15 * 60_000;
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** 結束的 session 還留著畫面給人看，超過就丟最舊的。 */
const MAX_ENDED_SESSIONS = 20;
const MAX_EVENT_TEXT = 8_000;
/** 不能讓 claude 及其子程序讀到的環境變數。 */
const SECRET_ENV = [
  'AGENT_BOARD_MACHINE_TOKEN',
  // daemon 若是從某個 Claude Code session 裡啟動，會繼承這些標記：claude 會把自己當成子 session，
  // 不存對話紀錄（--resume 與用量統計都會失效），MESSAGING_TOKEN 還是憑證。
  // 只列 session 標記，CLAUDE_CODE_USE_BEDROCK 之類是使用者的設定，要保留。
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SPAWN_BACKEND',
  'CLAUDE_PID',
];

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
  idleResizeMs?: number;
  heartbeatMs?: number;
  approvalWaitMs?: number;
  authRetryMs?: number;
  revokedGraceMs?: number;
}

/**
 * token 被拒多久後停掉本機 session。機器在離線時被移除，hub 沒機會送 session.stop，
 * 沒人看管的 claude 不能一直跑；等一下是為了 hub 只是暫時設定錯（換資料庫、還原備份）時有機會修。
 * 對話紀錄還在，重新配對後可用 --resume 接回。
 */
const REVOKED_GRACE_MS = 10 * 60_000;

const pathKey = (env: NodeJS.ProcessEnv): string =>
  // Windows 的環境變數不分大小寫，實際鍵名常是 Path。
  process.platform === 'win32'
    ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH')
    : 'PATH';

/** 回傳實際找到的絕對路徑，找不到丟例外。 */
function findExecutable(bin: string, env: NodeJS.ProcessEnv): string {
  const hasDir = bin.includes('/') || bin.includes('\\');
  const dirs = hasDir ? [''] : (env[pathKey(env)] ?? '').split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = resolve(dir, bin + ext);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 繼續找
      }
    }
  }
  throw new Error(`找不到可執行的 ${bin}`);
}

/**
 * hook 找不到時 Claude Code 只當成非阻擋錯誤、照常執行工具，危險指令檢查會被靜默跳過，
 * 所以找不到就不開 session（CONTRACTS §4.3）。settings 裡寫死的指令是 agent-board-hook，
 * 靠 PATH 解析，覆寫的檔案不叫這個名字一樣會找不到。
 */
function findHook(bin: string, env: NodeJS.ProcessEnv): string {
  const found = findExecutable(bin, env);
  const name = basename(found, extname(found));
  if (name !== HOOK_COMMAND) {
    throw new Error(`hook 執行檔必須命名為 ${HOOK_COMMAND}，目前是 ${basename(found)}`);
  }
  return found;
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

/**
 * 交接要列「偵測到的檔案改動」。只有這四種工具看得到路徑：透過 Bash 改的檔案（sed、mv、產生器）不會有事件，
 * 所以清單不代表全部。只回傳路徑，內容不進事件。
 */
function editedFilePath(payload: HookRequest['payload']): string | null {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const path =
    payload.tool_name === 'NotebookEdit'
      ? input?.notebook_path
      : payload.tool_name === 'Write' ||
          payload.tool_name === 'Edit' ||
          payload.tool_name === 'MultiEdit'
        ? input?.file_path
        : undefined;
  return typeof path === 'string' && path !== '' ? path : null;
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
  private usageReportedOnConnect = false;
  private stopping = false;
  private revokedTimer: NodeJS.Timeout | null = null;

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
      authRetryMs: deps.authRetryMs,
      onAuthRejected: () => this.handleAuthRejected(),
      buildHello: () => this.buildHello(),
      onMessage: (message) => this.handleHubMessage(message),
      onDisconnected: () => this.handleHubDisconnected(),
    });
    this.approvals = new ApprovalManager({
      send: (message) => this.send(message),
      dangerRules: () => this.dangerRules,
      onDangerPending: (sessionId, payload) =>
        this.sessions
          .get(sessionId)
          ?.onHook('PermissionRequest', { ...payload, hook_event_name: 'PermissionRequest' }),
      onDecided: (approval) => {
        const session = this.sessions.get(approval.sessionId);
        session?.onHook('PreToolUse', {
          session_id: session.runtime().claudeSessionId ?? '',
          hook_event_name: 'PreToolUse',
          tool_name: approval.toolName,
          tool_input: approval.toolInput,
        });
      },
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
    this.clearRevokedTimer();
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

  private handleAuthRejected(): void {
    if (this.revokedTimer || this.stopping) return;
    this.revokedTimer = setTimeout(() => {
      this.revokedTimer = null;
      const alive = [...this.sessions.values()].filter((s) => s.isAlive);
      log.error(`token 持續被 hub 拒絕，機器應已被移除：停止本機 ${alive.length} 個 session。`);
      for (const session of alive) session.terminate();
    }, this.deps.revokedGraceMs ?? REVOKED_GRACE_MS);
    this.revokedTimer.unref();
  }

  private clearRevokedTimer(): void {
    if (this.revokedTimer) clearTimeout(this.revokedTimer);
    this.revokedTimer = null;
  }

  private handleHubDisconnected(): void {
    this.usageReportedOnConnect = false;
    // hub 重連後會重新訂閱（CONTRACTS §6.1），這裡回到沒人看的狀態。
    this.resources.stop();
    for (const session of this.sessions.values()) session.unsubscribe();
  }

  private handleHubMessage(message: HubToDaemon): void {
    switch (message.type) {
      case 'hub.welcome':
        this.clearRevokedTimer();
        // 設定變更時 hub 會重送 welcome；用量每條連線只需要補報一次。
        this.applyHubSettings(message.dangerRules, message.stuckMinutes);
        for (const runtime of this.store.endedRuntimes) this.deliverEnded(runtime);
        if (!this.usageReportedOnConnect) {
          this.usageReportedOnConnect = true;
          void this.reportUsage();
        }
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
    if (existing?.isAlive) {
      this.send({ type: 'session.created', requestId, session: existing.runtime() });
      return;
    }
    let worktree: WorktreeInfo | null = null;
    try {
      if (this.stopping) throw new Error('daemon 正在關閉');
      this.assertCanLaunch();
      assertDirectory(spec.cwd);
      if (spec.useWorktree) worktree = await createWorktree(spec.cwd, spec.name, sessionId);
      await this.installHooksOrThrow(worktree?.cwd ?? spec.cwd);
      const persisted: PersistedSession = {
        sessionId,
        spec: { ...spec, firstPrompt: null },
        claudeSessionId: spec.resumeClaudeSessionId ?? randomUUID(),
        cwd: worktree?.cwd ?? spec.cwd,
        branch: worktree?.branch ?? (await currentBranch(spec.cwd)),
        // 接續舊對話時 hub 把原 worktree 當 cwd 傳來，worktreePath 不能因此變成 null。
        worktreePath:
          worktree?.worktreePath ??
          (spec.resumeClaudeSessionId ? await findLinkedWorktree(spec.cwd) : null),
        pendingFirstPrompt: spec.firstPrompt,
        createdAt: new Date().toISOString(),
      };
      // 已結束的同一個 session 被接續（/api/sessions/:id/resume）：換成新的 PTY 與畫面。
      if (existing) {
        existing.dispose();
        this.sessions.delete(sessionId);
      }
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

  private assertCanLaunch(): void {
    const env = this.childEnv();
    findExecutable(this.deps.config.claudeBin, env);
    findHook(this.deps.config.hookBin, env);
  }

  private async resumePersistedSessions(): Promise<void> {
    if (this.store.sessions.length === 0) return;
    try {
      this.assertCanLaunch();
    } catch (error) {
      // 環境問題（PATH 沒設好之類）修好就能接回，清單要留著；這次只是都不開。
      log.error(`本次不接回任何 session：${errorMessage(error)}`);
      return;
    }
    for (const entry of [...this.store.sessions]) {
      try {
        assertDirectory(entry.cwd);
      } catch (error) {
        // 接不回來就從清單移除，否則每次重啟都再失敗一次。hub 由 hello 得知它不在了。
        log.error(`無法接回 session ${entry.sessionId}：${errorMessage(error)}`);
        this.store.remove(entry.sessionId);
        continue;
      }
      try {
        await this.installHooksOrThrow(entry.cwd);
      } catch (error) {
        // 使用者修好設定檔就能接回，清單留著；沒裝上 hook 不可開 PTY。
        log.error(`這次不接回 session ${entry.sessionId}：${errorMessage(error)}`);
        continue;
      }
      try {
        await this.launch(entry, { resumeId: entry.claudeSessionId });
      } catch (error) {
        log.error(`無法接回 session ${entry.sessionId}：${errorMessage(error)}`);
        this.store.remove(entry.sessionId);
      }
    }
  }

  /** hook 沒裝上時危險指令檢查不會執行，各種權限模式都不開 PTY（CONTRACTS §4.1）。 */
  private async installHooksOrThrow(cwd: string): Promise<void> {
    try {
      await this.deps.installHooks(cwd);
    } catch (error) {
      throw new Error(
        `無法安裝 hook 設定（${errorMessage(error)}）。請修好 ${cwd}/.claude/settings.local.json，再重新開啟 session。`,
      );
    }
  }

  private async launch(
    entry: PersistedSession,
    how: { resumeId: string } | { newSessionId: string },
  ): Promise<ManagedSession> {
    const { spec, sessionId } = entry;
    // 接續同一個 session：上一輪還沒送出的結果已不適用，不可蓋掉新的狀態。
    this.store.removeEnded(sessionId);
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
      repo: await repoInfo(entry.cwd),
      model: spec.model,
      claudeSessionId: entry.claudeSessionId,
      pendingFirstPrompt: entry.pendingFirstPrompt,
      stuckMinutes: this.stuckMinutes,
      createStatusTracker: this.deps.createStatusTracker,
      runtimeThrottleMs: this.deps.runtimeThrottleMs,
      terminateGraceMs: this.deps.terminateGraceMs,
      idleResizeMs: this.deps.idleResizeMs,
      onRuntime: (session) => {
        if (session.endedAt !== null) this.recordEnded(session);
        else this.send({ type: 'session.runtime', session });
      },
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
    return session;
  }

  private handleSessionExit(sessionId: string, exitCode: number): void {
    this.approvals.cancelSession(sessionId);
    // 先記結果再移出接回清單，中間崩潰也不會兩邊都沒有。
    const session = this.sessions.get(sessionId);
    if (session) this.recordEnded(session.runtime());
    this.store.remove(sessionId);
    this.emitEvent(sessionId, 'exit', { exitCode });
    this.evictEndedSessions();
  }

  /** 結果先落地再送；確定寫進 socket 才移除，斷線或 daemon 重啟後都會在 welcome 後補送。 */
  private recordEnded(runtime: SessionRuntime): void {
    this.store.setEnded(runtime);
    this.deliverEnded(runtime);
  }

  private deliverEnded(runtime: SessionRuntime): void {
    this.hub.sendConfirmed({ type: 'session.runtime', session: runtime }, (sent) => {
      if (sent && this.store.isCurrentEnded(runtime)) this.store.removeEnded(runtime.id);
    });
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
    const env = this.childEnv();
    // 確保 settings 裡的 agent-board-hook 解析到剛才檢查過的那一支。
    const hookDir = dirname(findHook(this.deps.config.hookBin, env));
    const key = pathKey(env);
    return {
      ...env,
      [key]: [hookDir, env[key]].filter(Boolean).join(delimiter),
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
      // 每次工具呼叫都有，太吵；狀態變化另有 status 事件。
      if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') {
        this.emitEvent(sessionId, 'hook', summarizeHook(event, payload));
      }
      const edited = event === 'PostToolUse' ? editedFilePath(payload) : null;
      if (edited !== null) this.emitEvent(sessionId, 'file.changed', { path: edited });
    } else if (event !== 'PreToolUse') {
      return null;
    }
    this.approvals.settleAnsweredInTerminal(event, sessionId, payload);
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
