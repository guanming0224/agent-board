// 待處理與審核中心清單列上的狀態徽章。符號與文字集中在這裡；樣式和畫布卡片、側欄圖例共用
// shared/styles/status.css 的 .lamp.badge.l-<holder>（GM 2026-11-06 統一狀態樣式）。
import type { SessionStatus } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { STATUS_VISUAL, type BallHolder } from '../shared/status';
import type { ReviewGroup, TriageKind } from './triage';

type BadgeKind = TriageKind | ReviewGroup;

/** 不是 session 狀態本身的徽章：危險指令、提問、剛開好。其他照 STATUS_VISUAL。 */
const SPECIAL: Partial<
  Record<BadgeKind, { glyph: string; holder: BallHolder; color: string; key: string }>
> = {
  danger: { glyph: '⛔', holder: 'fault', color: 'danger', key: 'flows.badge.danger' },
  question: { glyph: '◇', holder: 'you', color: 'question', key: 'flows.badge.question' },
  idle: { glyph: '◇', holder: 'idle', color: 'fresh', key: 'flows.badge.idle' },
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
    ? { glyph: special.glyph, holder: special.holder, color: special.color, label: t(special.key) }
    : (() => {
        const status = STATUS_OF[kind] ?? 'waiting_input';
        const v = STATUS_VISUAL[status];
        return { glyph: v.glyph, holder: v.holder, color: status, label: t(v.labelKey) };
      })();
  return (
    <span className={`lamp badge l-${visual.holder} s-${visual.color}`} data-kind={kind}>
      <i aria-hidden="true">{visual.glyph}</i>
      {visual.label}
    </span>
  );
}
