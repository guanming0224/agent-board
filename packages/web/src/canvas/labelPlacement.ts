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
  /** 線實際的走法（edgeRoute.ts）；沒給就是 source → target 的曲線。 */
  route?: { at: (t: number) => Pt };
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
/** 線上的點都壓到卡片時，在附近找空位：先試線的中段，再往兩端。 */
const NEAR_T = [0.5, 0.35, 0.65, 0.2, 0.8];
/** 附近的範圍：左右 ±2 個標籤寬、上下 ±14 個標籤高（線從卡片上緣附近出發，往下要跨過整張卡才到下一條空隙）。 */
const NEAR_X = 2;
const NEAR_Y = 14;

/**
 * 線附近的候選中心點，由近到遠（上下比左右近：卡片之間的直線通常是左右走，空位在上下兩列之間）。
 * 除了固定間隔的格點，再加上「剛好貼著某個障礙物上下左右邊」的位置：空隙只比標籤大一點時，格點容易跳過。
 */
function nearSpots(p: Pt, w: number, h: number, blocks: readonly Rect[]): Pt[] {
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (let i = -4 * NEAR_X; i <= 4 * NEAR_X; i += 1) xs.add(p.x + (i / 4) * w);
  for (let j = -2 * NEAR_Y; j <= 2 * NEAR_Y; j += 1) ys.add(p.y + (j / 2) * h);
  const e = 0.5;
  for (const r of blocks) {
    for (const x of [r.x - w / 2 - e, r.x + r.w + w / 2 + e]) {
      if (Math.abs(x - p.x) <= NEAR_X * w) xs.add(x);
    }
    for (const y of [r.y - h / 2 - e, r.y + r.h + h / 2 + e]) {
      if (Math.abs(y - p.y) <= NEAR_Y * h) ys.add(y);
    }
  }
  const out: { x: number; y: number; d: number }[] = [];
  for (const x of xs) {
    for (const y of ys) {
      if (x === p.x && y === p.y) continue;
      out.push({ x, y, d: Math.hypot((3 * (x - p.x)) / w, (y - p.y) / h) });
    }
  }
  // 一樣近時先往下（和第 2 步往下疊一致；畫面上方常有工具列蓋著）。
  return out.sort((a, b) => a.d - b.d || b.y - a.y || a.x - b.x);
}

/**
 * 依序替每個標籤找位置：
 * 1. 線上離中點最近、不壓到任何卡片（含 pad 邊距）也不壓到已放好的標籤的點；
 * 2. 只找得到不壓卡片、但會壓到別的標籤的點：在那裡往下疊（每次一個標籤高），疊不下就交給第 3 步；
 * 3. 線上的點都會壓到卡片（例如同一列相鄰兩張卡之間的短線，縮小時字比卡片之間的空隙寬）：
 *    在線的附近找最近的空位（通常是兩張卡上方或下方、列與列之間的空隙），字仍然貼著線。
 *    只找卡片之間（所有卡片的外圍範圍裡面）：跑到整片卡片外面，常被畫面上方、角落的工具列蓋住；
 * 4. 附近都沒有空位：有第 2 步的點就疊在那裡（壓到別的標籤、不壓卡），沒有就放在來源卡右緣外面
 *    （兩張卡貼在一起、或空隙都太窄；標籤畫在卡片上層，看得到）。
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
  // 所有卡片的外圍範圍：第 3 步只在這裡面找。
  const left = Math.min(...cards.map((r) => r.x));
  const top = Math.min(...cards.map((r) => r.y));
  const right = Math.max(...cards.map((r) => r.x + r.w));
  const bottom = Math.max(...cards.map((r) => r.y + r.h));
  const within = (b: Rect) =>
    b.x >= left && b.y >= top && b.x + b.w <= right && b.y + b.h <= bottom;
  const boxAt = (p: Pt, w: number, h: number): Rect => ({ x: p.x - w / 2, y: p.y - h / 2, w, h });
  const free = (box: Rect, others: readonly Rect[]) => !others.some((o) => overlaps(box, o));

  for (const req of requests) {
    const curve = req.route ?? edgeCurve(req.source, req.target);
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
    }
    if (!spot) {
      for (const t of NEAR_T) {
        const p = curve.at(t);
        for (const q of nearSpots(p, req.w, req.h, [...padded, ...placed])) {
          const box = boxAt(q, req.w, req.h);
          if (within(box) && free(box, padded) && free(box, placed)) {
            spot = { t, dx: q.x - p.x, dy: q.y - p.y };
            break;
          }
        }
        if (spot) break;
      }
    }
    // 都找不到：寧可和別的標籤疊在線上不壓卡的點，再不行才放到來源卡右緣外面。
    if (!spot && fallback !== null) spot = { t: fallback, dx: 0, dy: 0 };
    spot ??= { t: 0, dx: req.w / 2 + pad, dy: 0 };
    const p = curve.at(spot.t);
    placed.push(boxAt({ x: p.x + spot.dx, y: p.y + spot.dy }, req.w, req.h));
    out.set(req.id, spot);
  }
  return out;
}
