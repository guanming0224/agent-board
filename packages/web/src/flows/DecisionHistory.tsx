// 收件匣底下「最近的決定」：讀 audit_log 的 approval.decide（hub 只讓 owner 讀，所以成員看到說明）。
// 收合時不讀；每次打開重讀一次。
import { useState } from 'react';
import type { AuditEntry, User } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Loading, type Loaded } from './common';
import { StatusBadge } from './StatusBadge';
import type { ReviewGroup } from './triage';

const HISTORY_LIMIT = 20;

export interface DecisionSummary {
  kind: ReviewGroup | null;
  behavior: 'allow' | 'allowRemember' | 'deny' | 'answer' | null;
  text: string | null;
}

/** hub 的 detail 是 `{ kind, decision: { behavior, … } }`；舊資料與假後端把 behavior 放在最外層。 */
export function parseDecision(detail: string): DecisionSummary {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // 不是 JSON：只顯示時間與 session
  }
  const decision =
    raw['decision'] && typeof raw['decision'] === 'object'
      ? (raw['decision'] as Record<string, unknown>)
      : raw;
  const kinds: ReviewGroup[] = ['danger', 'permission', 'plan', 'question'];
  const kind = kinds.find((k) => k === raw['kind']) ?? null;
  const b = decision['behavior'];
  const behavior =
    b === 'allow'
      ? decision['remember'] === true
        ? 'allowRemember'
        : 'allow'
      : b === 'deny' || b === 'answer'
        ? b
        : null;
  const text =
    typeof decision['reason'] === 'string'
      ? decision['reason']
      : typeof decision['text'] === 'string'
        ? decision['text']
        : null;
  return { kind, behavior, text };
}

const BEHAVIOR_KEY = {
  allow: 'flows.history.allow',
  allowRemember: 'flows.history.allowRemember',
  deny: 'flows.history.deny',
  answer: 'flows.history.answer',
} as const;

function HistoryRow({ entry }: { entry: AuditEntry }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const name = useBoard((s) => s.sessions.find((x) => x.id === entry.sessionId)?.name);
  const d = parseDecision(entry.detail);
  const at = new Date(entry.at);
  return (
    <li className="history-row" data-testid="history-row">
      <time className="num" dateTime={entry.at} title={at.toLocaleString(locale)}>
        {at.toLocaleString(locale, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
      {d.kind && <StatusBadge kind={d.kind} />}
      <span className="history-name">{name ?? entry.sessionId ?? '—'}</span>
      <b className={`history-result${d.behavior === 'deny' ? ' deny' : ''}`}>
        {d.behavior ? t(BEHAVIOR_KEY[d.behavior]) : '—'}
      </b>
      {d.text && <span className="history-text">{mask(d.text)}</span>}
    </li>
  );
}

export function DecisionHistory({ me }: { me: Loaded<User | null> }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [state, setState] = useState<{
    loading: boolean;
    error: string | null;
    entries: AuditEntry[] | null;
  }>({ loading: false, error: null, entries: null });
  const owner = me.data?.role === 'owner';

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const entries = await backend.listAudit({ action: 'approval.decide', limit: HISTORY_LIMIT });
      setState({ loading: false, error: null, entries });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: errorText(e) }));
    }
  };

  let body;
  if (!owner) {
    body = <p className="hint">{t('flows.history.ownerOnly')}</p>;
  } else if (state.loading && !state.entries) {
    body = <Loading />;
  } else if (state.error) {
    body = (
      <p className="hint" role="alert">
        {t('flows.history.failed', { error: state.error })}{' '}
        <button type="button" onClick={() => void load()}>
          {t('flows.retry')}
        </button>
      </p>
    );
  } else if (state.entries && state.entries.length === 0) {
    body = <p className="hint">{t('flows.history.none')}</p>;
  } else {
    body = (
      <ol className="history-list">
        {(state.entries ?? []).map((entry) => (
          <HistoryRow key={entry.id} entry={entry} />
        ))}
      </ol>
    );
  }

  return (
    <details
      className="history"
      data-testid="review-history"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && owner) void load();
      }}
    >
      <summary>
        {t('flows.history.title')}
        <span className="sub"> {t('flows.history.limit', { n: HISTORY_LIMIT })}</span>
      </summary>
      {body}
    </details>
  );
}
