import { CANVAS_LAYOUT_SET, type Layout, type Session } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';

export const WORKSPACE = CANVAS_LAYOUT_SET;
/** 「上一次擺設」：每次一鍵整理前的全部位置，存在 hub 的另一個 workspace，重新載入、換裝置都還在。 */
export const PREVIOUS_WORKSPACE = `${WORKSPACE}.previous`;

/**
 * 卡片外框。摘要條與 xterm 共用同一個外框（STYLE.md 邏輯 4），大小要讓 xterm 有約 80 欄，
 * 否則 fit 會把真 PTY 擠窄。摘要條邏輯寬度維持 320（STYLE.md §5），以 w / 320 等比放大填滿外框，
 * 所以畫布在 47% 左右時，摘要條在螢幕上就是規格的 320px。
 */
export const CARD_W = 680;
export const CARD_H = 640;
export const STRIP_W = 320;
/** 左右留得下交接線的小字，上下留得下團隊框。 */
export const GAP_X = 140;
export const GAP_Y = 72;
const COLUMNS = 3;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 低於這個縮放，卡片上的按鈕、輸入框、⋯ 都藏起來，只留標題列（GM 2026-11-09 Q4，canvas.css 的 [data-compact]）。
 * 「點兩下處理」、「下一個等我的」、團隊面板移鏡頭時，縮放至少夾到這裡，放大後按鈕才看得到。
 */
export const COMPACT_ZOOM = 0.3;

/** 縮放顯示（%）：和 COMPACT_ZOOM 的隱藏門檻對齊，0.295 不會顯示成「30%」卻已經藏起按鈕。 */
export function zoomPercent(zoom: number): number {
  const pct = Math.round(zoom * 100);
  const edge = Math.round(COMPACT_ZOOM * 100);
  return zoom < COMPACT_ZOOM ? Math.min(edge - 1, pct) : Math.max(edge, pct);
}

/** 放大到一張卡剛好看得完整的倍率。 */
export function fitCardZoom(rect: Rect, viewportW: number, viewportH: number): number {
  return Math.min(viewportW / (rect.w + 40), viewportH / (rect.h + 40));
}

export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 新卡放進第一個沒被占用的格子。 */
export function nextFreeSlot(occupied: readonly Rect[]): Rect {
  for (let i = 0; ; i += 1) {
    const slot = {
      x: (i % COLUMNS) * (CARD_W + GAP_X),
      y: Math.floor(i / COLUMNS) * (CARD_H + GAP_Y),
      w: CARD_W,
      h: CARD_H,
    };
    if (!occupied.some((r) => overlaps(slot, r))) return slot;
  }
}

/** 留下還在的卡，新的 session 先看存檔，沒有才找空位。 */
export function reconcileRects(
  sessions: readonly Session[],
  current: ReadonlyMap<string, Rect>,
  saved: readonly Layout[],
): Map<string, Rect> {
  const next = new Map<string, Rect>();
  const missing: Session[] = [];
  for (const s of sessions) {
    const known = current.get(s.id) ?? saved.find((l) => l.sessionId === s.id);
    if (known) next.set(s.id, { x: known.x, y: known.y, w: known.w, h: known.h });
    else missing.push(s);
  }
  for (const s of missing) next.set(s.id, nextFreeSlot([...next.values()]));
  return next;
}

// fakeBackend 的版面只放在記憶體，重新載入就沒了。後端回空時才退回瀏覽器裡的副本，
// 真 hub 有資料時這份副本不會被讀到。
const cacheKey = `agent-board.layouts.${WORKSPACE}`;

// 副本裡兩個 workspace 都有，讀的時候分開。
function readCache(workspace: string): Layout[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
    return Array.isArray(parsed)
      ? (parsed as Layout[]).filter((l) => (l.workspace ?? WORKSPACE) === workspace)
      : [];
  } catch {
    return [];
  }
}

/**
 * 讀一個 workspace 的版面。fakeBackend 不分 workspace，一律回全部，所以這裡再篩一次；
 * 真 hub 本來就只回那個 workspace。
 */
async function loadWorkspace(backend: BoardBackend, workspace: string): Promise<Layout[]> {
  const remote = (await backend.getLayouts(workspace)).filter((l) => l.workspace === workspace);
  return remote.length > 0 ? remote : readCache(workspace);
}

export const loadLayouts = (backend: BoardBackend) => loadWorkspace(backend, WORKSPACE);
export const loadPreviousLayouts = (backend: BoardBackend) =>
  loadWorkspace(backend, PREVIOUS_WORKSPACE);

/**
 * 畫布要存的全部列：目前位置，加上有快照時的「上一次擺設」。兩個一起送：hub 的 PUT 對 body 裡出現的
 * 每個 workspace 整批取代、在同一個交易裡；fakeBackend 整份取代，一起送才不會把快照洗掉。
 */
export function layoutRows(
  rects: Iterable<[string, Rect]>,
  previous: Iterable<[string, Rect]> | null,
): Layout[] {
  const rows = (workspace: string, from: Iterable<[string, Rect]>) =>
    [...from].map(([sessionId, r]) => ({ workspace, sessionId, x: r.x, y: r.y, w: r.w, h: r.h }));
  return [...rows(WORKSPACE, rects), ...(previous ? rows(PREVIOUS_WORKSPACE, previous) : [])];
}

export function saveLayouts(backend: BoardBackend, layouts: Layout[]): Promise<void> {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(layouts));
  } catch {
    // 瀏覽器不給存就只靠後端。
  }
  return backend.saveLayouts(layouts);
}
