// 終端機轉送（CONTRACTS §6.1）：只轉送，不保存任何終端機內容。
// 每個 client 各自判斷緩衝量，慢的那個被丟資料、之後補新快照，其他人不受影響。
// 尺寸擁有權也在這裡：同一個 session 只有一個 client 的 resize 會套用到 PTY（§6.1 第 6 點）。
import type { HubToClient } from '@agent-board/protocol';
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

type SizeOwner = Extract<HubToClient, { type: 'terminal.size' }>['owner'];

interface SizeState<C> {
  /** 擁有尺寸的 client；null 表示還沒人擁有，下一個送 resize 的訂閱者就是。 */
  owner: C | null;
  /** PTY 目前的尺寸（最後一次轉給 daemon 的 resize，或沒有擁有者時快照帶來的尺寸）。 */
  cols: number | null;
  rows: number | null;
  /** 每個訂閱者最後一次訂閱或搶尺寸的順序；擁有者離開時交給最近的一個。 */
  active: Map<C, number>;
}

export class TerminalRelay<C extends RelayClient> {
  private readonly sessions = new Map<string, Map<C, SubState>>();
  private readonly sizes = new Map<string, SizeState<C>>();
  private tick = 0;
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
    this.sizeState(sessionId).active.set(client, ++this.tick);
    this.options.subscribeUpstream(sessionId);
  }

  unsubscribe(client: C, sessionId: string): void {
    const subs = this.sessions.get(sessionId);
    if (!subs?.delete(client)) return;
    if (subs.size === 0) {
      this.sessions.delete(sessionId);
      this.sizes.delete(sessionId);
      this.options.unsubscribeUpstream(sessionId);
      return;
    }
    const size = this.sizes.get(sessionId);
    if (!size) return;
    size.active.delete(client);
    if (size.owner !== client) return;
    // 擁有者離開：交給最近操作過的人，它收到 owner: 'you' 後會照自己的畫面送 resize。
    let next: C | null = null;
    let latest = -1;
    for (const [candidate, at] of size.active) {
      if (subs.has(candidate) && at > latest) {
        next = candidate;
        latest = at;
      }
    }
    size.owner = next;
    this.announceSize(sessionId);
  }

  /**
   * 決定一個 resize 要不要轉給 daemon。擁有者、還沒人擁有、或 claim（使用者剛在這個終端機打字或點擊）時接受，
   * 並把新尺寸告訴其他訂閱者；不接受時回 null，並告訴送的人目前的尺寸，讓它改成照遠端尺寸顯示。
   * 沒訂閱就送 resize 的 client（舊版、腳本）不能擁有尺寸，只在還沒人擁有時照舊轉送。
   */
  resize(
    client: C,
    sessionId: string,
    cols: number,
    rows: number,
    claim: boolean,
  ): { cols: number; rows: number } | null {
    const subscribed = this.sessions.get(sessionId)?.has(client) ?? false;
    const size = this.sizes.get(sessionId);
    if (!subscribed || !size) {
      return size?.owner ? null : { cols, rows };
    }
    if (!claim && size.owner !== null && size.owner !== client) {
      this.sendSize(client, sessionId, size);
      return null;
    }
    const changed = size.owner !== client || size.cols !== cols || size.rows !== rows;
    size.owner = client;
    size.cols = cols;
    size.rows = rows;
    if (claim) size.active.set(client, ++this.tick);
    if (changed) this.announceSize(sessionId);
    return { cols, rows };
  }

  /** 測試與除錯用：目前的擁有者。 */
  sizeOwner(sessionId: string): C | null {
    return this.sizes.get(sessionId)?.owner ?? null;
  }

  removeClient(client: C): void {
    for (const sessionId of [...this.sessions.keys()]) this.unsubscribe(client, sessionId);
  }

  /** session 已不存在（機器被移除）：直接清掉，不用通知 daemon。 */
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sizes.delete(sessionId);
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

  /**
   * 快照只給在等的人；已經在看串流的人不需要重畫。快照之後緊接著送尺寸與擁有者。
   * 快照的尺寸是 PTY 的實際尺寸，但有擁有者時以它最後送的為準（快照可能比那個 resize 早產生）。
   */
  onSnapshot(
    sessionId: string,
    frame: string,
    snapshotSize?: { cols: number; rows: number },
  ): void {
    const subs = this.sessions.get(sessionId);
    if (!subs) return;
    const size = this.sizes.get(sessionId);
    if (size && snapshotSize && (size.owner === null || size.cols === null)) {
      size.cols = snapshotSize.cols;
      size.rows = snapshotSize.rows;
    }
    for (const [client, state] of subs) {
      if (state.kind !== 'awaiting_snapshot' || !isOpen(client)) continue;
      if (client.ws.bufferedAmount > this.options.maxBufferBytes) {
        this.markOverflowed(subs, client);
        continue;
      }
      client.ws.send(frame);
      subs.set(client, { kind: 'live' });
      if (size) this.sendSize(client, sessionId, size);
    }
  }

  close(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.sessions.clear();
    this.sizes.clear();
  }

  private sizeState(sessionId: string): SizeState<C> {
    let size = this.sizes.get(sessionId);
    if (!size) {
      size = { owner: null, cols: null, rows: null, active: new Map() };
      this.sizes.set(sessionId, size);
    }
    return size;
  }

  /** 尺寸或擁有者變了：告訴已經在看串流的每個人（還在等快照的，快照之後會收到）。 */
  private announceSize(sessionId: string): void {
    const subs = this.sessions.get(sessionId);
    const size = this.sizes.get(sessionId);
    if (!subs || !size) return;
    for (const [client, state] of subs) {
      if (state.kind === 'live') this.sendSize(client, sessionId, size);
    }
  }

  private sendSize(client: C, sessionId: string, size: SizeState<C>): void {
    if (size.cols === null || size.rows === null || !isOpen(client)) return;
    const owner: SizeOwner = size.owner === null ? 'none' : size.owner === client ? 'you' : 'other';
    const message: HubToClient = {
      type: 'terminal.size',
      sessionId,
      cols: size.cols,
      rows: size.rows,
      owner,
    };
    client.ws.send(JSON.stringify(message));
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
