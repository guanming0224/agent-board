// NDJSON：一行一則。超過上限就當成壞掉的連線（呼叫端斷線）。
import type { Socket } from 'node:net';
import { SESSION_HOST_MAX_LINE_BYTES } from '@agent-board/protocol/session-host';

/** 還沒通過 hello 的連線，一行的上限（hello 只有協定版本與 token）。 */
export const UNAUTHED_MAX_LINE_BYTES = 4 * 1024;

/**
 * maxLine 每次收到資料時重新讀：驗證前用小上限，驗證後放寬。
 * 只在新進來的那一段找換行（不重掃整個緩衝），大量輸出時不會變成平方時間。
 */
export function onLines(
  socket: Socket,
  onLine: (line: string) => void,
  onOverflow: () => void,
  maxLine: () => number = () => SESSION_HOST_MAX_LINE_BYTES,
): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    let from = buffer.length;
    buffer += chunk;
    let newline = buffer.indexOf('\n', from);
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
      if (socket.destroyed) return;
      from = 0;
      newline = buffer.indexOf('\n', from);
    }
    // 字元數 ≤ 位元組數，用長度粗估就夠擋住惡意或壞掉的對方。
    if (buffer.length > maxLine()) {
      buffer = '';
      onOverflow();
    }
  });
}

/** 寫一則；socket 已經關了就不寫。 */
export function sendLine(socket: Socket, message: unknown): boolean {
  if (socket.destroyed || !socket.writable) return false;
  socket.write(`${JSON.stringify(message)}\n`);
  return true;
}
