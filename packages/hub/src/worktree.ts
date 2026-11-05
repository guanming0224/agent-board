// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。前端 team/worktree.ts 有同樣的判斷；這裡才是防線。
// 只讀成員例外（GM 2026-11-06）：兩個成員都會改檔案才算衝突。
import {
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

/**
 * 只讀成員：角色是研究或審查，而且 session 在 plan 模式。兩個條件都要成立；
 * 角色是審查但不在 plan 模式，仍算會改檔案的成員。
 */
export const isReadOnlyMember = (role: Role, session: Pick<Session, 'permissionMode'>) =>
  (role === 'researcher' || role === 'reviewer') && session.permissionMode === 'plan';

/** 還沒開好的 session，worktreePath 要等 daemon 回報；要不要建 worktree 記在 pending_spec。 */
function willHaveOwnWorktree(store: Store, id: string): boolean {
  const row = store.db.prepare('SELECT pending_spec FROM sessions WHERE id = ?').get(id) as
    { pending_spec: string | null } | undefined;
  if (!row?.pending_spec) return false;
  return (JSON.parse(row.pending_spec) as SessionSpec).useWorktree;
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
