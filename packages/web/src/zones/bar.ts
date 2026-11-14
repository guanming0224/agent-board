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

/**
 * 群組現在要不要展開：沒收合，或拖著東西經過時暫時打開（peek）。暫時打開的在拖曳結束前都不收，
 * 拖著經過好幾個收合的群組時不會來回跳。
 */
export function groupOpen(
  groupId: string,
  collapsed: Readonly<Record<string, true>>,
  peek: readonly string[],
): boolean {
  return !collapsed[groupId] || peek.includes(groupId);
}

/** 收合記錄只留現有群組（別台刪掉的群組、舊資料不留）。 */
export function pruneCollapsed(
  collapsed: Readonly<Record<string, true>>,
  groupIds: readonly string[],
): Record<string, true> {
  const known = new Set(groupIds);
  const out: Record<string, true> = {};
  for (const id of Object.keys(collapsed)) if (known.has(id)) out[id] = true;
  return out;
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

/** WheelEvent.deltaMode：0＝像素、1＝行（Firefox 的滑鼠滾輪）、2＝頁。 */
export const WHEEL_LINE_PX = 16;

/**
 * 滑鼠滾輪轉成橫向捲動：只有放不下（可以橫向捲）、而且是直向為主的滾動（一般滑鼠滾輪）才轉；觸控板本來就有橫向 deltaX，不攔。
 * 依 deltaMode 換成像素（行＝16px、頁＝可見寬度），不然 Firefox 一格只捲 3px。回要捲的橫向量，不處理回 null（讓頁面照常）。
 */
export function wheelToHorizontal(
  delta: { deltaX: number; deltaY: number; deltaMode?: number },
  scroll: { scrollWidth: number; clientWidth: number },
): number | null {
  if (scroll.scrollWidth <= scroll.clientWidth + 1) return null;
  if (Math.abs(delta.deltaY) <= Math.abs(delta.deltaX)) return null;
  const unit =
    delta.deltaMode === 1 ? WHEEL_LINE_PX : delta.deltaMode === 2 ? scroll.clientWidth : 1;
  return delta.deltaY * unit;
}

/** 選單離視窗邊緣至少這麼多。 */
export const MENU_MARGIN = 8;

/**
 * 浮層選單放哪裡：預設在分頁下面、左緣對齊；右邊放不下往左推。下面放不下整個選單、上面空間比較大就往上翻。
 * 高度上限＝選的那一邊的可用高度（選單自己捲動），一定夾在視窗內。
 */
export function placeMenu(
  anchor: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const m = MENU_MARGIN;
  const left = Math.max(m, Math.min(anchor.left, viewport.width - menu.width - m));
  const below = viewport.height - anchor.bottom - 2 - m;
  const above = anchor.top - 2 - m;
  if (menu.height <= below || below >= above) {
    const maxHeight = Math.max(below, 0);
    return { left, top: anchor.bottom + 2, maxHeight };
  }
  const maxHeight = Math.max(above, 0);
  const height = Math.min(menu.height, maxHeight);
  return { left, top: Math.max(m, anchor.top - 2 - height), maxHeight };
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
