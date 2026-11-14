// 縮放門檻的緩衝區間：往上到 TERMINAL_ZOOM 才切成終端機，往下低於 TERMINAL_ZOOM_OUT 才切回摘要條。
// 在門檻附近來回縮放（滾輪、觸控板）不會一直切換、整批建立又卸載 xterm。

/** 往上放大到這個倍率，卡片切成終端機。 */
export const TERMINAL_ZOOM = 0.9;
/** 往下縮小到低於這個倍率，才切回摘要條。 */
export const TERMINAL_ZOOM_OUT = 0.8;

export function nextZoomedIn(previous: boolean, zoom: number): boolean {
  if (zoom >= TERMINAL_ZOOM) return true;
  if (zoom < TERMINAL_ZOOM_OUT) return false;
  return previous;
}

/** 每個畫布（React Flow 的 store）一份狀態，所有卡片讀同一個結果。 */
const gates = new WeakMap<object, boolean>();

/** 給 useStore 的 selector 用：同一個 zoom 重算幾次結果都一樣。 */
export function zoomGate(canvas: object, zoom: number): boolean {
  const next = nextZoomedIn(gates.get(canvas) ?? false, zoom);
  gates.set(canvas, next);
  return next;
}
