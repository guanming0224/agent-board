// 終端機輸入的稽核：把按鍵流還原成「以 Enter 為界的一筆指令」，以及 CSV 匯出。
import type { AuditEntry } from '@agent-board/protocol';

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
