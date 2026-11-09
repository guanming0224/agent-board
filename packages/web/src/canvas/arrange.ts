// 一鍵整理（GM 2026-11-06）：「整理團隊」把一個團隊排成緊湊的一塊，「整理畫布」依團隊、專案重排全部卡片。
// 純函式、不碰 DOM，同樣的輸入一定得到同樣的結果。
//
// 規則：
// - 團隊內：隊長在上面一列，其餘成員依分工排在下面：實驗／開發（EX、worker）→ 寫作（WR）
//   → 文獻（LR、researcher）→ 審查（RV、reviewer），同分工依名稱。每列置中，隊長在成員正上方，交接線由上往下讀。
//   同分工裡有交接線串起來的（A → B → C）照交接順序由左到右排，線只跨過相鄰卡之間的空隙。
//   團隊裡列與列之間留 TEAM_ROW_GAP（比一般的 GAP_Y 寬）：隊長 → 成員、跨列的交接線和線上的字都走這條空隙
//   （GM 2026-11-09：整理後關係線被壓住看不到；線怎麼走在 edgeRoute.ts）。
// - 欄數不固定（GM 2026-11-09「我需要你妥善利用空間」：以前每列最多 3 張，人一多就長成很高的一欄）：
//   依人數挑最接近畫面長寬比的欄數；成員（不含隊長）有 SIDE_LEAD_MIN 位以上時，隊長也可以放在左邊一欄、
//   成員排在右邊（交接線由左往右讀），哪個比較接近畫面比例就用哪個，一樣接近時維持隊長在上。
// - 整理團隊：新區塊的左上角＝原本團隊框內成員的左上角，團隊不會跳到別處。壓到新區塊（含框的留白與標籤空間）
//   的非成員卡，搬到最近、不碰到任何東西的位置。
// - 同時屬於多個團隊的成員：整理哪個團隊就跟著那個團隊排（它就是成員）；另一個團隊的框會跟著它變大，
//   再按「整理畫布」就會把兩個團隊排在一起。整理畫布時，共用成員的團隊併成一群：第一個團隊照常排，
//   後面的團隊只排還沒排過的成員、疊在下面。這一群的框一定會重疊（共用的卡同時在兩個框裡），和其他群不重疊。
// - 整理畫布：每個團隊（群）一塊，依團隊順序（hub 回傳的順序，即建立順序）；沒有團隊的依專案（沒有專案就依資料夾）
//   各一塊；已結束、沒有團隊的放最後一塊。區塊由左到右排、到列寬就換列（shelf packing），
//   區塊之間留 GAP_X 給團隊框標籤和交接線的字；團隊框之後留更寬的 TEAM_BLOCK_GAP（P2 §4.2），玻璃框之間看得出分界；
//   團隊框右邊另外預留進度卡的寬度 PROGRESS_RESERVE（P3 §1.5）。整塊的左上角＝原本所有卡片的左上角。
//   每塊的欄數和列寬一起試：挑「全部顯示」時縮放最大的組合（＝整片最接近畫面比例、留白最少，卡片在畫面上最大）。
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
  /** 沒有團隊、寫過進度卡（P3）：卡片畫在右側，整理時自己一塊並預留 PROGRESS_RESERVE。 */
  progress?: boolean;
}

export interface ArrangeInput {
  /** 畫布上每張卡目前的位置。只排這裡有的卡。 */
  rects: ReadonlyMap<string, Rect>;
  sessions: readonly ArrangeSession[];
  /** 這個順序就是整理後團隊的順序。 */
  teams: readonly { id: string }[];
  members: readonly TeamMember[];
  /** 交接規則（來源 → 目標）。同分工的成員照交接順序排；沒給就只依名稱。 */
  links?: readonly { source: string; target: string }[];
  /**
   * 畫布上收合的進度卡最高多高（畫布 px）。整理時區塊高度至少這麼高，卡片才不會壓到下一列。
   * 沒給或比 PROGRESS_DEFAULT_H 小就用 PROGRESS_DEFAULT_H。
   */
  progressH?: number;
  /**
   * 畫布可視範圍（螢幕 px）。整理時照它的長寬比排；沒給用 DEFAULT_VIEW（常見螢幕 16:10）。
   */
  view?: { w: number; h: number };
}

const cardHeight = (input: ArrangeInput) => Math.max(input.progressH ?? 0, PROGRESS_DEFAULT_H);

/** teamRows 預設每列幾張（只給單元測試與舊呼叫用；整理時欄數依畫面比例挑）。 */
export const MAX_COLS = 3;
/** 量不到畫布大小時當作的可視範圍（常見螢幕 16:10）。 */
export const DEFAULT_VIEW = { w: 1600, h: 1000 } as const;
/** 成員（不含隊長）至少幾位才考慮把隊長放在左邊一欄。人少時隊長在上就夠了。 */
export const SIDE_LEAD_MIN = 4;
/** 一塊最多幾欄（16 人的團隊在 16:10 的畫面上大約 6 欄）。 */
const MAX_BLOCK_COLS = 10;
/**
 * 整理畫布時每塊要接近的長寬比，逐一試過、挑全部顯示時縮放最大的。第一個是畫面本身的比例（呼叫時補上）。
 * 只有一塊時就是「接近畫面比例」；很多塊時每塊窄一點或寬一點，整片反而更貼近畫面。
 */
const BLOCK_ASPECTS = [0.5, 0.7, 1, 1.3, 1.6, 2, 2.6, 3.5, 5];
/** 分數裡「填滿畫面」的權重（layoutScore）。 */
const FILL_WEIGHT = 0.5;
/** 區塊之間的距離：留得下團隊框標籤和交接線的字。 */
export const BLOCK_GAP = GAP_X;
/**
 * 整理畫布時團隊框（群）後面的距離（畫布 px）。P2 §4.2 要求團隊之間至少 TEAM_GAP_SCREEN 螢幕像素：
 * 整理後移鏡頭時縮放不低於 TIDY_FIT_MIN_ZOOM（240 × 0.15 = 36；GM 2026-11-09 從 48 放寬，讓 6 隊 28 卡在 1440×900 一個畫面放得下），全部放不下就留給捲動（手機尤其如此）。
 */
export const TEAM_BLOCK_GAP = 240;
/**
 * 團隊框右側預留給進度卡的寬度（畫布 px，P3 §1.5）：卡寬 280＋和框之間 16。進度卡不是節點、不參與排列，
 * 但整理畫布時團隊框右邊多留這麼多，卡片才不會壓到右邊的團隊或卡。
 */
export const PROGRESS_CARD_W = 280;
/**
 * 進度卡和團隊框（或單獨 session 卡）之間的距離，畫布 px（GM 2026-11-09：整理畫布時不要壓到進度卡）。
 * 以前是「螢幕 16px」換算，整理後縮到 0.2 倍時會變成 80 畫布 px、超出預留，所以改成固定的畫布距離，
 * progress/CanvasProgress.tsx 畫卡片時用同一個值。
 */
export const PROGRESS_GAP = 24;
export const PROGRESS_RESERVE = PROGRESS_CARD_W + PROGRESS_GAP;
/** 量不到卡片高度時（例如卡片還沒畫出來）整理用的高度，畫布 px。收合的卡通常 150–250。 */
export const PROGRESS_DEFAULT_H = 260;
/** 一鍵整理後團隊之間至少要有的螢幕像素（P2 §4.2）。 */
export const TEAM_GAP_SCREEN = 36;
/** 整理畫布後「全部顯示」的最小縮放：TEAM_BLOCK_GAP 在畫面上至少 TEAM_GAP_SCREEN。 */
export const TIDY_FIT_MIN_ZOOM = TEAM_GAP_SCREEN / TEAM_BLOCK_GAP;

/**
 * 線上標籤的大小（螢幕 px，CanvasPage 擺標籤和這裡算列距共用）。次數徽章是畫布小標籤那一級
 * （links.css .edge-count：高 --ctl-h-xs 24、左邊距 6；一位數時整個標籤實測寬 42）。
 * 高度用實際的 24：多算的話一般列距（GAP_Y 72）在 0.5 倍時放不下，字會掉回線的正中間壓到卡片。
 */
export const EDGE_LABEL_H = 24;
export const EDGE_LABEL_BADGE_W = 42;
/** 線上的字和上下兩列卡片之間各留的螢幕 px（CanvasPage 擺標籤的 pad 也用這個）。 */
export const EDGE_LABEL_MARGIN = 6;
/** 列距多留的螢幕 px，吸收浮點誤差。 */
const EDGE_LABEL_SLACK = 2;
/**
 * 團隊裡列與列之間的距離（畫布 px）。隊長和成員分在上下兩列，關係線一定會從這條空隙走；
 * 同一列相鄰兩張卡之間的交接線，縮小時字比卡片之間的空隙寬，字也會放到這條空隙裡。
 * 整理後全部顯示最小縮到 TIDY_FIT_MIN_ZOOM（0.15）時，線上的字（EDGE_LABEL_H）加上下留白在畫面上
 * 要 24＋12＝36px，再多留 2px（擺標籤時 24 ÷ 0.2 的浮點誤差會讓「剛好放得下」變成放不下，字就掉回線中間壓到卡片）
 * → 38px → 畫布上 38 ÷ 0.2＝190。由標籤尺寸推算，改標籤大小時列距跟著變。
 * （乘 TEAM_BLOCK_GAP／TEAM_GAP_SCREEN 而不是除以 0.2，避免浮點誤差。）
 */
export const TEAM_ROW_GAP =
  ((EDGE_LABEL_H + 2 * EDGE_LABEL_MARGIN + EDGE_LABEL_SLACK) * TEAM_BLOCK_GAP) / TEAM_GAP_SCREEN;

/**
 * 整理後把 bounds 全部放進 viewW × viewH 的縮放（和 xyflow fitView 一樣：先算剛好放得下，再夾在上下限之間）。
 * padding 是每邊留白占可視寬高的比例。下限至少 TIDY_FIT_MIN_ZOOM。
 */
export function tidyFitZoom(
  bounds: Pick<Rect, 'w' | 'h'>,
  viewW: number,
  viewH: number,
  { padding = 0, minZoom = TIDY_FIT_MIN_ZOOM, maxZoom = Infinity } = {},
): number {
  const fit = Math.min(
    (viewW * (1 - 2 * padding)) / Math.max(1, bounds.w),
    (viewH * (1 - 2 * padding)) / Math.max(1, bounds.h),
  );
  const low = Math.max(minZoom, TIDY_FIT_MIN_ZOOM);
  return Math.min(Math.max(fit, low), Math.max(low, maxZoom));
}
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

/** 團隊成員的順序：隊長們、其餘成員（依分工；同分工照交接順序，再依名稱）。 */
interface TeamOrder {
  leads: string[];
  rest: string[];
}

/** skip 裡的成員不排（整理畫布時已經排在別的團隊）。 */
function teamOrder(
  teamId: string,
  input: Pick<ArrangeInput, 'rects' | 'sessions' | 'members' | 'links'>,
  skip: ReadonlySet<string> = new Set(),
): TeamOrder {
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
  // 同分工的一段一段照交接順序重排。
  const ordered = (list: TeamMember[]) => {
    const out: string[] = [];
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j < list.length && rank(list[j]!) === rank(list[i]!)) j += 1;
      out.push(
        ...chainOrder(
          list.slice(i, j).map((m) => m.sessionId),
          input.links ?? [],
        ),
      );
      i = j;
    }
    return out;
  };
  return {
    leads: ordered(mine.filter((m) => m.role === 'lead')),
    rest: ordered(mine.filter((m) => m.role !== 'lead')),
  };
}

/**
 * 團隊成員排成列（隊長在上的排法）：隊長一列（超過 cols 位就多列），其餘依分工、名稱，每列最多 cols 張。
 * skip 裡的成員不排（整理畫布時已經排在別的團隊）。
 */
export function teamRows(
  teamId: string,
  input: Pick<ArrangeInput, 'rects' | 'sessions' | 'members' | 'links'>,
  skip: ReadonlySet<string> = new Set(),
  cols = MAX_COLS,
): string[][] {
  const { leads, rest } = teamOrder(teamId, input, skip);
  return [...chunk(leads, cols), ...chunk(rest, cols)];
}

/**
 * 依交接線排順序：交出去的在前、接手的在後（拓撲排序），一條鏈接著排完再排下一條；
 * 同樣可以排的照原本的順序（名稱）。有環的話環上剩下的照原本順序接在後面。
 */
function chainOrder(ids: readonly string[], links: readonly { source: string; target: string }[]) {
  const set = new Set(ids);
  const edges = links.filter(
    (l) => set.has(l.source) && set.has(l.target) && l.source !== l.target,
  );
  if (edges.length === 0) return [...ids];
  const indeg = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const { source, target } of edges) {
    if (next.get(source)!.includes(target)) continue;
    next.get(source)!.push(target);
    indeg.set(target, indeg.get(target)! + 1);
  }
  const pos = new Map(ids.map((id, i) => [id, i]));
  const out: string[] = [];
  const done = new Set<string>();
  // 深度優先：接手的人緊接在交出去的人後面（所有前手都排好了才排）。
  const visit = (id: string) => {
    done.add(id);
    out.push(id);
    for (const t of [...next.get(id)!].sort((a, b) => pos.get(a)! - pos.get(b)!)) {
      indeg.set(t, indeg.get(t)! - 1);
      if (indeg.get(t) === 0 && !done.has(t)) visit(t);
    }
  };
  for (;;) {
    const start = ids.find((id) => !done.has(id) && indeg.get(id) === 0);
    if (start !== undefined) {
      visit(start);
      continue;
    }
    const rest = ids.find((id) => !done.has(id));
    if (rest === undefined) break;
    visit(rest);
  }
  return out;
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

/** 一列一列排，每列在區塊裡置中。rowGap：列與列之間（團隊用 TEAM_ROW_GAP）。 */
function gridBlock(
  rows: readonly string[][],
  cell: { w: number; h: number },
  rowGap = GAP_Y,
): Block {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const w = cols * cell.w + Math.max(0, cols - 1) * GAP_X;
  const h = rows.length * cell.h + Math.max(0, rows.length - 1) * rowGap;
  const cells = rows.flatMap((row, r) => {
    const rowW = row.length * cell.w + (row.length - 1) * GAP_X;
    const offset = (w - rowW) / 2;
    return row.map((id, c) => ({
      id,
      dx: offset + c * (cell.w + GAP_X),
      dy: r * (cell.h + rowGap),
    }));
  });
  return { w, h, cells };
}

/**
 * 隊長在左邊一欄（多位隊長由上往下），成員在右邊排成 rows（每列置中）。隊長欄和成員一起上下置中。
 * 隊長 → 成員的線從隊長右緣出發，走兩欄之間的空隙。
 */
function sideBlock(
  leads: readonly string[],
  rows: readonly string[][],
  cell: { w: number; h: number },
): Block {
  const grid = gridBlock(rows, cell, TEAM_ROW_GAP);
  const lead = gridBlock(
    leads.map((id) => [id]),
    cell,
    TEAM_ROW_GAP,
  );
  const h = Math.max(grid.h, lead.h);
  const left = cell.w + GAP_X;
  return {
    w: left + grid.w,
    h,
    cells: [
      ...lead.cells.map((c) => ({ ...c, dy: c.dy + (h - lead.h) / 2 })),
      ...grid.cells.map((c) => ({ ...c, dx: c.dx + left, dy: c.dy + (h - grid.h) / 2 })),
    ],
  };
}

/** 一塊在畫布上實際占的範圍：團隊有框的留白，右邊預留進度卡，卡片比區塊高時以卡片為準。 */
interface Part {
  block: Block;
  pad: number;
  reserve: boolean;
}
const extent = ({ block, pad, reserve }: Part, cardH: number) => ({
  w: block.w + 2 * pad + (reserve ? PROGRESS_RESERVE : 0),
  h: Math.max(block.h + 2 * pad, reserve ? cardH : 0),
});

/** 候選裡長寬比最接近 aspect 的（取對數比較：寬一倍和窄一倍一樣差）；一樣接近時取前面的。 */
function closest(
  candidates: readonly Block[],
  aspect: number,
  size: (b: Block) => { w: number; h: number },
): Block {
  let best = candidates[0]!;
  let bestCost = Infinity;
  for (const b of candidates) {
    const { w, h } = size(b);
    const cost = Math.abs(Math.log(w / Math.max(1, h) / aspect));
    if (cost < bestCost - 1e-9) {
      best = b;
      bestCost = cost;
    }
  }
  return best;
}

/** 一般卡片（沒有團隊）的一塊：1 欄到 n 欄都試。 */
function plainCandidates(ids: readonly string[], cell: { w: number; h: number }): Block[] {
  const most = Math.min(ids.length, MAX_BLOCK_COLS);
  return Array.from({ length: Math.max(1, most) }, (_, i) => gridBlock(chunk(ids, i + 1), cell));
}

/**
 * 團隊一塊的候選：隊長在上（成員 1 欄到 n 欄），成員夠多時再加隊長在左（成員 2 欄起）。
 * 隊長在上的排在前面：一樣接近畫面比例時維持慣例。
 */
function teamCandidates({ leads, rest }: TeamOrder, cell: { w: number; h: number }): Block[] {
  const out: Block[] = [];
  const most = Math.min(Math.max(1, leads.length, rest.length), MAX_BLOCK_COLS);
  for (let c = 1; c <= most; c += 1) {
    out.push(gridBlock([...chunk(leads, c), ...chunk(rest, c)], cell, TEAM_ROW_GAP));
  }
  if (leads.length > 0 && rest.length >= SIDE_LEAD_MIN) {
    for (let c = 2; c < Math.min(rest.length, MAX_BLOCK_COLS + 1); c += 1) {
      out.push(sideBlock(leads, chunk(rest, c), cell));
    }
  }
  return out;
}

const aspectOf = (view: { w: number; h: number } | undefined) => {
  const v = view && view.w > 0 && view.h > 0 ? view : DEFAULT_VIEW;
  return v.w / v.h;
};

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
  const order = teamOrder(teamId, input);
  const memberIds = [...order.leads, ...order.rest];
  if (memberIds.length === 0) return next;
  const memberSet = new Set(memberIds);
  const anchor = boundsOf(memberIds.map((id) => input.rects.get(id)!))!;
  // 欄數依畫面比例挑（只有一位時就是那張卡）。
  const pad = memberIds.length > 1 ? TEAM_PADDING : 0;
  const block = closest(
    teamCandidates(order, cellOf(memberIds, input.rects)),
    aspectOf(input.view),
    (b) => extent({ block: b, pad, reserve: true }, cardHeight(input)),
  );
  place(block, anchor, input.rects, next);

  const footprint = inflate({ x: anchor.x, y: anchor.y, w: block.w, h: block.h }, TEAM_CLEAR);
  // 團隊的進度卡畫在框右側（框＝成員外圍再留 TEAM_PADDING；只有一位時貼在那張卡右側），也不能被別的卡壓到。
  const card = inflate(
    {
      x: anchor.x + block.w + pad + PROGRESS_GAP,
      y: anchor.y - pad,
      w: PROGRESS_CARD_W,
      h: cardHeight(input),
    },
    MIN_GAP,
  );
  const intruders = [...next]
    .filter(([id, r]) => !memberSet.has(id) && (overlaps(r, footprint) || overlaps(r, card)))
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
    next.set(id, nearestFree(rect, [footprint, card, ...cards, ...frames]));
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

/** 排成一塊之前的一組卡：團隊（群）或一般卡片，每種排法都是一個候選 Block。 */
interface Group {
  /** 所有排法（欄數、隊長在上或在左）。 */
  options: Block[];
  /** 依目標長寬比挑一個排法（在 options 裡的位置）。 */
  pick: (aspect: number) => number;
  pad: number;
  reserve: boolean;
}

/**
 * 區塊由左到右排，到 rowW 就換列。回傳每塊的左上角（相對整片左上角）與整片範圍。
 * 有團隊框的列和下一列之間留 TEAM_BLOCK_GAP。
 */
function shelf(parts: readonly Part[], rowW: number, cardH: number) {
  const at: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let w = 0;
  // 這一列有沒有團隊框：有的話換列也留團隊的距離。
  let rowTeam = false;
  for (const part of parts) {
    const team = part.pad > 0;
    // 右邊還有進度卡（P3）：當成區塊的一部分，換列判斷與下一塊的位置都算進去。
    // 進度卡和框頂（單獨 session 是卡頂）對齊往下長：比區塊高時，這一列的高度以卡片為準。
    const size = extent(part, cardH);
    if (x > 0 && x + size.w > rowW) {
      x = 0;
      y += rowH + (rowTeam ? TEAM_BLOCK_GAP : BLOCK_GAP);
      rowH = 0;
      rowTeam = false;
    }
    at.push({ x: x + part.pad, y: y + part.pad });
    w = Math.max(w, x + size.w);
    x += size.w + (team ? TEAM_BLOCK_GAP : BLOCK_GAP);
    rowH = Math.max(rowH, size.h);
    rowTeam ||= team;
  }
  return { at, w, h: y + rowH };
}

/** 換列的寬度只有這些值會得到不同的排法：從某一塊開始連續幾塊剛好排滿一列的寬度。 */
function rowWidths(parts: readonly Part[], cardH: number): number[] {
  const sizes = parts.map((p) => ({
    w: extent(p, cardH).w,
    gap: p.pad > 0 ? TEAM_BLOCK_GAP : BLOCK_GAP,
  }));
  const out = new Set<number>();
  for (let i = 0; i < sizes.length; i += 1) {
    let w = 0;
    for (let j = i; j < sizes.length; j += 1) {
      w += (j > i ? sizes[j - 1]!.gap : 0) + sizes[j]!.w;
      out.add(w);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 排法的分數：全部顯示時的縮放（卡片在畫面上多大）× 填滿程度（整片長寬比和畫面比例差多少，1＝一樣）。
 * 只看縮放的話，高度先頂到時寬度怎麼排都一樣，會排出比畫面窄很多的一片；乘上填滿程度，同樣大時挑貼近畫面的。
 */
export function layoutScore(w: number, h: number, view: { w: number; h: number }): number {
  const zoom = Math.min(view.w / Math.max(1, w), view.h / Math.max(1, h));
  const aspect = w / Math.max(1, h) / (view.w / view.h);
  return zoom * Math.min(aspect, 1 / aspect) ** FILL_WEIGHT;
}

/**
 * 整理整張畫布。回傳每張卡的新位置。
 * maxRowW：固定列寬（測試用）；沒給就依畫面比例（input.view）挑每塊的欄數和列寬。
 */
export function arrangeCanvas(input: ArrangeInput, maxRowW?: number): Map<string, Rect> {
  const ids = [...input.rects.keys()];
  const next = new Map<string, Rect>();
  if (ids.length === 0) return next;
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const cell = cellOf(ids, input.rects);
  const cardH = cardHeight(input);
  const groups: Group[] = [];
  const teamExtent = (b: Block) => extent({ block: b, pad: TEAM_PADDING, reserve: true }, cardH);

  const used = new Set<string>();
  for (const cluster of clusters(input.teams, input.members)) {
    const orders: TeamOrder[] = [];
    for (const teamId of cluster) {
      const order = teamOrder(teamId, input, used);
      for (const id of [...order.leads, ...order.rest]) used.add(id);
      if (order.leads.length + order.rest.length > 0) orders.push(order);
    }
    if (orders.length === 0) continue;
    const candidates = orders.map((o) => teamCandidates(o, cell));
    if (candidates.length === 1) {
      const options = candidates[0]!;
      groups.push({
        options,
        pick: (aspect) => options.indexOf(closest(options, aspect, teamExtent)),
        pad: TEAM_PADDING,
        reserve: true,
      });
      continue;
    }
    // 一群裡的團隊疊在一起：每個團隊各自接近同一個目標比例。
    const options = [aspectOf(input.view), ...BLOCK_ASPECTS].map((aspect) =>
      stack(
        candidates.map((list) => closest(list, aspect, teamExtent)),
        BLOCK_GAP,
      ),
    );
    groups.push({
      options,
      pick: (aspect) => options.indexOf(closest(options, aspect, teamExtent)),
      pad: TEAM_PADDING,
      reserve: true,
    });
  }

  // 沒有團隊的：依專案，沒有專案就依資料夾；已結束的另成最後一塊。
  const byName = nameOrder(sessions);
  const rest = ids.filter((id) => !used.has(id));
  const plain = new Map<string, string[]>();
  const ended: string[] = [];
  // 寫過進度卡的單獨 session：各自一塊（在同組的格子裡，右邊的卡會被進度卡蓋住）。
  const withCard = new Map<string, string[]>();
  for (const id of rest) {
    const s = sessions.get(id);
    if (s?.ended) {
      ended.push(id);
      continue;
    }
    // 專案在前（1:），資料夾在後（2:）。
    const key = s?.projectId ? `1:${s.projectId}` : `2:${s?.cwd ?? ''}`;
    if (s?.progress) withCard.set(key, [...(withCard.get(key) ?? []), id]);
    else plain.set(key, [...(plain.get(key) ?? []), id]);
  }
  const plainGroup = (list: readonly string[]): Group => {
    const options = plainCandidates([...list].sort(byName), cell);
    return {
      options,
      pick: (aspect) => options.indexOf(closest(options, aspect, (b) => b)),
      pad: 0,
      reserve: false,
    };
  };
  // 同組的：一般的一塊在前，寫過卡的接在後面各一塊。
  for (const key of [...new Set([...plain.keys(), ...withCard.keys()])].sort(compareText)) {
    const group = plain.get(key);
    if (group) groups.push(plainGroup(group));
    for (const id of [...(withCard.get(key) ?? [])].sort(byName)) {
      groups.push({ options: [gridBlock([[id]], cell)], pick: () => 0, pad: 0, reserve: true });
    }
  }
  if (ended.length > 0) groups.push(plainGroup(ended));

  // 先讓每塊都接近同一個目標比例（畫面比例與 BLOCK_ASPECTS 各試一次），再一塊一塊換排法，
  // 每次都配上最好的列寬；挑分數最高的（score：全部顯示時卡片大、整片又貼近畫面比例）。
  const view = input.view && input.view.w > 0 && input.view.h > 0 ? input.view : DEFAULT_VIEW;
  const evaluate = (choice: readonly number[]) => {
    const parts = groups.map((g, i) => ({
      block: g.options[choice[i]!]!,
      pad: g.pad,
      reserve: g.reserve,
    }));
    let best: { parts: Part[]; at: { x: number; y: number }[]; score: number } | null = null;
    const widths = maxRowW === undefined ? rowWidths(parts, cardH) : [maxRowW];
    for (const rowW of widths) {
      const { at, w, h } = shelf(parts, rowW, cardH);
      const score = layoutScore(w, h, view);
      if (!best || score > best.score * (1 + 1e-9)) best = { parts, at, score };
    }
    return best!;
  };
  let choice: number[] = [];
  let best = null as ReturnType<typeof evaluate> | null;
  for (const target of [view.w / view.h, ...BLOCK_ASPECTS]) {
    const c = groups.map((g) => g.pick(target));
    const result = evaluate(c);
    if (!best || result.score > best.score * (1 + 1e-9)) {
      best = result;
      choice = c;
    }
  }
  for (let pass = 0; pass < 3; pass += 1) {
    let improved = false;
    groups.forEach((g, i) => {
      for (let k = 0; k < g.options.length; k += 1) {
        if (k === choice[i]) continue;
        const c = choice.with(i, k);
        const result = evaluate(c);
        if (result.score > best!.score * (1 + 1e-9)) {
          best = result;
          choice = c;
          improved = true;
        }
      }
    });
    if (!improved) break;
  }

  const origin = boundsOf([...input.rects.values()])!;
  best!.parts.forEach((part, i) => {
    const at = best!.at[i]!;
    place(part.block, { x: origin.x + at.x, y: origin.y + at.y }, input.rects, next);
  });
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
