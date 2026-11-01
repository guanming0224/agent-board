// 狀態的視覺語意（STYLE.md 規則一、規則二）。整個前端只從這裡取，不各寫一份。
import type { PermissionMode, Session, SessionStatus } from '@agent-board/protocol';

export type BallHolder = 'you' | 'fault' | 'agent' | 'quota' | 'idle';

export const STATUS_VISUAL: Record<
  SessionStatus,
  { glyph: string; holder: BallHolder; labelKey: string }
> = {
  waiting_permission: { glyph: '◆', holder: 'you', labelKey: 'status.waiting_permission' },
  waiting_input: { glyph: '◇', holder: 'you', labelKey: 'status.waiting_input' },
  plan_review: { glyph: '▣', holder: 'you', labelKey: 'status.plan_review' },
  error: { glyph: '✕', holder: 'fault', labelKey: 'status.error' },
  stuck: { glyph: '⚠', holder: 'fault', labelKey: 'status.stuck' },
  running: { glyph: '●', holder: 'agent', labelKey: 'status.running' },
  starting: { glyph: '◌', holder: 'agent', labelKey: 'status.starting' },
  queued: { glyph: '⋯', holder: 'agent', labelKey: 'status.queued' },
  rate_limited: { glyph: '⧖', holder: 'quota', labelKey: 'status.rate_limited' },
  done: { glyph: '✓', holder: 'idle', labelKey: 'status.done' },
  offline: { glyph: '⊘', holder: 'idle', labelKey: 'status.offline' },
};

export type HandsLine = 'dotted' | 'dashed' | 'solid' | 'heavy' | 'bypass';

export const HANDS_LINE: Record<PermissionMode, HandsLine> = {
  plan: 'dotted',
  dontAsk: 'dotted',
  default: 'dashed',
  acceptEdits: 'solid',
  auto: 'heavy',
  bypassPermissions: 'bypass',
};

const ATTENTION_RANK: Partial<Record<SessionStatus, number>> = {
  error: 0,
  stuck: 0,
  waiting_permission: 1,
  plan_review: 1,
  waiting_input: 1,
};

/** 待處理順序：故障優先，同級等最久的排前面。命中危險指令的置頂由呼叫端用 approvals 判斷。 */
export function attentionQueue(sessions: readonly Session[]): Session[] {
  return sessions
    .filter((s) => !s.archived && ATTENTION_RANK[s.status] !== undefined)
    .sort(
      (a, b) =>
        (ATTENTION_RANK[a.status] ?? 9) - (ATTENTION_RANK[b.status] ?? 9) ||
        a.statusSince.localeCompare(b.statusSince),
    );
}
