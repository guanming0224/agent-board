import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agent-board/protocol';
import { parseHandoffEvent } from './handoffActivityState';
import {
  buildLinks,
  COUNT_MS,
  DEFAULT_FILTERS,
  enabledChannels,
  KEEP_MS,
  KEEP_PER_PAIR,
  nextHistoryChangeAt,
  pairCount,
  pairHistory,
  PARALLEL_GAP,
  parseFilters,
  pruneHistory,
  recordInteraction,
  trafficHosts,
  type HistoryMap,
  type LinkFilters,
} from './interactions';
import type { Handoff } from './teams';

const event = (
  type: string,
  payload: Record<string, unknown>,
  sessionId: string,
): SessionEvent => ({
  id: crypto.randomUUID(),
  sessionId,
  type,
  payload,
  at: '2026-11-06T00:00:00.000Z',
});
const parsed = (type: string, payload: Record<string, unknown>, sessionId: string) => {
  const p = parseHandoffEvent(event(type, payload, sessionId));
  if (!p) throw new Error(`not parsed: ${type}`);
  return p;
};
const record = (map: HistoryMap, at: number, ...args: Parameters<typeof parsed>) =>
  recordInteraction(map, parsed(...args), at);

const empty: HistoryMap = new Map();
const ALL = enabledChannels(DEFAULT_FILTERS);

describe('往來紀錄：一則排入 → 送達算一則', () => {
  it('交接：排入後送達升級同一則，次數 1', () => {
    let map = record(
      empty,
      0,
      'handoff.fired',
      { fromSessionId: 'a', toSessionId: 'b', summary: 'Go.' },
      'a',
    );
    map = record(map, 100, 'handoff.delivered', { fromSessionId: 'a', toSessionId: 'b' }, 'b');
    const list = map.get('a->b')!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: 'delivered', summary: 'Go.', at: 0, updatedAt: 100 });
    expect(pairCount(map, 'a->b', ALL, 100)).toBe(1);
  });

  it('派工：用 workId 對上；不同工作的送達不會升級別人的排入', () => {
    let map = record(
      empty,
      0,
      'dispatch.send',
      { fromSessionId: 'l', toSessionId: 'm', workId: 'w1', summary: 'one' },
      'l',
    );
    map = record(
      map,
      10,
      'dispatch.send',
      { fromSessionId: 'l', toSessionId: 'm', workId: 'w2', summary: 'two' },
      'l',
    );
    map = record(
      map,
      20,
      'dispatch.delivered',
      { fromSessionId: 'l', toSessionId: 'm', workId: 'w1' },
      'm',
    );
    const list = map.get('l->m')!;
    expect(list.map((i) => [i.ref, i.state])).toEqual([
      ['w1', 'delivered'],
      ['w2', 'queued'],
    ]);
    expect(pairCount(map, 'l->m', ALL, 20)).toBe(2);
  });

  it('擋下：有排入就升級成擋下；沒有就新增一則', () => {
    let map = record(
      empty,
      0,
      'handoff.fired',
      { fromSessionId: 'a', toSessionId: 'b', ruleId: 'r1' },
      'a',
    );
    map = record(
      map,
      5,
      'handoff.dropped',
      { fromSessionId: 'a', toSessionId: 'b', ruleId: 'r1', reason: 'rule_disabled' },
      'a',
    );
    map = record(
      map,
      9,
      'handoff.blocked',
      { fromSessionId: 'a', toSessionId: 'b', ruleId: 'r1', reason: 'loop' },
      'a',
    );
    expect(map.get('a->b')!.map((i) => [i.state, i.reason])).toEqual([
      ['dropped', 'rule_disabled'],
      ['blocked', 'loop'],
    ]);
  });

  it('派工：送出前就擋下（沒有 workId）是另一則，不蓋掉排入中的那則', () => {
    let map = record(
      empty,
      0,
      'dispatch.send',
      { fromSessionId: 'l', toSessionId: 'm', workId: 'w1' },
      'l',
    );
    map = record(
      map,
      5,
      'dispatch.blocked',
      { fromSessionId: 'l', toSessionId: 'm', reason: 'rate_limit' },
      'l',
    );
    expect(map.get('l->m')!.map((i) => i.state)).toEqual(['queued', 'blocked']);
    map = record(
      map,
      9,
      'dispatch.blocked',
      { fromSessionId: 'l', toSessionId: 'm', workId: 'w1', reason: 'target_busy' },
      'l',
    );
    expect(map.get('l->m')!.map((i) => i.state)).toEqual(['blocked', 'blocked']);
  });

  it('派工開成員（只有送達）與審查判定各算一則', () => {
    let map = record(
      empty,
      0,
      'dispatch.spawn',
      { fromSessionId: 'l', toSessionId: 'm', summary: 'Start.' },
      'm',
    );
    map = record(
      map,
      1,
      'task.reviewed',
      { fromSessionId: 'm', toSessionId: 'l', verdict: 'pass' },
      'm',
    );
    expect(map.get('l->m')![0]).toMatchObject({
      state: 'delivered',
      what: 'canvas.link.what.spawn',
    });
    expect(map.get('m->l')![0]).toMatchObject({ state: 'verdict', channel: 'task' });
  });

  it('每一對最多留 20 則', () => {
    let map = empty;
    for (let i = 0; i < KEEP_PER_PAIR + 5; i += 1) {
      map = record(
        map,
        i,
        'handoff.blocked',
        { fromSessionId: 'a', toSessionId: 'b', reason: 'loop' },
        'a',
      );
    }
    expect(map.get('a->b')).toHaveLength(KEEP_PER_PAIR);
    expect(map.get('a->b')![0]!.at).toBe(5);
  });
});

describe('次數、紀錄、過期', () => {
  const sample = () => {
    let map = record(empty, 0, 'handoff.fired', { fromSessionId: 'a', toSessionId: 'b' }, 'a');
    map = record(
      map,
      1000,
      'dispatch.send',
      { fromSessionId: 'b', toSessionId: 'a', workId: 'w' },
      'b',
    );
    map = record(
      map,
      2000,
      'task.dispatched',
      { fromSessionId: 'a', toSessionId: 'b', taskId: 't', kind: 'review' },
      'b',
    );
    return map;
  };

  it('次數只算開著的類別、最近 10 分鐘', () => {
    const map = sample();
    expect(pairCount(map, 'a->b', ALL, 2000)).toBe(2);
    expect(pairCount(map, 'a->b', new Set(['task']), 2000)).toBe(1);
    expect(pairCount(map, 'a->b', ALL, COUNT_MS + 1)).toBe(1);
    expect(pairCount(map, 'nobody->x', ALL, 0)).toBe(0);
  });

  it('點線的紀錄：兩個方向、新的在前、照篩選', () => {
    const map = sample();
    expect(pairHistory(map, 'a', 'b', ALL).map((i) => i.channel)).toEqual([
      'task',
      'dispatch',
      'handoff',
    ]);
    expect(pairHistory(map, 'b', 'a', new Set(['handoff'])).map((i) => i.from)).toEqual(['a']);
    expect(pairHistory(map, 'a', 'b', ALL, 1)).toHaveLength(1);
  });

  it('一小時後清掉；沒變化時回傳同一個物件；下一次變化的時間', () => {
    const map = sample();
    expect(pruneHistory(map, 10)).toBe(map);
    expect(pruneHistory(map, KEEP_MS + 2001).size).toBe(0);
    expect(pruneHistory(map, KEEP_MS + 1).get('a->b')).toHaveLength(1);
    expect(nextHistoryChangeAt(map, 0)).toBe(COUNT_MS);
    expect(nextHistoryChangeAt(map, COUNT_MS + 5000)).toBe(KEEP_MS);
    expect(nextHistoryChangeAt(empty, 0)).toBeNull();
  });
});

describe('篩選開關', () => {
  it('壞掉或沒有就全開；只認布林值', () => {
    expect(parseFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(parseFilters('{oops')).toEqual(DEFAULT_FILTERS);
    expect(parseFilters('[1]')).toMatchObject(DEFAULT_FILTERS);
    expect(parseFilters('{"task":false,"handoff":"no"}')).toEqual({
      ...DEFAULT_FILTERS,
      task: false,
    });
    expect([...enabledChannels({ ...DEFAULT_FILTERS, dispatch: false })]).toEqual([
      'handoff',
      'task',
    ]);
  });
});

describe('畫哪些線', () => {
  const handoff = (source: string, target: string): Handoff => ({
    id: `${source}->${target}`,
    source,
    target,
    triggers: ['on_done'],
    ruleIds: ['r'],
    enabled: true,
  });
  const live = new Set(['lead', 'w1', 'w2', 'm', 'x']);
  const members = [
    { teamId: 't', sessionId: 'lead', role: 'lead' as const },
    { teamId: 't', sessionId: 'w1', role: 'worker' as const },
    { teamId: 't', sessionId: 'w2', role: 'worker' as const },
  ];
  const base = {
    sessions: [{ id: 'm', dispatchedBy: 'lead' }, { id: 'w1' }],
    handoffs: [handoff('w1', 'lead')],
    members,
    live,
    filters: DEFAULT_FILTERS,
    traffic: new Map(),
  };
  const ids = (filters: Partial<LinkFilters> = {}, extra: Partial<typeof base> = {}) =>
    buildLinks({ ...base, ...extra, filters: { ...DEFAULT_FILTERS, ...filters } })
      .map((l) => l.id)
      .sort();

  it('交接規則、派工、隊長 → 成員（只有兩人之間沒有其他線時）', () => {
    expect(ids()).toEqual(['dispatch:lead->m', 'team:lead->w2', 'w1->lead']);
    const links = buildLinks(base);
    expect(links.find((l) => l.kind === 'team')).toMatchObject({ source: 'lead', target: 'w2' });
    expect(links.find((l) => l.kind === 'dispatch')).toMatchObject({ source: 'lead', target: 'm' });
  });

  it('關掉交接就不畫規則線；關掉關係線就不畫派工與隊長線；隊長線不因交接關掉而冒出來', () => {
    expect(ids({ handoff: false })).toEqual(['dispatch:lead->m', 'team:lead->w2']);
    expect(ids({ relations: false })).toEqual(['w1->lead']);
  });

  it('不在畫布上的 session（封存、刪除）不畫', () => {
    expect(ids({}, { live: new Set(['lead', 'w1']) })).toEqual(['w1->lead']);
  });

  it('最近有往來但沒有同方向的線：畫暫時線；那一類關掉就不畫', () => {
    const traffic = new Map([
      ['x->m', { from: 'x', to: 'm', channels: new Set(['task'] as const) }],
      ['lead->m', { from: 'lead', to: 'm', channels: new Set(['dispatch'] as const) }],
      ['m->lead', { from: 'm', to: 'lead', channels: new Set(['dispatch'] as const) }],
    ]);
    expect(ids({}, { traffic })).toEqual([
      'dispatch:lead->m',
      'talk:m->lead',
      'talk:x->m',
      'team:lead->w2',
      'w1->lead',
    ]);
    expect(ids({ task: false }, { traffic })).not.toContain('talk:x->m');
    // 派工關係線關掉時，派工的往來改畫暫時線。
    expect(ids({ relations: false }, { traffic })).toContain('talk:lead->m');
  });

  it('同方向的線錯開、置中；往來畫在同方向優先順序最高的線上', () => {
    const links = buildLinks({
      ...base,
      handoffs: [handoff('lead', 'm')],
    });
    const pair = links.filter((l) => l.source === 'lead' && l.target === 'm');
    expect(pair.map((l) => [l.kind, l.offset])).toEqual([
      ['handoff', -PARALLEL_GAP / 2],
      ['dispatch', PARALLEL_GAP / 2],
    ]);
    const hosts = trafficHosts(links);
    expect(hosts.get('lead->m')).toBe('lead->m');
    expect(hosts.get('lead->w2')).toBe('team:lead->w2');
    expect(hosts.has('m->lead')).toBe(false);
    expect(links.find((l) => l.kind === 'team')!.offset).toBe(0);
  });
});
