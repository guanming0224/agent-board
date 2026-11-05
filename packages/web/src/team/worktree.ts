// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。真正的防線在 hub（hub/src/worktree.ts），
// 這裡先判斷是為了少打一次 API，並能直接列出是跟誰衝突。
// 只讀成員例外（GM 2026-11-06）：兩個成員都會改檔案才算衝突，規則和 hub 相同（protocol 的 isReadOnlyMember）。
import {
  isReadOnlyMember,
  sameWorkingTree,
  type Session,
  type TeamMember,
} from '@agent-board/protocol';

type Role = TeamMember['role'];

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
 * 已經在團隊裡、但現在和別的成員衝突的。hub 在加入時、以及只讀成員改成會改檔案的角色時都會檢查，
 * 正常不會出現；檢查上線前就存在的舊資料，或還沒開好時判斷不到的（例如 worktree 沒建成），在成員列上提醒。
 */
export function memberClashes(
  member: Session,
  members: readonly Session[],
  roleOf: (sessionId: string) => Role,
): Session[] {
  if (!isLive(member)) return [];
  return worktreeConflicts(member, members, { candidate: roleOf(member.id), of: roleOf });
}
