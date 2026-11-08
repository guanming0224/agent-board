import { useEffect, useRef, type ReactNode } from 'react';
import { useBoard } from '../shared/store';
import { AppHeader } from './AppHeader';
import { Sidebar } from './Sidebar';
import { StaleBanner } from './states';
import { useViewsUi } from './uiStore';
import './views.css';
import './messages';

/** 頁首高度給疊加層用：右側面板從頁首下緣開始（頁首會隨換行、橫幅改變高度）。 */
export function useHeaderHeight() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        '--app-header-height',
        `${Math.round(element.getBoundingClientRect().bottom)}px`,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** 頁首、資料過期列、側欄、主區。畫布滿版。 */
export function PageShell({ children }: { children: ReactNode }) {
  const connected = useBoard((s) => s.connected);
  const sideOpen = useViewsUi((s) => s.sideOpen);
  const header = useHeaderHeight();
  return (
    <div className={`shell${connected ? '' : ' is-stale'}`}>
      <div ref={header} className="shell-head">
        <AppHeader />
        {!connected && <StaleBanner />}
      </div>
      <div className={`board${sideOpen ? ' side-open' : ''}`}>
        <Sidebar />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
