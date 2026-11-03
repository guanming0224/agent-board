/** cols/rows 沒變就不送。快照帶來的尺寸是 PTY 目前的實際尺寸，要用 sync 記下。 */
export class ResizeGate {
  private cols: number | null = null;
  private rows: number | null = null;

  sync(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /** 忘掉記下的尺寸：下一次一定送（還沒人擁有尺寸時，送出去才會成為擁有者）。 */
  reset(): void {
    this.cols = null;
    this.rows = null;
  }

  shouldSend(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows) return false;
    this.sync(cols, rows);
    return true;
  }
}

export function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    call() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel,
  };
}

export type SizeOwner = 'you' | 'other' | 'none';

/**
 * 多個瀏覽器看同一個 session 時，PTY 尺寸由誰決定（CONTRACTS §6.1 第 6 點）。
 * owner 為 null 表示沒收過 terminal.size（假 PTY、舊 hub）：照舊自己 fit 並送 resize。
 */
export class SizeOwnership {
  owner: SizeOwner | null = null;
  remote: { cols: number; rows: number } | null = null;

  update(owner: SizeOwner, cols: number, rows: number): void {
    this.owner = owner;
    this.remote = { cols, rows };
  }

  /** 尺寸屬於別人：照遠端尺寸顯示，不送 resize。 */
  get following(): boolean {
    return this.owner === 'other' && this.remote !== null;
  }

  /** 使用者在這個終端機打字或點擊。回傳 true 表示要送帶 claim 的 resize 搶下擁有權。 */
  claim(): boolean {
    if (this.owner !== 'other') return false;
    // 先當作已經拿到，hub 的 terminal.size 隨後確認；之後的 resize 照常送。
    this.owner = 'you';
    return true;
  }
}

/** 照遠端尺寸顯示時要縮多少才放得進容器。只縮不放大：遠端比較小就留白（letterbox）。 */
export function followScale(
  natural: { width: number; height: number },
  box: { width: number; height: number },
): number {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}
