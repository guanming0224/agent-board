// 測試用的假 session host 程式碼（寫進假發布檔的 session-host/dist/main.mjs）：和真的一樣在
// `<dataDir>/session-host.sock`（路徑太長時 `<tmpdir>/ab-host-<雜湊>/`）開 socket，開好才寫 token，
// 安裝程式換 host 後才確認得了它真的起來（W4）。
//   termDelayMs：收到 SIGTERM 之後多久才結束（真的 host 要花約 2 秒結束 agent）
//   ignoreTerm：完全不理 SIGTERM（只能被 SIGKILL：測 launchd 的 ExitTimeOut）
export function fakeHostCode({ termDelayMs = 0, ignoreTerm = false } = {}) {
  return `
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const data = resolve(process.env.AGENT_BOARD_DATA_DIR);
mkdirSync(data, { recursive: true });
let sock = join(data, 'session-host.sock');
if (Buffer.byteLength(sock) > 100) {
  const dir = join(tmpdir(), 'ab-host-' + createHash('sha256').update(data).digest('hex').slice(0, 12));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sock = join(dir, 'session-host.sock');
}
rmSync(sock, { force: true });
createServer((c) => c.end()).listen(sock, () => writeFileSync(join(data, 'session-host.token'), String(process.pid)));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  if (${ignoreTerm}) return;
  setTimeout(() => process.exit(0), ${termDelayMs});
});
`;
}
