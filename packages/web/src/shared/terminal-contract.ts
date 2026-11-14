import type { ClientToHub, HubToClient } from '@agent-board/protocol';

/** terminal.size 只有真 hub 會送；假 PTY 不送時，終端機一律自己 fit 並送 resize。 */
export type TerminalServerMessage = Extract<
  HubToClient,
  { type: 'terminal.snapshot' | 'terminal.output' | 'terminal.size' }
>;

/** 終端機資料的來源。真實環境接 WebSocket，測試接假 PTY。 */
export interface TerminalStream {
  /** 訂閱並開始收資料；回傳值用來退訂。 */
  subscribe(sessionId: string, onMessage: (message: TerminalServerMessage) => void): () => void;
  send(
    message: Extract<
      ClientToHub,
      { type: 'terminal.input' | 'terminal.resize' | 'terminal.signal' }
    >,
  ): void;
}

export interface TerminalViewProps {
  sessionId: string;
  stream: TerminalStream;
  /** false 時暫停繪製，不取消訂閱（畫面外的卡片）。 */
  visible?: boolean;
  /** 自動取得焦點（放大或展開時）。程式 focus 不會搶尺寸，使用者打字或點擊才會。 */
  autoFocus?: boolean;
  /**
   * PTY 尺寸由誰決定（CONTRACTS §6.1 第 6 點）：other 表示照另一個畫面的尺寸縮放顯示。
   * null 表示 hub 沒有告知（假 PTY）。給外框顯示說明用；xterm 內不疊東西。
   */
  onSizeOwnerChange?: (owner: 'you' | 'other' | 'none' | null) => void;
  /** 捲動保留行數。預設 1000（全尺寸頁）；畫布小卡用 300 省記憶體，展開時改回 1000。 */
  scrollback?: number;
  /**
   * 看得到時要不要用 WebGL renderer（預設 true；實際給不給由全頁配額決定）。
   * 畫布卡一律 false（換 renderer 會改字元格寬度而送 resize），只有全尺寸頁用 WebGL。
   */
  webgl?: boolean;
  className?: string;
}
