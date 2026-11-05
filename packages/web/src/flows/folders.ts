// 資料夾選擇器的純函式：麵包屑、上一層、最近用過。路徑分隔符依機器（Windows 用 `\`）。
import type { Session } from '@agent-board/protocol';

export interface Crumb {
  /** 顯示的名稱：根目錄是 `/` 或 `C:\`，家目錄是 `~`。 */
  label: string;
  /** 點下去要瀏覽的完整路徑。 */
  path: string;
}

const trimEnd = (path: string, sep: string) => {
  let out = path;
  while (out.length > 1 && out.endsWith(sep) && !/^[A-Za-z]:\\$/.test(out)) out = out.slice(0, -1);
  return out;
};

/** `/home/me/x` → `/`、`home`、`me`、`x`；`C:\Users\me` → `C:\`、`Users`、`me`；`~/a` → `~`、`a`。 */
export function breadcrumbs(path: string, sep: '/' | '\\'): Crumb[] {
  const trimmed = trimEnd(path, sep);
  if (!trimmed) return [];
  const parts = trimmed.split(sep);
  const crumbs: Crumb[] = [];
  let current = '';
  parts.forEach((part, i) => {
    if (i === 0) {
      if (part === '') {
        // POSIX 根目錄
        current = sep;
        crumbs.push({ label: sep, path: sep });
      } else if (/^[A-Za-z]:$/.test(part)) {
        current = `${part}${sep}`;
        crumbs.push({ label: current, path: current });
      } else {
        current = part;
        crumbs.push({ label: part, path: part });
      }
      return;
    }
    if (!part) return;
    current = current.endsWith(sep) ? `${current}${part}` : `${current}${sep}${part}`;
    crumbs.push({ label: part, path: current });
  });
  return crumbs;
}

/** 上一層；已經在最上層就回傳 null。 */
export function parentPath(path: string, sep: '/' | '\\'): string | null {
  const crumbs = breadcrumbs(path, sep);
  return crumbs.length >= 2 ? crumbs[crumbs.length - 2]!.path : null;
}

/** 在 dir 底下的 name。 */
export function childPath(dir: string, name: string, sep: '/' | '\\'): string {
  return dir.endsWith(sep) ? `${dir}${name}` : `${trimEnd(dir, sep)}${sep}${name}`;
}

/** 同一台機器的 session 用過的工作目錄，新到舊、去重。 */
export function recentFolders(sessions: readonly Session[], machineId: string, max = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = sessions
    .filter((s) => s.machineId === machineId && s.cwd)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const s of sorted) {
    if (seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    out.push(s.cwd);
    if (out.length >= max) break;
  }
  return out;
}

const LAST_KEY = 'agent-board.folder-browser.last.';

/** 上次在這台機器瀏覽到哪裡（這個瀏覽器）。存不了、讀不到都當沒有。 */
export function readLastFolder(machineId: string): string | null {
  try {
    return localStorage.getItem(LAST_KEY + machineId);
  } catch {
    return null;
  }
}

export function saveLastFolder(machineId: string, path: string): void {
  try {
    localStorage.setItem(LAST_KEY + machineId, path);
  } catch {
    // 私密瀏覽等情況存不了，下次從家目錄開始就好。
  }
}

const START_KEY = 'agent-board.folder-browser.start.';

/** 使用者自訂的起始資料夾（這個瀏覽器、這台機器）。沒設定就從桌面開始。 */
export function readStartFolder(machineId: string): string | null {
  try {
    return localStorage.getItem(START_KEY + machineId);
  } catch {
    return null;
  }
}

/** null＝改回預設（桌面）。 */
export function saveStartFolder(machineId: string, path: string | null): void {
  try {
    if (path === null) localStorage.removeItem(START_KEY + machineId);
    else localStorage.setItem(START_KEY + machineId, path);
  } catch {
    // 私密瀏覽等情況存不了，就只在這次開啟期間有效。
  }
}
