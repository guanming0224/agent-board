// 畫布團隊框：共用資料夾的團隊（§24）在標籤上標出來。
import { describe, expect, it } from 'vitest';
import type { Team } from '@agent-board/protocol';
import { canvasTeams } from './teams';

const team = (id: string, over: Partial<Team> = {}): Team => ({
  id,
  name: id,
  goal: '',
  doneCriteria: '',
  color: 'teal',
  contextMd: '',
  zoneId: 'main',
  ...over,
});

describe('canvasTeams', () => {
  it('只有開著共用資料夾的團隊帶 shared', () => {
    const out = canvasTeams(
      [team('a', { sharedWriters: true }), team('b'), team('c', { sharedWriters: false })],
      [{ teamId: 'a', sessionId: 's1', role: 'lead' }],
    );
    expect(out.map((t) => [t.id, t.shared ?? false, t.memberIds])).toEqual([
      ['a', true, ['s1']],
      ['b', false, []],
      ['c', false, []],
    ]);
  });
});
