import { describe, expect, it } from 'vitest';
import { TerminalPool, allocateTerminals, type PoolCard, type PoolClock } from './terminalPool';

/** 假時鐘：手動推進時間、手動觸發排程。 */
class FakeClock implements PoolClock {
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
  /** 跑完排程（等於 microtask）。 */
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
  get pendingTimers() {
    return this.timers.length;
  }
}

const card = (id: string, patch: Partial<PoolCard> = {}): PoolCard => ({
  id,
  visible: false,
  pinned: false,
  granted: false,
  lastSeen: 0,
  touched: 0,
  ...patch,
});

describe('allocateTerminals', () => {
  it('畫面外、沒拿過的卡不給', () => {
    expect([...allocateTerminals([card('a')], 0, 8, 5000)]).toEqual([]);
  });

  it('畫面內的優先，超過上限的不給', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => card(id, { visible: true }));
    expect(allocateTerminals(cards, 0, 3, 5000).size).toBe(3);
  });

  it('展開／聚焦中的一定給，而且佔掉其他卡的名額', () => {
    const cards = [
      card('p1', { pinned: true }),
      card('p2', { pinned: true }),
      card('v1', { visible: true }),
      card('v2', { visible: true }),
    ];
    expect([...allocateTerminals(cards, 0, 3, 5000)].sort()).toEqual(['p1', 'p2', 'v1']);
    // 名額比 pinned 少也照樣給 pinned。
    expect([...allocateTerminals(cards, 0, 1, 5000)].sort()).toEqual(['p1', 'p2']);
  });

  it('剛離開畫面的在寬限期內保留，過了就釋放', () => {
    const left = card('a', { granted: true, lastSeen: 1000 });
    expect(allocateTerminals([left], 5999, 8, 5000).has('a')).toBe(true);
    expect(allocateTerminals([left], 6000, 8, 5000).has('a')).toBe(false);
  });

  it('畫面內的會擠掉寬限期內的；寬限期內的照最近看過排', () => {
    const cards = [
      card('old', { granted: true, lastSeen: 100 }),
      card('recent', { granted: true, lastSeen: 900 }),
      card('new', { visible: true }),
    ];
    expect([...allocateTerminals(cards, 1000, 2, 5000)].sort()).toEqual(['new', 'recent']);
  });

  it('畫面內超過上限：已經有的留著，再來是最近點過的', () => {
    const cards = [
      card('a', { visible: true, granted: true }),
      card('b', { visible: true, touched: 5 }),
      card('c', { visible: true, touched: 1 }),
    ];
    expect([...allocateTerminals(cards, 0, 2, 5000)].sort()).toEqual(['a', 'b']);
  });
});

describe('TerminalPool', () => {
  const setup = (limit = 3, grace = 5000) => {
    const clock = new FakeClock();
    const pool = new TerminalPool(limit, grace, clock);
    let notified = 0;
    pool.subscribe(() => (notified += 1));
    return { clock, pool, notified: () => notified };
  };

  it('同一輪的變化合併成一次分配，排程跑完才生效', () => {
    const { clock, pool, notified } = setup();
    pool.set('a', { visible: true, pinned: false });
    pool.set('b', { visible: true, pinned: false });
    expect(pool.granted('a')).toBe(false);
    clock.settle();
    expect(pool.granted('a') && pool.granted('b')).toBe(true);
    expect(notified()).toBe(1);
  });

  it('上限：一次很多張進畫面，只給上限數', () => {
    const { clock, pool } = setup(3);
    for (let i = 0; i < 25; i += 1) pool.set(`s${i}`, { visible: true, pinned: false });
    clock.settle();
    expect(pool.grantedCount).toBe(3);
  });

  it('離開畫面延遲釋放；寬限期內回來不重建', () => {
    const { clock, pool } = setup(3, 5000);
    pool.set('a', { visible: true, pinned: false });
    clock.settle();
    pool.set('a', { visible: false, pinned: false });
    clock.advance(4000);
    expect(pool.granted('a')).toBe(true);
    // 回到畫面：寬限期重算，計時器取消。
    pool.set('a', { visible: true, pinned: false });
    clock.advance(10_000);
    expect(pool.granted('a')).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    // 再離開：5 秒後釋放。
    pool.set('a', { visible: false, pinned: false });
    clock.advance(4999);
    expect(pool.granted('a')).toBe(true);
    clock.advance(1);
    expect(pool.granted('a')).toBe(false);
  });

  it('新卡進畫面、名額滿：立刻擠掉寬限期內的，不等 5 秒', () => {
    const { clock, pool } = setup(2);
    pool.set('a', { visible: true, pinned: false });
    pool.set('b', { visible: true, pinned: false });
    clock.settle();
    pool.set('a', { visible: false, pinned: false });
    pool.set('c', { visible: true, pinned: false });
    clock.settle();
    expect(pool.granted('a')).toBe(false);
    expect(pool.granted('b') && pool.granted('c')).toBe(true);
  });

  it('pinned（展開／聚焦）離開畫面也保留', () => {
    const { clock, pool } = setup(2);
    pool.set('a', { visible: false, pinned: true });
    clock.advance(60_000);
    expect(pool.granted('a')).toBe(true);
  });

  it('touch：畫面內超過上限時，最近點過的優先', () => {
    const { clock, pool } = setup(1);
    pool.set('a', { visible: true, pinned: false });
    pool.set('b', { visible: true, pinned: false });
    pool.touch('b');
    clock.settle();
    expect(pool.granted('b')).toBe(true);
    expect(pool.granted('a')).toBe(false);
  });

  it('remove 立刻讓出名額', () => {
    const { clock, pool } = setup(1);
    pool.set('a', { visible: true, pinned: false });
    clock.settle();
    pool.set('b', { visible: true, pinned: false });
    clock.settle();
    expect(pool.granted('b')).toBe(false);
    pool.remove('a');
    clock.settle();
    expect(pool.granted('b')).toBe(true);
  });

  it('縮放來回（全覽↔放大）在寬限期內不會整批釋放再重建', () => {
    const { clock, pool, notified } = setup(8);
    const ids = Array.from({ length: 25 }, (_, i) => `s${i}`);
    const onScreenWhenZoomed = new Set(['s0', 's1', 's2']);
    let grants = 0;
    pool.subscribe(() => (grants = pool.grantedCount));
    for (let round = 0; round < 10; round += 1) {
      // 放大：畫面內 3 張變終端機
      for (const id of ids) pool.set(id, { visible: onScreenWhenZoomed.has(id), pinned: false });
      clock.advance(800);
      expect(pool.grantedCount).toBe(3);
      // 全覽：全部變摘要條
      for (const id of ids) pool.set(id, { visible: false, pinned: false });
      clock.advance(800);
      expect(pool.grantedCount).toBe(3);
    }
    // 只在第一次放大時分配過一次，之後沒有變化。
    expect(notified()).toBe(1);
    expect(grants).toBe(3);
    clock.advance(5000);
    expect(pool.grantedCount).toBe(0);
  });
});
