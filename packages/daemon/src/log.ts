// 執行紀錄一律走 stderr。不可記錄 token、終端機內容、prompt 或工具輸入。
export type Logger = Pick<typeof console, 'info' | 'warn' | 'error'>;

export const log: Logger = {
  info: (...args) => console.error('[agent-board-daemon]', ...args),
  warn: (...args) => console.error('[agent-board-daemon] WARN', ...args),
  error: (...args) => console.error('[agent-board-daemon] ERROR', ...args),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
