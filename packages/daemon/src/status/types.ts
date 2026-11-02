// Agent A 與 Agent B 的介面（CONTRACTS.md §5.1）。A 呼叫，B 實作。
import type { HookEventName, HookPayload, SessionStatus } from '@agent-board/protocol';

export interface StatusChange {
  from: SessionStatus;
  to: SessionStatus;
  /** 例如 `hook:Stop`、`output:rate-limit`、`timer:stuck`，寫進 session_events。 */
  reason: string;
  detail: string | null;
  at: Date;
}

export interface StatusTrackerOptions {
  stuckMinutes: number;
  /** 測試注入假時鐘用。 */
  now?: () => Date;
  onChange: (change: StatusChange) => void;
}

export interface StatusTracker {
  readonly status: SessionStatus;
  /** claude 回報的 id；`/clear` 之類的動作會讓它改變。 */
  readonly claudeSessionId: string | null;
  onHook(event: HookEventName, payload: HookPayload): void;
  /** 原始輸出，用來偵測限流。TUI 的計時器每秒重畫，所以有輸出不代表有進展。 */
  onOutput(data: string): void;
  /** 畫面內容真的變了（排除計時器與動畫），stuck 的計時以此為準。 */
  onProgress(): void;
  onExit(exitCode: number): void;
  setStuckMinutes(minutes: number): void;
  dispose(): void;
}

export type CreateStatusTracker = (options: StatusTrackerOptions) => StatusTracker;
