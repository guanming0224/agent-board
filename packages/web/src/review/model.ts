// 交叉審查畫面的純函式（Codex 第二輪）：畫面與測試共用。
import {
  reviewSideFinished,
  type Review,
  type ReviewFile,
  type ReviewSide,
} from '@agent-board/protocol';

/** 位元組換成好讀的大小（KB／MB，1024 進位）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 毫秒換成「1 分 05 秒」用的數字。 */
export function durationParts(ms: number): { m: number; s: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  return { m: Math.floor(total / 60), s: total % 60 };
}

/** 兩邊都結束（不論成敗），或整份失敗／取消。 */
export const reviewFinished = (review: Review): boolean =>
  review.status === 'done' || review.status === 'failed' || review.status === 'cancelled';

/** 收件匣的「交叉審查」：結束了、還沒讀的（失敗也要讓 GM 知道）。新的在前（清單本來就是）。 */
export const unreadReviews = (reviews: readonly Review[]): Review[] =>
  reviews.filter((r) => !r.read && (r.status === 'done' || r.status === 'failed'));

/** 等 GM 確認的（GM 自己發起、檔案清單看完還沒按確認）。 */
export const awaitingReviews = (reviews: readonly Review[]): Review[] =>
  reviews.filter((r) => r.status === 'awaiting_confirm');

/**
 * 略過、失敗的原因分類：windows（Windows 只跑 Claude）、unavailable（這台沒有 codex）、cancelled、other。
 * hub／daemon 的錯誤字串開頭是固定代碼（`windows: …`、`codex_unavailable…`）。
 */
export function sideReason(side: ReviewSide): 'windows' | 'unavailable' | 'cancelled' | 'other' {
  const error = side.error ?? '';
  if (error.startsWith('windows')) return 'windows';
  if (error.startsWith('codex_unavailable')) return 'unavailable';
  if (error === 'cancelled') return 'cancelled';
  return 'other';
}

/** 一邊還在跑（顯示轉圈）。 */
export const sideBusy = (side: ReviewSide): boolean =>
  side.status === 'running' || side.status === 'pending';

export { reviewSideFinished };

/** 檔案清單排序：被略過的放最後，其餘照 daemon 的順序。 */
export function orderedFiles(files: readonly ReviewFile[]): ReviewFile[] {
  return [...files.filter((f) => !f.omitted), ...files.filter((f) => f.omitted)];
}
