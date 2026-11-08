// 搜尋的範圍、時間、含封存：每台裝置自己記（§3.3）。預設全部工作區、7 天、不含封存（D8）。
import {
  SEARCH_DEFAULTS,
  SearchScope,
  SearchSince,
  type SearchScope as Scope,
  type SearchSince as Since,
} from '@agent-board/protocol';
import { create } from 'zustand';

const KEY = 'agent-board.search.prefs';

export interface SearchPrefs {
  scope: Scope;
  since: Since;
  archived: boolean;
}

export function readPrefs(raw: string | null): SearchPrefs {
  try {
    const saved = raw ? (JSON.parse(raw) as Partial<Record<keyof SearchPrefs, unknown>>) : {};
    const scope = SearchScope.safeParse(saved.scope);
    const since = SearchSince.safeParse(saved.since);
    return {
      scope: scope.success ? scope.data : SEARCH_DEFAULTS.scope,
      since: since.success ? since.data : SEARCH_DEFAULTS.since,
      archived: typeof saved.archived === 'boolean' ? saved.archived : SEARCH_DEFAULTS.archived,
    };
  } catch {
    return { ...SEARCH_DEFAULTS };
  }
}

function load(): SearchPrefs {
  try {
    return readPrefs(localStorage.getItem(KEY));
  } catch {
    return { ...SEARCH_DEFAULTS };
  }
}

export const useSearchPrefs = create<SearchPrefs & { set(patch: Partial<SearchPrefs>): void }>(
  (set, get) => ({
    ...load(),
    set(patch) {
      set(patch);
      const { scope, since, archived } = get();
      try {
        localStorage.setItem(KEY, JSON.stringify({ scope, since, archived }));
      } catch {
        // 存不了就只在這次有效。
      }
    },
  }),
);

/** 事件目標當成元素看（不用 instanceof HTMLElement：單元測試沒有 DOM）。 */
type ElementLike = { closest(selector: string): unknown; isContentEditable?: boolean };
const asElement = (target: EventTarget | null): ElementLike | null =>
  target !== null && typeof (target as Partial<ElementLike>).closest === 'function'
    ? (target as unknown as ElementLike)
    : null;

/** 打字中（輸入框、終端機）：`/` 交給它。 */
export function isTyping(target: EventTarget | null): boolean {
  const el = asElement(target);
  return (
    el !== null &&
    (el.isContentEditable === true ||
      el.closest('input, textarea, select, .xterm, [role="textbox"]') !== null)
  );
}

/**
 * 這個按鍵要不要打開搜尋（§3.3）：⌘K／Ctrl+K 隨時可以，`/` 只在焦點不在輸入框時；
 * 焦點在終端機（xterm）時一律交給終端機（同 P2 Esc 規則，驗收 14）。
 */
export function isSearchShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  target: EventTarget | null;
}): boolean {
  if (e.isComposing || e.altKey) return false;
  const inTerminal = asElement(e.target)?.closest('.xterm') != null;
  if (inTerminal) return false;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') return true;
  return e.key === '/' && !e.metaKey && !e.ctrlKey && !isTyping(e.target);
}
