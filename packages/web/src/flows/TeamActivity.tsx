// 收件匣的「團隊動態」（隊長自主擴編，GM 2026-11-10，CONTRACTS §11.1）：隊長新增或封存了成員。
// 只是告知、不需要動作，不算在「等你」裡；可以標已讀、清除。桌面抽屜（InboxBoard）與手機收件匣（InboxPage）共用。
import { useState } from 'react';
import type { TeamActivity } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useViewsUi } from '../views';
import { errorText, Msg, type Note } from './common';
import { crossReviewHash } from '../views/overlay';
import '../review/messages';

/** 一開始顯示幾筆；其餘按「顯示全部」。 */
export const TEAM_ACTIVITY_SHOWN = 5;

function ActivityRow({
  item,
  busy,
  canvas,
  onRead,
  onClear,
}: {
  item: TeamActivity;
  busy: boolean;
  canvas: boolean;
  onRead: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const at = new Date(item.at);
  const vars = {
    lead: item.leadName,
    member: item.memberName,
    role: t(`flows.teamActivity.role.${item.role}`),
    team: item.teamName,
  };
  return (
    <li
      className={`activity-row${item.read ? '' : ' unread'}`}
      data-testid={`team-activity-${item.id}`}
      data-kind={item.kind}
      data-read={item.read ? '1' : '0'}
    >
      <time className="num" dateTime={item.at} title={at.toLocaleString(locale)}>
        {at.toLocaleString(locale, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
      <span className="activity-text">
        {!item.read && (
          <span className="activity-dot" aria-label={t('flows.teamActivity.unread')} />
        )}
        {t(
          item.kind === 'review_requested'
            ? 'review.activity'
            : item.kind === 'member_added'
              ? 'flows.teamActivity.added'
              : 'flows.teamActivity.released',
          vars,
        )}
      </span>
      <span className="activity-team">{item.teamName}</span>
      <span className="activity-reason">
        {t('flows.teamActivity.reason', { reason: mask(item.reason) })}
      </span>
      <span className="activity-acts">
        {item.kind === 'review_requested' && item.reviewId && (
          <a
            className="link"
            href={crossReviewHash(item.reviewId)}
            data-testid={`team-activity-review-${item.id}`}
          >
            {t('review.activity.open')}
          </a>
        )}
        {canvas && item.kind === 'member_added' && (
          <button
            type="button"
            className="link"
            onClick={() => useViewsUi.getState().focusSession(item.memberSessionId)}
            data-testid={`team-activity-show-${item.id}`}
          >
            {t('flows.teamActivity.show')}
          </button>
        )}
        {!item.read && (
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={onRead}
            data-testid={`team-activity-read-${item.id}`}
          >
            {t('flows.teamActivity.markRead')}
          </button>
        )}
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={onClear}
          data-testid={`team-activity-clear-${item.id}`}
        >
          {t('flows.teamActivity.clear')}
        </button>
      </span>
    </li>
  );
}

/**
 * 沒有任何動態時不顯示（收件匣保持乾淨）。canvas：桌面抽屜（畫布在底下）才有「在畫布上看」。
 */
export function TeamActivitySection({ canvas = false }: { canvas?: boolean }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const items = useBoard((s) => s.teamActivity) ?? [];
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  if (items.length === 0) return null;
  const unread = items.filter((a) => !a.read).length;
  const shown = all ? items : items.slice(0, TEAM_ACTIVITY_SHOWN);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setNote({ text: t('flows.teamActivity.failed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  const off = busy || !connected;
  return (
    <section
      className="team-activity"
      aria-labelledby="team-activity-title"
      data-testid="team-activity"
    >
      <header className="activity-head">
        <h2 id="team-activity-title">
          {t('flows.teamActivity.title')}
          {unread > 0 && (
            <span className="count num" data-testid="team-activity-unread">
              {unread}
            </span>
          )}
        </h2>
        <span className="activity-head-acts">
          {unread > 0 && (
            <button
              type="button"
              className="sm"
              disabled={off}
              onClick={() => void run(() => backend.readTeamActivity())}
              data-testid="team-activity-read-all"
            >
              {t('flows.teamActivity.markAllRead')}
            </button>
          )}
          <button
            type="button"
            className="sm"
            disabled={off}
            onClick={() => void run(() => backend.clearTeamActivity())}
            data-testid="team-activity-clear-all"
          >
            {t('flows.teamActivity.clearAll')}
          </button>
        </span>
      </header>
      <p className="hint">{t('flows.teamActivity.hint')}</p>
      <ol className="activity-list">
        {shown.map((item) => (
          <ActivityRow
            key={item.id}
            item={item}
            busy={off}
            canvas={canvas}
            onRead={() => void run(() => backend.readTeamActivity([item.id]))}
            onClear={() => void run(() => backend.clearTeamActivity([item.id]))}
          />
        ))}
      </ol>
      {items.length > TEAM_ACTIVITY_SHOWN && (
        <button
          type="button"
          className="link"
          onClick={() => setAll(!all)}
          data-testid="team-activity-more"
        >
          {all ? t('flows.teamActivity.fewer') : t('flows.teamActivity.more', { n: items.length })}
        </button>
      )}
      <Msg note={note} />
    </section>
  );
}
