// 載入中、空的、錯誤、資料過期（STYLE.md §2-8）。
import { useState, type ReactNode } from 'react';
import { useT } from '../shared/i18n';
import { useClock } from './session';

export function LoadingState() {
  const t = useT();
  return (
    <div className="state" role="status" data-state="loading">
      <p className="sub">{t('views.loading')}</p>
    </div>
  );
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="state" data-state="empty">
      <p>{text}</p>
      {action}
    </div>
  );
}

export function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="state" data-state="error">
      <div className="alert" role="alert">
        <span aria-hidden="true">✕</span>
        <div>{text}</div>
      </div>
      <button onClick={onRetry}>{t('views.retry')}</button>
    </div>
  );
}

/** hub 斷線的當下才掛上，所以掛上的時間就是畫面凍結的時間。 */
export function StaleBanner() {
  const t = useT();
  const clock = useClock();
  const [since] = useState(() => new Date().toISOString());
  return (
    <div className="stale-line" role="alert" data-state="stale">
      {t('views.stale', { time: clock(since) })}
    </div>
  );
}
