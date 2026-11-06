// 把 PTY、hub 連線、hook socket、approval、資源與用量接在一起。狀態機與 hook 安裝由外部注入。
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, resolve, sep } from 'node:path';
import {
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  HOOK_COMMAND,
  HOOK_ENV,
  MachineOs,
  type DaemonToHub,
  type HookRequest,
  type HubToDaemon,
  type McpRequest,
  type MachineCapabilities,
  type SessionRuntime,
  type SessionSpec,
} from '@agent-board/protocol';
import pkg from '../package.json' with { type: 'json' };
import { ApprovalManager } from './approvals';
import type { DaemonConfig } from './config';
import { listDirectory, makeDirectory } from './fsList';
import { hookSettingsLockKey, withFileLock } from './fileLock';
import { HookServer, type HookOutput } from './hookServer';
import { HubClient } from './hubClient';
import { errorMessage, log } from './log';
import {
  clearMcpDir,
  DISPATCH_TOOL_NAMES,
  removeMcpFiles,
  secretMatches,
  writeMcpFiles,
} from './mcpFiles';
import { probeCapabilities, ResourceMonitor, type ResourceMonitorOptions } from './resources';
import { buildClaudeArgs, ManagedSession } from './session';
import { claudeConfigFor, findTranscriptFiles, inspectSession, purgeSession } from './sessionFiles';
import type { CreateStatusTracker } from './status/types';
import { SessionStore, type PersistedSession } from './store';
import { readTranscript } from './transcript';
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
/** 派工工具等 hub 回答的上限；超過就告訴 Claude 稍後再試。 */
const DISPATCH_REPLY_TIMEOUT_MS = 30_000;
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
  dispatchReplyTimeoutMs?: number;
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

const realDir = (dir: string): Promise<string> => realpath(dir).catch(() => resolve(dir));

/** path（已 realpath）等於或落在任一 dirs 裡。 */
function within(path: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
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
  /** 正在清理檔案的 session（§9.6）：期間不能建立；同一個 id 的 purge 依序執行。 */
  private readonly purging = new Set<string>();
  private readonly purgeChains = new Map<string, Promise<void>>();
  /**
   * 清理中的 worktree 與 cwd（realpath），以 session id 為鍵。新 session 開在這些資料夾裡一律拒絕：
   * hub 的鎖可能已經不在（斷線、到期、hub 重啟），這是第二道防線（§9.6）。
   */
  private readonly purgingDirs = new Map<string, string[]>();
  /** 每個 session 的工作資料夾 realpath（建立中先記 spec.cwd，開起來後換成實際 cwd），purge 用來找「其他」session。 */
  private readonly sessionDirs = new Map<string, string>();
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
  /** `Settings.dispatch`（hub.welcome 下發）：新開的 PTY 要不要掛派工工具。 */
  private dispatchEnabled: boolean;
  /** 每個活著的 session 這次 PTY 的派工密鑰（只在記憶體，檔案另存 0600）。 */
  private readonly mcpSecrets = new Map<string, string>();
  private readonly dispatchRequests = new Map<
    string,
    { resolve: (reply: { ok: boolean; text: string }) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly deps: DaemonDeps) {
    const { config } = deps;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.store = new SessionStore(config.dataDir);
    // hub 還沒連上時也要擋危險指令：用上次下發的規則，再不然用預設值。
    this.dangerRules = this.store.dangerRules ?? DEFAULT_DANGER_RULES;
    this.stuckMinutes = this.store.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
    this.dispatchEnabled = this.store.dispatch;
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
    this.hookServer = new HookServer(
      config.dataDir,
      (request, signal) => this.handleHook(request, signal),
      (request) => this.handleMcp(request),
    );
  }

  get hookSocketPath(): string {
    return this.hookServer.path;
  }

  async start(): Promise<void> {
    // 上次留下的派工設定與密鑰都作廢：記憶體裡的密鑰已經不在，每個 PTY 會拿到新的。
    clearMcpDir(this.deps.config.dataDir);
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
    this.mcpSecrets.clear();
    this.settleDispatchRequests('hub_unreachable: Agent Board daemon is shutting down.');
    clearMcpDir(this.deps.config.dataDir);
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
    this.settleDispatchRequests(
      'hub_unreachable: Agent Board lost its connection to the hub. Try again in a minute.',
    );
  }

  private handleHubMessage(message: HubToDaemon): void {
    switch (message.type) {
      case 'hub.welcome':
        this.clearRevokedTimer();
        // 設定變更時 hub 會重送 welcome；用量每條連線只需要補報一次。
        this.applyHubSettings(message.dangerRules, message.stuckMinutes, message.dispatch === true);
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
      case 'fs.mkdir':
        void makeDirectory(message.requestId, message.parent, message.name).then((result) =>
          this.send(result),
        );
        return;
      case 'session.inspect':
      case 'session.purge':
      case 'session.transcript':
        void this.handleSessionFiles(message);
        return;
      case 'dispatch.reply': {
        const pending = this.dispatchRequests.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.dispatchRequests.delete(message.requestId);
        pending.resolve({ ok: message.ok, text: message.text });
        return;
      }
      default:
        message satisfies never;
    }
  }

  /** 封存與刪除（CONTRACTS §9）：例外一律變成 error 回給 hub，不讓它等到逾時。 */
  private async handleSessionFiles(
    message: Extract<
      HubToDaemon,
      { type: 'session.inspect' | 'session.purge' | 'session.transcript' }
    >,
  ): Promise<void> {
    const { requestId } = message;
    const configDir = this.deps.config.claudeConfigDir;
    try {
      switch (message.type) {
        case 'session.inspect': {
          const inspect = await inspectSession(message.target, configDir);
          this.send({ type: 'session.inspectResult', requestId, inspect, error: null });
          return;
        }
        case 'session.purge':
          await this.purgeSerialized(message);
          return;
        case 'session.transcript': {
          const page = await readTranscript(
            claudeConfigFor(message.accountProfile, configDir),
            message.claudeSessionId,
            { cursor: message.cursor, limit: message.limit, query: message.query },
          );
          this.send({ type: 'session.transcriptResult', requestId, page, error: null });
          return;
        }
      }
    } catch (error) {
      const text = errorMessage(error);
      log.warn(`${message.type} 失敗：${text}`);
      if (message.type === 'session.inspect') {
        this.send({ type: 'session.inspectResult', requestId, inspect: null, error: text });
      } else if (message.type === 'session.purge') {
        this.send({ type: 'session.purgeResult', requestId, result: null, error: text });
      } else {
        this.send({ type: 'session.transcriptResult', requestId, page: null, error: text });
      }
    }
  }

  /** 同一個 id 的 purge 依序執行，不讓兩次清理交錯。 */
  private purgeSerialized(message: Extract<HubToDaemon, { type: 'session.purge' }>): Promise<void> {
    const id = message.target.sessionId;
    const run = (this.purgeChains.get(id) ?? Promise.resolve()).then(() => this.purgeOnce(message));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.purgeChains.set(id, tail);
    void tail.then(() => {
      if (this.purgeChains.get(id) === tail) this.purgeChains.delete(id);
    });
    return run;
  }

  /**
   * hub 已保證 session 結束了；萬一 PTY 還活著或正在開（例如刪除期間被接續），
   * 回 error 'session_active'，什麼都不清、不殺（§9.6）。
   */
  private async purgeOnce(message: Extract<HubToDaemon, { type: 'session.purge' }>): Promise<void> {
    const { requestId, target, options } = message;
    const id = target.sessionId;
    // 先驗證再忘掉 session：accountProfile 不合法就整個拒絕，本機清單保持原樣。
    if (options.removeTranscript) {
      claudeConfigFor(target.accountProfile, this.deps.config.claudeConfigDir);
    }
    const dirs = [
      ...new Set(
        await Promise.all(
          [target.worktreePath, target.cwd]
            .filter((dir): dir is string => dir !== null)
            .map(realDir),
        ),
      ),
    ];
    // 從這裡到登記 purging 之間沒有 await：檢查與登記不會被建立插隊。
    if (this.sessions.get(id)?.isAlive || this.creating.has(id)) {
      log.warn(`session ${id} 還在執行，不清理`);
      this.send({ type: 'session.purgeResult', requestId, result: null, error: 'session_active' });
      return;
    }
    this.purging.add(id);
    this.purgingDirs.set(id, dirs);
    // 同一個同步區段：清理中的資料夾裡有其他活著或建立中的 session → 不清，撤銷登記。
    // createSessionOnce 也是「先查 purgingDirs、再登記 sessionDirs」同步完成，誰先誰後都看得到對方。
    const busy = [...this.sessionDirs].find(
      ([other, dir]) =>
        other !== id &&
        (this.sessions.get(other)?.isAlive === true || this.creating.has(other)) &&
        within(dir, dirs),
    );
    if (busy) {
      this.purging.delete(id);
      this.purgingDirs.delete(id);
      log.warn(`清理範圍裡有執行中的 session ${busy[0]}，不清理 ${id}`);
      this.send({ type: 'session.purgeResult', requestId, result: null, error: 'session_active' });
      return;
    }
    try {
      this.forgetSession(id);
      const result = await purgeSession(target, options, this.deps.config.claudeConfigDir);
      this.send({ type: 'session.purgeResult', requestId, result, error: null });
    } finally {
      this.purging.delete(id);
      this.purgingDirs.delete(id);
    }
  }

  /** realCwd（已 realpath）等於或落在清理中的資料夾裡。同步，讓檢查與登記在同一個區段。 */
  private inPurgingDir(realCwd: string): boolean {
    for (const dirs of this.purgingDirs.values()) {
      if (within(realCwd, dirs)) return true;
    }
    return false;
  }

  /** hub 要永久刪除：本機清單（接回清單、還沒送出的結果、留著給人看的畫面）都忘掉這個 id。 */
  private forgetSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.dispose();
    this.sessions.delete(sessionId);
    this.sessionDirs.delete(sessionId);
    this.dropMcp(sessionId);
    this.approvals.cancelSession(sessionId);
    if (this.store.sessions.some((s) => s.sessionId === sessionId)) this.store.remove(sessionId);
    this.store.removeEnded(sessionId);
  }

  private withSession(id: string, action: string, fn: (session: ManagedSession) => void): void {
    const session = this.sessions.get(id);
    if (!session) {
      log.warn(`${action}：找不到 session ${id}`);
      return;
    }
    fn(session);
  }

  private applyHubSettings(dangerRules: string[], stuckMinutes: number, dispatch: boolean): void {
    this.dangerRules = dangerRules;
    this.stuckMinutes = stuckMinutes;
    // 只影響之後開的 PTY；已經掛著的工具呼叫時由 hub 回「已關閉」。
    this.dispatchEnabled = dispatch;
    this.store.setHubSettings(dangerRules, stuckMinutes, dispatch);
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
      const realCwd = await realDir(spec.cwd);
      // 同步區段：查清理中的資料夾、登記自己（與 purgeOnce 對稱）。
      if (this.purging.has(sessionId) || this.inPurgingDir(realCwd)) {
        throw new Error('session_deleting');
      }
      this.sessionDirs.set(sessionId, realCwd);
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
      // 沒開起來：不留登記（同 id 還留著已結束的畫面時，它本來就不算活著）。
      if (!this.sessions.get(sessionId)?.isAlive) this.sessionDirs.delete(sessionId);
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
        await this.launch(entry, await this.restartHow(entry));
      } catch (error) {
        log.error(`無法接回 session ${entry.sessionId}：${errorMessage(error)}`);
        this.store.remove(entry.sessionId);
      }
    }
  }

  /**
   * 重啟接回時用 --resume 還是重新開始。開了之後一句話都沒說的 session 沒有對話紀錄，
   * --resume 會讓 claude 直接結束（exit 1），卡片就變錯誤；這種情況用同一個 id 以 --session-id
   * 重新開始，沒送出的第一句提示也會照常送。
   */
  private async restartHow(
    entry: PersistedSession,
  ): Promise<{ resumeId: string } | { newSessionId: string }> {
    const configDir = claudeConfigFor(entry.spec.accountProfile, this.deps.config.claudeConfigDir);
    const files = await findTranscriptFiles(configDir, entry.claudeSessionId);
    if (files.jsonl.length > 0) return { resumeId: entry.claudeSessionId };
    log.warn(`session ${entry.sessionId} 沒有對話紀錄，改為重新開始（不用 --resume）`);
    return { newSessionId: entry.claudeSessionId };
  }

  /** hook 沒裝上時危險指令檢查不會執行，各種權限模式都不開 PTY（CONTRACTS §4.1）。 */
  private async installHooksOrThrow(cwd: string): Promise<void> {
    try {
      // 與刪除時的 hook 移除共用同一把鎖（§9.6）。
      await withFileLock(await hookSettingsLockKey(cwd), () => this.deps.installHooks(cwd));
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

    const args = buildClaudeArgs({
      ...how,
      permissionMode: spec.permissionMode,
      model: spec.model,
      name: spec.name,
      readOnly: spec.readOnly,
      mcp: this.prepareMcp(sessionId),
    });
    const repo = await repoInfo(entry.cwd);
    let session: ManagedSession;
    try {
      session = this.newManagedSession(entry, args, repo);
    } catch (error) {
      this.dropMcp(sessionId);
      throw error;
    }
    this.sessions.set(sessionId, session);
    // 實際的工作資料夾（worktree session 是 worktree 裡的 cwd）；daemon 重啟接回的也在這裡登記。
    this.sessionDirs.set(sessionId, await realDir(entry.cwd));
    return session;
  }

  private newManagedSession(
    entry: PersistedSession,
    args: string[],
    repo: Awaited<ReturnType<typeof repoInfo>>,
  ): ManagedSession {
    const { spec, sessionId } = entry;
    return new ManagedSession({
      id: sessionId,
      bin: this.deps.config.claudeBin,
      args,
      env: this.sessionEnv(sessionId, spec),
      cwd: entry.cwd,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      repo,
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
  }

  private handleSessionExit(sessionId: string, exitCode: number): void {
    this.approvals.cancelSession(sessionId);
    // 結束的 session 的派工密鑰立刻作廢（CONTRACTS §11）。
    this.dropMcp(sessionId);
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
      this.sessionDirs.delete(session.id);
    }
  }

  // ── 派工工具（CONTRACTS §11）────────────────────────────

  /** 設定開著、找得到 MCP server 才掛；每次開 PTY 換新密鑰。寫檔失敗就不掛，session 照常開。 */
  private prepareMcp(
    sessionId: string,
  ): { configPath: string; allowedTools: readonly string[] } | null {
    this.dropMcp(sessionId);
    const server = this.deps.config.mcpServer;
    if (!this.dispatchEnabled || !server) return null;
    try {
      const launch = writeMcpFiles(
        this.deps.config.dataDir,
        sessionId,
        { command: process.execPath, args: [server] },
        this.hookServer.path,
      );
      this.mcpSecrets.set(sessionId, launch.secret);
      return { configPath: launch.configPath, allowedTools: DISPATCH_TOOL_NAMES };
    } catch (error) {
      log.warn(`無法寫入派工設定，這個 session 不掛派工工具：${errorMessage(error)}`);
      return null;
    }
  }

  private dropMcp(sessionId: string): void {
    this.mcpSecrets.delete(sessionId);
    try {
      removeMcpFiles(this.deps.config.dataDir, sessionId);
    } catch (error) {
      log.warn(`無法移除派工設定檔：${errorMessage(error)}`);
    }
  }

  /** MCP server 轉來的工具呼叫：比對密鑰（只認這次 PTY 的、session 還活著），再交給 hub 判斷。 */
  private async handleMcp(request: McpRequest): Promise<{ ok: boolean; text: string }> {
    const expected = this.mcpSecrets.get(request.sessionId);
    const alive = this.sessions.get(request.sessionId)?.isAlive === true;
    if (!expected || !alive || !secretMatches(expected, request.secret)) {
      log.warn(`拒絕派工請求：session ${request.sessionId} 的密鑰不符或已結束`);
      return { ok: false, text: 'unauthorized: This session is not allowed to use Agent Board tools.' };
    }
    if (!this.hub.connected) {
      return {
        ok: false,
        text: 'hub_unreachable: Agent Board is not connected to its hub right now. Try again in a minute.',
      };
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.dispatchRequests.delete(requestId);
        resolve({ ok: false, text: 'timeout: Agent Board hub did not answer in time. Try again.' });
      }, this.deps.dispatchReplyTimeoutMs ?? DISPATCH_REPLY_TIMEOUT_MS);
      timer.unref();
      this.dispatchRequests.set(requestId, { resolve, timer });
      this.send({
        type: 'dispatch.request',
        requestId,
        sessionId: request.sessionId,
        tool: request.tool,
        args: request.args,
      });
    });
  }

  private settleDispatchRequests(text: string): void {
    for (const [requestId, pending] of this.dispatchRequests) {
      clearTimeout(pending.timer);
      this.dispatchRequests.delete(requestId);
      pending.resolve({ ok: false, text });
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
