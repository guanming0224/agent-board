// 用量歷史（GM 2026-11-21「從始至今」）：daemon 掃機器上還在的全部對話紀錄（不限 90 天），hub 每天存一份
// 「機器 × 日期 × 來源（claude／codex）× 模型」的四種 token 數，Claude Code 清掉舊紀錄後 hub 仍留著。
// 這裡放 daemon → hub 的 `usage.history`、hub → web 的 `GET /api/usage/history`、hub 的保存規則，
// 以及把舊格式細項（90 天、含 session）壓成歷史列的換算（hub 與網頁假後端共用）。
import { z } from 'zod';
import { Id, IsoTime, type Machine } from './models';
import { shiftUsageDay, UsageDay, type UsageDetail } from './usage';

/** 歷史格式版本；看不懂的版本 hub 不寫入歷史（細項照收）。 */
export const USAGE_HISTORY_VERSION = 1;
/** 一則 `usage.history` 最多幾列；放不下的下一次回報再送（先送新的日子）。 */
export const USAGE_HISTORY_ROW_LIMIT = 50_000;
/**
 * 保存規則：機器「今天」往前幾個日曆日（含今天）以最新回報為準，可以變小；更早的日子只在新值（四項合計）
 * ≥ 已存的值時才整列換掉，也就是保留「曾見過的最大值」。daemon 每次也一定重送這幾天。
 */
export const USAGE_HISTORY_RECENT_DAYS = 2;
/** 一則 `usage.history` 最多幾個模型名稱。 */
export const USAGE_HISTORY_MODEL_LIMIT = 200;
/** 比這更早的日子 hub 不收（Claude Code 與 Codex 都還沒出來；擋時鐘壞掉或亂送的 daemon）。 */
export const USAGE_HISTORY_MIN_DAY = '2020-01-01';
/** 每台機器在 hub 最多存幾列；超過時只更新已有的列、不再新增（記 warn）。 */
export const USAGE_HISTORY_MACHINE_ROW_LIMIT = 200_000;

/** hub 自己的「今天」（UTC 日期）。 */
export const utcUsageDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * daemon 說的「今天」可不可信：各時區（UTC−12～+14）的今天一定落在 UTC 今天的前後一天內，
 * 超出就當 null（hub 不允許任何日子變小）。擋時鐘落後／超前或亂送的 daemon 把舊日子都變成「最近」。
 */
export function trustedHistoryToday(today: string | null, hubToday: string): string | null {
  if (today === null || !UsageDay.safeParse(today).success) return null;
  return today >= shiftUsageDay(hubToday, -1) && today <= shiftUsageDay(hubToday, 1) ? today : null;
}

/** hub 收不收這一天：USAGE_HISTORY_MIN_DAY 以後、不晚於 hub 的明天（未來的日子丟掉）。 */
export const historyDayAllowed = (day: string, hubToday: string): boolean =>
  day >= USAGE_HISTORY_MIN_DAY && day <= shiftUsageDay(hubToday, 1);

/** 「最近幾天」的起點；today 是 null 時沒有最近（回傳 null）。 */
export const historyRecentFrom = (today: string | null): string | null =>
  today === null ? null : shiftUsageDay(today, -(USAGE_HISTORY_RECENT_DAYS - 1));

/** 0：Claude Code；1：Codex。 */
export const UsageSourceIndex = z.union([z.literal(0), z.literal(1)]);
export type UsageSourceIndex = z.infer<typeof UsageSourceIndex>;
export const USAGE_SOURCES = ['claude', 'codex'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

const Tokens = z.number().int().nonnegative();
const Index = z.number().int().nonnegative();

/** daemon 送的一列：[日期索引, 模型索引, 來源, 輸入, 輸出, 快取讀, 快取寫]。 */
export const UsageHistoryRow = z.tuple([
  Index,
  Index,
  UsageSourceIndex,
  Tokens,
  Tokens,
  Tokens,
  Tokens,
]);
export type UsageHistoryRow = z.infer<typeof UsageHistoryRow>;

/**
 * daemon → hub（`usage` 訊息的選用欄位 `history`）。日期是這台機器時區的日曆日。
 * complete：這則含機器上目前掃得到的全部日子（連上 hub 後第一次送＝回填）；false 時只有最近幾天與有變動的日子。
 */
export const UsageHistory = z.object({
  version: z.number().int().positive(),
  timeZone: z.string().max(100),
  /** daemon 那邊的今天（hub 依它判斷「最近幾天」）。 */
  today: UsageDay,
  complete: z.boolean(),
  /** 這則的編號（新 daemon 才帶）：hub 寫入成功後回 `usage.historyAck`，daemon 收到才記成「送過」。 */
  id: z.string().min(1).max(64).optional(),
  days: z.array(UsageDay).max(20_000),
  models: z.array(z.string().max(200)).max(USAGE_HISTORY_MODEL_LIMIT),
  rows: z.array(UsageHistoryRow).max(USAGE_HISTORY_ROW_LIMIT),
});
export type UsageHistory = z.infer<typeof UsageHistory>;

/** 一格的四種 token。 */
export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const usageWeight = (c: UsageCounts): number =>
  c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens;

/**
 * 保存規則（hub 的 upsert 與測試共用）：回傳要不要用新值換掉已存的值。
 * - 沒存過：寫。
 * - 日期在「最近幾天」內（`recentFrom <= day <= today`，today 是 hub 驗過的 daemon 今天）：一律以最新的為準
 *   （今天還在累加；去重修正、時區換了也會變小）。today 不可信（null）時沒有「最近」。
 * - 其他日子：新值的四項合計 ≥ 舊值才整列換掉（保留曾見過的最大值）。機器上的紀錄被 Claude Code 清掉後，
 *   daemon 送來的是 0 或根本沒有那一列，都不會蓋掉 hub 已存的數字。整列一起換，四個數字永遠來自同一次掃描。
 * - force（換了時區後的完整回填）：不比大小。
 */
export function shouldReplaceHistory(
  old: UsageCounts | null,
  next: UsageCounts,
  day: string,
  today: string | null,
  force = false,
): boolean {
  if (old === null || force) return true;
  const recentFrom = historyRecentFrom(today);
  if (recentFrom !== null && today !== null && day >= recentFrom && day <= today) return true;
  return usageWeight(next) >= usageWeight(old);
}

/** 一列「日期 × 來源 × 模型」的四種 token（壓扁後的歷史）。 */
export interface UsageHistoryCell extends UsageCounts {
  day: string;
  source: UsageSource;
  model: string;
}

/** 舊格式細項（含 session）壓成「日期 × 模型」：舊 daemon 只送 90 天細項時，hub 用它寫歷史。 */
export function detailToHistoryCells(detail: UsageDetail, source: UsageSource): UsageHistoryCell[] {
  const cells = new Map<string, UsageHistoryCell>();
  for (const [d, m, , i, o, r, w] of detail.rows) {
    const day = detail.days[d];
    const model = detail.models[m];
    if (day === undefined || model === undefined) continue;
    const key = `${day}\0${model}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        day,
        source,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      cells.set(key, cell);
    }
    cell.inputTokens += i;
    cell.outputTokens += o;
    cell.cacheReadTokens += r;
    cell.cacheCreationTokens += w;
  }
  return [...cells.values()];
}

/** `usage.history` 的列展開成 cell（索引壞掉的略過）。 */
export function historyToCells(history: UsageHistory): UsageHistoryCell[] {
  const out: UsageHistoryCell[] = [];
  for (const [d, m, s, i, o, r, w] of history.rows) {
    const day = history.days[d];
    const model = history.models[m];
    if (day === undefined || model === undefined) continue;
    out.push({
      day,
      source: USAGE_SOURCES[s],
      model,
      inputTokens: i,
      outputTokens: o,
      cacheReadTokens: r,
      cacheCreationTokens: w,
    });
  }
  return out;
}

// ── hub → web：GET /api/usage/history ─────────────────

export const UsageHistoryMachine = z.object({
  machineId: Id,
  /** 機器被移除後用 hub 最後記下的名稱。 */
  name: z.string(),
  /** 機器已從 hub 移除，只剩歷史。 */
  removed: z.boolean(),
  online: z.boolean(),
  timeZone: z.string().nullable(),
  /** hub 保存的最早、最晚一天（各來源合起來）；沒有資料是 null。 */
  firstDay: UsageDay.nullable(),
  lastDay: UsageDay.nullable(),
  /** 最後一次寫入歷史的時間。 */
  updatedAt: IsoTime.nullable(),
  /** 最後一次收到「機器上全部日子」（回填）的時間；null：daemon 太舊只送 90 天，或還沒送過。 */
  completeAt: IsoTime.nullable(),
});
export type UsageHistoryMachine = z.infer<typeof UsageHistoryMachine>;

/** `YYYY-MM`。 */
export const UsageMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** [機器索引, 月份索引, 模型索引, 來源, 輸入, 輸出, 快取讀, 快取寫]：「全部」本來就以月為單位，hub 先加好。 */
export const UsageHistoryReportRow = z.tuple([
  Index,
  Index,
  Index,
  UsageSourceIndex,
  Tokens,
  Tokens,
  Tokens,
  Tokens,
]);
export type UsageHistoryReportRow = z.infer<typeof UsageHistoryReportRow>;

/** [機器索引, 來源, 最早一天, 最晚一天]：每台每個來源有用量的日期範圍（篩選後顯示「資料範圍」用）。 */
export const UsageHistoryRange = z.tuple([Index, UsageSourceIndex, UsageDay, UsageDay]);
export type UsageHistoryRange = z.infer<typeof UsageHistoryRange>;

export const UsageHistoryReport = z.object({
  generatedAt: IsoTime,
  /** 有資料的月份，由舊到新。 */
  months: z.array(UsageMonth),
  models: z.array(z.string()),
  machines: z.array(UsageHistoryMachine),
  ranges: z.array(UsageHistoryRange),
  rows: z.array(UsageHistoryReportRow),
});
export type UsageHistoryReport = z.infer<typeof UsageHistoryReport>;

/** hub 存的每台機器資訊（`usage_history_machines`）。 */
export interface StoredHistoryMachine {
  machineId: string;
  name: string;
  timeZone: string | null;
  updatedAt: string;
  completeAt: string | null;
}

/** hub 存的一列（`usage_history`）。 */
export interface StoredHistoryCell extends UsageHistoryCell {
  machineId: string;
}

/** hub 在 SQL 端先加好的一個月（`month` 是 `YYYY-MM`）。 */
export interface StoredHistoryMonth extends UsageCounts {
  machineId: string;
  month: string;
  source: UsageSource;
  model: string;
}

/** 每台每個來源有用量的最早、最晚一天。 */
export interface StoredHistoryRange {
  machineId: string;
  source: UsageSource;
  first: string;
  last: string;
}

export interface UsageHistoryReportInput {
  now: Date;
  machines: readonly Machine[];
  storedMachines: readonly StoredHistoryMachine[];
  /** SQL 端已按月加好的部分（比 `daily` 早的日子）。 */
  monthly?: readonly StoredHistoryMonth[];
  /** 逐日的部分（和 `current` 重疊的最近日子；網頁假後端直接給全部）。 */
  daily: readonly StoredHistoryCell[];
  /** SQL 算好的日期範圍（含 monthly 那段）。 */
  ranges?: readonly StoredHistoryRange[];
  /** 各機器目前記憶體裡的最新掃描（壓扁後）；和 `daily` 每格取四項合計較大者。 */
  current?: ReadonlyMap<string, readonly UsageHistoryCell[]>;
}

/**
 * 「全部」的資料：hub 歷史 ∪ 機器目前掃到的，每格（機器 × 日期 × 來源 × 模型）取四項合計較大者，再按月加總。
 * 日期一律過 `historyDayAllowed`（hub 的時鐘）：未來、太舊的不算。
 * 機器依機器列表順序，已移除但還有歷史的排在後面（名稱排序）。
 */
export function buildUsageHistoryReport(input: UsageHistoryReportInput): UsageHistoryReport {
  const hubToday = utcUsageDay(input.now);
  const merged = new Map<string, StoredHistoryCell>();
  const put = (cell: StoredHistoryCell) => {
    if (!historyDayAllowed(cell.day, hubToday) || usageWeight(cell) === 0) return;
    const key = `${cell.machineId}\0${cell.day}\0${cell.source}\0${cell.model}`;
    const old = merged.get(key);
    if (!old || usageWeight(cell) > usageWeight(old)) merged.set(key, cell);
  };
  for (const cell of input.daily) put(cell);
  for (const [machineId, cells] of input.current ?? []) {
    for (const cell of cells) put({ ...cell, machineId });
  }

  // 按月加總：SQL 端的月份＋逐日合併後的部分。
  const months = new Map<string, StoredHistoryMonth>();
  const addMonth = (m: StoredHistoryMonth) => {
    const key = `${m.machineId}\0${m.month}\0${m.source}\0${m.model}`;
    const old = months.get(key);
    if (!old) {
      months.set(key, { ...m });
      return;
    }
    old.inputTokens += m.inputTokens;
    old.outputTokens += m.outputTokens;
    old.cacheReadTokens += m.cacheReadTokens;
    old.cacheCreationTokens += m.cacheCreationTokens;
  };
  const maxMonth = shiftUsageDay(hubToday, 1).slice(0, 7);
  const minMonth = USAGE_HISTORY_MIN_DAY.slice(0, 7);
  for (const m of input.monthly ?? []) {
    if (m.month < minMonth || m.month > maxMonth || usageWeight(m) === 0) continue;
    addMonth(m);
  }
  for (const c of merged.values()) {
    addMonth({
      machineId: c.machineId,
      month: c.day.slice(0, 7),
      source: c.source,
      model: c.model,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cacheReadTokens: c.cacheReadTokens,
      cacheCreationTokens: c.cacheCreationTokens,
    });
  }

  // 日期範圍：SQL 給的＋逐日的（夾在 hub 收得下的範圍內）。
  const lastAllowed = shiftUsageDay(hubToday, 1);
  const rangeOf = new Map<string, StoredHistoryRange>();
  const widen = (r: StoredHistoryRange) => {
    const first = r.first < USAGE_HISTORY_MIN_DAY ? USAGE_HISTORY_MIN_DAY : r.first;
    const last = r.last > lastAllowed ? lastAllowed : r.last;
    if (first > last || first > lastAllowed || last < USAGE_HISTORY_MIN_DAY) return;
    const key = `${r.machineId}\0${r.source}`;
    const old = rangeOf.get(key);
    if (!old) rangeOf.set(key, { ...r, first, last });
    else {
      if (first < old.first) old.first = first;
      if (last > old.last) old.last = last;
    }
  };
  for (const r of input.ranges ?? []) widen(r);
  for (const c of merged.values()) {
    widen({ machineId: c.machineId, source: c.source, first: c.day, last: c.day });
  }

  const storedMachine = new Map(input.storedMachines.map((m) => [m.machineId, m]));
  const known = new Set(input.machines.map((m) => m.id));
  const removedIds = new Set<string>();
  for (const m of months.values()) if (!known.has(m.machineId)) removedIds.add(m.machineId);
  const removed = [...removedIds]
    .map((id) => ({ id, name: storedMachine.get(id)?.name ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));

  const machineIndex = new Map<string, number>();
  const machines: UsageHistoryMachine[] = [];
  const pushMachine = (id: string, name: string, online: boolean, isRemoved: boolean) => {
    const meta = storedMachine.get(id);
    const own = [...rangeOf.values()].filter((r) => r.machineId === id);
    machineIndex.set(id, machines.length);
    machines.push({
      machineId: id,
      name,
      removed: isRemoved,
      online,
      timeZone: meta?.timeZone ?? null,
      firstDay: own.length === 0 ? null : own.map((r) => r.first).sort()[0]!,
      lastDay: own.length === 0 ? null : own.map((r) => r.last).sort().at(-1)!,
      updatedAt: meta?.updatedAt ?? null,
      completeAt: meta?.completeAt ?? null,
    });
  };
  for (const m of input.machines) pushMachine(m.id, m.name, m.online, false);
  for (const m of removed) pushMachine(m.id, m.name, false, true);

  const monthList = [...new Set([...months.values()].map((m) => m.month))].sort();
  const monthIndex = new Map(monthList.map((m, i) => [m, i]));
  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const rows: UsageHistoryReportRow[] = [];
  for (const m of months.values()) {
    const machine = machineIndex.get(m.machineId);
    if (machine === undefined) continue;
    let mi = modelIndex.get(m.model);
    if (mi === undefined) {
      mi = models.length;
      models.push(m.model);
      modelIndex.set(m.model, mi);
    }
    rows.push([
      machine,
      monthIndex.get(m.month)!,
      mi,
      m.source === 'codex' ? 1 : 0,
      m.inputTokens,
      m.outputTokens,
      m.cacheReadTokens,
      m.cacheCreationTokens,
    ]);
  }
  rows.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[3] - b[3] || a[2] - b[2]);
  const ranges: UsageHistoryRange[] = [];
  for (const r of rangeOf.values()) {
    const machine = machineIndex.get(r.machineId);
    if (machine !== undefined) {
      ranges.push([machine, r.source === 'codex' ? 1 : 0, r.first, r.last]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    generatedAt: input.now.toISOString(),
    months: monthList,
    models,
    machines,
    ranges,
    rows,
  };
}
