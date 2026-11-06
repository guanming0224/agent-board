// 安全送字（交接規則與任務自動執行共用）：只在目標等輸入時送，文字和 Enter 分開，送 Enter 前再確認一次。
// 佇列只在記憶體，hub 重啟會遺失；兩邊各自決定重啟後怎麼交代（交接留 audit，任務標成沒送出）。
import type { Session } from '@agent-board/protocol';
import type { Store } from './store';

/** 送出後目標一直沒離開 waiting_input（輸入被吃掉）就不再等它，下一筆才有機會送。 */
const ACK_TIMEOUT_MS = 60 * 1000;

export type DropReason = 'target_ended' | string;

export interface DeliveryItem {
  /** 同一個 key 還沒送出又排進來，新的蓋舊的（位置不變）。 */
  key: string;
  targetId: string;
  message: string;
  /** 送之前再問一次：排隊期間情況可能變了（規則關掉、開關關掉、任務移走）。回傳不送的原因。 */
  check(): DropReason | null;
  /** 不送了（目標結束或 check 不過）。 */
  dropped(reason: DropReason): void;
  /** 文字打進去之後、按 Enter 之前目標不再等輸入：Enter 不按，輸入框裡的字留給使用者處理。 */
  aborted(): void;
  /** Enter 已送出。 */
  delivered(): void;
}

export interface DeliveryDeps {
  store: Pick<Store, 'getSession'>;
  now(): Date;
  enterDelayMs: number;
  audit(sessionId: string, action: string, detail: string): void;
  isReachable(sessionId: string): boolean;
  sendInput(sessionId: string, data: string): void;
  guarded(label: string, fn: () => void): void;
}

export const isGone = (session: Session): boolean =>
  session.endedAt !== null || session.status === 'done' || session.archived;

export class SafeDelivery {
  private readonly pending = new Map<string, DeliveryItem>();
  private readonly awaitingAck = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: DeliveryDeps) {}

  enqueue(item: DeliveryItem): void {
    this.pending.set(item.key, item);
    this.deliverNext(item.targetId);
  }

  /** 還沒送出的就拿掉，不呼叫 dropped（呼叫的人自己交代）。回傳有沒有拿掉。 */
  cancel(key: string): boolean {
    return this.pending.delete(key);
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** 由 hub 在 session 每次變動時呼叫。 */
  onSessionChange(prev: Session, next: Session): void {
    if (prev.status === next.status) return;
    if (prev.status === 'waiting_input') this.awaitingAck.delete(next.id);
    if (next.status === 'waiting_input') this.deliverNext(next.id);
    if (isGone(next)) this.dropPendingTo(next.id);
  }

  /** 心跳時呼叫：機器重連、確認逾時之後，沒有狀態變化也要繼續送。 */
  flush(): void {
    const now = this.deps.now().getTime();
    for (const [sessionId, at] of this.awaitingAck) {
      if (now - at > ACK_TIMEOUT_MS) this.awaitingAck.delete(sessionId);
    }
    const targets = new Set([...this.pending.values()].map((p) => p.targetId));
    for (const target of targets) this.deliverNext(target);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private dropPendingTo(targetId: string): void {
    for (const [key, item] of this.pending) {
      if (item.targetId !== targetId) continue;
      this.pending.delete(key);
      item.dropped('target_ended');
    }
  }

  /**
   * 只在目標等輸入時才送：其他狀態下畫面可能是權限對話框，Enter 會直接選到「允許」。
   * 文字和 Enter 分開送（黏在一起 TUI 會當成貼上），送 Enter 前再確認一次狀態。
   */
  private deliverNext(targetId: string): void {
    const { deps } = this;
    const target = deps.store.getSession(targetId);
    if (!target || isGone(target)) {
      this.dropPendingTo(targetId);
      return;
    }
    if (
      target.status !== 'waiting_input' ||
      this.awaitingAck.has(targetId) ||
      !deps.isReachable(targetId)
    ) {
      return;
    }
    const next = this.takeNext(targetId);
    if (!next) return;
    this.awaitingAck.set(targetId, deps.now().getTime());
    deps.sendInput(targetId, next.message);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      deps.guarded('delivery enter', () => this.pressEnter(targetId, next));
    }, deps.enterDelayMs);
    timer.unref();
    this.timers.add(timer);
  }

  private takeNext(targetId: string): DeliveryItem | null {
    for (const [key, item] of this.pending) {
      if (item.targetId !== targetId) continue;
      this.pending.delete(key);
      const reason = item.check();
      if (reason === null) return item;
      item.dropped(reason);
    }
    return null;
  }

  private pressEnter(targetId: string, item: DeliveryItem): void {
    const { store, audit, isReachable, sendInput } = this.deps;
    const current = store.getSession(targetId);
    if (current?.status !== 'waiting_input' || !isReachable(targetId)) {
      this.awaitingAck.delete(targetId);
      item.aborted();
      return;
    }
    sendInput(targetId, '\r');
    audit(targetId, 'terminal.input', item.message);
    item.delivered();
  }
}
