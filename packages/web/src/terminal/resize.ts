/** cols/rows 沒變就不送。快照帶來的尺寸是 PTY 目前的實際尺寸，要用 sync 記下。 */
export class ResizeGate {
  private cols: number | null = null;
  private rows: number | null = null;

  sync(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
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
