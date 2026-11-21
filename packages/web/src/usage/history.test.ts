// 用量詳情「全部」期間（GM 2026-11-21）：月彙總、來源與機器篩選、分布、空資料。
import { describe, expect, it } from 'vitest';
import type { UsageHistoryReport } from '@agent-board/protocol';
import {
  filterHistory,
  hasCodexHistory,
  historyByMachine,
  historyByModel,
  historyBySource,
  historyRange,
  historyTotals,
  monthly,
  monthsBetween,
  MAX_MONTHS,
} from './history';

const machine = (machineId: string, name: string, removed = false) => ({
  machineId,
  name,
  removed,
  online: !removed,
  timeZone: 'Asia/Taipei',
  firstDay: null,
  lastDay: null,
  updatedAt: null,
  completeAt: null,
});

const report: UsageHistoryReport = {
  generatedAt: '2026-11-21T00:00:00.000Z',
  months: ['2025-12', '2026-01', '2026-03'],
  models: ['claude-opus', 'gpt-5.5'],
  machines: [machine('m1', 'Mac'), machine('m2', 'Old', true)],
  ranges: [
    [0, 0, '2025-12-31', '2026-01-01'],
    [0, 1, '2026-03-02', '2026-03-02'],
    [1, 0, '2026-01-15', '2026-01-15'],
  ],
  rows: [
    // [機器, 月份, 模型, 來源, 輸入, 輸出, 快取讀, 快取寫]
    [0, 0, 0, 0, 1, 2, 3, 4],
    [0, 1, 0, 0, 10, 20, 30, 40],
    [1, 1, 0, 0, 100, 200, 0, 0],
    [0, 2, 1, 1, 5, 5, 50, 0],
  ],
};

describe('全部期間：月彙總', () => {
  it('monthsBetween 跨年、含頭尾', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthsBetween('2026-03', '2026-03')).toEqual(['2026-03']);
  });

  it('依 token 類型：每月加總，沒資料的月份補 0，一直排到這個月', () => {
    const rows = filterHistory(report, { source: 'all', machine: 'all' });
    const m = monthly(report, rows, 'type', 'conversation', '2026-04');
    expect(m.days).toEqual(['2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
    expect(m.series.map((s) => s.key)).toEqual(['input', 'output']);
    expect(m.values).toEqual([
      [1, 2],
      [110, 220],
      [0, 0],
      [5, 5],
      [0, 0],
    ]);
    expect(m.max).toBe(330);
    const all = monthly(report, rows, 'type', 'all', '2026-03');
    expect(all.values[1]).toEqual([110, 220, 40, 30]);
  });

  it('依機器、依來源堆疊', () => {
    const rows = filterHistory(report, { source: 'all', machine: 'all' });
    const byMachine = monthly(report, rows, 'machine', 'conversation', '2026-03');
    expect(byMachine.series.map((s) => s.key)).toEqual(['m1', 'm2']);
    expect(byMachine.values[1]).toEqual([30, 300]);
    const bySource = monthly(report, rows, 'source', 'all', '2026-03');
    expect(bySource.series.map((s) => s.key)).toEqual(['claude', 'codex']);
    expect(bySource.values[3]).toEqual([0, 60]);
  });

  it('依來源、機器篩選；合計、範圍與分布跟著篩選', () => {
    expect(hasCodexHistory(report)).toBe(true);
    const claude = filterHistory(report, { source: 'claude', machine: 'all' });
    expect(historyTotals(claude)).toEqual({
      input: 111,
      output: 222,
      cacheRead: 33,
      cacheCreation: 44,
    });
    expect(historyRange(report, { source: 'claude', machine: 'all' })).toEqual({
      first: '2025-12-31',
      last: '2026-01-15',
    });
    expect(historyRange(report, { source: 'all', machine: 'm1' })).toEqual({
      first: '2025-12-31',
      last: '2026-03-02',
    });
    const m1 = filterHistory(report, { source: 'all', machine: 'm1' });
    expect(historyTotals(m1).input).toBe(16);
    expect(historyByModel(report, m1, 'conversation')).toEqual([
      { key: 'model:0', label: 'claude-opus', value: 33 },
      { key: 'model:1', label: 'gpt-5.5', value: 10 },
    ]);
    const all = filterHistory(report, { source: 'all', machine: 'all' });
    expect(historyByMachine(report, all, 'conversation').map((s) => [s.key, s.value])).toEqual([
      ['m2', 300],
      ['m1', 43],
    ]);
    expect(historyBySource(all, 'all').map((s) => [s.label, s.value])).toEqual([
      ['claude', 410],
      ['codex', 60],
    ]);
  });

  it('沒有資料：只有這個月、全是 0', () => {
    const empty = { ...report, rows: [] };
    const m = monthly(empty, [], 'type', 'conversation', '2026-11');
    expect(m.days).toEqual(['2026-11']);
    expect(m.max).toBe(0);
    expect(historyRange({ ...empty, ranges: [] }, { source: 'all', machine: 'all' })).toBeNull();
  });

  it('防呆：月份格式不對回空、最多 MAX_MONTHS 個月；比這個月晚的月份不畫', () => {
    expect(monthsBetween('9999-99', '2026-01')).toEqual([]);
    const long = monthsBetween('0001-01', '9999-12');
    expect(long).toHaveLength(MAX_MONTHS);
    expect(long.at(-1)).toBe('9999-12');
    const future = { ...report, months: ['2026-01', '9999-12'], rows: [[0, 1, 0, 0, 1, 1, 0, 0]] };
    const m = monthly(
      future as UsageHistoryReport,
      future.rows as UsageHistoryReport['rows'],
      'type',
      'conversation',
      '2026-11',
    );
    expect(m.days).toEqual(['2026-11']);
  });
});
