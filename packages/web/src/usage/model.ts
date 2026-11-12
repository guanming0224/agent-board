// 用量詳情的計算（純函式，畫面與測試共用）。資料是 hub 的 UsageReport（GET /api/usage）。
// 日期一律是字串 `YYYY-MM-DD`：各機器用自己的時區算日期，網頁的「今天」用瀏覽器的時區（通常是同一個）。
import {
  localUsageDay,
  shiftUsageDay,
  type UsageReport,
  type UsageReportSession,
} from '@agent-board/protocol';

export type TokenKind = 'input' | 'output' | 'cacheCreation' | 'cacheRead';
/** 堆疊由下到上的順序，也是圖例順序；顏色跟著種類走，不跟排名。 */
export const TOKEN_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheCreation', 'cacheRead'];

export interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * conversation：輸入＋輸出（和頁首同一個數字；快取動輒上千萬，混進來會讓數字失去意義）。
 * all：四項合計。
 */
export type Measure = 'conversation' | 'all';

export const zeroCounts = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
export const conversation = (c: Counts) => c.input + c.output;
export const allTokens = (c: Counts) => c.input + c.output + c.cacheRead + c.cacheCreation;
export const measureOf = (c: Counts, m: Measure) => (m === 'all' ? allTokens(c) : conversation(c));
export const kindsOf = (m: Measure): readonly TokenKind[] =>
  m === 'all' ? TOKEN_KINDS : ['input', 'output'];

/** 期間：含今天往前 n 個日曆日。 */
export interface Period {
  from: string;
  to: string;
  days: number;
}

export const periodEnding = (today: string, days: number): Period => ({
  from: shiftUsageDay(today, -(days - 1)),
  to: today,
  days,
});

/** 緊接在前面、一樣長的期間。 */
export const previousPeriod = (p: Period): Period =>
  periodEnding(shiftUsageDay(p.from, -1), p.days);

export const todayOf = (now: Date) => localUsageDay(now);

type Row = UsageReport['rows'][number];

function add(target: Counts, row: Row): void {
  target.input += row[4];
  target.output += row[5];
  target.cacheRead += row[6];
  target.cacheCreation += row[7];
}

const inPeriod = (report: UsageReport, row: Row, p: Period) => {
  const day = report.days[row[1]];
  return day !== undefined && day >= p.from && day <= p.to;
};

export function totals(report: UsageReport, p: Period): Counts {
  const sum = zeroCounts();
  for (const row of report.rows) if (inPeriod(report, row, p)) add(sum, row);
  return sum;
}

/** 有細項的機器裡最晚開始有紀錄的那天：比它早的日子可能只是紀錄被 Claude Code 清掉了，不是沒用。 */
export function coverageFrom(report: UsageReport): string | null {
  let latest: string | null = null;
  for (const m of report.machines) {
    if (m.state !== 'detail') continue;
    const day = m.earliestAt ? localUsageDay(new Date(m.earliestAt)) : null;
    // 有細項卻完全沒紀錄：這台什麼都沒有，不影響別台的比較。
    if (day === null) continue;
    if (latest === null || day > latest) latest = day;
  }
  return latest;
}

export interface OverviewItem {
  days: 1 | 7 | 30;
  current: Counts;
  previous: Counts;
  /** 前一期的開頭早於某台機器最早的紀錄：比較只供參考。 */
  previousPartial: boolean;
}

export function overview(report: UsageReport, today: string): OverviewItem[] {
  const coverage = coverageFrom(report);
  return ([1, 7, 30] as const).map((days) => {
    const p = periodEnding(today, days);
    const prev = previousPeriod(p);
    return {
      days,
      current: totals(report, p),
      previous: totals(report, prev),
      previousPartial:
        (coverage !== null && coverage > prev.from) ||
        report.days.length === 0 ||
        report.days[0]! > prev.from,
    };
  });
}

/** 和前一期比：前一期是 0 時沒有百分比（null）。 */
export function change(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// ── 每日趨勢 ─────────────────────────────────────────

export type StackBy = 'type' | 'machine';

/** 依機器堆疊時最多幾台各自一層，其餘併成「其他機器」（同 dataviz：不產生第 5 個顏色）。 */
export const MACHINE_SLOTS = 4;

export interface Series {
  /** token 種類、機器 id，或 'other-machines'。 */
  key: string;
  /** 1–4：色階的第幾階；0 是「其他」（灰）。 */
  slot: number;
}

export interface Daily {
  days: string[];
  series: Series[];
  /** values[日][系列]。 */
  values: number[][];
  /** 最高那天的合計（畫 y 軸用）。 */
  max: number;
}

/** 有細項的機器依回報順序取前 4 台各一層（顏色跟著機器，不跟排名）。 */
export function machineSeries(report: UsageReport): Series[] {
  const withDetail = report.machines.filter((m) => m.state === 'detail');
  const series: Series[] = withDetail
    .slice(0, MACHINE_SLOTS)
    .map((m, i) => ({ key: m.machineId, slot: i + 1 }));
  if (withDetail.length > MACHINE_SLOTS) series.push({ key: 'other-machines', slot: 0 });
  return series;
}

export function daily(report: UsageReport, p: Period, stackBy: StackBy, measure: Measure): Daily {
  const days = Array.from({ length: p.days }, (_, i) => shiftUsageDay(p.from, i));
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const series: Series[] =
    stackBy === 'type'
      ? kindsOf(measure).map((k) => ({ key: k, slot: TOKEN_KINDS.indexOf(k) + 1 }))
      : machineSeries(report);
  const seriesIndex = new Map(series.map((s, i) => [s.key, i]));
  const values = days.map(() => series.map(() => 0));
  for (const row of report.rows) {
    const d = dayIndex.get(report.days[row[1]] ?? '');
    if (d === undefined) continue;
    const counts = zeroCounts();
    add(counts, row);
    if (stackBy === 'type') {
      for (const kind of kindsOf(measure)) values[d]![seriesIndex.get(kind)!]! += counts[kind];
    } else {
      const machineId = report.machines[row[0]]?.machineId ?? '';
      const s = seriesIndex.get(machineId) ?? seriesIndex.get('other-machines');
      if (s !== undefined) values[d]![s]! += measureOf(counts, measure);
    }
  }
  const max = Math.max(0, ...values.map((v) => v.reduce((a, b) => a + b, 0)));
  return { days, series, values, max };
}

/** y 軸刻度：1、2、5 × 10^n 的整數倍，最多 4 格。 */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

// ── 排行 ─────────────────────────────────────────────

export type RankKind = 'team' | 'session' | 'project';

/**
 * 點一列要去哪裡：看板上的 session（畫布聚焦或封存頁）、團隊（開團隊面板，畫布框住成員）。
 * 中控台外與「其他」沒有地方可去。
 */
export type RankTarget =
  | { type: 'session'; sessionId: string; archived: boolean; teamId: string | null }
  | { type: 'team'; teamId: string }
  | null;

/**
 * 列的種類決定名稱怎麼寫：board（看板上的 session／團隊／專案）、noTeam（看板上但不在團隊）、
 * outside（中控台外的 session）、other（超過上限併起來的，分不出是誰）、noCwd（沒有資料夾）。
 */
export type RankRowKind = 'board' | 'noTeam' | 'outside' | 'other' | 'noCwd';

export interface RankRow {
  key: string;
  kind: RankRowKind;
  /** 顯示名稱（session 名、團隊名、資料夾）；null 時畫面用種類的固定字。 */
  label: string | null;
  /** 第二行：資料夾或機器名。 */
  cwd: string | null;
  machines: string[];
  /** 這一列合併了幾個 Claude session。 */
  sessions: number;
  counts: Counts;
  target: RankTarget;
  archived: boolean;
}

export type SortKey = 'conversation' | TokenKind | 'all';

export const sortValue = (row: Pick<RankRow, 'counts'>, key: SortKey) =>
  key === 'conversation'
    ? conversation(row.counts)
    : key === 'all'
      ? allTokens(row.counts)
      : row.counts[key];

function sessionCounts(report: UsageReport, p: Period): Map<number, Counts> {
  const out = new Map<number, Counts>();
  for (const row of report.rows) {
    if (!inPeriod(report, row, p)) continue;
    let c = out.get(row[3]);
    if (!c) {
      c = zeroCounts();
      out.set(row[3], c);
    }
    add(c, row);
  }
  return out;
}

const machineName = (report: UsageReport, id: string) =>
  report.machines.find((m) => m.machineId === id)?.name ?? id;

function rowKindOf(s: UsageReportSession): RankRowKind {
  if (s.claudeSessionId === null) return 'other';
  return s.boardSessionId === null ? 'outside' : 'board';
}

function addCounts(target: Counts, c: Counts): void {
  target.input += c.input;
  target.output += c.output;
  target.cacheRead += c.cacheRead;
  target.cacheCreation += c.cacheCreation;
}

/** 依 key 合併；每組記下用最多的那個看板 session 當點擊目標。 */
function group(
  report: UsageReport,
  counts: Map<number, Counts>,
  keyOf: (s: UsageReportSession) => {
    key: string;
    kind: RankRowKind;
    label: string | null;
    cwd: string | null;
    team?: string | null;
  },
): RankRow[] {
  const rows = new Map<string, RankRow & { best: number }>();
  for (const [index, c] of counts) {
    const s = report.sessions[index];
    if (!s) continue;
    const k = keyOf(s);
    let row = rows.get(k.key);
    if (!row) {
      row = {
        key: k.key,
        kind: k.kind,
        label: k.label,
        cwd: k.cwd,
        machines: [],
        sessions: 0,
        counts: zeroCounts(),
        target: k.team ? { type: 'team', teamId: k.team } : null,
        archived: false,
        best: -1,
      };
      rows.set(k.key, row);
    }
    addCounts(row.counts, c);
    row.sessions += 1;
    const name = machineName(report, s.machineId);
    if (!row.machines.includes(name)) row.machines.push(name);
    if (!k.team && s.boardSessionId !== null && conversation(c) > row.best) {
      row.best = conversation(c);
      row.target = {
        type: 'session',
        sessionId: s.boardSessionId,
        archived: s.archived,
        teamId: s.teamId,
      };
    }
  }
  return [...rows.values()].map(({ best: _best, ...row }) => row);
}

export function ranking(report: UsageReport, p: Period, kind: RankKind): RankRow[] {
  const counts = sessionCounts(report, p);
  if (kind === 'session') {
    return [...counts].flatMap(([index, c]) => {
      const s = report.sessions[index];
      if (!s) return [];
      const rowKind = rowKindOf(s);
      return [
        {
          key: `${s.machineId}:${s.claudeSessionId ?? 'other'}`,
          kind: rowKind,
          label: s.name,
          cwd: s.cwd,
          machines: [machineName(report, s.machineId)],
          sessions: 1,
          counts: c,
          target:
            s.boardSessionId === null
              ? null
              : {
                  type: 'session' as const,
                  sessionId: s.boardSessionId,
                  archived: s.archived,
                  teamId: s.teamId,
                },
          archived: s.archived,
        },
      ];
    });
  }
  if (kind === 'team') {
    return group(report, counts, (s) => {
      const k = rowKindOf(s);
      if (k !== 'board') return { key: `:${k}`, kind: k, label: null, cwd: null };
      if (s.teamId === null) return { key: ':noTeam', kind: 'noTeam', label: null, cwd: null };
      return {
        key: `team:${s.teamId}`,
        kind: 'board',
        label: s.teamName,
        cwd: null,
        team: s.teamId,
      };
    });
  }
  return group(report, counts, (s) => {
    if (s.claudeSessionId === null) return { key: ':other', kind: 'other', label: null, cwd: null };
    if (s.cwd === null) return { key: ':noCwd', kind: 'noCwd', label: null, cwd: null };
    return { key: `cwd:${s.cwd}`, kind: 'board', label: s.cwd, cwd: s.cwd };
  });
}

export function sortRows(rows: readonly RankRow[], key: SortKey, desc: boolean): RankRow[] {
  return [...rows].sort((a, b) => {
    const diff = sortValue(a, key) - sortValue(b, key);
    return (desc ? -diff : diff) || a.key.localeCompare(b.key);
  });
}

// ── 分布 ─────────────────────────────────────────────

export interface Share {
  key: string;
  /** 模型 id（空字串是沒寫模型）或機器名。 */
  label: string;
  value: number;
}

export function byModel(report: UsageReport, p: Period, measure: Measure): Share[] {
  const sums = new Map<number, Counts>();
  for (const row of report.rows) {
    if (!inPeriod(report, row, p)) continue;
    let c = sums.get(row[2]);
    if (!c) {
      c = zeroCounts();
      sums.set(row[2], c);
    }
    add(c, row);
  }
  return [...sums]
    .map(([i, c]) => ({
      key: `model:${i}`,
      label: report.models[i] ?? '',
      value: measureOf(c, measure),
    }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export function byMachine(report: UsageReport, p: Period, measure: Measure): Share[] {
  const sums = report.machines.map(() => zeroCounts());
  for (const row of report.rows) if (inPeriod(report, row, p)) add(sums[row[0]]!, row);
  return report.machines
    .map((m, i) => ({ key: m.machineId, label: m.name, value: measureOf(sums[i]!, measure) }))
    .filter((_, i) => report.machines[i]!.state === 'detail')
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

// ── 代理（Claude／Codex，Codex 第二輪）──────────────────

/** all：Claude 與 Codex 合計；claude／codex：只看一邊。 */
export type AgentFilter = 'all' | 'claude' | 'codex';

const agentOfRow = (report: UsageReport, row: Row) => report.sessions[row[3]]?.agent ?? 'claude';

/** 有沒有 Codex 的用量（沒有就不顯示代理切換）。 */
export const hasCodexUsage = (report: UsageReport): boolean =>
  report.sessions.some((s) => s.agent === 'codex') ||
  report.machines.some((m) => m.codexSummary !== null);

/** 只留某個代理的列；其餘欄位（日期、機器、session 表）不動，索引照舊有效。 */
export function filterByAgent(report: UsageReport, agent: AgentFilter): UsageReport {
  if (agent === 'all') return report;
  return { ...report, rows: report.rows.filter((row) => agentOfRow(report, row) === agent) };
}

export function byAgent(report: UsageReport, p: Period, measure: Measure): Share[] {
  const sums = new Map<string, Counts>();
  for (const row of report.rows) {
    if (!inPeriod(report, row, p)) continue;
    const agent = agentOfRow(report, row);
    let c = sums.get(agent);
    if (!c) {
      c = zeroCounts();
      sums.set(agent, c);
    }
    add(c, row);
  }
  return [...sums]
    .map(([agent, c]) => ({ key: `agent:${agent}`, label: agent, value: measureOf(c, measure) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

/** 資料夾太長時只留最後兩層（完整路徑放提示框）。 */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}
