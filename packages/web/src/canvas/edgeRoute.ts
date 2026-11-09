// 關係線怎麼走（GM 2026-11-09：整理畫布後關係線被卡片壓住看不到）。
// 線畫在卡片底下（xyflow 的 edge 在節點下層），所以線一定要走在卡片之間的空隙，不能穿過任何一張卡，
// 連兩端的卡也不行（以前一律「來源右緣 → 目標左緣」，上下排的兩張卡之間的線整條藏在兩張卡底下）。
//
// 規則：
// 1. 先試一條平滑曲線，依兩張卡的相對位置挑出口：目標在右邊 → 右緣出、左緣進（和拖線的把手一致）；
//    上下排 → 下緣出、上緣進（或反過來）；目標在左邊 → 左緣出、右緣進。曲線不碰到任何卡（含留白）就用它。
// 2. 都會碰到（例如同一列隔一張卡、斜對角隔著卡）：在卡片之間的空隙裡找一條直角折線（只走空隙的中線），
//    轉彎越少越好，轉角畫成圓角。
// 3. 卡片疊在一起、找不到路：退回原本的曲線（右緣 → 左緣）。
// 純函式，不碰 React，方便單元測試；CanvasPage 算好路徑交給 HandoffEdge 畫，標籤也沿著同一條路擺。
import type { Rect } from './layout';
import { edgeCurve, type Pt } from './labelPlacement';

/** 拖線把手在卡片上緣往下 28px（canvas.css .ab-handle）：左右出入的線從這裡出發。 */
export const HANDLE_Y = 28;
/** 線和卡片之間至少留多少（畫布 px）。整理後列與列之間 72、欄與欄之間 140，中線兩邊都夠。 */
export const ROUTE_CLEAR = 12;
/** 直角折線從卡緣先直直出去多遠才轉彎。 */
const STUB = 24;
/** 每轉一個彎多算多少長度：寧可繞遠一點也少轉彎。 */
const BEND = 160;
/** 不是慣用出入口（右出左進）的多算一點，同樣好走時維持慣例。 */
const SIDE_COST = 40;
/** 折線轉角的圓角半徑。 */
const RADIUS = 16;
/** 曲線的兩端要離開卡緣多少才算「有空隙」可以走曲線。 */
const MIN_GAP = 2 * ROUTE_CLEAR;

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface Route {
  /** SVG path。 */
  d: string;
  /** 線上第 t（0–1）點；標籤沿著它擺。 */
  at: (t: number) => Pt;
  /** curve：平滑曲線；orthogonal：直角折線；fallback：找不到路，退回原本的曲線。 */
  kind: 'curve' | 'orthogonal' | 'fallback';
  /** 出口與入口。 */
  from: Side;
  to: Side;
}

const NORMAL: Record<Side, Pt> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};
const SIDES: readonly Side[] = ['right', 'bottom', 'top', 'left'];

/** 卡片某一邊的出入點；offset 是同方向多條線時的錯開距離（左右邊沿 y、上下邊沿 x）。 */
export function anchor(r: Rect, side: Side, offset = 0): Pt {
  switch (side) {
    case 'right':
      return { x: r.x + r.w, y: r.y + HANDLE_Y + offset };
    case 'left':
      return { x: r.x, y: r.y + HANDLE_Y + offset };
    case 'bottom':
      return { x: r.x + r.w / 2 + offset, y: r.y + r.h };
    case 'top':
      return { x: r.x + r.w / 2 + offset, y: r.y };
  }
}

const inflate = (r: Rect, d: number): Rect => ({
  x: r.x - d,
  y: r.y - d,
  w: r.w + 2 * d,
  h: r.h + 2 * d,
});

/** 點在矩形裡面（邊上不算）。 */
const inside = (p: Pt, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;

/** 兩端各沿著出口方向拉出控制點的三次貝茲曲線。 */
function sideCurve(s: Pt, from: Side, e: Pt, to: Side): { d: string; at: (t: number) => Pt } {
  const horizontal = from === 'left' || from === 'right';
  const k = 0.5 * Math.abs(horizontal ? e.x - s.x : e.y - s.y);
  const c1 = { x: s.x + NORMAL[from].x * k, y: s.y + NORMAL[from].y * k };
  const c2 = { x: e.x + NORMAL[to].x * k, y: e.y + NORMAL[to].y * k };
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

/** 曲線取樣有沒有碰到障礙（別的卡含留白；兩端的卡本身不能穿過）。 */
function curveHits(
  at: (t: number) => Pt,
  approxLength: number,
  others: readonly Rect[],
  ends: readonly Rect[],
): boolean {
  const n = Math.min(240, Math.max(24, Math.ceil(approxLength / 12)));
  for (let i = 1; i < n; i += 1) {
    const p = at(i / n);
    if (others.some((o) => inside(p, o)) || ends.some((o) => inside(p, o))) return true;
  }
  return false;
}

/** 依兩張卡的相對位置，可以走曲線的出入口（優先順序由前到後）。 */
function curveSides(a: Rect, b: Rect): [Side, Side][] {
  const right = b.x - (a.x + a.w);
  const left = a.x - (b.x + b.w);
  const down = b.y - (a.y + a.h);
  const up = a.y - (b.y + b.h);
  const out: [Side, Side, number][] = [];
  if (right >= MIN_GAP) out.push(['right', 'left', Infinity]);
  if (down >= MIN_GAP) out.push(['bottom', 'top', down]);
  if (up >= MIN_GAP) out.push(['top', 'bottom', up]);
  if (left >= MIN_GAP) out.push(['left', 'right', left]);
  // 慣用的右出左進優先；其他的空隙越寬越好走。
  return out.sort((x, y) => y[2] - x[2]).map(([f, t]) => [f, t]);
}

/** 折線：依長度取點，轉角畫圓角。 */
function polyline(points: readonly Pt[]): { d: string; at: (t: number) => Pt } {
  const lens = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const at = (t: number): Pt => {
    let left = Math.min(1, Math.max(0, t)) * total;
    for (let i = 0; i < lens.length; i += 1) {
      const len = lens[i]!;
      if (left <= len || i === lens.length - 1) {
        const k = len === 0 ? 0 : Math.min(1, left / len);
        const a = points[i]!;
        const b = points[i + 1]!;
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
      left -= len;
    }
    return points[points.length - 1]!;
  };
  let d = `M${points[0]!.x},${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const p = points[i]!;
    const next = points[i + 1]!;
    const r = Math.min(RADIUS, lens[i - 1]! / 2, lens[i]! / 2);
    const toward = (q: Pt, len: number) => ({
      x: p.x + ((q.x - p.x) / (len || 1)) * r,
      y: p.y + ((q.y - p.y) / (len || 1)) * r,
    });
    const a = toward(prev, lens[i - 1]!);
    const b = toward(next, lens[i]!);
    d += ` L${a.x},${a.y} Q${p.x},${p.y} ${b.x},${b.y}`;
  }
  const last = points[points.length - 1]!;
  d += ` L${last.x},${last.y}`;
  return { d, at };
}

/** 去掉同一直線上的中間點。 */
function simplify(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const n = out.length;
    if (n > 0 && out[n - 1]!.x === p.x && out[n - 1]!.y === p.y) continue;
    if (n >= 2) {
      const a = out[n - 2]!;
      const b = out[n - 1]!;
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out[n - 1] = p;
      else out.push(p);
    } else out.push(p);
  }
  return out;
}

const DIRS: readonly Pt[] = [NORMAL.right, NORMAL.bottom, NORMAL.left, NORMAL.top];
const dirIndex = (p: Pt) => DIRS.findIndex((d) => d.x === p.x && d.y === p.y);

/** 小小的二元堆積（Dijkstra 用）。 */
class Heap {
  private items: { cost: number; state: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, state: number) {
    const a = this.items;
    a.push({ cost, state });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.cost <= a[i]!.cost) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { cost: number; state: number } {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.cost < a[m]!.cost) m = l;
        if (r < a.length && a[r]!.cost < a[m]!.cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * 在卡片之間的空隙找直角折線。格線只取「相鄰兩條卡緣的中間」（空隙的中線）、出入口的延伸線，
 * 和整片卡片外圍；每轉一個彎加 BEND。找不到回 null。
 */
function orthogonal(a: Rect, b: Rect, cards: readonly Rect[], offset: number): Route | null {
  const blocks = cards.map((r) => inflate(r, ROUTE_CLEAR));
  const free = (p: Pt) => !blocks.some((o) => inside(p, o));
  const ends = (r: Rect, out: boolean) =>
    SIDES.flatMap((side) => {
      const at = anchor(r, side, offset);
      const n = NORMAL[side];
      const stub = { x: at.x + n.x * STUB, y: at.y + n.y * STUB };
      if (!free(stub)) return [];
      const usual = out ? side === 'right' : side === 'left';
      return [{ side, at, stub, cost: usual ? 0 : SIDE_COST }];
    });
  const starts = ends(a, true);
  const goals = ends(b, false);
  if (starts.length === 0 || goals.length === 0) return null;

  const axis = (pick: (r: Rect) => number[], stubs: number[]) => {
    const edges = [...new Set(cards.flatMap(pick))].sort((p, q) => p - q);
    const mids = edges.slice(1).map((v, i) => (v + edges[i]!) / 2);
    const outer = [edges[0]! - 4 * STUB, edges[edges.length - 1]! + 4 * STUB];
    return [...new Set([...mids, ...outer, ...stubs])].sort((p, q) => p - q);
  };
  const xs = axis(
    (r) => [r.x, r.x + r.w],
    [...starts, ...goals].map((s) => s.stub.x),
  );
  const ys = axis(
    (r) => [r.y, r.y + r.h],
    [...starts, ...goals].map((s) => s.stub.y),
  );
  const W = xs.length;
  const H = ys.length;
  const nodeFree: boolean[] = [];
  for (let j = 0; j < H; j += 1)
    for (let i = 0; i < W; i += 1) nodeFree.push(free({ x: xs[i]!, y: ys[j]! }));
  // 兩個相鄰格點之間的線段有沒有穿過障礙。
  const segFree = (p: Pt, q: Pt) =>
    !blocks.some((o) => {
      if (p.y === q.y) {
        const [x1, x2] = p.x < q.x ? [p.x, q.x] : [q.x, p.x];
        return p.y > o.y && p.y < o.y + o.h && x1 < o.x + o.w && x2 > o.x;
      }
      const [y1, y2] = p.y < q.y ? [p.y, q.y] : [q.y, p.y];
      return p.x > o.x && p.x < o.x + o.w && y1 < o.y + o.h && y2 > o.y;
    });

  const index = (p: Pt) => {
    const i = xs.indexOf(p.x);
    const j = ys.indexOf(p.y);
    return i < 0 || j < 0 ? -1 : j * W + i;
  };
  // 狀態＝格點 × 進來的方向。
  const best = new Map<number, number>();
  const back = new Map<number, number>();
  const heap = new Heap();
  for (const s of starts) {
    const node = index(s.stub);
    if (node < 0) continue;
    const state = node * 4 + dirIndex(NORMAL[s.side]);
    const cost = s.cost + STUB;
    if (cost < (best.get(state) ?? Infinity)) {
      best.set(state, cost);
      heap.push(cost, state);
    }
  }
  const goalAt = new Map<number, (typeof goals)[number]>();
  for (const g of goals) {
    const node = index(g.stub);
    if (node >= 0) goalAt.set(node, g);
  }

  let found: { state: number; goal: (typeof goals)[number] } | null = null;
  let foundCost = Infinity;
  while (heap.size > 0) {
    const { cost, state } = heap.pop();
    if (cost > (best.get(state) ?? Infinity)) continue;
    if (cost >= foundCost) break;
    const node = state >> 2;
    const dir = state & 3;
    const goal = goalAt.get(node);
    if (goal) {
      // 最後一段：從入口的延伸點直直進卡（方向和入口法線相反）。
      const into = dirIndex({ x: -NORMAL[goal.side].x, y: -NORMAL[goal.side].y });
      const total = cost + goal.cost + STUB + (dir === into ? 0 : BEND);
      if (dir !== (into + 2) % 4 && total < foundCost) {
        foundCost = total;
        found = { state, goal };
      }
    }
    const i = node % W;
    const j = (node - i) / W;
    const p = { x: xs[i]!, y: ys[j]! };
    for (let nd = 0; nd < 4; nd += 1) {
      if (nd === (dir + 2) % 4) continue; // 不掉頭
      const ni = i + DIRS[nd]!.x;
      const nj = j + DIRS[nd]!.y;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const next = nj * W + ni;
      if (!nodeFree[next]) continue;
      const q = { x: xs[ni]!, y: ys[nj]! };
      if (!segFree(p, q)) continue;
      const step = Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + (nd === dir ? 0 : BEND);
      const ns = next * 4 + nd;
      const nc = cost + step;
      if (nc < (best.get(ns) ?? Infinity)) {
        best.set(ns, nc);
        back.set(ns, state);
        heap.push(nc, ns);
      }
    }
  }
  if (!found) return null;

  const trail: Pt[] = [];
  let state: number | undefined = found.state;
  let first = found.state;
  while (state !== undefined) {
    const node = state >> 2;
    const i = node % W;
    trail.push({ x: xs[i]!, y: ys[(node - i) / W]! });
    first = state;
    state = back.get(state);
  }
  trail.reverse();
  const startNode = first >> 2;
  const start = starts.find(
    (s) => index(s.stub) === startNode && dirIndex(NORMAL[s.side]) === (first & 3),
  )!;
  const points = simplify([start.at, ...trail, found.goal.at]);
  return { ...polyline(points), kind: 'orthogonal', from: start.side, to: found.goal.side };
}

/**
 * 從 from 卡到 to 卡的線。cards 是畫布上所有的卡，可以含兩端（用同一個物件比對，是兩端就不當障礙）。
 */
export function routeEdge(from: Rect, to: Rect, cards: readonly Rect[], offset = 0): Route {
  const others = cards.filter((r) => r !== from && r !== to).map((r) => inflate(r, ROUTE_CLEAR));
  for (const [fs, ts] of curveSides(from, to)) {
    const s = anchor(from, fs, offset);
    const e = anchor(to, ts, offset);
    const curve = sideCurve(s, fs, e, ts);
    const approx = 1.5 * Math.hypot(e.x - s.x, e.y - s.y);
    if (!curveHits(curve.at, approx, others, [from, to])) {
      return { ...curve, kind: 'curve', from: fs, to: ts };
    }
  }
  const ortho = orthogonal(from, to, [...new Set([...cards, from, to])], offset);
  if (ortho) return ortho;
  const fallback = edgeCurve(anchor(from, 'right', offset), anchor(to, 'left', offset));
  return { ...fallback, kind: 'fallback', from: 'right', to: 'left' };
}
