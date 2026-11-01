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
  onOutput(data: string): void;
  onExit(exitCode: number): void;
  setStuckMinutes(minutes: number): void;
  dispose(): void;
}

export type CreateStatusTracker = (options: StatusTrackerOptions) => StatusTracker;
