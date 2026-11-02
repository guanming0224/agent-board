import type { Layout, Session } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';

export const WORKSPACE = 'default';

/**
 * 卡片外框。摘要條與 xterm 共用同一個外框（STYLE.md 邏輯 4），大小要讓 xterm 有約 80 欄，
 * 否則 fit 會把真 PTY 擠窄。摘要條邏輯寬度維持 320（STYLE.md §5），以 w / 320 等比放大填滿外框，
 * 所以畫布在 47% 左右時，摘要條在螢幕上就是規格的 320px。
 */
export const CARD_W = 680;
export const CARD_H = 640;
export const STRIP_W = 320;
/** 左右留得下交接線的小字，上下留得下團隊框。 */
const GAP_X = 140;
const GAP_Y = 72;
const COLUMNS = 3;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 放大到一張卡剛好看得完整的倍率。 */
export function fitCardZoom(rect: Rect, viewportW: number, viewportH: number): number {
  return Math.min(viewportW / (rect.w + 40), viewportH / (rect.h + 40));
}

const overlaps = (a: Rect, b: Rect) =>
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

function readCache(): Layout[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
    return Array.isArray(parsed) ? (parsed as Layout[]) : [];
  } catch {
    return [];
  }
}

export async function loadLayouts(backend: BoardBackend): Promise<Layout[]> {
  const remote = await backend.getLayouts(WORKSPACE);
  return remote.length > 0 ? remote : readCache();
}

export function saveLayouts(backend: BoardBackend, layouts: Layout[]): Promise<void> {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(layouts));
  } catch {
    // 瀏覽器不給存就只靠後端。
  }
  return backend.saveLayouts(layouts);
}
