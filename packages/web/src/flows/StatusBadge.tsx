// 待處理與審核中心清單列上的狀態徽章。符號、顏色、文字都集中在這裡，
// 之後狀態 token 改了（畫布那邊可能加新的狀態色）只要對齊這一個元件與 flows.css 的 .badge。
import type { SessionStatus } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { STATUS_VISUAL, type BallHolder } from '../shared/status';
import type { ReviewGroup, TriageKind } from './triage';

type BadgeKind = TriageKind | ReviewGroup;

/** 不是 session 狀態本身的徽章：危險指令、提問、剛開好。其他照 STATUS_VISUAL。 */
const SPECIAL: Partial<Record<BadgeKind, { glyph: string; holder: BallHolder; key: string }>> = {
  danger: { glyph: '⛔', holder: 'fault', key: 'flows.badge.danger' },
  question: { glyph: '◇', holder: 'you', key: 'flows.badge.question' },
  idle: { glyph: '◇', holder: 'idle', key: 'flows.badge.idle' },
};

const STATUS_OF: Partial<Record<BadgeKind, SessionStatus>> = {
  permission: 'waiting_permission',
  plan: 'plan_review',
  reply: 'waiting_input',
  error: 'error',
  stuck: 'stuck',
  rate_limited: 'rate_limited',
};

export function StatusBadge({ kind }: { kind: BadgeKind }) {
  const t = useT();
  const special = SPECIAL[kind];
  const visual = special
    ? { glyph: special.glyph, holder: special.holder, label: t(special.key) }
    : (() => {
        const v = STATUS_VISUAL[STATUS_OF[kind] ?? 'waiting_input'];
        return { glyph: v.glyph, holder: v.holder, label: t(v.labelKey) };
      })();
  return (
    <span className={`badge b-${visual.holder}`} data-kind={kind}>
      <i aria-hidden="true">{visual.glyph}</i>
      {visual.label}
    </span>
  );
}
