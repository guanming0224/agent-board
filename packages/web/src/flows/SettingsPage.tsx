// 設定（DISPATCH §5.3-7）：左側分類選單（手機是上方分頁），右邊只顯示選中的分類。
// 網址帶分類：#/settings/<分類>；舊連結 #/settings/<區塊 id> 會落到所在分類並捲到那一區。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ErrorBox, Loading, Page, useCurrentUser, useLoad } from './common';
import { LanguageSection, PushDeviceSection, SignedInSection } from './AccountSettings';
import { ArchivedSection } from './ArchivedSection';
import { AuditSection } from './AuditSection';
import { MachinesSection, UsersSection } from './MachinesUsersSettings';
import { PasswordSection } from './PasswordSection';
import {
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
  parseSettingsHash,
  settingsHash,
  visibleCategories,
  type Category,
} from './settingsNav';
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

export function SettingsPage() {
  const t = useT();
  const { backend } = useBoard();
  const me = useCurrentUser();
  const settings = useLoad(useCallback(() => backend.getSettings(), [backend]));
  // 草稿在這一層：切換分類不會丟掉還沒存的修改。
  const form = useServerSettings(settings.data);
  const target = useSettingsTarget();
  const role = me.data?.role;
  const isMember = role === 'member';
  const categories = visibleCategories(role);
  const current = categories.includes(target.category) ? target.category : DEFAULT_CATEGORY;

  // 換分類回到頁首；網址指定區塊時捲到那一區（區塊可能要等資料讀到才出現）。
  const scrolled = useRef<string | null>(null);
  const firstCategory = useRef(true);
  useEffect(() => {
    if (firstCategory.current) {
      firstCategory.current = false;
      return;
    }
    if (!target.section) scrollTo(0, 0);
  }, [current, target.section]);
  useEffect(() => {
    if (!target.section) {
      scrolled.current = null;
      return;
    }
    const key = `${current}/${target.section}`;
    if (scrolled.current === key) return;
    const element = document.getElementById(`s-${target.section}`);
    if (!element || element.closest('[hidden]')) return;
    scrolled.current = key;
    element.scrollIntoView({ block: 'start' });
  }, [current, target.section, form, me.data]);

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

  // 在沒有表單的分類，儲存列只在有未存修改時出現；按下儲存後留到換分類，結果訊息才看得到。
  const dirty = (form?.dirtyKeys.length ?? 0) > 0;
  const [barPinnedAt, setBarPinnedAt] = useState<Category | null>(null);
  if (dirty && barPinnedAt !== current) setBarPinnedAt(current);
  const showSaveBar =
    form !== null &&
    !isMember &&
    (FORM_CATEGORIES.has(current) || dirty || barPinnedAt === current);

  return (
    <Page>
      <header className="page-head">
        <h1>{t('flows.settings.title')}</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('flows.settings.nav')}>
          <ul>
            {categories.map((category) => {
              const dirty = form?.dirtyCategories.has(category) ?? false;
              return (
                <li key={category}>
                  <a
                    id={`settings-nav-${category}`}
                    href={settingsHash(category)}
                    aria-current={category === current ? 'page' : undefined}
                    data-dirty={dirty || undefined}
                  >
                    <span>{t(`flows.settings.cat.${category}`)}</span>
                    {dirty && <span className="chip unsaved">{t('flows.settings.unsaved')}</span>}
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
                !isMember &&
                server((f) => (
                  <>
                    <QuotaSection form={f} />
                    <StuckSection form={f} />
                  </>
                ))}
            </>,
          )}
          {group('security', current === 'security' && server((f) => <SecuritySection form={f} />))}
          {group(
            'machines',
            <>
              <MachinesSection />
              <UsersSection />
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
  );
}
