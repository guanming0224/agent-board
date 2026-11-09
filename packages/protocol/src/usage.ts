// 用量細項（GM 2026-11-09「用量詳情」）。daemon 掃本機 Claude Code 對話紀錄時，除了近 30 天總數
// （`UsageSummary`）再彙總「每日 × 模型 × Claude session」的四種 token 數。這不是官方方案額度。
// 大小靠字典編碼與上限控制：日期、模型、session 各一張表，每列只放索引與四個數字。
// 全部欄位都是選用的延伸：舊 daemon 不送 `detail`，hub 與畫面照常顯示總數。
import { z } from 'zod';
import { Id, IsoTime, UsageSummary } from './models';

/**
 * 細項保留幾個日曆日（含今天）。至少 60 天才能拿「近 30 天」和前 30 天比；90 天讓趨勢圖可切 90 天。
 * 掃描本來就要讀近 30 天內改過的檔，多留到 90 天幾乎不多讀（2026-11-09 實測：同一份資料 1.7–2.5 秒、
 * 訊息約 21 KB，和只算總數的舊版差不多）。Claude Code 預設只留 30 天對話紀錄，更早的日子多半沒資料，
 * 所以另外回報 `earliestAt`。
 */
export const USAGE_DETAIL_DAYS = 90;
/** 每台機器最多送幾個 Claude session；其餘併成「其他」（索引 -1），總數不變。 */
export const USAGE_DETAIL_SESSION_LIMIT = 200;
/** 每台機器最多幾列；超過時 daemon 會再少留一些 session，直到放得下。 */
export const USAGE_DETAIL_ROW_LIMIT = 20_000;
/** 細項格式版本；之後改格式時遞增，看不懂的版本 hub 當沒有細項。 */
export const USAGE_DETAIL_VERSION = 1;

/** 本地時區的日期 `YYYY-MM-DD`（daemon 那台機器的時區）。 */
export const UsageDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type UsageDay = z.infer<typeof UsageDay>;

const Tokens = z.number().int().nonnegative();
/** -1 表示「其他」：超過上限、或認不出 session id 的併在這裡。 */
const SessionIndex = z.number().int().min(-1);
const Index = z.number().int().nonnegative();

/** daemon 回報的一列：[日期索引, 模型索引, session 索引, 輸入, 輸出, 快取讀, 快取寫]。 */
export const UsageDetailRow = z.tuple([Index, Index, SessionIndex, Tokens, Tokens, Tokens, Tokens]);
export type UsageDetailRow = z.infer<typeof UsageDetailRow>;

export const UsageDetailSession = z.object({
  /** Claude Code 的 session id（JSONL 的 `sessionId`）。 */
  id: z.string().min(1).max(200),
  /** 對話紀錄裡第一個看到的工作資料夾；沒有就是 null。 */
  cwd: z.string().max(4096).nullable(),
});
export type UsageDetailSession = z.infer<typeof UsageDetailSession>;

export const UsageDetail = z.object({
  version: z.number().int().positive(),
  /** 日期用哪個時區算（IANA 名稱，例如 Asia/Taipei）。 */
  timeZone: z.string().max(100),
  /** 統計的日期，由舊到新，最後一個是 daemon 那邊的今天；沒有用量的日子也在。 */
  days: z.array(UsageDay).max(400),
  /** 模型 id；對話紀錄沒寫模型的是空字串。 */
  models: z.array(z.string().max(200)).max(500),
  sessions: z.array(UsageDetailSession).max(USAGE_DETAIL_SESSION_LIMIT),
  /** 併進「其他」的 session 數。 */
  otherSessions: z.number().int().nonnegative(),
  /** 掃到的最早一筆用量時間；Claude Code 預設只留 30 天的對話紀錄，比這更早的日子不是 0 而是沒資料。 */
  earliestAt: IsoTime.nullable(),
  rows: z.array(UsageDetailRow).max(USAGE_DETAIL_ROW_LIMIT),
});
export type UsageDetail = z.infer<typeof UsageDetail>;

// ── hub → web：跨機器彙整（GET /api/usage） ─────────────────

/**
 * detail：有細項。old_daemon：有總數但沒細項（daemon 版本太舊）。not_reported：還沒回報過。
 */
export const UsageMachineState = z.enum(['detail', 'old_daemon', 'not_reported']);
export type UsageMachineState = z.infer<typeof UsageMachineState>;

export const UsageReportMachine = z.object({
  machineId: Id,
  name: z.string(),
  online: z.boolean(),
  state: UsageMachineState,
  /** 近 30 天總數（和頁首同一份）；沒回報是 null。 */
  summary: UsageSummary.nullable(),
  /** 細項的統計時間（掃描完成的時間）；沒細項是 null。 */
  countedAt: IsoTime.nullable(),
  /** hub 重啟後還沒收到新的掃描，這份是上次存下來的。 */
  restored: z.boolean(),
  timeZone: z.string().nullable(),
  earliestAt: IsoTime.nullable(),
  otherSessions: z.number().int().nonnegative(),
});
export type UsageReportMachine = z.infer<typeof UsageReportMachine>;

export const UsageReportSession = z.object({
  machineId: Id,
  /** null：這台機器的「其他」（超過上限併起來的 session）。 */
  claudeSessionId: z.string().nullable(),
  cwd: z.string().nullable(),
  /** 對得到 Agent Board 的 session 才有；null 表示「中控台外的 session」（在外面直接開的 claude）。 */
  boardSessionId: Id.nullable(),
  name: z.string().nullable(),
  archived: z.boolean(),
  teamId: Id.nullable(),
  teamName: z.string().nullable(),
  zoneId: Id.nullable(),
  zoneName: z.string().nullable(),
  projectId: Id.nullable(),
  projectName: z.string().nullable(),
});
export type UsageReportSession = z.infer<typeof UsageReportSession>;

/** [機器索引, 日期索引, 模型索引, session 索引, 輸入, 輸出, 快取讀, 快取寫]。session 索引指向 `sessions`。 */
export const UsageReportRow = z.tuple([Index, Index, Index, Index, Tokens, Tokens, Tokens, Tokens]);
export type UsageReportRow = z.infer<typeof UsageReportRow>;

export const UsageReport = z.object({
  generatedAt: IsoTime,
  /** 所有機器的日期聯集，由舊到新。 */
  days: z.array(UsageDay),
  models: z.array(z.string()),
  machines: z.array(UsageReportMachine),
  sessions: z.array(UsageReportSession),
  rows: z.array(UsageReportRow),
});
export type UsageReport = z.infer<typeof UsageReport>;

const DAY_MS = 24 * 60 * 60_000;

/** `YYYY-MM-DD` 往前（負）或往後推 n 天：純日曆運算，和時區無關。 */
export function shiftUsageDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 執行環境本地時區的日期 `YYYY-MM-DD`（網頁的「今天」）。 */
export function localUsageDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
