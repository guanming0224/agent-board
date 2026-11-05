// 設定頁分類：左側選單（手機是上方分頁）＋網址 #/settings/<分類或區塊>。
import type { Settings } from '@agent-board/protocol';

export const CATEGORIES = [
  'account',
  'notify',
  'sessions',
  'security',
  'machines',
  'data',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const DEFAULT_CATEGORY: Category = 'account';

/** 整個分類只有 owner 用得到（hub 的 settings、users、machines 管理都只准 owner）。 */
export const OWNER_ONLY: ReadonlySet<Category> = new Set(['notify', 'security', 'machines']);

/**
 * 每個區塊（id="s-<id>"）在哪個分類。舊連結 #/settings/<區塊 id> 也能落到對的分類與位置。
 * 分類 id 和區塊 id 重複的（notify、security、machines）指向同一個分類，不衝突。
 */
export const SECTION_CATEGORY: Readonly<Record<string, Category>> = {
  account: 'account',
  language: 'account',
  password: 'account',
  push: 'account',
  notify: 'notify',
  templates: 'sessions',
  quota: 'sessions',
  stuck: 'sessions',
  security: 'security',
  machines: 'machines',
  users: 'machines',
  archived: 'data',
  audit: 'data',
};

/** 伺服器設定的每個欄位放在哪個分類（選單標「未存檔」用）。 */
export const KEY_CATEGORY: Record<keyof Settings, Category> = {
  notifications: 'notify',
  quotaGuards: 'sessions',
  stuckMinutes: 'sessions',
  listenAddress: 'security',
  publicOrigin: 'security',
  dangerRules: 'security',
};

/** 有伺服器設定欄位的分類：儲存列一直顯示。 */
export const FORM_CATEGORIES: ReadonlySet<Category> = new Set(Object.values(KEY_CATEGORY));

const isCategory = (value: string): value is Category =>
  (CATEGORIES as readonly string[]).includes(value);

export interface SettingsTarget {
  category: Category;
  /** 要捲到的區塊 id（不含 s- 前綴）；只給分類時是 null。 */
  section: string | null;
}

/** 解析 #/settings/<分類或區塊>；不認得的一律回到預設分類。 */
export function parseSettingsHash(hash: string): SettingsTarget {
  const [route, part = ''] = hash.replace(/^#\/?/, '').split('/');
  if (route !== 'settings' || !part) return { category: DEFAULT_CATEGORY, section: null };
  const name = decodeURIComponent(part);
  if (isCategory(name)) return { category: name, section: null };
  const category = SECTION_CATEGORY[name];
  return category ? { category, section: name } : { category: DEFAULT_CATEGORY, section: null };
}

export const settingsHash = (target: Category | string) => `#/settings/${target}`;

/** 這個人看得到的分類。還不知道身分（載入中、讀不到）時全部顯示，交給 hub 擋。 */
export function visibleCategories(role: 'owner' | 'member' | null | undefined): Category[] {
  if (role !== 'member') return [...CATEGORIES];
  return CATEGORIES.filter((c) => !OWNER_ONLY.has(c));
}
