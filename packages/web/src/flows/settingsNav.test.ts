import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  KEY_CATEGORY,
  parseSettingsHash,
  SECTION_CATEGORY,
  settingsAccess,
  visibleCategories,
} from './settingsNav';

describe('parseSettingsHash', () => {
  it('沒有分類時回到我的帳號', () => {
    expect(parseSettingsHash('#/settings')).toEqual({ category: 'account', section: null });
    expect(parseSettingsHash('#/settings/')).toEqual({ category: 'account', section: null });
  });

  it('分類 id 直接選中', () => {
    for (const category of CATEGORIES) {
      expect(parseSettingsHash(`#/settings/${category}`)).toEqual({ category, section: null });
    }
  });

  it('區塊 id 落到所在分類並記下要捲到哪', () => {
    expect(parseSettingsHash('#/settings/archived')).toEqual({
      category: 'data',
      section: 'archived',
    });
    expect(parseSettingsHash('#/settings/push')).toEqual({ category: 'account', section: 'push' });
    expect(parseSettingsHash('#/settings/stuck')).toEqual({
      category: 'sessions',
      section: 'stuck',
    });
    expect(parseSettingsHash('#/settings/users')).toEqual({
      category: 'machines',
      section: 'users',
    });
  });

  it('不認得的回到預設分類', () => {
    expect(parseSettingsHash('#/settings/nope')).toEqual({ category: 'account', section: null });
    expect(parseSettingsHash('#/canvas')).toEqual({ category: 'account', section: null });
    expect(parseSettingsHash('#/settings/toString')).toEqual({
      category: 'account',
      section: null,
    });
  });

  it('壞掉的百分比編碼不丟例外，回到預設分類', () => {
    expect(parseSettingsHash('#/settings/%E0')).toEqual({ category: 'account', section: null });
    expect(parseSettingsHash('#/settings/%')).toEqual({ category: 'account', section: null });
    expect(parseSettingsHash('#/settings/secur%69ty')).toEqual({
      category: 'security',
      section: null,
    });
  });
});

describe('visibleCategories', () => {
  it('owner 與讀不到身分時全部顯示', () => {
    expect(visibleCategories('owner')).toEqual([...CATEGORIES]);
    expect(visibleCategories('unknown')).toEqual([...CATEGORIES]);
  });

  it('成員與還在讀身分時看不到通知、安全', () => {
    const shared = ['account', 'sessions', 'machines', 'data'];
    expect(visibleCategories('member')).toEqual(shared);
    expect(visibleCategories('loading')).toEqual(shared);
  });
});

describe('settingsAccess', () => {
  it('依讀取狀態判斷', () => {
    const user = (role: 'owner' | 'member') => ({ role });
    expect(settingsAccess({ data: null, loading: true, error: null })).toBe('loading');
    expect(settingsAccess({ data: user('owner'), loading: false, error: null })).toBe('owner');
    expect(settingsAccess({ data: user('member'), loading: false, error: null })).toBe('member');
    expect(settingsAccess({ data: null, loading: false, error: 'down' })).toBe('unknown');
    expect(settingsAccess({ data: null, loading: false, error: null })).toBe('unknown');
  });
});

it('每個伺服器設定欄位與區塊都對到存在的分類', () => {
  for (const category of [...Object.values(KEY_CATEGORY), ...Object.values(SECTION_CATEGORY)]) {
    expect(CATEGORIES).toContain(category);
  }
});
