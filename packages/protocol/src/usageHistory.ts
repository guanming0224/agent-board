// 用量歷史（GM 2026-11-21「從始至今」）：daemon 掃機器上還在的全部對話紀錄（不限 90 天），hub 每天存一份
// 「機器 × 日期 × 來源（claude／codex）× 模型」的四種 token 數，Claude Code 清掉舊紀錄後 hub 仍留著。
// 這裡放 daemon → hub 的 `usage.history`、hub → web 的 `GET /api/usage/history`、hub 的保存規則，
// 以及把舊格式細項（90 天、含 session）壓成歷史列的換算（hub 與網頁假後端共用）。
import { z } from 'zod';
import { Id, IsoTime, type Machine } from './models';
import { UsageDay, type UsageDetail } from './usage';

/** 歷史格式版本；看不懂的版本 hub 不寫入歷史（細項照收）。 */
export const USAGE_HISTORY_VERSION = 1;
/** 一則 `usage.history` 最多幾列；放不下的下一次回報再送（先送新的日子）。 */
export const USAGE_HISTORY_ROW_LIMIT = 50_000;
/**
 * 保存規則：機器「今天」往前幾個日曆日（含今天）以最新回報為準，可以變小；更早的日子只在新值（四項合計）
 * ≥ 已存的值時才整列換掉，也就是保留「曾見過的最大值」。daemon 每次也一定重送這幾天。
 */
export const USAGE_HISTORY_RECENT_DAYS = 2;

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
  days: z.array(UsageDay).max(20_000),
  models: z.array(z.string().max(200)).max(2_000),
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
 * 保存規則（hub 的 upsert 與網頁假後端共用）：回傳要不要用新值換掉已存的值。
 * - 沒存過：寫。
 * - 日期在「最近幾天」內（`day >= recentFrom`）：一律以最新的為準（今天還在累加；去重修正、時區換了也會變小）。
 * - 更早的日子：新值的四項合計 ≥ 舊值才整列換掉（保留曾見過的最大值）。機器上的紀錄被 Claude Code 清掉後，
 *   daemon 送來的是 0 或根本沒有那一列，都不會蓋掉 hub 已存的數字。整列一起換，四個數字永遠來自同一次掃描。
 */
export function shouldReplaceHistory(
  old: UsageCounts | null,
  next: UsageCounts,
  day: string,
  recentFrom: string,
): boolean {
  if (old === null) return true;
  if (day >= recentFrom) return true;
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

/** [機器索引, 日期索引, 模型索引, 來源, 輸入, 輸出, 快取讀, 快取寫]。 */
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

export const UsageHistoryReport = z.object({
  generatedAt: IsoTime,
  /** 全部機器的日期聯集，由舊到新。 */
  days: z.array(UsageDay),
  models: z.array(z.string()),
  machines: z.array(UsageHistoryMachine),
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

export interface UsageHistoryReportInput {
  now: Date;
  machines: readonly Machine[];
  stored: readonly StoredHistoryCell[];
  storedMachines: readonly StoredHistoryMachine[];
  /** 各機器目前記憶體裡的最新掃描（壓扁後）；和歷史每格取四項合計較大者。 */
  current?: ReadonlyMap<string, readonly UsageHistoryCell[]>;
}

/**
 * 「全部」的資料：hub 歷史 ∪ 機器目前掃到的，每格（機器 × 日期 × 來源 × 模型）取四項合計較大者。
 * 機器依機器列表順序，已移除但還有歷史的排在後面（名稱排序）。
 */
export function buildUsageHistoryReport(input: UsageHistoryReportInput): UsageHistoryReport {
  const merged = new Map<string, StoredHistoryCell>();
  const put = (cell: StoredHistoryCell) => {
    const key = `${cell.machineId}\0${cell.day}\0${cell.source}\0${cell.model}`;
    const old = merged.get(key);
    if (!old || usageWeight(cell) > usageWeight(old)) merged.set(key, cell);
  };
  for (const cell of input.stored) put(cell);
  for (const [machineId, cells] of input.current ?? []) {
    for (const cell of cells) put({ ...cell, machineId });
  }

  const storedMachine = new Map(input.storedMachines.map((m) => [m.machineId, m]));
  const known = new Set(input.machines.map((m) => m.id));
  const removedIds = new Set<string>();
  for (const cell of merged.values())
    if (!known.has(cell.machineId)) removedIds.add(cell.machineId);
  const removed = [...removedIds]
    .map((id) => ({ id, name: storedMachine.get(id)?.name ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));

  const machineIndex = new Map<string, number>();
  const machines: UsageHistoryMachine[] = [];
  const range = new Map<string, { first: string; last: string }>();
  for (const cell of merged.values()) {
    if (usageWeight(cell) === 0) continue;
    const r = range.get(cell.machineId);
    if (!r) range.set(cell.machineId, { first: cell.day, last: cell.day });
    else {
      if (cell.day < r.first) r.first = cell.day;
      if (cell.day > r.last) r.last = cell.day;
    }
  }
  const pushMachine = (id: string, name: string, online: boolean, isRemoved: boolean) => {
    const meta = storedMachine.get(id);
    machineIndex.set(id, machines.length);
    machines.push({
      machineId: id,
      name,
      removed: isRemoved,
      online,
      timeZone: meta?.timeZone ?? null,
      firstDay: range.get(id)?.first ?? null,
      lastDay: range.get(id)?.last ?? null,
      updatedAt: meta?.updatedAt ?? null,
      completeAt: meta?.completeAt ?? null,
    });
  };
  for (const m of input.machines) pushMachine(m.id, m.name, m.online, false);
  for (const m of removed) pushMachine(m.id, m.name, false, true);

  const cells = [...merged.values()].filter((c) => usageWeight(c) > 0);
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const rows: UsageHistoryReportRow[] = [];
  for (const c of cells) {
    let mi = modelIndex.get(c.model);
    if (mi === undefined) {
      mi = models.length;
      models.push(c.model);
      modelIndex.set(c.model, mi);
    }
    rows.push([
      machineIndex.get(c.machineId)!,
      dayIndex.get(c.day)!,
      mi,
      c.source === 'codex' ? 1 : 0,
      c.inputTokens,
      c.outputTokens,
      c.cacheReadTokens,
      c.cacheCreationTokens,
    ]);
  }
  rows.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[3] - b[3] || a[2] - b[2]);
  return { generatedAt: input.now.toISOString(), days, models, machines, rows };
}
