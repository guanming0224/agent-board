// 看起來像金鑰的字串。hub（audit 打碼、搜尋片段的伺服器端遮蔽）與 web（遮蔽模式）各放一份完全相同的檔案，
// packages/web/src/security/mask.test.ts 會比對兩份一致。這是形狀比對，不是安全邊界：
// 沒有固定前綴也沒有 key=value 標籤的密碼認不出來。

/** 固定前綴的金鑰。 */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // sk-ant-…、sk-proj-…
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bab[sm]_[A-Za-z0-9_-]{20,}/g, // Agent Board 自己的登入與機器 token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
];

const LABEL =
  '[A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)';

/** 只遮第 1 組（值），標籤留著才看得出這裡是什麼。 */
const VALUE_PATTERNS: RegExp[] = [
  new RegExp(`\\b${LABEL}["']?\\s*[:=]\\s*["']?([^\\s"'&;,]{3,})`, 'gi'),
  /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/gi, // 網址裡的帳密
  /--code\s+'?([0-9A-Z]{5}-[0-9A-Z]{5})/g, // agent-board-daemon pair 的配對碼
];

const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

export type Range = [start: number, end: number];

/** 回傳排序、合併過的範圍。 */
export function secretRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  for (const pattern of VALUE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]!;
      const start = match.index + match[0].lastIndexOf(value);
      ranges.push([start, start + value.length]);
    }
  }
  for (const match of text.matchAll(PEM)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

const isWide = (code: number) =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    code >= 0x1f300);

/** 每個字換成同寬的 *；換行與空白留著（多行私鑰的版面不變）。 */
export function maskChars(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') out += ch;
    else out += isWide(ch.codePointAt(0) ?? 0) ? '**' : '*';
  }
  return out;
}

/**
 * 遮蔽模式：把看起來像金鑰的字串換成同寬的 *（寬度不變，TUI 的游標位置與折行才不會亂）。
 * 畫面（web）與搜尋片段（hub，P3 §3.5）用同一個函式，伺服器端遮好的片段和畫面上遮的一模一樣。
 */
export function maskSecrets(text: string): string {
  let out = '';
  let at = 0;
  for (const [start, end] of secretRanges(text)) {
    out += text.slice(at, start) + maskChars(text.slice(start, end));
    at = end;
  }
  return out + text.slice(at);
}
