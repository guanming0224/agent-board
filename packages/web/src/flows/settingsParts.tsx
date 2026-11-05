// 設定頁各分類共用：區塊外框、選用的管理員後端方法。
import type { ReactNode } from 'react';
import type { User } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { useT } from '../shared/i18n';

/**
 * REST 已有這些路由（protocol/rest.ts），但 BoardBackend 還沒開放。
 * 寫成選用：後端補上方法後畫面自動可用，沒補時照實告訴使用者。
 */
export interface OptionalAdmin {
  listUsers?: () => Promise<User[]>;
  createUser?: (input: {
    name: string;
    password: string;
    role: User['role'];
    locale: User['locale'];
  }) => Promise<User>;
  deleteUser?: (id: string) => Promise<void>;
  deleteTemplate?: (id: string) => Promise<void>;
}
export type AdminBackend = BoardBackend & OptionalAdmin;

export function Section({
  id,
  title,
  dirty,
  children,
}: {
  id: string;
  title: string;
  dirty?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className={`form-card${dirty ? ' dirty' : ''}`} aria-labelledby={id} id={`s-${id}`}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        {dirty && <span className="chip unsaved">{t('flows.settings.unsaved')}</span>}
      </div>
      {children}
    </section>
  );
}
