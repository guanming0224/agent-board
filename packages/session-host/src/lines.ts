// NDJSON：一行一則。超過上限就當成壞掉的連線（呼叫端斷線）。
import type { Socket } from 'node:net';
import { SESSION_HOST_MAX_LINE_BYTES } from '@agent-board/protocol/session-host';

export function onLines(
  socket: Socket,
  onLine: (line: string) => void,
  onOverflow: () => void,
): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
      newline = buffer.indexOf('\n');
    }
    // 字元數 ≤ 位元組數，用長度粗估就夠擋住惡意或壞掉的對方。
    if (buffer.length > SESSION_HOST_MAX_LINE_BYTES) {
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
