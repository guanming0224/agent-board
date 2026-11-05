// 已結束 session 在機器上留下的東西：Claude 對話紀錄、worktree、hook 設定（CONTRACTS §9）。
// 路徑一律由 hub 從資料庫帶來（SessionLocator），daemon 不必還記得這個 session。
// 原則：只刪 Agent Board 自己產生的東西，不加 --force，有疑慮就留著並說明原因。
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ClaudeSessionId,
  HOOK_COMMAND,
  type PurgeOptions,
  type PurgeOutcome,
  type PurgeResult,
  type SessionInspect,
  type SessionLocator,
} from '@agent-board/protocol';
import { hookSettingsLockKey, withFileLock } from './fileLock';
import { errorMessage } from './log';
import { currentBranch, git } from './worktree';

/** contract §3.1：Agent Board 建的 worktree 都在 `<repo>/../.agent-board-wt/<slug>`，分支是 `ab/<slug>`。 */
const WORKTREE_PARENT = '.agent-board-wt';
const WORKTREE_BRANCH_PREFIX = 'ab/';

export type InspectFindings = Omit<
  SessionInspect,
  'hooksShared' | 'worktreeShared' | 'transcriptShared'
>;

const execFileAsync = promisify(execFile);

/** 不 trim 的 git：`status --porcelain -z` 開頭的空白是狀態欄的一部分。 */
async function gitRaw(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

const outcome = (status: PurgeOutcome['status'], detail: string | null = null): PurgeOutcome => ({
  status,
  detail,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** 錯誤訊息只取第一行，git 的說明常常好幾行。 */
function firstLine(error: unknown): string {
  return (
    errorMessage(error)
      .split('\n')
      .find((line) => line.trim() !== '') ?? ''
  );
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

// ── 對話紀錄 ─────────────────────────────────────────────

/** accountProfile 是 CLAUDE_CONFIG_DIR，必須是絕對路徑：相對路徑會依 daemon 的工作資料夾解析（§9.6）。 */
export function claudeConfigFor(accountProfile: string | null, fallback: string): string {
  if (!accountProfile) return fallback;
  if (!isAbsolute(accountProfile)) throw new Error('accountProfile must be an absolute path');
  return accountProfile;
}

export interface TranscriptFiles {
  /** `<projects>/*\/<id>.jsonl`，新的在前。 */
  jsonl: string[];
  /** 同名資料夾（subagent 紀錄等）。 */
  dirs: string[];
}

/**
 * 掃 `<config>/projects/*` 一層找 `<id>.jsonl` 與同名資料夾，不依賴 Claude Code 的路徑編碼規則。
 * id 雖然 hub 與協定都驗過，這裡再驗一次，並確認組出的路徑都在 projects 底下。
 */
export async function findTranscriptFiles(
  configDir: string,
  claudeSessionId: string,
): Promise<TranscriptFiles> {
  const found: TranscriptFiles = { jsonl: [], dirs: [] };
  if (!ClaudeSessionId.safeParse(claudeSessionId).success) return found;
  const projects = resolve(configDir, 'projects');
  let dirents;
  try {
    dirents = await readdir(projects, { withFileTypes: true });
  } catch {
    return found;
  }
  const withTime: { path: string; mtimeMs: number }[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const file = join(projects, dirent.name, `${claudeSessionId}.jsonl`);
    const folder = join(projects, dirent.name, claudeSessionId);
    if (!inside(projects, file) || !inside(projects, folder)) continue;
    // lstat：符號連結不跟，刪的時候也只刪連結本身。
    const fileStat = await lstat(file).catch(() => null);
    if (fileStat?.isFile()) withTime.push({ path: file, mtimeMs: fileStat.mtimeMs });
    const folderStat = await lstat(folder).catch(() => null);
    if (folderStat?.isDirectory()) found.dirs.push(folder);
  }
  found.jsonl = withTime.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
  return found;
}

async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  const children = await readdir(path).catch(() => [] as string[]);
  let total = 0;
  for (const child of children) total += await treeBytes(join(path, child));
  return total;
}

async function transcriptBytes(configDir: string, claudeSessionId: string | null) {
  if (claudeSessionId === null) return null;
  const files = await findTranscriptFiles(configDir, claudeSessionId);
  if (files.jsonl.length === 0 && files.dirs.length === 0) return null;
  let total = 0;
  for (const path of [...files.jsonl, ...files.dirs]) total += await treeBytes(path);
  return total;
}

// ── git ─────────────────────────────────────────────────

/** `git worktree list --porcelain` 的第一筆就是主 worktree。 */
async function mainWorktree(dir: string): Promise<string | null> {
  try {
    const out = await git(['-C', dir, 'worktree', 'list', '--porcelain']);
    const line = out.split('\n').find((l) => l.startsWith('worktree '));
    return line ? line.slice('worktree '.length) : null;
  } catch {
    return null;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  const real = (p: string) => realpath(p).catch(() => resolve(p));
  return (await real(a)) === (await real(b));
}

async function countCommits(dir: string, range: string): Promise<number | null> {
  try {
    const n = Number(await git(['-C', dir, 'rev-list', '--count', range]));
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

async function gitFindings(target: SessionLocator): Promise<InspectFindings['git']> {
  const dir = target.worktreePath ?? target.cwd;
  if (!(await isDirectory(dir))) return null;
  let porcelain: string;
  try {
    porcelain = await git(['-C', dir, 'status', '--porcelain']);
  } catch {
    return null; // 不是 git
  }
  const branch = await currentBranch(dir);
  let unmergedCommits: number | null = null;
  if (target.worktreePath !== null) {
    const main = await mainWorktree(dir);
    if (main !== null && !(await samePath(main, dir))) {
      const mainHead = await git(['-C', main, 'rev-parse', 'HEAD']).catch(() => null);
      const ref = target.branch ?? 'HEAD';
      if (mainHead) unmergedCommits = await countCommits(dir, `${mainHead}..${ref}`);
    }
  }
  return {
    dir,
    dirtyFiles: porcelain === '' ? 0 : porcelain.split('\n').length,
    unpushedCommits: await countCommits(dir, '@{u}..HEAD'),
    branch,
    unmergedCommits,
  };
}

export async function inspectSession(
  target: SessionLocator,
  defaultConfigDir: string,
): Promise<InspectFindings> {
  const configDir = claudeConfigFor(target.accountProfile, defaultConfigDir);
  return {
    transcriptBytes: await transcriptBytes(configDir, target.claudeSessionId),
    git: await gitFindings(target),
    worktreeExists: target.worktreePath !== null && (await isDirectory(target.worktreePath)),
  };
}

// ── 刪除 ─────────────────────────────────────────────────

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** `git worktree list --porcelain`：空行分隔的區塊，第一筆是主 worktree。 */
async function listWorktrees(dir: string): Promise<WorktreeEntry[] | null> {
  let out: string;
  try {
    out = await gitRaw(['-C', dir, 'worktree', 'list', '--porcelain']);
  } catch {
    return null;
  }
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null;
    entries.push({ path, branch });
  }
  return entries;
}

const realOrResolved = (p: string) => realpath(p).catch(() => resolve(p));

/**
 * 確認這是 Agent Board 建的 worktree（§9.6），全部成立才回傳；否則回 kept／not_found 的結果：
 * 絕對且正規的路徑、沒經過符號連結、在 `<主 worktree>/../.agent-board-wt/` 底下、
 * `git worktree list` 有剛好這一筆、而且分支是 `refs/heads/ab/…` 並等於 hub 記的 branch。
 */
async function verifyOwnWorktree(
  target: SessionLocator,
): Promise<{ main: string; real: string; branch: string } | PurgeOutcome> {
  const { worktreePath, branch } = target;
  if (worktreePath === null) return outcome('not_found');
  if (!isAbsolute(worktreePath) || worktreePath !== resolve(worktreePath)) {
    return outcome('kept', 'worktree 路徑不是正規的絕對路徑，保留');
  }
  if (!(await isDirectory(worktreePath))) return outcome('not_found', 'worktree 資料夾已不存在');
  const real = await realpath(worktreePath);
  if (real !== worktreePath) return outcome('kept', 'worktree 路徑經過符號連結，保留');
  const list = await listWorktrees(real);
  const mainEntry = list?.[0];
  if (!list || !mainEntry) return outcome('kept', '不是 git worktree，保留');
  const main = await realOrResolved(mainEntry.path);
  if (main === real) return outcome('kept', '這是主 worktree，保留');
  if (dirname(real) !== join(dirname(main), WORKTREE_PARENT)) {
    return outcome('kept', '不是 Agent Board 建立的 worktree，保留');
  }
  let entry: WorktreeEntry | undefined;
  for (const candidate of list.slice(1)) {
    if ((await realOrResolved(candidate.path)) === real) entry = candidate;
  }
  if (!entry) return outcome('kept', '不在 git worktree 清單裡，保留');
  if (
    branch === null ||
    !branch.startsWith(WORKTREE_BRANCH_PREFIX) ||
    entry.branch !== `refs/heads/${branch}`
  ) {
    return outcome('kept', 'worktree 的分支與紀錄不符，保留');
  }
  return { main, real, branch };
}

/** `git status --porcelain -z --untracked-files=all` → [狀態, 相對路徑]。 */
async function worktreeChanges(dir: string): Promise<{ xy: string; path: string }[]> {
  const parts = (await gitRaw(['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=all']))
    .split('\0')
    .filter((p) => p !== '');
  const changes: { xy: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const xy = part.slice(0, 2);
    changes.push({ xy, path: part.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // 改名的下一段是舊路徑
  }
  return changes;
}

async function purgeWorktree(target: SessionLocator): Promise<PurgeOutcome> {
  const verified = await verifyOwnWorktree(target);
  if ('status' in verified) return verified;
  const { main, real, branch } = verified;

  // 我們寫進 worktree 的 hook 設定會是未追蹤檔，讓 `git worktree remove` 拒絕。
  // 只有在「拿掉它之後就沒有其他改動」時才拿（確定會移除），否則整個 worktree 原封不動。
  const hookDirs = new Set([real]);
  if (inside(real, target.cwd)) hookDirs.add(target.cwd);
  const plans: { dir: string; plan: HookPlan }[] = [];
  for (const dir of hookDirs) plans.push({ dir, plan: await planHookRemoval(dir) });
  const deletable = new Set(
    plans.flatMap(({ plan }) =>
      plan.kind === 'change' && plan.deleteFile && inside(real, plan.realPath)
        ? [relative(real, plan.realPath)]
        : [],
    ),
  );
  let changes: { xy: string; path: string }[];
  try {
    changes = await worktreeChanges(real);
  } catch (error) {
    return outcome('failed', firstLine(error));
  }
  const blocking = changes.filter((c) => !(c.xy === '??' && deletable.has(c.path)));
  if (blocking.length > 0) {
    return outcome('kept', `worktree 有改動，保留（${blocking.length} 個檔案）`);
  }
  for (const { dir } of plans) await removeHookEntries(dir);
  try {
    // 不加 --force：有沒 commit 的改動或未追蹤檔，git 會拒絕。用 realpath，前面加 --。
    await git(['-C', main, 'worktree', 'remove', '--', real]);
  } catch (error) {
    return outcome('kept', `worktree 有改動，保留（${firstLine(error)}）`);
  }
  try {
    // -d（不是 -D）：沒合併的分支 git 會拒絕。
    await git(['-C', main, 'branch', '-d', '--', branch]);
  } catch {
    return outcome('removed', `分支 ${branch} 沒合併，保留`);
  }
  return outcome('removed');
}

async function purgeTranscript(target: SessionLocator, configDir: string): Promise<PurgeOutcome> {
  if (target.claudeSessionId === null) return outcome('not_found');
  const files = await findTranscriptFiles(configDir, target.claudeSessionId);
  const paths = [...files.jsonl, ...files.dirs];
  if (paths.length === 0) return outcome('not_found');
  const errors: string[] = [];
  for (const path of paths) {
    await rm(path, { recursive: true, force: true }).catch((error: unknown) =>
      errors.push(firstLine(error)),
    );
  }
  return errors.length > 0 ? outcome('failed', errors.join('; ')) : outcome('removed');
}

function isOurCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trimStart();
  return trimmed === HOOK_COMMAND || trimmed.startsWith(`${HOOK_COMMAND} `);
}

/** 就地拿掉 agent-board-hook 的項目，回傳拿掉幾個。其他內容（含看不懂的）原樣保留。 */
function stripHooks(hooks: Record<string, unknown>): number {
  let removed = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let removedHere = 0;
    const next: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const handlers = group.hooks as unknown[];
      const kept = handlers.filter((h) => !(isRecord(h) && isOurCommand(h.command)));
      removedHere += handlers.length - kept.length;
      if (kept.length === handlers.length) next.push(group);
      else if (kept.length > 0) next.push({ ...group, hooks: kept });
    }
    removed += removedHere;
    if (removedHere === 0) continue;
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  }
  return removed;
}

async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
  const tempPath = join(dirname(path), `.settings.local.json.${randomUUID()}.tmp`);
  try {
    const file = await open(tempPath, 'wx', mode);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

type HookPlan =
  | { kind: 'not_found' }
  | { kind: 'failed'; detail: string }
  | {
      kind: 'change';
      /** 實際要改或刪的檔案（解開符號連結後）。 */
      realPath: string;
      /** 拿完只剩空物件、而且設定檔本身不是符號連結 → 刪檔。 */
      deleteFile: boolean;
      text: string;
    };

/** 只讀不寫：算出拿掉 agent-board-hook 之後的內容。 */
async function planHookRemoval(cwd: string): Promise<HookPlan> {
  const linkPath = join(cwd, '.claude', 'settings.local.json');
  let isLink: boolean;
  let realPath: string;
  let raw: string;
  try {
    // 只看最後一層是不是符號連結；cwd 本身經過符號連結不算（W1）。
    isLink = (await lstat(linkPath)).isSymbolicLink();
    realPath = await realpath(linkPath);
    raw = await readFile(realPath, 'utf8');
  } catch (error) {
    return isNotFound(error) ? { kind: 'not_found' } : { kind: 'failed', detail: firstLine(error) };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return { kind: 'failed', detail: 'settings.local.json 不是合法的 JSON，沒有修改' };
  }
  if (!isRecord(settings)) {
    return { kind: 'failed', detail: 'settings.local.json 最外層不是物件，沒有修改' };
  }
  if (settings.hooks === undefined) return { kind: 'not_found' };
  if (!isRecord(settings.hooks)) return { kind: 'failed', detail: '"hooks" 不是物件，沒有修改' };
  if (stripHooks(settings.hooks) === 0) return { kind: 'not_found' };
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return {
    kind: 'change',
    realPath,
    // 符號連結指向別處的檔案就只改內容，不刪別人的檔案。
    deleteFile: Object.keys(settings).length === 0 && !isLink,
    text: `${JSON.stringify(settings, null, 2)}\n`,
  };
}

/**
 * 從 `<cwd>/.claude/settings.local.json` 拿掉 agent-board-hook（安裝方式見 hook/src/settings.ts）。
 * 檔案壞掉就 failed、不覆寫。拿完變成空物件就刪檔（.claude 空了也收掉），
 * 否則 worktree 裡多一個未追蹤檔，`git worktree remove` 會拒絕。與 hook 安裝共用同一把鎖。
 */
export async function removeHookEntries(cwd: string): Promise<PurgeOutcome> {
  return withFileLock(await hookSettingsLockKey(cwd), async () => {
    const plan = await planHookRemoval(cwd);
    if (plan.kind === 'not_found') return outcome('not_found');
    if (plan.kind === 'failed') return outcome('failed', plan.detail);
    try {
      if (plan.deleteFile) {
        await unlink(plan.realPath);
        await rmdir(dirname(plan.realPath)).catch(() => undefined); // 不是空的就留著
      } else {
        const mode = (await stat(plan.realPath)).mode & 0o777;
        await writeAtomically(plan.realPath, plan.text, mode);
      }
    } catch (error) {
      return outcome('failed', firstLine(error));
    }
    return outcome('removed');
  });
}

/**
 * 依勾選清理。hook 先拿：它可能是 worktree 裡唯一的未追蹤檔，留著 worktree 就移不掉。
 * 每一項各自處理失敗，不因一項出錯就放棄其他項。
 */
export async function purgeSession(
  target: SessionLocator,
  options: PurgeOptions,
  defaultConfigDir: string,
): Promise<PurgeResult> {
  // accountProfile 只在處理對話紀錄時才要求是絕對路徑（§9.6）；不合法就整個拒絕，什麼都不做。
  const configDir = options.removeTranscript
    ? claudeConfigFor(target.accountProfile, defaultConfigDir)
    : defaultConfigDir;
  const safely = async (fn: () => Promise<PurgeOutcome>): Promise<PurgeOutcome> => {
    try {
      return await fn();
    } catch (error) {
      return outcome('failed', firstLine(error));
    }
  };
  const skipped = outcome('skipped');
  const hooks = options.removeHooks ? await safely(() => removeHookEntries(target.cwd)) : skipped;
  const worktree = options.removeWorktree ? await safely(() => purgeWorktree(target)) : skipped;
  const transcript = options.removeTranscript
    ? await safely(() => purgeTranscript(target, configDir))
    : skipped;
  return { worktree, transcript, hooks };
}
