/**
 * 搜尋圖示（放大鏡 SVG）：取代原本的「⌕」字元，那個字在多數字型裡只有幾 px 大，手機上幾乎看不出是搜尋。
 * 只是裝飾（aria-hidden），按鈕自己要有 aria-label。大小在 controls.css 的 .search-icon（--fs-lg，觸控放大）。
 */
export function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M15.5 15.5 20.5 20.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
