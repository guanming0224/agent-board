// 不是 git 的資料夾一鍵 git init（GM 2026-11-13，CONTRACTS §24）。
// 只在本機：git init（分支 main）→ 沒有 .gitignore 就建一份 → 大檔寫進 .git/info/exclude → git add -A → 第一個 commit。
// 不設 remote、不 push、不改使用者的 git 設定檔（沒設定身分時只對這一次 commit 用 `-c` 帶固定值）。
// 不跑任何 hook：每個 git 指令都帶 `-c core.hooksPath=<.git 裡一個不存在的資料夾>`（蓋過使用者全域的 hooksPath，
// post-commit、reference-transaction 等都不會跑）、`-c core.fsmonitor=false`；`git init --template=` 不複製範本（範本裡可能有 hook）。
// git 一律走 worktree.ts 的 `git()`（同一個審查過的呼叫點，參數陣列、不經 shell，Windows 不用處理引號）。
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  DEFAULT_GITIGNORE_LINES,
  GIT_INIT_BRANCH,
  GIT_INIT_COMMIT_MESSAGE,
  GIT_INIT_FALLBACK_EMAIL,
  GIT_INIT_FALLBACK_NAME,
  GIT_INIT_MAX_FILE_BYTES,
  GIT_INIT_SKIPPED_LIST_MAX,
  type GitInitErrorCode,
  type GitInitResult,
  type GitInitSkipped,
} from '@agent-board/protocol';
import { errorMessage } from './log';
import { git, type GitOptions } from './worktree';

/** add／commit 可能要掃很多檔案。hub 等的時間（`Timing.gitInitTimeoutMs`）要比這個長。 */
export const GIT_INIT_STEP_TIMEOUT_MS = 5 * 60_000;
/** `ls-files -z` 的輸出上限：上萬個檔案的路徑也放得下。 */
const LIST_MAX_BUFFER = 256 * 1024 * 1024;
const STAT_CONCURRENCY = 64;
const MESSAGE_MAX = 500;
/** core.hooksPath 指到 .git 裡這個（不存在的）資料夾：一個 hook 都不跑。 */
const NO_HOOKS_DIR = 'agent-board-no-hooks';

/** 家目錄底下這些標準資料夾本身太大（整個桌面、整個文件夾），不在這裡 init；子資料夾可以。 */
export const HOME_BROAD_FOLDERS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Library',
  'Pictures',
  'Music',
  'Movies',
  'Videos',
  'Public',
  'Applications',
  'AppData',
  'OneDrive',
] as const;

/** POSIX 系統資料夾本身（含 macOS）。 */
const POSIX_SYSTEM = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/usr/local',
  '/var',
  '/Applications',
  '/Library',
  '/System',
  '/Users',
  '/Volumes',
  '/private',
  '/private/etc',
  '/private/tmp',
  '/private/var',
];
/** Windows 任一磁碟機根目錄底下的系統資料夾。 */
const WINDOWS_SYSTEM = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users'];

/** 同一個資料夾同時只做一次（兩個分頁同時按）。key 是 `comparable`（macOS／Windows 不分大小寫）。 */
const running = new Set<string>();

export interface GitInitOptions {
  /** 測試用：當成家目錄、暫存資料夾。正式是 daemon 執行帳號的 `os.homedir()`／`os.tmpdir()`。 */
  home?: string;
  tmp?: string;
  maxFileBytes?: number;
  platform?: NodeJS.Platform;
  /** 測試用：資料夾所在的裝置編號（判斷掛載點）。 */
  devOf?: (path: string) => Promise<number>;
}

const fail = (path: string, code: GitInitErrorCode, message: string): GitInitResult => ({
  ok: false,
  path,
  code,
  message: message.slice(0, MESSAGE_MAX),
});

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** 比較用：去掉結尾分隔字元；Windows、macOS 的檔案系統預設不分大小寫。 */
function comparable(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, '') || path : path;
  const unified = platform === 'win32' ? trimmed.replaceAll('/', '\\') : trimmed;
  return platform === 'win32' || platform === 'darwin' ? unified.toLowerCase() : unified;
}

/**
 * 太大的位置（不 init）：根目錄、磁碟或網路碟的根目錄（掛載點）、家目錄本身與它的上層、家目錄底下的標準大資料夾、
 * 家目錄底下以 `.` 開頭的資料夾（含裡面）、iCloud／雲端硬碟的根目錄、系統資料夾、暫存資料夾本身。
 * 回傳原因（英文），可以 init 時回 null。`dir` 是已解析符號連結的絕對路徑。
 */
export async function tooBroadReason(
  dir: string,
  options: GitInitOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const key = comparable(dir, platform);
  const separator = platform === 'win32' ? '\\' : '/';
  if (dirname(dir) === dir || /^[a-z]:\\?$/i.test(key)) return 'it is the root of the file system';
  const home = comparable(await realOrSelf(options.home ?? homedir()), platform);
  const under = (path: string) => comparable(`${home}${separator}${path}`, platform);
  if (key === home) return 'it is your home folder';
  if (home.startsWith(`${key}${separator}`)) return 'it contains your home folder';
  for (const name of HOME_BROAD_FOLDERS) {
    if (key === under(name)) {
      return `it is the whole ${name} folder; choose a project folder inside it`;
    }
  }
  if (key.startsWith(`${home}${separator}`)) {
    const first = key.slice(home.length + 1).split(separator)[0] ?? '';
    if (first.startsWith('.')) return 'it is inside a hidden folder of your home folder';
  }
  const icloud = under(`Library${separator}Mobile Documents${separator}com~apple~CloudDocs`);
  const cloudStorage = under(`Library${separator}CloudStorage`);
  if (key === icloud) return 'it is the root of iCloud Drive';
  if (key === cloudStorage || dirname(key) === cloudStorage) {
    return 'it is the root of a cloud storage drive';
  }
  const temp = await realOrSelf(options.tmp ?? tmpdir());
  if (key === comparable(temp, platform) || key === comparable(options.tmp ?? tmpdir(), platform)) {
    return 'it is the temporary folder itself';
  }
  if (platform === 'win32') {
    const rest = key.replace(/^[a-z]:\\/, '');
    if (WINDOWS_SYSTEM.some((name) => rest === name.toLowerCase())) return 'it is a system folder';
    return null;
  }
  if (POSIX_SYSTEM.some((p) => key === comparable(p, platform))) return 'it is a system folder';
  // 掛載點（外接碟、網路碟的根目錄）：和上層不在同一個裝置。裡面的專案資料夾照常可以。
  const devOf = options.devOf ?? (async (p: string) => (await stat(p)).dev);
  try {
    if ((await devOf(dir)) !== (await devOf(dirname(dir)))) {
      return 'it is the root of a disk or network drive';
    }
  } catch {
    // 讀不到就不判斷（後面 git 自己會失敗）
  }
  return null;
}

/** git 失敗時給人看的那一段：stderr 優先。 */
function gitError(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : errorMessage(error);
  return text.slice(0, MESSAGE_MAX);
}

const isMissing = (error: unknown) => (error as { code?: unknown }).code === 'ENOENT';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 寫進 `.git/info/exclude` 的一行：以 `/` 開頭只比對這個位置，萬用字元與 `#`、`!`、結尾空白都跳脫。 */
export function excludeLine(relPath: string): string | null {
  if (/[\r\n]/.test(relPath)) return null; // 檔名有換行寫不進排除清單
  const escaped = relPath
    .replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)
    .replace(/ +$/, (s) => '\\ '.repeat(s.length));
  return `/${escaped}`;
}

/** 在 dir 跑 git：一律不跑 hook、不用 fsmonitor（只對這一次指令，不寫設定檔）。 */
function gitIn(dir: string, args: string[], options?: GitOptions): Promise<string> {
  return git(
    [
      '-c',
      `core.hooksPath=${join(dir, '.git', NO_HOOKS_DIR)}`,
      '-c',
      'core.fsmonitor=false',
      '-C',
      dir,
      ...args,
    ],
    options,
  );
}

/** 還沒進版控、也沒被忽略的檔案裡，超過上限的（相對路徑、`/` 分隔）。 */
async function largeFiles(dir: string, max: number): Promise<GitInitSkipped[]> {
  const out = await gitIn(dir, ['ls-files', '-z', '--others', '--exclude-standard'], {
    raw: true,
    maxBuffer: LIST_MAX_BUFFER,
    timeoutMs: GIT_INIT_STEP_TIMEOUT_MS,
  });
  const files = out.split('\0').filter((p) => p !== '');
  const large: GitInitSkipped[] = [];
  for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
    const batch = files.slice(i, i + STAT_CONCURRENCY);
    const sizes = await Promise.all(
      batch.map((rel) =>
        lstat(join(dir, rel)).then(
          (s) => (s.isFile() ? s.size : 0),
          () => 0,
        ),
      ),
    );
    sizes.forEach((bytes, j) => {
      if (bytes > max) large.push({ path: batch[j]!, bytes });
    });
  }
  return large.sort((a, b) => b.bytes - a.bytes);
}

/** 沒設定 user.name／user.email（任一個）就回 false：這次 commit 用固定身分。 */
async function hasIdentity(dir: string): Promise<boolean> {
  try {
    const [name, email] = await Promise.all([
      gitIn(dir, ['config', 'user.name']),
      gitIn(dir, ['config', 'user.email']),
    ]);
    return name !== '' && email !== '';
  } catch {
    return false;
  }
}

/** 路徑裡有一段是 `.git`（在 git 資料夾裡面）。 */
const insideDotGit = (dir: string) =>
  dir.split(/[\\/]/).some((part) => part.toLowerCase() === '.git');

export async function gitInitFolder(
  rawPath: string,
  options: GitInitOptions = {},
): Promise<GitInitResult> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const expanded =
    rawPath === '~'
      ? home
      : rawPath.startsWith('~/') || rawPath.startsWith('~\\')
        ? join(home, rawPath.slice(2))
        : rawPath;
  if (!isAbsolute(expanded)) return fail(rawPath, 'not_absolute', 'The path must be absolute');
  let dir: string;
  try {
    const info = await stat(expanded);
    if (!info.isDirectory()) return fail(expanded, 'not_directory', 'Not a folder');
    dir = await realpath(expanded);
  } catch (error) {
    return fail(expanded, 'not_found', `Folder not found (${errorMessage(error)})`);
  }
  if (insideDotGit(dir)) return fail(dir, 'already_repo', 'This folder is inside a .git folder');
  const broad = await tooBroadReason(dir, options);
  if (broad) return fail(dir, 'too_broad', `Not initialized here: ${broad}`);
  const key = comparable(dir, platform);
  if (running.has(key)) {
    return fail(dir, 'busy', 'Another git init is already running in this folder');
  }
  running.add(key);
  try {
    return await initLocked(dir, options);
  } finally {
    running.delete(key);
  }
}

async function initLocked(dir: string, options: GitInitOptions): Promise<GitInitResult> {
  try {
    await git(['--version']);
  } catch (error) {
    return isMissing(error)
      ? fail(dir, 'git_missing', 'git is not installed on this machine (or not on PATH)')
      : fail(dir, 'git_failed', gitError(error));
  }
  // 已在 repo 裡（含上層）→ 不動。只有 git 明說「not a git repository」才繼續；
  // 其他失敗（dubious ownership、權限…）一律停下，不然會在別人的 repo 裡 init 出巢狀 repo。
  try {
    const gitDir = await git(['-C', dir, 'rev-parse', '--absolute-git-dir']);
    return fail(dir, 'already_repo', `This folder is already inside the git repository ${gitDir}`);
  } catch (error) {
    if (isMissing(error)) {
      return fail(dir, 'git_missing', 'git is not installed on this machine (or not on PATH)');
    }
    if (!/not a git repository/i.test(gitError(error))) {
      return fail(dir, 'git_failed', gitError(error));
    }
  }

  const gitignore = join(dir, '.gitignore');
  const gitDir = join(dir, '.git');
  // 先自己建 .git（不遞迴）：已經有了（別人剛好也在建）就是 already_repo；建成了才算「這次建的」，失敗時才刪。
  try {
    await mkdir(gitDir);
  } catch (error) {
    return (error as { code?: unknown }).code === 'EEXIST'
      ? fail(dir, 'already_repo', 'This folder already has a .git')
      : fail(dir, 'git_failed', errorMessage(error));
  }
  let gitignoreCreated = false;
  try {
    if (!(await exists(gitignore))) {
      // wx：剛好有人同時建了就不覆寫（丟出 EEXIST，當成已有）。
      await writeFile(gitignore, `${DEFAULT_GITIGNORE_LINES.join('\n')}\n`, { flag: 'wx' }).then(
        () => {
          gitignoreCreated = true;
        },
        (error: unknown) => {
          if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
        },
      );
    }
    // --template=：不複製任何範本（使用者的 init.templateDir 裡可能有 hook）。
    await gitIn(dir, ['init', '-q', '--template=']);
    // `init -b` 要 git 2.28；還沒有 commit 時改 HEAD 指向哪個分支，舊版也能用。
    await gitIn(dir, ['symbolic-ref', 'HEAD', `refs/heads/${GIT_INIT_BRANCH}`]);

    const max = options.maxFileBytes ?? GIT_INIT_MAX_FILE_BYTES;
    const large = await largeFiles(dir, max);
    const lines: string[] = ['.claude/settings.local.json'];
    for (const file of large) {
      const line = excludeLine(file.path);
      // 寫不進排除清單的大檔：不能回報「略過」卻 commit 進去，整次失敗、還原。
      if (line === null) {
        throw new Error(
          `A file over ${Math.round(max / 1024 / 1024)} MB has a line break in its name and cannot be left out: ${JSON.stringify(file.path)}`,
        );
      }
      lines.push(line);
    }
    // hook 設定（含這台的路徑）一律不進版控；大檔也寫進排除清單（只在這台、不改 .gitignore）。
    const excludeFile = join(gitDir, 'info', 'exclude');
    await mkdir(dirname(excludeFile), { recursive: true });
    const before = await readFile(excludeFile, 'utf8').catch(() => '');
    await writeFile(
      excludeFile,
      `${before}${before && !before.endsWith('\n') ? '\n' : ''}# Agent Board git init（超過大小上限的檔案與 hook 設定，只在這台）\n${lines.join('\n')}\n`,
    );

    await gitIn(dir, ['add', '-A'], { timeoutMs: GIT_INIT_STEP_TIMEOUT_MS });
    const identity = (await hasIdentity(dir)) ? 'user' : 'fallback';
    await gitIn(
      dir,
      [
        ...(identity === 'fallback'
          ? [
              '-c',
              `user.name=${GIT_INIT_FALLBACK_NAME}`,
              '-c',
              `user.email=${GIT_INIT_FALLBACK_EMAIL}`,
            ]
          : []),
        // 只對這一次：不簽章（沒設定金鑰會失敗）。
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--no-verify',
        '--allow-empty',
        '-m',
        GIT_INIT_COMMIT_MESSAGE,
      ],
      { timeoutMs: GIT_INIT_STEP_TIMEOUT_MS },
    );
    // commit 已經成功：之後只是統計，失敗也不還原（回 0／空字串）。
    const commit = await gitIn(dir, ['rev-parse', 'HEAD']).catch(() => '');
    const tracked = await gitIn(dir, ['ls-files', '-z'], {
      raw: true,
      maxBuffer: LIST_MAX_BUFFER,
      timeoutMs: GIT_INIT_STEP_TIMEOUT_MS,
    }).catch(() => '');
    return {
      ok: true,
      path: dir,
      branch: GIT_INIT_BRANCH,
      commit,
      gitignoreCreated,
      identity,
      files: tracked.split('\0').filter((p) => p !== '').length,
      skipped: large.slice(0, GIT_INIT_SKIPPED_LIST_MAX),
      skippedMore: Math.max(0, large.length - GIT_INIT_SKIPPED_LIST_MAX),
    };
  } catch (error) {
    // 走到這裡一定還沒 commit（commit 之後的統計都各自 catch）。做到一半（含逾時被殺）：收掉這次建的 .git 與 .gitignore，資料夾回到原樣（使用者的檔案沒被動過）。
    await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
    if (gitignoreCreated) await rm(gitignore, { force: true }).catch(() => undefined);
    return isMissing(error)
      ? fail(dir, 'git_missing', 'git is not installed on this machine (or not on PATH)')
      : fail(dir, 'git_failed', gitError(error));
  }
}

/** `child` 在 `parent` 裡面（或就是它）。兩邊都要是 realpath。 */
export function isInside(child: string, parent: string, platform = process.platform): boolean {
  const c = comparable(child, platform);
  const p = comparable(parent, platform);
  const separator = platform === 'win32' ? '\\' : sep;
  return c === p || c.startsWith(p.endsWith(separator) ? p : `${p}${separator}`);
}
