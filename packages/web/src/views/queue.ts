import type { Approval, Session } from '@agent-board/protocol';
import { attentionQueue } from '../shared/status';

/** 命中危險指令的 approval，同一 session 取最早的一筆。 */
export function dangerApproval(approvals: readonly Approval[], sessionId: string) {
  return approvals
    .filter((a) => a.kind === 'danger' && a.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/**
 * 待處理清單與「下一個等我的」共用的順序：危險指令置頂，其餘照 attentionQueue。
 * 危險指令的 hook 卡在 PreToolUse，session 可能還是 running，所以不能只從 attentionQueue 裡挑。
 */
export function pendingQueue(
  sessions: readonly Session[],
  approvals: readonly Approval[],
): Session[] {
  const danger = sessions
    .filter((s) => !s.archived && dangerApproval(approvals, s.id))
    .sort((a, b) =>
      dangerApproval(approvals, a.id)!.createdAt.localeCompare(
        dangerApproval(approvals, b.id)!.createdAt,
      ),
    );
  const dangerIds = new Set(danger.map((s) => s.id));
  return [...danger, ...attentionQueue(sessions).filter((s) => !dangerIds.has(s.id))];
}

/** 連按時的下一個；游標不在清單裡（已處理掉）就回到最前面。 */
export function nextInQueue(queue: readonly Session[], cursorId: string | null): Session | null {
  if (queue.length === 0) return null;
  const at = queue.findIndex((s) => s.id === cursorId);
  return queue[(at + 1) % queue.length] ?? null;
}
