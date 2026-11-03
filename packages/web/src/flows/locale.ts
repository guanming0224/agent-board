// 語言偏好。shared/i18n 只偵測瀏覽器語系；這裡決定用哪一個：
// - 登入前：這個瀏覽器上次選的（localStorage），沒有就跟瀏覽器。登入頁、首次引導的選擇器只改這裡。
// - 登入後：一律用帳號的語言（User.locale），並記在這個瀏覽器，下次登入前的畫面也一樣。
// - 登入後換語言（頁首、設定頁）：畫面、這個瀏覽器、帳號三者一起改。
import type { User } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
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

/**
 * 登入成功、或開頁時確認已登入後呼叫：畫面改用帳號的語言。
 * 這個瀏覽器原本的選擇（含「跟隨瀏覽器」）若已經是同一個語言就不動，否則記成帳號的語言。
 */
export function applyAccountLocale(user: Pick<User, 'locale'> | null | undefined): void {
  if (!user) return;
  const choice = savedLocaleChoice();
  const resolved = choice === 'auto' ? detectLocale() : choice;
  if (resolved === user.locale) useLocale.getState().setLocale(user.locale);
  else applyLocaleChoice(user.locale);
}

/**
 * 登入後換語言：畫面與這個瀏覽器立刻生效，再存到帳號。
 * 「跟隨瀏覽器」時帳號記成這個瀏覽器的語言（帳號只有 zh-TW、en）。
 * 存帳號失敗不擋畫面，回傳錯誤讓呼叫端決定要不要說。
 */
export async function chooseLocale(
  backend: Pick<BoardBackend, 'saveLocale'>,
  choice: LocaleChoice,
): Promise<void> {
  applyLocaleChoice(choice);
  await backend.saveLocale(choice === 'auto' ? detectLocale() : choice);
}
