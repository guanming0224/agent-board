// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。真正的防線在 hub（hub/src/worktree.ts），
// 這裡先判斷是為了少打一次 API，並能直接列出是跟誰衝突。
// 只讀成員例外（GM 2026-11-06）：兩個成員都會改檔案才算衝突，規則和 hub 相同。
import { sameWorkingTree, type Session, type TeamMember } from '@agent-board/protocol';

type Role = TeamMember['role'];

/**
 * 只讀成員：角色是研究或審查，而且 session 在 plan 模式。兩個條件都要成立；
 * 角色是審查但不在 plan 模式，仍算會改檔案的成員。
 */
export const isReadOnlyMember = (role: Role, session: Pick<Session, 'permissionMode'>) =>
  (role === 'researcher' || role === 'reviewer') && session.permissionMode === 'plan';

/** 有 worktree 就看 worktree，那才是它實際改檔案的地方。 */
const place = (session: Session) => ({
  dir: session.worktreePath ?? session.cwd,
  repoRoot: session.repoRoot,
});

const isLive = (session: Session) => session.endedAt === null && session.status !== 'done';

/** 還沒開好的 session 可能正要建 worktree，前端看不到設定，交給 hub 判斷。 */
const isPending = (session: Session) =>
  session.status === 'starting' || session.status === 'queued';

/** 不給角色時當成會改檔案的成員（worker）。 */
export interface Roles {
  candidate: Role;
  of: (sessionId: string) => Role;
}
const WRITERS: Roles = { candidate: 'worker', of: () => 'worker' };

/** 同一台機器、同一個 working tree（daemon 回報的 repo 根目錄；不知道時比資料夾），而且雙方都會改檔案。 */
export function worktreeConflicts(
  candidate: Session,
  members: readonly Session[],
  roles: Roles = WRITERS,
): Session[] {
  if (isPending(candidate) || isReadOnlyMember(roles.candidate, candidate)) return [];
  return members.filter((member) => {
    if (member.id === candidate.id || member.machineId !== candidate.machineId) return false;
    if (!isLive(member) || isPending(member)) return false;
    if (isReadOnlyMember(roles.of(member.id), member)) return false;
    return sameWorkingTree(place(candidate), place(member));
  });
}

/**
 * 已經在團隊裡、但現在和別的成員衝突的（例如研究／審查之後被切出 plan 模式，或角色被改成會改檔案的）。
 * 加入時 hub 檢查過，之後沒有人重新檢查，所以只在成員列上提醒。
 */
export function memberClashes(
  member: Session,
  members: readonly Session[],
  roleOf: (sessionId: string) => Role,
): Session[] {
  if (!isLive(member)) return [];
  return worktreeConflicts(member, members, { candidate: roleOf(member.id), of: roleOf });
}
