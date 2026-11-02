// 待處理項目：審核中心與收件匣共用的清單與排序（STYLE.md §2-3）。
import type { Approval, Session, SessionStatus } from '@agent-board/protocol';
import type { BoardSnapshot } from '../shared/backend';
import { attentionQueue, STATUS_VISUAL } from '../shared/status';

export interface WorkItem {
  key: string;
  approval: Approval | null;
  /** null：approval 對應不到 session，看不出呼號，不准從介面允許。 */
  session: Session | null;
  status: SessionStatus;
  since: string;
}

const APPROVAL_STATUS: Record<Approval['kind'], SessionStatus> = {
  permission: 'waiting_permission',
  danger: 'waiting_permission',
  plan: 'plan_review',
  question: 'waiting_input',
};

const rank = (item: WorkItem) => {
  if (item.approval?.kind === 'danger') return 0;
  return STATUS_VISUAL[item.status].holder === 'fault' ? 1 : 2;
};

/**
 * 每個 approval 一項；還沒有 approval 但在等人的 session 也算一項。
 * 危險指令命中時 session 常常還是 running（PreToolUse 先把它標成工作中），所以不能只看 session 狀態。
 */
export function workItems(board: Pick<BoardSnapshot, 'sessions' | 'approvals'>): WorkItem[] {
  const fromApprovals = board.approvals.map((approval) => ({
    key: approval.id,
    approval,
    session: board.sessions.find((s) => s.id === approval.sessionId) ?? null,
    status: APPROVAL_STATUS[approval.kind],
    since: approval.createdAt,
  }));
  const fromSessions = attentionQueue(board.sessions)
    .filter((s) => !board.approvals.some((a) => a.sessionId === s.id))
    .map((session) => ({
      key: session.id,
      approval: null,
      session,
      status: session.status,
      since: session.statusSince,
    }));
  return [...fromApprovals, ...fromSessions].sort(
    (a, b) => rank(a) - rank(b) || a.since.localeCompare(b.since),
  );
}

export const isFault = (item: WorkItem) => STATUS_VISUAL[item.status].holder === 'fault';
