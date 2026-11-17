// 快照補上 @xterm/addon-serialize 沒輸出的終端機模式。
// serialize 會帶滑鼠「追蹤模式」（?1000/1002/1003h），但不帶滑鼠「編碼」（?1006h SGR、?1016h SGR 像素）。
// 網頁收到快照會先 reset 再寫入，編碼就退回預設的 X10：Claude Code 要 SGR（?1006h），網頁卻送 `ESC[M`＋3 bytes。
import type { Terminal } from '@xterm/headless';

/** xterm.js 內部的滑鼠編碼名稱 → 開啟它的序列（DEFAULT＝X10，不用送）。 */
const ENCODING_SEQUENCES: Readonly<Record<string, string>> = {
  SGR: '\x1b[?1006h',
  SGR_PIXELS: '\x1b[?1016h',
};

/**
 * 目前滑鼠編碼的開啟序列；預設（X10）或讀不到時回空字串。
 * 用的是 xterm.js 內部的 coreMouseService（公開 API 沒有編碼），版本換了讀不到就當預設，不會壞快照。
 */
export function mouseEncodingSequence(term: Terminal): string {
  try {
    const core = (
      term as unknown as { _core?: { coreMouseService?: { activeEncoding?: unknown } } }
    )._core;
    const encoding = core?.coreMouseService?.activeEncoding;
    return typeof encoding === 'string' ? (ENCODING_SEQUENCES[encoding] ?? '') : '';
  } catch {
    return '';
  }
}

/** 快照內容：serialize 的結果＋滑鼠編碼（放最後，網頁寫完快照時編碼和 PTY 一致）。 */
export function serializeSnapshot(
  term: Terminal,
  serializer: { serialize: (options: { scrollback: number }) => string },
  scrollback: number,
): string {
  return serializer.serialize({ scrollback }) + mouseEncodingSequence(term);
}
