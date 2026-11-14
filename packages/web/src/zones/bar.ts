// 分頁群組頂部列（§25）的純函式：收合狀態的讀寫、往左／往右移、捲動到目前分頁、滾輪轉橫向。
// 不碰 React 與 store，單元測試直接用（bar.test.ts）。
import type { Zone, ZoneBarItem, ZoneBarMove } from '@agent-board/protocol';

/** localStorage 的最小介面（測試換成記憶體或會丟錯的假物件）。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const COLLAPSED_KEY = 'agent-board.zone.collapsed';

/** 收合中的群組（每台裝置各自記）。讀不到、壞掉、不是物件＝全部展開。 */
export function readCollapsed(storage: KeyValueStorage | null | undefined): Record<string, true> {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(value)) if (v === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

/** 改一個群組的收合狀態；存不了（無痕、滿了）就只在這次有效。 */
export function writeCollapsed(
  storage: KeyValueStorage | null | undefined,
  current: Record<string, true>,
  groupId: string,
  collapsed: boolean,
): Record<string, true> {
  const next = { ...current };
  if (collapsed) next[groupId] = true;
  else delete next[groupId];
  try {
    storage?.setItem(COLLAPSED_KEY, JSON.stringify(next));
  } catch {
    // 只在這次有效。
  }
  return next;
}

/** 群組現在要不要展開：沒收合，或拖著東西經過時暫時打開（peek）。 */
export function groupOpen(
  groupId: string,
  collapsed: Readonly<Record<string, true>>,
  peek: string | null,
): boolean {
  return !collapsed[groupId] || peek === groupId;
}

/** 一格在哪一排（頂部列或某個群組）以及同一排的 id 順序。 */
function siblingsOf(
  items: readonly ZoneBarItem<Zone>[],
  target: { kind: 'zone' | 'group'; id: string },
): { groupId: string | null; ids: string[] } | null {
  const top = items.map((i) => (i.kind === 'zone' ? i.zone.id : i.group.id));
  if (target.kind === 'group') return top.includes(target.id) ? { groupId: null, ids: top } : null;
  if (top.includes(target.id)) return { groupId: null, ids: top };
  for (const i of items) {
    if (i.kind === 'group' && i.zones.some((z) => z.id === target.id)) {
      return { groupId: i.group.id, ids: i.zones.map((z) => z.id) };
    }
  }
  return null;
}

/**
 * 「往左移」「往右移」（拖曳的鍵盤／觸控替代）：在同一排裡和旁邊那格換位置。已經在最邊邊回 null（選單項目停用）。
 */
export function stepMove(
  items: readonly ZoneBarItem<Zone>[],
  target: { kind: 'zone' | 'group'; id: string },
  dir: -1 | 1,
): ZoneBarMove | null {
  const row = siblingsOf(items, target);
  if (!row) return null;
  const at = row.ids.indexOf(target.id);
  const to = at + dir;
  if (to < 0 || to >= row.ids.length) return null;
  // 往左：放在左邊那格前面；往右：放在右邊那格的下一格前面（沒有＝最後）。
  const before = dir < 0 ? row.ids[to]! : (row.ids[to + 1] ?? null);
  return target.kind === 'group'
    ? { kind: 'group', id: target.id, before }
    : { kind: 'zone', id: target.id, groupId: row.groupId, before };
}

/**
 * 目前分頁自動捲進可見範圍：分頁（相對捲動內容的左緣與寬度）不在 [scrollLeft, scrollLeft + clientWidth] 裡就回新的 scrollLeft，
 * 兩側留 margin，免得剛好貼邊看不出旁邊還有。已經看得到回 null（不動）。
 */
export function revealScroll(
  view: { scrollLeft: number; clientWidth: number },
  item: { left: number; width: number },
  margin = 24,
): number | null {
  const start = view.scrollLeft;
  const end = start + view.clientWidth;
  if (item.left >= start && item.left + item.width <= end) return null;
  if (item.left < start || item.width + margin * 2 > view.clientWidth) {
    return Math.max(0, item.left - margin);
  }
  return item.left + item.width + margin - view.clientWidth;
}

/**
 * 滑鼠滾輪轉成橫向捲動：只有放不下（可以橫向捲）、而且是直向為主的滾動（一般滑鼠滾輪）才轉；觸控板本來就有橫向 deltaX，不攔。
 * 回要捲的橫向量，不處理回 null（讓頁面照常）。
 */
export function wheelToHorizontal(
  delta: { deltaX: number; deltaY: number },
  scroll: { scrollWidth: number; clientWidth: number },
): number | null {
  if (scroll.scrollWidth <= scroll.clientWidth + 1) return null;
  if (Math.abs(delta.deltaY) <= Math.abs(delta.deltaX)) return null;
  return delta.deltaY;
}

/** 拖曳中的那一格（分頁或群組標籤）。 */
export interface BarTarget {
  kind: 'zone' | 'group';
  id: string;
}

/** 放在哪裡：某個分頁、某個群組標籤、或頂部列最後面的空白。 */
export type DropOver =
  { kind: 'zone'; id: string } | { kind: 'group'; id: string } | { kind: 'end' };

/**
 * 拖曳放下（桌面）：分頁放到分頁上＝放進那一排（群組或頂部列）、那個分頁的前面或後面（看指到左半還是右半）；
 * 分頁放到群組標籤上＝加進群組最後面；放到最後面的空白＝移出群組、排到最後。群組只在頂部列排序：放到群組裡的分頁上＝那個群組的前後。
 * 放回原地回 null。
 */
export function dropMove(
  items: readonly ZoneBarItem<Zone>[],
  drag: BarTarget,
  over: DropOver,
  side: 'before' | 'after',
): ZoneBarMove | null {
  const top = items.map((i) => (i.kind === 'zone' ? i.zone.id : i.group.id));
  const nextIn = (ids: readonly string[], id: string) => ids[ids.indexOf(id) + 1] ?? null;
  if (over.kind === 'end') {
    return drag.kind === 'group'
      ? { kind: 'group', id: drag.id, before: null }
      : { kind: 'zone', id: drag.id, groupId: null, before: null };
  }
  if (drag.kind === 'zone') {
    if (over.kind === 'group') return { kind: 'zone', id: drag.id, groupId: over.id, before: null };
    if (over.id === drag.id) return null;
    const row = siblingsOf(items, over);
    if (!row) return null;
    const rest = row.ids.filter((x) => x !== drag.id);
    const before = side === 'before' ? over.id : nextIn(rest, over.id);
    return { kind: 'zone', id: drag.id, groupId: row.groupId, before };
  }
  let anchor = over.id;
  if (over.kind === 'zone') {
    const row = siblingsOf(items, over);
    if (!row) return null;
    if (row.groupId) anchor = row.groupId;
  }
  if (anchor === drag.id) return null;
  const rest = top.filter((x) => x !== drag.id);
  const before = side === 'before' ? anchor : nextIn(rest, anchor);
  return { kind: 'group', id: drag.id, before };
}
