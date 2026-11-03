// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。前端 team/worktree.ts 有同樣的判斷；這裡才是防線。
import { sameWorkingTree, type Session, type SessionSpec } from '@agent-board/protocol';
import type { Store } from './store';

/** 有 worktree 就看 worktree，那才是它實際改檔案的地方。 */
const place = (session: Session) => ({
  dir: session.worktreePath ?? session.cwd,
  repoRoot: session.repoRoot,
});

const isLive = (session: Session) => session.endedAt === null && session.status !== 'done';

/** 還沒開好的 session，worktreePath 要等 daemon 回報；要不要建 worktree 記在 pending_spec。 */
function willHaveOwnWorktree(store: Store, id: string): boolean {
  const row = store.db.prepare('SELECT pending_spec FROM sessions WHERE id = ?').get(id) as
    { pending_spec: string | null } | undefined;
  if (!row?.pending_spec) return false;
  return (JSON.parse(row.pending_spec) as SessionSpec).useWorktree;
}

/**
 * 回傳和候選者在同一台機器、同一個 working tree 的現有成員。daemon 回報了 repo 根目錄就比根目錄
 * （同 repo 的不同子資料夾也算衝突），還不知道時退回比較資料夾是否相同或互相包含。
 */
export function worktreeConflicts(
  store: Store,
  candidateId: string,
  memberIds: readonly string[],
): Session[] {
  const candidate = store.getSession(candidateId);
  if (!candidate || !isLive(candidate)) return [];
  if (!candidate.worktreePath && willHaveOwnWorktree(store, candidate.id)) return [];
  return memberIds.flatMap((id) => {
    const member = store.getSession(id);
    if (!member || id === candidateId || member.machineId !== candidate.machineId) return [];
    if (!isLive(member)) return [];
    if (!member.worktreePath && willHaveOwnWorktree(store, id)) return [];
    return sameWorkingTree(place(candidate), place(member)) ? [member] : [];
  });
}
