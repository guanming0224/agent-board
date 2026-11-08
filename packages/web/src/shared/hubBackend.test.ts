import { describe, expect, it } from 'vitest';
import type { Broadcast } from '@agent-board/protocol';
import { mergeAfterReconnect } from './hubBackend';

const broadcast = (id: string, states: Broadcast['targets'][number]['state'][]): Broadcast => ({
  id,
  teamId: 't',
  text: 'hi',
  mentioned: false,
  by: null,
  byName: null,
  at: '2026-11-08T00:00:00.000Z',
  boardPaused: false,
  targets: states.map((state, i) => ({
    sessionId: `s${i}`,
    name: `s${i}`,
    state,
    reason: null,
    at: '2026-11-08T00:00:00.000Z',
  })),
});

describe('群發：hub 重啟後重連', () => {
  it('hub 清單裡沒有的、原本還在排隊的對象標成「沒送出（hub 重啟）」，不默默消失', () => {
    const before = [broadcast('old', ['sent', 'queued']), broadcast('done', ['sent'])];
    const merged = mergeAfterReconnect(before, [broadcast('new', ['queued'])]);
    expect(merged.map((b) => b.id)).toEqual(['old', 'new']);
    expect(merged[0]!.targets.map((t) => [t.state, t.reason])).toEqual([
      ['sent', null],
      ['failed', 'hub_restarted'],
    ]);
  });

  it('只是斷線重連（hub 還記得）：照 hub 的', () => {
    const before = [broadcast('a', ['queued'])];
    expect(mergeAfterReconnect(before, [broadcast('a', ['sent'])])[0]!.targets[0]!.state).toBe(
      'sent',
    );
  });
});
