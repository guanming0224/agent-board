// 一鍵整理（GM 2026-11-06）：「整理團隊」把一個團隊排成緊湊的一塊，「整理畫布」依團隊、專案重排全部卡片。
// 純函式、不碰 DOM，同樣的輸入一定得到同樣的結果。
//
// 規則：
// - 團隊內：隊長一列（每列最多 3 張），其餘成員依分工排在下面：實驗／開發（EX、worker）→ 寫作（WR）
//   → 文獻（LR、researcher）→ 審查（RV、reviewer），同分工依名稱。每列置中，隊長在成員正上方，交接線由上往下讀。
// - 整理團隊：新區塊的左上角＝原本團隊框內成員的左上角，團隊不會跳到別處。壓到新區塊（含框的留白與標籤空間）
//   的非成員卡，搬到最近、不碰到任何東西的位置。
// - 同時屬於多個團隊的成員：整理哪個團隊就跟著那個團隊排（它就是成員）；另一個團隊的框會跟著它變大，
//   再按「整理畫布」就會把兩個團隊排在一起。整理畫布時，共用成員的團隊併成一群：第一個團隊照常排，
//   後面的團隊只排還沒排過的成員、疊在下面。這一群的框一定會重疊（共用的卡同時在兩個框裡），和其他群不重疊。
// - 整理畫布：每個團隊（群）一塊，依團隊順序（hub 回傳的順序，即建立順序）；沒有團隊的依專案（沒有專案就依資料夾）
//   各一塊；已結束、沒有團隊的放最後一塊。區塊由左到右排，超過最大列寬就換列（shelf packing），
//   區塊之間留 GAP_X 給團隊框標籤和交接線的字；團隊框之後留更寬的 TEAM_BLOCK_GAP（P2 §4.2），玻璃框之間看得出分界。整塊的左上角＝原本所有卡片的左上角。
import type { ResearchKind, TeamMember } from '@agent-board/protocol';
import { memberKind } from '../team/research';
import { CARD_H, CARD_W, GAP_X, GAP_Y, overlaps, type Rect } from './layout';
import { TEAM_PADDING } from './teams';

export interface ArrangeSession {
  id: string;
  name: string;
  projectId: string | null;
  cwd: string;
  /** 已結束（endedAt 有值）。沒有團隊的排在最後一塊。 */
  ended: boolean;
}

export interface ArrangeInput {
  /** 畫布上每張卡目前的位置。只排這裡有的卡。 */
  rects: ReadonlyMap<string, Rect>;
  sessions: readonly ArrangeSession[];
  /** 這個順序就是整理後團隊的順序。 */
  teams: readonly { id: string }[];
  members: readonly TeamMember[];
}

/** 每列最多幾張卡。 */
export const MAX_COLS = 3;
/** 區塊之間的距離：留得下團隊框標籤和交接線的字。 */
export const BLOCK_GAP = GAP_X;
/**
 * 整理畫布時團隊框（群）後面的距離。P2 §4.2 要求團隊之間至少 48px 螢幕像素：
 * 桌面寬度整理後全部顯示的倍率約 0.25（一列最寬 MAX_ROW_W），240 × 0.25 = 60px。
 */
export const TEAM_BLOCK_GAP = 240;
/** 整理畫布時一列區塊最寬多少（約兩個三欄的團隊並排）。 */
export const MAX_ROW_W = 5200;
/** 整理團隊時新區塊外面要淨空多少：團隊框的留白＋標籤。 */
export const TEAM_CLEAR = TEAM_PADDING + GAP_Y;
/** 被搬開的卡和其他卡至少隔多遠。 */
const MIN_GAP = 40;

const KIND_ORDER: Record<ResearchKind, number> = { ld: 0, ex: 1, wr: 2, lr: 3, rv: 4 };

const inflate = (r: Rect, d: number): Rect => ({
  x: r.x - d,
  y: r.y - d,
  w: r.w + 2 * d,
  h: r.h + 2 * d,
});

function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function nameOrder(sessions: ReadonlyMap<string, ArrangeSession>) {
  return (a: string, b: string) =>
    compareText(
      (sessions.get(a)?.name ?? '').toLocaleLowerCase('en'),
      (sessions.get(b)?.name ?? '').toLocaleLowerCase('en'),
    ) || compareText(a, b);
}

function chunk<T>(items: readonly T[], size = MAX_COLS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 格子大小：至少一張標準卡，有更大的就用最大的，排起來才不會重疊。 */
function cellOf(ids: readonly string[], rects: ReadonlyMap<string, Rect>) {
  let w = CARD_W;
  let h = CARD_H;
  for (const id of ids) {
    const r = rects.get(id);
    if (!r) continue;
    w = Math.max(w, r.w);
    h = Math.max(h, r.h);
  }
  return { w, h };
}

/**
 * 團隊成員排成列：隊長一列（超過 3 位就多列），其餘依分工、名稱。
 * skip 裡的成員不排（整理畫布時已經排在別的團隊）。
 */
export function teamRows(
  teamId: string,
  input: Pick<ArrangeInput, 'rects' | 'sessions' | 'members'>,
  skip: ReadonlySet<string> = new Set(),
): string[][] {
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const byName = nameOrder(sessions);
  const seen = new Set<string>();
  const mine = input.members.filter((m) => {
    if (m.teamId !== teamId || !input.rects.has(m.sessionId) || skip.has(m.sessionId)) return false;
    if (seen.has(m.sessionId)) return false;
    seen.add(m.sessionId);
    return true;
  });
  const rank = (m: TeamMember) => KIND_ORDER[memberKind(m)];
  mine.sort((a, b) => rank(a) - rank(b) || byName(a.sessionId, b.sessionId));
  const leads = mine.filter((m) => m.role === 'lead').map((m) => m.sessionId);
  const rest = mine.filter((m) => m.role !== 'lead').map((m) => m.sessionId);
  return [...chunk(leads), ...chunk(rest)];
}

interface Cell {
  id: string;
  dx: number;
  dy: number;
}
interface Block {
  w: number;
  h: number;
  cells: Cell[];
}

/** 一列一列排，每列在區塊裡置中。 */
function gridBlock(rows: readonly string[][], cell: { w: number; h: number }): Block {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const w = cols * cell.w + Math.max(0, cols - 1) * GAP_X;
  const h = rows.length * cell.h + Math.max(0, rows.length - 1) * GAP_Y;
  const cells = rows.flatMap((row, r) => {
    const rowW = row.length * cell.w + (row.length - 1) * GAP_X;
    const offset = (w - rowW) / 2;
    return row.map((id, c) => ({
      id,
      dx: offset + c * (cell.w + GAP_X),
      dy: r * (cell.h + GAP_Y),
    }));
  });
  return { w, h, cells };
}

/** 幾塊由上往下疊，水平置中。 */
function stack(parts: readonly Block[], gap: number): Block {
  const w = Math.max(0, ...parts.map((p) => p.w));
  let y = 0;
  const cells: Cell[] = [];
  for (const part of parts) {
    const offset = (w - part.w) / 2;
    for (const c of part.cells) cells.push({ id: c.id, dx: c.dx + offset, dy: c.dy + y });
    y += part.h + gap;
  }
  return { w, h: Math.max(0, y - gap), cells };
}

function place(
  block: Block,
  at: { x: number; y: number },
  rects: ReadonlyMap<string, Rect>,
  into: Map<string, Rect>,
) {
  for (const c of block.cells) {
    const old = rects.get(c.id);
    into.set(c.id, {
      x: at.x + c.dx,
      y: at.y + c.dy,
      w: old?.w ?? CARD_W,
      h: old?.h ?? CARD_H,
    });
  }
}

/**
 * 離 rect 最近、不碰到任何障礙的位置。在半格的格點上找（左右半張卡寬＋間距、上下半張卡高＋間距），
 * 依距離由近到遠；範圍不夠就加倍，所以一定找得到。
 */
function nearestFree(rect: Rect, obstacles: readonly Rect[]): Rect {
  const sx = (CARD_W + GAP_X) / 2;
  const sy = (CARD_H + GAP_Y) / 2;
  const at = (i: number, j: number): Rect => ({ ...rect, x: rect.x + i * sx, y: rect.y + j * sy });
  const free = (r: Rect) => !obstacles.some((o) => overlaps(r, o));
  for (let reach = 4; ; reach *= 2) {
    const candidates: { i: number; j: number; d: number }[] = [];
    for (let i = -reach; i <= reach; i += 1) {
      for (let j = -reach; j <= reach; j += 1) {
        candidates.push({ i, j, d: (i * sx) ** 2 + (j * sy) ** 2 });
      }
    }
    // 同距離時：先下、再右（j、i 由大到小），結果固定。
    candidates.sort((a, b) => a.d - b.d || b.j - a.j || b.i - a.i);
    // 只有在這個範圍內一定是最近的才採用；更遠的留給下一輪（範圍更大）。
    const sure = (reach * Math.min(sx, sy)) ** 2;
    for (const c of candidates) {
      if (c.d > sure) break;
      const r = at(c.i, c.j);
      if (free(r)) return r;
    }
  }
}

/** 團隊框（成員外框＋留白）；成員不足兩位不畫框，回 null。和 teams.ts 的 teamRect 一致。 */
function frameOf(ids: readonly string[], rects: ReadonlyMap<string, Rect>): Rect | null {
  const members = ids.flatMap((id) => rects.get(id) ?? []);
  if (members.length < 2) return null;
  return inflate(boundsOf(members)!, TEAM_PADDING);
}

function teamMemberIds(teamId: string, members: readonly TeamMember[]): string[] {
  return members.filter((m) => m.teamId === teamId).map((m) => m.sessionId);
}

/**
 * 整理一個團隊。回傳整張畫布的新位置（沒動的照舊）。團隊在畫布上沒有卡就原樣回傳。
 */
export function arrangeTeam(teamId: string, input: ArrangeInput): Map<string, Rect> {
  const next = new Map(input.rects);
  const rows = teamRows(teamId, input);
  const memberIds = rows.flat();
  if (memberIds.length === 0) return next;
  const memberSet = new Set(memberIds);
  const anchor = boundsOf(memberIds.map((id) => input.rects.get(id)!))!;
  const block = gridBlock(rows, cellOf(memberIds, input.rects));
  place(block, anchor, input.rects, next);

  const footprint = inflate({ x: anchor.x, y: anchor.y, w: block.w, h: block.h }, TEAM_CLEAR);
  const intruders = [...next]
    .filter(([id, r]) => !memberSet.has(id) && overlaps(r, footprint))
    .sort(([a, ra], [b, rb]) => ra.y - rb.y || ra.x - rb.x || compareText(a, b))
    .map(([id]) => id);
  const pending = new Set(intruders);

  for (const id of intruders) {
    pending.delete(id);
    const rect = next.get(id)!;
    const settled = new Map([...next].filter(([other]) => other !== id && !pending.has(other)));
    const cards = [...settled.values()].map((r) => inflate(r, MIN_GAP));
    // 不要落進別的團隊框裡（看起來像加入了那個團隊）；自己所屬的團隊框不算。
    const frames = input.teams.flatMap((team) => {
      if (team.id === teamId) return [];
      const ids = teamMemberIds(team.id, input.members);
      if (ids.includes(id)) return [];
      const frame = frameOf(ids, settled);
      return frame ? [inflate(frame, MIN_GAP)] : [];
    });
    next.set(id, nearestFree(rect, [footprint, ...cards, ...frames]));
  }
  return next;
}

/** 共用成員的團隊併成一群；群的順序依群裡第一個團隊。 */
function clusters(teams: readonly { id: string }[], members: readonly TeamMember[]): string[][] {
  const parent = new Map(teams.map((t) => [t.id, t.id]));
  const find = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const firstTeam = new Map<string, string>();
  for (const m of members) {
    if (!parent.has(m.teamId)) continue;
    const other = firstTeam.get(m.sessionId);
    if (other === undefined) firstTeam.set(m.sessionId, m.teamId);
    else {
      const [a, b] = [find(other), find(m.teamId)];
      if (a === b) continue;
      // 根留給順序在前的團隊。
      const ia = teams.findIndex((t) => t.id === a);
      const ib = teams.findIndex((t) => t.id === b);
      if (ia < ib) parent.set(b, a);
      else parent.set(a, b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const t of teams) {
    const root = find(t.id);
    groups.set(root, [...(groups.get(root) ?? []), t.id]);
  }
  return [...groups.values()];
}

/** 整理整張畫布。回傳每張卡的新位置。 */
export function arrangeCanvas(input: ArrangeInput, maxRowW = MAX_ROW_W): Map<string, Rect> {
  const ids = [...input.rects.keys()];
  const next = new Map<string, Rect>();
  if (ids.length === 0) return next;
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const cell = cellOf(ids, input.rects);
  const blocks: { block: Block; pad: number }[] = [];

  const used = new Set<string>();
  for (const group of clusters(input.teams, input.members)) {
    const parts: Block[] = [];
    for (const teamId of group) {
      const rows = teamRows(teamId, input, used);
      for (const id of rows.flat()) used.add(id);
      if (rows.length > 0) parts.push(gridBlock(rows, cell));
    }
    if (parts.length > 0) blocks.push({ block: stack(parts, BLOCK_GAP), pad: TEAM_PADDING });
  }

  // 沒有團隊的：依專案，沒有專案就依資料夾；已結束的另成最後一塊。
  const byName = nameOrder(sessions);
  const rest = ids.filter((id) => !used.has(id));
  const groups = new Map<string, string[]>();
  const ended: string[] = [];
  for (const id of rest) {
    const s = sessions.get(id);
    if (s?.ended) {
      ended.push(id);
      continue;
    }
    // 專案在前（1:），資料夾在後（2:）。
    const key = s?.projectId ? `1:${s.projectId}` : `2:${s?.cwd ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const loose = [...groups.keys()].sort(compareText).map((key) => groups.get(key)!);
  if (ended.length > 0) loose.push(ended);
  for (const group of loose) {
    blocks.push({ block: gridBlock(chunk([...group].sort(byName)), cell), pad: 0 });
  }

  // 由左到右、超過列寬換列。
  const origin = boundsOf([...input.rects.values()])!;
  let x = 0;
  let y = 0;
  let rowH = 0;
  // 這一列有沒有團隊框：有的話換列也留團隊的距離。
  let rowTeam = false;
  for (const { block, pad } of blocks) {
    const w = block.w + 2 * pad;
    const h = block.h + 2 * pad;
    const team = pad > 0;
    if (x > 0 && x + w > maxRowW) {
      x = 0;
      y += rowH + (rowTeam ? TEAM_BLOCK_GAP : BLOCK_GAP);
      rowH = 0;
      rowTeam = false;
    }
    place(block, { x: origin.x + x + pad, y: origin.y + y + pad }, input.rects, next);
    x += w + (team ? TEAM_BLOCK_GAP : BLOCK_GAP);
    rowH = Math.max(rowH, h);
    rowTeam ||= team;
  }
  return next;
}

/**
 * 回到上一次擺設：快照裡有的卡回到快照的位置；快照之後才出現的卡留在原地，
 * 會壓到回來的卡就搬到最近的空位；快照裡已經不在畫布上的忽略。
 * 回傳新位置，以及新的快照（＝目前的擺設），再按一次就換回來。
 */
export function restoreLayout(
  current: ReadonlyMap<string, Rect>,
  snapshot: ReadonlyMap<string, Rect>,
): { rects: Map<string, Rect>; snapshot: Map<string, Rect> } {
  const rects = new Map<string, Rect>();
  for (const id of current.keys()) {
    const saved = snapshot.get(id);
    if (saved) rects.set(id, { ...saved });
  }
  const newcomers = [...current]
    .filter(([id]) => !snapshot.has(id))
    .sort(([a, ra], [b, rb]) => ra.y - rb.y || ra.x - rb.x || compareText(a, b));
  for (const [id, r] of newcomers) {
    const others = [...rects.values()];
    const clash = others.some((o) => overlaps(r, o));
    rects.set(
      id,
      clash
        ? nearestFree(
            r,
            others.map((o) => inflate(o, MIN_GAP)),
          )
        : { ...r },
    );
  }
  // 依目前的順序回傳，畫布節點順序不變。
  const ordered = new Map([...current.keys()].map((id) => [id, rects.get(id)!]));
  return { rects: ordered, snapshot: new Map(current) };
}
