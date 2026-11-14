import { describe, expect, it } from 'vitest';
import { TERMINAL_ZOOM, TERMINAL_ZOOM_OUT, nextZoomedIn, zoomGate } from './terminalZoom';

describe('縮放門檻的緩衝區間', () => {
  it('往上到 90% 才切終端機，往下低於 80% 才切回摘要條', () => {
    expect(TERMINAL_ZOOM).toBe(0.9);
    expect(TERMINAL_ZOOM_OUT).toBe(0.8);
    expect(nextZoomedIn(false, 0.89)).toBe(false);
    expect(nextZoomedIn(false, 0.9)).toBe(true);
    expect(nextZoomedIn(true, 0.85)).toBe(true);
    expect(nextZoomedIn(true, 0.8)).toBe(true);
    expect(nextZoomedIn(true, 0.79)).toBe(false);
    expect(nextZoomedIn(false, 0.85)).toBe(false);
  });

  it('每個畫布各自一份狀態，同一個倍率重算結果一樣', () => {
    const a = {};
    const b = {};
    expect(zoomGate(a, 1)).toBe(true);
    expect(zoomGate(a, 0.85)).toBe(true);
    expect(zoomGate(a, 0.85)).toBe(true);
    // 新畫布一開就在緩衝區間：當摘要條。
    expect(zoomGate(b, 0.85)).toBe(false);
    expect(zoomGate(a, 0.7)).toBe(false);
    expect(zoomGate(a, 0.85)).toBe(false);
  });
});
