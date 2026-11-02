// 終端機輸入的稽核：把按鍵流還原成「以 Enter 為界的一筆指令」，以及 CSV 匯出。
import type { AuditEntry } from '@agent-board/protocol';
import { secretRanges } from './secretPatterns';

const MAX_LINE_CHARS = 16 * 1024;
const TRUNCATED_MARK = ' …[truncated]';

type ParseState = 'text' | 'esc' | 'csi' | 'ss3' | 'osc' | 'osc_esc';

/**
 * 只理解行編輯常用的控制字元，游標移動後的編輯不會還原，所以紀錄是「盡力而為」。
 * bracketed paste 內的換行不算 Enter：真正送出的是貼完之後那一下。
 */
export class InputLineBuffer {
  private line = '';
  private truncated = false;
  private state: ParseState = 'text';
  private csi = '';
  private inPaste = false;
  private lastWasCr = false;

  /** 餵入一段輸入，回傳這段裡完成的指令。 */
  push(data: string): string[] {
    const done: string[] = [];
    for (const ch of data) {
      const wasCr = this.lastWasCr;
      this.lastWasCr = false;
      switch (this.state) {
        case 'esc':
          if (ch === '[') {
            this.state = 'csi';
            this.csi = '';
          } else if (ch === 'O') {
            this.state = 'ss3';
          } else if (ch === ']') {
            this.state = 'osc';
          } else {
            // Alt+Enter 在 Claude Code 是換行，不是送出。
            if (ch === '\r' || ch === '\n') this.append('\n');
            this.state = 'text';
          }
          continue;
        case 'csi': {
          const code = ch.codePointAt(0) ?? 0;
          if (code >= 0x40 && code <= 0x7e) {
            if (ch === '~' && this.csi === '200') this.inPaste = true;
            if (ch === '~' && this.csi === '201') this.inPaste = false;
            this.state = 'text';
          } else {
            this.csi += ch;
          }
          continue;
        }
        case 'ss3':
          this.state = 'text';
          continue;
        case 'osc':
          if (ch === '\x07') this.state = 'text';
          else if (ch === '\x1b') this.state = 'osc_esc';
          continue;
        case 'osc_esc':
          this.state = ch === '\\' ? 'text' : 'osc';
          continue;
        case 'text':
          break;
      }
      if (ch === '\x1b') {
        this.state = 'esc';
      } else if (ch === '\r' || ch === '\n') {
        if (this.inPaste) this.append('\n');
        else if (!(ch === '\n' && wasCr)) done.push(this.take());
        this.lastWasCr = ch === '\r';
      } else if (ch === '\x7f' || ch === '\b') {
        this.line = Array.from(this.line).slice(0, -1).join('');
      } else if (ch === '\x15' || ch === '\x03') {
        this.line = '';
        this.truncated = false;
      } else if (ch === '\x17') {
        this.line = this.line.replace(/\S*\s*$/, '');
      } else if ((ch.codePointAt(0) ?? 0) >= 0x20) {
        this.append(ch);
      }
    }
    // 一段輸入以單獨的 ESC 結束：那是使用者按了 Esc 鍵，不是序列被切開。
    if (this.state === 'esc') this.state = 'text';
    return done;
  }

  /** 取出尚未按 Enter 的內容（連線結束時用）。 */
  flush(): string | null {
    return this.line === '' ? null : this.take();
  }

  clear(): void {
    this.line = '';
    this.truncated = false;
  }

  private append(ch: string): void {
    if (this.line.length >= MAX_LINE_CHARS) {
      this.truncated = true;
      return;
    }
    this.line += ch;
  }

  private take(): string {
    const value = this.truncated ? this.line + TRUNCATED_MARK : this.line;
    this.clear();
    return value;
  }
}

export const REDACTED_INPUT = '[redacted: typed at a password prompt]';

const PROMPT_TAIL_BYTES = 2048;
const PROMPT_LOOKBACK_LINES = 3;
/** 行尾是「…密碼：」才算；只出現 password 這個字（例如在講解文字裡）不算。 */
const PASSWORD_PROMPT =
  /(?:password|passphrase|passcode|verification code|one-time code|\botp\b|\bpin\b|api key|密碼|口令|驗證碼)[^\n:：?？]{0,40}[:：?？]\s*$/i;
// 畫面控制碼與 TUI 的框線；比對前先拿掉。
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\^_])/g;
const BOX_EDGES = /[\s│|┃╎╏]+$/;

/**
 * hub 分不出打的字是不是密碼，但看得到輸出：沒有回顯的輸入，畫面尾巴還停在提示上。
 * 按 Enter 當下檢查最後幾行。只留最後一小段在記憶體（不落地，也不算保存終端機資料），
 * 取捨見 docs/security-checklist.md「audit 明文密碼」。
 */
export class PromptWatcher {
  private readonly tails = new Map<string, string>();

  onOutput(sessionId: string, data: string): void {
    const tail = (this.tails.get(sessionId) ?? '') + data;
    this.tails.set(sessionId, tail.slice(-PROMPT_TAIL_BYTES));
  }

  /** 快照是整個畫面，舊尾巴作廢。 */
  onSnapshot(sessionId: string, data: string): void {
    this.tails.set(sessionId, data.slice(-PROMPT_TAIL_BYTES));
  }

  forget(sessionId: string): void {
    this.tails.delete(sessionId);
  }

  atPasswordPrompt(sessionId: string): boolean {
    const tail = this.tails.get(sessionId);
    if (!tail) return false;
    const lines = tail
      .replace(ANSI, '')
      .split(/[\r\n]+/)
      .map((line) => line.replace(BOX_EDGES, ''))
      .filter((line) => line !== '')
      .slice(-PROMPT_LOOKBACK_LINES);
    return lines.some((line) => PASSWORD_PROMPT.test(line));
  }
}

/** 寫進 audit 前把金鑰形狀的字串換掉；貼上的 API key 不會永久留在資料庫。 */
export function redactSecrets(text: string): string {
  let out = '';
  let at = 0;
  for (const [start, end] of secretRanges(text)) {
    out += `${text.slice(at, start)}[redacted]`;
    at = end;
  }
  return out + text.slice(at);
}

/** 試算表會把這些開頭當公式（CSV injection），前面補單引號讓它變成純文字。 */
function csvCell(value: string | null): string {
  const text = value ?? '';
  const safe = /^[\s　]*[=+\-@＝＋－＠]/.test(text) || /^[\t\r\n]/.test(text);
  const cell = safe ? `'${text}` : text;
  return `"${cell.replaceAll('"', '""')}"`;
}

const CSV_HEADER = ['id', 'at', 'user_id', 'session_id', 'action', 'detail'];

/** 開頭的 BOM 讓 Excel 用 UTF-8 開啟中文。 */
export function auditToCsv(entries: Iterable<AuditEntry>): string {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const e of entries) {
    lines.push([e.id, e.at, e.userId, e.sessionId, e.action, e.detail].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
