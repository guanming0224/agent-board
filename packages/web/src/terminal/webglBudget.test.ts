import { describe, expect, it } from 'vitest';
import {
  WebglBudget,
  allocateWebgl,
  type BudgetClock,
  type Candidate,
  type WebglClient,
} from './webglBudget';

class FakeClock implements BudgetClock {
  time = 0;
  private timers: { at: number; run: () => void; handle: number }[] = [];
  private queued: (() => void)[] = [];
  private nextHandle = 1;
  now = () => this.time;
  setTimeout = (run: () => void, ms: number) => {
    const handle = this.nextHandle++;
    this.timers.push({ at: this.time + ms, run, handle });
    return handle;
  };
  clearTimeout = (handle: unknown) => {
    this.timers = this.timers.filter((t) => t.handle !== handle);
  };
  schedule = (run: () => void) => {
    this.queued.push(run);
  };
  settle() {
    while (this.queued.length > 0) this.queued.shift()!();
  }
  advance(ms: number) {
    this.time += ms;
    this.settle();
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.time).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      due.run();
      this.settle();
    }
  }
}

/** 假的 GC：手動回收。 */
class FakeGc {
  private pending: (() => void)[] = [];
  track = (_target: object, onCollected: () => void) => {
    this.pending.push(onCollected);
  };
  collectAll() {
    const all = this.pending;
    this.pending = [];
    for (const run of all) run();
  }
}

class FakeClient implements WebglClient {
  visible = false;
  focused = false;
  webglBroken = false;
  /** 下一次 grant 失敗（不支援 WebGL2）。 */
  failNext = false;
  holding = false;
  grants = 0;
  revokes = 0;
  constructor(private readonly onGrant: (c: FakeClient) => void) {}
  grantWebgl() {
    if (this.failNext) {
      this.webglBroken = true;
      return [];
    }
    this.grants += 1;
    this.holding = true;
    this.onGrant(this);
    return [{}];
  }
  revokeWebgl() {
    this.revokes += 1;
    this.holding = false;
  }
}

const cand = (id: number, patch: Partial<Candidate> = {}): Candidate => ({
  id,
  visible: false,
  focused: false,
  lingering: false,
  broken: false,
  holding: false,
  touched: id,
  ...patch,
});

describe('allocateWebgl', () => {
  it('只給看得到、聚焦中或保留期內的', () => {
    const winners = allocateWebgl(
      [
        cand(1),
        cand(2, { visible: true }),
        cand(3, { focused: true }),
        cand(4, { lingering: true }),
      ],
      6,
    );
    expect([...winners].sort()).toEqual([2, 3, 4]);
  });

  it('聚焦中 > 看得到 > 保留期內；同級裡已經拿著的優先，再來是最近的', () => {
    const winners = allocateWebgl(
      [
        cand(1, { visible: true, holding: true, touched: 1 }),
        cand(2, { visible: true, touched: 9 }),
        cand(3, { visible: true, touched: 5 }),
        cand(4, { focused: true, touched: 0 }),
        cand(5, { lingering: true, holding: true, touched: 99 }),
      ],
      3,
    );
    expect([...winners]).toEqual([4, 1, 2]);
  });

  it('壞掉的不給', () => {
    expect(allocateWebgl([cand(1, { visible: true, broken: true })], 6).size).toBe(0);
  });
});

describe('WebglBudget', () => {
  const setup = (limit = 6, ceiling = 12, linger = 5000, hard = ceiling, delay = 0) => {
    const clock = new FakeClock();
    const gc = new FakeGc();
    const budget = new WebglBudget(limit, ceiling, hard, linger, delay, clock, gc.track);
    let peak = 0;
    const client = (visible = false) => {
      const c = new FakeClient(() => (peak = Math.max(peak, budget.holding + 1)));
      c.visible = visible;
      budget.register(c);
      return c;
    };
    // 實際上分配在 microtask 裡馬上跑，這裡也馬上跑完再推進時間。
    const show = (c: FakeClient, visible: boolean) => {
      c.visible = visible;
      budget.changed(c, visible);
      clock.settle();
    };
    return { budget, clock, gc, client, show, peak: () => peak };
  };

  it('25 個看得到的終端機：任何時刻都不超過上限', () => {
    const { budget, clock, gc, client, show, peak } = setup(6, 100);
    const clients = Array.from({ length: 25 }, () => client(true));
    clock.settle();
    expect(budget.holding).toBe(6);
    // 換一批看得到：先收回舊的再給新的（看不到的還在保留期，但名額要讓給看得到的）。
    for (const [i, c] of clients.entries()) show(c, i >= 19);
    clock.settle();
    expect(budget.holding).toBe(6);
    expect(clients.slice(19).every((c) => c.holding)).toBe(true);
    expect(peak()).toBe(6);
    gc.collectAll();
  });

  it('看不到先保留 5 秒，期間回來不重建；過了才降級成 DOM', () => {
    const { budget, clock, client, show } = setup();
    const c = client(true);
    clock.settle();
    expect(c.holding).toBe(true);
    show(c, false);
    clock.advance(4000);
    expect(c.holding).toBe(true);
    show(c, true);
    clock.advance(10_000);
    expect(c.grants).toBe(1);
    show(c, false);
    clock.advance(5000);
    expect(c.holding).toBe(false);
    expect(budget.holding).toBe(0);
    show(c, true);
    clock.settle();
    expect(c.grants).toBe(2);
  });

  it('還沒回收的 context 到上限就先不給，回收後再升級', () => {
    const { budget, clock, gc, client, show } = setup(6, 3, 0);
    const a = client(true);
    clock.settle();
    // a 反覆看得到／看不到：每次都建新的 context，舊的還沒被 GC。
    for (let i = 0; i < 2; i += 1) {
      show(a, false);
      clock.advance(1);
      show(a, true);
      clock.settle();
    }
    expect(budget.contexts).toBe(3);
    expect(a.holding).toBe(true);
    show(a, false);
    clock.advance(1);
    show(a, true);
    clock.settle();
    // 已經 3 個沒回收：這次維持 DOM。
    expect(a.holding).toBe(false);
    expect(a.grants).toBe(3);
    gc.collectAll();
    clock.settle();
    expect(budget.contexts).toBe(1);
    expect(a.holding).toBe(true);
  });

  it('context 快滿時：聚焦中的、或頁面上唯一要 WebGL 的（全尺寸頁）可以用到硬上限', () => {
    const { budget, clock, client, show } = setup(6, 2, 0, 3);
    const a = client(true);
    const b = client(true);
    clock.settle();
    expect(budget.contexts).toBe(2);
    // 兩個都看不到又回來：軟上限 2 已滿，一般的不給。
    show(a, false);
    show(b, false);
    clock.advance(1);
    expect(budget.holding).toBe(0);
    const c = client(true);
    clock.settle();
    // 頁面上沒有人在用 WebGL（例如剛切到全尺寸頁）：可以用到硬上限。
    expect(c.holding).toBe(true);
    expect(budget.contexts).toBe(3);
    // 再來一個：已到硬上限，維持 DOM。
    const d = client(true);
    d.focused = true;
    budget.changed(d, true);
    clock.settle();
    expect(d.holding).toBe(false);
  });

  it('新拿 WebGL 要先看得到 1 秒；平移經過的不花 context；頁面上唯一的、聚焦中的立刻給', () => {
    const { budget, clock, client, show } = setup(6, 12, 5000, 12, 1000);
    // 頁面上沒有人在用：立刻給（全尺寸頁）。
    const first = client(true);
    clock.settle();
    expect(first.holding).toBe(true);
    // 其他的：看得到 1 秒後才給。
    const passing = client(true);
    clock.settle();
    clock.advance(500);
    expect(passing.holding).toBe(false);
    show(passing, false);
    clock.advance(2000);
    expect(passing.grants).toBe(0);
    const staying = client(true);
    clock.settle();
    clock.advance(999);
    expect(staying.holding).toBe(false);
    clock.advance(1);
    expect(staying.holding).toBe(true);
    // 聚焦中的不用等。
    const focused = client(false);
    focused.focused = true;
    budget.changed(focused, true);
    clock.settle();
    expect(focused.holding).toBe(true);
  });

  it('聚焦中的會搶到名額（擠掉只是看得到的）', () => {
    const { budget, clock, client } = setup(1);
    const a = client(true);
    const b = client(false);
    clock.settle();
    expect(a.holding).toBe(true);
    b.focused = true;
    budget.changed(b, true);
    clock.settle();
    expect(b.holding).toBe(true);
    expect(a.holding).toBe(false);
  });

  it('unregister 立刻收回並讓下一個遞補', () => {
    const { budget, clock, client } = setup(1);
    const a = client(true);
    const b = client(true);
    clock.settle();
    const [holder, waiter] = a.holding ? [a, b] : [b, a];
    budget.unregister(holder);
    expect(holder.revokes).toBe(1);
    clock.settle();
    expect(waiter.holding).toBe(true);
  });

  it('載入失敗的標成壞掉，名額讓給下一個，不重試', () => {
    const { budget, clock, client } = setup(1);
    const a = new FakeClient(() => {});
    a.visible = true;
    a.failNext = true;
    budget.register(a);
    clock.settle();
    const b = client(true);
    clock.settle();
    expect(a.webglBroken).toBe(true);
    expect(b.holding).toBe(true);
    expect(budget.holding).toBe(1);
  });
});
