// 把 PTY、hub 連線、hook socket、approval、資源與用量接在一起。狀態機與 hook 安裝由外部注入。
import { randomUUID } from 'node:crypto';
import { accessSync, constants, rmSync, statSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, resolve, sep } from 'node:path';
import {
  agentOf,
  CODEX_PERMISSION_WAIT_MS,
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  HOOK_COMMAND,
  HOOK_ENV,
  MachineOs,
  DAEMON_FEATURES,
  type AgentKind,
  type DaemonToHub,
  type HookRequest,
  type HostSessionInfo,
  type HubToDaemon,
  type McpRequest,
  type MachineCapabilities,
  type SessionRuntime,
  type SessionSpec,
} from '@agent-board/protocol';
import { HostConnectError, hostEndpoint, SessionHostClient } from '@agent-board/session-host';
import pkg from '../package.json' with { type: 'json' };
import { ApprovalManager } from './approvals';
import {
  buildCodexArgs,
  codexHome,
  codexHookOutput,
  codexProjectHookFiles,
  codexThreadIds,
} from './codex';
import type { DaemonConfig } from './config';
import { DeepSearcher } from './deepSearch';
import { listDirectory, makeDirectory } from './fsList';
import { hookSettingsLockKey, withFileLock } from './fileLock';
import { downMarkerPath, HookServer, type HookOutput } from './hookServer';
import { HostPtyBackend } from './hostPty';
import { HubClient } from './hubClient';
import { errorMessage, log } from './log';
import {
  clearMcpDir,
  enabledTools,
  readMcpSecret,
  removeMcpFiles,
  toolFullName,
  secretMatches,
  writeMcpFiles,
} from './mcpFiles';
import { probeCapabilities, ResourceMonitor, type ResourceMonitorOptions } from './resources';
import { localPtyBackend, type PtyBackend } from './pty';
import { buildClaudeArgs, ManagedSession } from './session';
import { launchSessionHost } from './sessionHostLauncher';
import {
  pruneSnapshots,
  readSnapshot,
  removeSnapshot,
  writeSnapshot,
  type SessionSnapshot,
} from './sessionState';
import { claudeConfigFor, findTranscriptFiles, inspectSession, purgeSession } from './sessionFiles';
import type { CreateStatusTracker } from './status/types';
import { SessionStore, type PersistedSession } from './store';
import { readTranscript } from './transcript';
import { scanUsage } from './usage';
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
  /** 叫服務管理程式拉起 session host 之後，等它能連的上限（毫秒）。 */
  sessionHostLaunchWaitMs?: number;
}

/** 拉起 session host 之後等它能連的時間。 */
const SESSION_HOST_LAUNCH_WAIT_MS = 5_000;
const SESSION_HOST_RETRY_MS = 250;
/** 接不回的 session：等 host 收掉舊 agent 的上限。 */
const ORPHAN_KILL_WAIT_MS = 3_000;

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
  /** `Settings.memory`（hub.welcome 下發，P3 項目一）：新開的 PTY 要不要掛進度卡工具。 */
  private memoryEnabled: boolean;
  /** 每個活著的 session 這次 PTY 的派工密鑰（只在記憶體，檔案另存 0600）。 */
  private readonly mcpSecrets = new Map<string, string>();
  /** 全域搜尋的深層（P3 ③b）：只讀本機對話紀錄與畫面，和對話紀錄檢視分開排隊。 */
  private readonly deepSearch: DeepSearcher;
  private readonly dispatchRequests = new Map<
    string,
    { resolve: (reply: { ok: boolean; text: string }) => void; timer: NodeJS.Timeout }
  >();
  /**
   * 開 agent 用的 PTY 後端（CONTRACTS §20）：連得上 session host 就交給它養（daemon 重啟時 agent 不中斷），
   * 否則 daemon 自己開（舊模式）。
   */
  private backend: PtyBackend = localPtyBackend;
  private host: SessionHostClient | null = null;
  private recoveringHost = false;
  /** 啟動時接回 session host 裡的 session 完成前，hook 先等著（重試中的 hook 才找得到 session）。 */
  private sessionsReady: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DaemonDeps) {
    const { config } = deps;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.store = new SessionStore(config.dataDir);
    // hub 還沒連上時也要擋危險指令：用上次下發的規則，再不然用預設值。
    this.dangerRules = this.store.dangerRules ?? DEFAULT_DANGER_RULES;
    this.stuckMinutes = this.store.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
    this.dispatchEnabled = this.store.dispatch;
    this.memoryEnabled = this.store.memory;
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
    this.deepSearch = new DeepSearcher({
      configDir: config.claudeConfigDir,
      // 只認這台開過 session 的帳號設定目錄（記在 sessions.json，重啟後還在）與還在清單上的 session 用的。
      knownProfile: (profile) =>
        this.accountProfiles.has(profile) ||
        this.store.accountProfiles.includes(profile) ||
        this.store.sessions.some((s) => s.spec.accountProfile === profile),
      screen: (sessionId) => {
        const session = this.sessions.get(sessionId);
        // 規格只搜活著的 session 的畫面（結束後留著給人看的那些不算）。
        return session?.isAlive ? session.screenLines() : null;
      },
      send: (message) => this.send(message),
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
    // 另一個 daemon 正在用同一份資料夾時在這裡就失敗，不會去搶 session host 的連線。
    await this.hookServer.start();
    let markReady: () => void = () => {};
    this.sessionsReady = new Promise((resolve) => (markReady = resolve));
    try {
      await this.attachToSessionHost();
    } finally {
      markReady();
    }
    this.capabilities =
      this.deps.capabilities ??
      (await probeCapabilities(
        this.deps.config.claudeBin,
        this.childEnv(),
        this.deps.config.codexBin,
      ));
    // 先把 session 接回來（status=starting），第一則 hello 才對得上帳（CONTRACTS §3.2）。
    await this.resumePersistedSessions();
    this.hub.start();
    this.usageTimer = setInterval(() => void this.reportUsage(), USAGE_INTERVAL_MS);
    this.usageTimer.unref();
  }

  /**
   * 關閉 daemon。session host 模式：agent 留在 host 繼續跑，狀態快照落地，下次啟動接回（CONTRACTS §20.3）。
   * 舊模式：PTY 一起結束，但本機清單保留，下次啟動用 --resume 接回（§3.2）。
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    this.clearRevokedTimer();
    this.resources.stop();
    await Promise.allSettled(this.creating.values());
    const sessions = [...this.sessions.values()];
    if (this.host?.connected) {
      // 快照（含等待中的審批 id）先落地，再把審批交回終端機（hook 連線馬上就會斷）。
      for (const session of sessions) this.saveSnapshot(session.id);
      this.approvals.handOffToTerminal();
      await Promise.all(sessions.map((s) => (s.detachable ? s.detach() : s.detachAndKill())));
      this.writeDownMarker();
    } else {
      this.approvals.dispose();
      await Promise.all(sessions.map((s) => s.detachAndKill()));
      clearMcpDir(this.deps.config.dataDir);
    }
    this.sessions.clear();
    this.mcpSecrets.clear();
    this.settleDispatchRequests('hub_unreachable: Agent Board daemon is shutting down.');
    this.deepSearch.cancelAll();
    this.hub.stop();
    await this.hookServer.close();
    this.host?.close();
    this.host = null;
  }

  // ── session host（CONTRACTS §20）──────────────────────────

  /** 啟動時：連 session host、接回它養著的 session；連不上就退回舊模式。 */
  private async attachToSessionHost(): Promise<void> {
    const { dataDir } = this.deps.config;
    const hostSessions = await this.connectSessionHost();
    if (hostSessions === null) {
      // 舊模式：上次留下的派工設定與密鑰都作廢（agent 已隨上一個 daemon 結束），每個 PTY 會拿到新的。
      clearMcpDir(dataDir);
    } else {
      await this.reattachHostSessions(hostSessions);
      // 密鑰檔只留還活著的 session 的（MCP server 還拿著它們）。
      const live = new Set([...this.sessions.values()].filter((s) => s.isAlive).map((s) => s.id));
      clearMcpDir(dataDir, live);
    }
    pruneSnapshots(dataDir, new Set(this.store.sessions.map((s) => s.sessionId)));
    this.clearDownMarker();
  }

  private async tryConnectHost(): Promise<SessionHostClient | Error> {
    try {
      return await SessionHostClient.connect(hostEndpoint(this.deps.config.dataDir));
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 連上就把後端換成 session host，回傳它養著的 session；連不上回 null（舊模式，記 warn）。 */
  private async connectSessionHost(): Promise<HostSessionInfo[] | null> {
    const { config } = this.deps;
    if (config.sessionHost === 'off') return null;
    let result = await this.tryConnectHost();
    const launchable =
      result instanceof HostConnectError &&
      ['unreachable', 'no_token', 'timeout', 'unauthorized'].includes(result.reason);
    if (result instanceof Error && launchable && config.sessionHostService) {
      // host 沒在跑：叫服務管理程式拉起來（macOS launchctl kickstart），等它能連。
      if (await launchSessionHost(config.sessionHostService)) {
        const deadline =
          Date.now() + (this.deps.sessionHostLaunchWaitMs ?? SESSION_HOST_LAUNCH_WAIT_MS);
        while (result instanceof Error && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, SESSION_HOST_RETRY_MS));
          result = await this.tryConnectHost();
        }
      }
    }
    if (result instanceof Error) {
      log.warn(
        `連不上 session host（${result.message}），退回舊模式：daemon 自己開 PTY，daemon 重啟時 agent 會結束、改用 --resume 接回。`,
      );
      return null;
    }
    const client = result;
    this.host = client;
    this.backend = new HostPtyBackend(client);
    client.onClose(() => this.handleHostLost(client));
    log.info(
      `已連上 session host ${client.hostVersion}（養著 ${client.sessions.length} 個 session）`,
    );
    return client.sessions;
  }

  /** host 裡還在（活著或剛結束、還沒 release）的 session：重播輸出、載入快照接回。 */
  private async reattachHostSessions(list: readonly HostSessionInfo[]): Promise<void> {
    const host = this.host;
    if (!host) return;
    for (const info of list) {
      if (this.sessions.get(info.id)?.isAlive) continue;
      const entry = this.store.sessions.find((s) => s.sessionId === info.id);
      if (!entry) {
        // 不在本機清單上（例如已刪除）：沒人管的 agent 不留著。
        if (info.alive) log.warn(`session host 裡的 session ${info.id} 不在本機清單上，結束它`);
        await this.killHostSession(host, info);
        continue;
      }
      try {
        await this.attachSession(entry, info);
      } catch (error) {
        log.error(`接不回 session ${info.id}（${errorMessage(error)}），改用 --resume 重新開`);
        const session = this.sessions.get(info.id);
        session?.detach();
        this.sessions.delete(info.id);
        this.sessionDirs.delete(info.id);
        this.mcpSecrets.delete(info.id);
        // 舊的 agent 還在跑就收掉：同一個對話不能有兩個 claude。
        await this.killHostSession(host, info);
      }
    }
  }

  /** 強制結束 host 裡的某個 session 並丟掉它的緩衝。先 attach 到最新位置才收得到結束通知。 */
  private killHostSession(host: SessionHostClient, info: HostSessionInfo): Promise<void> {
    if (!info.alive) {
      host.release(info.id);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        host.unregister(info.id);
        host.release(info.id);
        resolve();
      };
      const timer = setTimeout(done, ORPHAN_KILL_WAIT_MS);
      host.register(info.id, { onOutput: () => {}, onExit: done, onError: done });
      host.attach(info.id, info.seqEnd);
      host.kill(info.id, 'SIGKILL');
    });
  }

  private async attachSession(entry: PersistedSession, info: HostSessionInfo): Promise<void> {
    const { spec, sessionId } = entry;
    if (spec.accountProfile) this.accountProfiles.add(spec.accountProfile);
    const snapshot = readSnapshot(this.deps.config.dataDir, sessionId);
    const repo = await repoInfo(entry.cwd);
    const session = this.newManagedSession(entry, [], repo, {
      snapshot,
      cols: info.cols,
      rows: info.rows,
    });
    this.sessions.set(sessionId, session);
    this.sessionDirs.set(sessionId, await realDir(entry.cwd));
    // MCP server 還拿著上一個 daemon 寫的密鑰檔：讀回來，派工工具才繼續能用。
    const secret = readMcpSecret(this.deps.config.dataDir, sessionId);
    if (secret) this.mcpSecrets.set(sessionId, secret);
    await session.ready;
    log.info(`已接回 session ${sessionId}（${info.alive ? '執行中' : '停機期間已結束'}）`);
  }

  /**
   * 和 session host 的連線斷了（host 崩潰或被停掉）：它養的 agent 多半也結束了。這些 session 不算結束、
   * 留在本機清單，重新連（拉起）host 後接回還活著的，其他的用 --resume 重開；連不上就用舊模式開。
   */
  private handleHostLost(client: SessionHostClient): void {
    if (this.stopping || this.host !== client) return;
    log.error('session host 連線中斷，重新連線並接回 session');
    this.host = null;
    this.backend = localPtyBackend;
    for (const session of [...this.sessions.values()]) {
      if (!session.detachable || !session.isAlive) continue;
      session.detach();
      this.sessions.delete(session.id);
      this.sessionDirs.delete(session.id);
    }
    void this.recoverFromHostLoss();
  }

  private async recoverFromHostLoss(): Promise<void> {
    if (this.recoveringHost) return;
    this.recoveringHost = true;
    try {
      const hostSessions = await this.connectSessionHost();
      if (this.stopping) return;
      if (hostSessions) await this.reattachHostSessions(hostSessions);
      await this.resumePersistedSessions();
      for (const session of this.sessions.values()) {
        if (session.isAlive) this.send({ type: 'session.runtime', session: session.runtime() });
      }
    } catch (error) {
      log.error(`session host 中斷後的接回失敗：${errorMessage(error)}`);
    } finally {
      this.recoveringHost = false;
    }
  }

  /** 狀態快照落地（只有 session host 模式需要：舊模式 daemon 一停 agent 就結束了）。 */
  private saveSnapshot(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.detachable || !session.isAlive) return;
    const snapshot: SessionSnapshot = {
      ...session.stateSnapshot(),
      pendingApprovalIds: this.approvals
        .pending()
        .filter((approval) => approval.sessionId === sessionId)
        .map((approval) => approval.id),
    };
    writeSnapshot(this.deps.config.dataDir, snapshot);
  }

  private downMarker(): string | null {
    try {
      return downMarkerPath(this.hookServer.path);
    } catch {
      return null;
    }
  }

  /** hook CLI 看這個記號決定連不上時要不要重試（剛停＝重啟中）。 */
  private writeDownMarker(): void {
    const marker = this.downMarker();
    if (!marker) return;
    try {
      writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch (error) {
      log.warn(`無法寫入 daemon 停止記號：${errorMessage(error)}`);
    }
  }

  private clearDownMarker(): void {
    const marker = this.downMarker();
    if (marker) rmSync(marker, { force: true });
  }

  // ── hub ──────────────────────────────────────────────────

  private send(message: DaemonToHub): void {
    this.hub.send(message);
  }

  /** 帶 onlyIfStatus 的 terminal.signal 回報有沒有送（hub 送了才清派工工作）。 */
  private signalResult(
    sessionId: string,
    signal: Extract<DaemonToHub, { type: 'terminal.signalResult' }>['signal'],
    sent: boolean,
    status: Extract<DaemonToHub, { type: 'terminal.signalResult' }>['status'],
  ): void {
    this.send({ type: 'terminal.signalResult', sessionId, signal, sent, status });
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
      features: [
        DAEMON_FEATURES.signalGuard,
        DAEMON_FEATURES.memory,
        DAEMON_FEATURES.search,
        // 偵測到 codex 才宣告：hub 只把 Codex 的 spec 送給有這個旗標的 daemon（§19）。
        ...(this.capabilities.codexVersion ? [DAEMON_FEATURES.codex] : []),
      ],
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
    this.deepSearch.cancelAll();
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
        this.applyHubSettings(
          message.dangerRules,
          message.stuckMinutes,
          message.dispatch === true,
          message.memory === true,
        );
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
      case 'terminal.signal': {
        const guarded = message.onlyIfStatus !== undefined;
        const s = this.sessions.get(message.sessionId);
        if (!s) {
          log.warn(`${message.type}：找不到 session ${message.sessionId}`);
          if (guarded) this.signalResult(message.sessionId, message.signal, false, null);
          return;
        }
        // 全部暫停「立刻中斷」：hub 以為在跑，這裡再確認一次（正要轉權限請求時 Esc 會變成拒絕）。
        const status = s.runtime().status;
        if (guarded && status !== message.onlyIfStatus) {
          log.info(
            `terminal.signal：session ${message.sessionId} 狀態是 ${status}，不是 ${message.onlyIfStatus}，不送`,
          );
          this.signalResult(message.sessionId, message.signal, false, status);
          return;
        }
        if (message.signal === 'escape') s.write('\x1b');
        else if (message.signal === 'ctrl_c') s.write('\x03');
        else s.terminate();
        if (guarded) this.signalResult(message.sessionId, message.signal, true, status);
        return;
      }
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
      case 'search.request':
        void this.deepSearch.start(message);
        return;
      case 'search.cancel':
        this.deepSearch.cancel(message.searchId);
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
    removeSnapshot(this.deps.config.dataDir, sessionId);
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

  private applyHubSettings(
    dangerRules: string[],
    stuckMinutes: number,
    dispatch: boolean,
    memory: boolean,
  ): void {
    this.dangerRules = dangerRules;
    this.stuckMinutes = stuckMinutes;
    // 只影響之後開的 PTY；已經掛著的工具呼叫時由 hub 回「已關閉」。
    this.dispatchEnabled = dispatch;
    this.memoryEnabled = memory;
    this.store.setHubSettings(dangerRules, stuckMinutes, dispatch, memory);
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
      const agent = agentOf(spec);
      this.assertCanLaunch(agent);
      assertDirectory(spec.cwd);
      if (spec.useWorktree) worktree = await createWorktree(spec.cwd, spec.name, sessionId);
      // Codex 的 hook 用 -c 在啟動時帶入，不寫任何設定檔（§19.2）。
      if (agent === 'claude') await this.installHooksOrThrow(worktree?.cwd ?? spec.cwd);
      else this.assertNoCodexProjectHooks(worktree?.cwd ?? spec.cwd);
      const persisted: PersistedSession = {
        sessionId,
        spec: { ...spec, firstPrompt: null },
        // Codex 不能指定新對話的 id：等 SessionStart 回報 thread id。
        claudeSessionId: spec.resumeClaudeSessionId ?? (agent === 'codex' ? null : randomUUID()),
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
      if (this.codexPromptDelivered.delete(sessionId)) persisted.pendingFirstPrompt = null;
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
      this.codexPromptDelivered.delete(sessionId);
      this.send({ type: 'session.createFailed', requestId, error: errorMessage(error) });
    }
  }

  private agentBin(agent: AgentKind): string {
    return agent === 'codex' ? (this.deps.config.codexBin ?? 'codex') : this.deps.config.claudeBin;
  }

  private assertCanLaunch(agent: AgentKind): void {
    const env = this.childEnv();
    findExecutable(this.agentBin(agent), env);
    findHook(this.deps.config.hookBin, env);
  }

  /**
   * 專案自己有 Codex hook 設定就不開（§19.2）：`--dangerously-bypass-hook-trust` 會讓它們不經確認就執行。
   * 只看檔案在不在，不讀內容。
   */
  private assertNoCodexProjectHooks(cwd: string): void {
    const env = this.childEnv();
    const found = codexProjectHookFiles(cwd, env.HOME || homedir());
    if (found.length === 0) return;
    throw new Error(
      `這個資料夾有專案自己的 Codex 設定（${found.join('、')}），中控台開 Codex 會略過 hook 信任確認、` +
        '讓裡面的 hook 不經你確認就執行。請先在終端機用 codex 手動信任，或移除這些檔案再開。',
    );
  }

  private async resumePersistedSessions(): Promise<void> {
    if (this.store.sessions.length === 0) return;
    try {
      await this.resumeEach();
    } finally {
      this.codexThreads = null;
    }
  }

  /** 重啟時 Codex 有對話紀錄的 thread id：只掃一次 `sessions/` 的檔名，所有 Codex session 共用。 */
  private codexThreads: Promise<Set<string>> | null = null;

  private async resumeEach(): Promise<void> {
    for (const entry of [...this.store.sessions]) {
      // 已經從 session host 接回的不用再開。
      if (this.sessions.has(entry.sessionId)) continue;
      try {
        this.assertCanLaunch(agentOf(entry.spec));
      } catch (error) {
        // 環境問題（PATH 沒設好之類）修好就能接回，清單要留著；這次只是不開。
        log.error(`這次不接回 session ${entry.sessionId}：${errorMessage(error)}`);
        continue;
      }
      try {
        assertDirectory(entry.cwd);
      } catch (error) {
        // 接不回來就從清單移除，否則每次重啟都再失敗一次。hub 由 hello 得知它不在了。
        log.error(`無法接回 session ${entry.sessionId}：${errorMessage(error)}`);
        this.store.remove(entry.sessionId);
        continue;
      }
      try {
        if (agentOf(entry.spec) === 'claude') await this.installHooksOrThrow(entry.cwd);
        else this.assertNoCodexProjectHooks(entry.cwd);
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
  ): Promise<{ resumeId: string } | { newSessionId: string | null }> {
    if (agentOf(entry.spec) === 'codex') {
      // Codex：知道 thread id 而且有對話紀錄才 `codex resume <id>`，否則重新開始（沒送出的第一句照常帶）。
      const id = entry.claudeSessionId;
      this.codexThreads ??= codexThreadIds(codexHome(this.childEnv()));
      if (id && (await this.codexThreads).has(id.toLowerCase())) return { resumeId: id };
      log.warn(`Codex session ${entry.sessionId} 沒有對話紀錄，改為重新開始`);
      return { newSessionId: null };
    }
    if (entry.claudeSessionId === null) return { newSessionId: randomUUID() };
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
    how: { resumeId: string } | { newSessionId: string | null },
  ): Promise<ManagedSession> {
    const { spec, sessionId } = entry;
    // 接續同一個 session：上一輪還沒送出的結果已不適用，不可蓋掉新的狀態。
    this.store.removeEnded(sessionId);
    if (spec.accountProfile) {
      this.accountProfiles.add(spec.accountProfile);
      this.store.rememberAccountProfile(spec.accountProfile);
    }

    const agent = agentOf(spec);
    let args: string[];
    let launchEntry = entry;
    if (agent === 'codex') {
      // 第一句用官方的 `codex [PROMPT]` 帶入（不必等 SessionStart 再打字）；派工工具第一版不給 Codex。
      // 本機清單裡的第一句等 Codex 回報 UserPromptSubmit 才清（handleHook）：開起來就崩潰的話，重啟會再帶一次。
      const resumeId = 'resumeId' in how ? how.resumeId : null;
      args = buildCodexArgs({
        resumeId,
        permissionMode: spec.permissionMode,
        readOnly: spec.readOnly,
        model: spec.model,
        firstPrompt: resumeId ? null : entry.pendingFirstPrompt,
        hookTarget: { sessionId, socketPath: this.hookServer.path },
      });
      // 已經在參數裡了，不要再用送字佇列打一次。
      if (entry.pendingFirstPrompt !== null) launchEntry = { ...entry, pendingFirstPrompt: null };
    } else {
      const claudeHow =
        'resumeId' in how ? how : { newSessionId: how.newSessionId ?? randomUUID() };
      if ('newSessionId' in claudeHow && entry.claudeSessionId !== claudeHow.newSessionId) {
        entry.claudeSessionId = claudeHow.newSessionId;
        if (this.store.sessions.some((s) => s.sessionId === sessionId)) {
          this.store.patch(sessionId, { claudeSessionId: claudeHow.newSessionId });
        }
      }
      args = buildClaudeArgs({
        ...claudeHow,
        permissionMode: spec.permissionMode,
        model: spec.model,
        name: spec.name,
        readOnly: spec.readOnly,
        mcp: this.prepareMcp(sessionId),
      });
    }
    const repo = await repoInfo(entry.cwd);
    let session: ManagedSession;
    try {
      session = this.newManagedSession(launchEntry, args, repo);
    } catch (error) {
      this.dropMcp(sessionId);
      throw error;
    }
    this.sessions.set(sessionId, session);
    // 實際的工作資料夾（worktree session 是 worktree 裡的 cwd）；daemon 重啟接回的也在這裡登記。
    this.sessionDirs.set(sessionId, await realDir(entry.cwd));
    try {
      // session host 模式：host 回報開起來了才算（本機模式 spawn 失敗已經在上面丟例外）。
      await session.ready;
    } catch (error) {
      session.dispose();
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.dropMcp(sessionId);
      throw error;
    }
    return session;
  }

  private newManagedSession(
    entry: PersistedSession,
    args: string[],
    repo: Awaited<ReturnType<typeof repoInfo>>,
    reattach?: { snapshot: SessionSnapshot | null; cols: number; rows: number },
  ): ManagedSession {
    const { spec, sessionId } = entry;
    return new ManagedSession({
      id: sessionId,
      agent: agentOf(spec),
      bin: this.agentBin(agentOf(spec)),
      args,
      // 接回的 agent 早就開好了，不需要（也不能再給）環境變數。
      env: reattach ? {} : this.sessionEnv(sessionId, spec),
      backend: this.backend,
      reattach,
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
      onStatusChange: (change) => {
        this.emitEvent(sessionId, 'status', {
          from: change.from,
          fromDetail: change.fromDetail ?? null,
          to: change.to,
          reason: change.reason,
          detail: change.detail,
        });
        // daemon 崩潰（沒跑到 stop）時，下一個 daemon 也有最近的狀態可以接。
        this.saveSnapshot(sessionId);
      },
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
    removeSnapshot(this.deps.config.dataDir, sessionId);
    // session host 丟掉它的緩衝與結束紀錄（不是 host 開的也無妨，host 不認得的 id 不理）。
    if (this.host?.connected) this.host.release(sessionId);
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

  /**
   * 派工或進度卡設定開著、找得到 MCP server 才掛（兩個都關＝完全不掛）；`--allowedTools` 只列開著的功能的工具。
   * 每次開 PTY 換新密鑰。寫檔失敗就不掛，session 照常開。
   */
  private prepareMcp(
    sessionId: string,
  ): { configPath: string; allowedTools: readonly string[] } | null {
    this.dropMcp(sessionId);
    const server = this.deps.config.mcpServer;
    const tools = enabledTools({ dispatch: this.dispatchEnabled, memory: this.memoryEnabled });
    if (tools.length === 0 || !server) return null;
    try {
      const launch = writeMcpFiles(
        this.deps.config.dataDir,
        sessionId,
        { command: process.execPath, args: [server] },
        this.hookServer.path,
        tools,
      );
      this.mcpSecrets.set(sessionId, launch.secret);
      return { configPath: launch.configPath, allowedTools: tools.map(toolFullName) };
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
    await this.sessionsReady;
    const expected = this.mcpSecrets.get(request.sessionId);
    const alive = this.sessions.get(request.sessionId)?.isAlive === true;
    if (!expected || !alive || !secretMatches(expected, request.secret)) {
      log.warn(`拒絕派工請求：session ${request.sessionId} 的密鑰不符或已結束`);
      return {
        ok: false,
        text: 'unauthorized: This session is not allowed to use Agent Board tools.',
      };
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
      // 帳號資料夾是 Claude Code 的設定；Codex 第一版不支援（hub 已擋），也不設 CODEX_HOME。
      ...(spec.accountProfile && agentOf(spec) === 'claude'
        ? { CLAUDE_CONFIG_DIR: spec.accountProfile }
        : {}),
    };
  }

  private emitEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.send({
      type: 'session.event',
      event: { id: randomUUID(), sessionId, type, payload, at: new Date().toISOString() },
    });
  }

  // ── hook ─────────────────────────────────────────────────

  /** 新建的 Codex session 還沒寫進本機清單前就送出了第一句：寫入時不要再留著（createSessionOnce）。 */
  private readonly codexPromptDelivered = new Set<string>();

  private clearPendingFirstPrompt(sessionId: string): void {
    const entry = this.store.sessions.find((s) => s.sessionId === sessionId);
    if (!entry) this.codexPromptDelivered.add(sessionId);
    else if (entry.pendingFirstPrompt !== null) {
      this.store.patch(sessionId, { pendingFirstPrompt: null });
    }
  }

  private async handleHook(request: HookRequest, signal: AbortSignal): Promise<HookOutput> {
    // 啟動時還在接回 session host 的 session：等接完，否則這個 hook 會被當成不認得的 session 丟掉。
    await this.sessionsReady;
    const { event, sessionId, payload } = request;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.onHook(event, payload);
      // Codex 的第一句在啟動參數裡：真的送進去了（UserPromptSubmit）才從本機清單清掉。
      if (session.agent === 'codex' && event === 'UserPromptSubmit') {
        this.clearPendingFirstPrompt(sessionId);
      }
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
    // Codex 收的格式不同（§19.4）：hook CLI 說了是 codex，或這個 session 是 Codex 開的。
    const codex = request.agent === 'codex' || session?.agent === 'codex';
    // 不認得的 session 也照樣比對危險指令，往安全的方向。
    // Codex 的 PermissionRequest 會卡住終端機等 hook，所以等網頁的時間短很多（§19.4）。
    const output = await this.approvals.handleHook(event, sessionId, payload, signal, {
      ...(codex ? { permissionWaitMs: CODEX_PERMISSION_WAIT_MS } : {}),
    });
    return codex ? codexHookOutput(event, output) : output;
  }

  // ── 用量 ─────────────────────────────────────────────────

  private async reportUsage(): Promise<void> {
    if (this.usageRunning || !this.hub.connected) return;
    this.usageRunning = true;
    try {
      // 總數與細項同一次掃描（GM 2026-11-09 用量詳情），不多讀一次檔。
      const { summary, detail } = await scanUsage(
        [this.deps.config.claudeConfigDir, ...this.accountProfiles],
        new Date(),
        { windowMs: USAGE_WINDOW_MS },
      );
      this.send({ type: 'usage', summary, detail });
    } catch (error) {
      log.warn(`用量統計失敗：${errorMessage(error)}`);
    } finally {
      this.usageRunning = false;
    }
  }
}
