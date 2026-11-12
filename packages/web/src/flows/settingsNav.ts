// 設定頁分類：左側選單（手機是上方分頁）＋網址 #/settings/<分類或區塊>。
import type { Settings } from '@agent-board/protocol';

export const CATEGORIES = [
  'account',
  'notify',
  'sessions',
  // 團隊 Presets（P3 項目二）：內容由 team 資料夾註冊（settingsExtra.ts）。
  'presets',
  'security',
  'machines',
  'data',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const DEFAULT_CATEGORY: Category = 'account';

/**
 * 整個分類只有 owner 用得到（hub 的 settings 只准 owner）。
 * 「機器與使用者」成員也看得到：機器清單是 user 權限，只是唯讀；使用者區只有 owner。
 */
export const OWNER_ONLY: ReadonlySet<Category> = new Set(['notify', 'security']);

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
  autocontinue: 'sessions',
  dispatch: 'sessions',
  codexMcp: 'sessions',
  autostaff: 'sessions',
  review: 'sessions',
  memory: 'sessions',
  stuck: 'sessions',
  presets: 'presets',
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
  autoContinue: 'sessions',
  dispatch: 'sessions',
  codexMcp: 'sessions',
  autoStaff: 'sessions',
  review: 'sessions',
  memory: 'sessions',
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
  let name: string;
  try {
    name = decodeURIComponent(part);
  } catch {
    // 壞掉的百分比編碼（例如 %E0）：當成不認得，不讓整頁掛掉。
    return { category: DEFAULT_CATEGORY, section: null };
  }
  if (isCategory(name)) return { category: name, section: null };
  // 只認自己的 key，不讓 toString、__proto__ 這類原型上的名字混進來。
  const category = Object.hasOwn(SECTION_CATEGORY, name) ? SECTION_CATEGORY[name] : undefined;
  return category ? { category, section: name } : { category: DEFAULT_CATEGORY, section: null };
}

export const settingsHash = (target: Category | string) => `#/settings/${target}`;

/**
 * 目前登入的人能用到多少：loading 還不知道（只畫大家都能用的）；
 * unknown 是讀不到身分，照舊全部顯示、交給 hub 擋。
 */
export type SettingsAccess = 'loading' | 'owner' | 'member' | 'unknown';

export function settingsAccess(me: {
  data: { role: 'owner' | 'member' } | null;
  loading: boolean;
  error: string | null;
}): SettingsAccess {
  if (me.data) return me.data.role;
  if (me.loading && !me.error) return 'loading';
  return 'unknown';
}

/** 看得到 owner 專屬的分類與區塊嗎。 */
export const ownerContent = (access: SettingsAccess) => access === 'owner' || access === 'unknown';

/** 這個人看得到的分類。 */
export function visibleCategories(access: SettingsAccess): Category[] {
  return ownerContent(access) ? [...CATEGORIES] : CATEGORIES.filter((c) => !OWNER_ONLY.has(c));
}
