import type { HandoffRule, Session, TeamMember } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import { createRules, patchAction, ruleAction, triggerChoice, twoWayRules } from './handoffRules';
import { existingTeam, memberKind, phaseDiff, planHasPair, researchPairRules } from './research';
import { phaseRows } from './teamPlan';

const m = (sessionId: string, role: TeamMember['role'], kind?: TeamMember['kind']) => ({
  teamId: 't',
  sessionId,
  role,
  ...(kind ? { kind } : {}),
});

describe('成員分工', () => {
  it('存的 kind 和角色對得上才用；沒有或對不上就照角色推', () => {
    expect(memberKind(m('a', 'worker', 'wr'))).toBe('wr');
    expect(memberKind(m('a', 'worker'))).toBe('ex');
    // 在工作台把寫作改成審查：以角色為準。
    expect(memberKind(m('a', 'reviewer', 'wr'))).toBe('rv');
    expect(memberKind(m('a', 'lead'))).toBe('ld');
  });
});

describe('換階段的差異', () => {
  const experiment = [
    m('ld', 'lead', 'ld'),
    m('ex1', 'worker', 'ex'),
    m('ex2', 'worker', 'ex'),
    m('rv', 'reviewer', 'rv'),
  ];

  it('實驗 → 寫作：多一位 EX，缺 WR', () => {
    expect(phaseDiff(experiment, 'writing')).toEqual({ extra: ['ex2'], missing: ['wr'] });
  });

  it('實驗 → 選題：EX、RV 用不到，缺兩位 LR', () => {
    expect(phaseDiff(experiment, 'topic')).toEqual({
      extra: ['ex1', 'ex2', 'rv'],
      missing: ['lr', 'lr'],
    });
  });

  it('同階段沒有差異；舊資料沒有 kind 的 worker 當實驗', () => {
    expect(phaseDiff(experiment, 'experiment')).toEqual({ extra: [], missing: [] });
    expect(phaseDiff([m('a', 'lead'), m('b', 'worker')], 'revision')).toEqual({
      extra: [],
      missing: ['wr', 'rv'],
    });
  });
});

describe('補成員要算進來的現有成員', () => {
  const session = (over: Partial<Session>): Session =>
    ({
      id: 's',
      name: 'x',
      machineId: 'm1',
      cwd: '/r',
      worktreePath: null,
      repoRoot: null,
      readOnly: false,
      archived: false,
      endedAt: null,
      ...over,
    }) as Session;

  it('隊長、主資料夾寫入者（不含 worktree、唯讀、別台機器、封存）與所有名稱', () => {
    const lead = session({ id: 'a', name: 'A-LD' });
    const bd = session({ id: 'b', name: 'A-BD1', worktreePath: '/wt/b' });
    const rv = session({ id: 'c', name: 'A-RV', readOnly: true });
    const other = session({ id: 'd', name: 'A-BD2', machineId: 'm2' });
    const gone = session({ id: 'e', name: 'A-OLD', archived: true });
    const result = existingTeam(
      [
        { member: { role: 'lead' }, session: lead },
        { member: { role: 'worker' }, session: bd },
        { member: { role: 'reviewer' }, session: rv },
        { member: { role: 'worker' }, session: other },
        { member: { role: 'lead' }, session: gone },
      ],
      { machineId: 'm1', cwd: '/r' },
      [lead, bd, rv, other, gone, session({ name: 'canvas-only' })],
    );
    expect(result).toMatchObject({ members: 4, leads: 1, mainWriters: 1 });
    expect(result.names).toEqual(
      new Set(['A-LD', 'A-BD1', 'A-RV', 'A-BD2', 'A-OLD', 'canvas-only']),
    );
  });
});

describe('研究團隊預設的雙向交接', () => {
  it('第一位實驗 ⇄ 第一位寫作：[結果完成] 與 [需要實驗]，共用輪數，先關著', () => {
    const rows = phaseRows('revision', 'P');
    expect(planHasPair(rows)).toBe(true);
    expect(planHasPair(phaseRows('experiment', 'P'))).toBe(false);
    const ids = new Map(rows.map((r) => [r.key, `id-${r.name}`]));
    expect(researchPairRules(rows, ids, 3)).toEqual([
      {
        fromSessionId: 'id-P-EX1',
        trigger: 'on_marker',
        action: { toSessionId: 'id-P-WR', marker: '[結果完成]', maxRounds: 3 },
        enabled: false,
      },
      {
        fromSessionId: 'id-P-WR',
        trigger: 'on_marker',
        action: { toSessionId: 'id-P-EX1', marker: '[需要實驗]', maxRounds: 3 },
        enabled: false,
      },
    ]);
    // 寫作沒建好：不建。
    const noWr = new Map([...ids].filter(([key]) => key !== rows[2]!.key));
    expect(researchPairRules(rows, noWr, 3)).toBeNull();
  });
});

describe('交接規則的欄位', () => {
  it('只帶這個觸發條件用得到的欄位', () => {
    expect(ruleAction('b', triggerChoice('on_done', { filePattern: 'x' }))).toEqual({
      toSessionId: 'b',
    });
    expect(ruleAction('b', triggerChoice('on_file', { filePattern: ' *.ts ' }), 2)).toEqual({
      toSessionId: 'b',
      filePattern: '*.ts',
      maxRounds: 2,
    });
    expect(ruleAction('b', triggerChoice('on_marker'))).toEqual({
      toSessionId: 'b',
      marker: '[需要實驗]',
    });
  });

  it('改一項時保留其他欄位；maxRounds null 是改回單向', () => {
    const action = { toSessionId: 'b', filePattern: '*.ts', maxRounds: 3 };
    expect(patchAction(action, { maxRounds: null })).toEqual({
      toSessionId: 'b',
      filePattern: '*.ts',
    });
    expect(patchAction(action, { filePattern: '' })).toEqual({ toSessionId: 'b', maxRounds: 3 });
  });

  it('雙向的兩條依序建立；一條失敗時另一條保留並回報', async () => {
    const [ab, ba] = twoWayRules('a', 'b', triggerChoice('on_done'), triggerChoice('on_fail'), 3);
    const backend = {
      createHandoffRule: async (_team: string, input: Omit<HandoffRule, 'id' | 'teamId'>) => {
        if (input.fromSessionId === 'b') throw new Error('hub down');
        return { ...input, id: 'r1', teamId: 't' };
      },
    };
    const result = await createRules(backend, 't', [ab, ba]);
    expect(result.created.map((r) => r.fromSessionId)).toEqual(['a']);
    expect(result.failed).toMatchObject([{ input: { fromSessionId: 'b' } }]);
  });
});
