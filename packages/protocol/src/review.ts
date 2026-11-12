// 交叉審查（Codex 第二輪，GM 2026-11-12，docs/codex-round2-spec.md §2）：把一份 diff 同時交給 Claude 與 Codex
// 各審一次，結果並排給 GM 看。只在 GM 按確認、或隊長呼叫 `request_review` 時才跑（no-llm 界線：
// docs/no-llm-review.md「交叉審查」）；daemon 在那台機器上開使用者自己登入的官方 CLI（`claude -p`、`codex exec`），
// 吃使用者自己的訂閱額度，中控台不呼叫任何模型 API。
import { z } from 'zod';
import { AgentKind, Id, IsoTime } from './models';

/** 固定審查指示的版本：改文字就加一（結果記下用的是哪一版）。 */
export const REVIEW_INSTRUCTIONS_VERSION = 1;

/**
 * 固定的審查指示（給模型看，英文；要求用繁體中文回答，給 GM 看）。不要求特定 JSON：
 * 某一家的格式不穩時整份才不會失敗（spec §2-2）。daemon 把它和 diff 接成 prompt，經 stdin 交給 CLI。
 */
export const REVIEW_INSTRUCTIONS = [
  'You are reviewing a code change. You are read-only: do not modify any file, do not run commands that change state.',
  'You may read files in the current repository for context.',
  'The change is given below as a unified diff, plus the full content of new untracked files. Parts marked as truncated were cut for size.',
  'Write your review in Traditional Chinese (zh-TW), in plain text, with exactly these three sections:',
  '1. 嚴重問題 (serious problems): bugs, security issues, data loss, broken behaviour. Cite file and line. Write "無" if none.',
  '2. 建議 (suggestions): smaller improvements, missing tests, readability. Keep it short.',
  '3. 整體結論 (verdict): one or two sentences: is this change safe to merge as is?',
  'Do not repeat the diff. Do not invent files that are not in the diff or the repository.',
].join('\n');

/** 單檔 diff（或未追蹤檔內容）超過就截斷並標明。 */
export const REVIEW_FILE_MAX_BYTES = 200 * 1024;
/** 整份 diff 的上限；超過的檔案只列名稱、不送內容。 */
export const REVIEW_TOTAL_MAX_BYTES = 1024 * 1024;
/** 每一邊最多跑多久；到了就結束那一邊並標記逾時（另一邊不受影響）。 */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
/** 每一邊的結果文字最多存多少字元。 */
export const REVIEW_OUTPUT_MAX_CHARS = 60_000;
export const REVIEW_REASON_MAX = 200;
/** board 快照帶最近幾筆審查（收件匣、面板用；更舊的用 REST 讀）。 */
export const REVIEW_BOARD_KEEP = 50;
/** 準備好、還沒確認的 diff 在 daemon 記憶體裡留多久。 */
export const REVIEW_PREPARED_TTL_MS = 30 * 60_000;

/** 分支名稱（branch、base）：git 的 ref，不能以 - 開頭（不會被當成 git 參數），不能有空白與 `..`。 */
export const ReviewRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!-)[A-Za-z0-9._/@^~+-]+$/)
  .refine((ref) => !ref.includes('..'), 'ref must not contain ..');

/** 絕對路徑（POSIX `/…`、Windows `C:\…`、UNC `\\…`）；protocol 不能用 node:path，自己判斷（審查 W1）。 */
export const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

/** 要審的東西。session：那個 session 的工作資料夾裡還沒 commit 的變更；branch：repo 的分支相對 base。 */
export const ReviewTargetInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: Id }),
  z.object({
    kind: z.literal('branch'),
    machineId: Id,
    repoPath: z.string().min(1).max(4096).refine(isAbsolutePath, 'repoPath must be absolute'),
    branch: ReviewRef,
    base: ReviewRef.default('main'),
  }),
]);
export type ReviewTargetInput = z.infer<typeof ReviewTargetInput>;

/** hub 存的對象（含給人看的描述）。 */
export const ReviewTarget = z.object({
  kind: z.enum(['session', 'branch']),
  /** 例如「BD1 的未 commit 變更」或「repo:feature/x（相對 main）」。 */
  label: z.string(),
  sessionId: Id.nullable(),
  /** daemon 跑 git 與 CLI 的資料夾。 */
  cwd: z.string(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
});
export type ReviewTarget = z.infer<typeof ReviewTarget>;

export const ReviewFileStatus = z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked']);
export const ReviewFile = z.object({
  path: z.string(),
  status: ReviewFileStatus,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** 這個檔案送審的位元組數（截斷後）。 */
  bytes: z.number().int().nonnegative(),
  /** 超過單檔上限被截斷。 */
  truncated: z.boolean(),
  /**
   * 沒送內容（只列名稱）：true＝整份超過上限；"sensitive"＝檔名像機密（`.env*`、金鑰、憑證…，審查 W2），一律不送內容。
   */
  omitted: z.union([z.boolean(), z.literal('sensitive')]),
});
export type ReviewFile = z.infer<typeof ReviewFile>;

/** diff 摘要：hub 只存這個（檔案清單、行數），不存整份 diff。 */
export const ReviewDiffSummary = z.object({
  files: z.array(ReviewFile).max(2000),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** 有檔案被截斷或略過。 */
  truncated: z.boolean(),
});
export type ReviewDiffSummary = z.infer<typeof ReviewDiffSummary>;

/** 一邊（Claude 或 Codex）的狀態。skipped：沒有跑（例如 Windows 機器不跑 Codex、這台沒有 codex）。 */
export const ReviewSideStatus = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'timeout',
  'skipped',
]);
export type ReviewSideStatus = z.infer<typeof ReviewSideStatus>;

export const ReviewSide = z.object({
  agent: AgentKind,
  status: ReviewSideStatus,
  /** 模型的審查意見（截到 REVIEW_OUTPUT_MAX_CHARS）。 */
  output: z.string().nullable(),
  /** 失敗、逾時、略過的原因（給人看）。 */
  error: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /**
   * 意見全文的字數。快照、`review.updated`、清單只送摘要（`output` 是 null、這裡是字數，審查 W7）；
   * 全文用 `GET /api/reviews/:id` 讀。
   */
  outputChars: z.number().int().nonnegative().nullable().default(null),
});
export type ReviewSide = z.infer<typeof ReviewSide>;

/** 摘要版：意見全文換成字數（快照、廣播、清單用）。 */
export const summarizeReview = <T extends { claude: ReviewSide; codex: ReviewSide }>(
  review: T,
): T => {
  const side = (s: ReviewSide): ReviewSide => ({
    ...s,
    output: null,
    outputChars: s.output === null ? s.outputChars : s.output.length,
  });
  return { ...review, claude: side(review.claude), codex: side(review.codex) };
};

export const pendingSide = (agent: AgentKind): ReviewSide => ({
  agent,
  status: 'pending',
  output: null,
  error: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  durationMs: null,
  outputChars: null,
});

/**
 * preparing：daemon 在產生 diff；awaiting_confirm：GM 看檔案清單、還沒按確認；running：兩邊在跑；
 * done：兩邊都結束（各自可能失敗）；failed：diff 產生不了或 daemon 斷線；cancelled：GM 取消。
 */
export const ReviewStatus = z.enum([
  'preparing',
  'awaiting_confirm',
  'running',
  'done',
  'failed',
  'cancelled',
]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const ReviewRequester = z.object({
  kind: z.enum(['user', 'lead']),
  /** user id 或隊長 session id。 */
  id: Id.nullable(),
  name: z.string(),
});
export type ReviewRequester = z.infer<typeof ReviewRequester>;

export const Review = z.object({
  id: Id,
  requestedBy: ReviewRequester,
  /** 隊長發起時的團隊。 */
  teamId: Id.nullable(),
  /** 隊長發起必填（進 audit、團隊動態，不進推播）；GM 發起可空白。 */
  reason: z.string(),
  machineId: Id,
  target: ReviewTarget,
  status: ReviewStatus,
  /** 失敗原因（status failed）。 */
  error: z.string().nullable(),
  diff: ReviewDiffSummary.nullable(),
  claude: ReviewSide,
  codex: ReviewSide,
  instructionsVersion: z.number().int().positive(),
  read: z.boolean(),
  createdAt: IsoTime,
  startedAt: IsoTime.nullable(),
  completedAt: IsoTime.nullable(),
});
export type Review = z.infer<typeof Review>;

/** 兩邊都結束了沒有。 */
export const reviewSideFinished = (side: ReviewSide): boolean =>
  side.status === 'done' ||
  side.status === 'failed' ||
  side.status === 'timeout' ||
  side.status === 'skipped';

// ── hub ↔ daemon ─────────────────────────────────────────────

/** daemon 宣告會做交叉審查（認得 review.prepare／review.run）。舊 daemon 沒有：hub 回 review_unsupported。 */
export const REVIEW_FEATURE = 'review.v1';

/** hub → daemon：產生 diff（不跑模型）。 */
export const ReviewPrepareRequest = z.object({
  type: z.literal('review.prepare'),
  requestId: Id,
  reviewId: Id,
  kind: z.enum(['session', 'branch']),
  cwd: z.string(),
  branch: z.string().nullable(),
  base: z.string().nullable(),
});

/** daemon → hub：diff 摘要（整份 diff 留在 daemon 記憶體，key 是 reviewId）。 */
export const ReviewPrepared = z.object({
  type: z.literal('review.prepared'),
  requestId: Id,
  reviewId: Id,
  diff: ReviewDiffSummary.nullable(),
  error: z.string().nullable(),
});

/**
 * hub → daemon：跑審查。只有兩個地方會送：GM 在網頁按確認（`POST /api/reviews/:id/start`）、
 * 隊長呼叫 `request_review`（no-llm 界線，scripts/check-no-llm.mjs 檢查）。
 */
export const ReviewRunRequest = z.object({
  type: z.literal('review.run'),
  reviewId: Id,
  claude: z.object({ model: z.string().nullable(), accountProfile: z.string().nullable() }),
  /** null：這邊不跑（Windows、沒有 codex）。 */
  codex: z.object({ model: z.string().nullable(), effort: z.string().nullable() }).nullable(),
});

/** hub → daemon：取消（還沒確認的 diff 丟掉；跑到一半的結束）。 */
export const ReviewCancelRequest = z.object({ type: z.literal('review.cancel'), reviewId: Id });

/** daemon → hub：某一邊的狀態變了（開始、結束）。 */
export const ReviewSideUpdate = z.object({
  type: z.literal('review.side'),
  reviewId: Id,
  side: ReviewSide,
});
