// 同一團隊改同一 repo 要各自 worktree（DISPATCH §6）。真正的防線在 hub（hub/src/worktree.ts），
// 這裡先判斷是為了少打一次 API，並能直接列出是跟誰衝突。
import type { Session } from '@agent-board/protocol';

const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');

/** 有 worktree 就看 worktree，那才是它實際改檔案的地方。 */
const workDir = (session: Session) => normalize(session.worktreePath ?? session.cwd);

const isLive = (session: Session) => session.endedAt === null && session.status !== 'done';

/** 還沒開好的 session 可能正要建 worktree，前端看不到設定，交給 hub 判斷。 */
const isPending = (session: Session) =>
  session.status === 'starting' || session.status === 'queued';

/**
 * 同一台機器上，資料夾相同或一個在另一個裡面。repo 根目錄只有 daemon 知道，
 * 所以同 repo 的兩個不相干子資料夾這裡判斷不出來。
 */
export function worktreeConflicts(candidate: Session, members: readonly Session[]): Session[] {
  const dir = workDir(candidate);
  if (!dir || isPending(candidate)) return [];
  return members.filter((member) => {
    if (member.id === candidate.id || member.machineId !== candidate.machineId) return false;
    if (!isLive(member) || isPending(member)) return false;
    const other = workDir(member);
    return other === dir || other.startsWith(`${dir}/`) || dir.startsWith(`${other}/`);
  });
}
