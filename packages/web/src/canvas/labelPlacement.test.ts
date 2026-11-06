import { describe, expect, it } from 'vitest';
import type { Rect } from './layout';
import { edgeCurve, placeLabels, textWidth, type LabelRequest } from './labelPlacement';

const inside = (p: { x: number; y: number }, w: number, h: number, r: Rect) =>
  p.x + w / 2 > r.x && p.x - w / 2 < r.x + r.w && p.y + h / 2 > r.y && p.y - h / 2 < r.y + r.h;

const centerOf = (req: LabelRequest, spot: { t: number; dx: number; dy: number }) => {
  const p = edgeCurve(req.source, req.target).at(spot.t);
  return { x: p.x + spot.dx, y: p.y + spot.dy };
};

describe('線的形狀', () => {
  it('兩端與 xyflow 相同：t=0 是來源、t=1 是目標，中點在兩者中間', () => {
    const curve = edgeCurve({ x: 0, y: 0 }, { x: 100, y: 50 });
    expect(curve.at(0)).toEqual({ x: 0, y: 0 });
    expect(curve.at(1)).toEqual({ x: 100, y: 50 });
    expect(curve.at(0.5)).toEqual({ x: 50, y: 25 });
    expect(curve.d).toBe('M0,0 C50,0 50,50 100,50');
  });
});

describe('標籤寬度估計', () => {
  it('中文一格 11、英數 6.5，加 12 留白', () => {
    expect(textWidth('完成時交接')).toBe(67);
    expect(textWidth('On done')).toBe(Math.ceil(12 + 7 * 6.5));
  });
});

describe('標籤擺放', () => {
  // 兩張卡左右排，中間留 100 的空隙；另一張卡在下方。
  const a: Rect = { x: 0, y: 0, w: 300, h: 400 };
  const b: Rect = { x: 400, y: 0, w: 300, h: 400 };
  const c: Rect = { x: 0, y: 500, w: 300, h: 400 };
  const req = (id: string, source: Rect, target: Rect, w = 20, h = 16): LabelRequest => ({
    id,
    source: { x: source.x + source.w, y: source.y + 28 },
    target: { x: target.x, y: target.y + 28 },
    w,
    h,
  });

  it('中點在空隙裡：放中點', () => {
    const spots = placeLabels([req('ab', a, b)], [a, b, c], 6);
    expect(spots.get('ab')).toEqual({ t: 0.5, dx: 0, dy: 0 });
  });

  it('中點壓在卡片上：沿著線移到卡片之間的空隙', () => {
    // 來源與目標中間隔著一張卡，線（水平）的中點落在那張卡上。
    const from: Rect = { x: 0, y: 0, w: 300, h: 400 };
    const to: Rect = { x: 800, y: 0, w: 300, h: 400 };
    const middle: Rect = { x: 380, y: -100, w: 200, h: 300 };
    const r = req('ft', from, to);
    const spot = placeLabels([r], [from, to, middle], 6).get('ft')!;
    // 離中點最近、出了中間那張卡的點（線上的點不是等速分布，所以不寫死 t）。
    expect(spot.t).toBeGreaterThan(0.5);
    expect(spot).toMatchObject({ dx: 0, dy: 0 });
    const p = centerOf(r, spot);
    for (const card of [from, to, middle]) expect(inside(p, r.w, r.h, card)).toBe(false);
  });

  it('整條線都在卡片上：放在來源卡右緣外面', () => {
    const from: Rect = { x: 0, y: 0, w: 300, h: 400 };
    const cover: Rect = { x: -1000, y: -1000, w: 3000, h: 3000 };
    const r = req('x', from, b);
    expect(placeLabels([r], [from, cover], 6).get('x')).toEqual({ t: 0, dx: 16, dy: 0 });
  });

  it('兩個標籤會疊在一起：第二個沿著線換位置或往下疊，不重疊', () => {
    const r1 = req('ab', a, b, 60, 16);
    const r2 = { ...req('ab2', a, b, 60, 16), id: 'ab2' };
    const spots = placeLabels([r1, r2], [a, b], 6);
    const p1 = centerOf(r1, spots.get('ab')!);
    const p2 = centerOf(r2, spots.get('ab2')!);
    const apart = Math.abs(p1.x - p2.x) >= 60 || Math.abs(p1.y - p2.y) >= 16;
    expect(apart).toBe(true);
    for (const card of [a, b]) expect(inside(p2, 60, 16, card)).toBe(false);
  });

  it('沒有卡片時照順序放，結果是確定的', () => {
    const r = req('ab', a, b);
    expect(placeLabels([r], [], 0)).toEqual(placeLabels([r], [], 0));
  });
});
