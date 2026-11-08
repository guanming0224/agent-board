import { useEffect, useState } from 'react';
import { chooseLocale } from '../flows/locale';
import { MaskChip } from '../security';
import { ZoneTabs } from '../zones';
import { useLocale, useT, type Locale } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { openSearch, useOverlay, toggleInbox } from './overlayStore';
import { nextInQueue, pendingQueue } from './queue';
import { useViewsUi } from './uiStore';
import { formatTokens, formatTokensFull, usageTotals } from './usage';
import { useUsagePolling, useUsageStore } from './usageStore';
import { useWaiting, WaitingBanner } from './waiting';

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

/** 各機器近 N 天的 token 合計。不是額度百分比：沒有上限可比，所以只是灰字。 */
function UsageSummaryText() {
  const t = useT();
  const { locale } = useLocale();
  const machines = useBoard((s) => s.machines);
  const byMachine = useUsageStore((s) => s.byMachine);
  const totals = usageTotals(machines.map((m) => byMachine[m.id]));
  if (!totals) {
    return (
      <span title={t('views.usage.noneTitle')} data-testid="usage-total">
        {t('views.usage.none')}
      </span>
    );
  }
  return (
    <span
      className="num"
      data-testid="usage-total"
      title={t('views.usage.title', {
        days: totals.days,
        tokens: formatTokensFull(totals.tokens, locale),
        cache: formatTokensFull(totals.cacheTokens, locale),
        machines: totals.machines,
      })}
    >
      {t('views.usage.short', { days: totals.days, tokens: formatTokens(totals.tokens, locale) })}
    </span>
  );
}

/**
 * 頁首（P2 §1.2）：沒有原本的分頁列，那個位置改放工作區分頁（P2 §2.3）。畫布是唯一主畫面，收件匣、團隊、設定都疊在畫布上，
 * 從這裡的收件匣鈕、齒輪或網址打開。
 */
export function AppHeader() {
  const t = useT();
  const { sessions, approvals, machines, backend } = useBoard();
  const { locale } = useLocale();
  const focusSession = useViewsUi((s) => s.focusSession);
  const inboxOpen = useOverlay((s) => s.right?.kind === 'inbox');
  const settingsOpen = useOverlay((s) => s.modal === 'settings');
  const searchOpen = useOverlay((s) => s.modal === 'search');
  const [announce, setAnnounce] = useState('');
  useUsagePolling();
  const queue = pendingQueue(sessions, approvals);
  // 頁首的數字：真的在等你的（剛開好的 NEW 不算；protocol attention.ts）。「下一個」巡 pendingQueue，同樣不含 NEW。
  const { count: waiting } = useWaiting();
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
    // 面板開著也照常：畫布在底下，聚焦那張卡；收件匣裡同一項會跟著標出（P2 §1.2）。
    // 在全尺寸終端機頁時，那一頁自己會回到畫布。
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
        {waiting > 0 ? (
          <a
            className="waiting"
            href="#/inbox"
            role="status"
            aria-label={t('views.waiting.aria', { n: waiting })}
            title={t('views.waiting.link')}
            data-testid="waiting-link"
          >
            <span>{t('label.waiting')}</span>
            <b className="num" data-testid="waiting-count">
              {waiting}
            </b>
          </a>
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
          <UsageSummaryText />
        </span>
        <MaskChip />
        <div className="seg" role="group" aria-label={t('views.locale.aria')}>
          {LOCALES.map((l) => (
            <button
              key={l.value}
              aria-pressed={locale === l.value}
              // 畫面立刻換，同時存到帳號（下次登入、別的裝置也是這個語言）。
              // 存失敗只影響下次登入，頁首沒有放訊息的地方，所以不打擾。
              onClick={() => void chooseLocale(backend, l.value).catch(() => undefined)}
            >
              {l.label}
            </button>
          ))}
        </div>
        {/* 桌面畫布的「新增 session」在底部指令列（P2 §3.3），這顆只在手機與全尺寸終端機頁出現（views.css）。 */}
        <button
          className="header-new"
          onClick={() => {
            // 在畫布上就原地打開快速建立，其他頁面去完整表單。
            const open = useViewsUi.getState().openQuickCreate;
            if (open) open();
            else location.hash = '#/new';
          }}
        >
          {t('views.newSession')}
        </button>
        {/* 全域搜尋（P3 §3.3）：收件匣鈕左邊；⌘K／Ctrl+K 或 / 也能開。 */}
        <button
          type="button"
          className="search-btn"
          aria-pressed={searchOpen}
          aria-label={t('views.search.aria')}
          title={t('views.search.title')}
          onClick={openSearch}
          data-testid="search-button"
        >
          <span aria-hidden="true">⌕</span>
          <span className="search-btn-label">{t('views.search.label')}</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          type="button"
          className="inbox-btn"
          aria-pressed={inboxOpen}
          aria-label={t('views.inbox.aria', { n: waiting })}
          title={t('views.inbox.title')}
          onClick={toggleInbox}
          data-testid="inbox-button"
        >
          {t('views.inbox.label')}
          <b className="num">{waiting}</b>
          <kbd>I</kbd>
        </button>
        <a
          className="button icon gear"
          href="#/settings"
          aria-label={t('views.settings.aria')}
          aria-current={settingsOpen ? 'page' : undefined}
          title={t('views.settings.aria')}
          data-testid="settings-button"
        >
          <span aria-hidden="true">⚙</span>
        </a>
      </div>
      {/* 工作區分頁（P2 §2.3）：原分頁列的位置。「等你 N」與收件匣一律全域，分頁上另外顯示各自的等你數。 */}
      <ZoneTabs />
      <WaitingBanner />
    </header>
  );
}
