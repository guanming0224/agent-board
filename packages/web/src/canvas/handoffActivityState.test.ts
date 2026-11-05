import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agent-board/protocol';
import {
  ACTIVE_MS,
  advance,
  firstLine,
  isReceiving,
  nextChangeAt,
  parseHandoffEvent,
  phaseAt,
  recordHandoff,
  RECENT_MS,
  type ActivityMap,
} from './handoffActivityState';

const event = (type: string, payload: Record<string, unknown>, sessionId = 'a'): SessionEvent => ({
  id: crypto.randomUUID(),
  sessionId,
  type,
  payload,
  at: '2026-11-06T00:00:00.000Z',
});

const fired = (from = 'a', to = 'b', summary = 'Fixed the redirect.') =>
  event(
    'handoff.fired',
    { fromSessionId: from, toSessionId: to, trigger: 'on_done', summary },
    from,
  );

const empty: ActivityMap = new Map();

describe('交接事件 → 動畫狀態', () => {
  it('只認 handoff.fired／blocked／dropped，其他事件原樣回傳', () => {
    expect(parseHandoffEvent(event('status', { from: 'running', to: 'done' }))).toBeNull();
    expect(parseHandoffEvent(event('handoff.delivered', { toSessionId: 'b' }))).toBeNull();
    const map = recordHandoff(empty, event('hook', { event: 'Stop' }), 0);
    expect(map).toBe(empty);
  });

  it('成功的交接：key 和畫布線的 id 相同，帶摘要、沒有原因', () => {
    expect(parseHandoffEvent(fired())).toEqual({
      key: 'a->b',
      from: 'a',
      to: 'b',
      kind: 'fired',
      reason: null,
      summary: 'Fixed the redirect.',
    });
  });

  it('擋下與取消帶原因；舊版 hub 沒有摘要也可以', () => {
    const blocked = parseHandoffEvent(
      event('handoff.blocked', { fromSessionId: 'b', toSessionId: 'a', reason: 'loop' }, 'b'),
    );
    expect(blocked).toMatchObject({ key: 'b->a', kind: 'blocked', reason: 'loop', summary: null });
    const dropped = parseHandoffEvent(
      event('handoff.dropped', { toSessionId: 'b', reason: 'rule_disabled' }),
    );
    // 沒有 fromSessionId 時用事件所屬的 session（hub 把交接事件記在來源）。
    expect(dropped).toMatchObject({ key: 'a->b', kind: 'dropped', reason: 'rule_disabled' });
  });

  it('缺目標或自己交給自己不算', () => {
    expect(parseHandoffEvent(event('handoff.fired', { fromSessionId: 'a' }))).toBeNull();
    expect(parseHandoffEvent(fired('a', 'a'))).toBeNull();
  });

  it('階段：播放 → 一分鐘內說過話 → 消失；擋下的播放比較短', () => {
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, ACTIVE_MS.fired - 1)).toBe('active');
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, ACTIVE_MS.fired)).toBe('recent');
    expect(phaseAt({ kind: 'blocked', receivedAt: 0 }, ACTIVE_MS.blocked)).toBe('recent');
    expect(ACTIVE_MS.blocked).toBeLessThan(ACTIVE_MS.fired);
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, RECENT_MS)).toBeNull();
  });

  it('advance 推進階段、清掉過期；沒變化時回傳同一個物件', () => {
    const map = recordHandoff(empty, fired(), 1000);
    expect(map.get('a->b')).toMatchObject({ phase: 'active', seq: 1, receivedAt: 1000 });
    expect(advance(map, 1001)).toBe(map);
    const recent = advance(map, 1000 + ACTIVE_MS.fired);
    expect(recent.get('a->b')?.phase).toBe('recent');
    expect(advance(recent, 1000 + RECENT_MS).size).toBe(0);
  });

  it('同一條線再觸發：重新播放、seq 加一；最新的結果蓋掉舊的', () => {
    let map = recordHandoff(empty, fired(), 0);
    map = advance(map, ACTIVE_MS.fired + 10);
    map = recordHandoff(
      map,
      event('handoff.blocked', { fromSessionId: 'a', toSessionId: 'b', reason: 'rate_limit' }),
      ACTIVE_MS.fired + 10,
    );
    expect(map.get('a->b')).toMatchObject({ kind: 'blocked', phase: 'active', seq: 2 });
  });

  it('nextChangeAt 只給下一個換階段的時間（store 只排一個計時器）', () => {
    expect(nextChangeAt(empty)).toBeNull();
    let map = recordHandoff(empty, fired(), 0);
    map = recordHandoff(
      map,
      event('handoff.blocked', { fromSessionId: 'c', toSessionId: 'd', reason: 'loop' }, 'c'),
      100,
    );
    expect(nextChangeAt(map)).toBe(100 + ACTIVE_MS.blocked);
    expect(nextChangeAt(advance(map, ACTIVE_MS.fired + 1))).toBe(RECENT_MS);
  });

  it('收到交接的光圈：只有正在播放的成功交接，而且只在目標', () => {
    const map = recordHandoff(empty, fired('a', 'b'), 0);
    expect(isReceiving(map, 'b')).toBe(true);
    expect(isReceiving(map, 'a')).toBe(false);
    expect(isReceiving(advance(map, ACTIVE_MS.fired), 'b')).toBe(false);
    const blocked = recordHandoff(
      empty,
      event('handoff.blocked', { fromSessionId: 'a', toSessionId: 'b', reason: 'loop' }),
      0,
    );
    expect(isReceiving(blocked, 'b')).toBe(false);
  });

  it('摘要只取第一行、太長截斷', () => {
    expect(firstLine(null)).toBeNull();
    expect(firstLine('\n  first line \nsecond')).toBe('first line');
    expect(firstLine('x'.repeat(10), 4)).toBe('xxxx…');
  });
});
