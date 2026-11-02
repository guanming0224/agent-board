// 輸入相關的純邏輯：輸入法組字、快捷鍵分類、連結檢查。

/** 組字結束後，這段時間內出現一樣的內容視為 xterm 重複送出。 */
export const COMPOSITION_DEDUPE_MS = 50;

/** 不會結束組字的 keyCode：229 組字、20 CapsLock、16/17/18 修飾鍵（同 xterm CompositionHelper）。 */
const COMPOSING_KEY_CODES = new Set([229, 20, 16, 17, 18]);

/**
 * 擋在 xterm onData 之後：組字中的內容不送，確定後只送一次。
 * xterm 在組字結束時從 textarea 取字送出（CompositionHelper），但 insertText 型的 input 事件
 * 又會走另一條路送一次（_inputEvent），兩條路同時發生就會重複。
 */
export class ImeInputGuard {
  private composing = false;
  /** 組字中按了非組字鍵，xterm 會立刻送出目前內容，這筆要放行。 */
  private awaitingForcedCommit = false;
  private committed: string | null = null;
  private dedupeUntil = 0;

  compositionStart(): void {
    this.composing = true;
    this.awaitingForcedCommit = false;
    this.committed = null;
    this.dedupeUntil = 0;
  }

  compositionEnd(now: number): void {
    this.composing = false;
    this.awaitingForcedCommit = false;
    this.dedupeUntil = now + COMPOSITION_DEDUPE_MS;
  }

  keyDown(keyCode: number): void {
    if (!this.composing || COMPOSING_KEY_CODES.has(keyCode)) return;
    this.composing = false;
    this.awaitingForcedCommit = true;
  }

  /** 這筆 onData 要不要送進終端機。 */
  accept(data: string, now: number): boolean {
    if (this.composing) return false;
    if (this.awaitingForcedCommit) {
      this.awaitingForcedCommit = false;
      this.committed = data;
      return true;
    }
    if (now > this.dedupeUntil) return true;
    if (this.committed === null) {
      this.committed = data;
      return true;
    }
    if (this.committed === data) {
      this.committed = null;
      this.dedupeUntil = 0;
      return false;
    }
    return true;
  }
}

export type KeyAction = 'terminal' | 'browser' | 'copy';

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/**
 * terminal：交給 xterm；browser：xterm 不處理，留給瀏覽器；copy：複製選取內容。
 * macOS 的 Ctrl+W、Ctrl+T 不是瀏覽器快捷鍵，要照常送（Ctrl+W 是刪一個字）。
 */
export function classifyKey(ev: KeyLike, isMac: boolean): KeyAction {
  if (ev.altKey) return 'terminal';
  const key = ev.key.toLowerCase();
  if ((key === 'w' || key === 't') && (ev.metaKey || (ev.ctrlKey && !isMac))) return 'browser';
  if (!isMac && ev.ctrlKey && ev.shiftKey) {
    if (key === 'c') return 'copy';
    if (key === 'v') return 'browser';
  }
  return 'terminal';
}

/** 只開 http(s)，終端機輸出裡的 OSC 8 連結可能是任意協定。 */
export function isOpenableLink(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
