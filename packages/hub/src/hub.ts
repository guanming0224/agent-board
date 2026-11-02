// hub 的執行期核心：daemon 與瀏覽器連線、session 生命週期、併發排隊、approval 快取、推播。
// 資料歸屬見 CONTRACTS §2：終端機內容只經過這裡，不落地；approval 只快取，daemon 才是擁有者。
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  ClientToHub,
  DaemonToHub,
  needsAttention,
  type Approval,
  type DirEntry,
  type HubToClient,
  type HubToDaemon,
  type Machine,
  type Session,
  type SessionRuntime,
  type SessionSpec,
  type SessionStatus,
  type Settings,
  type UsageSummary,
  type User,
} from '@agent-board/protocol';
import type { z } from 'zod';
import { InputLineBuffer } from './audit';
import { conflict, HttpError, notFound } from './errors';
import { HandoffEngine } from './handoff';
import { attentionPayload, inQuietHours, type PushTransport, type VapidKeys } from './push';
import { TerminalRelay, type RelayClient } from './relay';
import type { Store } from './store';

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
  /** 送進 TUI 的文字和 Enter 之間的間隔，太短會被當成貼上。 */
  handoffEnterDelayMs: number;
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
  handoffEnterDelayMs: 100,
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

interface PendingBrowse {
  machineId: string;
  timer: NodeJS.Timeout;
  resolve(value: { path: string; entries: z.infer<typeof DirEntry>[] }): void;
  reject(error: Error): void;
}

const SESSION_DETAIL_LOST = 'ended while the machine was disconnected; outcome unknown';
const SESSION_DETAIL_CREATE_TIMEOUT = 'daemon did not confirm session start in time';
const SESSION_DETAIL_CANCELLED = 'cancelled while queued';

/** 由 hub 設定的狀態（CONTRACTS §5）。例外只有一個：PTY exit 0 由 daemon 回報 done + endedAt。 */
const HUB_ONLY_STATUSES: readonly SessionStatus[] = ['queued', 'done', 'offline'];

const holdsSlot = (s: Session): boolean =>
  s.endedAt === null && s.status !== 'queued' && s.status !== 'done';

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
  private readonly pendingBrowses = new Map<string, PendingBrowse>();
  private readonly usage = new Map<string, UsageSummary>();
  private readonly pushes = new Set<Promise<void>>();
  private readonly relay: TerminalRelay<ClientConn>;
  private readonly handoff: HandoffEngine;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: HubDeps) {
    this.store = deps.store;
    this.log = deps.log;
    this.timing = deps.timing;
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
    this.handoff = new HandoffEngine({
      store: deps.store,
      now: deps.now,
      enterDelayMs: deps.timing.handoffEnterDelayMs,
      audit: (sessionId, action, detail) => this.audit(null, sessionId, action, detail),
      addEvent: (sessionId, type, payload, at) => this.addEvent(sessionId, type, payload, at),
      isReachable: (sessionId) => {
        const machineId = this.store.sessionMachineId(sessionId);
        return machineId !== null && this.daemonFor(machineId) !== null;
      },
      sendInput: (sessionId, data) =>
        this.toSessionDaemon(sessionId, { type: 'terminal.input', sessionId, data }),
      guarded: (label, fn) => this.guarded(label, fn),
    });
    // 上次關機時的連線都不在了：機器與 session 先視為離線，等 daemon 回來對帳。
    for (const machine of this.store.listMachines()) this.markMachineOffline(machine.id);
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
      case 'session.event':
        if (this.ownsSession(conn, msg.event.sessionId) && this.store.insertEvent(msg.event)) {
          this.broadcast({ type: 'session.event', event: msg.event });
          this.guarded('handoff', () => this.handoff.onEvent(msg.event));
        }
        return;
      case 'terminal.output':
        if (this.ownsSession(conn, msg.sessionId)) {
          this.relay.onOutput(msg.sessionId, JSON.stringify(msg));
        }
        return;
      case 'terminal.snapshot':
        if (this.ownsSession(conn, msg.sessionId)) {
          this.relay.onSnapshot(msg.sessionId, JSON.stringify(msg));
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
        this.onFsListResult(conn, msg);
        return;
    }
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
    this.store.machineHello(conn.machineId, msg.os, msg.capabilities, this.nowIso());
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
    };
  }

  private onDaemonClose(conn: DaemonConn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    if (conn.retired || this.daemons.get(conn.machineId) !== conn) return;
    this.daemons.delete(conn.machineId);
    if (this.closed) return;
    this.markMachineOffline(conn.machineId);
  }

  private markMachineOffline(machineId: string): void {
    this.store.setMachineOffline(machineId, this.nowIso());
    for (const [requestId, pending] of this.pendingCreates) {
      if (pending.machineId !== machineId) continue;
      clearTimeout(pending.timer);
      this.pendingCreates.delete(requestId);
    }
    this.rejectBrowses(machineId, new HttpError(502, 'daemon_disconnected', 'Daemon disconnected'));
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
      approvals: [...this.approvals.values()].map((a) => a.approval),
    };
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
        if (/[\r\n]/.test(msg.data)) this.handoff.onUserInput(msg.sessionId);
        this.toSessionDaemon(msg.sessionId, msg);
        return;
      case 'terminal.resize':
        this.toSessionDaemon(msg.sessionId, msg);
        return;
      case 'terminal.signal':
        client.inputs.get(msg.sessionId)?.clear();
        if (msg.signal === 'terminate') this.handoff.onUserStop(msg.sessionId);
        this.audit(client.userId, msg.sessionId, 'terminal.signal', msg.signal);
        this.toSessionDaemon(msg.sessionId, msg);
        return;
    }
  }

  private auditInput(client: ClientConn, sessionId: string, data: string): void {
    let buffer = client.inputs.get(sessionId);
    if (!buffer) {
      buffer = new InputLineBuffer();
      client.inputs.set(sessionId, buffer);
    }
    for (const line of buffer.push(data)) {
      this.audit(client.userId, sessionId, 'terminal.input', line);
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
      if (partial !== null) this.audit(client.userId, sessionId, 'terminal.input.partial', partial);
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
  }

  // ── Session 生命週期 ─────────────────────────────────
  createSession(input: SessionSpec & { machineId: string }, user: User): Session {
    const { machineId, ...spec } = input;
    if (!this.store.getMachine(machineId)) throw notFound('Machine');
    if (!this.daemonFor(machineId)) throw conflict('machine_offline', 'Machine is offline');
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
      status: this.slotAvailable() ? 'starting' : 'queued',
      statusDetail: null,
      claudeSessionId: spec.resumeClaudeSessionId,
      lastLines: [],
      lastOutputAt: null,
      statusSince: now,
      contextTokens: null,
      createdAt: now,
      endedAt: null,
      archived: false,
    };
    this.store.db.transaction(() => {
      this.store.insertSession(session, spec);
      this.audit(
        user.id,
        session.id,
        'session.create',
        JSON.stringify({
          name: spec.name,
          machineId,
          cwd: spec.cwd,
          permissionMode: spec.permissionMode,
          model: spec.model,
          useWorktree: spec.useWorktree,
        }),
      );
      // firstPrompt 也是送入終端機的輸入。
      if (spec.firstPrompt !== null) {
        this.audit(user.id, session.id, 'terminal.input', spec.firstPrompt);
      }
    })();
    this.broadcast({ type: 'session.updated', session });
    if (session.status === 'starting') this.dispatchCreate(session, spec);
    return session;
  }

  private slotAvailable(): boolean {
    const max = this.store.getSettings().quotaGuards.maxConcurrentSessions;
    return max === null || this.store.countActiveSessions() < max;
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

  /** 有名額就依序開始；機器離線的先跳過，不擋後面的人。 */
  private drainQueue(): void {
    if (this.closed) return;
    for (const { session, spec } of this.store.queuedSessions()) {
      if (!this.slotAvailable()) return;
      if (!this.daemonFor(session.machineId)) continue;
      const started = this.setStatus(session, 'starting', null, 'dequeued');
      this.dispatchCreate(started, spec);
    }
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
    const session = this.requireSession(id);
    if (session.endedAt === null) throw conflict('session_active', 'Session is still active');
    if (!session.claudeSessionId) {
      throw conflict('no_claude_session', 'Session has no Claude conversation to resume');
    }
    if (!this.daemonFor(session.machineId)) throw conflict('machine_offline', 'Machine is offline');
    const spec: SessionSpec = {
      name: session.name,
      projectId: session.projectId,
      cwd: session.worktreePath ?? session.cwd,
      useWorktree: false,
      permissionMode: session.permissionMode,
      model: session.model,
      accountProfile: session.accountProfile,
      resumeClaudeSessionId: session.claudeSessionId,
      firstPrompt: null,
    };
    this.audit(user.id, id, 'session.resume', '');
    this.store.setPendingSpec(id, spec);
    const available = this.slotAvailable();
    const next = this.setStatus(session, available ? 'starting' : 'queued', null, 'user_resumed', {
      endedAt: null,
    });
    if (available) this.dispatchCreate(next, spec);
    return next;
  }

  updateSession(
    id: string,
    patch: { name?: string; projectId?: string | null; archived?: boolean; markDone?: true },
    user: User,
  ): Session {
    let session = this.requireSession(id);
    const { markDone, ...fields } = patch;
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(defined).length > 0) session = this.updateFields(session, defined);
    if (markDone && session.status !== 'done') {
      this.audit(user.id, id, 'session.mark_done', '');
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

  private requireSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) throw notFound('Session');
    return session;
  }

  /** daemon 回報的欄位覆蓋 hub 的（§2）；archived、projectId、name 與 hub 專屬狀態不動。 */
  private applyRuntime(runtime: SessionRuntime): void {
    const prev = this.store.getSession(runtime.id);
    if (!prev || prev.status === 'queued') return;
    const wasOffline = prev.status === 'offline';
    const preOffline = wasOffline ? this.store.preOfflineStatus(runtime.id) : null;
    const exitedCleanly = runtime.status === 'done' && runtime.endedAt !== null;
    const keepStatus =
      prev.status === 'done' || (HUB_ONLY_STATUSES.includes(runtime.status) && !exitedCleanly);
    const next: Session = {
      ...prev,
      cwd: runtime.cwd,
      branch: runtime.branch,
      worktreePath: runtime.worktreePath,
      claudeSessionId: runtime.claudeSessionId,
      lastLines: runtime.lastLines,
      lastOutputAt: runtime.lastOutputAt,
      contextTokens: runtime.contextTokens,
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
      this.addEvent(session.id, 'status', { from: session.status, to: status, reason });
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
    // 「結果不明」當時沒推播；daemon 補送真正的結果時才算第一次得知，所以就算同樣是 error 也要發。
    const outcomeLearned =
      prev.statusDetail === SESSION_DETAIL_LOST && next.statusDetail !== SESSION_DETAIL_LOST;
    const entered = prev.status !== next.status || outcomeLearned;
    if (mayNotify && entered && needsAttention(next.status)) {
      this.notifyAttention(next);
    }
    this.guarded('handoff', () => this.handoff.onSessionChange(prev, next, mayNotify && entered));
    if (holdsSlot(prev) && !holdsSlot(next)) this.drainQueue();
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
    this.rejectBrowses(id, new HttpError(502, 'daemon_disconnected', 'Machine removed'));
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

  browse(
    machineId: string,
    path: string,
  ): Promise<{ path: string; entries: z.infer<typeof DirEntry>[] }> {
    if (!this.store.getMachine(machineId)) throw notFound('Machine');
    const conn = this.daemonFor(machineId);
    if (!conn) throw conflict('machine_offline', 'Machine is offline');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBrowses.delete(requestId);
        reject(new HttpError(504, 'daemon_timeout', 'Daemon did not respond in time'));
      }, this.timing.browseTimeoutMs);
      timer.unref();
      this.pendingBrowses.set(requestId, { machineId, timer, resolve, reject });
      this.send(conn.ws, { type: 'fs.list', requestId, path });
    });
  }

  private onFsListResult(
    conn: DaemonConn,
    msg: Extract<DaemonToHub, { type: 'fs.listResult' }>,
  ): void {
    const pending = this.pendingBrowses.get(msg.requestId);
    if (!pending || pending.machineId !== conn.machineId) return;
    clearTimeout(pending.timer);
    this.pendingBrowses.delete(msg.requestId);
    if (msg.error !== null) pending.reject(new HttpError(400, 'fs_error', msg.error));
    else pending.resolve({ path: msg.path, entries: msg.entries });
  }

  private rejectBrowses(machineId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingBrowses) {
      if (pending.machineId !== machineId) continue;
      clearTimeout(pending.timer);
      this.pendingBrowses.delete(requestId);
      pending.reject(error);
    }
  }

  // ── 設定 ─────────────────────────────────────────────
  /** 危險指令規則不能等 daemon 重連才生效：重送 welcome。 */
  onSettingsChanged(prev: Settings, next: Settings): void {
    const changed =
      prev.stuckMinutes !== next.stuckMinutes ||
      JSON.stringify(prev.dangerRules) !== JSON.stringify(next.dangerRules);
    if (changed) {
      for (const conn of this.daemons.values()) {
        if (conn.helloed) this.send(conn.ws, this.welcomeFor(conn.machineId));
      }
    }
    this.drainQueue();
  }

  // ── 推播 ─────────────────────────────────────────────
  private notifyAttention(session: Session): void {
    const settings = this.store.getSettings();
    if (!settings.notifications.enabled) return;
    if (inQuietHours(settings.notifications.quietHours, this.deps.now())) return;
    const subject = settings.publicOrigin?.startsWith('https:')
      ? settings.publicOrigin
      : 'mailto:agent-board@localhost';
    const payload = attentionPayload(session);
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
      detail,
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
    this.handoff.flush();
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
    this.relay.close();
    this.handoff.close();
    for (const pending of this.pendingCreates.values()) clearTimeout(pending.timer);
    this.pendingCreates.clear();
    for (const pending of this.pendingBrowses.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(503, 'shutting_down', 'Hub is shutting down'));
    }
    this.pendingBrowses.clear();
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
