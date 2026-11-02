// 遮蔽模式：把看起來像金鑰的字串換成同寬的 *。寬度不變，TUI 的游標位置與折行才不會亂。
// 只改這個畫面看到的東西，不是安全邊界：原始資料照樣送到瀏覽器，形狀認不出來的密碼也遮不到。
import { secretRanges } from './secretPatterns';

const isWide = (code: number) =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    code >= 0x1f300);

/** 換行與空白留著（多行私鑰的版面不變）。 */
function star(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') out += ch;
    else out += isWide(ch.codePointAt(0) ?? 0) ? '**' : '*';
  }
  return out;
}

export function maskSecrets(text: string): string {
  let out = '';
  let at = 0;
  for (const [start, end] of secretRanges(text)) {
    out += text.slice(at, start) + star(text.slice(start, end));
    at = end;
  }
  return out + text.slice(at);
}

type Item =
  | { kind: 'text'; raw: string }
  /** 顏色：金鑰被上色切開時也要認得出來，比對時當它不存在。 */
  | { kind: 'sgr'; raw: string }
  /** 游標移動、換行等：畫面上不再連續。 */
  | { kind: 'break'; raw: string };

const MAX_ESCAPE = 64 * 1024;
const MAX_HELD = 16 * 1024;
const CONTEXT_CHARS = 256;
const MAX_PEM_CHARS = 16 * 1024;

/** 把資料切成 item；結尾沒收完的控制碼放進 partial。 */
function tokenize(data: string): { items: Item[]; partial: string } {
  const items: Item[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = () => {
    if (i > textStart) items.push({ kind: 'text', raw: data.slice(textStart, i) });
  };
  while (i < data.length) {
    const code = data.charCodeAt(i);
    if (code !== 0x1b && code >= 0x20 && code !== 0x7f) {
      i += 1;
      continue;
    }
    flushText();
    if (code !== 0x1b) {
      items.push({ kind: 'break', raw: data[i]! });
      i += 1;
      textStart = i;
      continue;
    }
    const next = data[i + 1];
    let end = -1;
    let kind: 'sgr' | 'break' = 'break';
    if (next === undefined) {
      return { items, partial: data.slice(i) };
    } else if (next === '[') {
      let j = i + 2;
      while (j < data.length && data.charCodeAt(j) < 0x40) j += 1;
      if (j < data.length) {
        end = j + 1;
        if (data[j] === 'm') kind = 'sgr';
      }
    } else if (next === ']' || next === 'P' || next === '_' || next === '^') {
      for (let j = i + 2; j < data.length; j += 1) {
        if (data[j] === '\x07') {
          end = j + 1;
          break;
        }
        if (data[j] === '\x1b' && data[j + 1] === '\\') {
          end = j + 2;
          break;
        }
      }
    } else if (next === '(' || next === ')' || next === '#' || next === '%') {
      if (i + 2 < data.length) end = i + 3;
    } else {
      end = i + 2;
    }
    if (end < 0) {
      // 控制碼沒收完：等下一段。太長就當壞掉的，交給 xterm。
      if (data.length - i <= MAX_ESCAPE) return { items, partial: data.slice(i) };
      end = data.length;
    }
    items.push({ kind, raw: data.slice(i, end) });
    i = end;
    textStart = i;
  }
  flushText();
  return { items, partial: '' };
}

/** 可能還沒收完的金鑰。比對到就先扣住，等下一段或等計時到才決定。 */
const IN_PROGRESS: RegExp[] = [
  /(?:^|[^A-Za-z0-9_-])((?:sk-|gh[pousr]_|github_pat_|glpat-|xox[abeoprs]-|AKIA|ASIA|AIza|npm_|hf_|[srp]k_(?:live|test)_|ab[sm]_|eyJ)[A-Za-z0-9_.-]*)$/,
  /[A-Za-z0-9_-]*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([^\s"'&;,]*)$/i,
  /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]*)$/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]*)$/i,
  /(-----BEGIN [A-Z ]*)$/,
];

const WRAP_WORD = /^(\s*)([A-Za-z0-9_+/=.-]+)/;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

interface Run {
  parts: Item[];
}

/**
 * 串流版本：金鑰可能被切在兩段之間、被顏色碼切開，或被 TUI 折成兩行。
 * - 比對時帶上同一行已經送出的文字（context），後半段才認得出來；已送出的改不了，所以開頭幾個字可能先露出。
 * - 尾巴看起來還在收的先扣住，呼叫方要在短暫沒資料後呼叫 flush()，扣住的內容一律打碼。
 * - 金鑰打到行尾時，下一行開頭的連續字元視為折行的後半段。
 */
export class StreamMasker {
  private pending = '';
  private context = '';
  private wrapCarry = false;
  private pemLeft = 0;

  get holding(): boolean {
    return this.pending !== '';
  }

  push(data: string): string {
    this.pending += data;
    return this.process(false);
  }

  flush(): string {
    return this.process(true);
  }

  private process(flushing: boolean): string {
    const { items, partial } = tokenize(this.pending);
    let out = '';
    let run: Run = { parts: [] };
    for (const item of items) {
      if (item.kind === 'break') {
        out += this.renderRun(run, 'complete').text;
        run = { parts: [] };
        this.context = '';
        out += item.raw;
      } else {
        run.parts.push(item);
      }
    }
    const last = this.renderRun(run, flushing ? 'flush' : 'open');
    out += last.text;
    // 計時到了還沒收完的控制碼就照原樣交出去，xterm 自己接得起來。
    if (flushing) {
      this.pending = '';
      return out + partial;
    }
    this.pending = last.held + partial;
    return out;
  }

  private renderRun(run: Run, mode: 'complete' | 'open' | 'flush'): { text: string; held: string } {
    const fresh = run.parts
      .filter((p) => p.kind === 'text')
      .map((p) => p.raw)
      .join('');
    if (fresh === '') {
      return { text: run.parts.map((p) => p.raw).join(''), held: '' };
    }
    const base = this.context.length;
    const full = this.context + fresh;
    const hold = mode === 'open' ? this.holdIndex(full, base) : full.length;

    const covered = new Uint8Array(full.length);
    const mark = (start: number, end: number) => covered.fill(1, start, end);
    for (const [start, end] of secretRanges(full)) mark(start, end);
    if (mode === 'flush') {
      // 扣住的都長得像金鑰，時間到了也不放行。
      const from = this.inProgressStart(full);
      if (from !== null) mark(from, full.length);
    }
    const wrapEnd = this.applyWrap(full, base, mode);
    if (wrapEnd > base) mark(base, wrapEnd);
    this.applyPem(full, base, mark);

    // 這一段最後是不是打到金鑰（只有收完的才算）。
    if (mode !== 'open' && !this.wrapCarry && !PEM_END.test(fresh)) {
      let end = full.length;
      while (end > 0 && full[end - 1] === ' ') end -= 1;
      this.wrapCarry = end > base && covered[end - 1] === 1;
    }

    let visible = base;
    let text = '';
    let held = '';
    for (const part of run.parts) {
      if (part.kind === 'sgr') {
        if (visible >= hold && hold < full.length) held += part.raw;
        else text += part.raw;
        continue;
      }
      const raw = part.raw;
      const keep = Math.max(0, Math.min(raw.length, hold - visible));
      let segment = '';
      let at = 0;
      while (at < keep) {
        const isCovered = covered[visible + at] === 1;
        let stop = at + 1;
        while (stop < keep && (covered[visible + stop] === 1) === isCovered) stop += 1;
        const slice = raw.slice(at, stop);
        segment += isCovered ? star(slice) : slice;
        at = stop;
      }
      text += segment;
      held += raw.slice(keep);
      visible += raw.length;
    }
    this.context = full.slice(0, hold).slice(-CONTEXT_CHARS);
    return { text, held };
  }

  private inProgressStart(full: string): number | null {
    let start: number | null = null;
    for (const pattern of IN_PROGRESS) {
      const match = pattern.exec(full);
      if (!match) continue;
      const value = match[1]!;
      const at = full.length - value.length;
      if (start === null || at < start) start = at;
    }
    return start;
  }

  private holdIndex(full: string, base: number): number {
    if (full.length - base > MAX_HELD) return full.length;
    let hold = this.inProgressStart(full) ?? full.length;
    if (this.wrapCarry) {
      // 折行的後半段可能還沒收完。
      const match = WRAP_WORD.exec(full.slice(base));
      if (match && match[0].length === full.length - base) {
        hold = Math.min(hold, base + match[1]!.length);
      }
    }
    return Math.max(hold, base);
  }

  /** 回傳折行後半段的結束位置（沒有就回 base）。 */
  private applyWrap(full: string, base: number, mode: 'complete' | 'open' | 'flush'): number {
    if (!this.wrapCarry) return base;
    const rest = full.slice(base);
    const match = WRAP_WORD.exec(rest);
    if (!match) {
      if (rest.trim() !== '') this.wrapCarry = false;
      return base;
    }
    const word = match[2]!;
    const wholeRun = match[0].length === rest.trimEnd().length;
    // 下一行正常的短字不該被吃掉：折行的後半段要嘛夠長，要嘛自己占整行。
    if (word.length < 8 && !wholeRun) {
      this.wrapCarry = false;
      return base;
    }
    if (mode !== 'open') this.wrapCarry = wholeRun;
    return base + match[0].length;
  }

  /** 私鑰跨多行：看到 BEGIN 之後每一行都打碼，直到 END。上限防止永遠停不下來。 */
  private applyPem(full: string, base: number, mark: (start: number, end: number) => void): void {
    const fresh = full.slice(base);
    if (this.pemLeft > 0) {
      const end = PEM_END.exec(fresh);
      if (end) {
        mark(base, base + end.index + end[0].length);
        this.pemLeft = 0;
      } else {
        mark(base, full.length);
        this.pemLeft = Math.max(0, this.pemLeft - fresh.length);
      }
      return;
    }
    if (PEM_BEGIN.test(fresh) && !PEM_END.test(fresh)) this.pemLeft = MAX_PEM_CHARS;
  }
}

/** 接在 xterm 前面。沒開遮蔽時完全透明，不扣住任何東西。 */
export class TerminalMaskGate {
  private masker = new StreamMasker();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly enabled: () => boolean,
    private readonly flushMs = 40,
  ) {}

  output(data: string): void {
    if (!this.enabled()) {
      this.write(data);
      return;
    }
    this.clearTimer();
    const out = this.masker.push(data);
    if (out) this.write(out);
    if (this.masker.holding) {
      this.timer = setTimeout(() => {
        this.timer = null;
        const rest = this.masker.flush();
        if (rest) this.write(rest);
      }, this.flushMs);
    }
  }

  /** 快照涵蓋之前的所有輸出，扣住的舊資料作廢。 */
  snapshot(data: string): string {
    this.clearTimer();
    this.masker = new StreamMasker();
    if (!this.enabled()) return data;
    const out = this.masker.push(data) + this.masker.flush();
    this.masker = new StreamMasker();
    return out;
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
