import { describe, expect, it } from 'vitest';
import type { ResearchKind, TeamMember } from '@agent-board/protocol';
import {
  arrangeCanvas,
  arrangeTeam,
  DEFAULT_VIEW,
  restoreLayout,
  PROGRESS_CARD_W,
  PROGRESS_DEFAULT_H,
  PROGRESS_GAP,
  PROGRESS_RESERVE,
  TEAM_BLOCK_GAP,
  TEAM_CLEAR,
  TEAM_GAP_SCREEN,
  TEAM_ROW_GAP,
  teamRows,
  TIDY_FIT_MIN_ZOOM,
  tidyFitZoom,
  type ArrangeInput,
  type ArrangeSession,
} from './arrange';
import {
  CARD_H,
  CARD_W,
  GAP_X,
  GAP_Y,
  layoutRows,
  nextFreeSlot,
  overlaps,
  PREVIOUS_WORKSPACE,
  WORKSPACE,
  type Rect,
} from './layout';
import { canvasTeams, TEAM_PADDING, teamRect } from './teams';

const STEP_X = CARD_W + GAP_X;
const STEP_Y = CARD_H + GAP_Y;
/** 團隊裡上下兩列的距離（TEAM_ROW_GAP 比 GAP_Y 寬，留給關係線和線上的字）。 */
const TEAM_STEP_Y = CARD_H + TEAM_ROW_GAP;

const card = (x: number, y: number): Rect => ({ x, y, w: CARD_W, h: CARD_H });
const session = (id: string, extra: Partial<ArrangeSession> = {}): ArrangeSession => ({
  id,
  name: id,
  projectId: null,
  cwd: '/work',
  ended: false,
  ...extra,
});
const member = (
  teamId: string,
  sessionId: string,
  role: TeamMember['role'],
  kind?: ResearchKind,
): TeamMember => ({ teamId, sessionId, role, ...(kind ? { kind } : {}) });

function input(
  rects: Record<string, Rect>,
  members: TeamMember[] = [],
  sessions: ArrangeSession[] = Object.keys(rects).map((id) => session(id)),
): ArrangeInput {
  const teams = [...new Set(members.map((m) => m.teamId))].map((id) => ({ id }));
  return { rects: new Map(Object.entries(rects)), sessions, teams, members };
}

function boundsOf(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

function overlapping(rects: ReadonlyMap<string, Rect>): string[] {
  const list = [...rects];
  const out: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (overlaps(list[i]![1], list[j]![1])) out.push(`${list[i]![0]}×${list[j]![0]}`);
    }
  }
  return out;
}

function frames(data: ArrangeInput, rects: ReadonlyMap<string, Rect>) {
  return canvasTeams(
    data.teams.map((t) => ({
      ...t,
      name: t.id,
      goal: '',
      doneCriteria: '',
      color: '',
      contextMd: '',
      zoneId: 'main',
    })),
    data.members,
  ).flatMap((team) => {
    const rect = teamRect(team, rects);
    return rect ? [{ team, rect }] : [];
  });
}

/** 固定種子的亂數，失敗時可以重現。 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 隨機畫布：卡片放在互不重疊的格子上（可能很散），隨機團隊（有些成員同時在兩個團隊）。 */
function randomCanvas(seed: number): ArrangeInput {
  const rand = rng(seed);
  const n = Math.floor(rand() * 14);
  const rects: Record<string, Rect> = {};
  const occupied: Rect[] = [];
  for (let i = 0; i < n; i += 1) {
    // 散在 8×6 的格子上，偶爾不對齊格線。
    let r: Rect;
    do {
      r = card(
        Math.floor(rand() * 8) * STEP_X + (rand() < 0.3 ? 37 : 0),
        Math.floor(rand() * 6) * STEP_Y + (rand() < 0.3 ? 19 : 0),
      );
    } while (occupied.some((o) => overlaps(o, r)));
    occupied.push(r);
    rects[`s${i}`] = r;
  }
  const ids = Object.keys(rects);
  const roles: TeamMember['role'][] = ['lead', 'worker', 'researcher', 'reviewer'];
  const members: TeamMember[] = [];
  const teamCount = Math.floor(rand() * 4);
  for (let t = 0; t < teamCount; t += 1) {
    for (const id of ids) {
      const inTeam = members.some((m) => m.sessionId === id);
      if (rand() < (inTeam ? 0.08 : 0.3)) {
        members.push(member(`t${t}`, id, roles[Math.floor(rand() * roles.length)]!));
      }
    }
  }
  const sessions = ids.map((id) =>
    session(id, {
      name: `n${Math.floor(rand() * 5)}`,
      projectId: rand() < 0.5 ? `p${Math.floor(rand() * 3)}` : null,
      cwd: `/w${Math.floor(rand() * 2)}`,
      ended: rand() < 0.15,
    }),
  );
  return {
    rects: new Map(Object.entries(rects)),
    sessions,
    teams: [...new Set(members.map((m) => m.teamId))].sort().map((id) => ({ id })),
    members,
  };
}

/** 團隊 → 和它共用成員的所有團隊（含自己），算「同一群」。 */
function clusterOf(data: ArrangeInput) {
  const group = new Map(data.teams.map((t) => [t.id, new Set([t.id])]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of data.members) {
      for (const b of data.members) {
        if (a.sessionId !== b.sessionId) continue;
        const ga = group.get(a.teamId)!;
        const gb = group.get(b.teamId)!;
        if (ga === gb) continue;
        for (const id of gb) {
          ga.add(id);
          group.set(id, ga);
        }
        changed = true;
      }
    }
  }
  return group;
}

describe('teamRows：隊長一列，其餘依分工、名稱', () => {
  it('隊長在第一列；EX → WR → LR → RV；同分工依名稱；每列最多 3 張', () => {
    const data = input(
      {
        rv: card(0, 0),
        wr: card(0, 0),
        lead: card(0, 0),
        exB: card(0, 0),
        exA: card(0, 0),
        lr: card(0, 0),
        other: card(0, 0),
      },
      [
        member('t', 'rv', 'reviewer'),
        member('t', 'wr', 'worker', 'wr'),
        member('t', 'lead', 'lead'),
        member('t', 'exB', 'worker'),
        member('t', 'exA', 'worker', 'ex'),
        member('t', 'lr', 'researcher'),
        member('u', 'other', 'lead'),
      ],
    );
    expect(teamRows('t', data)).toEqual([['lead'], ['exA', 'exB', 'wr'], ['lr', 'rv']]);
  });

  it('多位隊長也分列；沒放上畫布的成員不排', () => {
    const data = input({ a: card(0, 0), b: card(0, 0), c: card(0, 0), d: card(0, 0) }, [
      member('t', 'a', 'lead'),
      member('t', 'b', 'lead'),
      member('t', 'c', 'lead'),
      member('t', 'd', 'lead'),
      member('t', 'ghost', 'worker'),
    ]);
    expect(teamRows('t', data)).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('同分工裡照交接順序由左到右（交接線只跨相鄰的空隙）；分工順序不變；有環也排得完', () => {
    const ids = ['lead', 'a', 'b', 'c', 'd', 'rv'];
    const data: ArrangeInput = {
      ...input(Object.fromEntries(ids.map((id) => [id, card(0, 0)])), [
        member('t', 'lead', 'lead'),
        member('t', 'a', 'worker'),
        member('t', 'b', 'worker'),
        member('t', 'c', 'worker'),
        member('t', 'd', 'worker'),
        member('t', 'rv', 'reviewer'),
      ]),
      // c → a → d，b 單獨；rv → lead 跨分工不影響；d → c 造成環也不會卡住。
      links: [
        { source: 'c', target: 'a' },
        { source: 'a', target: 'd' },
        { source: 'rv', target: 'lead' },
      ],
    };
    expect(teamRows('t', data)).toEqual([['lead'], ['b', 'c', 'a'], ['d', 'rv']]);
    const cyclic = { ...data, links: [...data.links!, { source: 'd', target: 'c' }] };
    expect(teamRows('t', cyclic).flat().sort()).toEqual([...ids].sort());
  });
});

describe('arrangeTeam', () => {
  it('錨定在原本的左上角；隊長置中在成員上方', () => {
    const data = input(
      {
        lead: card(3 * STEP_X, 4 * STEP_Y),
        a: card(STEP_X, 2 * STEP_Y),
        b: card(5 * STEP_X, STEP_Y),
        c: card(2 * STEP_X, 6 * STEP_Y),
      },
      [
        member('t', 'lead', 'lead'),
        member('t', 'a', 'worker'),
        member('t', 'b', 'worker'),
        member('t', 'c', 'reviewer'),
      ],
    );
    const out = arrangeTeam('t', data);
    const x0 = STEP_X;
    const y0 = STEP_Y;
    expect(out.get('lead')).toEqual(card(x0 + STEP_X, y0));
    expect(out.get('a')).toEqual(card(x0, y0 + TEAM_STEP_Y));
    expect(out.get('b')).toEqual(card(x0 + STEP_X, y0 + TEAM_STEP_Y));
    expect(out.get('c')).toEqual(card(x0 + 2 * STEP_X, y0 + TEAM_STEP_Y));
  });

  it('壓到新區塊的非成員搬到最近的空位，其他卡不動', () => {
    const data = input(
      {
        lead: card(0, 0),
        a: card(0, 3 * STEP_Y),
        // 會被新區塊（隊長＋1 位左右排：成員在隊長右邊）壓到
        intruder: card(STEP_X + 10, 10),
        // 遠處的卡不動
        far: card(9 * STEP_X, 0),
      },
      [member('t', 'lead', 'lead'), member('t', 'a', 'worker')],
    );
    const out = arrangeTeam('t', data);
    expect(out.get('lead')).toEqual(card(0, 0));
    expect(out.get('a')).toEqual(card(STEP_X, 0));
    expect(out.get('far')).toEqual(data.rects.get('far'));
    const moved = out.get('intruder')!;
    expect(moved).not.toEqual(data.rects.get('intruder'));
    const frame = teamRect({ id: 't', name: '', color: '', memberIds: ['lead', 'a'] }, out)!;
    expect(overlaps(moved, frame)).toBe(false);
    expect(overlapping(out)).toEqual([]);
    // 最近：只往旁邊挪，不會飛到很遠
    expect(Math.hypot(moved.x - (STEP_X + 10), moved.y - 10)).toBeLessThan(3 * STEP_X);
  });

  it('同時在兩個團隊的成員跟著被整理的團隊排；別的團隊成員被壓到才搬', () => {
    const data = input(
      {
        lead: card(0, 0),
        shared: card(4 * STEP_X, 0),
        uLead: card(5 * STEP_X, 0),
        uWorker: card(STEP_X, STEP_Y),
      },
      [
        member('t', 'lead', 'lead'),
        member('t', 'shared', 'worker'),
        member('u', 'uLead', 'lead'),
        member('u', 'shared', 'worker'),
        member('u', 'uWorker', 'worker'),
      ],
    );
    const out = arrangeTeam('t', data);
    // 隊長＋1 位：左右排，shared 排到隊長右邊。
    expect(out.get('shared')).toEqual(card(STEP_X, 0));
    // uWorker 原本在 (STEP_X, STEP_Y)，在 shared 新位置的正下方、團隊框的留白裡 → 搬走
    expect(overlaps(out.get('uWorker')!, out.get('shared')!)).toBe(false);
    expect(out.get('uLead')).toEqual(data.rects.get('uLead'));
    expect(overlapping(out)).toEqual([]);
  });

  it('隊長＋1 位：照畫面比例左右排（橫的畫面隊長在左）或上下排（直的畫面），團隊框不再是 0.48 的瘦長條', () => {
    const data = input({ lead: card(2 * STEP_X, 3 * STEP_Y), a: card(0, 0) }, [
      member('t', 'lead', 'lead'),
      member('t', 'a', 'worker'),
    ]);
    const frame = (out: ReadonlyMap<string, Rect>) =>
      teamRect({ id: 't', name: '', color: '', memberIds: ['lead', 'a'] }, out)!;
    for (const view of [undefined, DEFAULT_VIEW, { w: 1208, h: 808 }, { w: 2560, h: 1080 }]) {
      const out = arrangeTeam('t', { ...data, view });
      expect(out.get('lead')).toEqual(card(0, 0));
      expect(out.get('a')).toEqual(card(STEP_X, 0));
      const f = frame(out);
      expect(f.w / f.h).toBeGreaterThan(2);
    }
    // 直的畫面（手機）：上下排，隊長在上。
    const phone = arrangeTeam('t', { ...data, view: { w: 390, h: 760 } });
    expect(phone.get('lead')).toEqual(card(0, 0));
    expect(phone.get('a')).toEqual(card(0, TEAM_STEP_Y));
    // 隊長＋2 位以上不受影響：照舊隊長在上、成員一列。
    const three = arrangeTeam(
      't',
      input({ lead: card(0, 0), a: card(STEP_X, 0), b: card(2 * STEP_X, 0) }, [
        member('t', 'lead', 'lead'),
        member('t', 'a', 'worker'),
        member('t', 'b', 'worker'),
      ]),
    );
    expect(three.get('a')!.y).toBe(TEAM_STEP_Y);
    expect(three.get('b')!.y).toBe(TEAM_STEP_Y);
  });

  it('團隊不在畫布上：原樣回傳', () => {
    const data = input({ a: card(0, 0) }, [member('t', 'ghost', 'lead')]);
    expect(arrangeTeam('t', data)).toEqual(data.rects);
    expect(arrangeTeam('nope', data)).toEqual(data.rects);
  });

  it('只有一位成員：留在原地', () => {
    const data = input({ a: card(123, 456) }, [member('t', 'a', 'lead')]);
    expect(arrangeTeam('t', data).get('a')).toEqual(card(123, 456));
  });

  it('同樣的輸入一定得到同樣的結果', () => {
    const data = randomCanvas(7);
    const team = data.teams[0]?.id ?? 't';
    expect(arrangeTeam(team, data)).toEqual(arrangeTeam(team, data));
  });

  it('隨機畫布：不會產生重疊的卡，非成員不會落在團隊框裡', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const data = randomCanvas(seed);
      for (const { id } of data.teams) {
        const out = arrangeTeam(id, data);
        expect(overlapping(out), `seed ${seed} team ${id}`).toEqual([]);
        expect([...out.keys()].sort()).toEqual([...data.rects.keys()].sort());
        const memberIds = new Set(
          data.members.filter((m) => m.teamId === id).map((m) => m.sessionId),
        );
        const frame = frames(data, out).find((f) => f.team.id === id);
        if (!frame) continue;
        for (const [other, r] of out) {
          if (memberIds.has(other)) continue;
          expect(overlaps(r, frame.rect), `seed ${seed} ${other} in ${id}`).toBe(false);
        }
        // 新區塊外圍淨空（含標籤空間）
        const clear = {
          x: frame.rect.x - (TEAM_CLEAR - 32),
          y: frame.rect.y - (TEAM_CLEAR - 32),
          w: frame.rect.w + 2 * (TEAM_CLEAR - 32),
          h: frame.rect.h + 2 * (TEAM_CLEAR - 32),
        };
        for (const [other, r] of out) {
          if (!memberIds.has(other)) expect(overlaps(r, clear)).toBe(false);
        }
      }
    }
  });
});

describe('arrangeCanvas', () => {
  it('空畫布回空的；單張卡留在原地', () => {
    expect(arrangeCanvas(input({})).size).toBe(0);
    expect(arrangeCanvas(input({ a: card(500, 300) })).get('a')).toEqual(card(500, 300));
  });

  it('團隊依順序成塊，沒有團隊的依專案、資料夾，已結束的最後', () => {
    const data = input(
      {
        z: card(0, 0),
        lead: card(STEP_X * 7, STEP_Y * 3),
        w: card(STEP_X * 2, STEP_Y * 5),
        p1: card(STEP_X, 0),
        d1: card(STEP_X * 4, STEP_Y),
        old: card(STEP_X * 3, STEP_Y * 2),
      },
      [member('t', 'lead', 'lead'), member('t', 'w', 'worker')],
      [
        session('z', { name: 'z' }),
        session('lead'),
        session('w'),
        session('p1', { projectId: 'proj' }),
        session('d1', { cwd: '/elsewhere' }),
        session('old', { ended: true }),
      ],
    );
    const out = arrangeCanvas(data);
    expect(overlapping(out)).toEqual([]);
    const pad = 32;
    // 團隊在最前面：隊長＋1 位在 16:10 的畫面左右排（隊長在左）
    expect(out.get('lead')).toEqual(card(pad, pad));
    expect(out.get('w')).toEqual(card(pad + STEP_X, pad));
    // 依序（由左到右、一列排完換下一列）：專案 → 資料夾（/elsewhere 在 /work 前）→ 已結束
    const order = ['lead', 'p1', 'd1', 'z', 'old'].map((id) => out.get(id)!);
    for (let i = 1; i < order.length; i += 1) {
      const [a, b] = [order[i - 1]!, order[i]!];
      const sameRow = b.y < a.y + a.h && a.y < b.y + b.h;
      expect(sameRow ? b.x > a.x : b.y >= a.y + a.h, `第 ${i} 塊`).toBe(true);
    }
  });

  it('整理畫布：隊長＋1 位的團隊照畫面比例左右排，旁邊有別的區塊也一樣；直的畫面上下排', () => {
    const rects: Record<string, Rect> = {
      lead: card(0, 0),
      w: card(STEP_X, STEP_Y),
      lead2: card(2 * STEP_X, 0),
      w2: card(3 * STEP_X, STEP_Y),
    };
    for (let i = 0; i < 4; i += 1) rects[`x${i}`] = card(i * STEP_X, 3 * STEP_Y);
    const data = input(rects, [
      member('t', 'lead', 'lead'),
      member('t', 'w', 'worker'),
      member('u', 'lead2', 'lead'),
      member('u', 'w2', 'worker'),
    ]);
    for (const view of [DEFAULT_VIEW, { w: 1208, h: 808 }]) {
      const out = arrangeCanvas({ ...data, view });
      expect(overlapping(out)).toEqual([]);
      for (const [l, m] of [
        ['lead', 'w'],
        ['lead2', 'w2'],
      ] as const) {
        expect(out.get(m)!.y).toBe(out.get(l)!.y);
        expect(out.get(m)!.x).toBe(out.get(l)!.x + STEP_X);
      }
    }
    const phone = arrangeCanvas({ ...data, view: { w: 390, h: 760 } });
    expect(phone.get('w')!.x).toBe(phone.get('lead')!.x);
    expect(phone.get('w')!.y).toBe(phone.get('lead')!.y + TEAM_STEP_Y);
  });

  it('同專案的卡排在一起，每列最多 3 張、依名稱', () => {
    const rects: Record<string, Rect> = {};
    const sessions: ArrangeSession[] = [];
    for (const name of ['e', 'd', 'c', 'b', 'a']) {
      rects[name] = card(sessions.length * STEP_X * 2, 0);
      sessions.push(session(name, { projectId: 'p' }));
    }
    const out = arrangeCanvas(input(rects, [], sessions));
    expect(out.get('a')).toEqual(card(0, 0));
    expect(out.get('b')).toEqual(card(STEP_X, 0));
    expect(out.get('c')).toEqual(card(2 * STEP_X, 0));
    // 第二列只有兩張：置中
    expect(out.get('d')).toEqual(card(STEP_X / 2, STEP_Y));
    expect(out.get('e')).toEqual(card(STEP_X / 2 + STEP_X, STEP_Y));
  });

  it('依畫面比例換列：一排卡片在 16:10 的畫面排成接近 16:10，直式手機排成直的（GM 2026-11-09）', () => {
    const rects: Record<string, Rect> = {};
    const sessions: ArrangeSession[] = [];
    for (let i = 0; i < 10; i += 1) {
      rects[`s${i}`] = card(i * STEP_X, 0);
      sessions.push(session(`s${i}`, { cwd: `/p${i}` }));
    }
    const aspect = (out: ReadonlyMap<string, Rect>) => {
      const b = boundsOf([...out.values()]);
      return b.w / b.h;
    };
    const wide = arrangeCanvas({ ...input(rects, [], sessions), view: DEFAULT_VIEW });
    expect(overlapping(wide)).toEqual([]);
    expect(aspect(wide)).toBeGreaterThan(1.2);
    expect(aspect(wide)).toBeLessThan(2.2);
    const phone = arrangeCanvas({ ...input(rects, [], sessions), view: { w: 390, h: 844 } });
    expect(aspect(phone)).toBeLessThan(1);
    // 指定列寬（測試用）時照列寬換列。
    const fixed = arrangeCanvas(input(rects, [], sessions), 3 * STEP_X);
    for (const r of fixed.values()) expect(r.x + r.w).toBeLessThanOrEqual(3 * STEP_X);
  });

  it('團隊框之間（與後面沒有團隊的卡）至少隔 TEAM_BLOCK_GAP（P2 §4.2）', () => {
    // 兩點之間的空隙：重疊或相鄰回 0 以下。
    const gap = (a: Rect, b: Rect) =>
      Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
    expect(TEAM_BLOCK_GAP).toBeGreaterThan(GAP_X);
    for (let seed = 1; seed <= 200; seed += 1) {
      const data = randomCanvas(seed);
      const out = arrangeCanvas(data);
      const cluster = clusterOf(data);
      const drawn = frames(data, out);
      const inTeam = new Set(data.members.map((m) => m.sessionId));
      for (const a of drawn) {
        for (const b of drawn) {
          if (cluster.get(a.team.id)!.has(b.team.id)) continue;
          expect(
            gap(a.rect, b.rect),
            `seed ${seed} ${a.team.id}/${b.team.id}`,
          ).toBeGreaterThanOrEqual(TEAM_BLOCK_GAP);
        }
        for (const [id, r] of out) {
          if (inTeam.has(id)) continue;
          expect(gap(a.rect, r), `seed ${seed} ${id}/${a.team.id}`).toBeGreaterThanOrEqual(
            TEAM_BLOCK_GAP,
          );
        }
      }
    }
  });

  it('團隊框右邊預留進度卡的寬與高（P3 §1.5；GM 2026-11-09 整理不要壓到進度卡）：卡片不壓到右邊、下一列的東西', () => {
    expect(PROGRESS_RESERVE).toBe(PROGRESS_CARD_W + PROGRESS_GAP);
    // 卡片比團隊框高很多時（400）也不能壓到下一列。
    const H = 400;
    for (let seed = 1; seed <= 200; seed += 1) {
      const data = { ...randomCanvas(seed), progressH: H };
      const out = arrangeCanvas(data);
      const cluster = clusterOf(data);
      const drawn = frames(data, out);
      const inTeam = new Set(data.members.map((m) => m.sessionId));
      // 進度卡的位置：框的右上角外側 PROGRESS_GAP、寬 PROGRESS_CARD_W、高 H（和 progress/CanvasProgress.tsx 一致）。
      for (const a of drawn) {
        const card = {
          x: a.rect.x + a.rect.w + PROGRESS_GAP,
          y: a.rect.y,
          w: PROGRESS_CARD_W,
          h: H,
        };
        const others: Rect[] = [
          ...drawn.filter((b) => !cluster.get(a.team.id)!.has(b.team.id)).map((b) => b.rect),
          ...[...out].filter(([id]) => !inTeam.has(id)).map(([, r]) => r),
        ];
        for (const r of others) {
          const overlap =
            card.x < r.x + r.w &&
            r.x < card.x + card.w &&
            card.y < r.y + r.h &&
            r.y < card.y + card.h;
          expect(overlap, `seed ${seed} ${a.team.id}`).toBe(false);
        }
      }
    }
  });

  it('寫過進度卡的單獨 session 自己一塊、右邊預留 PROGRESS_RESERVE：卡片（預設高度）不壓到別的卡', () => {
    const rects: Record<string, Rect> = {};
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id, i) => (rects[id] = card(i * STEP_X, 0)));
    const sessions = ids.map((id) => session(id, { progress: id === 'a' || id === 'c' }));
    const out = arrangeCanvas(input(rects, [], sessions));
    expect(overlapping(out)).toEqual([]);
    for (const id of ['a', 'c']) {
      const r = out.get(id)!;
      const note = {
        x: r.x + r.w + PROGRESS_GAP,
        y: r.y,
        w: PROGRESS_CARD_W,
        h: PROGRESS_DEFAULT_H,
      };
      for (const [other, o] of out) {
        if (other === id) continue;
        expect(overlaps(note, o), `${id} 的進度卡壓到 ${other}`).toBe(false);
      }
    }
    // 沒寫過卡的仍是同一塊（同一列，相鄰間距 GAP_X）。
    const rest = ['b', 'd', 'e'].map((id) => out.get(id)!);
    expect(rest[1]!.x - rest[0]!.x).toBe(STEP_X);
    expect(rest[0]!.y).toBe(rest[1]!.y);
  });

  it('只有一列、卡片比區塊高：下一列從卡片底下開始（GM 2026-11-09）', () => {
    const rects: Record<string, Rect> = {};
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    ids.forEach((id, i) => (rects[id] = card(i * STEP_X, 0)));
    const sessions = ids.map((id) => session(id, { progress: id === 'a' }));
    // 列寬小到每塊各自一列，才看得出「下一列」的位置。
    const out = arrangeCanvas({ ...input(rects, [], sessions), progressH: 900 }, 1);
    const a = out.get('a')!;
    const note = { x: a.x + a.w + PROGRESS_GAP, y: a.y, w: PROGRESS_CARD_W, h: 900 };
    for (const [id, r] of out) {
      if (id === 'a') continue;
      expect(overlaps(note, r), `a 的進度卡壓到 ${id}`).toBe(false);
    }
  });

  it('整理團隊：進度卡的位置也算禁區，原本在那裡的卡被移走（GM 2026-11-09）', () => {
    const rects: Record<string, Rect> = {
      a: card(0, 0),
      b: card(STEP_X, 0),
      // x 剛好落在團隊框右邊、進度卡會畫的地方（框右緣＋PROGRESS_GAP 之後）。
      z: card(2 * STEP_X - GAP_X + TEAM_PADDING + PROGRESS_GAP + 20, 40),
    };
    const members = [member('t', 'a', 'lead'), member('t', 'b', 'worker')];
    const data = input(rects, members);
    const out = arrangeTeam('t', data);
    const frame = frames({ ...data, rects: out }, out).find((f) => f.team.id === 't')!.rect;
    const note = {
      x: frame.x + frame.w + PROGRESS_GAP,
      y: frame.y,
      w: PROGRESS_CARD_W,
      h: PROGRESS_DEFAULT_H,
    };
    expect(overlaps(note, out.get('z')!)).toBe(false);
  });

  it('整理後全部顯示：手機與桌面寬度下，團隊之間在畫面上至少 TEAM_GAP_SCREEN（36px，GM 2026-11-09 從 48 放寬；P2 §4.2）', () => {
    expect(TEAM_GAP_SCREEN).toBe(36);
    expect(TEAM_BLOCK_GAP * TIDY_FIT_MIN_ZOOM).toBeGreaterThanOrEqual(TEAM_GAP_SCREEN);
    const gap = (a: Rect, b: Rect) =>
      Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
    const views = [
      { w: 390, h: 844 },
      { w: 1440, h: 900 },
      { w: 2560, h: 1440 },
    ];
    let checked = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const data = randomCanvas(seed);
      const out = arrangeCanvas(data);
      const cluster = clusterOf(data);
      const drawn = frames(data, out);
      if (drawn.length === 0) continue;
      // 整理後的全部範圍（含團隊框）。
      const all = [...out.values(), ...drawn.map((d) => d.rect)];
      const x = Math.min(...all.map((r) => r.x));
      const y = Math.min(...all.map((r) => r.y));
      const bounds = {
        w: Math.max(...all.map((r) => r.x + r.w)) - x,
        h: Math.max(...all.map((r) => r.y + r.h)) - y,
      };
      const inTeam = new Set(data.members.map((m) => m.sessionId));
      let min = Infinity;
      for (const a of drawn) {
        for (const b of drawn) {
          if (!cluster.get(a.team.id)!.has(b.team.id)) min = Math.min(min, gap(a.rect, b.rect));
        }
        for (const [id, r] of out) if (!inTeam.has(id)) min = Math.min(min, gap(a.rect, r));
      }
      if (min === Infinity) continue;
      for (const view of views) {
        const zoom = tidyFitZoom(bounds, view.w, view.h, { padding: 0.06, maxZoom: 0.3 });
        expect(zoom).toBeGreaterThanOrEqual(TIDY_FIT_MIN_ZOOM);
        expect(min * zoom, `seed ${seed} ${view.w}px`).toBeGreaterThanOrEqual(TEAM_GAP_SCREEN);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
    // 手機寬度放不下全部時不會再縮小（交給捲動），桌面放得下時照常剛好放進畫面。
    expect(tidyFitZoom({ w: 5200, h: 3000 }, 390, 844)).toBe(TIDY_FIT_MIN_ZOOM);
    expect(tidyFitZoom({ w: 1000, h: 500 }, 1440, 900, { maxZoom: 0.3 })).toBe(0.3);
    expect(tidyFitZoom({ w: 5200, h: 2000 }, 1440, 900)).toBeCloseTo(1440 / 5200, 5);
  });

  it('隨機畫布：卡不重疊、不同群的團隊框不重疊、框裡沒有別群的卡', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const data = randomCanvas(seed);
      const out = arrangeCanvas(data);
      expect(overlapping(out), `seed ${seed}`).toEqual([]);
      expect([...out.keys()].sort()).toEqual([...data.rects.keys()].sort());
      const cluster = clusterOf(data);
      const drawn = frames(data, out);
      for (const a of drawn) {
        for (const b of drawn) {
          if (cluster.get(a.team.id)!.has(b.team.id)) continue;
          expect(overlaps(a.rect, b.rect), `seed ${seed} ${a.team.id}/${b.team.id}`).toBe(false);
        }
        const inCluster = new Set(
          data.members.filter((m) => cluster.get(a.team.id)!.has(m.teamId)).map((m) => m.sessionId),
        );
        for (const [id, r] of out) {
          if (!inCluster.has(id)) {
            expect(overlaps(r, a.rect), `seed ${seed} ${id} in ${a.team.id}`).toBe(false);
          }
        }
      }
      // 同團隊（不共用成員時）的卡相鄰：每位成員到最近的隊友不超過一格
      for (const { id } of data.teams) {
        const ids = data.members.filter((m) => m.teamId === id).map((m) => m.sessionId);
        if (ids.length < 2 || cluster.get(id)!.size > 1) continue;
        for (const a of ids) {
          const ra = out.get(a)!;
          const nearest = Math.min(
            ...ids
              .filter((b) => b !== a)
              .map((b) => Math.hypot(out.get(b)!.x - ra.x, out.get(b)!.y - ra.y)),
          );
          expect(nearest, `seed ${seed} ${a}`).toBeLessThanOrEqual(Math.hypot(STEP_X, STEP_Y));
        }
      }
      expect(arrangeCanvas(data)).toEqual(out);
    }
  });
});

describe('restoreLayout：回到上一次擺設', () => {
  it('回到快照的位置，並把目前的擺設變成新的快照；再按一次換回來', () => {
    const current = new Map([
      ['a', card(0, 0)],
      ['b', card(STEP_X, 0)],
    ]);
    const snapshot = new Map([
      ['a', card(5 * STEP_X, 5 * STEP_Y)],
      ['b', card(7 * STEP_X, 2 * STEP_Y)],
    ]);
    const first = restoreLayout(current, snapshot);
    expect(first.rects).toEqual(snapshot);
    expect(first.snapshot).toEqual(current);
    const second = restoreLayout(first.rects, first.snapshot);
    expect(second.rects).toEqual(current);
    expect(second.snapshot).toEqual(snapshot);
  });

  it('快照之後才出現的卡留在原地；會壓到就搬到空位；已經不在的忽略', () => {
    const current = new Map([
      ['a', card(0, 0)],
      ['fresh', card(9 * STEP_X, 0)],
      ['clash', card(3 * STEP_X, 3 * STEP_Y)],
    ]);
    const snapshot = new Map([
      ['a', card(3 * STEP_X + 20, 3 * STEP_Y + 20)],
      ['gone', card(0, 0)],
    ]);
    const { rects, snapshot: next } = restoreLayout(current, snapshot);
    expect([...rects.keys()]).toEqual(['a', 'fresh', 'clash']);
    expect(rects.get('a')).toEqual(snapshot.get('a'));
    expect(rects.get('fresh')).toEqual(card(9 * STEP_X, 0));
    expect(rects.get('clash')).not.toEqual(card(3 * STEP_X, 3 * STEP_Y));
    expect(overlapping(rects)).toEqual([]);
    expect(next.has('gone')).toBe(false);
    expect(next).toEqual(current);
  });

  it('整理後回到上一次擺設＝整理前', () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const data = randomCanvas(seed);
      const tidied = arrangeCanvas(data);
      const { rects, snapshot } = restoreLayout(tidied, data.rects);
      expect(rects).toEqual(data.rects);
      expect(snapshot).toEqual(tidied);
    }
  });
});

it('nextFreeSlot 照舊（整理沒有改到新卡的放法）', () => {
  expect(nextFreeSlot([])).toEqual(card(0, 0));
});

describe('layoutRows：目前位置與上一次擺設一起存', () => {
  it('兩個 workspace 各自一組；沒有快照就只有目前位置', () => {
    const now = new Map([['a', card(0, 0)]]);
    const prev = new Map([['a', card(STEP_X, 0)]]);
    expect(layoutRows(now, null)).toEqual([
      { workspace: WORKSPACE, sessionId: 'a', ...card(0, 0) },
    ]);
    expect(layoutRows(now, prev)).toEqual([
      { workspace: WORKSPACE, sessionId: 'a', ...card(0, 0) },
      { workspace: PREVIOUS_WORKSPACE, sessionId: 'a', ...card(STEP_X, 0) },
    ]);
    expect(PREVIOUS_WORKSPACE).toBe('default.previous');
  });
});
