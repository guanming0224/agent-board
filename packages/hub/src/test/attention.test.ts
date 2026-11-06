// 合併通知的時間規則與內容（attention.ts）。整合行為（送什麼、設定關掉照舊）在 notify.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSummary, DEFAULT_WINDOWS, NotifyCoalescer, type SummaryItem } from '../attention';

describe('NotifyCoalescer', () => {
  let flushed: string[][];
  let coalescer: NotifyCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
    flushed = [];
    coalescer = new NotifyCoalescer({
      now: () => Date.now(),
      windows: DEFAULT_WINDOWS,
      flush: (triggered) => flushed.push(triggered),
    });
  });

  afterEach(() => {
    coalescer.close();
    vi.useRealTimers();
  });

  it('預設：一般事件 15 秒、權限請求 5 秒、最多 60 秒', () => {
    expect(DEFAULT_WINDOWS).toEqual({ normalMs: 15_000, urgentMs: 5_000, maxMs: 60_000 });
  });

  it('一個事件：等 15 秒後送一次', () => {
    coalescer.add('a', false);
    vi.advanceTimersByTime(14_999);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([['a']]);
    vi.advanceTimersByTime(60_000);
    expect(flushed).toHaveLength(1);
  });

  it('新事件延長等待（從新事件再算 15 秒）', () => {
    coalescer.add('a', false);
    vi.advanceTimersByTime(10_000);
    coalescer.add('b', false);
    vi.advanceTimersByTime(14_000);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(flushed).toEqual([['a', 'b']]);
  });

  it('一直有新事件也最多等 60 秒', () => {
    coalescer.add('a', false);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(10_000);
      if (flushed.length === 0) coalescer.add(`s${i}`, false);
    }
    expect(flushed).toHaveLength(1);
    // 第一個事件 10:00:00，最晚 10:01:00 送出。
    expect(flushed[0]).toContain('a');
    expect(flushed[0]).toHaveLength(6);
  });

  it('權限請求：5 秒內就送，後來的一般事件不會再延長', () => {
    coalescer.add('a', false);
    vi.advanceTimersByTime(2_000);
    coalescer.add('perm', true);
    vi.advanceTimersByTime(1_000);
    coalescer.add('b', false);
    expect(coalescer.deadline()).toBe(Date.now() + 4_000);
    vi.advanceTimersByTime(3_999);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([['a', 'perm', 'b']]);
  });

  it('只有權限請求：5 秒', () => {
    coalescer.add('perm', true);
    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([['perm']]);
  });

  it('同一個 session 再來一次只記一次，排到最新', () => {
    coalescer.add('a', false);
    coalescer.add('b', false);
    coalescer.add('a', false);
    vi.advanceTimersByTime(15_000);
    expect(flushed).toEqual([['b', 'a']]);
  });

  it('送出後重新開始一批', () => {
    coalescer.add('a', false);
    vi.advanceTimersByTime(15_000);
    coalescer.add('b', true);
    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([['a'], ['b']]);
  });

  it('flushNow 馬上送；沒有在等就什麼都不做', () => {
    coalescer.flushNow();
    expect(flushed).toEqual([]);
    coalescer.add('a', false);
    coalescer.flushNow();
    expect(flushed).toEqual([['a']]);
    vi.advanceTimersByTime(60_000);
    expect(flushed).toHaveLength(1);
  });
});

describe('buildSummary', () => {
  const item = (sessionId: string, over: Partial<SummaryItem> = {}): SummaryItem => ({
    sessionId,
    name: sessionId.toUpperCase(),
    status: 'waiting_input',
    ...over,
  });
  const at = '2026-11-06T10:00:00.000Z';

  it('什麼都不剩就不送', () => {
    expect(buildSummary([], ['a'], [], at)).toBeNull();
  });

  it('權限請求最前、再來是自動流程停下的、再來是這一批觸發的（新的在前）', () => {
    const payload = buildSummary(
      [
        item('old'),
        item('ex', { reason: 'handoff_round_limit', maxRounds: 3 }),
        item('new'),
        item('bd1', { status: 'waiting_permission' }),
      ],
      ['old', 'new'],
      [],
      at,
    )!;
    expect(payload.items.map((i) => i.sessionId)).toEqual(['bd1', 'ex', 'new', 'old']);
    expect(payload).toMatchObject({ kind: 'summary', count: 4, more: 0, at });
    expect(payload.overLimit).toBeUndefined();
  });

  it('超過 5 項只帶前 5 項，其餘算在 more；名稱太長截斷', () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`s${i}`));
    many[0] = item('s0', { name: 'x'.repeat(200) });
    const payload = buildSummary(many, [], [], at, 3)!;
    expect(payload.count).toBe(8);
    expect(payload.items).toHaveLength(5);
    expect(payload.more).toBe(3);
    expect(payload.items[0]!.name).toHaveLength(60);
    expect(payload.overLimit).toBe(3);
  });

  it('只有自動接續也送（告知）', () => {
    const payload = buildSummary([], [], [{ sessionId: 'a', name: 'BD1' }], at)!;
    expect(payload).toMatchObject({ count: 0, items: [], autoContinued: [{ name: 'BD1' }] });
  });

  it('內容只有名稱、狀態、原因代碼與數字：和單則推播帶的一樣', () => {
    const payload = buildSummary(
      [item('a', { reason: 'task_reject_limit', maxRounds: 3, task: 7 })],
      [],
      [],
      at,
    )!;
    expect(Object.keys(payload).sort()).toEqual(
      ['at', 'autoContinued', 'count', 'items', 'kind', 'more'].sort(),
    );
    expect(Object.keys(payload.items[0]!).sort()).toEqual(
      ['maxRounds', 'name', 'reason', 'sessionId', 'status', 'task'].sort(),
    );
  });
});
