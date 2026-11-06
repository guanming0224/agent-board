// 畫布上 session 之間的往來：關係線（派工、交接規則、隊長 → 成員）、最近的往來紀錄、每一對的次數、篩選。
// 純函式，不碰 React，方便單元測試；資料來自 handoffActivityState 的 parseHandoffEvent。
import type { TeamMember } from '@agent-board/protocol';
import { activityKey, type Channel, type HandoffKind, type Parsed } from './handoffActivityState';
import type { Handoff } from './teams';

// ── 往來紀錄 ───────────────────────────────────────────

/** 一則往來。排入後送達是同一則（state 從 queued 升成 delivered），不重複算次數。 */
export interface Interaction {
  id: number;
  from: string;
  to: string;
  channel: Channel;
  what: string;
  state: 'queued' | 'delivered' | 'blocked' | 'dropped' | 'verdict';
  summary: string | null;
  reason: string | null;
  ref: string | null;
  /** 第一次收到的時間（ms）。 */
  at: number;
  /** 最後一次更新的時間（ms）：送達、擋下時更新。 */
  updatedAt: number;
}

/** key 是有方向的一對 `${from}->${to}`。每一對最新的在最後面。 */
export type HistoryMap = ReadonlyMap<string, readonly Interaction[]>;

/** 次數徽章與「最近往來」的暫時線：最近 10 分鐘。 */
export const COUNT_MS = 10 * 60_000;
/** 點線看紀錄：留一小時、每一對最多 20 則。 */
export const KEEP_MS = 60 * 60_000;
export const KEEP_PER_PAIR = 20;
/** 點線的小視窗列幾則。 */
export const POPOVER_ROWS = 8;
/** 排入後多久內的送達算同一則。 */
const MATCH_MS = 30 * 60_000;

const STATE_OF: Record<HandoffKind, Interaction['state']> = {
  fired: 'queued',
  delivered: 'delivered',
  blocked: 'blocked',
  dropped: 'dropped',
  verdict: 'verdict',
};

let nextId = 1;

/**
 * 記一筆。送達、擋下、取消會先找同一對、同一類、同一個 ref 還在排入的那則，升級它；
 * 找不到才新增一則。
 */
export function recordInteraction(map: HistoryMap, parsed: Parsed, now: number): HistoryMap {
  const state = STATE_OF[parsed.kind];
  const list = map.get(parsed.key) ?? [];
  const next = new Map(map);
  if (state === 'delivered' || state === 'blocked' || state === 'dropped') {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i]!;
      if (item.state !== 'queued' || item.channel !== parsed.channel) continue;
      if (now - item.at > MATCH_MS) break;
      // 送達：ref 一樣，或其中一邊沒有 ref（舊版 hub）就算同一則。
      // 擋下、取消：ref 要一樣；派工「送出前就擋下」沒有 workId，是另一則，不能蓋掉排入中的那則。
      const loose = state === 'delivered' && (item.ref === null || parsed.ref === null);
      if (!loose && item.ref !== parsed.ref) continue;
      const updated: Interaction = {
        ...item,
        state,
        summary: parsed.summary ?? item.summary,
        reason: parsed.reason,
        updatedAt: now,
      };
      next.set(parsed.key, [...list.slice(0, i), updated, ...list.slice(i + 1)]);
      return next;
    }
  }
  const item: Interaction = {
    id: nextId++,
    from: parsed.from,
    to: parsed.to,
    channel: parsed.channel,
    what: parsed.what,
    state,
    summary: parsed.summary,
    reason: parsed.reason,
    ref: parsed.ref,
    at: now,
    updatedAt: now,
  };
  next.set(parsed.key, [...list, item].slice(-KEEP_PER_PAIR));
  return next;
}

/** 清掉超過一小時的；沒有變化就回傳同一個物件。 */
export function pruneHistory(map: HistoryMap, now: number): HistoryMap {
  let next: Map<string, readonly Interaction[]> | null = null;
  for (const [key, list] of map) {
    const kept = list.filter((i) => now - i.updatedAt < KEEP_MS);
    if (kept.length === list.length) continue;
    next ??= new Map(map);
    if (kept.length === 0) next.delete(key);
    else next.set(key, kept);
  }
  return next ?? map;
}

/** 下一次次數會變（有一則滿 10 分鐘）或要清掉的時間；沒有就是 null。 */
export function nextHistoryChangeAt(map: HistoryMap, now: number): number | null {
  let soonest: number | null = null;
  for (const list of map.values()) {
    for (const i of list) {
      for (const at of [i.updatedAt + COUNT_MS, i.updatedAt + KEEP_MS]) {
        if (at > now && (soonest === null || at < soonest)) soonest = at;
      }
    }
  }
  return soonest;
}

/** 這一對（有方向）最近 10 分鐘有幾則，只算開著的類別。 */
export function pairCount(
  map: HistoryMap,
  key: string,
  channels: ReadonlySet<Channel>,
  now: number,
): number {
  return (map.get(key) ?? []).filter((i) => channels.has(i.channel) && now - i.updatedAt < COUNT_MS)
    .length;
}

/** 兩個 session 之間（兩個方向）最近的幾則，新的在前面。 */
export function pairHistory(
  map: HistoryMap,
  a: string,
  b: string,
  channels: ReadonlySet<Channel>,
  rows = POPOVER_ROWS,
): Interaction[] {
  return [...(map.get(activityKey(a, b)) ?? []), ...(map.get(activityKey(b, a)) ?? [])]
    .filter((i) => channels.has(i.channel))
    .sort((x, y) => y.updatedAt - x.updatedAt || y.id - x.id)
    .slice(0, rows);
}

// ── 篩選 ───────────────────────────────────────────────

/** 畫布上的四個開關：三類往來＋關係線（派工、隊長 → 成員）。交接關掉時連交接規則線一起藏。 */
export interface LinkFilters {
  handoff: boolean;
  dispatch: boolean;
  task: boolean;
  relations: boolean;
}

export const FILTER_KEYS: readonly (keyof LinkFilters)[] = [
  'handoff',
  'dispatch',
  'task',
  'relations',
];
export const DEFAULT_FILTERS: LinkFilters = {
  handoff: true,
  dispatch: true,
  task: true,
  relations: true,
};

/** 存在這台瀏覽器的字串 → 開關；壞掉或沒有就全開。 */
export function parseFilters(raw: string | null): LinkFilters {
  if (!raw) return DEFAULT_FILTERS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return DEFAULT_FILTERS;
    const record = value as Record<string, unknown>;
    const out = { ...DEFAULT_FILTERS };
    for (const key of FILTER_KEYS) {
      if (typeof record[key] === 'boolean') out[key] = record[key];
    }
    return out;
  } catch {
    return DEFAULT_FILTERS;
  }
}

export const enabledChannels = (filters: LinkFilters): ReadonlySet<Channel> =>
  new Set((['handoff', 'dispatch', 'task'] as const).filter((c) => filters[c]));

// ── 線 ─────────────────────────────────────────────────

export type LinkKind = 'handoff' | 'dispatch' | 'team' | 'traffic';

/** 畫布上的一條線。traffic 是沒有關係線的兩張卡之間、最近有往來時暫時畫的。 */
export interface Link {
  id: string;
  kind: LinkKind;
  source: string;
  target: string;
  /** 同方向好幾條線時，垂直錯開的距離（px，畫布座標）。 */
  offset: number;
  /** 交接規則線才有。 */
  handoff?: Handoff;
  /**
   * 兩個方向都有線時，兩條線的中點幾乎在同一個地方（把手一左一右），標籤分在上方（-1）與下方（1）；
   * 只有一個方向是 0。
   */
  side: -1 | 0 | 1;
}

/** 同方向的線之間錯開多少。把手在卡片邊上，錯開 14px 仍在邊上。 */
export const PARALLEL_GAP = 14;
const KIND_ORDER: Record<LinkKind, number> = { handoff: 0, dispatch: 1, team: 2, traffic: 3 };

interface LinkInput {
  sessions: readonly { id: string; dispatchedBy?: string | null }[];
  handoffs: readonly Handoff[];
  members: readonly Pick<TeamMember, 'teamId' | 'sessionId' | 'role'>[];
  /** 畫布上有卡片的 session。 */
  live: ReadonlySet<string>;
  filters: LinkFilters;
  /** 最近有往來（或正在播動畫）的有方向的一對，以及那一對用到的類別。 */
  traffic: ReadonlyMap<string, { from: string; to: string; channels: ReadonlySet<Channel> }>;
}

const pairOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * 算出要畫哪些線：
 * - 交接規則（交接開著時）；
 * - 派工：呼叫者 → 成員（Session.dispatchedBy，關係線開著時）；
 * - 隊長 → 成員：只有兩人之間沒有任何交接規則或派工線時才畫，免得同一對有兩三條線；
 * - 最近有往來、但同方向沒有任何線的一對：暫時畫一條（那一類開著時）。
 * 同方向的線錯開；反方向的線本來就從不同的把手出發，不會疊在一起。
 */
export function buildLinks(input: LinkInput): Link[] {
  const { live, filters } = input;
  const links: Omit<Link, 'offset' | 'side'>[] = [];
  const connected = new Set<string>();
  const directed = new Set<string>();
  const add = (link: Omit<Link, 'offset' | 'side'>) => {
    if (!live.has(link.source) || !live.has(link.target) || link.source === link.target) return;
    links.push(link);
    directed.add(activityKey(link.source, link.target));
  };

  for (const h of input.handoffs) {
    connected.add(pairOf(h.source, h.target));
    if (filters.handoff)
      add({ id: h.id, kind: 'handoff', source: h.source, target: h.target, handoff: h });
  }
  for (const s of input.sessions) {
    if (!s.dispatchedBy) continue;
    connected.add(pairOf(s.dispatchedBy, s.id));
    if (filters.relations) {
      add({
        id: `dispatch:${activityKey(s.dispatchedBy, s.id)}`,
        kind: 'dispatch',
        source: s.dispatchedBy,
        target: s.id,
      });
    }
  }
  if (filters.relations) {
    const leads = input.members.filter((m) => m.role === 'lead');
    for (const lead of leads) {
      for (const m of input.members) {
        if (m.teamId !== lead.teamId || m.sessionId === lead.sessionId) continue;
        if (connected.has(pairOf(lead.sessionId, m.sessionId))) continue;
        connected.add(pairOf(lead.sessionId, m.sessionId));
        add({
          id: `team:${activityKey(lead.sessionId, m.sessionId)}`,
          kind: 'team',
          source: lead.sessionId,
          target: m.sessionId,
        });
      }
    }
  }
  for (const [key, pair] of input.traffic) {
    if (directed.has(key)) continue;
    if (![...pair.channels].some((c) => filters[c])) continue;
    add({ id: `talk:${key}`, kind: 'traffic', source: pair.from, target: pair.to });
  }

  // 同方向的線依種類排好，置中錯開。
  const groups = new Map<string, Omit<Link, 'offset' | 'side'>[]>();
  for (const link of links) {
    const key = activityKey(link.source, link.target);
    groups.set(key, [...(groups.get(key) ?? []), link]);
  }
  return [...groups.values()].flatMap((group) =>
    group
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      .map((link, i) => {
        const reverse = directed.has(activityKey(link.target, link.source));
        const side: Link['side'] = !reverse ? 0 : link.source < link.target ? -1 : 1;
        return { ...link, offset: (i - (group.length - 1) / 2) * PARALLEL_GAP, side };
      }),
  );
}

/**
 * 每一對（有方向）的往來畫在哪條線上：同方向的交接規則線優先，其次派工、隊長線，最後是暫時線。
 * 回傳 key（from->to）→ 線的 id。
 */
export function trafficHosts(links: readonly Link[]): Map<string, string> {
  const hosts = new Map<string, string>();
  const sorted = [...links].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  for (const link of sorted) {
    const key = activityKey(link.source, link.target);
    if (!hosts.has(key)) hosts.set(key, link.id);
  }
  return hosts;
}
