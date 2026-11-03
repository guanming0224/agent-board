// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。真正的防線在 hub（hub/src/worktree.ts），
// 這裡先判斷是為了少打一次 API，並能直接列出是跟誰衝突。
import { sameWorkingTree, type Session } from '@agent-board/protocol';

/** 有 worktree 就看 worktree，那才是它實際改檔案的地方。 */
const place = (session: Session) => ({
  dir: session.worktreePath ?? session.cwd,
  repoRoot: session.repoRoot,
});

const isLive = (session: Session) => session.endedAt === null && session.status !== 'done';

/** 還沒開好的 session 可能正要建 worktree，前端看不到設定，交給 hub 判斷。 */
const isPending = (session: Session) =>
  session.status === 'starting' || session.status === 'queued';

/** 同一台機器、同一個 working tree（daemon 回報的 repo 根目錄；不知道時比資料夾）。 */
export function worktreeConflicts(candidate: Session, members: readonly Session[]): Session[] {
  if (isPending(candidate)) return [];
  return members.filter((member) => {
    if (member.id === candidate.id || member.machineId !== candidate.machineId) return false;
    if (!isLive(member) || isPending(member)) return false;
    return sameWorkingTree(place(candidate), place(member));
  });
}
