// 設定（DISPATCH §5.3-7）：左側分類選單（手機是上方分頁），右邊只顯示選中的分類。
// 網址帶分類：#/settings/<分類>；舊連結 #/settings/<區塊 id> 會落到所在分類並捲到那一區。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Settings } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ErrorBox, Loading, Page, scrollPageTop, useCurrentUser, useLoad } from './common';
import { LanguageSection, PushDeviceSection, SignedInSection } from './AccountSettings';
import { ArchivedSection } from './ArchivedSection';
import { AuditSection } from './AuditSection';
import { MachinesSection, UsersSection } from './MachinesUsersSettings';
import { PasswordSection } from './PasswordSection';
import {
  AutoContinueSection,
  DispatchSection,
  MemorySection,
  NotifySection,
  QuotaSection,
  SaveBar,
  SecuritySection,
  StuckSection,
  useServerSettings,
  type ServerSettingsForm,
} from './ServerSettings';
import {
  DEFAULT_CATEGORY,
  FORM_CATEGORIES,
  ownerContent,
  parseSettingsHash,
  settingsAccess,
  settingsHash,
  visibleCategories,
  type Category,
} from './settingsNav';
import { SettingsUserContext } from './settingsParts';
import { settingsCategoryContent } from './settingsExtra';
import { TemplatesSection } from './TemplatesSection';

function useSettingsTarget() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseSettingsHash(hash), [hash]);
}

/** 最多等這麼久讓區塊出現、版面穩定（上方內容讀完會把目標往下推；Safari 沒有捲動錨定）。 */
const SCROLL_WAIT_MS = 1000;
/** 連續這麼多個畫格位置不變才算穩定。 */
const STABLE_FRAMES = 10;
/** 捲到之後再盯這麼久：上方內容晚到、把目標推走時再捲一次。使用者自己捲動就不再管。 */
const PIN_MS = 3000;

/** 網址指定區塊時，等它出現而且版面不再移動，再捲過去；之後一小段時間內版面變了就再捲一次。 */
function useScrollToSection(section: string | null, ready: boolean, current: Category) {
  useEffect(() => {
    if (!section || !ready) return;
    const start = performance.now();
    let last = '';
    let stable = 0;
    let pinnedAt: number | null = null;
    let pinnedTop = 0;
    let userMoved = false;
    const onUser = () => {
      userMoved = true;
    };
    const userEvents = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    for (const name of userEvents) addEventListener(name, onUser, { passive: true });
    const stop = () => {
      for (const name of userEvents) removeEventListener(name, onUser);
    };
    let frame = requestAnimationFrame(function tick() {
      if (userMoved) return stop();
      const element = document.getElementById(`s-${section}`);
      const now = performance.now();
      if (pinnedAt !== null) {
        if (now - pinnedAt > PIN_MS || !element) return stop();
        const top = Math.round(element.getBoundingClientRect().top);
        if (Math.abs(top - pinnedTop) > 1) {
          element.scrollIntoView({ block: 'start' });
          pinnedTop = Math.round(element.getBoundingClientRect().top);
        }
        frame = requestAnimationFrame(tick);
        return;
      }
      const late = now - start > SCROLL_WAIT_MS;
      if (element && !element.closest('[hidden]')) {
        const top = Math.round(element.getBoundingClientRect().top + scrollY);
        const layout = `${top}/${document.documentElement.scrollHeight}`;
        stable = layout === last ? stable + 1 : 0;
        last = layout;
        if (stable >= STABLE_FRAMES || late) {
          element.scrollIntoView({ block: 'start' });
          pinnedAt = now;
          pinnedTop = Math.round(element.getBoundingClientRect().top);
        }
      } else if (late) {
        return stop();
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [section, ready, current]);
}

/** 其他資料夾註冊的分類內容（例如 team 的 Presets）；沒註冊就是空的。 */
function RegisteredContent({ category }: { category: Category }) {
  const Content = settingsCategoryContent(category);
  return Content ? <Content /> : null;
}

export function SettingsPage() {
  const t = useT();
  const { backend } = useBoard();
  // 只讀一次目前登入的人，用 context 給各區塊。
  const me = useCurrentUser();
  const access = settingsAccess(me);
  const owner = ownerContent(access);
  // 還不知道身分時不讀 hub 設定：成員讀了只會拿到 403。
  const settings = useLoad(
    useCallback(
      (): Promise<Settings | null> => (owner ? backend.getSettings() : Promise.resolve(null)),
      [backend, owner],
    ),
  );
  // 草稿在這一層：切換分類不會丟掉還沒存的修改。
  const form = useServerSettings(settings.data);
  const target = useSettingsTarget();
  const categories = visibleCategories(access);
  const current = categories.includes(target.category) ? target.category : DEFAULT_CATEGORY;
  const ready = access !== 'loading';

  // 換分類回到頁首（網址指定區塊時改捲到那一區）。
  const firstCategory = useRef(true);
  useEffect(() => {
    if (firstCategory.current) {
      firstCategory.current = false;
      return;
    }
    if (!target.section) scrollPageTop();
  }, [current, target.section]);
  useScrollToSection(target.section, ready, current);

  // 在沒有表單的分類，儲存列只在有未存修改時出現；按下儲存後留到換分類，結果訊息才看得到。
  const dirty = (form?.dirtyKeys.length ?? 0) > 0;
  const [barPinnedAt, setBarPinnedAt] = useState<Category | null>(null);
  if (dirty && barPinnedAt !== current) setBarPinnedAt(current);

  // 身分還沒讀到：先不畫選單與內容，免得 owner 專屬的東西閃一下又消失。
  if (!ready) {
    return (
      <Page>
        <header className="page-head">
          <h1>{t('flows.settings.title')}</h1>
        </header>
        <Loading />
      </Page>
    );
  }

  /** 有自己狀態的區塊一直掛著、只是藏起來，切回來時輸入到一半的內容還在。 */
  const group = (category: Category, children: ReactNode) =>
    categories.includes(category) && (
      <div
        className="settings-group"
        data-category={category}
        hidden={category !== current}
        aria-labelledby={`settings-nav-${category}`}
        role="region"
      >
        {children}
      </div>
    );

  /** hub 設定的區塊：狀態在 form 裡，只畫眼前這個分類。 */
  const server = (render: (form: ServerSettingsForm) => ReactNode) =>
    settings.error && !form ? (
      <ErrorBox
        what={t('flows.settings.loadFailed', { error: settings.error })}
        how={t('flows.settings.loadHow')}
        onRetry={settings.reload}
      />
    ) : form ? (
      render(form)
    ) : (
      <Loading />
    );

  const showSaveBar =
    form !== null && owner && (FORM_CATEGORIES.has(current) || dirty || barPinnedAt === current);

  return (
    <SettingsUserContext.Provider value={me}>
      <Page>
        <header className="page-head">
          <h1>{t('flows.settings.title')}</h1>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('flows.settings.nav')}>
            <ul>
              {categories.map((category) => {
                const categoryDirty = form?.dirtyCategories.has(category) ?? false;
                return (
                  <li key={category}>
                    <a
                      id={`settings-nav-${category}`}
                      href={settingsHash(category)}
                      aria-current={category === current ? 'page' : undefined}
                      data-dirty={categoryDirty || undefined}
                    >
                      <span>{t(`flows.settings.cat.${category}`)}</span>
                      {categoryDirty && (
                        <span className="chip unsaved">{t('flows.settings.unsaved')}</span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className={`settings-panel${current === 'data' ? ' wide' : ''}`}>
            {group(
              'account',
              <>
                <SignedInSection />
                <LanguageSection />
                <PasswordSection />
                <PushDeviceSection />
              </>,
            )}
            {group('notify', current === 'notify' && server((f) => <NotifySection form={f} />))}
            {group(
              'sessions',
              <>
                <TemplatesSection />
                {current === 'sessions' &&
                  owner &&
                  server((f) => (
                    <>
                      <QuotaSection form={f} />
                      <AutoContinueSection form={f} />
                      <DispatchSection form={f} />
                      <MemorySection form={f} />
                      <StuckSection form={f} />
                    </>
                  ))}
              </>,
            )}
            {group('presets', <RegisteredContent category="presets" />)}
            {group(
              'security',
              current === 'security' && server((f) => <SecuritySection form={f} />),
            )}
            {group(
              'machines',
              <>
                <MachinesSection canManage={owner} />
                {owner && <UsersSection />}
              </>,
            )}
            {group(
              'data',
              <>
                <ArchivedSection />
                <AuditSection />
              </>,
            )}
            {showSaveBar && <SaveBar form={form} current={current} order={categories} />}
          </div>
        </div>
      </Page>
    </SettingsUserContext.Provider>
  );
}
