import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agent-board/protocol';
import { maskSecrets } from '../security/mask';
import { translate } from '../shared/i18n';
import {
  ACTIVE_MS,
  advance,
  describeTalk,
  firstLine,
  isReceiving,
  LINGER_MS,
  nextChangeAt,
  parseHandoffEvent,
  phaseAt,
  recordHandoff,
  roundLabel,
  RECENT_MS,
  type ActivityMap,
} from './handoffActivityState';
import './messages';

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
const delivered = (from = 'a', to = 'b', summary = 'Fixed the redirect.') =>
  event('handoff.delivered', { fromSessionId: from, toSessionId: to, summary }, to);
const blocked = (reason = 'loop', from = 'a', to = 'b') =>
  event('handoff.blocked', { fromSessionId: from, toSessionId: to, reason }, from);

const empty: ActivityMap = new Map();
const t = (key: string, vars?: Record<string, string | number>) => translate('zh-TW', key, vars);
const plain = (text: string) => text;

describe('交接事件 → 動畫狀態', () => {
  it('只認 handoff.fired／delivered／blocked／dropped，其他事件原樣回傳', () => {
    expect(parseHandoffEvent(event('status', { from: 'running', to: 'done' }))).toBeNull();
    const map = recordHandoff(empty, event('hook', { event: 'Stop' }), 0);
    expect(map).toBe(empty);
  });

  it('排入：key 和畫布線的 id 相同，帶摘要、沒有原因', () => {
    expect(parseHandoffEvent(fired())).toEqual({
      key: 'a->b',
      from: 'a',
      to: 'b',
      kind: 'fired',
      channel: 'handoff',
      type: 'handoff.fired',
      what: 'canvas.link.what.handoff',
      ref: null,
      reason: null,
      summary: 'Fixed the redirect.',
      round: null,
      maxRounds: null,
    });
  });

  it('送達記在目標上：來源從 payload 讀，目標一定是事件所屬的 session', () => {
    expect(parseHandoffEvent(delivered())).toMatchObject({ key: 'a->b', kind: 'delivered' });
    // payload 說送給 c，事件卻記在 b：不採用。
    expect(
      parseHandoffEvent(event('handoff.delivered', { fromSessionId: 'a', toSessionId: 'c' }, 'b')),
    ).toBeNull();
    expect(parseHandoffEvent(event('handoff.delivered', { toSessionId: 'b' }, 'b'))).toBeNull();
  });

  it('任務自動執行的送審／退回（task.delivered）也畫在同一條線；沒有來源成員的不畫', () => {
    expect(
      parseHandoffEvent(
        event('task.delivered', { kind: 'review', fromSessionId: 'a', toSessionId: 'b' }, 'b'),
      ),
    ).toMatchObject({ key: 'a->b', kind: 'delivered' });
    expect(
      parseHandoffEvent(event('task.delivered', { kind: 'start', toSessionId: 'b' }, 'b')),
    ).toBeNull();
    expect(parseHandoffEvent(event('task.dispatched', { toSessionId: 'b' }, 'b'))).toBeNull();
  });

  it('任務：排入（task.dispatched）記在收的那一邊；審查判定記在審查，畫成審查 → 負責人', () => {
    const queued = event(
      'task.dispatched',
      { kind: 'review', fromSessionId: 'a', toSessionId: 'b', taskId: 't1' },
      'b',
    );
    expect(parseHandoffEvent(queued)).toMatchObject({
      key: 'a->b',
      kind: 'fired',
      channel: 'task',
      what: 'canvas.link.what.task_review',
      ref: 't1',
    });
    // 記錯邊的不採用。
    expect(
      parseHandoffEvent(event('task.dispatched', { fromSessionId: 'a', toSessionId: 'b' }, 'a')),
    ).toBeNull();
    const pass = event(
      'task.reviewed',
      { verdict: 'pass', fromSessionId: 'rv', toSessionId: 'bd', taskId: 't1' },
      'rv',
    );
    const parsedPass = parseHandoffEvent(pass)!;
    expect(parsedPass).toMatchObject({ key: 'rv->bd', kind: 'verdict', channel: 'task' });
    // 判定沒有摘要：說明寫判定本身。
    const activity = recordHandoff(empty, pass, 0).get('rv->bd')!;
    expect(describeTalk(activity, t, plain)).toBe('審查通過');
    const reject = event(
      'task.rejected',
      { reason: 'Missing a test.', fromSessionId: 'rv', toSessionId: 'bd' },
      'rv',
    );
    expect(parseHandoffEvent(reject)).toMatchObject({
      what: 'canvas.link.what.reject',
      summary: 'Missing a test.',
    });
    // 舊版 hub 的判定沒有 toSessionId：不畫。
    expect(parseHandoffEvent(event('task.reviewed', { verdict: 'pass' }, 'rv'))).toBeNull();
  });

  it('來源一定是事件所屬的 session；payload 的 fromSessionId 不一致就不採用', () => {
    expect(
      parseHandoffEvent(event('handoff.fired', { fromSessionId: 'x', toSessionId: 'b' }, 'a')),
    ).toBeNull();
    // 沒寫 fromSessionId：用事件所屬的 session。
    expect(
      parseHandoffEvent(event('handoff.dropped', { toSessionId: 'b', reason: 'rule_disabled' })),
    ).toMatchObject({ key: 'a->b', kind: 'dropped', reason: 'rule_disabled' });
  });

  it('擋下帶原因；舊版 hub 沒有摘要也可以', () => {
    expect(parseHandoffEvent(blocked('loop', 'b', 'a'))).toMatchObject({
      key: 'b->a',
      kind: 'blocked',
      reason: 'loop',
      summary: null,
    });
  });

  it('缺目標或自己交給自己不算', () => {
    expect(parseHandoffEvent(event('handoff.fired', { fromSessionId: 'a' }))).toBeNull();
    expect(parseHandoffEvent(fired('a', 'a'))).toBeNull();
  });

  it('階段：播放 → 標籤多留幾秒 → 一分鐘內說過話（收成徽章）→ 消失；擋下的播放比較短', () => {
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, ACTIVE_MS.fired - 1)).toBe('active');
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, ACTIVE_MS.fired)).toBe('linger');
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, ACTIVE_MS.fired + LINGER_MS)).toBe('recent');
    expect(phaseAt({ kind: 'blocked', receivedAt: 0 }, ACTIVE_MS.blocked)).toBe('linger');
    expect(ACTIVE_MS.blocked).toBeLessThan(ACTIVE_MS.fired);
    expect(phaseAt({ kind: 'fired', receivedAt: 0 }, RECENT_MS)).toBeNull();
  });

  it('advance 推進階段、清掉過期；沒變化時回傳同一個物件', () => {
    const map = recordHandoff(empty, fired(), 1000);
    expect(map.get('a->b')).toMatchObject({ phase: 'active', seq: 1, receivedAt: 1000 });
    expect(advance(map, 1001)).toBe(map);
    const linger = advance(map, 1000 + ACTIVE_MS.fired);
    expect(linger.get('a->b')?.phase).toBe('linger');
    const recent = advance(linger, 1000 + ACTIVE_MS.fired + LINGER_MS);
    expect(recent.get('a->b')?.phase).toBe('recent');
    expect(advance(recent, 1000 + RECENT_MS).size).toBe(0);
  });

  it('上一波播完後再來：新的一波，seq 加一、次數重算', () => {
    let map = recordHandoff(empty, fired(), 0);
    map = advance(map, ACTIVE_MS.fired + 10);
    map = recordHandoff(map, blocked('rate_limit'), ACTIVE_MS.fired + 10);
    expect(map.get('a->b')).toMatchObject({
      kind: 'blocked',
      phase: 'active',
      seq: 2,
      counts: { fired: 0, delivered: 0, blocked: 1 },
    });
  });

  it('排入 → 送達：同一波升級，不重播流動，目標卡才亮', () => {
    let map = recordHandoff(empty, fired(), 0);
    expect(isReceiving(map, 'b')).toBe(false);
    map = recordHandoff(map, delivered(), 200);
    expect(map.get('a->b')).toMatchObject({
      kind: 'delivered',
      seq: 1,
      receivedAt: 200,
      counts: { fired: 1, delivered: 1, blocked: 0 },
    });
    expect(isReceiving(map, 'b')).toBe(true);
    expect(isReceiving(map, 'a')).toBe(false);
    expect(isReceiving(advance(map, 200 + ACTIVE_MS.delivered), 'b')).toBe(false);
    // 一則排入＋送達算一則，不加次數說明。
    expect(describeTalk(map.get('a->b')!, t, plain)).toBe('Fixed the redirect.');
  });

  it('同一對 session 好幾條規則：動畫期間後到的擋下不蓋掉送出，記次數', () => {
    let map = recordHandoff(empty, fired(), 0);
    map = recordHandoff(map, delivered(), 100);
    map = recordHandoff(map, blocked('rate_limit'), 200);
    const activity = map.get('a->b')!;
    expect(activity).toMatchObject({
      kind: 'delivered',
      summary: 'Fixed the redirect.',
      counts: { fired: 1, delivered: 1, blocked: 1 },
    });
    expect(describeTalk(activity, t, plain)).toBe('Fixed the redirect.（1 則送出、1 則擋下）');
  });

  it('先擋下、後送出：升級成送出並重播', () => {
    let map = recordHandoff(empty, blocked(), 0);
    map = recordHandoff(map, fired(), 100);
    expect(map.get('a->b')).toMatchObject({ kind: 'fired', seq: 2 });
  });

  it('擋下的不會讓目標卡亮', () => {
    expect(isReceiving(recordHandoff(empty, blocked(), 0), 'b')).toBe(false);
  });

  it('nextChangeAt 只給下一個換階段的時間（store 只排一個計時器）', () => {
    expect(nextChangeAt(empty)).toBeNull();
    let map = recordHandoff(empty, fired(), 0);
    map = recordHandoff(map, blocked('loop', 'c', 'd'), 100);
    expect(nextChangeAt(map)).toBe(100 + ACTIVE_MS.blocked);
    const later = advance(map, ACTIVE_MS.fired + 1);
    expect(nextChangeAt(later)).toBe(100 + ACTIVE_MS.blocked + LINGER_MS);
    expect(nextChangeAt(advance(later, ACTIVE_MS.fired + LINGER_MS + 101))).toBe(RECENT_MS);
  });

  it('摘要只取第一行、太長截斷', () => {
    expect(firstLine(null)).toBeNull();
    expect(firstLine('\n  first line \nsecond')).toBe('first line');
    expect(firstLine('x'.repeat(10), 4)).toBe('xxxx…');
  });

  it('說明框：先遮蔽再截斷，金鑰跨過 120 字的切點也不會露出一半', () => {
    const secret = 'sk-ant-demo0123456789abcdefXYZ';
    const summary = `${'x'.repeat(110)} ${secret} rest`;
    // 反過來做（先截斷）會留下認不出來的半截金鑰：確認這個測試真的測到邊界。
    expect(maskSecrets(firstLine(summary)!)).toContain('sk-ant');
    const activity = recordHandoff(empty, fired('a', 'b', summary), 0).get('a->b')!;
    const text = describeTalk(activity, t, maskSecrets);
    expect(text).not.toContain('sk-ant');
    expect(text.endsWith('…')).toBe(true);
  });

  it('說明框：擋下寫原因，沒翻譯的原因照代碼顯示', () => {
    const loop = recordHandoff(empty, blocked('loop'), 0).get('a->b')!;
    expect(describeTalk(loop, t, plain)).toBe('擋下：會形成迴圈');
    const odd = recordHandoff(empty, blocked('new_reason'), 0).get('a->b')!;
    expect(describeTalk(odd, t, plain)).toBe('new_reason');
  });

  it('雙向交接：帶第幾輪；到上限擋下時說明等你決定', () => {
    const second = event(
      'handoff.delivered',
      { fromSessionId: 'w', toSessionId: 'x', summary: 's', round: 2, maxRounds: 3 },
      'x',
    );
    const activity = recordHandoff(empty, second, 0).get('w->x')!;
    expect(activity).toMatchObject({ round: 2, maxRounds: 3 });
    expect(roundLabel(activity, t)).toBe('第 2/3 輪');

    const limit = event(
      'handoff.blocked',
      { fromSessionId: 'w', toSessionId: 'x', reason: 'round_limit', round: 4, maxRounds: 3 },
      'w',
    );
    const stopped = recordHandoff(empty, limit, 0).get('w->x')!;
    expect(roundLabel(stopped, t)).toBe('第 3/3 輪');
    expect(describeTalk(stopped, t, plain)).toBe('停下：已來回 3 輪，等你決定');
    // 單向規則、舊版 hub：沒有輪數。
    expect(roundLabel(recordHandoff(empty, fired(), 0).get('a->b')!, t)).toBeNull();
    const bad = event('handoff.fired', { fromSessionId: 'a', toSessionId: 'b', round: '2' }, 'a');
    expect(parseHandoffEvent(bad)).toMatchObject({ round: null });
  });
});

describe('session 派工（CONTRACTS §11）也畫在同一條線上', () => {
  it('send／result 是排入、spawn／delivered／result_delivered 是送達，記在哪一邊和交接相同', () => {
    const go = { fromSessionId: 'lead', toSessionId: 'bd', summary: 'Go.' };
    const back = { fromSessionId: 'bd', toSessionId: 'lead', summary: 'Done.' };
    const cases: [SessionEvent, string, string][] = [
      [event('dispatch.spawn', go, 'bd'), 'delivered', 'lead->bd'],
      [event('dispatch.send', go, 'lead'), 'fired', 'lead->bd'],
      [event('dispatch.delivered', go, 'bd'), 'delivered', 'lead->bd'],
      [event('dispatch.result', back, 'bd'), 'fired', 'bd->lead'],
      [event('dispatch.result_delivered', back, 'lead'), 'delivered', 'bd->lead'],
      [event('dispatch.blocked', { ...go, reason: 'rate_limit' }, 'lead'), 'blocked', 'lead->bd'],
    ];
    for (const [e, kind, key] of cases) {
      expect(parseHandoffEvent(e), e.type).toMatchObject({ kind, key, channel: 'dispatch' });
    }
    expect(parseHandoffEvent(cases[0]![0])?.what).toBe('canvas.link.what.spawn');
    expect(parseHandoffEvent(cases[3]![0])?.what).toBe('canvas.link.what.result');
    // 記錯邊的（payload 和事件所屬的 session 對不上）不採用。
    expect(parseHandoffEvent(event('dispatch.result_delivered', back, 'bd'))).toBeNull();
  });
});
