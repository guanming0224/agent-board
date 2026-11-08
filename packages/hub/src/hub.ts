// hub 的執行期核心：daemon 與瀏覽器連線、session 生命週期、併發排隊、approval 快取、推播。
// 資料歸屬見 CONTRACTS §2：終端機內容只經過這裡，不落地；approval 只快取，daemon 才是擁有者。
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  ClientToHub,
  DAEMON_FEATURES,
  DaemonToHub,
  needsAttention,
  QUEUE_DETAIL_RATE_LIMITED,
  WaitingThreshold,
  waitingSessions,
  AbsolutePath,
  ClaudeSessionId,
  DEFAULT_ZONE_ID,
  SessionSpec,
  type Approval,
  type AutoContinue,
  type BoardHeld,
  type BoardInterruptResult,
  type BoardPauseMode,
  type BoardPauseState,
  type DirEntry,
  type PurgeOptions,
  type PurgeResult,
  type SessionInspect,
  type SessionLocator,
  type TranscriptPage,
  type RepoInfo,
  type HubToClient,
  type HubToDaemon,
  type Machine,
  type Session,
  type SessionRuntime,
  type SessionStatus,
  type Settings,
  type Task,
  type Team,
  type TerminalSignal,
  type UsageSummary,
  type User,
  type Zone,
} from '@agent-board/protocol';
import type { z } from 'zod';
import { buildSummary, DEFAULT_WINDOWS, NotifyCoalescer, type SummaryItem } from './attention';
import { InputLineBuffer, PromptWatcher, REDACTED_INPUT, redactSecrets } from './audit';
import { AutoContinueEngine, isAutoContinueKey } from './autoContinue';
import { BroadcastEngine } from './broadcast';
import { conflict, HttpError, notFound } from './errors';
import { SafeDelivery, type DeliveryItem } from './delivery';
import { DispatchEngine } from './dispatch';
import { HandoffEngine } from './handoff';
import {
  attentionPayload,
  inQuietHours,
  type AttentionReason,
  type PushTransport,
  type VapidKeys,
} from './push';
import { parseRateLimitReset } from './rateLimitReset';
import { TerminalRelay, type RelayClient } from './relay';
import type { Store, StoredBoardPause } from './store';
import { TaskEngine } from './tasks';

export interface Timing {
  heartbeatMs: number;
  browseTimeoutMs: number;
  createTimeoutMs: number;
  helloTimeoutMs: number;
  pushRetryMs: number;
  maxClientBufferBytes: number;
  /** 非終端機訊息的硬上限：連這個都超過，連線就是死了。 */
  hardClientBufferBytes: number;
  drainPollMs: number;
  drainTimeoutMs: number;
  /** 刪除時等 daemon 清掉機器上檔案的上限（CONTRACTS §9.4）。 */
  purgeTimeoutMs: number;
  /** 刪除前檢查與讀對話紀錄（daemon 要掃資料夾、跑 git、讀大檔），比資料夾瀏覽久。 */
  sessionFilesTimeoutMs: number;
  /** 刪除鎖的上限：daemon 一直不回又不斷線時自動解鎖（daemon 端另有 purging／session_active 防護）。 */
  deleteLockMaxMs: number;
  /** 送進 TUI 的文字和 Enter 之間的間隔，太短會被當成貼上。 */
  handoffEnterDelayMs: number;
  /** 合併通知的等待時間（protocol NOTIFY_*；測試縮短）。 */
  notifyWindowMs: number;
  notifyPermissionWindowMs: number;
  notifyMaxWindowMs: number;
}

export const DEFAULT_TIMING: Timing = {
  heartbeatMs: 30_000,
  browseTimeoutMs: 10_000,
  createTimeoutMs: 120_000,
  helloTimeoutMs: 10_000,
  pushRetryMs: 5_000,
  maxClientBufferBytes: 1024 * 1024,
  hardClientBufferBytes: 16 * 1024 * 1024,
  drainPollMs: 200,
  drainTimeoutMs: 60_000,
  purgeTimeoutMs: 30_000,
  sessionFilesTimeoutMs: 20_000,
  deleteLockMaxMs: 5 * 60_000,
  handoffEnterDelayMs: 100,
  notifyWindowMs: DEFAULT_WINDOWS.normalMs,
  notifyPermissionWindowMs: DEFAULT_WINDOWS.urgentMs,
  notifyMaxWindowMs: DEFAULT_WINDOWS.maxMs,
};

export const CLOSE_REVOKED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_HELLO_TIMEOUT = 4408;

export interface HubLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

interface DaemonConn {
  ws: WebSocket;
  machineId: string;
  helloed: boolean;
  alive: boolean;
  /** 已撤銷或被新連線取代：在 close 事件來之前，它送的東西一律不理。 */
  retired: boolean;
  helloTimer: NodeJS.Timeout | null;
  /** hello 宣告的協定功能（DAEMON_FEATURES）。hello 前是空的。 */
  features: Set<string>;
}

export interface ClientConn extends RelayClient {
  ws: WebSocket;
  userId: string;
  tokenHash: string;
  alive: boolean;
  watching: boolean;
  /** 每個 session 一份行緩衝，湊滿一行（Enter）才寫 audit。 */
  inputs: Map<string, InputLineBuffer>;
}

interface PendingCreate {
  sessionId: string;
  machineId: string;
  timer: NodeJS.Timeout;
}

/** 一問一答的 daemon 請求（資料夾瀏覽、封存相關）。 */
type DaemonRequest = Extract<
  HubToDaemon,
  { type: 'fs.list' | 'fs.mkdir' | 'session.inspect' | 'session.purge' | 'session.transcript' }
>;
type DaemonReply = Extract<
  DaemonToHub,
  {
    type:
      | 'fs.listResult'
      | 'session.inspectResult'
      | 'session.purgeResult'
      | 'session.transcriptResult';
  }
>;

/** 刪除中的 session（§9.6）：鎖到 daemon 回 purgeResult 或斷線。hub 先回 504 也不解。 */
interface DeleteLock {
  userId: string;
  machineId: string;
  cwd: string;
  worktreePath: string | null;
  requestId: string | null;
  /** 到上限自動解鎖。 */
  timer: NodeJS.Timeout;
}

interface PendingRequest {
  machineId: string;
  /** 期待的回應類型：daemon 不能拿別種回應結掉這個請求。 */
  expects: DaemonReply['type'];
  timer: NodeJS.Timeout;
  resolve(reply: DaemonReply): void;
  reject(error: Error): void;
}

interface BrowseResult {
  path: string;
  entries: z.infer<typeof DirEntry>[];
  repo: RepoInfo | null;
}

const SESSION_DETAIL_LOST = 'ended while the machine was disconnected; outcome unknown';
const SESSION_DETAIL_CREATE_TIMEOUT = 'daemon did not confirm session start in time';
const SESSION_DETAIL_CANCELLED = 'cancelled while queued';

/** 由 hub 設定的狀態（CONTRACTS §5）。例外只有一個：PTY exit 0 由 daemon 回報 done + endedAt。 */
const HUB_ONLY_STATUSES: readonly SessionStatus[] = ['queued', 'done', 'offline'];

const holdsSlot = (s: Session): boolean =>
  s.endedAt === null && s.status !== 'queued' && s.status !== 'done';

/** 同一個 Claude 帳號：同機器、同 CLAUDE_CONFIG_DIR（null 是該機器的預設帳號）。 */
type AccountKey = Pick<Session, 'machineId' | 'accountProfile'>;
const sameAccount = (a: AccountKey, b: AccountKey): boolean =>
  a.machineId === b.machineId && (a.accountProfile || null) === (b.accountProfile || null);

/** approval 對應的狀態（危險指令命中時 session 常常還是 running）。 */
const APPROVAL_STATUS: Record<Approval['kind'], SessionStatus> = {
  permission: 'waiting_permission',
  danger: 'waiting_permission',
  plan: 'plan_review',
  question: 'waiting_input',
};

/** 送字佇列 key 的前綴 → 被暫停擋下時 audit 裡寫的種類（key 由各引擎決定）。 */
const HELD_KINDS: [prefix: string, kind: string][] = [
  ['rule:', 'handoff'],
  ['task:', 'task'],
  ['dispatch-result:', 'dispatch_result'],
  ['dispatch:', 'dispatch'],
  ['auto-continue:', 'auto_continue'],
];
const heldKind = (key: string): string =>
  HELD_KINDS.find(([prefix]) => key.startsWith(prefix))?.[1] ?? 'other';
/** board.held audit 裡的訊息只留開頭（全文送出時另有 terminal.input）。 */
const HELD_MESSAGE_MAX = 200;

/** 重置時間到了之後多等一下再開，時鐘差一點就開會馬上又撞到限流。 */
const RATE_LIMIT_RESET_GRACE_MS = 60_000;

function browseResult(reply: Extract<DaemonToHub, { type: 'fs.listResult' }>): BrowseResult {
  if (reply.error !== null) throw new HttpError(400, 'fs_error', reply.error);
  return { path: reply.path, entries: reply.entries, repo: reply.repo };
}

/** 資料庫裡的 claude id 不合格式就當沒有：daemon 拿它組檔名，協定也會拒收。 */
function validClaudeId(id: string | null): string | null {
  if (id === null) return null;
  const parsed = ClaudeSessionId.safeParse(id);
  return parsed.success ? parsed.data : null; // 協定已轉小寫
}

/** 資料庫裡的 accountProfile（舊資料可能是 '' 或相對路徑）：'' 當 null，不合法回 undefined。 */
function validAccountProfile(profile: string | null): string | null | undefined {
  if (!profile) return null;
  return AbsolutePath.safeParse(profile).success ? profile : undefined;
}

/** 排隊中的 spec 來自資料庫（可能是舊版寫的）：送出前照協定再驗一次，'' 當 null、id 轉小寫。 */
function sanitizeSpec(spec: SessionSpec): SessionSpec | null {
  const parsed = SessionSpec.safeParse({ ...spec, accountProfile: spec.accountProfile || null });
  return parsed.success ? parsed.data : null;
}

/** daemon 不一定還記得已結束的 session，路徑一律由 hub 從資料庫帶過去。 */
function locatorFor(session: Session): SessionLocator {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    branch: session.branch,
    claudeSessionId: validClaudeId(session.claudeSessionId),
    accountProfile: session.accountProfile || null,
  };
}

export interface HubDeps {
  store: Store;
  log: HubLog;
  timing: Timing;
  now(): Date;
  pushTransport: PushTransport;
  vapid: VapidKeys;
}

export class Hub {
  private readonly store: Store;
  private readonly log: HubLog;
  private readonly timing: Timing;
  private readonly daemons = new Map<string, DaemonConn>();
  private readonly clients = new Set<ClientConn>();
  private readonly approvals = new Map<string, { approval: Approval; machineId: string }>();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly deleting = new Map<string, DeleteLock>();
  private readonly usage = new Map<string, UsageSummary>();
  private readonly pushes = new Set<Promise<void>>();
  private readonly relay: TerminalRelay<ClientConn>;
  private readonly prompts = new PromptWatcher();
  /** 交接與任務自動執行共用的送字佇列：同一個目標一次只送一則。 */
  private readonly delivery: SafeDelivery;
  private readonly handoff: HandoffEngine;
  private readonly tasks: TaskEngine;
  private readonly autoContinue: AutoContinueEngine;
  /** session 派工（MCP 工具，CONTRACTS §11）。 */
  private readonly dispatch: DispatchEngine;
  /** 團隊群發（P2 項目二）：GM 親手下的，走同一條送字佇列，全部暫停不擋。 */
  private readonly broadcasts: BroadcastEngine;
  /** 合併通知（Settings.notifications.coalesce）：哪時候送；送什麼在 flushSummary 決定。 */
  private readonly coalescer: NotifyCoalescer;
  /** 同時等你的上限：每次跨過只通知一次，回到上限以內才重設。 */
  private readonly waiting = new WaitingThreshold();
  /** 合併通知等待期間跨過了上限：值是上限。 */
  private overloadPending: number | null = null;
  /** 等待期間自動接續的 session（合併通知裡寫「已自動接續」）。 */
  private autoContinued: { sessionId: string; name: string }[] = [];
  /** 自動流程停下等使用者決定的 session（合併通知送出時再確認還成不成立）。 */
  private readonly roundLimits = new Map<string, number>();
  private readonly taskLimits = new Map<
    string,
    { taskId: string; number: number; limit: number }
  >();
  /** daemon 最後一次回報：畫面最下面是平常的輸入框（SessionRuntime.inputReady）。不落地。 */
  private readonly inputReady = new Map<string, boolean>();
  private heartbeat: NodeJS.Timeout | null = null;
  /** 限流帳號的重置時間到時重新排隊（§8-5）。 */
  private resetTimer: NodeJS.Timeout | null = null;
  /** 全部暫停（P2 項目三）：null＝沒暫停。和資料庫同步，hub 重啟後照樣暫停。 */
  private pause: StoredBoardPause | null = null;
  private pauseBroadcastQueued = false;
  /** 最後一次推給 client 的暫停狀態（沒變就不再推）。 */
  private lastPauseFrame: string | null = null;
  /** 「立刻中斷」送出、等 daemon 回報結果的 session → 按暫停的使用者。 */
  private readonly pauseInterrupts = new Map<string, string>();
  private closed = false;

  constructor(private readonly deps: HubDeps) {
    this.store = deps.store;
    this.log = deps.log;
    this.timing = deps.timing;
    // 暫停狀態要在任何引擎還原（可能排進送字）之前讀出來。
    this.pause = this.loadPause();
    this.relay = new TerminalRelay<ClientConn>({
      subscribeUpstream: (id) =>
        this.toSessionDaemon(id, { type: 'terminal.subscribe', sessionId: id }),
      unsubscribeUpstream: (id) =>
        this.toSessionDaemon(id, { type: 'terminal.unsubscribe', sessionId: id }),
      maxBufferBytes: deps.timing.maxClientBufferBytes,
      drainPollMs: deps.timing.drainPollMs,
      drainTimeoutMs: deps.timing.drainTimeoutMs,
      now: () => deps.now().getTime(),
    });
    const sendDeps = {
      store: deps.store,
      now: deps.now,
      enterDelayMs: deps.timing.handoffEnterDelayMs,
      audit: (sessionId: string, action: string, detail: string) =>
        this.audit(null, sessionId, action, detail),
      isReachable: (sessionId: string) => {
        const machineId = this.store.sessionMachineId(sessionId);
        return machineId !== null && this.daemonFor(machineId) !== null;
      },
      // hub 唯一自己送字進 PTY 的地方（交接規則、任務自動執行、自動接續、session 派工，docs/no-llm-review.md）。
      // 直接送給 daemon，不經過使用者輸入那條路：不算使用者輸入，不會重設交接鏈。
      sendInput: (sessionId: string, data: string) =>
        this.toSessionDaemon(sessionId, { type: 'terminal.input', sessionId, data }),
      guarded: (label: string, fn: () => void) => this.guarded(label, fn),
    };
    this.delivery = new SafeDelivery({
      ...sendDeps,
      paused: () => this.pause !== null,
      held: (item) => this.auditHeld(item),
      changed: () => this.pauseCountsChanged(),
    });
    this.handoff = new HandoffEngine({
      ...sendDeps,
      delivery: this.delivery,
      addEvent: (sessionId, type, payload, at) => this.addEvent(sessionId, type, payload, at),
      notifyRoundLimit: (sessionId, maxRounds) => {
        const session = this.store.getSession(sessionId);
        if (session) {
          this.roundLimits.set(sessionId, maxRounds);
          this.notifyAttention(session, { reason: 'handoff_round_limit', maxRounds });
        }
      },
    });
    this.tasks = new TaskEngine({
      store: deps.store,
      now: deps.now,
      delivery: this.delivery,
      audit: (sessionId, action, detail) => this.audit(null, sessionId, action, detail),
      addEvent: (sessionId, type, payload, at) => this.addEvent(sessionId, type, payload, at),
      notifyLimit: (sessionId, task, limit) => {
        const session = this.store.getSession(sessionId);
        if (session) {
          this.taskLimits.set(sessionId, { taskId: task.id, number: task.number, limit });
          this.notifyAttention(session, {
            reason: 'task_reject_limit',
            maxRounds: limit,
            task: task.number,
          });
        }
      },
    });
    this.autoContinue = new AutoContinueEngine({
      store: deps.store,
      now: deps.now,
      delivery: this.delivery,
      save: (session, autoContinue) => this.saveAutoContinue(session.id, autoContinue),
      audit: (sessionId, action, detail) => this.audit(null, sessionId, action, detail),
      addEvent: (sessionId, type, payload) => this.addEvent(sessionId, type, payload),
      inputReady: (sessionId) => this.inputReady.get(sessionId) === true,
      sent: (session) => this.notifyAutoContinued(session),
      guarded: (label, fn) => this.guarded(label, fn),
    });
    this.dispatch = new DispatchEngine({
      store: deps.store,
      now: deps.now,
      delivery: this.delivery,
      audit: (sessionId, action, detail) => this.audit(null, sessionId, action, detail),
      addEvent: (sessionId, type, payload, at) => this.addEvent(sessionId, type, payload, at),
      enabled: () => this.store.getSettings().dispatch,
      paused: () => this.pause !== null,
      createSession: (input, dispatchedBy) => this.createSessionAs(input, null, dispatchedBy),
      machineOnline: (machineId) => this.daemonFor(machineId) !== null,
    });
    this.broadcasts = new BroadcastEngine({
      store: deps.store,
      now: deps.now,
      delivery: this.delivery,
      audit: (userId, sessionId, action, detail) => this.audit(userId, sessionId, action, detail),
      paused: () => this.pause !== null,
      changed: (broadcast) => this.broadcast({ type: 'broadcast.updated', broadcast }),
      userInput: (sessionId) => {
        this.handoff.onUserInput(sessionId);
        this.roundLimits.delete(sessionId);
        this.guarded('auto continue', () => this.autoContinue.onUserInput(sessionId));
      },
    });
    this.coalescer = new NotifyCoalescer({
      now: () => deps.now().getTime(),
      windows: {
        normalMs: deps.timing.notifyWindowMs,
        urgentMs: deps.timing.notifyPermissionWindowMs,
        maxMs: deps.timing.notifyMaxWindowMs,
      },
      flush: (triggered) => this.guarded('notify summary', () => this.flushSummary(triggered)),
    });
    // 送字佇列在記憶體，上次關機時排隊的已經不在：標成沒送出，不自動重送。
    this.tasks.restore();
    // 上次關機時的連線都不在了：機器與 session 先視為離線，等 daemon 回來對帳。
    for (const machine of this.store.listMachines()) this.markMachineOffline(machine.id);
    // 排好的自動接續存在資料庫：照樣計時（到時候 session 還沒回來就等它回來）。
    this.autoContinue.restore();
    this.heartbeat = setInterval(
      () => this.guarded('heartbeat', () => this.tick()),
      deps.timing.heartbeatMs,
    );
    this.heartbeat.unref();
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  /** 計時器與 socket 事件裡的例外沒有人接，不擋下來整個 hub 會掛掉。 */
  private guarded(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log.error({ err: error }, `${label} failed`);
    }
  }

  // ── 連線：daemon ─────────────────────────────────────
  attachDaemon(ws: WebSocket, machine: Machine): void {
    const conn: DaemonConn = {
      ws,
      machineId: machine.id,
      helloed: false,
      alive: true,
      retired: false,
      helloTimer: null,
      features: new Set(),
    };
    conn.helloTimer = setTimeout(() => {
      this.log.warn({ machineId: machine.id }, 'daemon did not send hello in time');
      ws.close(CLOSE_HELLO_TIMEOUT, 'hello timeout');
    }, this.timing.helloTimeoutMs);
    conn.helloTimer.unref();

    // 同一台機器重連：新連線為準，舊連線的 close 事件不能把機器標成離線。
    const previous = this.daemons.get(machine.id);
    if (previous) {
      this.retireDaemon(previous);
      previous.ws.close(CLOSE_REPLACED, 'replaced by newer connection');
    }
    this.daemons.set(machine.id, conn);

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      if (conn.retired) return;
      try {
        this.onDaemonRaw(conn, raw.toString(), isBinary);
      } catch (error) {
        this.log.error({ err: error, machineId: conn.machineId }, 'daemon message failed');
      }
    });
    ws.on('close', () => this.guarded('daemon close', () => this.onDaemonClose(conn)));
    ws.on('error', (error) => this.log.warn({ err: error }, 'daemon socket error'));
  }

  private retireDaemon(conn: DaemonConn): void {
    conn.retired = true;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
  }

  private onDaemonRaw(conn: DaemonConn, raw: string, isBinary: boolean): void {
    // HubToDaemon 沒有 error 訊息可回，只記 log、丟棄，不斷線。
    let json: unknown;
    try {
      json = isBinary ? undefined : JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = DaemonToHub.safeParse(json);
    if (!parsed.success) {
      this.log.warn({ machineId: conn.machineId }, 'dropped invalid daemon message');
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'daemon.hello') {
      this.onHello(conn, msg);
      return;
    }
    if (!conn.helloed) {
      this.log.warn({ machineId: conn.machineId, type: msg.type }, 'message before daemon.hello');
      return;
    }
    switch (msg.type) {
      case 'session.created': {
        const pending = this.takePendingCreate(msg.requestId, conn.machineId);
        if (pending && pending.sessionId !== msg.session.id) {
          this.log.warn({ requestId: msg.requestId }, 'session.created id mismatch');
          return;
        }
        if (this.ownsSession(conn, msg.session.id)) {
          this.store.setPendingSpec(msg.session.id, null);
          this.applyRuntime(msg.session);
          // 新 PTY 的 seq 重新開始，daemon 也還沒有這個 PTY 的訂閱，畫面開著的人要重新要快照。
          this.relay.resubscribe([msg.session.id]);
        }
        return;
      }
      case 'session.createFailed': {
        const pending = this.takePendingCreate(msg.requestId, conn.machineId);
        if (pending) this.failStart(pending.sessionId, msg.error);
        return;
      }
      case 'session.runtime': {
        if (!this.ownsSession(conn, msg.session.id)) return;
        const wasEnded = this.store.getSession(msg.session.id)?.endedAt !== null;
        this.applyRuntime(msg.session);
        // 已結束的 session 又活過來（daemon 修好環境後重啟）：同樣是新的 PTY。
        if (wasEnded && msg.session.endedAt === null) this.relay.resubscribe([msg.session.id]);
        return;
      }
      case 'terminal.signalResult':
        if (this.ownsSession(conn, msg.sessionId)) this.onPauseSignalResult(msg);
        return;
      case 'session.event':
        // handoff.*、task.*、dispatch.* 只能由 hub 自己寫（引擎讀它當分界，畫布拿它畫動畫），daemon 送來的不收。
        if (/^(handoff|task|dispatch)\./.test(msg.event.type)) return;
        if (this.ownsSession(conn, msg.event.sessionId) && this.store.insertEvent(msg.event)) {
          this.broadcast({ type: 'session.event', event: msg.event });
          this.guarded('handoff', () => this.handoff.onEvent(msg.event));
          this.guarded('tasks', () => this.tasks.onEvent(msg.event));
          this.guarded('dispatch', () => this.dispatch.onEvent(msg.event));
        }
        return;
      case 'dispatch.request':
        this.onDispatchRequest(conn, msg);
        return;
      case 'terminal.output':
        if (this.ownsSession(conn, msg.sessionId)) {
          this.prompts.onOutput(msg.sessionId, msg.data);
          this.relay.onOutput(msg.sessionId, JSON.stringify(msg));
        }
        return;
      case 'terminal.snapshot':
        if (this.ownsSession(conn, msg.sessionId)) {
          this.prompts.onSnapshot(msg.sessionId, msg.data);
          this.relay.onSnapshot(msg.sessionId, JSON.stringify(msg), msg);
        }
        return;
      case 'approval.requested':
        if (this.ownsSession(conn, msg.approval.sessionId)) {
          this.cacheApproval(msg.approval, conn.machineId);
        }
        return;
      case 'approval.resolved':
        if (this.ownsSession(conn, msg.sessionId)) {
          this.resolveCachedApproval(msg.approvalId, msg.sessionId, msg.by);
        }
        return;
      case 'resources':
        this.broadcastToWatchers({
          type: 'resources',
          sample: { ...msg.sample, machineId: conn.machineId },
        });
        return;
      case 'usage':
        this.usage.set(conn.machineId, { ...msg.summary, machineId: conn.machineId });
        return;
      case 'fs.listResult':
      case 'session.inspectResult':
      case 'session.purgeResult':
      case 'session.transcriptResult':
        this.onDaemonReply(conn, msg);
        return;
    }
  }

  /**
   * 派工工具（CONTRACTS §11）：daemon 已用 session 的密鑰確認是它本人；這裡再確認 session 在這台機器上，
   * 能做什麼由 DispatchEngine 依團隊判斷。結果原樣回給 daemon，再交給 Claude。
   */
  private onDispatchRequest(
    conn: DaemonConn,
    msg: Extract<DaemonToHub, { type: 'dispatch.request' }>,
  ): void {
    let reply: { ok: boolean; text: string };
    if (!this.store.getSession(msg.sessionId) || !this.ownsSession(conn, msg.sessionId)) {
      reply = { ok: false, text: 'caller_inactive: This session is not known to Agent Board.' };
    } else {
      try {
        reply = this.dispatch.handle(msg.sessionId, msg.tool, msg.args);
      } catch (error) {
        this.log.error({ err: error, tool: msg.tool }, 'dispatch failed');
        reply = { ok: false, text: 'internal_error: Agent Board could not complete this request.' };
      }
    }
    this.send(conn.ws, { type: 'dispatch.reply', requestId: msg.requestId, ...reply });
  }

  /** daemon 只能碰自己機器上的 session；別台機器的 id 視同不存在。 */
  private ownsSession(conn: DaemonConn, sessionId: string): boolean {
    const owner = this.store.sessionMachineId(sessionId);
    if (owner === conn.machineId) return true;
    this.log.warn({ machineId: conn.machineId, sessionId }, 'daemon referenced foreign session');
    return false;
  }

  private onHello(conn: DaemonConn, msg: Extract<DaemonToHub, { type: 'daemon.hello' }>): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conn.helloed = true;
    conn.features = new Set(msg.features);
    this.store.machineHello(conn.machineId, msg.os, msg.capabilities, this.nowIso());
    // 機器上線：它的 QUE 變成繼續後會開的（排隊統計）。
    this.pauseCountsChanged();
    this.send(conn.ws, this.welcomeFor(conn.machineId));

    // session：有回報的用真實狀態；還標著活著但沒回報的，就是在斷線期間消失了。
    const reported = new Set<string>();
    for (const runtime of msg.sessions) {
      if (!this.store.getSession(runtime.id)) {
        // 只會發生在 hub 資料庫被換掉時。runtime 沒有名稱與模式，補建會顯示假資料，所以只記錄。
        this.log.warn({ sessionId: runtime.id }, 'daemon reported unknown session');
        continue;
      }
      if (!this.ownsSession(conn, runtime.id)) continue;
      reported.add(runtime.id);
      // 排隊中的 session 還要靠 pending_spec 才開得起來，這裡不能清。
      if (this.store.getSession(runtime.id)?.status !== 'queued') {
        this.store.setPendingSpec(runtime.id, null);
      }
      this.applyRuntime(runtime);
      // 封存時機器離線、沒停成的，現在補停（§9.1）。
      const current = this.store.getSession(runtime.id);
      if (current?.archived && current.endedAt === null) {
        this.send(conn.ws, { type: 'session.stop', sessionId: runtime.id });
      }
    }
    for (const session of this.store.listMachineSessions(conn.machineId)) {
      if (reported.has(session.id) || session.endedAt !== null || session.status === 'queued') {
        continue;
      }
      this.store.setPendingSpec(session.id, null);
      this.store.setPreOfflineStatus(session.id, null);
      // 使用者已經處理過的（done、archived）不改狀態也不推播，只記下結束時間，併發名額才會放出來。
      if (session.status === 'done' || session.archived) {
        this.updateFields(session, { endedAt: this.nowIso() });
      } else {
        // 分不出正常結束還是崩潰，推播會變成假警報：標在畫面上讓人自己看。
        this.setStatus(
          session,
          'error',
          SESSION_DETAIL_LOST,
          'daemon_reconcile',
          { endedAt: this.nowIso() },
          false,
        );
      }
    }

    this.reconcileApprovals(conn, msg.pendingApprovals);
    this.broadcastMachine(conn.machineId);

    // 串流與資源監看都在舊連線上，重連後要重新要。
    const mine = this.relay
      .subscribedSessions()
      .filter((id) => this.store.sessionMachineId(id) === conn.machineId);
    this.relay.resubscribe(mine);
    if (this.hasWatchers()) this.send(conn.ws, { type: 'resources.watch', watching: true });
    this.drainQueue();
  }

  private welcomeFor(machineId: string): HubToDaemon {
    const settings = this.store.getSettings();
    return {
      type: 'hub.welcome',
      machineId,
      dangerRules: settings.dangerRules,
      stuckMinutes: settings.stuckMinutes,
      dispatch: settings.dispatch,
    };
  }

  private onDaemonClose(conn: DaemonConn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    if (conn.retired || this.daemons.get(conn.machineId) !== conn) return;
    this.daemons.delete(conn.machineId);
    // 等 daemon 回報 Esc 結果的，斷線就不會有回報了（送了沒送不知道；成員之後 Stop 照常結算）。
    for (const sessionId of this.pauseInterrupts.keys()) {
      if (this.store.sessionMachineId(sessionId) === conn.machineId) {
        this.pauseInterrupts.delete(sessionId);
      }
    }
    if (this.closed) return;
    this.markMachineOffline(conn.machineId);
  }

  private markMachineOffline(machineId: string): void {
    this.store.setMachineOffline(machineId, this.nowIso());
    this.pauseCountsChanged();
    for (const [requestId, pending] of this.pendingCreates) {
      if (pending.machineId !== machineId) continue;
      clearTimeout(pending.timer);
      this.pendingCreates.delete(requestId);
    }
    this.rejectRequests(
      machineId,
      new HttpError(502, 'daemon_disconnected', 'Daemon disconnected'),
    );
    for (const session of this.store.listMachineSessions(machineId)) {
      if (
        session.endedAt !== null ||
        session.status === 'done' ||
        session.status === 'queued' ||
        session.status === 'offline'
      ) {
        continue;
      }
      this.store.setPreOfflineStatus(session.id, session.status);
      this.setStatus(session, 'offline', null, 'daemon_disconnected');
    }
    this.broadcastMachine(machineId);
  }

  // ── 連線：瀏覽器 ─────────────────────────────────────
  attachClient(ws: WebSocket, user: User, tokenHash: string): void {
    const client: ClientConn = {
      ws,
      userId: user.id,
      tokenHash,
      alive: true,
      watching: false,
      inputs: new Map(),
    };
    this.clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      try {
        this.onClientRaw(client, raw.toString(), isBinary);
      } catch (error) {
        this.log.error({ err: error }, 'client message failed');
        this.sendClientError(client, 'internal', 'Internal error');
      }
    });
    ws.on('close', () => this.guarded('client close', () => this.onClientClose(client)));
    ws.on('error', (error) => this.log.warn({ err: error }, 'client socket error'));
    this.send(ws, this.boardState());
  }

  private boardState(): HubToClient {
    return {
      type: 'board.state',
      machines: this.store.listMachines(),
      sessions: this.store.listSessions(false),
      approvals: this.approvalList(),
      waitingLimit: this.store.getSettings().notifications.waitingLimit,
      pause: this.boardPauseState(),
      zones: this.store.listZones(),
      broadcasts: this.broadcasts.list(),
    };
  }

  private approvalList(): Approval[] {
    return [...this.approvals.values()].map((a) => a.approval);
  }

  private onClientRaw(client: ClientConn, raw: string, isBinary: boolean): void {
    let json: unknown;
    try {
      json = isBinary ? undefined : JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const parsed = ClientToHub.safeParse(json);
    if (!parsed.success) {
      this.sendClientError(client, 'invalid_message', 'Message failed validation');
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case 'ping':
        this.send(client.ws, { type: 'pong', at: msg.at });
        return;
      case 'resources.watch':
        this.setWatching(client, msg.watching);
        return;
      case 'terminal.unsubscribe':
        this.relay.unsubscribe(client, msg.sessionId);
        return;
      case 'approval.decide':
        this.decideApproval(client, msg);
        return;
      default:
        break;
    }
    const session = this.store.getSession(msg.sessionId);
    if (!session) {
      this.sendClientError(client, 'session_not_found', `Unknown session ${msg.sessionId}`);
      return;
    }
    if (msg.type === 'terminal.subscribe') {
      this.relay.subscribe(client, msg.sessionId);
      return;
    }
    if (session.endedAt !== null) {
      this.sendClientError(client, 'session_ended', 'Session has ended');
      return;
    }
    if (!this.daemonFor(session.machineId)) {
      this.sendClientError(client, 'machine_offline', 'Machine is offline');
      return;
    }
    switch (msg.type) {
      case 'terminal.input':
        // 先寫 audit 再轉送：寫失敗就不送進終端機（例外由外層回 error）。
        this.auditInput(client, msg.sessionId, msg.data);
        if (/[\r\n]/.test(msg.data)) {
          this.handoff.onUserInput(msg.sessionId);
          this.roundLimits.delete(msg.sessionId);
        }
        // 使用者打了任何字：這次限流的自動接續取消（不能把我們的字接在他的字後面）。
        this.guarded('auto continue', () => this.autoContinue.onUserInput(msg.sessionId));
        // 在終端機裡按 Esc／Ctrl+C 中斷回合：派工成員手上的工作不會有 Stop，清掉（CONTRACTS §11）。
        if (msg.data === '\x1b' || msg.data === '\x03') this.interrupted(session);
        this.toSessionDaemon(msg.sessionId, msg);
        return;
      case 'terminal.resize': {
        // 只有尺寸擁有者的 resize 會套用（CONTRACTS §6.1 第 6 點）；claim 只在 hub 用，不轉給 daemon。
        const size = this.relay.resize(
          client,
          msg.sessionId,
          msg.cols,
          msg.rows,
          msg.claim === true,
        );
        if (size) {
          this.toSessionDaemon(msg.sessionId, {
            type: 'terminal.resize',
            sessionId: msg.sessionId,
            ...size,
          });
        }
        return;
      }
      case 'terminal.signal':
        client.inputs.get(msg.sessionId)?.clear();
        this.signal(client.userId, session, msg.signal);
        return;
    }
  }

  /** 使用者在終端機按的中斷／結束。 */
  private signal(userId: string, session: Session, signal: TerminalSignal): void {
    if (signal === 'terminate') this.handoff.onUserStop(session.id);
    else this.interrupted(session);
    this.guarded('auto continue', () => this.autoContinue.onUserInput(session.id));
    this.audit(userId, session.id, 'terminal.signal', signal);
    this.toSessionDaemon(session.id, { type: 'terminal.signal', sessionId: session.id, signal });
  }

  /** 只有回合進行中（會被中斷）才算；等輸入時按 Esc 只是關選單。 */
  private interrupted(session: Session): void {
    if (!['running', 'stuck', 'waiting_permission'].includes(session.status)) return;
    this.guarded('dispatch', () => this.dispatch.onInterrupt(session.id));
  }

  private auditInput(client: ClientConn, sessionId: string, data: string): void {
    let buffer = client.inputs.get(sessionId);
    if (!buffer) {
      buffer = new InputLineBuffer();
      client.inputs.set(sessionId, buffer);
    }
    for (const line of buffer.push(data)) {
      const atPrompt = this.prompts.atPasswordPrompt(sessionId);
      this.audit(client.userId, sessionId, 'terminal.input', atPrompt ? REDACTED_INPUT : line);
    }
  }

  private onClientClose(client: ClientConn): void {
    // 先算 watcher 再移除：setWatching 要看得到它原本的狀態才知道要不要通知 daemon。
    this.setWatching(client, false);
    this.clients.delete(client);
    this.relay.removeClient(client);
    // 還沒按 Enter 就離開的內容還留在 PTY 輸入列，也要留下紀錄。
    for (const [sessionId, buffer] of client.inputs) {
      const partial = buffer.flush();
      if (partial === null) continue;
      const atPrompt = this.prompts.atPasswordPrompt(sessionId);
      this.audit(
        client.userId,
        sessionId,
        'terminal.input.partial',
        atPrompt ? REDACTED_INPUT : partial,
      );
    }
  }

  private setWatching(client: ClientConn, watching: boolean): void {
    if (client.watching === watching) return;
    const before = this.hasWatchers();
    client.watching = watching;
    const after = this.hasWatchers();
    if (before === after || this.closed) return;
    for (const conn of this.daemons.values()) {
      if (conn.helloed) this.send(conn.ws, { type: 'resources.watch', watching: after });
    }
  }

  private hasWatchers(): boolean {
    for (const client of this.clients) if (client.watching) return true;
    return false;
  }

  /** 登出、改密碼、刪使用者時，既有的 WebSocket 要一起失效。 */
  dropClients(predicate: (client: { userId: string; tokenHash: string }) => boolean): void {
    for (const client of this.clients) {
      if (predicate(client)) client.ws.close(CLOSE_REVOKED, 'session revoked');
    }
  }

  // ── Approval ────────────────────────────────────────
  private cacheApproval(approval: Approval, machineId: string): void {
    const known = this.approvals.has(approval.id);
    this.approvals.set(approval.id, { approval, machineId });
    if (known) return;
    this.addEvent(approval.sessionId, 'approval.requested', {
      approvalId: approval.id,
      kind: approval.kind,
      toolName: approval.toolName,
    });
    this.broadcast({ type: 'approval.requested', approval });
    this.checkWaiting(true);
  }

  private resolveCachedApproval(
    approvalId: string,
    sessionId: string,
    by: 'web' | 'terminal' | 'timeout',
  ): void {
    const entry = this.approvals.get(approvalId);
    // 網頁決定時 hub 已經先處理完，daemon 的回音不用再發一次。
    if (!entry || entry.approval.sessionId !== sessionId) return;
    this.approvals.delete(approvalId);
    this.audit(null, sessionId, 'approval.resolved', JSON.stringify({ approvalId, by }));
    this.addEvent(sessionId, 'approval.resolved', { approvalId, by });
    this.broadcast({ type: 'approval.resolved', approvalId, sessionId, by });
    this.checkWaiting(true);
  }

  private reconcileApprovals(conn: DaemonConn, pending: Approval[]): void {
    const live = new Set<string>();
    for (const approval of pending) {
      if (
        !this.store.getSession(approval.sessionId) ||
        !this.ownsSession(conn, approval.sessionId)
      ) {
        continue;
      }
      live.add(approval.id);
      this.cacheApproval(approval, conn.machineId);
    }
    for (const [id, entry] of [...this.approvals]) {
      if (entry.machineId === conn.machineId && !live.has(id)) {
        this.resolveCachedApproval(id, entry.approval.sessionId, 'timeout');
      }
    }
  }

  private decideApproval(
    client: ClientConn,
    msg: Extract<ClientToHub, { type: 'approval.decide' }>,
  ): void {
    const entry = this.approvals.get(msg.approvalId);
    if (!entry || entry.approval.sessionId !== msg.sessionId) {
      this.sendClientError(client, 'approval_not_found', 'Approval is no longer pending');
      return;
    }
    // 危險指令只有 owner 能決定（CONTRACTS §2）。角色每次重查，不信連線建立時的狀態。
    if (entry.approval.kind === 'danger' && this.store.getUser(client.userId)?.role !== 'owner') {
      this.audit(
        client.userId,
        msg.sessionId,
        'approval.decide_forbidden',
        JSON.stringify({
          approvalId: msg.approvalId,
          matchedRule: entry.approval.matchedRule,
          behavior: msg.decision.behavior,
        }),
      );
      this.sendClientError(client, 'forbidden', 'Only an owner can decide dangerous commands');
      return;
    }
    const conn = this.daemonFor(entry.machineId);
    if (!conn) {
      this.sendClientError(client, 'machine_offline', 'Machine is offline');
      return;
    }
    // 先從快取移除：兩個人同時按，第二個會拿到 approval_not_found，不會把兩個決定都送出去。
    this.approvals.delete(msg.approvalId);
    const detail = {
      approvalId: msg.approvalId,
      kind: entry.approval.kind,
      toolName: entry.approval.toolName,
      matchedRule: entry.approval.matchedRule,
      decision: msg.decision,
    };
    this.audit(client.userId, msg.sessionId, 'approval.decide', JSON.stringify(detail));
    this.addEvent(msg.sessionId, 'approval.decided', { ...detail, userId: client.userId });
    this.send(conn.ws, {
      type: 'approval.decide',
      approvalId: msg.approvalId,
      sessionId: msg.sessionId,
      decision: msg.decision,
    });
    this.broadcast({
      type: 'approval.resolved',
      approvalId: msg.approvalId,
      sessionId: msg.sessionId,
      by: 'web',
    });
    this.checkWaiting(true);
  }

  // ── Session 生命週期 ─────────────────────────────────
  createSession(input: SessionSpec & { machineId: string; zoneId?: string }, user: User): Session {
    return this.createSessionAs(input, user.id, null);
  }

  /** userId 為 null：派工工具開的（系統動作，dispatchedBy 是呼叫者）。 */
  private createSessionAs(
    input: SessionSpec & { machineId: string; zoneId?: string },
    userId: string | null,
    dispatchedBy: string | null,
  ): Session {
    const { machineId, zoneId = DEFAULT_ZONE_ID, ...spec } = input;
    if (!this.store.getMachine(machineId)) throw notFound('Machine');
    this.requireZone(zoneId);
    if (!this.daemonFor(machineId)) throw conflict('machine_offline', 'Machine is offline');
    this.assertCwdNotDeleting(machineId, spec.cwd);
    const now = this.nowIso();
    const session: Session = {
      id: randomUUID(),
      machineId,
      projectId: spec.projectId,
      name: spec.name,
      cwd: spec.cwd,
      branch: null,
      worktreePath: null,
      permissionMode: spec.permissionMode,
      model: spec.model,
      accountProfile: spec.accountProfile,
      status: 'starting',
      statusDetail: null,
      claudeSessionId: spec.resumeClaudeSessionId,
      lastLines: [],
      lastOutputAt: null,
      statusSince: now,
      contextTokens: null,
      contextWindow: null,
      repoRoot: null,
      repoCommonDir: null,
      createdAt: now,
      endedAt: null,
      archived: false,
      archivedAt: null,
      readOnly: spec.readOnly,
      autoContinue: null,
      dispatchedBy,
      zoneId,
    };
    const blocked = this.queueReason(session);
    if (blocked !== undefined) {
      session.status = 'queued';
      session.statusDetail = blocked;
    }
    this.store.db.transaction(() => {
      this.store.insertSession(session, spec);
      this.audit(
        userId,
        session.id,
        'session.create',
        JSON.stringify({
          name: spec.name,
          machineId,
          cwd: spec.cwd,
          permissionMode: spec.permissionMode,
          model: spec.model,
          useWorktree: spec.useWorktree,
          readOnly: spec.readOnly,
          ...(dispatchedBy ? { dispatchedBy } : {}),
        }),
      );
      // firstPrompt 也是送入終端機的輸入。
      if (spec.firstPrompt !== null) {
        this.audit(userId, session.id, 'terminal.input', spec.firstPrompt);
      }
    })();
    this.broadcast({ type: 'session.updated', session });
    if (session.status === 'starting') this.dispatchCreate(session, spec);
    else {
      this.scheduleResetDrain();
      this.pauseCountsChanged();
    }
    return session;
  }

  private slotAvailable(): boolean {
    const max = this.store.getSettings().quotaGuards.maxConcurrentSessions;
    return max === null || this.store.countActiveSessions() < max;
  }

  /**
   * 現在不能開的原因（寫進 statusDetail）；undefined 表示可以開。帳號限流比較具體，先看；
   * 併發上限沿用舊行為，detail 是 null。
   */
  private queueReason(target: Session): string | null | undefined {
    if (this.limitedSessions(target).length > 0) return QUEUE_DETAIL_RATE_LIMITED;
    if (!this.slotAvailable()) return null;
    return undefined;
  }

  /**
   * 擋住 target 的限流中 session（§8-5）：同帳號、還活著、狀態是 rate_limited，
   * 而且訊息裡的重置時間（認得出來的話）還沒到。設定關掉就一律不擋。
   */
  private limitedSessions(target: Session): Session[] {
    if (!this.store.getSettings().quotaGuards.queueWhenRateLimited) return [];
    const now = this.deps.now().getTime();
    return this.store
      .listMachineSessions(target.machineId)
      .filter(
        (s) =>
          s.id !== target.id &&
          s.endedAt === null &&
          s.status === 'rate_limited' &&
          sameAccount(s, target) &&
          !this.resetPassed(s, now),
      );
  }

  private resetAt(session: Session): number | null {
    return parseRateLimitReset(session.statusDetail, new Date(session.statusSince));
  }

  private resetPassed(session: Session, now: number): boolean {
    const at = this.resetAt(session);
    return at !== null && now >= at + RATE_LIMIT_RESET_GRACE_MS;
  }

  /** 排隊中有人在等限流帳號、而且知道重置時間時，到時候再跑一次 drainQueue。 */
  private scheduleResetDrain(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    if (this.closed) return;
    let earliest: number | null = null;
    for (const { session } of this.store.queuedSessions()) {
      for (const limited of this.limitedSessions(session)) {
        const at = this.resetAt(limited);
        if (at !== null && (earliest === null || at < earliest)) earliest = at;
      }
    }
    if (earliest === null) return;
    const delay = earliest + RATE_LIMIT_RESET_GRACE_MS - this.deps.now().getTime();
    // setTimeout 上限約 24.8 天；超過就先睡到上限，醒來會重算。
    this.resetTimer = setTimeout(
      () => this.guarded('rate limit reset', () => this.drainQueue()),
      Math.min(Math.max(delay, 0), 2 ** 31 - 1),
    );
    this.resetTimer.unref();
  }

  private dispatchCreate(session: Session, spec: SessionSpec): void {
    const conn = this.daemonFor(session.machineId);
    if (!conn) return;
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (!this.pendingCreates.delete(requestId)) return;
      // 也許 session.created 沒來但 session.runtime 來了：已經動起來就不算失敗。
      if (this.store.getSession(session.id)?.status === 'starting') {
        this.guarded('create timeout', () =>
          this.failStart(session.id, SESSION_DETAIL_CREATE_TIMEOUT),
        );
      }
    }, this.timing.createTimeoutMs);
    timer.unref();
    this.pendingCreates.set(requestId, {
      sessionId: session.id,
      machineId: session.machineId,
      timer,
    });
    this.send(conn.ws, { type: 'session.create', requestId, sessionId: session.id, spec });
  }

  private takePendingCreate(requestId: string, machineId: string): PendingCreate | null {
    const pending = this.pendingCreates.get(requestId);
    if (!pending || pending.machineId !== machineId) return null;
    clearTimeout(pending.timer);
    this.pendingCreates.delete(requestId);
    return pending;
  }

  private failStart(sessionId: string, detail: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    this.store.setPendingSpec(sessionId, null);
    this.setStatus(session, 'error', detail, 'create_failed', { endedAt: this.nowIso() });
  }

  /**
   * 有名額就依序開始；機器離線的先跳過，不擋後面的人。帳號限流的也跳過（別的帳號照開），
   * 排隊原因變了就更新 statusDetail，畫面才說得出現在在等什麼。
   * 全部暫停中一個都不開（QUE 維持排隊，繼續時再跑一次）。
   */
  private drainQueue(): void {
    if (this.closed) return;
    for (const { session, spec } of this.store.queuedSessions()) {
      const reason = this.queueReason(session);
      if (reason === undefined && this.daemonFor(session.machineId) && this.pause === null) {
        const clean = sanitizeSpec(spec);
        // 不合協定的 spec daemon 會整則丟掉，等到逾時；直接標失敗。
        if (clean === null) {
          const badProfile = validAccountProfile(spec.accountProfile) === undefined;
          this.failStart(
            session.id,
            badProfile ? 'invalid_account_profile' : 'invalid_session_spec',
          );
          continue;
        }
        const started = this.setStatus(session, 'starting', null, 'dequeued');
        this.dispatchCreate(started, clean);
        continue;
      }
      // 名額滿了但這個帳號沒限流：維持 null（等名額）。
      const detail = reason ?? null;
      if (session.statusDetail !== detail) this.updateFields(session, { statusDetail: detail });
    }
    this.scheduleResetDrain();
  }

  stopSession(id: string, user: User): Session {
    const session = this.requireSession(id);
    if (session.status === 'queued') {
      this.store.setPendingSpec(id, null);
      this.audit(user.id, id, 'session.cancel', '');
      return this.setStatus(session, 'done', SESSION_DETAIL_CANCELLED, 'user_cancelled', {
        endedAt: this.nowIso(),
      });
    }
    if (session.endedAt !== null) throw conflict('session_ended', 'Session has already ended');
    const conn = this.daemonFor(session.machineId);
    if (!conn) throw conflict('machine_offline', 'Machine is offline');
    this.audit(user.id, id, 'session.stop', '');
    this.handoff.onUserStop(id);
    this.send(conn.ws, { type: 'session.stop', sessionId: id });
    return session;
  }

  /** 協定沒有 resume 訊息：沿用 sessionId 再送一次 session.create，帶舊的 claude id。 */
  resumeSession(id: string, user: User): Session {
    let session = this.requireSession(id);
    this.assertNotDeleting(id);
    if (session.endedAt === null) throw conflict('session_active', 'Session is still active');
    // 不合 UUID 格式的 id daemon 會整則丟掉（§9.6），當成沒有。
    const claudeSessionId = validClaudeId(session.claudeSessionId);
    if (claudeSessionId === null) {
      throw conflict('no_claude_session', 'Session has no Claude conversation to resume');
    }
    // daemon 會把相對路徑當成相對於它自己的工作資料夾（§9.6）：不送出。
    const accountProfile = validAccountProfile(session.accountProfile);
    if (accountProfile === undefined) {
      throw conflict('invalid_account_profile', 'The account folder is not an absolute path');
    }
    if (!this.daemonFor(session.machineId)) throw conflict('machine_offline', 'Machine is offline');
    // 接續已封存的：先還原，不然它會在跑卻不出現在畫布上（§9.1）。
    if (session.archived) session = this.restore(session, user, 'resume');
    const spec: SessionSpec = {
      name: session.name,
      projectId: session.projectId,
      cwd: session.worktreePath ?? session.cwd,
      useWorktree: false,
      permissionMode: session.permissionMode,
      model: session.model,
      accountProfile,
      resumeClaudeSessionId: claudeSessionId,
      firstPrompt: null,
      // 唯讀是建立時決定的，接續時照舊（daemon 才會再帶 --disallowedTools）。
      readOnly: session.readOnly,
    };
    this.audit(user.id, id, 'session.resume', '');
    this.store.setPendingSpec(id, spec);
    const blocked = this.queueReason(session);
    const available = blocked === undefined;
    const next = this.setStatus(
      session,
      available ? 'starting' : 'queued',
      available ? null : blocked,
      'user_resumed',
      { endedAt: null },
    );
    if (available) this.dispatchCreate(next, spec);
    else this.scheduleResetDrain();
    return next;
  }

  updateSession(
    id: string,
    patch: {
      name?: string;
      projectId?: string | null;
      archived?: boolean;
      markDone?: true;
      zoneId?: string;
    },
    user: User,
  ): Session {
    let session = this.requireSession(id);
    if (patch.zoneId !== undefined) {
      this.requireZone(patch.zoneId);
      if (patch.zoneId !== session.zoneId) {
        this.audit(
          user.id,
          id,
          'session.zone',
          JSON.stringify({ from: session.zoneId, to: patch.zoneId }),
        );
      }
    }
    const { markDone, archived, ...fields } = patch;
    // 封存要先停（可能因機器離線失敗），失敗時其他欄位也不改。
    if (archived === true && !session.archived) session = this.archive(session, user);
    else if (archived === false && session.archived) {
      this.assertNotDeleting(id);
      session = this.restore(session, user);
    }
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(defined).length > 0) session = this.updateFields(session, defined);
    if (markDone && session.status !== 'done') {
      this.audit(user.id, id, 'session.mark_done', '');
      // 使用者親自判定完成，接下來的交接不算上一條鏈的延續。
      this.handoff.onUserInput(id);
      this.store.setPendingSpec(id, null);
      session = this.setStatus(
        session,
        'done',
        null,
        'user_marked_done',
        session.status === 'queued' ? { endedAt: this.nowIso() } : {},
      );
    }
    return session;
  }

  /**
   * §9.1：還沒結束的先停（排隊的取消，其他與 sessionsStop 同一條路；機器離線就 409，不封存），
   * 再暫停從它出發或指向它的交接規則。
   */
  private archive(session: Session, user: User): Session {
    const live = session.endedAt === null;
    // 機器離線停不了：照樣封存，等 daemon 重連的 hello 對帳時補送 stop。
    const stopPending = live && session.status !== 'queued' && !this.daemonFor(session.machineId);
    const stopped = live && !stopPending;
    if (stopped) this.stopSession(session.id, user);
    if (stopPending) this.handoff.onUserStop(session.id);
    const rulesPaused = this.store.disableRulesTouching(session.id);
    const current = this.requireSession(session.id);
    const next = this.updateFields(current, { archived: true, archivedAt: this.nowIso() });
    this.audit(
      user.id,
      session.id,
      'session.archive',
      JSON.stringify({ stopped, stopPending, rulesPaused }),
    );
    return next;
  }

  /** 不自動重開，也不恢復被暫停的交接規則。 */
  private restore(session: Session, user: User, via: 'resume' | null = null): Session {
    const next = this.updateFields(session, { archived: false, archivedAt: null });
    this.audit(user.id, session.id, 'session.restore', via ? JSON.stringify({ via }) : '');
    return next;
  }

  private requireSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) throw notFound('Session');
    return session;
  }

  /** daemon 回報的欄位覆蓋 hub 的（§2）；archived、projectId、name 與 hub 專屬狀態不動。 */
  private applyRuntime(runtime: SessionRuntime): void {
    const prev = this.store.getSession(runtime.id);
    if (!prev || prev.status === 'queued') return;
    this.inputReady.set(runtime.id, runtime.inputReady === true);
    const wasOffline = prev.status === 'offline';
    const preOffline = wasOffline ? this.store.preOfflineStatus(runtime.id) : null;
    const exitedCleanly = runtime.status === 'done' && runtime.endedAt !== null;
    // 使用者標記完成後又在同一個行程裡開始工作（例如送了 /clear 再下指令），就不算完成了。
    const resumedAfterDone =
      prev.status === 'done' &&
      runtime.endedAt === null &&
      runtime.status === 'running' &&
      runtime.statusSince > prev.statusSince;
    const keepStatus =
      (prev.status === 'done' && !resumedAfterDone) ||
      (HUB_ONLY_STATUSES.includes(runtime.status) && !exitedCleanly);
    const next: Session = {
      ...prev,
      cwd: runtime.cwd,
      branch: runtime.branch,
      worktreePath: runtime.worktreePath,
      claudeSessionId: runtime.claudeSessionId,
      lastLines: runtime.lastLines,
      lastOutputAt: runtime.lastOutputAt,
      contextTokens: runtime.contextTokens,
      contextWindow: runtime.contextWindow,
      repoRoot: runtime.repoRoot,
      repoCommonDir: runtime.repoCommonDir,
      endedAt: runtime.endedAt,
      ...(keepStatus
        ? {}
        : {
            status: runtime.status,
            statusDetail: runtime.statusDetail,
            statusSince: runtime.statusSince,
          }),
    };
    this.store.updateSession(next);
    if (wasOffline && !keepStatus) this.store.setPreOfflineStatus(runtime.id, null);
    // 斷線前就在等人的 session，重連不算「新進入」，不重複推播。
    this.afterChange(prev, next, !(wasOffline && preOffline === next.status));
  }

  /** hub 自己決定的狀態變化：寫 session_events 並通知前端。 */
  private setStatus(
    session: Session,
    status: SessionStatus,
    detail: string | null,
    reason: string,
    extra: Partial<Session> = {},
    notify = true,
  ): Session {
    const next: Session = {
      ...session,
      ...extra,
      status,
      statusDetail: detail,
      statusSince: status === session.status ? session.statusSince : this.nowIso(),
    };
    this.store.updateSession(next);
    if (status !== session.status) {
      // 狀態歷史也存 detail（舊資料頁要分得出 NEW 與 ASK，GM 2026-11-08）。
      this.addEvent(session.id, 'status', {
        from: session.status,
        fromDetail: session.statusDetail,
        to: status,
        detail,
        reason,
      });
    }
    this.afterChange(session, next, notify);
    return next;
  }

  private updateFields(session: Session, fields: Partial<Session>): Session {
    const next = { ...session, ...fields };
    this.store.updateSession(next);
    this.afterChange(session, next, false);
    return next;
  }

  private afterChange(prev: Session, next: Session, mayNotify: boolean): void {
    this.broadcast({ type: 'session.updated', session: next });
    // QUE 數、會放出的 QUE 數（名額、限流、機器在線都看狀態）都可能變了；沒變的不會推。
    if (prev.status !== next.status) this.pauseCountsChanged();
    // 「結果不明」當時沒推播；daemon 補送真正的結果時才算第一次得知，所以就算同樣是 error 也要發。
    const outcomeLearned =
      prev.statusDetail === SESSION_DETAIL_LOST && next.statusDetail !== SESSION_DETAIL_LOST;
    const entered = prev.status !== next.status || outcomeLearned;
    if (mayNotify && entered && needsAttention(next.status)) {
      this.notifyAttention(next);
    }
    this.guarded('delivery', () => this.delivery.onSessionChange(prev, next));
    this.guarded('handoff', () => this.handoff.onSessionChange(prev, next, mayNotify && entered));
    this.guarded('auto continue', () => this.autoContinue.onSessionChange(prev, next));
    this.guarded('dispatch', () => this.dispatch.onSessionChange(prev, next));
    if (next.endedAt !== null || next.archived) {
      this.roundLimits.delete(next.id);
      this.inputReady.delete(next.id);
    }
    if (
      prev.status !== next.status ||
      prev.statusDetail !== next.statusDetail ||
      prev.archived !== next.archived
    ) {
      this.checkWaiting(mayNotify);
    }
    // 離開限流（例如重置後繼續工作）也可能放出同帳號排隊中的 session（§8-5）；
    // 進入限流或重置時間變了，要重排計時器。
    const limitChanged =
      prev.status === 'rate_limited' || next.status === 'rate_limited'
        ? prev.status !== next.status || prev.statusDetail !== next.statusDetail
        : false;
    if ((holdsSlot(prev) && !holdsSlot(next)) || limitChanged) this.drainQueue();
  }

  private addEvent(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    at: string = this.nowIso(),
  ): void {
    const event = { id: randomUUID(), sessionId, type, payload, at };
    this.store.insertEvent(event);
    this.broadcast({ type: 'session.event', event });
  }

  // ── 團隊任務（任務自動執行，GM 2026-11-06）────────────
  createTask(teamId: string, input: Pick<Task, 'title' | 'ownerSessionId'>): Task {
    const task: Task = {
      id: randomUUID(),
      teamId,
      title: input.title,
      ownerSessionId: input.ownerSessionId,
      column: 'todo',
      number: this.store.takeTaskNumber(teamId),
      rejectCount: 0,
      needsUser: false,
      reviewerSessionId: null,
      auto: null,
    };
    this.store.upsertTask(task);
    return task;
  }

  /**
   * 使用者在任務板上改任務。移欄或換負責人：清掉「等你決定」與最後一步的顯示（使用者已經接手），
   * 退回次數保留（是任務的歷史，不悄悄歸零）。開關開著時，進入進行中／待審查會自動送出。
   */
  updateTask(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'ownerSessionId' | 'column'>>,
    user: User,
  ): Task {
    const current = this.store.getTask(id);
    if (!current) throw notFound('Task');
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as typeof patch;
    let next: Task = { ...current, ...defined };
    if (next.column !== 'todo' && next.ownerSessionId === null) {
      throw conflict('task_unassigned', 'Assign the task before moving it');
    }
    const moved = next.column !== current.column || next.ownerSessionId !== current.ownerSessionId;
    if (moved) next = { ...next, needsUser: false, auto: null };
    this.store.upsertTask(next);
    if (moved) {
      this.audit(
        user.id,
        next.ownerSessionId,
        'task.update',
        JSON.stringify({
          taskId: id,
          teamId: next.teamId,
          number: next.number,
          column: next.column,
          ownerSessionId: next.ownerSessionId,
        }),
      );
    }
    this.guarded('tasks', () => this.tasks.userChanged(current, next));
    return this.store.getTask(id) ?? next;
  }

  deleteTask(id: string): void {
    const current = this.store.getTask(id);
    if (!current || !this.store.deleteTask(id)) throw notFound('Task');
    this.tasks.userDeleted(current);
  }

  /** 開關會決定要不要花成員的額度：誰開、誰關都寫 audit。關掉時排隊中的任務不送了。 */
  updateTeam(id: string, patch: Partial<Omit<Team, 'id'>>, user: User): Team {
    const current = this.store.getTeam(id);
    if (!current) throw notFound('Team');
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as typeof patch;
    const next: Team = { ...current, ...defined };
    if (next.zoneId !== current.zoneId) {
      this.requireZone(next.zoneId);
      this.audit(
        user.id,
        null,
        'team.zone',
        JSON.stringify({ teamId: id, from: current.zoneId, to: next.zoneId }),
      );
    }
    this.store.upsertTeam(next);
    this.broadcastTeam(id);
    if (Boolean(current.taskAuto) !== Boolean(next.taskAuto)) {
      this.audit(
        user.id,
        null,
        'team.task_auto',
        JSON.stringify({ teamId: id, on: !!next.taskAuto }),
      );
    }
    this.guarded('tasks', () => this.tasks.teamChanged(current, next));
    return this.store.getTeam(id) ?? next;
  }

  /** 團隊建立、修改後推給每個 client（不等前端輪詢）。不存在了就推 team.removed。 */
  broadcastTeam(teamId: string): void {
    const team = this.store.getTeam(teamId);
    this.broadcast(team ? { type: 'team.updated', team } : { type: 'team.removed', teamId });
  }

  /**
   * 成員離開團隊（或團隊刪掉）：它自己的工作區欄位原本被忽略，改成團隊所在的工作區，
   * 卡片才不會跳到別的工作區（P2 §2.2）。回傳有沒有改。
   */
  leaveTeamZone(sessionId: string, team: Team): void {
    const session = this.store.getSession(sessionId);
    if (!session || session.zoneId === team.zoneId) return;
    if (this.store.teamsOfSession(sessionId).length > 0) return;
    this.store.setSessionZone(sessionId, team.zoneId);
    this.broadcastSession(sessionId);
  }

  // ── 群發（P2 項目二）─────────────────────────────────
  teamBroadcast(teamId: string, text: string, targets: string[] | undefined, user: User) {
    return this.broadcasts.send(teamId, text, targets, user);
  }

  cancelBroadcast(broadcastId: string, sessionId: string, user: User) {
    return this.broadcasts.cancel(broadcastId, sessionId, user);
  }

  // ── 工作區（P2 項目二；程式內叫 zone）────────────────
  private requireZone(id: string): Zone {
    const zone = this.store.getZone(id);
    if (!zone) throw new HttpError(400, 'unknown_zone', `Unknown workspace ${id}`);
    return zone;
  }

  private broadcastZones(): void {
    this.broadcast({ type: 'zone.list', zones: this.store.listZones() });
  }

  createZone(name: string, user: User): Zone {
    const zone = this.store.insertZone({ id: randomUUID(), name, createdAt: this.nowIso() });
    this.audit(user.id, null, 'zone.create', JSON.stringify({ id: zone.id, name }));
    this.broadcastZones();
    return zone;
  }

  renameZone(id: string, name: string, user: User): Zone {
    const zone = this.store.getZone(id);
    if (!zone) throw notFound('Workspace');
    this.store.renameZone(id, name);
    this.audit(user.id, null, 'zone.rename', JSON.stringify({ id, from: zone.name, to: name }));
    this.broadcastZones();
    return { ...zone, name };
  }

  /**
   * 只有沒有團隊、也沒有單獨 session（沒封存的）時才能刪；最後一個不能刪。
   * 封存的 session、成員那欄、便利貼搬到第一個剩下的工作區。
   */
  deleteZone(id: string, user: User): void {
    const zones = this.store.listZones();
    const zone = zones.find((z) => z.id === id);
    if (!zone) throw notFound('Workspace');
    if (zones.length <= 1) throw conflict('last_zone', 'The last workspace cannot be deleted');
    const { teams, sessions } = this.store.zoneContents(id);
    if (teams > 0 || sessions > 0) {
      throw conflict(
        'zone_not_empty',
        `Move ${teams} team(s) and ${sessions} session(s) to another workspace first (teams=${teams}, sessions=${sessions})`,
      );
    }
    const fallback = zones.find((z) => z.id !== id)!;
    const moved = this.store
      .listSessions()
      .filter((s) => s.zoneId === id)
      .map((s) => s.id);
    this.store.deleteZone(id, fallback.id);
    this.audit(user.id, null, 'zone.delete', JSON.stringify({ id, name: zone.name }));
    for (const sessionId of moved) this.broadcastSession(sessionId);
    this.broadcastZones();
  }

  // ── 機器 ─────────────────────────────────────────────
  deleteMachine(id: string, user: User): void {
    const machine = this.store.getMachine(id);
    if (!machine) throw notFound('Machine');
    const sessions = this.store.listMachineSessions(id);
    this.audit(user.id, null, 'machine.delete', JSON.stringify({ id, name: machine.name }));
    // 先刪 token（連同機器），這之後就算 daemon 重連也會在升級時被 401。
    this.store.deleteMachine(id);
    const conn = this.daemons.get(id);
    if (conn) {
      // token 撤銷後沒人管得到那邊的 claude，連線還在就請它一起停。
      // 機器離線時送不到：daemon 重連被 401 持續拒絕後會自己停（daemon.ts REVOKED_GRACE_MS）。
      for (const session of sessions) {
        if (session.endedAt === null && conn.helloed) {
          this.send(conn.ws, { type: 'session.stop', sessionId: session.id });
        }
      }
      this.daemons.delete(id);
      this.retireDaemon(conn);
      conn.ws.close(CLOSE_REVOKED, 'machine removed');
      // 對方不回 close frame 也要斷。
      setTimeout(() => conn.ws.terminate(), 2000).unref();
    }
    for (const [requestId, pending] of this.pendingCreates) {
      if (pending.machineId !== id) continue;
      clearTimeout(pending.timer);
      this.pendingCreates.delete(requestId);
    }
    this.rejectRequests(id, new HttpError(502, 'daemon_disconnected', 'Machine removed'));
    this.usage.delete(id);
    // session 已刪，不能寫 session_events；audit 沒有外鍵，照記。
    for (const [approvalId, entry] of [...this.approvals]) {
      if (entry.machineId !== id) continue;
      const { sessionId } = entry.approval;
      this.approvals.delete(approvalId);
      this.audit(
        null,
        sessionId,
        'approval.resolved',
        JSON.stringify({ approvalId, by: 'timeout', reason: 'machine_removed' }),
      );
      this.broadcast({ type: 'approval.resolved', approvalId, sessionId, by: 'timeout' });
    }
    for (const session of sessions) {
      this.prompts.forget(session.id);
      this.relay.dropSession(session.id);
      this.broadcast({ type: 'session.removed', sessionId: session.id });
    }
    this.broadcast({ type: 'machine.removed', machineId: id });
    this.drainQueue();
  }

  broadcastMachine(machineId: string): void {
    const machine = this.store.getMachine(machineId);
    if (machine) this.broadcast({ type: 'machine.updated', machine });
  }

  broadcastSession(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (session) this.broadcast({ type: 'session.updated', session });
  }

  latestUsage(machineId: string): UsageSummary | null {
    return this.usage.get(machineId) ?? null;
  }

  async browse(machineId: string, path: string): Promise<BrowseResult> {
    const reply = await this.askDaemon(
      machineId,
      'fs.listResult',
      this.timing.browseTimeoutMs,
      (requestId) => ({ type: 'fs.list', requestId, path }),
    );
    return browseResult(reply);
  }

  /** 在 parent 底下建一層資料夾；回傳新資料夾的列表。不覆蓋已存在的。 */
  async mkdir(
    userId: string,
    machineId: string,
    parent: string,
    name: string,
  ): Promise<BrowseResult> {
    const reply = await this.askDaemon(
      machineId,
      'fs.listResult',
      this.timing.browseTimeoutMs,
      (requestId) => ({ type: 'fs.mkdir', requestId, parent, name }),
    );
    const result = browseResult(reply);
    this.audit(userId, null, 'fs.mkdir', JSON.stringify({ machineId, path: result.path }));
    return result;
  }

  // ── 封存、刪除、看舊資料（CONTRACTS §9） ─────────────────
  /** 刪除前的檢查：daemon 看機器上的狀況，hooksShared 由 hub 依資料庫算。 */
  async inspectSession(id: string): Promise<SessionInspect> {
    const session = this.requireSession(id);
    const reply = await this.askDaemon(
      session.machineId,
      'session.inspectResult',
      this.timing.sessionFilesTimeoutMs,
      (requestId) => ({ type: 'session.inspect', requestId, target: locatorFor(session) }),
    );
    if (reply.error !== null || reply.inspect === null) {
      throw new HttpError(502, 'daemon_error', reply.error ?? 'Daemon returned no result');
    }
    return {
      ...reply.inspect,
      hooksShared: this.hooksShared(session),
      worktreeShared: this.worktreeShared(session),
      transcriptShared: this.transcriptShared(session),
    };
  }

  /** 讀 Claude 的對話紀錄。沒有 claude id（或格式不對，daemon 不會接受）就不用問 daemon。 */
  async sessionTranscript(
    id: string,
    query: { cursor: number; limit: number; q?: string | undefined },
  ): Promise<TranscriptPage> {
    const session = this.requireSession(id);
    const claudeSessionId = validClaudeId(session.claudeSessionId);
    if (claudeSessionId === null) {
      return { entries: [], total: 0, matched: null, nextCursor: null, missing: true };
    }
    const q = query.q?.trim() ? query.q : null;
    const reply = await this.askDaemon(
      session.machineId,
      'session.transcriptResult',
      this.timing.sessionFilesTimeoutMs,
      (requestId) => ({
        type: 'session.transcript',
        requestId,
        claudeSessionId,
        accountProfile: session.accountProfile || null,
        cursor: query.cursor,
        limit: query.limit,
        query: q,
      }),
    );
    if (reply.error !== null || reply.page === null) {
      throw new HttpError(502, 'daemon_error', reply.error ?? 'Daemon returned no result');
    }
    return reply.page;
  }

  /**
   * 永久刪除（§9.4）：只刪已封存且已結束的。勾了清理項目就先等 daemon 清完（逾時不刪 hub 資料），
   * 再刪資料列並廣播。audit_log 沒有外鍵，紀錄保留。
   */
  async deleteSession(id: string, options: PurgeOptions, user: User): Promise<PurgeResult> {
    const session = this.requireSession(id);
    this.assertNotDeleting(id);
    this.assertDeletable(session);
    const wantsPurge = options.removeWorktree || options.removeTranscript || options.removeHooks;
    if (wantsPurge && !this.daemonFor(session.machineId)) {
      throw conflict('machine_offline', 'Machine is offline');
    }
    if (options.removeHooks && this.hooksShared(session)) {
      throw conflict('hooks_shared', 'Another session uses the same folder and its hooks');
    }
    if (options.removeWorktree && this.worktreeShared(session)) {
      throw conflict('worktree_shared', 'Another session works in the same worktree');
    }
    if (options.removeTranscript && this.transcriptShared(session)) {
      throw conflict('transcript_shared', 'Another session uses the same Claude conversation');
    }
    const skipped = { status: 'skipped', detail: null } as const;
    let result: PurgeResult = { worktree: skipped, transcript: skipped, hooks: skipped };
    if (!wantsPurge) return this.removeSessionRow(id, result, user);

    const lock: DeleteLock = {
      userId: user.id,
      machineId: session.machineId,
      cwd: session.cwd,
      worktreePath: session.worktreePath,
      requestId: null,
      timer: setTimeout(() => {
        if (this.deleting.get(id) !== lock) return;
        this.deleting.delete(id);
        this.log.warn(
          { sessionId: id, machineId: lock.machineId },
          'delete lock expired without a purge result',
        );
      }, this.timing.deleteLockMaxMs),
    };
    lock.timer.unref();
    this.deleting.set(id, lock);
    let reply: Extract<DaemonReply, { type: 'session.purgeResult' }>;
    try {
      reply = await this.askDaemon(
        session.machineId,
        'session.purgeResult',
        this.timing.purgeTimeoutMs,
        (requestId) => {
          lock.requestId = requestId;
          return { type: 'session.purge', requestId, target: locatorFor(session), options };
        },
      );
    } catch (error) {
      // 逾時：daemon 可能還在清，鎖留到 purgeResult 或斷線（onDaemonReply／rejectRequests）。
      if (!(error instanceof HttpError && error.status === 504)) this.releaseDeleteLock(id, lock);
      throw error;
    }
    try {
      if (reply.error !== null || reply.result === null) {
        throw new HttpError(
          reply.error === 'session_active' ? 409 : 502,
          reply.error === 'session_active' ? 'session_active' : 'daemon_error',
          reply.error ?? 'Daemon returned no result',
        );
      }
      result = reply.result;
      return this.removeSessionRow(id, result, user);
    } finally {
      this.releaseDeleteLock(id, lock);
    }
  }

  private removeSessionRow(id: string, result: PurgeResult, user: User): PurgeResult {
    // 等 daemon 的期間可能被還原或接續了：那就不刪資料列（機器上已清的檔案記進 audit）。
    const current = this.store.getSession(id);
    if (!current) throw notFound('Session');
    try {
      this.assertDeletable(current);
    } catch (error) {
      this.audit(
        user.id,
        id,
        'session.purge_aborted',
        JSON.stringify({ name: current.name, result }),
      );
      throw error;
    }
    this.store.deleteSession(id);
    this.prompts.forget(id);
    this.relay.dropSession(id);
    this.audit(
      user.id,
      id,
      'session.delete',
      JSON.stringify({
        name: current.name,
        cwd: current.cwd,
        machineId: current.machineId,
        result,
      }),
    );
    this.broadcast({ type: 'session.removed', sessionId: id });
    return result;
  }

  private assertDeletable(session: Session): void {
    if (!session.archived) throw conflict('not_archived', 'Archive the session before deleting it');
    if (session.endedAt !== null) return;
    throw conflict('session_active', 'Session is still active');
  }

  private assertNotDeleting(id: string): void {
    if (this.deleting.has(id)) throw conflict('session_deleting', 'Session is being deleted');
  }

  /** 新 session 開在刪除中 session 的 cwd 或它的 worktree 裡：daemon 可能正在清那裡。 */
  private assertCwdNotDeleting(machineId: string, cwd: string): void {
    for (const lock of this.deleting.values()) {
      if (lock.machineId !== machineId) continue;
      const wt = lock.worktreePath;
      if (cwd === lock.cwd || (wt !== null && (cwd === wt || cwd.startsWith(`${wt}/`)))) {
        throw conflict('session_deleting', 'A session in this folder is being deleted');
      }
    }
  }

  private releaseDeleteLock(id: string, lock: DeleteLock): void {
    if (this.deleting.get(id) !== lock) return;
    clearTimeout(lock.timer);
    this.deleting.delete(id);
  }

  private worktreeShared(session: Session): boolean {
    if (session.worktreePath === null) return false;
    return (
      this.store.countSessionsInWorktree(session.machineId, session.worktreePath, session.id) > 0
    );
  }

  private transcriptShared(session: Session): boolean {
    if (session.claudeSessionId === null) return false;
    return (
      this.store.countSessionsSharingClaudeId(
        session.machineId,
        session.accountProfile,
        session.claudeSessionId,
        session.id,
      ) > 0
    );
  }

  /** 同機器同 cwd 還有別的 session：hook 設定共用，不能拿掉。 */
  private hooksShared(session: Session): boolean {
    return this.store.countSessionsSharingCwd(session.machineId, session.cwd, session.id) > 0;
  }

  private askDaemon<T extends DaemonReply['type']>(
    machineId: string,
    expects: T,
    timeoutMs: number,
    message: (requestId: string) => DaemonRequest,
  ): Promise<Extract<DaemonReply, { type: T }>> {
    if (!this.store.getMachine(machineId)) throw notFound('Machine');
    const conn = this.daemonFor(machineId);
    if (!conn) throw conflict('machine_offline', 'Machine is offline');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new HttpError(504, 'daemon_timeout', 'Daemon did not respond in time'));
      }, timeoutMs);
      timer.unref();
      this.pendingRequests.set(requestId, {
        machineId,
        expects,
        timer,
        resolve: (reply) => resolve(reply as Extract<DaemonReply, { type: T }>),
        reject,
      });
      this.send(conn.ws, message(requestId));
    });
  }

  /** daemon 只能回自己機器、且是同一種請求的 requestId；其他一律丟掉。 */
  private onDaemonReply(conn: DaemonConn, msg: DaemonReply): void {
    if (msg.type === 'session.purgeResult') {
      // hub 已經回 504 的刪除，daemon 晚到的結果也要解鎖。
      for (const [sessionId, lock] of this.deleting) {
        if (lock.requestId === msg.requestId && lock.machineId === conn.machineId) {
          // hub 已經回了 504：沒人等這個結果，但機器上可能已刪了東西，要查得到。
          if (!this.pendingRequests.has(msg.requestId)) {
            this.audit(
              lock.userId,
              sessionId,
              'session.purge_late',
              JSON.stringify({ result: msg.result, error: msg.error }),
            );
          }
          this.releaseDeleteLock(sessionId, lock);
        }
      }
    }
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending || pending.machineId !== conn.machineId || pending.expects !== msg.type) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);
    pending.resolve(msg);
  }

  private rejectRequests(machineId: string, error: Error): void {
    // daemon 斷線或機器被移除：刪除鎖一起解（daemon 那邊的清理已經中斷或結束）。
    for (const [sessionId, lock] of this.deleting) {
      if (lock.machineId === machineId) this.releaseDeleteLock(sessionId, lock);
    }
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.machineId !== machineId) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.reject(error);
    }
  }

  // ── 全部暫停（P2 項目三） ────────────────────────────
  /**
   * 讀出上次的暫停狀態。暫停中 hub 重啟：記憶體裡被擋下的送字已經不在，把則數記進 clearedOnRestart
   * 讓畫面交代（自動接續存在資料庫，會重新排進來，不算）。
   */
  private loadPause(): StoredBoardPause | null {
    const { pause, invalid } = this.store.getBoardPause();
    if (invalid) this.log.warn({}, 'stored board pause state is invalid; treating as not paused');
    if (!pause || pause.heldInMemory === 0) return pause;
    const next: StoredBoardPause = {
      ...pause,
      clearedOnRestart: pause.clearedOnRestart + pause.heldInMemory,
      heldInMemory: 0,
    };
    this.store.setBoardPause(next);
    this.audit(
      null,
      null,
      'board.held_cleared',
      JSON.stringify({ reason: 'hub_restarted', count: pause.heldInMemory }),
    );
    return next;
  }

  isPaused(): boolean {
    return this.pause !== null;
  }

  /** 記憶體佇列裡的送字（不含自動接續，自動接續存在資料庫）。 */
  private heldDeliveries(): number {
    return this.delivery.pendingKeys().filter((key) => !isAutoContinueKey(key)).length;
  }

  /**
   * 排隊統計。sessions 只算繼續後 drainQueue 會馬上開的：帳號沒限流、機器在線，再依同時 session 上限截斷
   * （順序和 drainQueue 一樣）。其餘的 QUE 算在 sessionsWaiting。
   */
  private heldCounts(): BoardHeld {
    const keys = this.delivery.pendingKeys();
    const autoContinues = keys.filter(isAutoContinueKey).length;
    const max = this.store.getSettings().quotaGuards.maxConcurrentSessions;
    let free = max === null ? Infinity : Math.max(0, max - this.store.countActiveSessions());
    let sessions = 0;
    let sessionsWaiting = 0;
    for (const { session } of this.store.queuedSessions()) {
      const startable =
        free > 0 &&
        this.limitedSessions(session).length === 0 &&
        this.daemonFor(session.machineId) !== null;
      if (startable) {
        sessions += 1;
        free -= 1;
      } else {
        sessionsWaiting += 1;
      }
    }
    return { deliveries: keys.length - autoContinues, sessions, sessionsWaiting, autoContinues };
  }

  boardPauseState(): BoardPauseState {
    const held = this.heldCounts();
    if (!this.pause) return { paused: null, held };
    const { mode, since, by, byName, clearedOnRestart } = this.pause;
    return { paused: { mode, since, by, byName, clearedOnRestart }, held };
  }

  /**
   * 全部暫停。finish_turn：擋自動送字與自動開新 session，正在跑的跑完。interrupt：同上，
   * 另外對每個 RUN 的 session 送一次 Esc（離線機器上的不送，列為 offline）。已暫停時再按＝改模式
   * （interrupt 會再送一次 Esc），開始時間不變。GM 自己的手動輸入一律不擋（Q6）。
   */
  pauseBoard(
    user: User,
    mode: BoardPauseMode,
  ): { state: BoardPauseState; interrupted: BoardInterruptResult[] } {
    const prev = this.pause;
    this.pause = {
      mode,
      since: prev?.since ?? this.nowIso(),
      by: user.id,
      byName: user.name,
      clearedOnRestart: prev?.clearedOnRestart ?? 0,
      heldInMemory: this.heldDeliveries(),
    };
    this.store.setBoardPause(this.pause);
    // 剛暫停：已在佇列裡等目標空下來的，從現在起也是被擋下的，一則一則記下來。
    if (!prev) this.delivery.noteHeld();
    const interrupted = mode === 'interrupt' ? this.interruptRunning() : [];
    // 剛被 spawn_member 開、還在啟動的成員：daemon 啟動後會自己把派工訊息（firstPrompt）送進去，閘門擋不到。
    // 記下來讓 GM 知道（CONTRACTS §12）。
    const startingDispatched = this.store
      .listSessions()
      .filter((s) => s.endedAt === null && s.status === 'starting' && s.dispatchedBy !== null)
      .map((s) => s.id);
    for (const r of interrupted) {
      if (r.result === 'requested') this.pauseInterrupts.set(r.sessionId, user.id);
    }
    this.audit(
      user.id,
      null,
      'board.pause',
      JSON.stringify({
        mode,
        previous: prev?.mode ?? null,
        interrupted,
        ...(startingDispatched.length > 0 ? { startingDispatched } : {}),
      }),
    );
    this.broadcastPause();
    return { state: this.boardPauseState(), interrupted };
  }

  /**
   * 請 daemon 對每個 RUN 送一次 Esc（`onlyIfStatus: 'running'`，daemon 看到的不是 running 就不送）。
   * 派工工作、自動接續、`terminal.signal` audit 等 daemon 回報真的送了才處理（onPauseSignalResult），
   * 否則 daemon 沒送、成員其實沒被中斷，hub 卻先清掉它手上的工作，之後 Stop 的結果就送不回呼叫者。
   * 舊版 daemon 不會再確認狀態（Esc 可能把權限請求按成拒絕），不送，列為 unsupported。
   */
  private interruptRunning(): BoardInterruptResult[] {
    const results: BoardInterruptResult[] = [];
    for (const session of this.store.listSessions()) {
      if (session.endedAt !== null) continue;
      const running = session.status === 'running';
      // 機器斷線時 RUN 會變成 OFF：記得斷線前在跑的，回報「沒送到：失聯」。
      const wasRunning =
        session.status === 'offline' && this.store.preOfflineStatus(session.id) === 'running';
      if (!running && !wasRunning) continue;
      const base = { sessionId: session.id, name: session.name };
      const conn = running ? this.daemonFor(session.machineId) : null;
      if (!conn) {
        results.push({ ...base, result: 'offline' });
      } else if (!conn.features.has(DAEMON_FEATURES.signalGuard)) {
        results.push({ ...base, result: 'unsupported' });
      } else {
        this.toSessionDaemon(session.id, {
          type: 'terminal.signal',
          sessionId: session.id,
          signal: 'escape',
          onlyIfStatus: 'running',
        });
        results.push({ ...base, result: 'requested' });
      }
    }
    return results;
  }

  /** daemon 回報「立刻中斷」的 Esc 有沒有送。只認這次暫停送出的；送了才照使用者按 Esc 處理。 */
  private onPauseSignalResult(msg: Extract<DaemonToHub, { type: 'terminal.signalResult' }>): void {
    const userId = this.pauseInterrupts.get(msg.sessionId);
    if (userId === undefined) return;
    this.pauseInterrupts.delete(msg.sessionId);
    if (!msg.sent) {
      this.audit(
        userId,
        msg.sessionId,
        'board.interrupt_skipped',
        JSON.stringify({ status: msg.status }),
      );
      return;
    }
    this.audit(userId, msg.sessionId, 'terminal.signal', msg.signal);
    // daemon 確認送 Esc 時在跑：中斷的回合不會有 Stop，派工成員手上的工作清掉（CONTRACTS §11）。
    this.guarded('dispatch', () => this.dispatch.onInterrupt(msg.sessionId));
    this.guarded('auto continue', () => this.autoContinue.onUserInput(msg.sessionId));
  }

  /** 全部繼續：只解除閘門，不對被中斷的 session 送「繼續」（Q8）。沒暫停時什麼都不做。 */
  resumeBoard(user: User): { state: BoardPauseState; released: BoardHeld } {
    const prev = this.pause;
    if (!prev) {
      return {
        state: this.boardPauseState(),
        released: { deliveries: 0, sessions: 0, sessionsWaiting: 0, autoContinues: 0 },
      };
    }
    const released = this.heldCounts();
    this.pause = null;
    this.pauseInterrupts.clear();
    this.store.setBoardPause(null);
    this.audit(
      user.id,
      null,
      'board.resume',
      JSON.stringify({ mode: prev.mode, since: prev.since, released }),
    );
    // 放出排隊的送字與 session，再推狀態（推的是放出之後的排隊數）。
    this.guarded('delivery', () => this.delivery.flush());
    this.drainQueue();
    this.broadcastPause();
    return { state: this.boardPauseState(), released };
  }

  private auditHeld(item: DeliveryItem): void {
    const chars = [...item.message];
    const message =
      chars.length > HELD_MESSAGE_MAX
        ? `${chars.slice(0, HELD_MESSAGE_MAX).join('')}…`
        : item.message;
    this.audit(
      null,
      item.targetId,
      'board.held',
      JSON.stringify({ kind: heldKind(item.key), key: item.key, message }),
    );
  }

  /**
   * 排隊數可能變了：暫停中資料庫記下記憶體佇列的則數（重啟時交代）；不論有沒有暫停，合併成一則推給 client
   * （沒暫停時 held 照算，同一個事件迴圈內的變化合併，沒變不推）。
   */
  private pauseCountsChanged(): void {
    if (this.closed) return;
    if (this.pause) {
      const inMemory = this.heldDeliveries();
      if (inMemory !== this.pause.heldInMemory) {
        this.pause = { ...this.pause, heldInMemory: inMemory };
        this.store.setBoardPause(this.pause);
      }
    }
    if (this.pauseBroadcastQueued) return;
    this.pauseBroadcastQueued = true;
    queueMicrotask(() =>
      this.guarded('pause broadcast', () => {
        this.pauseBroadcastQueued = false;
        if (!this.closed) this.broadcastPause(false);
      }),
    );
  }

  private broadcastPause(force = true): void {
    const pause = this.boardPauseState();
    const frame = JSON.stringify(pause);
    if (!force && frame === this.lastPauseFrame) return;
    this.lastPauseFrame = frame;
    this.broadcast({ type: 'board.pause', pause });
  }

  // ── 設定 ─────────────────────────────────────────────
  /** 危險指令規則不能等 daemon 重連才生效：重送 welcome。 */
  onSettingsChanged(prev: Settings, next: Settings): void {
    const changed =
      prev.stuckMinutes !== next.stuckMinutes ||
      prev.dispatch !== next.dispatch ||
      JSON.stringify(prev.dangerRules) !== JSON.stringify(next.dangerRules);
    if (changed) {
      for (const conn of this.daemons.values()) {
        if (conn.helloed) this.send(conn.ws, this.welcomeFor(conn.machineId));
      }
    }
    this.drainQueue();
    // 名額上限或限流設定改了：會放出的 QUE 數可能變了。
    this.pauseCountsChanged();
    // 改成不合併：手上這批馬上送，不丟。
    if (prev.notifications.coalesce && !next.notifications.coalesce) this.coalescer.flushNow();
    if (prev.notifications.waitingLimit !== next.notifications.waitingLimit) {
      this.broadcast({ type: 'board.waitingLimit', waitingLimit: next.notifications.waitingLimit });
      this.checkWaiting(true);
    }
    this.guarded('auto continue', () =>
      this.autoContinue.onSettingsChanged(prev.autoContinue, next.autoContinue),
    );
  }

  private saveAutoContinue(sessionId: string, autoContinue: AutoContinue | null): void {
    const current = this.store.getSession(sessionId);
    if (current) this.updateFields(current, { autoContinue });
  }

  // ── 推播 ─────────────────────────────────────────────
  /** 推播開著、不在勿擾時段。 */
  private pushAllowed(settings: Settings): boolean {
    return (
      settings.notifications.enabled &&
      !inQuietHours(settings.notifications.quietHours, this.deps.now())
    );
  }

  /**
   * 狀態需要人（等你回覆等）時推播；`extra` 是同一條路的其他原因，例如雙向交接到了輪數上限。
   * 合併通知開著時只記下來，等一小段時間後送一則總表（flushSummary）；關著就照舊每個事件一則。
   */
  private notifyAttention(session: Session, extra?: AttentionReason): void {
    // 封存的不推播（§9.1）：停止中的 session 可能還會回報一次狀態。
    if (session.archived) return;
    const settings = this.store.getSettings();
    if (!this.pushAllowed(settings)) return;
    if (settings.notifications.coalesce) {
      this.coalescer.add(session.id, session.status === 'waiting_permission' && !extra);
      return;
    }
    this.sendPush(attentionPayload(session, extra));
  }

  /** 自動接續送出了：合併通知裡寫「BD1 已自動接續」；不合併時單獨一則。 */
  private notifyAutoContinued(session: Session): void {
    if (session.archived) return;
    const settings = this.store.getSettings();
    if (!this.pushAllowed(settings)) return;
    if (settings.notifications.coalesce) {
      this.autoContinued = [
        ...this.autoContinued.filter((a) => a.sessionId !== session.id),
        { sessionId: session.id, name: session.name },
      ];
      this.coalescer.add(session.id, false);
      return;
    }
    this.sendPush(attentionPayload(session, { reason: 'auto_continued' }));
  }

  /**
   * 「等你」的數量跨過上限時通知一次（protocol WaitingThreshold）。`notify` 為 false（機器重連帶回原本的狀態）
   * 時只更新計數、不推播。合併通知開著時併進下一則總表（標題改成超過上限）。
   */
  private checkWaiting(notify: boolean): void {
    const settings = this.store.getSettings();
    const limit = settings.notifications.waitingLimit;
    const count = waitingSessions(this.store.listSessions(false), this.approvalList()).length;
    const crossed = this.waiting.update(count, limit);
    if (!crossed || !notify || !this.pushAllowed(settings)) return;
    if (settings.notifications.coalesce) {
      this.overloadPending = limit;
      this.coalescer.add(null, false);
      return;
    }
    this.sendPush(JSON.stringify({ kind: 'overload', count, limit, at: this.nowIso() }));
  }

  /** 合併通知的時間到了：列出現在所有在等你的（等待期間已處理掉的不列），什麼都不剩就不送。 */
  private flushSummary(triggered: string[]): void {
    const autoContinued = this.autoContinued;
    const overLimit = this.overloadPending;
    this.autoContinued = [];
    this.overloadPending = null;
    const settings = this.store.getSettings();
    if (!this.pushAllowed(settings)) return;
    const items = this.summaryItems();
    const stillOver = overLimit !== null && items.length > settings.notifications.waitingLimit;
    const payload = buildSummary(
      items,
      triggered,
      autoContinued,
      this.nowIso(),
      stillOver ? overLimit : undefined,
    );
    if (payload) this.sendPush(JSON.stringify(payload));
  }

  /** 現在在等你的：收件匣的範圍（protocol waitingSessions），加上自動流程停下等你決定、還沒處理的。 */
  private summaryItems(): SummaryItem[] {
    const approvals = this.approvalList();
    const sessions = this.store.listSessions(false);
    const waiting = new Set(waitingSessions(sessions, approvals).map((s) => s.id));
    const items: SummaryItem[] = [];
    for (const session of sessions) {
      const taskLimit = this.taskLimits.get(session.id);
      const task = taskLimit ? this.store.getTask(taskLimit.taskId) : null;
      if (taskLimit && !task?.needsUser) this.taskLimits.delete(session.id);
      const roundLimit = this.roundLimits.get(session.id);
      const flagged = Boolean(task?.needsUser) || roundLimit !== undefined;
      if (!waiting.has(session.id) && !(flagged && session.endedAt === null)) continue;
      const approval = approvals.find((a) => a.sessionId === session.id);
      const status: SessionStatus =
        approval && !needsAttention(session.status)
          ? APPROVAL_STATUS[approval.kind]
          : session.status;
      const item: SummaryItem = { sessionId: session.id, name: session.name, status };
      if (task?.needsUser && taskLimit) {
        item.reason = 'task_reject_limit';
        item.maxRounds = taskLimit.limit;
        item.task = taskLimit.number;
      } else if (roundLimit !== undefined) {
        item.reason = 'handoff_round_limit';
        item.maxRounds = roundLimit;
      }
      items.push(item);
    }
    return items;
  }

  private sendPush(payload: string): void {
    const settings = this.store.getSettings();
    const subject = settings.publicOrigin?.startsWith('https:')
      ? settings.publicOrigin
      : 'mailto:agent-board@localhost';
    for (const subscription of this.store.listPushSubscriptions()) {
      const job = this.deliverPush(subscription, payload, subject).catch((error: unknown) => {
        this.log.warn({ err: error }, 'push delivery failed');
      });
      this.pushes.add(job);
      void job.finally(() => this.pushes.delete(job));
    }
  }

  /** 暫時性失敗重試一次；訂閱失效（404／410）就刪掉。endpoint 不寫 log：它本身就是憑證。 */
  private async deliverPush(
    subscription: Parameters<PushTransport['send']>[0],
    payload: string,
    subject: string,
  ): Promise<void> {
    const { pushTransport, vapid } = this.deps;
    let result = await pushTransport.send(subscription, payload, vapid, subject);
    if (result === 'retry' && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, this.timing.pushRetryMs).unref());
      result = await pushTransport.send(subscription, payload, vapid, subject);
    }
    if (result === 'gone' && !this.closed) this.store.deletePushEndpoint(subscription.endpoint);
    if (result === 'retry' || result === 'failed') {
      this.log.warn({ result }, 'push not delivered');
    }
  }

  /** 等目前排定的推播都送完（關機與測試用）。 */
  async pushesSettled(): Promise<void> {
    await Promise.all(this.pushes);
  }

  // ── 共用 ─────────────────────────────────────────────
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void {
    this.store.insertAudit({
      id: randomUUID(),
      userId,
      sessionId,
      action,
      detail: redactSecrets(detail),
      at: this.nowIso(),
    });
  }

  private daemonFor(machineId: string): DaemonConn | null {
    const conn = this.daemons.get(machineId);
    return conn?.helloed ? conn : null;
  }

  private toSessionDaemon(sessionId: string, msg: HubToDaemon): void {
    const machineId = this.store.sessionMachineId(sessionId);
    const conn = machineId ? this.daemonFor(machineId) : null;
    if (conn) this.send(conn.ws, msg);
  }

  private send(ws: WebSocket, msg: HubToDaemon | HubToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendClientError(client: ClientConn, code: string, message: string): void {
    this.send(client.ws, { type: 'error', code, message });
  }

  private broadcast(msg: HubToClient): void {
    this.fanOut(this.clients, JSON.stringify(msg));
  }

  private broadcastToWatchers(msg: HubToClient): void {
    const watchers = [...this.clients].filter((client) => client.watching);
    this.fanOut(watchers, JSON.stringify(msg));
  }

  private fanOut(clients: Iterable<ClientConn>, frame: string): void {
    for (const client of clients) {
      if (client.ws.readyState !== client.ws.OPEN) continue;
      if (client.ws.bufferedAmount > this.timing.hardClientBufferBytes) {
        client.ws.terminate();
        continue;
      }
      client.ws.send(frame);
    }
  }

  private tick(): void {
    const now = this.nowIso();
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      if (!this.store.authSessionUser(client.tokenHash, now)) {
        client.ws.close(CLOSE_REVOKED, 'session expired');
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
    for (const conn of this.daemons.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
      if (conn.helloed) this.store.touchMachine(conn.machineId, now);
    }
    this.store.pruneExpired(now);
    this.delivery.flush();
    // 時鐘可能跳過（睡眠、改時間）：心跳時也看一次排定的自動接續到了沒。
    this.autoContinue.tick();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // 先把未完成的行寫進 audit，連線關閉的事件不一定來得及在資料庫關閉前觸發。
    for (const client of this.clients) {
      for (const [sessionId, buffer] of client.inputs) {
        const partial = buffer.flush();
        if (partial !== null) {
          this.audit(client.userId, sessionId, 'terminal.input.partial', partial);
        }
      }
    }
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.relay.close();
    this.coalescer.close();
    this.autoContinue.close();
    this.delivery.close();
    for (const pending of this.pendingCreates.values()) clearTimeout(pending.timer);
    this.pendingCreates.clear();
    for (const lock of this.deleting.values()) clearTimeout(lock.timer);
    this.deleting.clear();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(503, 'shutting_down', 'Hub is shutting down'));
    }
    this.pendingRequests.clear();
    await this.pushesSettled();
    for (const conn of this.daemons.values()) {
      this.retireDaemon(conn);
      conn.ws.terminate();
    }
    this.daemons.clear();
    for (const client of this.clients) client.ws.terminate();
    this.clients.clear();
  }
}
