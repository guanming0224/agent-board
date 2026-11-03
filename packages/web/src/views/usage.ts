// 用量：daemon 讀本機 Claude Code 對話紀錄算 token（DISPATCH §5.1），hub 只在記憶體留每台最新一筆。
// 這不是官方方案額度，也沒有上限可比，所以畫面只寫 token 數，不畫百分比條、不上色。
// 這個檔只放純函式；定期向 hub 要資料的 hook 在 usageStore.ts。
import type { UsageSummary } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';

/** daemon 每 15 分回報一次，hub 不會推給網頁；每分鐘問一次，hub 只讀記憶體，很便宜。 */
export const USAGE_REFRESH_MS = 60_000;

const DAY_MS = 24 * 60 * 60_000;

export interface UsageState {
  /** 機器 id → 最新一筆；null 表示 hub 還沒收到這台的回報。 */
  byMachine: Record<string, UsageSummary | null>;
  /** 至少問完一輪。 */
  loaded: boolean;
  /** 上一輪每台都問不到（例如 hub 斷線）；舊資料照留。 */
  failed: boolean;
}

/** 逐台問；單台失敗時沿用上一輪的值，不把已知的數字變成「沒資料」。 */
export async function fetchUsage(
  backend: Pick<BoardBackend, 'machineUsage'>,
  machineIds: readonly string[],
  previous: Record<string, UsageSummary | null>,
): Promise<Pick<UsageState, 'byMachine' | 'failed'>> {
  const results = await Promise.allSettled(machineIds.map((id) => backend.machineUsage(id)));
  const byMachine: Record<string, UsageSummary | null> = {};
  let failures = 0;
  results.forEach((result, i) => {
    const id = machineIds[i]!;
    if (result.status === 'fulfilled') byMachine[id] = result.value;
    else {
      failures += 1;
      if (id in previous) byMachine[id] = previous[id]!;
    }
  });
  return { byMachine, failed: machineIds.length > 0 && failures === machineIds.length };
}

/** 主數字只算輸入＋輸出；快取讀取動輒上千萬，混進來會讓數字失去意義，另外列。 */
export const conversationTokens = (s: UsageSummary) => s.inputTokens + s.outputTokens;
export const cacheTokens = (s: UsageSummary) => s.cacheReadTokens + s.cacheCreationTokens;

/** 統計區間的天數（daemon 目前是 30 天）；不寫死，以回報內容為準。 */
export const windowDays = (s: UsageSummary) =>
  Math.max(1, Math.round((Date.parse(s.to) - Date.parse(s.from)) / DAY_MS));

export interface UsageTotals {
  tokens: number;
  cacheTokens: number;
  /** 有回報的機器數。 */
  machines: number;
  days: number;
}

/** 頁首的合計。沒有任何一台回報過時是 null，畫面寫「—」，不寫 0。 */
export function usageTotals(
  summaries: readonly (UsageSummary | null | undefined)[],
): UsageTotals | null {
  const known = summaries.filter((s): s is UsageSummary => s != null);
  if (known.length === 0) return null;
  return {
    tokens: known.reduce((sum, s) => sum + conversationTokens(s), 0),
    cacheTokens: known.reduce((sum, s) => sum + cacheTokens(s), 0),
    machines: known.length,
    days: Math.max(...known.map(windowDays)),
  };
}

/** 1.2M、120 萬這類精簡寫法；完整數字放提示框。 */
export const formatTokens = (n: number, locale: string) =>
  new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const formatTokensFull = (n: number, locale: string) =>
  new Intl.NumberFormat(locale).format(n);
