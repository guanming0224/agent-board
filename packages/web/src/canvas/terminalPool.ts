// 畫布卡的 xterm 名額：只替「畫面內＋最近看過」的卡建終端機（GM 2026-11-14，分頁記憶體 1GB 多）。
// 每個 xterm 在網頁程序約 4MB、用 WebGL 時 GPU 程序再十幾 MB；放大時一次替幾十張卡建 xterm，
// 再縮小又整批卸載，來回幾次就建了幾百個 WebGL context。這裡集中決定哪些卡可以有 xterm：
// - 展開或聚焦中、顯示成終端機的卡（pinned）一定有，不算進名額競爭；
// - 其他：畫面內的優先，其次是剛離開畫面（含縮回摘要條）還在寬限期內的，最多 CANVAS_TERMINAL_LIMIT 個；
// - 離開畫面超過 RELEASE_AFTER_MS 或被擠出名額就釋放；回到畫面再建，內容從 hub 的快照重拿。
// 不碰 DOM，方便單元測試；React 的部分是 useTerminalLease。
import { useLayoutEffect, useSyncExternalStore } from 'react';

/** 畫布上同時最多幾張卡有 xterm（不含展開／聚焦中的卡）。 */
export const CANVAS_TERMINAL_LIMIT = 8;
/** 離開畫面（或縮回摘要條）多久後釋放 xterm。縮放來回、平移經過時不必重建。 */
export const RELEASE_AFTER_MS = 5000;

export interface TerminalDemand {
  /** 顯示成終端機而且在畫面內。 */
  visible: boolean;
  /** 展開或聚焦中、顯示成終端機：一定保留。 */
  pinned: boolean;
}

export interface PoolCard extends TerminalDemand {
  id: string;
  granted: boolean;
  /** 最後一次在畫面內（或 pinned）的時間。 */
  lastSeen: number;
  /** 最近一次被聚焦、展開或點擊的順序，越大越新。 */
  touched: number;
}

/** 決定哪些卡有 xterm。 */
export function allocateTerminals(
  cards: readonly PoolCard[],
  now: number,
  limit: number,
  graceMs: number,
): Set<string> {
  const winners = new Set(cards.filter((c) => c.pinned).map((c) => c.id));
  const rest = cards.filter(
    (c) => !c.pinned && (c.visible || (c.granted && now - c.lastSeen < graceMs)),
  );
  rest.sort(
    (a, b) =>
      // 畫面內 > 寬限期內
      Number(b.visible) - Number(a.visible) ||
      // 已經有的先留著，不來回搶
      Number(b.granted) - Number(a.granted) ||
      // 最近聚焦／點過的
      b.touched - a.touched ||
      // 最近看過的
      b.lastSeen - a.lastSeen ||
      a.id.localeCompare(b.id),
  );
  for (const card of rest.slice(0, Math.max(0, limit - winners.size))) winners.add(card.id);
  return winners;
}

export interface PoolClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 同一輪的多個變化合併成一次分配。 */
  schedule(run: () => void): void;
}

const realClock: PoolClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // 不能直接傳 queueMicrotask：當成物件方法呼叫時 this 不是 window，瀏覽器會丟錯。
  schedule: (run) => queueMicrotask(run),
};

export class TerminalPool {
  private readonly cards = new Map<string, PoolCard>();
  private readonly listeners = new Set<() => void>();
  private touchClock = 0;
  private timer: unknown = null;
  private scheduled = false;

  constructor(
    readonly limit = CANVAS_TERMINAL_LIMIT,
    readonly graceMs = RELEASE_AFTER_MS,
    private readonly clock: PoolClock = realClock,
  ) {}

  set(id: string, demand: TerminalDemand): void {
    const now = this.clock.now();
    const card = this.cards.get(id);
    if (!card) {
      this.cards.set(id, { id, ...demand, granted: false, lastSeen: now, touched: 0 });
    } else {
      if (card.visible === demand.visible && card.pinned === demand.pinned) return;
      // 剛離開畫面：從這一刻起算寬限期。
      if (card.visible || card.pinned || demand.visible || demand.pinned) card.lastSeen = now;
      // 剛被聚焦／展開：最近操作過的優先。
      if (demand.pinned && !card.pinned) card.touched = ++this.touchClock;
      card.visible = demand.visible;
      card.pinned = demand.pinned;
    }
    this.request();
  }

  /** 使用者點了這張卡的終端機。 */
  touch(id: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    card.touched = ++this.touchClock;
    this.request();
  }

  remove(id: string): void {
    if (!this.cards.delete(id)) return;
    this.request();
  }

  granted(id: string): boolean {
    return this.cards.get(id)?.granted ?? false;
  }

  get grantedCount(): number {
    let count = 0;
    for (const card of this.cards.values()) if (card.granted) count += 1;
    return count;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 立刻重新分配（測試用；平常由 schedule 觸發）。 */
  flush(): void {
    this.scheduled = false;
    const now = this.clock.now();
    const cards = [...this.cards.values()];
    const winners = allocateTerminals(cards, now, this.limit, this.graceMs);
    let changed = false;
    let nextExpiry = Infinity;
    for (const card of cards) {
      const granted = winners.has(card.id);
      if (granted !== card.granted) {
        card.granted = granted;
        changed = true;
      }
      if (granted && !card.visible && !card.pinned) {
        nextExpiry = Math.min(nextExpiry, card.lastSeen + this.graceMs);
      }
    }
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (nextExpiry !== Infinity) {
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = null;
          this.flush();
        },
        Math.max(0, nextExpiry - now),
      );
    }
    if (changed) for (const listener of [...this.listeners]) listener();
  }

  private request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.clock.schedule(() => {
      if (this.scheduled) this.flush();
    });
  }
}

/** 畫布共用的那一份。 */
export const canvasTerminals = new TerminalPool();

/** 這張卡現在能不能有 xterm。demand 改變時回報給名額管理。 */
export function useTerminalLease(id: string, demand: TerminalDemand, pool = canvasTerminals) {
  const granted = useSyncExternalStore(pool.subscribe, () => pool.granted(id));
  const { visible, pinned } = demand;
  // 先宣告移除：卸載（或 StrictMode 重跑）時兩個 cleanup 先跑完，再依序 set，卡不會被誤刪。
  useLayoutEffect(() => () => pool.remove(id), [pool, id]);
  useLayoutEffect(() => {
    pool.set(id, { visible, pinned });
  }, [pool, id, visible, pinned]);
  return granted;
}
