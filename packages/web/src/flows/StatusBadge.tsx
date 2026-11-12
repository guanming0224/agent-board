// 收件匣清單列上的狀態徽章：英文狀態代碼＋符號（GM 2026-11-08）。畫法和畫布卡片、側欄圖例
// 共用 views/session.tsx 的 CodeChip（樣式在 shared/styles/status.css）。
import type { SessionStatus } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { statusCode, statusLabelKey, type StatusCode, visualOf } from '../shared/status';
import { CodeChip } from '../views/session';
import type { ReviewGroup, TriageKind } from './triage';

type BadgeKind = TriageKind | ReviewGroup;

/**
 * 不是 session 狀態本身的徽章：危險指令（是一種權限請求，PERM）、提問（ASK）、剛開好（NEW）。
 * 其他照 session 狀態算代碼。
 */
const SPECIAL: Partial<Record<BadgeKind, { glyph: string; code: StatusCode; key: string }>> = {
  danger: { glyph: '⛔', code: 'PERM', key: 'flows.badge.danger' },
  question: { glyph: '◇', code: 'ASK', key: 'flows.badge.question' },
  idle: { glyph: '◌', code: 'NEW', key: 'flows.badge.idle' },
};

const STATUS_OF: Partial<Record<BadgeKind, SessionStatus>> = {
  permission: 'waiting_permission',
  plan: 'plan_review',
  reply: 'waiting_input',
  error: 'error',
  stuck: 'stuck',
  rate_limited: 'rate_limited',
};

/** 這一項的狀態代碼（徽章、列與卡片外框的代碼色都用它，三處才不會不一樣）。 */
export function badgeCode(kind: BadgeKind): StatusCode {
  return (
    SPECIAL[kind]?.code ??
    statusCode({ status: STATUS_OF[kind] ?? 'waiting_input', statusDetail: null })
  );
}

export function StatusBadge({ kind }: { kind: BadgeKind }) {
  const t = useT();
  const special = SPECIAL[kind];
  const status = STATUS_OF[kind] ?? 'waiting_input';
  const session = { status, statusDetail: null };
  return special ? (
    <CodeChip
      code={special.code}
      glyph={special.glyph}
      label={t(special.key)}
      badge
      data={{ 'data-kind': kind }}
    />
  ) : (
    <CodeChip
      code={statusCode(session)}
      glyph={visualOf(status).glyph}
      label={t(statusLabelKey(session))}
      badge
      data={{ 'data-kind': kind }}
    />
  );
}
