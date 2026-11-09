// 從終端機輸出偵測用量上限。這是輔助訊號，主要訊號是 StopFailure hook（CONTRACTS.md §5）。
// 所有比對規則都在這裡。訊息格式取自 claude 2.1.316 內的字串，未經真實限流驗證，換版可能要調整。
//
// 寧可不報也不要誤報：agent 的輸出可能剛好在討論限流，所以比對「整行就是 CLI 訊息」，
// 不比對「行內提到某字樣」。agent 的文字或程式碼不會只有這句話。

/** 帶重置時間的完整訊息，agent 工作中也算。 */
const STRICT_PATTERNS: readonly RegExp[] = [
  // `fast limit` 只是快速模式降速，工作不會停，不算。
  /^You've hit your (?!fast\b)[\w -]{0,40}\blimit · resets? .+$/,
  /^Usage limit reached(?: again)? · (?:limit resets|continuing automatically) .+$/,
  // Codex（未驗證：取自 codex 原始碼的錯誤訊息，沒有真的撞過上限）。TUI 的錯誤行前面有 ■，
  // 要求這個前綴，agent 自己的文字不會被當成限流。
  /^■ ?You've hit your usage limit\b.*$/,
];

/** 沒有重置時間的短訊息，只在 agent 沒在工作時才算。 */
const IDLE_ONLY_PATTERNS: readonly RegExp[] = [
  /^You've hit your (?!fast\b)[\w -]{0,40}\blimit\b[.]?$/,
  /^You've hit your monthly spend limit\b.*$/,
  /^You're out of usage credits\b.*$/,
  /^Usage limit reached$/,
];

/** CLI 在訊息前可能加的裝飾。 */
const LINE_DECORATION = /^[\s│⎿⏺●]+/;

const MAX_LINE_LENGTH = 200;
/** 超過就丟掉開頭。上限只是防止沒有換行的輸出吃光記憶體。 */
const MAX_BUFFER_LENGTH = 8_192;

const ESC = '\\u001b';
const ANSI_SEQUENCES = new RegExp(
  [
    `${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)`, // OSC
    `${ESC}[PX^_][^\\u001b]*${ESC}\\\\`, // DCS、SOS、PM、APC
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI
    `${ESC}[ -/]*[0-~]`, // 其他兩字元序列
  ].join('|'),
  'g',
);
/** 結尾不完整的控制序列，要留到下一個 chunk。 */
const TRAILING_PARTIAL_SEQUENCE = new RegExp(
  `${ESC}(?:\\][^\\u0007\\u001b]*|[PX^_][^\\u001b]*|\\[[0-?]*[ -/]*|[ -/]*)?$`,
);

// 顏色直接拿掉；C 是往右移，多半等於空白；其他游標移動與清除都等於換到另一段文字。
function replaceSequence(sequence: string): string {
  if (!sequence.startsWith('\u001b[')) return '';
  const final = sequence.at(-1);
  if (final === 'm') return '';
  if (final === 'C') return ' ';
  return '\n';
}

export type LimitMatchMode = 'strict' | 'idle';

export function matchesUsageLimit(rawLine: string, mode: LimitMatchMode): boolean {
  const line = rawLine.replace(LINE_DECORATION, '').trimEnd().replaceAll('∙', '·');
  if (line.length === 0 || line.length > MAX_LINE_LENGTH) return false;
  if (STRICT_PATTERNS.some((pattern) => pattern.test(line))) return true;
  return mode === 'idle' && IDLE_ONLY_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * 把 PTY 的 chunk 切成去 ANSI 後的完整行。chunk 可能切在控制序列或一行的中間，所以要有緩衝；
 * 還沒結束的行不比對，否則 `Usage limit reached` 可能只是更長句子的開頭。
 */
export function createLineSplitter(): (data: string) => string[] {
  let pending = '';
  return (data) => {
    pending += data;
    if (pending.length > MAX_BUFFER_LENGTH) pending = pending.slice(-MAX_BUFFER_LENGTH);

    const partial = TRAILING_PARTIAL_SEQUENCE.exec(pending);
    const complete = partial ? pending.slice(0, partial.index) : pending;
    const carried = partial ? pending.slice(partial.index) : '';

    const lines = complete.replace(ANSI_SEQUENCES, replaceSequence).split(/[\r\n]/);
    pending = (lines.pop() ?? '') + carried;
    return lines;
  };
}
