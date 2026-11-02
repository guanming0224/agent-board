// 語言偏好存在瀏覽器：shared/i18n 只偵測瀏覽器語系，不記得使用者的選擇。
import { detectLocale, useLocale, type Locale } from '../shared/i18n';

const KEY = 'agent-board.locale';

export type LocaleChoice = Locale | 'auto';

export function savedLocaleChoice(): LocaleChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'zh-TW' || value === 'en' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyLocaleChoice(choice: LocaleChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // 無痕模式等情況存不了，這次仍然生效。
  }
  useLocale.getState().setLocale(choice === 'auto' ? detectLocale() : choice);
}

export function restoreLocale(): void {
  const choice = savedLocaleChoice();
  if (choice !== 'auto') useLocale.getState().setLocale(choice);
}
