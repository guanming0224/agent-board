// 遠端資料夾瀏覽（新 session 選路徑用）。
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { DaemonToHub } from '@agent-board/protocol';
import { errorMessage } from './log';
import { repoInfo } from './worktree';

const MAX_ENTRIES = 5_000;

type ListResult = Extract<DaemonToHub, { type: 'fs.listResult' }>;

function expandPath(path: string): string {
  if (!path || path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function listDirectory(requestId: string, rawPath: string): Promise<ListResult> {
  const path = expandPath(rawPath);
  const base = { type: 'fs.listResult', requestId, path, repo: null } as const;
  try {
    const dirents = await readdir(path, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.slice(0, MAX_ENTRIES).map(async (dirent) => {
        const full = join(path, dirent.name);
        let isDir = dirent.isDirectory();
        if (dirent.isSymbolicLink()) {
          // 壞掉的連結當成檔案，不讓整個列表失敗。
          isDir = await stat(full).then(
            (s) => s.isDirectory(),
            () => false,
          );
        }
        return {
          name: dirent.name,
          isDir,
          isGitRepo: isDir && (await exists(join(full, '.git'))),
        };
      }),
    );
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    // 新 session 用它判斷「同一個 repo」（CONTRACTS §6.3）。
    return { ...base, entries, repo: await repoInfo(path), error: null };
  } catch (error) {
    return { ...base, entries: [], error: errorMessage(error) };
  }
}

/**
 * 在 parent 底下建一層新資料夾，成功就回新資料夾的列表。
 * parent 要已經存在（不遞迴），名稱已存在就回錯誤，不覆蓋、不沿用。
 */
export async function makeDirectory(
  requestId: string,
  rawParent: string,
  name: string,
): Promise<ListResult> {
  const parent = expandPath(rawParent);
  const target = join(parent, name);
  // 協定已擋掉分隔字元與 . ..；這裡再確認不會跑出 parent。
  if (resolve(parent, name) !== target || basename(target) !== name) {
    return {
      type: 'fs.listResult',
      requestId,
      path: parent,
      repo: null,
      entries: [],
      error: 'invalid folder name',
    };
  }
  try {
    await mkdir(target, { mode: 0o755 });
  } catch (error) {
    return {
      type: 'fs.listResult',
      requestId,
      path: target,
      repo: null,
      entries: [],
      error: errorMessage(error),
    };
  }
  return listDirectory(requestId, target);
}
