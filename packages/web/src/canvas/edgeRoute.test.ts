// 關係線走卡片之間的空隙（GM 2026-11-09：整理畫布後關係線被卡片壓住看不到）。
// 幾何檢查：整理後每條線取樣的點都不在任何卡片裡（線畫在卡片底下，進到卡裡就看不到），
// 線上的標籤也不和卡片重疊。
import { describe, expect, it } from 'vitest';
import type { HandoffRule, TeamMember } from '@agent-board/protocol';
import {
  arrangeCanvas,
  arrangeTeam,
  PROGRESS_CARD_W,
  PROGRESS_DEFAULT_H,
  PROGRESS_GAP,
  TEAM_BLOCK_GAP,
  TEAM_GAP_SCREEN,
  tidyFitZoom,
  type ArrangeInput,
  type ArrangeSession,
} from './arrange';
import { anchor, HANDLE_Y, routeEdge, ROUTE_CLEAR, type Route } from './edgeRoute';
import { buildLinks, DEFAULT_FILTERS, type Link } from './interactions';
import { placeLabels, textWidth } from './labelPlacement';
import { CARD_H, CARD_W, GAP_X, GAP_Y, overlaps, type Rect } from './layout';
import { groupHandoffs, TEAM_PADDING } from './teams';

const STEP_X = CARD_W + GAP_X;
const STEP_Y = CARD_H + GAP_Y;
const card = (x: number, y: number, w = CARD_W, h = CARD_H): Rect => ({ x, y, w, h });

const strictlyInside = (p: { x: number; y: number }, r: Rect) =>
  p.x > r.x + 0.01 && p.x < r.x + r.w - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.h - 0.01;

/** 線上取樣，回傳落在卡片裡的點（標明是哪張卡）。 */
function hits(route: Route, cards: ReadonlyMap<string, Rect>, samples = 400): string[] {
  const out: string[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const p = route.at(i / samples);
    for (const [id, r] of cards) {
      if (strictlyInside(p, r)) out.push(`${id}@${(i / samples).toFixed(3)}`);
    }
  }
  return out;
}

/** CanvasPage 的算法：線、路線、標籤（縮放 z 時標籤在畫布上的大小是螢幕大小 / z）。 */
function layoutLinks(
  rects: ReadonlyMap<string, Rect>,
  members: readonly TeamMember[],
  rules: readonly HandoffRule[],
  dispatched: readonly { id: string; dispatchedBy: string | null }[] = [],
  z = 1,
) {
  const links = buildLinks({
    sessions: dispatched,
    handoffs: groupHandoffs(rules),
    members,
    live: new Set(rects.keys()),
    filters: DEFAULT_FILTERS,
    traffic: new Map(),
  });
  const cards = [...rects.values()];
  const routes = new Map<string, Route>();
  for (const l of links) {
    routes.set(l.id, routeEdge(rects.get(l.source)!, rects.get(l.target)!, cards, l.offset));
  }
  // 規則線的字（「完成時交接」）。
  const labeled = links.filter((l) => l.kind === 'handoff');
  const w = textWidth('完成時交接') / z;
  const h = 22 / z;
  const spots = placeLabels(
    labeled.map((l) => ({
      id: l.id,
      source: anchor(rects.get(l.source)!, 'right', l.offset),
      target: anchor(rects.get(l.target)!, 'left', l.offset),
      route: routes.get(l.id),
      w,
      h,
    })),
    cards,
    6 / z,
  );
  const labels = new Map(
    labeled.map((l) => {
      const spot = spots.get(l.id)!;
      const p = routes.get(l.id)!.at(spot.t);
      const box = { x: p.x + spot.dx - w / 2, y: p.y + spot.dy - h / 2, w, h };
      return [l.id, box] as const;
    }),
  );
  return { links, routes, labels };
}

function expectVisible(
  rects: ReadonlyMap<string, Rect>,
  members: readonly TeamMember[],
  rules: readonly HandoffRule[],
  dispatched: readonly { id: string; dispatchedBy: string | null }[] = [],
  z = 1,
) {
  const { links, routes, labels } = layoutLinks(rects, members, rules, dispatched, z);
  const problems: string[] = [];
  for (const l of links) {
    const route = routes.get(l.id)!;
    if (route.kind === 'fallback') problems.push(`${l.id}: 找不到路`);
    // 不只端點以外的卡：線畫在卡片底下，連兩端的卡也不能穿過。
    const bad = hits(route, rects);
    if (bad.length > 0) problems.push(`${l.id}: ${bad.slice(0, 3).join(', ')}`);
  }
  for (const [id, box] of labels) {
    const under = [...rects].filter(([, r]) => overlaps(box, r)).map(([cid]) => cid);
    if (under.length > 0) problems.push(`標籤 ${id} 壓到 ${under.join(',')}`);
  }
  expect(problems).toEqual([]);
  return { links, routes, labels };
}

const session = (id: string): ArrangeSession => ({
  id,
  name: id,
  projectId: null,
  cwd: '/work',
  ended: false,
});
const member = (teamId: string, sessionId: string, role: TeamMember['role']): TeamMember => ({
  teamId,
  sessionId,
  role,
});
const rule = (teamId: string, from: string, to: string, i = 0): HandoffRule => ({
  id: `r-${from}-${to}-${i}`,
  teamId,
  fromSessionId: from,
  trigger: 'on_done',
  action: { toSessionId: to },
  enabled: true,
});

function input(
  rects: Record<string, Rect>,
  members: TeamMember[],
  rules: HandoffRule[] = [],
): ArrangeInput {
  return {
    rects: new Map(Object.entries(rects)),
    sessions: Object.keys(rects).map(session),
    teams: [...new Set(members.map((m) => m.teamId))].map((id) => ({ id })),
    members,
    links: rules.map((r) => ({ source: r.fromSessionId, target: r.action.toSessionId })),
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('線的走法', () => {
  const a = card(0, 0);

  it('目標在右邊：右緣出、左緣進的曲線（和以前一樣）', () => {
    const b = card(STEP_X, 300);
    const route = routeEdge(a, b, [a, b]);
    expect(route).toMatchObject({ kind: 'curve', from: 'right', to: 'left' });
    expect(route.at(0)).toEqual({ x: CARD_W, y: HANDLE_Y });
    expect(route.at(1)).toEqual({ x: STEP_X, y: 300 + HANDLE_Y });
  });

  it('上下排（隊長在成員正上方）：下緣出、上緣進，整條在兩列之間的空隙', () => {
    const b = card(0, STEP_Y);
    const up = routeEdge(b, a, [a, b]);
    expect(up).toMatchObject({ kind: 'curve', from: 'top', to: 'bottom' });
    const down = routeEdge(a, b, [a, b]);
    expect(down).toMatchObject({ kind: 'curve', from: 'bottom', to: 'top' });
    for (let i = 0; i <= 20; i += 1) {
      const p = down.at(i / 20);
      expect(p.y).toBeGreaterThanOrEqual(CARD_H);
      expect(p.y).toBeLessThanOrEqual(STEP_Y);
    }
  });

  it('目標在左邊：左緣出、右緣進', () => {
    const b = card(-STEP_X, 0);
    expect(routeEdge(a, b, [a, b])).toMatchObject({ kind: 'curve', from: 'left', to: 'right' });
  });

  it('同一列隔著一張卡：不穿過中間的卡，改走卡片之間空隙的直角折線', () => {
    const mid = card(STEP_X, 0);
    const b = card(2 * STEP_X, 0);
    const below = card(STEP_X, STEP_Y);
    const rects = new Map(Object.entries({ a, mid, b, below }));
    const route = routeEdge(a, b, [...rects.values()]);
    expect(route.kind).toBe('orthogonal');
    expect(hits(route, rects)).toEqual([]);
    // 走中間那張卡上面或下面的空隙，離卡至少 ROUTE_CLEAR。
    const mids = Array.from({ length: 101 }, (_, i) => route.at(i / 100));
    for (const p of mids) {
      if (p.x > mid.x && p.x < mid.x + mid.w) {
        expect(p.y <= mid.y - ROUTE_CLEAR || p.y >= mid.y + mid.h + ROUTE_CLEAR).toBe(true);
      }
    }
    // 轉角是圓角。
    expect(route.d).toContain('Q');
  });

  it('同方向的多條線錯開，不疊成一條', () => {
    const b = card(0, STEP_Y);
    const one = routeEdge(a, b, [a, b], -7);
    const two = routeEdge(a, b, [a, b], 7);
    expect(one.at(0).x).not.toBe(two.at(0).x);
  });

  it('一張卡整個蓋住另一張、找不到路：退回原本的曲線', () => {
    const b = card(100, 100, 200, 200);
    const route = routeEdge(a, b, [a, b]);
    expect(route.kind).toBe('fallback');
    expect(route.at(0)).toEqual({ x: CARD_W, y: HANDLE_Y });
  });

  it('同樣的輸入一定得到同樣的路', () => {
    const cards = [a, card(STEP_X, 0), card(2 * STEP_X, 0), card(STEP_X, STEP_Y)];
    expect(routeEdge(a, cards[2]!, cards).d).toBe(routeEdge(a, cards[2]!, cards).d);
  });
});

describe('整理畫布後關係線看得到（GM 2026-11-09）', () => {
  it('demo：隊長在上、成員在下，交接線從兩列之間的空隙走，標籤不壓到卡', () => {
    const members = [member('t', 's-tests', 'lead'), member('t', 's-auth', 'worker')];
    const rules = [rule('t', 's-auth', 's-tests')];
    const data = input(
      {
        's-auth': card(0, 0),
        's-tests': card(STEP_X, 0),
        's-etl': card(2 * STEP_X, 0),
        's-ml': card(0, STEP_Y),
        's-docs': card(STEP_X, STEP_Y),
        's-web': card(2 * STEP_X, STEP_Y),
      },
      members,
      rules,
    );
    const out = arrangeCanvas(data);
    // 整理前：成員在隊長正下方時，以前的線（右緣 → 左緣）整條藏在兩張卡底下。
    const lead = out.get('s-tests')!;
    const worker = out.get('s-auth')!;
    expect(worker.x).toBe(lead.x);
    const { routes } = expectVisible(out, members, rules);
    expect(routes.get('s-auth->s-tests')).toMatchObject({ from: 'top', to: 'bottom' });
    // 縮到整理後常見的 0.4 倍，字也還放得進兩列之間。
    expectVisible(out, members, rules, [], 0.4);
  });

  it('大團隊（隊長＋7 位成員、交接鏈、隊長線、派工線）：每條線都不穿過任何卡，標籤不壓到卡', () => {
    const ids = ['ld', 'a', 'b', 'c', 'd', 'e', 'rv1', 'rv2', 'x', 'y'];
    const members = [
      member('t', 'ld', 'lead'),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => member('t', id, 'worker')),
      member('t', 'rv1', 'reviewer'),
      member('t', 'rv2', 'reviewer'),
    ];
    const rules = [
      rule('t', 'c', 'a'),
      rule('t', 'a', 'e'),
      rule('t', 'e', 'rv2'),
      rule('t', 'rv2', 'ld'),
      rule('t', 'b', 'rv1'),
      rule('t', 'd', 'ld'),
    ];
    const rects = Object.fromEntries(ids.map((id, i) => [id, card((i % 4) * STEP_X, 0)]));
    const out = arrangeCanvas(input(rects, members, rules));
    expectVisible(out, members, rules, [
      { id: 'x', dispatchedBy: 'ld' },
      { id: 'y', dispatchedBy: 'x' },
    ]);
  });

  it('整理團隊後也一樣', () => {
    const members = [
      member('t', 'ld', 'lead'),
      member('t', 'a', 'worker'),
      member('t', 'b', 'worker'),
      member('t', 'c', 'worker'),
      member('t', 'd', 'reviewer'),
    ];
    const rules = [rule('t', 'a', 'd'), rule('t', 'd', 'ld'), rule('t', 'c', 'b')];
    const rects = {
      ld: card(5 * STEP_X, 3 * STEP_Y),
      a: card(0, 0),
      b: card(2 * STEP_X, 4 * STEP_Y),
      c: card(4 * STEP_X, 0),
      d: card(STEP_X, 2 * STEP_Y),
      other: card(STEP_X, STEP_Y),
    };
    const out = arrangeTeam('t', input(rects, members, rules));
    expectVisible(out, members, rules);
  });

  it('隨機團隊與交接規則（固定種子）：整理後每條線都找得到路、不穿過任何卡', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = rng(seed);
      const n = 2 + Math.floor(rand() * 12);
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      const rects = Object.fromEntries(
        ids.map((id, i) => [
          id,
          card((i % 5) * STEP_X + (rand() < 0.3 ? 37 : 0), Math.floor(i / 5) * STEP_Y),
        ]),
      );
      const members: TeamMember[] = [];
      const teams = 1 + Math.floor(rand() * 3);
      for (const id of ids) {
        if (rand() < 0.2) continue;
        const t = `t${Math.floor(rand() * teams)}`;
        const lead = !members.some((m) => m.teamId === t && m.role === 'lead');
        members.push(member(t, id, lead ? 'lead' : rand() < 0.3 ? 'reviewer' : 'worker'));
      }
      const rules: HandoffRule[] = [];
      for (let k = 0; k < n; k += 1) {
        const a = members[Math.floor(rand() * members.length)];
        const b = members[Math.floor(rand() * members.length)];
        if (a && b && a.teamId === b.teamId && a.sessionId !== b.sessionId) {
          rules.push(rule(a.teamId, a.sessionId, b.sessionId, k));
        }
      }
      const out = arrangeCanvas(input(rects, members, rules));
      const { links, routes } = layoutLinks(out, members, rules);
      const bad = links.flatMap((l: Link) => {
        const route = routes.get(l.id)!;
        const h = hits(route, out, 200);
        return route.kind === 'fallback' || h.length > 0 ? [`${l.id} ${route.kind} ${h[0]}`] : [];
      });
      expect(bad, `seed ${seed}`).toEqual([]);
    }
  });

  it('30 張卡、40 條線：路線＋標籤擺放算得夠快（放開卡片、縮放換級時整張重算一次）', () => {
    // 拖曳中不整張重算（CanvasPage 的 draggingIds：連到被拖的卡的線畫簡單曲線，其他沿用），
    // 所以這裡量的是「放開那一下」的成本，含 placeLabels（審查 tidy-edges #1）。
    const rand = rng(7);
    const rects = new Map<string, Rect>();
    for (let i = 0; i < 30; i += 1) {
      rects.set(
        `s${i}`,
        card((i % 6) * STEP_X + Math.floor(rand() * 60), Math.floor(i / 6) * STEP_Y),
      );
    }
    const cards = [...rects.values()];
    const pairs: [Rect, Rect][] = [];
    for (let k = 0; k < 40; k += 1) {
      const a = cards[Math.floor(rand() * 30)]!;
      const b = cards[Math.floor(rand() * 30)]!;
      if (a !== b) pairs.push([a, b]);
    }
    const z = 0.3;
    const start = performance.now();
    const requests = pairs.map(([a, b], i) => ({
      id: `e${i}`,
      source: anchor(a, 'right', 0),
      target: anchor(b, 'left', 0),
      route: routeEdge(a, b, cards),
      w: textWidth('完成時交接') / z,
      h: 26 / z,
    }));
    placeLabels(requests, cards, 6 / z);
    // 單獨跑約 105ms；pnpm -r test 幾個套件同時跑時會慢好幾倍，門檻留寬一點免得誤報。
    expect(performance.now() - start).toBeLessThan(800);
  });
});

// GM 2026-11-09「我需要你妥善利用空間」：人一多以前只會往下長成很高的一欄（每列最多 3 張）。
// 用 GM 實際的量級：1 個團隊 5、8、12、16 人，6 個團隊各 3–5 人。
describe('整理畫布妥善利用空間（GM 2026-11-09）', () => {
  /** 1440×900 視窗扣掉頁首與左側欄後的畫布，和常見 16:10 螢幕。 */
  const VIEWS = [
    { w: 1208, h: 808 },
    { w: 1600, h: 1000 },
  ];

  /** 幾個團隊：隊長＋開發＋最後一位審查，交接鏈 開發1 → 開發2 → … → 審查 → 隊長；外加兩張沒有團隊的卡。 */
  function scenario(sizes: readonly number[]) {
    const rects: Record<string, Rect> = {};
    const members: TeamMember[] = [];
    const rules: HandoffRule[] = [];
    let k = 0;
    sizes.forEach((n, t) => {
      const team = `t${t}`;
      const ids = Array.from({ length: n }, (_, i) => `${team}-${i}`);
      ids.forEach((id, i) => {
        // 整理前散在一片很寬的格子上。
        rects[id] = card((k % 9) * STEP_X, Math.floor(k / 9) * STEP_Y);
        k += 1;
        const role = i === 0 ? 'lead' : i === n - 1 && n > 2 ? 'reviewer' : 'worker';
        members.push(member(team, id, role));
      });
      for (let i = 1; i < n - 1; i += 1) rules.push(rule(team, ids[i]!, ids[i + 1]!));
      if (n > 2) rules.push(rule(team, ids[n - 1]!, ids[0]!));
    });
    for (const id of ['loose-a', 'loose-b']) {
      rects[id] = card((k % 9) * STEP_X, Math.floor(k / 9) * STEP_Y);
      k += 1;
    }
    return { data: input(rects, members, rules), members, rules };
  }

  const union = (all: readonly Rect[]): Rect => {
    const x = Math.min(...all.map((r) => r.x));
    const y = Math.min(...all.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...all.map((r) => r.x + r.w)) - x,
      h: Math.max(...all.map((r) => r.y + r.h)) - y,
    };
  };
  /** 團隊框：成員外圍再留 TEAM_PADDING（和 teams.ts teamRect 一致）。 */
  const frameOf = (
    out: ReadonlyMap<string, Rect>,
    members: readonly TeamMember[],
    team: string,
  ) => {
    const b = union(members.filter((m) => m.teamId === team).map((m) => out.get(m.sessionId)!));
    return {
      x: b.x - TEAM_PADDING,
      y: b.y - TEAM_PADDING,
      w: b.w + 2 * TEAM_PADDING,
      h: b.h + 2 * TEAM_PADDING,
    };
  };
  const gap = (p: Rect, q: Rect) =>
    Math.max(q.x - (p.x + p.w), p.x - (q.x + q.w), q.y - (p.y + p.h), p.y - (q.y + q.h));

  const cases: [string, number[]][] = [
    ['1 個團隊 5 人', [5]],
    ['1 個團隊 8 人', [8]],
    ['1 個團隊 12 人', [12]],
    ['1 個團隊 16 人', [16]],
    ['6 個團隊各 3–5 人', [3, 4, 5, 3, 4, 5]],
  ];
  for (const [name, sizes] of cases) {
    it(`${name}：範圍接近畫面比例（1.2–2.2）；線不穿過卡、字不壓到卡；進度卡不被壓；團隊之間 ≥ 36px`, () => {
      const { data, members, rules } = scenario(sizes);
      for (const view of VIEWS) {
        const at = `${view.w}×${view.h}`;
        const out = arrangeCanvas({ ...data, view });
        const teamIds = [...new Set(members.map((m) => m.teamId))];
        const teams = teamIds.map((t) => frameOf(out, members, t));
        // 整理後畫面上看得到的範圍：卡片＋團隊框。
        const b = union([...out.values()]);
        const whole = union([...out.values(), ...teams]);
        const aspect = whole.w / whole.h;
        expect(aspect, at).toBeGreaterThanOrEqual(1.2);
        expect(aspect, at).toBeLessThanOrEqual(2.2);
        expect(b.w / b.h, at).toBeGreaterThanOrEqual(1.2);
        // 以前每列最多 3 張：16 人是 6 列 × 3 欄（長寬比約 0.5）。現在同一列可以超過 3 張。
        if (sizes[0]! >= 12) {
          const perRow = new Map<number, number>();
          for (const r of out.values()) perRow.set(r.y, (perRow.get(r.y) ?? 0) + 1);
          expect(Math.max(...perRow.values()), at).toBeGreaterThan(3);
        }
        // 全部顯示時的縮放（整理後的 fitView：下限 TIDY_FIT_MIN_ZOOM），線上的字照這個縮放算大小。
        const z = tidyFitZoom(whole, view.w, view.h, { padding: 0.06, maxZoom: 1 });
        expectVisible(out, members, rules, [], z);
        // 團隊框之間：畫布上至少 TEAM_BLOCK_GAP，畫面上至少 TEAM_GAP_SCREEN（36px）（P2 §4.2）。
        for (let i = 0; i < teams.length; i += 1) {
          for (let j = i + 1; j < teams.length; j += 1) {
            const g = gap(teams[i]!, teams[j]!);
            expect(g, at).toBeGreaterThanOrEqual(TEAM_BLOCK_GAP - 1e-6);
            expect(g * z, at).toBeGreaterThanOrEqual(TEAM_GAP_SCREEN - 0.01);
          }
        }
        // 進度卡（框右上角外側、預設高度）不壓到任何別的卡或別的團隊框。
        for (const t of teams) {
          const note = {
            x: t.x + t.w + PROGRESS_GAP,
            y: t.y,
            w: PROGRESS_CARD_W,
            h: PROGRESS_DEFAULT_H,
          };
          for (const other of [...out.values(), ...teams.filter((o) => o !== t)]) {
            expect(overlaps(note, other), at).toBe(false);
          }
        }
      }
    });
  }

  it('40 張卡、10 個團隊整理得夠快（按一下就要排好）', () => {
    const { data } = scenario([5, 4, 3, 5, 4, 3, 4, 4, 3, 3]);
    const start = performance.now();
    arrangeCanvas({ ...data, view: VIEWS[0] });
    expect(performance.now() - start).toBeLessThan(500);
  });
});
