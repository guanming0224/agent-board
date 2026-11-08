// 安全送字（交接規則與任務自動執行共用）：只在目標等輸入時送，文字和 Enter 分開，送 Enter 前再確認一次。
// 佇列只在記憶體，hub 重啟會遺失；兩邊各自決定重啟後怎麼交代（交接留 audit，任務標成沒送出）。
// 全部暫停（P2 項目三）：所有 hub 自己送的字都經過這裡，暫停時只收不送（留在佇列），繼續後照常送。
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
  /**
   * 目標現在能不能打字。沒給就是只在 `waiting_input` 才送（交接、任務都是這樣）。
   * 自動接續另外接受「還在同一次限流、daemon 看到平常的輸入框」（CONTRACTS §3.5）。
   */
  ready?(target: Session): boolean;
}

const readyFor = (item: DeliveryItem, target: Session): boolean =>
  item.ready ? item.ready(target) : target.status === 'waiting_input';

export interface DeliveryDeps {
  store: Pick<Store, 'getSession'>;
  now(): Date;
  enterDelayMs: number;
  audit(sessionId: string, action: string, detail: string): void;
  isReachable(sessionId: string): boolean;
  sendInput(sessionId: string, data: string): void;
  guarded(label: string, fn: () => void): void;
  /** 全部暫停中：只收不送。沒給＝永遠不暫停。 */
  paused?(): boolean;
  /** 暫停中被擋下的一則（排進來時、或按暫停時已在佇列裡的），呼叫的人負責記錄。 */
  held?(item: DeliveryItem): void;
  /** 佇列內容變了（排進、取出、拿掉）。 */
  changed?(): void;
}

export const isGone = (session: Session): boolean =>
  session.endedAt !== null || session.status === 'done' || session.archived;

export class SafeDelivery {
  private readonly pending = new Map<string, DeliveryItem>();
  private readonly awaitingAck = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: DeliveryDeps) {}

  enqueue(item: DeliveryItem): void {
    // 同一個 key 蓋掉還沒送的舊的：已經記過被擋，不再記一次（audit 的 board.held 筆數＝排隊則數）。
    const existed = this.pending.has(item.key);
    this.pending.set(item.key, item);
    if (this.isPaused() && !existed) this.deps.held?.(item);
    this.deliverNext(item.targetId);
    this.deps.changed?.();
  }

  /** 還沒送出的就拿掉，不呼叫 dropped（呼叫的人自己交代）。回傳有沒有拿掉。 */
  cancel(key: string): boolean {
    const removed = this.pending.delete(key);
    if (removed) this.deps.changed?.();
    return removed;
  }

  /** 排隊中的 key（暫停時統計各類數量用）。 */
  pendingKeys(): string[] {
    return [...this.pending.keys()];
  }

  /** 剛按下暫停：已在佇列裡的每一則都交給 held 記錄。 */
  noteHeld(): void {
    for (const item of this.pending.values()) this.deps.held?.(item);
  }

  private isPaused(): boolean {
    return this.deps.paused?.() === true;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** 狀態沒變但可能變得能送了（例如派工成員手上的工作剛回報完，CONTRACTS §11）。 */
  retry(targetId: string): void {
    this.deliverNext(targetId);
  }

  /** 由 hub 在 session 每次變動時呼叫。 */
  onSessionChange(prev: Session, next: Session): void {
    if (isGone(next)) {
      if (prev.status !== next.status) this.dropPendingTo(next.id);
      return;
    }
    // 送出後狀態變了（輸入被接受、開始工作）才放下一則。
    if (prev.status !== next.status) this.awaitingAck.delete(next.id);
    // 狀態沒變也可能變得能送（例如限流中的 session 輸入框出現了），有排隊的才看。
    if (prev.status !== next.status || this.hasPendingFor(next.id)) this.deliverNext(next.id);
  }

  private hasPendingFor(targetId: string): boolean {
    for (const item of this.pending.values()) if (item.targetId === targetId) return true;
    return false;
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
    let removed = false;
    for (const [key, item] of this.pending) {
      if (item.targetId !== targetId) continue;
      this.pending.delete(key);
      removed = true;
      item.dropped('target_ended');
    }
    if (removed) this.deps.changed?.();
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
    // 暫停中：留在佇列，不送（目標結束的照樣丟掉，上面已處理）。
    if (this.isPaused()) return;
    if (this.awaitingAck.has(targetId) || !deps.isReachable(targetId)) return;
    const before = this.pending.size;
    const next = this.takeNext(target);
    if (this.pending.size !== before) this.deps.changed?.();
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

  /** 第一則現在能送的；還不能送的留在佇列裡。 */
  private takeNext(target: Session): DeliveryItem | null {
    for (const [key, item] of this.pending) {
      if (item.targetId !== target.id || !readyFor(item, target)) continue;
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
    // 字打進去之後、Enter 之前按了暫停：字已經在輸入框裡，照樣按 Enter 把這一則送完（不按會留下殘字，
    // 這一則也會被當成沒送出丟掉）。暫停只擋還沒打字的（CONTRACTS §12）。
    if (!current || !readyFor(item, current) || !isReachable(targetId)) {
      this.awaitingAck.delete(targetId);
      item.aborted();
      return;
    }
    sendInput(targetId, '\r');
    audit(targetId, 'terminal.input', item.message);
    item.delivered();
  }
}
