import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  KEY_CATEGORY,
  parseSettingsHash,
  SECTION_CATEGORY,
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
  });
});

describe('visibleCategories', () => {
  it('owner 與還不知道身分時全部顯示', () => {
    expect(visibleCategories('owner')).toEqual([...CATEGORIES]);
    expect(visibleCategories(undefined)).toEqual([...CATEGORIES]);
  });

  it('成員看不到通知、安全、機器與使用者', () => {
    expect(visibleCategories('member')).toEqual(['account', 'sessions', 'data']);
  });
});

it('每個伺服器設定欄位與區塊都對到存在的分類', () => {
  for (const category of [...Object.values(KEY_CATEGORY), ...Object.values(SECTION_CATEGORY)]) {
    expect(CATEGORIES).toContain(category);
  }
});
