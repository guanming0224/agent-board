import { useEffect, useState } from 'react';
import { MaskChip } from '../security';
import { useLocale, useT, type Locale } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { nextInQueue, pendingQueue } from './queue';
import { useViewsUi } from './uiStore';

export type TabName = 'canvas' | 'queue' | 'review' | 'team' | 'settings';

const TABS: { name: TabName; labelKey: string; hash?: string }[] = [
  { name: 'canvas', labelKey: 'views.tab.canvas', hash: '#/canvas' },
  { name: 'queue', labelKey: 'views.tab.queue', hash: '#/queue' },
  { name: 'review', labelKey: 'views.tab.review', hash: '#/review' },
  { name: 'team', labelKey: 'views.tab.team', hash: '#/team' },
  { name: 'settings', labelKey: 'views.tab.settings', hash: '#/settings' },
];

const LOCALES: { value: Locale; label: string }[] = [
  { value: 'zh-TW', label: '中' },
  { value: 'en', label: 'EN' },
];

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  );
}

export function AppHeader({ tab }: { tab: TabName }) {
  const t = useT();
  const { sessions, approvals, machines } = useBoard();
  const { locale, setLocale } = useLocale();
  const focusSession = useViewsUi((s) => s.focusSession);
  const [announce, setAnnounce] = useState('');
  const queue = pendingQueue(sessions, approvals);
  const online = machines.filter((m) => m.online).length;
  const off = machines.length - online;

  const goNext = () => {
    const next = nextInQueue(queue, useViewsUi.getState().cursorId);
    if (!next) return;
    focusSession(next.id);
    setAnnounce(
      t('views.next.aria', {
        name: next.name,
        i: queue.findIndex((s) => s.id === next.id) + 1,
        n: queue.length,
      }),
    );
    if (tab !== 'canvas') location.hash = '#/canvas';
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || isTyping(e.target)) return;
      e.preventDefault();
      goNext();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <header className="top">
      <div className="bar">
        <span className="brand">{t('views.brand')}</span>
        {queue.length > 0 ? (
          <span
            className="waiting"
            role="status"
            aria-label={t('views.waiting.aria', { n: queue.length })}
          >
            <span>{t('label.waiting')}</span>
            <b className="num" data-testid="waiting-count">
              {queue.length}
            </b>
          </span>
        ) : (
          <span className="waiting none" role="status" data-testid="waiting-none">
            <span>{t('views.waiting.none')}</span>
          </span>
        )}
        <button
          // 沒事時不留亮色（STYLE.md 邏輯 5）。
          className={queue.length > 0 ? 'primary' : undefined}
          onClick={goNext}
          disabled={queue.length === 0}
          data-testid="next-up"
        >
          {t('action.next')}
          <kbd>N</kbd>
        </button>
        <span className="sr-only" role="status" data-testid="next-announce">
          {announce}
        </span>
        <span className="spacer" />
        <span className="meta">
          <span>
            {off > 0
              ? t('views.machines.summaryOff', { online, off })
              : t('views.machines.summary', { online })}
          </span>
          <span title={t('views.quota.title')}>{t('views.quota.short')}</span>
        </span>
        <MaskChip />
        <div className="seg" role="group" aria-label={t('views.locale.aria')}>
          {LOCALES.map((l) => (
            <button
              key={l.value}
              aria-pressed={locale === l.value}
              onClick={() => setLocale(l.value)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <button onClick={() => (location.hash = '#/new')}>{t('views.newSession')}</button>
      </div>
      <nav className="tabs" aria-label={t('views.tab.nav')}>
        {TABS.map((item) =>
          item.hash ? (
            <a
              key={item.name}
              href={item.hash}
              aria-current={item.name === tab ? 'page' : undefined}
            >
              {t(item.labelKey)}
            </a>
          ) : (
            <span key={item.name} className="off" title={t('views.tab.notYet')} aria-disabled>
              {t(item.labelKey)}
            </span>
          ),
        )}
      </nav>
    </header>
  );
}
