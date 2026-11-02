import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** 留下字母與數字（含中文），加上 session id 確保不撞名。 */
export function makeSlug(name: string, sessionId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const suffix = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `${base || 'session'}-${suffix || 'x'}`;
}

export interface WorktreeInfo {
  /** session 要開在哪：對應原本 cwd 在 repo 內的相對位置。 */
  cwd: string;
  worktreePath: string;
  branch: string;
  repo: string;
}

export async function createWorktree(
  cwd: string,
  name: string,
  sessionId: string,
): Promise<WorktreeInfo> {
  const repo = await git(['-C', cwd, 'rev-parse', '--show-toplevel']);
  const slug = makeSlug(name, sessionId);
  const worktreePath = resolve(repo, '..', '.agent-board-wt', slug);
  const branch = `ab/${slug}`;
  await git(['-C', repo, 'worktree', 'add', worktreePath, '-b', branch]);
  const inner = relative(await realpath(repo), await realpath(cwd));
  const mapped = inner ? join(worktreePath, inner) : worktreePath;
  // 子資料夾可能沒進版控，新 worktree 裡就不存在。
  return { cwd: existsSync(mapped) ? mapped : worktreePath, worktreePath, branch, repo };
}

/** 開 PTY 失敗時收掉剛建的空 worktree。不加 --force，有任何變更就留著不動。 */
export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  await git(['-C', info.repo, 'worktree', 'remove', info.worktreePath]);
  await git(['-C', info.repo, 'branch', '-d', info.branch]);
}

/** cwd 所在的是 linked worktree 就回傳它的根目錄，否則 null（接續舊對話時還原 worktreePath 用）。 */
export async function findLinkedWorktree(cwd: string): Promise<string | null> {
  try {
    const gitDir = resolve(cwd, await git(['-C', cwd, 'rev-parse', '--git-dir']));
    const commonDir = resolve(cwd, await git(['-C', cwd, 'rev-parse', '--git-common-dir']));
    if (gitDir === commonDir) return null;
    return await git(['-C', cwd, 'rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null; // 不是 git repo，或還沒有任何 commit
  }
}
