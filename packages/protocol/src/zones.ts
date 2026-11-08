// 工作區移入時的擺放規則（P2 §2.3、§2.8 必要規則）。座標共用同一個版面組，移進來的團隊或 session
// 要排到目標工作區現有內容的右側空白，不能疊在別人上面。hub（存好的版面）、畫布（畫面上的卡）、
// 前端假後端都用這一個函式，排出來才一樣。

/**
 * 排到目標工作區現有卡片最右邊再往右這麼多（畫布 px）：團隊框兩側內距（32 × 2）＋團隊之間的間距（240）。
 */
export const ZONE_MOVE_GAP = 32 * 2 + 240;

export interface ZoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 移進來的這組卡要平移多少：左緣對齊「目標工作區現有卡片的最右邊＋間距」，上緣對齊現有卡片的最上面。
 * 目標工作區沒有別的卡（或沒有要移的卡）就不用動，回傳 null。
 */
export function zoneMoveShift(
  moving: readonly ZoneRect[],
  others: readonly ZoneRect[],
): { dx: number; dy: number } | null {
  if (moving.length === 0 || others.length === 0) return null;
  const left = Math.min(...moving.map((r) => r.x));
  const top = Math.min(...moving.map((r) => r.y));
  const right = Math.max(...others.map((r) => r.x + r.w)) + ZONE_MOVE_GAP;
  const minY = Math.min(...others.map((r) => r.y));
  return { dx: right - left, dy: minY - top };
}
