/**
 * 手機斷點只有一個（GM 2026-11-09，STYLE.md §5「控制項尺寸與層級」）。
 * - 版面切換（手機只有收件匣等）：JS 用 PHONE_QUERY。
 * - 控制項尺寸（觸控 44／動作 56、輸入框 16px）：CSS 用 TOUCH_QUERY，寫在 shared/styles/controls.css。
 * 改數字要三處一起改：這裡、controls.css 的 @media、tokens.css 的 --bp-phone。
 */
export const PHONE_WIDTH = 640;
export const PHONE_QUERY = `(max-width: ${PHONE_WIDTH}px)`;
export const TOUCH_QUERY = `${PHONE_QUERY}, (pointer: coarse)`;
