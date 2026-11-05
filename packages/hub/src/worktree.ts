// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。前端 team/worktree.ts 有同樣的判斷；這裡才是防線。
// 只讀成員例外（GM 2026-11-06）：兩個成員都會改檔案才算衝突（isReadOnlyMember，protocol/repo.ts）。
import {
  isReadOnlyMember,
  sameWorkingTree,
  type Session,
  type SessionSpec,
  type TeamMember,
} from '@agent-board/protocol';
import type { Store } from './store';

type Role = TeamMember['role'];

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
  // 壞掉的資料當成不會有自己的 worktree（保守：照樣檢查衝突），不讓加入成員整個 500。
  try {
    return (JSON.parse(row.pending_spec) as SessionSpec).useWorktree === true;
  } catch {
    return false;
  }
}

/**
 * 回傳和候選者在同一台機器、同一個 working tree、而且雙方都會改檔案的現有成員。
 * daemon 回報了 repo 根目錄就比根目錄（同 repo 的不同子資料夾也算衝突），
 * 還不知道時退回比較資料夾是否相同或互相包含。
 */
export function worktreeConflicts(
  store: Store,
  candidate: { sessionId: string; role: Role },
  members: readonly Pick<TeamMember, 'sessionId' | 'role'>[],
): Session[] {
  const session = store.getSession(candidate.sessionId);
  if (!session || !isLive(session)) return [];
  if (isReadOnlyMember(candidate.role, session)) return [];
  if (!session.worktreePath && willHaveOwnWorktree(store, session.id)) return [];
  return members.flatMap(({ sessionId: id, role }) => {
    const member = store.getSession(id);
    if (!member || id === session.id || member.machineId !== session.machineId) return [];
    if (!isLive(member) || isReadOnlyMember(role, member)) return [];
    if (!member.worktreePath && willHaveOwnWorktree(store, id)) return [];
    return sameWorkingTree(place(session), place(member)) ? [member] : [];
  });
}
