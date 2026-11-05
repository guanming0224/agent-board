// 已封存清單與舊資料頁的純函式（CONTRACTS §9.5）。
import type { Machine, Project, Session } from '@agent-board/protocol';

const KB = 1024;
const MB = 1024 * 1024;

/** 對話大小顯示成 KB／MB；null（找不到或讀不到）由呼叫端顯示「—」。 */
export function formatBytes(bytes: number): string {
  if (bytes < MB) {
    const kb = bytes / KB;
    return `${kb < 10 && bytes > 0 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** 依封存時間新到舊；沒有封存時間的（schema 3 之前封存的）排最後，彼此依建立時間新到舊。 */
export function sortArchived(list: readonly Session[]): Session[] {
  return [...list].sort((a, b) => {
    const x = a.archivedAt ?? null;
    const y = b.archivedAt ?? null;
    if (x && y) return y.localeCompare(x);
    if (x) return -1;
    if (y) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** 搜尋：名稱、呼號、資料夾（cwd 與 worktree）、專案名稱，不分大小寫。 */
export function matchesArchived(
  session: Session,
  query: string,
  machines: readonly Machine[],
  projects: readonly Project[],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const project = projects.find((p) => p.id === session.projectId)?.name ?? '';
  // 呼號（`機器 / 專案 @ 分支`）的每一段都比對；不 import common.tsx，這裡要能在 node 單元測試。
  const machine = machines.find((m) => m.id === session.machineId)?.name ?? session.machineId;
  return [
    session.name,
    machine,
    session.branch ?? '',
    session.cwd,
    session.worktreePath ?? '',
    project,
  ].some((field) => field.toLowerCase().includes(q));
}

/** 還沒結束的 session 封存時會被停止（CONTRACTS §9.1）。done／error／offline 不用確認。 */
export function stopsOnArchive(session: Pick<Session, 'status' | 'endedAt'>): boolean {
  return session.endedAt === null && !['done', 'error', 'offline'].includes(session.status);
}
