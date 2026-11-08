// @vitest-environment node
// 深層搜尋（P3 ③b）：畫面狀態的併法、假後端（兩台機器：一台 300ms、一台失聯）、對話紀錄網址。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackend } from '../shared/fakeBackend';
import type { DeepSearchEvent } from '../shared/backend';
import { parseHash, transcriptHash, transcriptTarget } from '../views/overlay';
import { reduceDeep, type DeepState } from './deep';

describe('reduceDeep', () => {
  const running: DeepState = { state: 'running', searchId: 'd1', machines: [], items: [] };
  it('開始 → 每台搜尋中；結果累加筆數；每台都結束才算完成；別的 searchId 不理', () => {
    let s = reduceDeep(running, {
      type: 'search.deepStarted',
      searchId: 'd1',
      machines: [
        { machineId: 'a', totalSessions: 2 },
        { machineId: 'b', totalSessions: 1 },
      ],
    });
    expect(s.state).toBe('running');
    s = reduceDeep(s, {
      type: 'search.deepResult',
      searchId: 'd1',
      machineId: 'a',
      items: [{ kind: 'transcript', snippet: 'x', matchRanges: [], machineId: 'a' }],
    });
    s = reduceDeep(s, {
      type: 'search.deepResult',
      searchId: 'old',
      machineId: 'a',
      items: [{ kind: 'transcript', snippet: 'old', matchRanges: [] }],
    });
    s = reduceDeep(s, {
      type: 'search.deepDone',
      searchId: 'd1',
      machineId: 'b',
      state: 'offline',
      scannedSessions: 0,
      totalSessions: 1,
    });
    expect(s.state).toBe('running');
    s = reduceDeep(s, {
      type: 'search.deepDone',
      searchId: 'd1',
      machineId: 'a',
      state: 'timeout',
      scannedSessions: 1,
      totalSessions: 2,
    });
    expect(s).toMatchObject({
      state: 'finished',
      items: [{ snippet: 'x' }],
      machines: [
        { machineId: 'a', state: 'timeout', items: 1, scanned: 1, total: 2 },
        { machineId: 'b', state: 'offline', items: 0 },
      ],
    });
    expect(
      reduceDeep(running, { type: 'search.deepFailed', searchId: 'd1', error: 'disconnected' })
        .state,
    ).toBe('failed');
    expect(
      reduceDeep(running, { type: 'search.deepStarted', searchId: 'd1', machines: [] }).state,
    ).toBe('finished');
  });
});

describe('假後端的深層搜尋', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('demo-studio 300ms 回 2 筆、demo-gpu 慢、demo-laptop 失聯；遮蔽模式片段沒有金鑰；取消後不再回', () => {
    const backend = createFakeBackend();
    const events: DeepSearchEvent[] = [];
    backend.deepSearch(
      { q: '手續費 0.1425', scope: 'all', since: '7d', archived: false, mask: false },
      (e) => events.push(e),
    );
    vi.advanceTimersByTime(0);
    const started = events.find((e) => e.type === 'search.deepStarted');
    expect(
      started?.type === 'search.deepStarted' && started.machines.map((m) => m.machineId).sort(),
    ).toEqual(['m-gpu', 'm-laptop', 'm-studio']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'search.deepDone', machineId: 'm-laptop', state: 'offline' }),
    );
    vi.advanceTimersByTime(299);
    expect(events.some((e) => e.type === 'search.deepResult')).toBe(false);
    vi.advanceTimersByTime(1);
    const studio = events.find((e) => e.type === 'search.deepResult' && e.machineId === 'm-studio');
    expect(studio?.type === 'search.deepResult' && studio.items).toHaveLength(2);
    expect(
      studio?.type === 'search.deepResult' && studio.items.map((i) => i.transcriptIndex),
    ).toEqual([12, 31]);
    vi.advanceTimersByTime(1500);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'search.deepDone', machineId: 'm-gpu', state: 'done' }),
    );

    const masked: DeepSearchEvent[] = [];
    backend.deepSearch(
      { q: 'FEE_TOKEN', scope: 'all', since: '7d', archived: false, mask: true },
      (e) => masked.push(e),
    );
    vi.advanceTimersByTime(2000);
    const hits = masked.flatMap((e) => (e.type === 'search.deepResult' ? e.items : []));
    expect(hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(hits)).not.toContain('sk-ant');

    const cancelled: DeepSearchEvent[] = [];
    const handle = backend.deepSearch(
      { q: '手續費', scope: 'all', since: '7d', archived: false, mask: false },
      (e) => cancelled.push(e),
    );
    vi.advanceTimersByTime(0);
    handle.cancel();
    vi.advanceTimersByTime(2000);
    expect(cancelled.map((e) => e.type)).not.toContain('search.deepResult');
  });
});

describe('對話紀錄網址', () => {
  it('#/transcript/<id>?at=<n> 是次畫面；解析回 id 與序號', () => {
    const hash = transcriptHash('s 1', 31);
    expect(hash).toBe('#/transcript/s%201?at=31');
    expect(parseHash(hash)).toMatchObject({ kind: 'board', modal: 'transcript' });
    expect(transcriptTarget(hash)).toEqual({ id: 's 1', at: 31 });
    expect(transcriptTarget(transcriptHash('s1'))).toEqual({ id: 's1', at: null });
    expect(transcriptTarget('#/transcript/s1?at=-3')).toEqual({ id: 's1', at: null });
  });
});
