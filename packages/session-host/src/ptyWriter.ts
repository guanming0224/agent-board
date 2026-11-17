// PTY 輸入的寫入（Mac／Linux）。事故 9（2026-11，一台 Mac 上所有 session 打字沒反應）的修正，CONTRACTS §20.8。
//
// 不用 node-pty 內建的 write：node-pty 1.1.0 用 `fs.write`（非同步，走 libuv 的 threadpool，預設只有 4 條）。
// 只要有 4 個寫入卡在核心裡（例如寫到一個沒有 slave 的 /dev/ptmx——node-pty 在 macOS 每開一個 session 就漏一個
// 這種 fd，見 closeLeakedPtyFds），之後**整個 host** 的輸入都排在後面永遠送不出去，但輸出、開新 session、結束
// session 都正常（它們不走 threadpool）——和事故的症狀完全一樣，重啟 daemon 沒用、重啟 host 才好。
//
// 這裡改成在主執行緒同步寫：PTY master 是 non-blocking（node-pty 開的時候就設好），寫不進去會立刻回 EAGAIN，
// 不會卡住；稍後再試。每次寫之前確認 PTY 還開著（isOpen：node-pty 的讀取 socket 還沒被 destroy），而且 fd 還是
// 當初那個 PTY（fd 編號可能已經被關掉又分給別的檔案），不對就停。
// 注意（審查 W1）：macOS 關掉一個 ptmx 再開新的，fd 編號與 dev／ino／rdev 可能**完全相同**（重用最小號與最小 minor），
// 所以 fstat 擋不住「被下一個 session 的 master 重用」；真正擋住的是 isOpen（socket 一 destroy 就不再寫）。
import { fstatSync, writeSync } from 'node:fs';

/** EAGAIN 後多久再試：從 RETRY_MIN_MS 開始加倍到 RETRY_MAX_MS（agent 一直不讀時不空轉吃 CPU）。 */
const RETRY_MIN_MS = 2;
const RETRY_MAX_MS = 100;
/** agent 多久沒把輸入讀走就記一筆（只記一次，不含內容）。 */
export const PTY_WRITE_STALL_WARN_MS = 10_000;
/** 積著沒寫進去的上限：agent 一直不讀時不無限長，超過的新輸入丟掉並記一筆。 */
export const PTY_WRITE_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface PtyWriterLog {
  warn: (message: string) => void;
}

export interface PtyWriterOptions {
  /** PTY 還開著嗎（每次寫之前問）。回 false 就關掉寫入器。 */
  isOpen?: () => boolean;
  /** 輸入積太多被丟掉（第一次）時呼叫，讓 daemon 知道（不含內容）。 */
  onOverflow?: () => void;
  now?: () => number;
}

interface FdIdentity {
  dev: bigint;
  ino: bigint;
  rdev: bigint;
}

function identityOf(fd: number): FdIdentity | null {
  try {
    // bigint：dev 可能超過 2^53（審查 N3）。
    const st = fstatSync(fd, { bigint: true });
    return { dev: st.dev, ino: st.ino, rdev: st.rdev };
  } catch {
    return null;
  }
}

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? String(error);

export class PtyWriter {
  private readonly identity: FdIdentity | null;
  private readonly queue: Buffer[] = [];
  private offset = 0;
  private pending = 0;
  private timer: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  private stalledSince: number | null = null;
  private stallWarned = false;
  private overflowWarned = false;
  private closed = false;

  private readonly now: () => number;

  constructor(
    private readonly fd: number,
    private readonly label: string,
    private readonly log: PtyWriterLog,
    private readonly options: PtyWriterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.identity = identityOf(fd);
  }

  /** 積著還沒寫進 PTY 的位元組數（診斷用）。 */
  get pendingBytes(): number {
    return this.pending;
  }

  write(data: string): void {
    if (this.closed || data.length === 0) return;
    const bytes = Buffer.from(data, 'utf8');
    if (this.pending + bytes.length > PTY_WRITE_MAX_PENDING_BYTES) {
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.log.warn(
          `${this.label}：agent 沒有在讀輸入，積了 ${this.pending} bytes，之後的輸入先丟掉`,
        );
        this.options.onOverflow?.();
      }
      return;
    }
    this.queue.push(bytes);
    this.pending += bytes.length;
    if (!this.timer) this.flush();
  }

  /** agent 結束（或 PTY 關了）：丟掉沒寫進去的，不再寫。 */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.pending = 0;
    this.offset = 0;
  }

  /** fd 還是不是當初那個 PTY（編號被關掉又分給別的檔案時 dev／ino／rdev 會不一樣）。 */
  private sameFd(): boolean {
    const current = identityOf(this.fd);
    if (!current || !this.identity) return false;
    return (
      current.dev === this.identity.dev &&
      current.ino === this.identity.ino &&
      current.rdev === this.identity.rdev
    );
  }

  private flush(): void {
    this.timer = null;
    while (!this.closed && this.queue.length > 0) {
      if (this.options.isOpen && !this.options.isOpen()) {
        // PTY 已關（agent 結束中，exit 還沒到）：fd 編號隨時可能被下一個 session 重用，不再寫。
        this.close();
        return;
      }
      if (!this.sameFd()) {
        this.log.warn(`${this.label}：PTY 已經關閉（fd ${this.fd} 不是原本的 PTY），不再寫入`);
        this.close();
        return;
      }
      const head = this.queue[0]!;
      let written: number;
      try {
        written = writeSync(this.fd, head, this.offset, head.length - this.offset);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR') {
          this.scheduleRetry();
          return;
        }
        // EIO（agent 剛結束）、EBADF 等：這批輸入送不到了。
        this.log.warn(`${this.label}：寫入 PTY 失敗（${code}），丟掉 ${this.pending} bytes 輸入`);
        this.queue.length = 0;
        this.pending = 0;
        this.offset = 0;
        return;
      }
      this.offset += written;
      this.pending -= written;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    this.retryMs = RETRY_MIN_MS;
    this.stalledSince = null;
    this.stallWarned = false;
    this.overflowWarned = false;
  }

  private scheduleRetry(): void {
    const now = this.now();
    this.stalledSince ??= now;
    if (!this.stallWarned && now - this.stalledSince >= PTY_WRITE_STALL_WARN_MS) {
      this.stallWarned = true;
      this.log.warn(
        `${this.label}：agent ${Math.round((now - this.stalledSince) / 1000)} 秒沒有讀輸入（積了 ${this.pending} bytes）`,
      );
    }
    this.timer = setTimeout(() => this.flush(), this.retryMs);
    this.timer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }
}
