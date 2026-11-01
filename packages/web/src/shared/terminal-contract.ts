import type { ClientToHub, HubToClient } from '@agent-board/protocol';

export type TerminalServerMessage = Extract<
  HubToClient,
  { type: 'terminal.snapshot' | 'terminal.output' }
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
  /** 自動取得焦點（放大或展開時）。 */
  autoFocus?: boolean;
  className?: string;
}
