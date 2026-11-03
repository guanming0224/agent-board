import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { CanvasPage, QueuePage, TerminalPage } from './canvas';
import {
  InboxPage,
  LoginPage,
  NewSessionPage,
  OnboardingPage,
  ReviewPage,
  SettingsPage,
} from './flows';
import { applyAccountLocale } from './flows/locale';
import { isDemo, useBoard } from './shared/store';
import { TeamPage } from './team';
import { AppHeader, type TabName } from './views';

const ROUTES: Record<string, ComponentType> = {
  canvas: CanvasPage,
  queue: QueuePage,
  terminal: TerminalPage,
  team: TeamPage,
  new: NewSessionPage,
  review: ReviewPage,
  inbox: InboxPage,
  settings: SettingsPage,
  onboarding: OnboardingPage,
  login: LoginPage,
};

/** 這些頁面自己沒有導覽，要包 App 頁首。畫布與待處理由 PageShell 自帶。 */
const WITH_HEADER: Record<string, TabName> = {
  new: 'canvas',
  review: 'review',
  settings: 'settings',
};

const PUBLIC_ROUTES = new Set(['login', 'onboarding']);
const PHONE_WIDTH = 640;

function currentRoute(): string {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  return name in ROUTES ? name : 'canvas';
}

function WithHeader({ tab, children }: { tab: TabName; children: ReactNode }) {
  const header = useRef<HTMLDivElement>(null);

  // 流程頁的 sticky 元素要避開頁首，頁首高度會隨換行改變。
  useEffect(() => {
    const element = header.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        '--app-header-height',
        `${element.offsetHeight}px`,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={header} style={{ position: 'sticky', top: 0, zIndex: 20 }}>
        <AppHeader tab={tab} />
      </div>
      {children}
    </>
  );
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [checked, setChecked] = useState(isDemo);
  const backend = useBoard((s) => s.backend);

  useEffect(() => {
    if (!location.hash && innerWidth <= PHONE_WIDTH) location.hash = '#/inbox';
    const onChange = () => setRoute(currentRoute());
    onChange();
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    void (async () => {
      try {
        const user = (await backend.needsSetup()) ? undefined : await backend.currentUser();
        if (user === undefined) location.hash = '#/onboarding';
        else if (!user) location.hash = '#/login';
        else {
          // 已登入：畫面用帳號的語言（只在開頁時套一次，之後切換由頁首／設定頁負責）。
          if (!cancelled) applyAccountLocale(user);
          if (PUBLIC_ROUTES.has(currentRoute())) location.hash = '#/canvas';
        }
      } catch {
        // hub 連不上時停在登入頁，那裡會說明怎麼辦。
        location.hash = '#/login';
      }
      if (!cancelled) setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [backend]);

  if (!checked) return null;

  const Page = ROUTES[route] ?? CanvasPage;
  const tab = WITH_HEADER[route];
  return tab ? (
    <WithHeader tab={tab}>
      <Page />
    </WithHeader>
  ) : (
    <Page />
  );
}
