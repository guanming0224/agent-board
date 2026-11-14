// WebGL 配額：全頁共用，集中決定哪幾個終端機用 WebGL renderer，其他用 xterm 的 DOM renderer。
// 瀏覽器（WebKit／Chromium）一頁最多 16 個 WebGL context，超過會把最舊的擠掉（黑屏、閃爍），
// 每個 context 在 GPU 程序還要十幾 MB。這裡留空間給頁面其他元件，絕不讓終端機撞到上限：
// - 同時用 WebGL 的終端機最多 WEBGL_LIMIT 個，只給看得到或聚焦中的；
// - WebKit 把「已經 loseContext、但 JS 物件還沒被 GC」的 context 也算進 16 個，所以另外數
//   還沒回收的 context（FinalizationRegistry），到 CONTEXT_CEILING 就先用 DOM renderer，回收後再升級；
//   聚焦中的、或頁面上唯一要 WebGL 的（全尺寸終端機頁）可以用到 CONTEXT_HARD_CEILING，仍低於 16；
// - 剛看不到的先保留 WEBGL_LINGER_MS（縮放來回、平移經過不必反覆建 context），名額不夠時才提早收回。
// 不碰 DOM，方便單元測試；實際的載入／卸載由 controller.ts 做。

/** 同時最多幾個終端機用 WebGL。 */
export const WEBGL_LIMIT = 6;
/** 終端機建立、還沒被回收的 context 最多幾個（瀏覽器上限 16，留 4 個給其他元件與誤差）。 */
export const CONTEXT_CEILING = 12;
/** 聚焦中、或頁面上沒有別的終端機在用 WebGL 時，可以用到這裡（瀏覽器上限 16 減 1）。 */
export const CONTEXT_HARD_CEILING = 15;
/** 看不到之後還保留 WebGL 多久。 */
export const WEBGL_LINGER_MS = 5000;

export interface WebglClient {
  /** 畫面上看得到（畫布卡在畫面內、全尺寸頁）。 */
  readonly visible: boolean;
  /** 鍵盤焦點在這個終端機裡。 */
  readonly focused: boolean;
  /** WebGL 壞過（不支援或 context 遺失）：不再分配，維持 DOM renderer。 */
  readonly webglBroken: boolean;
  /**
   * 分配到配額：載入 WebGL addon，回傳持有 context 的物件（canvas），用來數什麼時候被回收。
   * 失敗時自己標記 webglBroken、回傳空陣列。
   */
  grantWebgl(): readonly object[];
  /** 收回配額：卸載 addon 並釋放 context，退回 DOM renderer。 */
  revokeWebgl(): void;
}

export interface Candidate {
  id: number;
  visible: boolean;
  focused: boolean;
  /** 拿著 WebGL、剛看不到，還在保留期內。 */
  lingering: boolean;
  broken: boolean;
  holding: boolean;
  /** 最近一次變得可見或取得焦點的順序，越大越新。 */
  touched: number;
}

/**
 * 決定哪些拿到 WebGL：看得到或聚焦中的，名額有剩才輪到保留期內的。
 * 優先序：聚焦中 > 看得到 > 保留期內；同一級裡已經拿著的優先（不來回搶），再來是最近的。
 */
export function allocateWebgl(candidates: readonly Candidate[], limit: number): Set<number> {
  const rank = (c: Candidate) => (c.focused ? 2 : c.visible ? 1 : 0);
  const eligible = candidates.filter((c) => !c.broken && (c.visible || c.focused || c.lingering));
  eligible.sort(
    (a, b) => rank(b) - rank(a) || Number(b.holding) - Number(a.holding) || b.touched - a.touched,
  );
  return new Set(eligible.slice(0, Math.max(0, limit)).map((c) => c.id));
}

export interface BudgetClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 同一輪裡的多個變化（例如縮放時一次好幾張卡）合併成一次分配。 */
  schedule(run: () => void): void;
}

/** 物件被 GC 回收時通知（瀏覽器用 FinalizationRegistry）。 */
export type CollectTracker = (target: object, onCollected: () => void) => void;

const realClock: BudgetClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // 不能直接傳 queueMicrotask：當成物件方法呼叫時 this 不是 window，瀏覽器會丟錯。
  schedule: (run) => queueMicrotask(run),
};

const realTracker = (): CollectTracker => {
  if (typeof FinalizationRegistry === 'undefined') return () => {};
  const registry = new FinalizationRegistry<() => void>((onCollected) => onCollected());
  return (target, onCollected) => registry.register(target, onCollected);
};

interface Entry {
  id: number;
  holding: boolean;
  touched: number;
  /** 拿著 WebGL 但不再看得到的起點；看得到或聚焦時是 null。 */
  idleSince: number | null;
}

export class WebglBudget {
  private readonly entries = new Map<WebglClient, Entry>();
  private nextId = 0;
  private touchClock = 0;
  private scheduled = false;
  private timer: unknown = null;
  /** 終端機建立、還沒被回收的 context 數（含已釋放但 JS 物件還在的）。 */
  private alive = 0;

  constructor(
    readonly limit: number = WEBGL_LIMIT,
    readonly ceiling: number = CONTEXT_CEILING,
    readonly hardCeiling: number = CONTEXT_HARD_CEILING,
    readonly lingerMs: number = WEBGL_LINGER_MS,
    private readonly clock: BudgetClock = realClock,
    private readonly track: CollectTracker = realTracker(),
  ) {}

  register(client: WebglClient): void {
    this.entries.set(client, {
      id: this.nextId++,
      holding: false,
      touched: ++this.touchClock,
      idleSince: null,
    });
    this.request();
  }

  /** 終端機要 dispose：立刻收回（釋放 context），再讓別人遞補。 */
  unregister(client: WebglClient): void {
    const entry = this.entries.get(client);
    if (!entry) return;
    this.entries.delete(client);
    if (entry.holding) client.revokeWebgl();
    this.request();
  }

  /** 可見性、焦點或 broken 改變時呼叫；touched 表示剛變得可見或取得焦點。 */
  changed(client: WebglClient, touched = false): void {
    const entry = this.entries.get(client);
    if (!entry) return;
    if (touched) entry.touched = ++this.touchClock;
    this.request();
  }

  /** 目前拿著 WebGL 的數量（測試、量測用）。 */
  get holding(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.holding) count += 1;
    return count;
  }

  /** 還沒被回收的 context 數（測試、量測用）。 */
  get contexts(): number {
    return this.alive;
  }

  /** 立刻分配（測試用；平常由 schedule 觸發）。 */
  flush(): void {
    this.scheduled = false;
    const now = this.clock.now();
    const list = [...this.entries];
    for (const [client, entry] of list) {
      const wanted = !client.webglBroken && (client.visible || client.focused);
      if (wanted || !entry.holding) entry.idleSince = null;
      else entry.idleSince ??= now;
    }
    const lingering = (entry: Entry) =>
      entry.idleSince !== null && now - entry.idleSince < this.lingerMs;
    const winners = allocateWebgl(
      list.map(([client, entry]) => ({
        id: entry.id,
        visible: client.visible,
        focused: client.focused,
        lingering: entry.holding && lingering(entry),
        broken: client.webglBroken,
        holding: entry.holding,
        touched: entry.touched,
      })),
      this.limit,
    );
    // 先收回再分配：任何時刻拿著的數量都不超過上限。
    for (const [client, entry] of list) {
      if (entry.holding && !winners.has(entry.id)) {
        entry.holding = false;
        entry.idleSince = null;
        client.revokeWebgl();
      }
    }
    let retry = false;
    // 照優先序給（winners 是排序過的），context 不夠時先拿到的是聚焦中、看得到的。
    const byId = new Map(list.map(([client, entry]) => [entry.id, [client, entry] as const]));
    for (const id of winners) {
      const [client, entry] = byId.get(id)!;
      if (entry.holding || !this.entries.has(client)) continue;
      // 還沒回收的 context 太多：先用 DOM renderer，等回收後（onCollected）再升級。
      const cap = client.focused || this.holding === 0 ? this.hardCeiling : this.ceiling;
      if (this.alive >= cap) continue;
      const owners = client.grantWebgl();
      entry.holding = !client.webglBroken && owners.length > 0;
      for (const owner of owners) {
        this.alive += 1;
        this.track(owner, () => {
          this.alive -= 1;
          this.request();
        });
      }
      // 載入失敗的名額讓給下一個（壞掉的已被排除，不會無限重試）。
      retry ||= !entry.holding;
    }
    this.armTimer(now);
    if (retry) this.request();
  }

  /** 保留期到了要重新分配。 */
  private armTimer(now: number): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    let next = Infinity;
    for (const entry of this.entries.values()) {
      if (entry.holding && entry.idleSince !== null) {
        next = Math.min(next, entry.idleSince + this.lingerMs);
      }
    }
    if (next === Infinity) return;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.max(0, next - now),
    );
  }

  private request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.clock.schedule(() => {
      if (this.scheduled) this.flush();
    });
  }
}

/** 全頁共用的那一份。 */
export const webglBudget = new WebglBudget();
