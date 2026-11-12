// 收件匣的「交叉審查」區塊（Codex 第二輪）：結束了、還沒讀的審查，加上等 GM 確認的。只是告知，不算在「等你」裡。
// 桌面抽屜（InboxBoard）與手機收件匣（InboxPage）共用。
import { useState } from 'react';
import { useMaskText } from '../security';
import { errorText, Msg, type Note } from '../flows/common';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { crossReviewHash } from '../views/overlay';
import { awaitingReviews, unreadReviews } from './model';
import './messages';
import './review.css';

export function ReviewInboxSection() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const reviews = useBoard((s) => s.reviews) ?? [];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const unread = unreadReviews(reviews);
  const awaiting = awaitingReviews(reviews);
  if (unread.length === 0 && awaiting.length === 0) return null;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setNote({ text: t('review.failed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  const off = busy || !connected;
  return (
    <section
      className="team-activity cross-review-inbox"
      aria-labelledby="cross-review-inbox-title"
      data-testid="cross-review-inbox"
    >
      <header className="activity-head">
        <h2 id="cross-review-inbox-title">
          {t('review.inbox.title')}
          {unread.length > 0 && (
            <span className="count num" data-testid="cross-review-unread">
              {unread.length}
            </span>
          )}
        </h2>
        {unread.length > 0 && (
          <span className="activity-head-acts">
            <button
              type="button"
              className="sm"
              disabled={off}
              onClick={() => void run(() => backend.readReviews(unread.map((r) => r.id)))}
              data-testid="cross-review-read-all"
            >
              {t('review.inbox.markAllRead')}
            </button>
          </span>
        )}
      </header>
      <p className="hint">{t('review.inbox.hint')}</p>
      {awaiting.length > 0 && (
        <p className="hint">{t('review.inbox.awaiting', { n: awaiting.length })}</p>
      )}
      <ol className="activity-list">
        {[...awaiting, ...unread].map((review) => (
          <li
            key={review.id}
            className={`activity-row cr-inbox-row${review.read ? '' : ' unread'}`}
            data-testid={`cross-review-item-${review.id}`}
            data-status={review.status}
          >
            <time className="num" dateTime={review.createdAt}>
              {new Date(review.completedAt ?? review.createdAt).toLocaleString(locale, {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
            </time>
            <span className="cr-inbox-label">
              {mask(review.target.label)} · {t(`review.state.${review.status}`)}
            </span>
            <span className="activity-acts">
              <a
                className="link"
                href={crossReviewHash(review.id)}
                data-testid={`cross-review-open-${review.id}`}
              >
                {t('review.inbox.open')}
              </a>
              {!review.read && review.status !== 'awaiting_confirm' && (
                <button
                  type="button"
                  className="link"
                  disabled={off}
                  onClick={() => void run(() => backend.readReviews([review.id]))}
                >
                  {t('review.markRead')}
                </button>
              )}
            </span>
          </li>
        ))}
      </ol>
      <Msg note={note} />
    </section>
  );
}
