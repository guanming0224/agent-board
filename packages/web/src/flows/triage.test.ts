// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { IDLE_START_DETAIL, waitingSessions } from '@agent-board/protocol';
import type { Approval, Session } from '@agent-board/protocol';
import {
  contextLine,
  filterTriage,
  groupTriage,
  inboxItems,
  keepSelection,
  leadApproval,
  triageItems,
  urgencyOrder,
} from './triage';

const at = (m: number) => new Date(Date.UTC(2026, 10, 6, 12, 0) - m * 60_000).toISOString();

const session = (over: Partial<Session> & Pick<Session, 'id'>): Session => ({
  name: over.id,
  machineId: 'm1',
  projectId: null,
  cwd: '/work/api',
  branch: 'main',
  worktreePath: null,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  status: 'running',
  statusDetail: null,
  claudeSessionId: null,
  lastLines: [],
  lastOutputAt: at(0),
  statusSince: at(1),
  contextTokens: null,
  contextWindow: null,
  repoRoot: null,
  repoCommonDir: null,
  createdAt: at(60),
  endedAt: null,
  archived: false,
  archivedAt: null,
  readOnly: false,
  autoContinue: null,
  dispatchedBy: null,
  ...over,
});

const approval = (over: Partial<Approval> & Pick<Approval, 'id' | 'sessionId'>): Approval => ({
  kind: 'permission',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  suggestions: [],
  matchedRule: null,
  message: null,
  createdAt: at(1),
  ...over,
});

const board = () => {
  const sessions = [
    session({ id: 'perm', status: 'waiting_permission', statusSince: at(12) }),
    session({ id: 'plan', status: 'plan_review', statusSince: at(4) }),
    session({ id: 'stuck', status: 'stuck', statusSince: at(14) }),
    session({ id: 'err', status: 'error', statusSince: at(6) }),
    session({ id: 'quota', status: 'rate_limited', statusSince: at(30) }),
    session({ id: 'reply', status: 'waiting_input', statusSince: at(27) }),
    session({ id: 'ask', status: 'waiting_input', statusSince: at(3) }),
    session({
      id: 'idle',
      status: 'waiting_input',
      statusDetail: IDLE_START_DETAIL,
      statusSince: at(50),
    }),
    // 危險指令命中時 session 常常還是 running
    session({ id: 'danger', status: 'running' }),
    session({ id: 'busy', status: 'running' }),
    session({ id: 'done', status: 'done' }),
    session({ id: 'gone', status: 'error', archived: true }),
  ];
  const approvals = [
    approval({ id: 'a-perm', sessionId: 'perm', createdAt: at(12) }),
    approval({ id: 'a-plan', sessionId: 'plan', kind: 'plan', createdAt: at(4) }),
    approval({ id: 'a-ask', sessionId: 'ask', kind: 'question', createdAt: at(3) }),
    approval({
      id: 'a-danger',
      sessionId: 'danger',
      kind: 'danger',
      toolInput: { command: 'git push --force' },
      createdAt: at(2),
    }),
  ];
  return { sessions, approvals };
};

describe('triageItems', () => {
  it('分四組：要你決定 → 等你回覆 → 出問題 → 其他；危險指令置頂，同組等最久的在前', () => {
    const { sessions, approvals } = board();
    const items = triageItems(sessions, approvals);
    expect(items.map((i) => [i.session.id, i.group, i.kind])).toEqual([
      ['danger', 'decide', 'danger'],
      ['perm', 'decide', 'permission'],
      ['plan', 'decide', 'plan'],
      ['reply', 'reply', 'reply'],
      ['ask', 'reply', 'question'],
      ['quota', 'trouble', 'rate_limited'],
      ['stuck', 'trouble', 'stuck'],
      ['err', 'trouble', 'error'],
      ['idle', 'other', 'idle'],
    ]);
  });

  it('不列工作中、完成、封存的；等多久從 approval 建立時間算', () => {
    const { sessions, approvals } = board();
    const items = triageItems(sessions, approvals);
    const ids = items.map((i) => i.session.id);
    expect(ids).not.toContain('busy');
    expect(ids).not.toContain('done');
    expect(ids).not.toContain('gone');
    expect(items.find((i) => i.session.id === 'danger')?.since).toBe(at(2));
  });

  it('算進「等你」的數量和頁首（attention.ts）完全一樣；額度與剛開好的不算', () => {
    const { sessions, approvals } = board();
    const items = triageItems(sessions, approvals);
    const counted = items.filter((i) => i.counted).map((i) => i.session.id);
    expect(counted.sort()).toEqual(
      waitingSessions(sessions, approvals)
        .map((s) => s.id)
        .sort(),
    );
    expect(items.filter((i) => !i.counted).map((i) => i.session.id)).toEqual(['quota', 'idle']);
  });

  it('同一個 session 有多筆 approval：一列，危險指令優先', () => {
    const approvals = [
      approval({ id: 'p', sessionId: 's', createdAt: at(10) }),
      approval({ id: 'd', sessionId: 's', kind: 'danger', createdAt: at(1) }),
    ];
    expect(leadApproval(approvals, 's')?.id).toBe('d');
    const items = triageItems([session({ id: 's', status: 'waiting_permission' })], approvals);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('danger');
  });

  it('groupTriage 保留空的組', () => {
    const groups = groupTriage(triageItems([session({ id: 'e', status: 'error' })], []));
    expect(groups.map((g) => [g.group, g.items.length])).toEqual([
      ['decide', 0],
      ['reply', 0],
      ['trouble', 1],
      ['other', 0],
    ]);
  });

  it('依團隊成員與機器篩選', () => {
    const { sessions, approvals } = board();
    const moved = sessions.map((s) => (s.id === 'perm' ? { ...s, machineId: 'm2' } : s));
    const items = triageItems(moved, approvals);
    expect(
      filterTriage(items, { teamMembers: null, machineId: 'm2' }).map((i) => i.session.id),
    ).toEqual(['perm']);
    expect(
      filterTriage(items, { teamMembers: new Set(['err', 'plan']), machineId: null }).map(
        (i) => i.session.id,
      ),
    ).toEqual(['plan', 'err']);
  });
});

describe('contextLine', () => {
  it('指令、提問、計畫第一行、檔案、最後一行輸出；多行壓成一行', () => {
    const s = session({ id: 's', lastLines: ['first', 'last line', '  '] });
    expect(
      contextLine({
        session: s,
        approval: approval({ id: 'a', sessionId: 's', toolInput: { command: 'a\n  b' } }),
      }),
    ).toBe('a b');
    expect(
      contextLine({
        session: s,
        approval: approval({
          id: 'a',
          sessionId: 's',
          toolInput: { questions: [{ question: 'Which?', options: [] }] },
        }),
      }),
    ).toBe('Which?');
    expect(
      contextLine({
        session: s,
        approval: approval({ id: 'a', sessionId: 's', toolInput: { plan: '\n# Plan\n1. x' } }),
      }),
    ).toBe('# Plan');
    expect(
      contextLine({
        session: s,
        approval: approval({ id: 'a', sessionId: 's', toolInput: { file_path: 'src/a.ts' } }),
      }),
    ).toBe('src/a.ts');
    expect(contextLine({ session: s, approval: null })).toBe('last line');
    expect(contextLine({ session: session({ id: 'x' }), approval: null })).toBe('');
  });
});

describe('收件匣（P2 §1.2）', () => {
  it('只列算「等你」的：列數＝頁首「等你 N」；NEW（剛開好）與額度用完不列', () => {
    const { sessions, approvals } = board();
    const ids = inboxItems(sessions, approvals).map((i) => i.session.id);
    expect(ids).not.toContain('idle');
    expect(ids).not.toContain('quota');
    expect(ids.length).toBe(waitingSessions(sessions, approvals).length);
    expect([...ids].sort()).toEqual(
      waitingSessions(sessions, approvals)
        .map((s) => s.id)
        .sort(),
    );
  });

  it('依急迫：⛔ → ERR（錯誤、卡住）→ PERM → PLAN／ASK，同級等最久的在前', () => {
    const { sessions, approvals } = board();
    const ordered = urgencyOrder(inboxItems(sessions, approvals));
    expect(ordered.map((i) => i.session.id)).toEqual([
      'danger',
      'stuck',
      'err',
      'perm',
      'reply',
      'plan',
      'ask',
    ]);
  });

  it('依組別：沿用待處理的分組（決定 → 回覆 → 出問題）', () => {
    const { sessions, approvals } = board();
    const groups = groupTriage(inboxItems(sessions, approvals));
    expect(groups.map((g) => [g.group, g.items.map((i) => i.session.id)])).toEqual([
      ['decide', ['danger', 'perm', 'plan']],
      ['reply', ['reply', 'ask']],
      ['trouble', ['stuck', 'err']],
      ['other', []],
    ]);
  });
});

describe('keepSelection', () => {
  it('選中的還在就不變', () => {
    expect(keepSelection(['a', 'b'], ['a', 'b'], 'b')).toBe('b');
  });
  it('處理掉後選原本位置的下一個，最後一個就選上一個', () => {
    expect(keepSelection(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
    expect(keepSelection(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
  });
  it('沒選、選的不認得或清單空了', () => {
    expect(keepSelection(['a'], ['a', 'b'], null)).toBe('a');
    expect(keepSelection(['a'], ['b'], 'zz')).toBe('b');
    expect(keepSelection(['a'], [], 'a')).toBeNull();
  });
});
