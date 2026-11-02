import { registerMessages } from '../shared/i18n';

registerMessages('zh-TW', {
  'security.mask.on': '◐ 遮蔽中（僅畫面）',
  'security.mask.off': '遮蔽',
  'security.mask.title':
    '把看起來像金鑰的字串打碼，展示畫面時用。這不是安全邊界：原始資料照樣送到這個瀏覽器，沒有固定形狀的密碼遮不到，輸出被切開時開頭幾個字可能先露出。',
});

registerMessages('en', {
  'security.mask.on': '◐ Masking (display only)',
  'security.mask.off': 'Mask',
  'security.mask.title':
    'Hides strings that look like keys, for showing the screen to others. This is not a security boundary: raw data still reaches this browser, passwords with no recognizable shape stay visible, and the first few characters of a split key may show.',
});
