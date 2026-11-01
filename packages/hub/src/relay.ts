// 終端機轉送（CONTRACTS §6.1）：只轉送，不保存任何終端機內容。
// 每個 client 各自判斷緩衝量，慢的那個被丟資料、之後補新快照，其他人不受影響。
import { WebSocket } from 'ws';

export interface RelayClient {
  ws: Pick<WebSocket, 'send' | 'bufferedAmount' | 'readyState' | 'terminate'>;
}

type SubState =
  /** 訂閱了但還沒拿到快照：快照之前的 output 對它沒有意義，直接丟。 */
  | { kind: 'awaiting_snapshot' }
  | { kind: 'live' }
  /** 緩衝爆了：不再送 output，等緩衝消化後再要一份快照。 */
  | { kind: 'overflowed'; since: number };

export interface RelayOptions {
  /** 向 daemon 送 terminal.subscribe／unsubscribe；daemon 離線時什麼都不做，重連後由 resubscribe 補。 */
  subscribeUpstream(sessionId: string): void;
  unsubscribeUpstream(sessionId: string): void;
  maxBufferBytes: number;
  drainPollMs: number;
  drainTimeoutMs: number;
  now(): number;
}

export class TerminalRelay<C extends RelayClient> {
  private readonly sessions = new Map<string, Map<C, SubState>>();
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RelayOptions) {}

  /**
   * 第一個訂閱者讓 daemon 開始送串流。之後的訂閱者（含跳號後重訂）也要一份快照，
   * 而 hub 不存終端機內容，只能再問 daemon 一次：daemon 把 subscribe 當成「給我新快照」，是冪等的。
   */
  subscribe(client: C, sessionId: string): void {
    let subs = this.sessions.get(sessionId);
    if (!subs) {
      subs = new Map();
      this.sessions.set(sessionId, subs);
    }
    subs.set(client, { kind: 'awaiting_snapshot' });
    this.options.subscribeUpstream(sessionId);
  }

  unsubscribe(client: C, sessionId: string): void {
    const subs = this.sessions.get(sessionId);
    if (!subs?.delete(client)) return;
    if (subs.size === 0) {
      this.sessions.delete(sessionId);
      this.options.unsubscribeUpstream(sessionId);
    }
  }

  removeClient(client: C): void {
    for (const sessionId of [...this.sessions.keys()]) this.unsubscribe(client, sessionId);
  }

  /** session 已不存在（機器被移除）：直接清掉，不用通知 daemon。 */
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  subscribedSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /** daemon 重連：之前的串流已斷，全部人都要等新快照。 */
  resubscribe(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      const subs = this.sessions.get(sessionId);
      if (!subs) continue;
      for (const [client, state] of subs) {
        if (state.kind === 'live') subs.set(client, { kind: 'awaiting_snapshot' });
      }
      this.options.subscribeUpstream(sessionId);
    }
  }

  onOutput(sessionId: string, frame: string): void {
    const subs = this.sessions.get(sessionId);
    if (!subs) return;
    for (const [client, state] of subs) {
      if (state.kind !== 'live' || !isOpen(client)) continue;
      if (client.ws.bufferedAmount > this.options.maxBufferBytes) {
        this.markOverflowed(subs, client);
        continue;
      }
      client.ws.send(frame);
    }
  }

  /** 快照只給在等的人；已經在看串流的人不需要重畫。 */
  onSnapshot(sessionId: string, frame: string): void {
    const subs = this.sessions.get(sessionId);
    if (!subs) return;
    for (const [client, state] of subs) {
      if (state.kind !== 'awaiting_snapshot' || !isOpen(client)) continue;
      if (client.ws.bufferedAmount > this.options.maxBufferBytes) {
        this.markOverflowed(subs, client);
        continue;
      }
      client.ws.send(frame);
      subs.set(client, { kind: 'live' });
    }
  }

  close(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.sessions.clear();
  }

  private markOverflowed(subs: Map<C, SubState>, client: C): void {
    subs.set(client, { kind: 'overflowed', since: this.options.now() });
    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => this.checkDrained(), this.options.drainPollMs);
      this.drainTimer.unref();
    }
  }

  private checkDrained(): void {
    const lowWater = this.options.maxBufferBytes / 4;
    let waiting = false;
    for (const [sessionId, subs] of this.sessions) {
      let needSnapshot = false;
      for (const [client, state] of subs) {
        if (state.kind !== 'overflowed') continue;
        if (client.ws.bufferedAmount <= lowWater) {
          subs.set(client, { kind: 'awaiting_snapshot' });
          needSnapshot = true;
        } else if (this.options.now() - state.since > this.options.drainTimeoutMs) {
          // 一直消化不完就是連線死了。切斷後它的 close 事件會把訂閱清掉。
          client.ws.terminate();
        } else {
          waiting = true;
        }
      }
      if (needSnapshot) this.options.subscribeUpstream(sessionId);
    }
    if (!waiting && this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

const isOpen = (client: RelayClient): boolean => client.ws.readyState === WebSocket.OPEN;
