// 遠端資料夾瀏覽（新 session 選路徑用）。
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DaemonToHub } from '@agent-board/protocol';
import { errorMessage } from './log';

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
  const base = { type: 'fs.listResult', requestId, path } as const;
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
    return { ...base, entries, error: null };
  } catch (error) {
    return { ...base, entries: [], error: errorMessage(error) };
  }
}
