// hook CLI 與 MCP server 連 daemon 前先確認對方真的是 daemon（W5，CONTRACTS §4.2、§20.7）。
// 送 `auth.challenge{nonce}`，daemon 用 `<dataDir>/hook.key` 回 `auth.proof`；驗過才送請求（請求裡有工具輸入、MCP 密鑰）。
// 別的程序搶先開了同名 pipe（Windows）也拿不到請求內容、也不能冒充 daemon 回答危險指令檢查。
// 只用 node 內建模組（跑在每次工具呼叫的路徑上，不載入 zod）。
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { newNonce, verifyLocalProof } from '@agent-board/protocol/local-auth';

/** daemon 傳給 agent 的密鑰檔路徑（protocol 的 HOOK_ENV.keyFile）。 */
export const KEY_FILE_ENV = 'AGENT_BOARD_HOOK_KEY_FILE';
/** Codex 的 hook 指令直接帶（protocol 的 HOOK_KEY_FILE_FLAG）。 */
export const KEY_FILE_FLAG = '--key-file';
/** 等 daemon 回證明的上限。舊版 daemon 不認得 auth.challenge、不會回：等到這裡就當成連不上（不重試）。 */
export const AUTH_DEADLINE_MS = 2_000;

export type DaemonKey =
  /** 讀到密鑰：先驗證再送。 */
  | { kind: 'key'; key: string }
  /**
   * 沒給密鑰檔（0.1.6 以前的 daemon 開的 agent，升級後還活著）而且是 Unix socket：照舊不驗證。
   * Unix socket 在 700 的資料夾裡，別的使用者進不去、也搶不了；Windows 的 pipe 沒有這層保護，不走這條。
   */
  | { kind: 'legacy' }
  /** 給了密鑰檔但讀不到、或是 Windows pipe 卻沒給：當成連不上，不重試。 */
  | { kind: 'missing' };

export const isPipe = (socketPath: string): boolean => socketPath.startsWith('\\\\.\\pipe\\');

export function readDaemonKey(socketPath: string, keyFile: string | null | undefined): DaemonKey {
  if (!keyFile) return isPipe(socketPath) ? { kind: 'missing' } : { kind: 'legacy' };
  try {
    const key = readFileSync(keyFile, 'utf8').trim();
    return key ? { kind: 'key', key } : { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }
}

/**
 * 在剛連上的 socket 上做一次挑戰：送 nonce、等一行 `auth.proof`。驗過回 true（socket 原樣交還，之後的資料照常讀）；
 * 驗不過、逾時、斷線回 false（呼叫端當成連不上，不重試）。
 */
export function authenticateDaemon(
  socket: Socket,
  key: string,
  deadlineMs: number = AUTH_DEADLINE_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const nonce = newNonce();
    let buffer = '';
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onFail);
      socket.off('close', onFail);
      resolve(ok);
    };
    const onFail = () => done(false);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.length > 4096) return done(false);
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let reply: unknown;
      try {
        reply = JSON.parse(buffer.slice(0, newline));
      } catch {
        return done(false);
      }
      const r = (reply ?? {}) as { type?: unknown; proof?: unknown };
      done(r.type === 'auth.proof' && verifyLocalProof(key, 'hookServer', nonce, r.proof));
    };
    const timer = setTimeout(() => done(false), deadlineMs);
    socket.on('data', onData);
    socket.on('error', onFail);
    socket.on('close', onFail);
    socket.write(`${JSON.stringify({ type: 'auth.challenge', nonce })}\n`);
  });
}
