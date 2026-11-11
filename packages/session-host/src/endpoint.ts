// session host 的位置與驗證檔（CONTRACTS §20.1）。daemon 與 session host 共用，兩邊才找得到同一個地方。
// Mac／Linux：Unix socket `<dataDir>/session-host.sock`（檔案 600、資料夾 700）；
// Windows：named pipe `\\.\pipe\agent-board-session-host-<使用者>`（未在 Windows 實測）。
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import {
  SESSION_HOST_PIPE_PREFIX,
  SESSION_HOST_SOCKET_FILE,
  SESSION_HOST_TOKEN_FILE,
} from '@agent-board/protocol/session-host';

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

/** 每份安裝（每個資料夾）一個隨機亂數，存在 `<dataDir>/install-id`（600）。Windows 的 pipe 名稱用它。 */
export const INSTALL_ID_FILE = 'install-id';

export function installId(dataDir: string): string {
  const file = join(dataDir, INSTALL_ID_FILE);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{16,64}$/.test(existing)) return existing;
  } catch {
    // 還沒有：下面建一個
  }
  ensurePrivateDir(dataDir);
  const id = randomBytes(16).toString('hex');
  try {
    // wx：另一個程序剛好同時建立時，用先寫好的那份。
    writeFileSync(file, `${id}\n`, { mode: 0o600, flag: 'wx' });
    return id;
  } catch {
    return readFileSync(file, 'utf8').trim();
  }
}

export function hostEndpoint(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): HostEndpoint {
  const tokenPath = join(dataDir, SESSION_HOST_TOKEN_FILE);
  if (platform === 'win32') {
    // 名稱裡有每份安裝的隨機亂數（installId）：別的使用者猜不到名稱，搶不到先開同名 pipe（W5）。
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\${SESSION_HOST_PIPE_PREFIX}${safeName(userInfo().username)}-${installId(dataDir)}`,
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

/** 執行外部指令（測試換成假的）：回 stdout，失敗丟例外。 */
export type RunSync = (file: string, args: string[]) => string;

const defaultRunSync: RunSync = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** 這個程序已經鎖好的資料夾（每個資料夾每次啟動只做一次）。 */
const lockedDirs = new Set<string>();

/** 只給測試：忘記哪些資料夾鎖過了。 */
export function forgetLockedDirs(): void {
  lockedDirs.clear();
}

const system32 = (exe: string, env: NodeJS.ProcessEnv = process.env): string =>
  win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', exe);

/** `whoami /user /fo csv /nh` 的輸出 → 目前使用者的 SID（`S-1-5-21-…`）；認不得回 null。 */
export function parseWhoamiSid(text: string): string | null {
  const match = /"(S-1-[\d-]+)"\s*$/m.exec(text.trim());
  return match ? match[1]! : null;
}

/**
 * Windows（審查 W2）：Unix 的 600／700 在 Windows 沒有作用，密鑰（hook.key、host token、install-id、機器 token）
 * 的保護靠資料夾的 ACL。預設的使用者資料夾只有本人、SYSTEM、Administrators 讀得到，但 `AGENT_BOARD_DATA_DIR`
 * 指到別處（例如 `C:\agent-board`）時會繼承「Users 可讀」。所以拿掉繼承，只給目前使用者與 SYSTEM 完整權限
 * （子資料夾與檔案跟著繼承）：`icacls <dir> /inheritance:r /grant:r *<自己的 SID>:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F`。
 * 用 SID 不用名稱：不受網域名稱、語系（「SYSTEM」的在地名稱）、引號影響；參數用陣列傳、不經過 shell。
 * whoami／icacls 用 System32 的絕對路徑。失敗就丟例外（呼叫端拒絕啟動並說明）。
 */
export function restrictToCurrentUser(
  dir: string,
  { run = defaultRunSync, env = process.env }: { run?: RunSync; env?: NodeJS.ProcessEnv } = {},
): void {
  let sid: string | null = null;
  try {
    sid = parseWhoamiSid(run(system32('whoami.exe', env), ['/user', '/fo', 'csv', '/nh']));
  } catch (error) {
    throw new Error(
      `讀不到目前使用者的 SID（whoami 失敗：${error instanceof Error ? error.message : String(error)}），不能確定 ${dir} 只有自己讀得到，不啟動。`,
    );
  }
  if (!sid) throw new Error(`讀不到目前使用者的 SID，不能確定 ${dir} 只有自己讀得到，不啟動。`);
  try {
    run(system32('icacls.exe', env), [
      dir,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '/grant:r',
      '*S-1-5-18:(OI)(CI)F',
    ]);
  } catch (error) {
    throw new Error(
      `無法把 ${dir} 設成只有目前使用者（與 SYSTEM）讀得到（icacls 失敗：${error instanceof Error ? error.message : String(error)}）。` +
        '裡面有密鑰，所以不啟動。請確認這個資料夾是自己的（或改用預設的資料夾），再重新啟動。',
    );
  }
}

/**
 * 資料夾 700（裡面有機器 token、MCP 密鑰、socket）。Windows 改成用 ACL 只給目前使用者與 SYSTEM
 * （restrictToCurrentUser，每個資料夾每次啟動做一次；失敗丟例外）。
 */
export function ensurePrivateDir(
  dir: string,
  options: {
    platform?: NodeJS.Platform;
    run?: RunSync;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    chmodSync(dir, 0o700);
    return;
  }
  const key = resolve(dir);
  if (lockedDirs.has(key)) return;
  restrictToCurrentUser(key, options);
  lockedDirs.add(key);
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
