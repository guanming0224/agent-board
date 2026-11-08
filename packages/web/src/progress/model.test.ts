import { describe, expect, it } from 'vitest';
import {
  emptyProgressCard,
  type ProgressCard,
  type Session,
  type Team,
  type TeamMember,
} from '@agent-board/protocol';
import {
  changedSince,
  editedFields,
  memoryRows,
  parseInline,
  parseMarkdown,
  resolveConflict,
} from './model';

describe('簡單 Markdown（只有清單、粗體、行內 code）', () => {
  it('清單、段落、粗體、code；連結與圖片照原樣當文字', () => {
    expect(parseMarkdown('狀態：**回測完成**\n第二行\n\n- 補 `2021`\n* 再跑\n1. 三')).toEqual([
      {
        kind: 'p',
        lines: [
          [
            { kind: 'text', text: '狀態：' },
            { kind: 'bold', text: '回測完成' },
          ],
          [{ kind: 'text', text: '第二行' }],
        ],
      },
      {
        kind: 'list',
        items: [
          [
            { kind: 'text', text: '補 ' },
            { kind: 'code', text: '2021' },
          ],
          [{ kind: 'text', text: '再跑' }],
          [{ kind: 'text', text: '三' }],
        ],
      },
    ]);
    expect(parseInline('[x](http://evil) ![i](a.png)')).toEqual([
      { kind: 'text', text: '[x](http://evil) ![i](a.png)' },
    ]);
  });
});

const T0 = Date.parse('2026-11-10T00:00:00Z');
const iso = (hoursAgo: number) => new Date(T0 - hoursAgo * 3600_000).toISOString();
const team = (id: string, zoneId = 'main'): Team => ({
  id,
  name: id,
  goal: '',
  doneCriteria: '',
  color: 'teal',
  contextMd: '',
  zoneId,
});
const session = (id: string, zoneId = 'main') =>
  ({ id, name: id, zoneId, archived: false }) as Session;
const card = (over: Partial<ProgressCard>): ProgressCard => ({
  ...emptyProgressCard({ teamId: 'x' }),
  revision: 1,
  id: Math.random().toString(),
  ...over,
});

describe('Memory 清單', () => {
  const teams = [team('a'), team('b'), team('c'), team('far', 'z2')];
  const members: TeamMember[] = [{ teamId: 'a', sessionId: 'joined', role: 'worker' }];
  const sessions = [session('solo'), session('joined')];
  const cards = [
    card({ teamId: 'a', updatedAt: iso(1) }),
    // 3 天沒更新、期間有回合結束：⚠，排最前。
    card({
      teamId: 'b',
      updatedAt: iso(72),
      facts: { ...emptyProgressCard({ teamId: 'b' }).facts, lastStopAt: iso(2) },
    }),
    card({ teamId: 'c', updatedAt: iso(5) }),
    card({ teamId: 'far', updatedAt: iso(0.5) }),
    card({ teamId: null, sessionId: 'solo', updatedAt: iso(3) }),
    card({ teamId: null, sessionId: 'joined', updatedAt: iso(4) }),
    // 還沒寫過、擁有者已刪除的不列。
    card({ teamId: 'gone', updatedAt: iso(1) }),
    card({ teamId: 'c2', revision: 0 }),
  ];
  const rows = (scope: 'current' | 'all') =>
    memoryRows(cards, { teams, members, sessions, now: T0, scope, zoneId: 'main' }).map((r) => [
      r.info.key,
      r.stale,
      r.info.joinedTeam,
    ]);

  it('目前工作區：⚠ 在前，其餘依更新時間新到舊；已加入團隊的單獨卡不列', () => {
    expect(rows('current')).toEqual([
      ['team:b', true, null],
      ['team:a', false, null],
      ['session:solo', false, null],
      ['team:c', false, null],
    ]);
  });

  it('全部工作區：含別的工作區與「（已加入 …）」的卡', () => {
    expect(rows('all')).toEqual([
      ['team:b', true, null],
      ['team:far', false, null],
      ['team:a', false, null],
      ['session:solo', false, null],
      ['session:joined', false, 'a'],
      ['team:c', false, null],
    ]);
  });
});

describe('編輯與衝突', () => {
  it('兩個都留：我的在上、空一行、目前的；一邊空就只留另一邊', () => {
    expect(resolveConflict('mine', 'theirs', 'both')).toBe('mine\n\ntheirs');
    expect(resolveConflict('mine', 'theirs', 'mine')).toBe('mine');
    expect(resolveConflict('mine', 'theirs', 'theirs')).toBe('theirs');
    expect(resolveConflict('', 'theirs', 'both')).toBe('theirs');
  });

  it('只送真的改了的欄位；開始編輯之後被改過的欄位', () => {
    const before = { status: 'a', next: 'b', blockers: '', gmNotes: '' };
    expect(editedFields(before, { ...before, next: 'B' })).toEqual({ next: 'B' });
    expect(editedFields(before, before)).toEqual({});
    const c = card({
      revision: 4,
      fieldRevisions: { status: 1, next: 4, blockers: 3, gmNotes: 0 },
    });
    expect(changedSince(c, 2)).toEqual(['next', 'blockers']);
    expect(changedSince(c, 4)).toEqual([]);
  });
});
