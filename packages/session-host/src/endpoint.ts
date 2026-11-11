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
/** 執行外部指令（測試換成假的）：回 stdout，失敗丟例外。extraEnv 會加進子程序的環境變數。 */
export type RunSync = (file: string, args: string[], extraEnv?: Record<string, string>) => string;

const defaultRunSync: RunSync = (file, args, extraEnv) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

/**
 * 這個程序設過 ACL 的資料夾與結果（每個資料夾每次啟動只做一次；複查 R2：失敗也記住，不會每寫一次快照就同步重跑
 * whoami＋icacls）。值是 null＝成功；Error＝失敗（之後照樣丟同一個錯）。
 */
const lockedDirs = new Map<string, Error | null>();

/** 只給測試：忘記哪些資料夾設過了。 */
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

/** 讀資料夾擁有者的 PowerShell 指令（路徑從環境變數 AB_ACL_DIR 帶進去，不經過指令字串的引號）。 */
export const OWNER_COMMAND =
  '(Get-Acl -LiteralPath $env:AB_ACL_DIR).GetOwner([System.Security.Principal.SecurityIdentifier]).Value';

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Windows（審查 W2）：Unix 的 600／700 在 Windows 沒有作用，密鑰（hook.key、host token、install-id、機器 token）
 * 的保護靠資料夾的 ACL。預設的使用者資料夾只有本人、SYSTEM、Administrators 讀得到，但 `AGENT_BOARD_DATA_DIR`
 * 指到別處（例如 `C:\agent-board`）時會繼承「Users 可讀」。
 * 1. `whoami /user` 取自己的 SID。
 * 2. 複查 R3、R4：資料夾的擁有者要是自己、Administrators 或 SYSTEM（PowerShell `Get-Acl` 的 owner SID）。其他使用者
 *    建的資料夾，擁有者隨時能改回權限、也可能事先放了東西，不用；拒絕啟動並說明。
 * 3. 拿掉繼承，只給自己與 SYSTEM 完整權限（子資料夾與檔案跟著繼承）：
 *    `icacls <dir> /inheritance:r /grant:r *<自己的 SID>:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F`。
 * 用 SID 不用名稱：不受網域名稱、語系（「SYSTEM」的在地名稱）、引號影響；參數用陣列傳、不經過 shell。
 * whoami／icacls／PowerShell 都用 System32 的絕對路徑。任何一步失敗就丟例外（呼叫端拒絕啟動並說明）。
 */
/** 可以當資料夾擁有者的 SID：自己、Administrators（S-1-5-32-544）、SYSTEM（S-1-5-18）。 */
const trustedOwners = (sid: string) => new Set([sid, 'S-1-5-32-544', 'S-1-5-18']);

export function restrictToCurrentUser(
  dir: string,
  { run = defaultRunSync, env = process.env }: { run?: RunSync; env?: NodeJS.ProcessEnv } = {},
): void {
  let sid: string | null = null;
  try {
    sid = parseWhoamiSid(run(system32('whoami.exe', env), ['/user', '/fo', 'csv', '/nh']));
  } catch (error) {
    throw new Error(
      `讀不到目前使用者的 SID（whoami 失敗：${describe(error)}），不能確定 ${dir} 只有自己讀得到，不啟動。`,
    );
  }
  if (!sid) throw new Error(`讀不到目前使用者的 SID，不能確定 ${dir} 只有自己讀得到，不啟動。`);
  let owner = '';
  try {
    owner = run(
      system32('WindowsPowerShell\\v1.0\\powershell.exe', env),
      ['-NoProfile', '-NonInteractive', '-Command', OWNER_COMMAND],
      { AB_ACL_DIR: dir },
    ).trim();
  } catch (error) {
    throw new Error(
      `讀不到 ${dir} 的擁有者（${describe(error)}），不能確定是自己的資料夾，不啟動。`,
    );
  }
  // 要防的是「權限比自己低的其他使用者」：Administrators 與 SYSTEM 本來就比自己權限高，擁有者是它們也接受
  // （在系統管理員權限的 PowerShell 跑安裝程式時，資料夾擁有者預設是 Administrators；複查 R4）。
  if (!trustedOwners(sid).has(owner)) {
    throw new Error(
      `${dir} 的擁有者（${owner || '不明'}）不是目前使用者（${sid}）。裡面要放密鑰，別人的資料夾不用：` +
        '請改用自己建立的資料夾（或預設的使用者資料夾），再重新啟動。',
    );
  }
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
      `無法把 ${dir} 設成只有目前使用者（與 SYSTEM）讀得到（icacls 失敗：${describe(error)}）。` +
        '裡面有密鑰，所以不啟動。請確認這個資料夾是自己的（或改用預設的資料夾），再重新啟動。',
    );
  }
}

/**
 * 資料夾 700（裡面有機器 token、MCP 密鑰、socket）。Windows 改成用 ACL 只給目前使用者與 SYSTEM
 * （restrictToCurrentUser）。每個資料夾每次啟動只做一次，結果（含失敗）記住：失敗之後再呼叫照樣丟同一個錯，
 * 但不再重跑外部指令（複查 R2）。子資料夾用 ensurePrivateSubdir（Windows 只建資料夾，繼承上層的 ACL）。
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
  if (lockedDirs.has(key)) {
    const failure = lockedDirs.get(key);
    if (failure) throw failure;
    return;
  }
  try {
    restrictToCurrentUser(key, options);
    lockedDirs.set(key, null);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    lockedDirs.set(key, failure);
    throw failure;
  }
}

/**
 * dataDir 底下的子資料夾（例如 `state\`）：Mac／Linux 一樣 700；Windows 只建資料夾，ACL 繼承 dataDir 的
 * （dataDir 由 ensurePrivateDir 設好，複查 R2：不對每個子資料夾重跑 whoami＋icacls）。
 */
export function ensurePrivateSubdir(
  dir: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') chmodSync(dir, 0o700);
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
