// 畫布卡的 xterm 名額：只替「畫面內＋最近看過」的卡建終端機（GM 2026-11-14，分頁記憶體 1GB 多）。
// 每個 xterm 在網頁程序約 4MB、用 WebGL 時 GPU 程序再十幾 MB；放大時一次替幾十張卡建 xterm，
// 再縮小又整批卸載，來回幾次就建了幾百個 WebGL context。這裡集中決定哪些卡可以有 xterm：
// - 畫面內、顯示成終端機的卡一律有（GM 2026-11-16，0.1.13 熱修）：0.1.11–0.1.12 畫面內也有上限 8，
//   超過的卡只放 lastLines 的靜態文字，結果「送出了看不到回覆」「點進去打不了字」。
//   記憶體的主要改善來自畫布一律 DOM renderer（不用 WebGL），不是這個上限。
//   但要在畫面內停留 VISIBLE_DWELL_MS 才建：「全部顯示」的鏡頭動畫經過 80–90% 時一路掃過的卡
//   不必各建一個 xterm（每個都要向 hub 訂閱、拿快照、送 resize），已經有的、剛被點的不用等；
// - 展開或聚焦中、顯示成終端機的卡（pinned）即使離開畫面也保留，但最多 PINNED_LIMIT 張（展開很多張時最舊的讓位）；
// - 剛離開畫面（含縮回摘要條）還在寬限期內的：只用剩下的名額保留（總數不超過 CANVAS_TERMINAL_LIMIT，
//   畫面內的卡已經用掉的不算剩下），剛點過的、已經有的、最近看過的優先；
// - 離開畫面超過 RELEASE_AFTER_MS 或被擠出名額就釋放；回到畫面再建，內容從 hub 的快照重拿。
// 不碰 DOM，方便單元測試；React 的部分是 useTerminalLease。
import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * 畫面外保留 xterm 的上限：畫面內的卡加上寬限期內保留的，超過這個數就不再替畫面外的卡保留。
 * 畫面內的卡不受這個數限制（一律有 xterm）。
 */
export const CANVAS_TERMINAL_LIMIT = 8;
/** 離開畫面（或縮回摘要條）多久後釋放 xterm。縮放來回、平移經過時不必重建。 */
export const RELEASE_AFTER_MS = 5000;
/** 展開／聚焦中的卡最多幾張一定保留；超過的最舊的改成和一般卡一起排。 */
export const PINNED_LIMIT = 4;
/**
 * 進入畫面多久後才建 xterm。鏡頭動畫是 200ms（motion.ts），動畫途中短暫經過畫面的卡不建；
 * 平移或縮放停下後最多慢這麼久出現。
 */
export const VISIBLE_DWELL_MS = 250;
/** 剛被點的卡在這段時間內優先（寬限期內保留時）。 */
export const TOUCH_PRIORITY_MS = 10_000;

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
  /** 這次進入畫面的時間（visible 從 false 變 true 的那一刻）。 */
  visibleSince: number;
  /** 最近一次被聚焦、展開或點擊的順序，越大越新。 */
  touched: number;
  /** 最近一次被點的時間；沒點過是 -Infinity。 */
  touchedAt: number;
}

export interface AllocateOptions {
  limit: number;
  graceMs: number;
  pinnedLimit?: number;
  touchMs?: number;
  /** 進入畫面多久後才給；已經有的、剛被點的不用等。 */
  dwellMs?: number;
}

/** 畫面內的卡現在能不能拿（停留夠久、已經有、或剛被點）。 */
const settledVisible = (c: PoolCard, now: number, dwellMs: number, touchMs: number) =>
  c.visible && (c.granted || now - c.visibleSince >= dwellMs || now - c.touchedAt < touchMs);

/** 決定哪些卡有 xterm。 */
export function allocateTerminals(
  cards: readonly PoolCard[],
  now: number,
  {
    limit,
    graceMs,
    pinnedLimit = PINNED_LIMIT,
    touchMs = TOUCH_PRIORITY_MS,
    dwellMs = VISIBLE_DWELL_MS,
  }: AllocateOptions,
): Set<string> {
  // 畫面內的一律給（不受名額限制），只要停留夠久。
  const winners = new Set(
    cards.filter((c) => settledVisible(c, now, dwellMs, touchMs)).map((c) => c.id),
  );
  // 畫面外但展開／聚焦中的：最近的優先保留，超過 pinnedLimit 的和寬限期內的一起排。
  const pinned = cards
    .filter((c) => c.pinned && !winners.has(c.id))
    .sort((a, b) => b.touched - a.touched);
  for (const card of pinned.slice(0, Math.max(0, pinnedLimit))) winners.add(card.id);
  const recent = (c: PoolCard) => now - c.touchedAt < touchMs;
  const rest = cards.filter(
    (c) => !winners.has(c.id) && (c.pinned || (c.granted && now - c.lastSeen < graceMs)),
  );
  rest.sort(
    (a, b) =>
      // 展開／聚焦中 > 寬限期內
      Number(b.pinned) - Number(a.pinned) ||
      // 剛被點的 > 已經有的
      Number(recent(b)) - Number(recent(a)) ||
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
    readonly dwellMs = VISIBLE_DWELL_MS,
  ) {}

  set(id: string, demand: TerminalDemand): void {
    const now = this.clock.now();
    const card = this.cards.get(id);
    if (!card) {
      this.cards.set(id, {
        id,
        ...demand,
        granted: false,
        lastSeen: now,
        visibleSince: now,
        touched: demand.pinned ? ++this.touchClock : 0,
        touchedAt: -Infinity,
      });
    } else {
      if (card.visible === demand.visible && card.pinned === demand.pinned) return;
      // 剛離開畫面：從這一刻起算寬限期。
      if (card.visible || card.pinned || demand.visible || demand.pinned) card.lastSeen = now;
      // 剛被聚焦／展開：最近操作過的優先。
      if (demand.pinned && !card.pinned) card.touched = ++this.touchClock;
      // 剛進入畫面：從這一刻起算停留時間。
      if (demand.visible && !card.visible) card.visibleSince = now;
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
    card.touchedAt = this.clock.now();
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
    const winners = allocateTerminals(cards, now, {
      limit: this.limit,
      graceMs: this.graceMs,
      dwellMs: this.dwellMs,
    });
    let changed = false;
    // 下一次要重新分配的時間：寬限期到期，或畫面內的卡停留夠久。
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
      if (!granted && card.visible) {
        nextExpiry = Math.min(nextExpiry, card.visibleSince + this.dwellMs);
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
