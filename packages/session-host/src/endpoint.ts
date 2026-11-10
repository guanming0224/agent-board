// session host 的位置與驗證檔（CONTRACTS §20.1）。daemon 與 session host 共用，兩邊才找得到同一個地方。
// Mac／Linux：Unix socket `<dataDir>/session-host.sock`（檔案 600、資料夾 700）；
// Windows：named pipe `\\.\pipe\agent-board-session-host-<使用者>`（未在 Windows 實測）。
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SESSION_HOST_PIPE_PREFIX,
  SESSION_HOST_SOCKET_FILE,
  SESSION_HOST_TOKEN_FILE,
} from '@agent-board/protocol';

/** macOS 的 sun_path 上限 104 bytes，保守一點（和 daemon 的 hook socket 同一個值）。 */
const MAX_UNIX_SOCKET_BYTES = 100;

export interface HostEndpoint {
  kind: 'unix' | 'pipe';
  /** net.connect／listen 用的路徑。 */
  path: string;
  tokenPath: string;
}

const shortHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 12);

/** 使用者名稱裡 pipe 名稱不接受的字元換掉。 */
const safeName = (text: string): string => text.replace(/[^\w.-]/g, '_') || 'user';

/**
 * Unix socket 路徑太長（資料夾很深）時，改放在 tmpdir 底下一個固定名稱、只有自己能進的資料夾：
 * 名稱由資料夾路徑決定（不隨機），daemon 重啟後才找得到同一個 host。
 */
export function stableShortDir(dataDir: string, prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${shortHash(resolve(dataDir))}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  // 別人先建了同名資料夾、或是符號連結：不用（可能被偷看或搶走）。
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  ) {
    throw new Error(`${dir} 不是自己建立的資料夾，不能放 socket`);
  }
  chmodSync(dir, 0o700);
  return dir;
}

export function hostEndpoint(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): HostEndpoint {
  const tokenPath = join(dataDir, SESSION_HOST_TOKEN_FILE);
  if (platform === 'win32') {
    // 預設資料夾就用使用者名稱；自訂資料夾（測試、多份安裝）再加一段雜湊，彼此才不會撞名。
    const isDefault = resolve(dataDir) === resolve(join(homedir(), '.agent-board'));
    const suffix = isDefault ? '' : `-${shortHash(resolve(dataDir))}`;
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\${SESSION_HOST_PIPE_PREFIX}${safeName(userInfo().username)}${suffix}`,
      tokenPath,
    };
  }
  const preferred = join(dataDir, SESSION_HOST_SOCKET_FILE);
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_BYTES) {
    return { kind: 'unix', path: preferred, tokenPath };
  }
  return {
    kind: 'unix',
    path: join(stableShortDir(dataDir, 'ab-host'), SESSION_HOST_SOCKET_FILE),
    tokenPath,
  };
}

/** 資料夾 700（裡面有機器 token、MCP 密鑰、socket）。 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
}

/** 先寫暫存檔、設好權限再換名：檔案從出現的那一刻起就是 600。 */
export function writePrivateFile(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** host 每次啟動產生新的 token。 */
export function writeToken(tokenPath: string): string {
  const token = randomBytes(32).toString('base64url');
  writePrivateFile(tokenPath, `${token}\n`);
  return token;
}

/** 讀不到回 null（host 沒在跑或還沒寫好）。 */
export function readToken(tokenPath: string): string | null {
  try {
    const token = readFileSync(tokenPath, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}
