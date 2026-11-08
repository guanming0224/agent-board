// 告訴開機檢查（flows/pwa/boot-check.js）「主程式畫好了」：在 <html> 標 data-ab-booted="1"。
// 沒標的話，開機檢查 8 秒後會蓋上「畫面沒有載入成功」的說明。
export function markBooted(): void {
  document.documentElement.setAttribute('data-ab-booted', '1');
}
