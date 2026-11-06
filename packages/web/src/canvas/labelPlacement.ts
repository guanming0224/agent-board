// 線上標籤（次數徽章、交接條件）擺在哪裡：沿著線找一個不壓到卡片、也不壓到其他標籤的點。
// 純函式，不碰 React，方便單元測試。線的形狀和 xyflow 的 getBezierPath（右 → 左）相同。
import type { Rect } from './layout';

export interface Pt {
  x: number;
  y: number;
}

/** xyflow 的 calculateControlOffset（curvature 0.25）。 */
const controlOffset = (distance: number) =>
  distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance);

/** 從來源右緣到目標左緣的三次貝茲曲線：路徑字串與第 t（0–1）點。 */
export function edgeCurve(s: Pt, e: Pt): { d: string; at: (t: number) => Pt } {
  const k = controlOffset(e.x - s.x);
  const c1 = { x: s.x + k, y: s.y };
  const c2 = { x: e.x - k, y: e.y };
  const at = (t: number): Pt => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * s.x + b * c1.x + c * c2.x + d * e.x,
      y: a * s.y + b * c1.y + c * c2.y + d * e.y,
    };
  };
  return { d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${e.x},${e.y}`, at };
}

/** 標籤字的大概寬度（螢幕 px，11px 字）：中日韓字一格 11、其他 6.5，加左右留白。 */
export function textWidth(text: string): number {
  let w = 12;
  for (const ch of text) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 11 : 6.5;
  return Math.ceil(w);
}

export interface LabelRequest {
  id: string;
  source: Pt;
  target: Pt;
  /** 標籤框的大小（畫布座標）。 */
  w: number;
  h: number;
}

/** 沿著線的第 t 點，再偏移 dx、dy（畫布座標）。 */
export interface LabelSpot {
  t: number;
  dx: number;
  dy: number;
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 從中點往兩端找：0.5、0.45、0.55、0.4… */
const CANDIDATES = Array.from({ length: 19 }, (_, i) => (i + 1) / 20).sort(
  (a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5) || a - b,
);
const MAX_STACK = 6;

/**
 * 依序替每個標籤找位置：
 * 1. 線上離中點最近、不壓到任何卡片（含 pad 邊距）也不壓到已放好的標籤的點；
 * 2. 只找得到不壓卡片、但會壓到別的標籤的點：在那裡往下疊（每次一個標籤高）；
 * 3. 整條線都在卡片上（兩張卡貼在一起）：放在來源卡右緣外面。
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  cards: readonly Rect[],
  pad: number,
): Map<string, LabelSpot> {
  const padded = cards.map((r) => ({
    x: r.x - pad,
    y: r.y - pad,
    w: r.w + 2 * pad,
    h: r.h + 2 * pad,
  }));
  const placed: Rect[] = [];
  const out = new Map<string, LabelSpot>();
  const boxAt = (p: Pt, w: number, h: number): Rect => ({ x: p.x - w / 2, y: p.y - h / 2, w, h });
  const free = (box: Rect, others: readonly Rect[]) => !others.some((o) => overlaps(box, o));

  for (const req of requests) {
    const curve = edgeCurve(req.source, req.target);
    let spot: LabelSpot | null = null;
    let fallback: number | null = null;
    for (const t of CANDIDATES) {
      const box = boxAt(curve.at(t), req.w, req.h);
      if (!free(box, padded)) continue;
      if (free(box, placed)) {
        spot = { t, dx: 0, dy: 0 };
        break;
      }
      fallback ??= t;
    }
    if (!spot && fallback !== null) {
      const p = curve.at(fallback);
      for (let i = 1; i <= MAX_STACK && !spot; i += 1) {
        const dy = i * (req.h + 2);
        const box = boxAt({ x: p.x, y: p.y + dy }, req.w, req.h);
        if (free(box, padded) && free(box, placed)) spot = { t: fallback, dx: 0, dy };
      }
      spot ??= { t: fallback, dx: 0, dy: 0 };
    }
    spot ??= { t: 0, dx: req.w / 2 + pad, dy: 0 };
    const p = curve.at(spot.t);
    placed.push(boxAt({ x: p.x + spot.dx, y: p.y + spot.dy }, req.w, req.h));
    out.set(req.id, spot);
  }
  return out;
}
