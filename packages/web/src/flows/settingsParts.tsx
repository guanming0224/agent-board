// 設定頁各分類共用：區塊外框、目前登入的人、選用的管理員後端方法。
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useCurrentUser, type Loaded } from './common';

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

/** 設定頁讀一次目前登入的人，各區塊共用，不各自打 /api/auth/me。 */
export const SettingsUserContext = createContext<Loaded<User | null> | null>(null);

export function useSettingsUser(): Loaded<User | null> {
  const me = useContext(SettingsUserContext);
  if (!me) throw new Error('useSettingsUser 要放在設定頁（SettingsUserContext）裡面');
  return me;
}

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

/** 還沒有機器時的下一步：管理員連到設定配對；成員不能配對，請他找管理員。 */
export function PairMachineNext({ label, className }: { label: string; className?: string }) {
  const t = useT();
  const me = useCurrentUser();
  if (me.data?.role === 'member') {
    return <span data-testid="pair-ask-owner">{t('flows.new.noMachinesMember')}</span>;
  }
  return (
    <a className={className} href="#/settings/machines">
      {label}
    </a>
  );
}
