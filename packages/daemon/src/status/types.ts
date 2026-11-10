// Agent A 與 Agent B 的介面（CONTRACTS.md §5.1）。A 呼叫，B 實作。
import type { HookEventName, HookPayload, SessionStatus } from '@agent-board/protocol';

/** `from` 等於 `to` 時只是補 detail（例如限流的重置時間），`at` 沿用進入該狀態的時間。 */
export interface StatusChange {
  from: SessionStatus;
  to: SessionStatus;
  /** 例如 `hook:Stop`、`output:rate-limit`、`timer:stuck`，寫進 session_events。 */
  reason: string;
  detail: string | null;
  /** 變化前的 statusDetail（狀態歷史要分得出 NEW 與 ASK）；舊的測試替身可以不給。 */
  fromDetail?: string | null;
  at: Date;
}

export interface StatusTrackerOptions {
  stuckMinutes: number;
  /** 測試注入假時鐘用。 */
  now?: () => Date;
  onChange: (change: StatusChange) => void;
}

/** daemon 重啟、從 session host 接回時載入的狀態（CONTRACTS §20.3）。 */
export interface TrackerRestoreState {
  status: SessionStatus;
  detail: string | null;
  /** 進入這個狀態的時間（statusSince）。 */
  at: Date;
  claudeSessionId: string | null;
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
  /** 畫面上出現新資料夾的信任對話框。回答前 hook 不會跑，不偵測的話會一直顯示「啟動中」。 */
  onTrustPrompt(): void;
  /**
   * 畫面已經是 CLI 的輸入畫面，但還沒收到 SessionStart（Codex 未驗證 SessionStart 是否在開啟時就送，§19.3）。
   * 還在 starting 才轉成「剛開好、閒著」，SessionStart 先到就沒事。
   */
  onReadyScreen(): void;
  onExit(exitCode: number): void;
  setStuckMinutes(minutes: number): void;
  dispose(): void;
  /**
   * 接回時載入上一個 daemon 存下的狀態。不觸發 onChange（狀態沒有變，只是換了一個 daemon 看著）。
   * 舊的測試替身可以沒有；沒有就從 starting 開始。
   */
  restore?(state: TrackerRestoreState): void;
  /**
   * 接回後用畫面補正狀態（停機期間漏掉的 hook）。和一般轉換一樣觸發 onChange；同狀態不動。
   * reason 用 `screen:*`。
   */
  correct?(to: SessionStatus, reason: string, detail: string | null): void;
}

export type CreateStatusTracker = (options: StatusTrackerOptions) => StatusTracker;
