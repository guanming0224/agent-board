// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocale } from '../shared/i18n';
import { applyAccountLocale, applyLocaleChoice, chooseLocale, savedLocaleChoice } from './locale';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  // 這個瀏覽器是中文。
  vi.stubGlobal('navigator', { languages: ['zh-TW', 'en-US'] });
  applyLocaleChoice('auto');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyAccountLocale', () => {
  it('登入後用帳號的語言，並記在這個瀏覽器（下次登入前也一樣）', () => {
    expect(useLocale.getState().locale).toBe('zh-TW');
    applyAccountLocale({ locale: 'en' });
    expect(useLocale.getState().locale).toBe('en');
    expect(savedLocaleChoice()).toBe('en');
  });

  it('瀏覽器原本的選擇已經是同一個語言時不動它，「跟隨瀏覽器」照樣保留', () => {
    applyAccountLocale({ locale: 'zh-TW' });
    expect(useLocale.getState().locale).toBe('zh-TW');
    expect(savedLocaleChoice()).toBe('auto');
  });

  it('登入前選的語言和帳號不同時，以帳號為準', () => {
    applyLocaleChoice('en');
    applyAccountLocale({ locale: 'zh-TW' });
    expect(useLocale.getState().locale).toBe('zh-TW');
    expect(savedLocaleChoice()).toBe('zh-TW');
  });

  it('沒有使用者就不動', () => {
    applyLocaleChoice('en');
    applyAccountLocale(null);
    expect(useLocale.getState().locale).toBe('en');
  });
});

describe('chooseLocale', () => {
  it('畫面、瀏覽器、帳號一起改', async () => {
    const saveLocale = vi.fn(async () => undefined);
    await chooseLocale({ saveLocale }, 'en');
    expect(useLocale.getState().locale).toBe('en');
    expect(savedLocaleChoice()).toBe('en');
    expect(saveLocale).toHaveBeenCalledWith('en');
  });

  it('「跟隨瀏覽器」把帳號記成瀏覽器的語言', async () => {
    const saveLocale = vi.fn(async () => undefined);
    applyLocaleChoice('en');
    await chooseLocale({ saveLocale }, 'auto');
    expect(useLocale.getState().locale).toBe('zh-TW');
    expect(savedLocaleChoice()).toBe('auto');
    expect(saveLocale).toHaveBeenCalledWith('zh-TW');
  });

  it('存帳號失敗時畫面仍然換了，錯誤交給呼叫端', async () => {
    const saveLocale = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(chooseLocale({ saveLocale }, 'en')).rejects.toThrow('offline');
    expect(useLocale.getState().locale).toBe('en');
  });
});
