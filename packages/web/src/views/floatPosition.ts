// 浮動對話框（GM 2026-11-14）的位置規則：純函式，FloatingDialog 與單元測試共用。
// 位置是框左上角在視窗裡的座標（CSS px）。可放的範圍是頁首下緣到視窗底、左右到視窗邊，各留一點邊距。
import { PHONE_WIDTH } from '../shared/breakpoints';

export interface Pos {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 可放的範圍（視窗座標）。right／bottom 是右緣、下緣，不是 CSS 的 right／bottom。 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 框和視窗邊、頁首之間至少留這麼多。 */
export const FLOAT_MARGIN = 8;

/** 鍵盤移動（Alt＋方向鍵）一次走多少；加 Shift 走大步。 */
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 64;

/** localStorage 的鍵：每個浮動對話框各記各的位置。 */
export const storageKey = (id: string) => `agent-board.float.${id}`;

/** 手機（≤ 640px）維持全螢幕頁或原本的內嵌行為；比手機寬才浮動（平板用觸控也能拖）。 */
export function shouldFloat(viewportWidth: number): boolean {
  return viewportWidth > PHONE_WIDTH;
}

/**
 * 可放的範圍：頁首下緣（headerBottom）以下、視窗以內，扣掉邊距。
 * 頁首永遠不會被浮動框蓋到；右側面板則可能重疊（層級見 STYLE §5.2）。
 */
export function floatBounds(viewport: Size, headerBottom: number): Bounds {
  return {
    left: FLOAT_MARGIN,
    top: Math.max(0, headerBottom) + FLOAT_MARGIN,
    right: viewport.width - FLOAT_MARGIN,
    bottom: viewport.height - FLOAT_MARGIN,
  };
}

/** 夾進範圍：整個框都在範圍內；框比範圍大時對齊左上（標題列一定看得到、拖得到）。 */
export function clampPos(pos: Pos, size: Size, bounds: Bounds): Pos {
  const maxX = bounds.right - size.width;
  const maxY = bounds.bottom - size.height;
  return {
    x: Math.round(Math.max(bounds.left, Math.min(pos.x, maxX))),
    y: Math.round(Math.max(bounds.top, Math.min(pos.y, maxY))),
  };
}

/**
 * 預設位置：範圍正中間。avoidRight 是右側面板蓋住的寬度（uiStore 的 rightInset）：
 * 放得下時置中在面板左邊的畫布區，打開時不會一開就蓋在面板上。
 */
export function centerPos(size: Size, bounds: Bounds, avoidRight = 0): Pos {
  const right =
    avoidRight > 0 && bounds.right - avoidRight - bounds.left >= size.width
      ? bounds.right - avoidRight
      : bounds.right;
  return clampPos(
    {
      x: bounds.left + (right - bounds.left - size.width) / 2,
      y: bounds.top + (bounds.bottom - bounds.top - size.height) / 2,
    },
    size,
    bounds,
  );
}

/** 讀記住的位置。沒有、壞掉、或 localStorage 不能用（隱私模式、被擋）都回 null（＝置中）。 */
export function readPos(id: string, storage: Pick<Storage, 'getItem'> | null): Pos | null {
  try {
    const raw = storage?.getItem(storageKey(id));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      Number.isFinite((value as Pos).x) &&
      Number.isFinite((value as Pos).y)
    ) {
      return { x: (value as Pos).x, y: (value as Pos).y };
    }
    return null;
  } catch {
    return null;
  }
}

/** 記住位置；null 是「回到中間」（清掉記錄）。寫不進去就算了，這次照樣移動。 */
export function writePos(
  id: string,
  pos: Pos | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
): void {
  try {
    if (pos === null) storage?.removeItem(storageKey(id));
    else storage?.setItem(storageKey(id), JSON.stringify({ x: pos.x, y: pos.y }));
  } catch {
    // 隱私模式或空間滿了：不記，但不影響操作。
  }
}

/** 拿 localStorage；某些瀏覽器設定下光是讀這個屬性就會丟例外。 */
export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Alt＋方向鍵：回傳要移動的量；不是移動鍵回 null。 */
export function keyMove(key: string, big: boolean): Pos | null {
  const step = big ? KEY_STEP_BIG : KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 };
    case 'ArrowRight':
      return { x: step, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -step };
    case 'ArrowDown':
      return { x: 0, y: step };
    default:
      return null;
  }
}
