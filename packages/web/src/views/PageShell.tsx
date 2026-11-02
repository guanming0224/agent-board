import type { ReactNode } from 'react';
import { useBoard } from '../shared/store';
import { AppHeader, type TabName } from './AppHeader';
import { Sidebar } from './Sidebar';
import { StaleBanner } from './states';
import { useViewsUi } from './uiStore';
import './views.css';
import './messages';

/** 頁首、資料過期列、側欄、主區。畫布滿版，其他頁的 1320px 上限由頁面自己的 `.page` 控制。 */
export function PageShell({ tab, children }: { tab: TabName; children: ReactNode }) {
  const connected = useBoard((s) => s.connected);
  const sideOpen = useViewsUi((s) => s.sideOpen);
  return (
    <div className={`shell${connected ? '' : ' is-stale'}`}>
      <AppHeader tab={tab} />
      {!connected && <StaleBanner />}
      <div className={`board${sideOpen ? ' side-open' : ''}`}>
        <Sidebar />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
