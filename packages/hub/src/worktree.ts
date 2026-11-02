// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。前端 team/worktree.ts 有同樣的判斷；這裡才是防線。
import type { Session, SessionSpec } from '@agent-board/protocol';
import type { Store } from './store';

const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');

const isLive = (session: Session) => session.endedAt === null && session.status !== 'done';

/** 還沒開好的 session，worktreePath 要等 daemon 回報；要不要建 worktree 記在 pending_spec。 */
function willHaveOwnWorktree(store: Store, id: string): boolean {
  const row = store.db.prepare('SELECT pending_spec FROM sessions WHERE id = ?').get(id) as
    { pending_spec: string | null } | undefined;
  if (!row?.pending_spec) return false;
  return (JSON.parse(row.pending_spec) as SessionSpec).useWorktree;
}

/**
 * 回傳和候選者在同一台機器、資料夾相同或互相包含的現有成員。repo 根目錄只有 daemon 知道，
 * 所以同 repo 的兩個不相干子資料夾這裡判斷不出來。
 */
export function worktreeConflicts(
  store: Store,
  candidateId: string,
  memberIds: readonly string[],
): Session[] {
  const candidate = store.getSession(candidateId);
  if (!candidate || !isLive(candidate)) return [];
  if (!candidate.worktreePath && willHaveOwnWorktree(store, candidate.id)) return [];
  const dir = normalize(candidate.worktreePath ?? candidate.cwd);
  return memberIds.flatMap((id) => {
    const member = store.getSession(id);
    if (!member || id === candidateId || member.machineId !== candidate.machineId) return [];
    if (!isLive(member)) return [];
    if (!member.worktreePath && willHaveOwnWorktree(store, id)) return [];
    const other = normalize(member.worktreePath ?? member.cwd);
    return other === dir || other.startsWith(`${dir}/`) || dir.startsWith(`${other}/`)
      ? [member]
      : [];
  });
}
