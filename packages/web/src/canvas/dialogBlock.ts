import type { Approval, Session } from '@agent-board/protocol';

export type DialogBlock = 'permission' | 'question' | 'plan';

/**
 * 原生對話框在等決定時，摘要卡輸入框送進 PTY 的字會被當成選項（`1` 就是 Yes、Enter 選預設）。
 * 這時輸入框不送，改指向核准按鈕；要在原生對話框回答，就放大進真的 xterm。
 * 危險指令的 approval 可能出現在 running 狀態，所以也看 approvals。
 */
export function dialogBlock(
  session: Pick<Session, 'id' | 'status'>,
  approvals: readonly Approval[],
): DialogBlock | null {
  const pending = approvals.filter((a) => a.sessionId === session.id);
  if (session.status === 'plan_review' || pending.some((a) => a.kind === 'plan')) return 'plan';
  if (pending.some((a) => a.kind === 'question')) return 'question';
  if (session.status === 'waiting_permission' || pending.length > 0) return 'permission';
  return null;
}
