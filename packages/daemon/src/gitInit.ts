// 不是 git 的資料夾一鍵 git init（GM 2026-11-13，CONTRACTS §24）。
// 只在本機：git init（分支 main）→ 沒有 .gitignore 就建一份 → 大檔寫進 .git/info/exclude → git add -A → 第一個 commit。
// 不設 remote、不 push、不改使用者的 git 設定檔（沒設定身分時只對這一次 commit 用 `-c` 帶固定值）。
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
import { git } from './worktree';

/** add／commit 可能要掃很多檔案。hub 等的時間（`Timing.gitInitTimeoutMs`）要比這個長。 */
export const GIT_INIT_STEP_TIMEOUT_MS = 5 * 60_000;
/** `ls-files -z` 的輸出上限：上萬個檔案的路徑也放得下。 */
const LIST_MAX_BUFFER = 256 * 1024 * 1024;
const STAT_CONCURRENCY = 64;
const MESSAGE_MAX = 500;

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

/** 同一個資料夾同時只做一次（兩個分頁同時按）。 */
const running = new Set<string>();

export interface GitInitOptions {
  /** 測試用：當成家目錄、暫存資料夾。 */
  home?: string;
  tmp?: string;
  maxFileBytes?: number;
  platform?: NodeJS.Platform;
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
 * 太大的位置（不 init）：根目錄、家目錄本身與它的上層、家目錄底下的標準大資料夾、系統資料夾、暫存資料夾本身。
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
  if (key === home) return 'it is your home folder';
  if (home.startsWith(`${key}${separator}`)) return 'it contains your home folder';
  for (const name of HOME_BROAD_FOLDERS) {
    if (key === comparable(`${home}${separator}${name}`, platform)) {
      return `it is the whole ${name} folder; choose a project folder inside it`;
    }
  }
  const temp = await realOrSelf(options.tmp ?? tmpdir());
  if (key === comparable(temp, platform) || key === comparable(options.tmp ?? tmpdir(), platform)) {
    return 'it is the temporary folder itself';
  }
  if (platform === 'win32') {
    const rest = key.replace(/^[a-z]:\\/, '');
    if (WINDOWS_SYSTEM.some((name) => rest === name.toLowerCase())) return 'it is a system folder';
  } else if (POSIX_SYSTEM.some((p) => key === comparable(p, platform))) {
    return 'it is a system folder';
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

/** 還沒進版控、也沒被忽略的檔案裡，超過上限的（相對路徑、`/` 分隔）。 */
async function largeFiles(dir: string, max: number): Promise<GitInitSkipped[]> {
  const out = await git(['-C', dir, 'ls-files', '-z', '--others', '--exclude-standard'], {
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
      git(['-C', dir, 'config', 'user.name']),
      git(['-C', dir, 'config', 'user.email']),
    ]);
    return name !== '' && email !== '';
  } catch {
    return false;
  }
}

export async function gitInitFolder(
  rawPath: string,
  options: GitInitOptions = {},
): Promise<GitInitResult> {
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
  const broad = await tooBroadReason(dir, options);
  if (broad) return fail(dir, 'too_broad', `Not initialized here: ${broad}`);
  if (running.has(dir)) {
    return fail(dir, 'git_failed', 'Another git init is already running in this folder');
  }
  running.add(dir);
  try {
    return await initLocked(dir, options);
  } finally {
    running.delete(dir);
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
  if (await exists(join(dir, '.git'))) {
    return fail(dir, 'already_repo', 'This folder already has a .git');
  }
  try {
    const root = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
    return fail(dir, 'already_repo', `This folder is already inside the git repository ${root}`);
  } catch {
    // 不是 git：繼續
  }

  const gitignore = join(dir, '.gitignore');
  const gitDir = join(dir, '.git');
  let gitignoreCreated = false;
  let initialized = false;
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
    await git(['-C', dir, 'init', '-q']);
    initialized = true;
    // `init -b` 要 git 2.28；還沒有 commit 時改 HEAD 指向哪個分支，舊版也能用。
    await git(['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${GIT_INIT_BRANCH}`]);

    const max = options.maxFileBytes ?? GIT_INIT_MAX_FILE_BYTES;
    const large = await largeFiles(dir, max);
    // hook 設定（含這台的路徑）一律不進版控；大檔也寫進排除清單（只在這台、不改 .gitignore）。
    const lines = [
      '.claude/settings.local.json',
      ...large.flatMap((f) => {
        const line = excludeLine(f.path);
        return line ? [line] : [];
      }),
    ];
    const excludeFile = join(gitDir, 'info', 'exclude');
    await mkdir(dirname(excludeFile), { recursive: true });
    const before = await readFile(excludeFile, 'utf8').catch(() => '');
    await writeFile(
      excludeFile,
      `${before}${before && !before.endsWith('\n') ? '\n' : ''}# Agent Board git init（超過大小上限的檔案與 hook 設定，只在這台）\n${lines.join('\n')}\n`,
    );

    await git(['-C', dir, 'add', '-A'], { timeoutMs: GIT_INIT_STEP_TIMEOUT_MS });
    const identity = (await hasIdentity(dir)) ? 'user' : 'fallback';
    await git(
      [
        ...(identity === 'fallback'
          ? [
              '-c',
              `user.name=${GIT_INIT_FALLBACK_NAME}`,
              '-c',
              `user.email=${GIT_INIT_FALLBACK_EMAIL}`,
            ]
          : []),
        // 只對這一次：不簽章（沒設定金鑰會失敗）、不跑使用者全域的 hook。
        '-c',
        'commit.gpgsign=false',
        '-C',
        dir,
        'commit',
        '-q',
        '--no-verify',
        '--allow-empty',
        '-m',
        GIT_INIT_COMMIT_MESSAGE,
      ],
      { timeoutMs: GIT_INIT_STEP_TIMEOUT_MS },
    );
    const commit = await git(['-C', dir, 'rev-parse', 'HEAD']);
    const tracked = await git(['-C', dir, 'ls-files', '-z'], {
      raw: true,
      maxBuffer: LIST_MAX_BUFFER,
      timeoutMs: GIT_INIT_STEP_TIMEOUT_MS,
    });
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
    // 做到一半：收掉這次建的 .git 與 .gitignore，資料夾回到原樣（使用者的檔案沒動過）。
    if (initialized) await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
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
