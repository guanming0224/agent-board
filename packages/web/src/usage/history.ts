// 用量詳情「全部」期間（GM 2026-11-21，CONTRACTS §28）的計算：資料是 hub 的 UsageHistoryReport
// （GET /api/usage/history：hub 每天存的歷史 ∪ 各機器目前的掃描）。太長的每日列表不實用，一律以「月」為單位。
// 純函式，畫面與測試共用。
import type { UsageHistoryReport } from '@agent-board/protocol';
import {
  kindsOf,
  measureOf,
  TOKEN_KINDS,
  zeroCounts,
  type AgentFilter,
  type Counts,
  type Daily,
  type Measure,
  type Series,
  type Share,
} from './model';

export interface HistoryFilter {
  source: AgentFilter;
  /** 'all' 或機器 id。 */
  machine: string;
}

/** 全部時間的堆疊：依 token 類型、依機器、依來源（Claude／Codex）。 */
export type HistoryStackBy = 'type' | 'machine' | 'source';

type Row = UsageHistoryReport['rows'][number];

const sourceOf = (row: Row): 'claude' | 'codex' => (row[3] === 1 ? 'codex' : 'claude');

function add(target: Counts, row: Row): void {
  target.input += row[4];
  target.output += row[5];
  target.cacheRead += row[6];
  target.cacheCreation += row[7];
}

/** 篩選後的列（來源、機器）。 */
export function filterHistory(report: UsageHistoryReport, filter: HistoryFilter): Row[] {
  return report.rows.filter(
    (row) =>
      (filter.source === 'all' || sourceOf(row) === filter.source) &&
      (filter.machine === 'all' || report.machines[row[0]]?.machineId === filter.machine),
  );
}

export const hasCodexHistory = (report: UsageHistoryReport): boolean =>
  report.rows.some((row) => row[3] === 1);

/** 月份列表最多幾個月（防呆：資料壞掉也不會畫出幾萬個月）。 */
export const MAX_MONTHS = 600;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 從 from 到 to（含）的每個月 `YYYY-MM`；格式不對回空陣列，最多 MAX_MONTHS 個（保留最新的）。 */
export function monthsBetween(from: string, to: string): string[] {
  const a = MONTH.exec(from);
  const b = MONTH.exec(to);
  if (!a || !b) return [];
  const start = Number(a[1]) * 12 + Number(a[2]) - 1;
  const end = Number(b[1]) * 12 + Number(b[2]) - 1;
  const out: string[] = [];
  for (let n = Math.max(start, end - MAX_MONTHS + 1); n <= end; n += 1) {
    out.push(`${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/** 篩選後（來源、機器）有資料的最早、最晚一天（hub 給的 ranges）。 */
export function historyRange(
  report: UsageHistoryReport,
  filter: HistoryFilter,
): { first: string; last: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const [m, s, from, to] of report.ranges) {
    if (filter.source !== 'all' && (s === 1 ? 'codex' : 'claude') !== filter.source) continue;
    if (filter.machine !== 'all' && report.machines[m]?.machineId !== filter.machine) continue;
    if (first === null || from < first) first = from;
    if (last === null || to > last) last = to;
  }
  return first === null || last === null ? null : { first, last };
}

export function historyTotals(rows: readonly Row[]): Counts {
  const sum = zeroCounts();
  for (const row of rows) add(sum, row);
  return sum;
}

/** 依機器堆疊最多幾台各一層（同每日趨勢）。 */
const MACHINE_SLOTS = 4;

/**
 * 每月趨勢（和每日趨勢同一個圖元件：`days` 放的是 `YYYY-MM`）。月份從篩選後最早有資料的月到 `thisMonth`
 * （沒資料的月份也在，值是 0）。
 */
export function monthly(
  report: UsageHistoryReport,
  rows: readonly Row[],
  stackBy: HistoryStackBy,
  measure: Measure,
  thisMonth: string,
): Daily {
  // 月份從篩選後最早有資料的月到這個月；比這個月晚的月份（不該有，hub 已擋）不畫。
  let from = thisMonth;
  for (const row of rows) {
    const month = report.months[row[1]];
    if (month !== undefined && month < from) from = month;
  }
  const months = monthsBetween(from, thisMonth);
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  let series: Series[];
  if (stackBy === 'type') {
    series = kindsOf(measure).map((k) => ({ key: k, slot: TOKEN_KINDS.indexOf(k) + 1 }));
  } else if (stackBy === 'source') {
    series = [
      { key: 'claude', slot: 1 },
      { key: 'codex', slot: 3 },
    ];
  } else {
    // 依機器：有資料的機器依回報順序前 4 台各一層，其餘併成「其他機器」。
    const used = new Set(rows.map((r) => r[0]));
    const withData = report.machines.filter((_, i) => used.has(i));
    series = withData.slice(0, MACHINE_SLOTS).map((m, i) => ({ key: m.machineId, slot: i + 1 }));
    if (withData.length > MACHINE_SLOTS) series.push({ key: 'other-machines', slot: 0 });
  }
  const seriesIndex = new Map(series.map((s, i) => [s.key, i]));
  const values = months.map(() => series.map(() => 0));
  for (const row of rows) {
    const mi = monthIndex.get(report.months[row[1]] ?? '');
    if (mi === undefined) continue;
    const counts = zeroCounts();
    add(counts, row);
    if (stackBy === 'type') {
      for (const kind of kindsOf(measure)) values[mi]![seriesIndex.get(kind)!]! += counts[kind];
    } else {
      const key = stackBy === 'source' ? sourceOf(row) : (report.machines[row[0]]?.machineId ?? '');
      const s = seriesIndex.get(key) ?? seriesIndex.get('other-machines');
      if (s !== undefined) values[mi]![s]! += measureOf(counts, measure);
    }
  }
  const max = Math.max(0, ...values.map((v) => v.reduce((a, b) => a + b, 0)));
  return { days: months, series, values, max };
}

function shares(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  labelOf: (key: string) => string,
  measure: Measure,
): Share[] {
  const sums = new Map<string, Counts>();
  for (const row of rows) {
    const key = keyOf(row);
    let c = sums.get(key);
    if (!c) {
      c = zeroCounts();
      sums.set(key, c);
    }
    add(c, row);
  }
  return [...sums]
    .map(([key, c]) => ({ key, label: labelOf(key), value: measureOf(c, measure) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export const historyByModel = (
  report: UsageHistoryReport,
  rows: readonly Row[],
  measure: Measure,
) =>
  shares(
    rows,
    (row) => `model:${row[2]}`,
    (key) => report.models[Number(key.slice(6))] ?? '',
    measure,
  );

export const historyByMachine = (
  report: UsageHistoryReport,
  rows: readonly Row[],
  measure: Measure,
) =>
  shares(
    rows,
    (row) => report.machines[row[0]]?.machineId ?? '',
    (key) => report.machines.find((m) => m.machineId === key)?.name ?? key,
    measure,
  );

export const historyBySource = (rows: readonly Row[], measure: Measure) =>
  shares(
    rows,
    (row) => `agent:${sourceOf(row)}`,
    (key) => key.slice(6),
    measure,
  );
