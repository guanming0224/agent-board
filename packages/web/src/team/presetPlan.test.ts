// 團隊 Presets 的純函式（P3 項目二 §2.5、§2.6、§6）：列 ↔ PlanRow 互轉、規則的列序號、從團隊擷取、撞名、
// 以及 runPlan 套用 Preset 時的第一個指令、交接規則、初始進度卡。
import {
  TeamPresetConfig,
  type HandoffRule,
  type Session,
  type Team,
  type TeamMember,
} from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import type { BoardBackend } from '../shared/backend';
import {
  planRowsToPreset,
  presetAbbr,
  presetCosts,
  presetHasBypass,
  presetRuleInputs,
  presetToPlanRows,
  rulesWithoutRow,
  teamToPresetConfig,
  uniqueTeamName,
  type TeamRecord,
} from './presetPlan';
import { runPlan } from './runPlan';
import { rowUsesWorktree, validatePlan } from './teamPlan';

const team: Team = {
  id: 't1',
  name: '策略驗證',
  goal: 'Validate',
  doneCriteria: 'Sharpe > 1',
  color: 'lime',
  contextMd: '# fixed rules',
  taskAuto: false,
  zoneId: 'main',
};

function session(id: string, name: string, over: Partial<Session> = {}): Session {
  return {
    id,
    machineId: 'm1',
    projectId: 'p1',
    name,
    cwd: '/repo',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    status: 'waiting_input',
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: null,
    statusSince: '2026-11-08T00:00:00.000Z',
    contextTokens: null,
    contextWindow: null,
    repoRoot: null,
    repoCommonDir: null,
    createdAt: '2026-11-08T00:00:00.000Z',
    endedAt: null,
    archived: false,
    archivedAt: null,
    readOnly: false,
    autoContinue: null,
    dispatchedBy: null,
    zoneId: 'main',
    ...over,
  };
}

const member = (sessionId: string, role: TeamMember['role']): TeamMember => ({
  teamId: 't1',
  sessionId,
  role,
});

/** 隊長＋2 成員＋審查、1 條交接規則（關）（§2.6-1）。名單順序故意打亂。 */
function records(): TeamRecord[] {
  return [
    {
      member: member('rv', 'reviewer'),
      session: session('rv', '策略驗證-RV', { permissionMode: 'plan', readOnly: true }),
    },
    {
      member: member('bd1', 'worker'),
      session: session('bd1', '策略驗證-BD1', {
        permissionMode: 'acceptEdits',
        worktreePath: '/wt/bd1',
        model: 'opus',
      }),
    },
    { member: member('ld', 'lead'), session: session('ld', '策略驗證-LD') },
    {
      member: member('bd2', 'worker'),
      session: session('bd2', 'data-loader', {
        permissionMode: 'acceptEdits',
        worktreePath: '/wt/bd2',
      }),
    },
  ];
}

const rule = (from: string, to: string, over: Partial<HandoffRule> = {}): HandoffRule => ({
  id: `${from}-${to}`,
  teamId: 't1',
  fromSessionId: from,
  trigger: 'on_done',
  action: { toSessionId: to },
  enabled: false,
  ...over,
});

describe('從團隊擷取 Preset', () => {
  it('列數 4、隊長在前、角色與模式一致、worktree 看 worktreePath、改過的名稱存後綴；規則 1 條且關；進度卡預設空', () => {
    const result = teamToPresetConfig(team, records(), [
      rule('bd1', 'rv'),
      // 連到團隊外：略過。
      rule('bd1', 'outsider'),
    ])!;
    expect(result.skippedRules).toBe(1);
    const config = TeamPresetConfig.parse(result.config);
    expect(config.rows).toEqual([
      { kind: 'lead', permissionMode: 'default', model: null, useWorktree: false, label: null },
      {
        kind: 'worker',
        permissionMode: 'acceptEdits',
        model: 'opus',
        useWorktree: true,
        label: null,
      },
      {
        kind: 'worker',
        permissionMode: 'acceptEdits',
        model: null,
        useWorktree: true,
        label: 'data-loader',
      },
      { kind: 'reviewer', permissionMode: 'plan', model: null, useWorktree: false, label: null },
    ]);
    expect(config.handoffRules).toEqual([
      { fromRow: 1, toRow: 3, trigger: 'on_done', enabled: false },
    ]);
    expect(config.placement).toEqual({ machineId: 'm1', cwd: '/repo', projectId: 'p1' });
    expect(config).toMatchObject({
      teamType: 'dev',
      phase: null,
      color: 'lime',
      goal: 'Validate',
      doneCriteria: 'Sharpe > 1',
      contextMd: '# fixed rules',
      taskAuto: false,
      leadFirstPrompt: null,
      initialProgress: { status: '', next: '', blockers: '', gmNotes: '' },
    });
    expect(presetAbbr(config)).toBe('LD · BD · BD · RV');
    expect(presetCosts(config).any).toBe(false);
    // 帶進度卡、封存的成員不算。
    const withCard = teamToPresetConfig(
      team,
      [
        ...records(),
        { member: member('old', 'worker'), session: session('old', 'old', { archived: true }) },
      ],
      [],
      { status: 's', next: 'n', blockers: '', gmNotes: '' },
    )!;
    expect(withCard.config.rows).toHaveLength(4);
    expect(withCard.config.initialProgress).toMatchObject({ next: 'n' });
    expect(teamToPresetConfig(team, [], [])).toBeNull();
  });

  it('研究團隊存分工（ex／wr），沒有隊長取第一位的位置', () => {
    const research: Team = { ...team, phase: 'writing' };
    const result = teamToPresetConfig(
      research,
      [
        {
          member: { ...member('w', 'worker'), kind: 'wr' },
          session: session('w', '策略驗證-WR', { cwd: '/paper' }),
        },
        { member: { ...member('e', 'worker'), kind: 'ex' }, session: session('e', '策略驗證-EX1') },
      ],
      [],
    )!;
    expect(result.config.teamType).toBe('research');
    expect(result.config.phase).toBe('writing');
    expect(result.config.rows!.map((r) => r.kind)).toEqual(['wr', 'ex']);
    expect(result.config.placement.cwd).toBe('/paper');
  });
});

describe('Preset 的列 ↔ PlanRow', () => {
  it('套用時名稱照新團隊名產生：`<名稱 2>-LD`、-BD1、-BD2、-RV；後綴列是 `<名稱 2>-後綴`；往返不變', () => {
    const config = TeamPresetConfig.parse(teamToPresetConfig(team, records(), [])!.config);
    const rows = presetToPlanRows(config.rows, '策略驗證 2');
    expect(rows.map((r) => r.name)).toEqual([
      '策略驗證 2-LD',
      '策略驗證 2-BD1',
      '策略驗證 2-data-loader',
      '策略驗證 2-RV',
    ]);
    expect(rows.map((r) => [r.role, r.mode, r.model ?? null, r.worktree])).toEqual([
      ['lead', 'default', null, false],
      ['worker', 'acceptEdits', 'opus', true],
      ['worker', 'acceptEdits', null, true],
      ['reviewer', 'plan', null, false],
    ]);
    expect(planRowsToPreset(rows, '策略驗證 2')).toEqual(config.rows);
    // 預設命名的 BD 編號：沒有後綴列時 BD1、BD2。
    const plain = presetToPlanRows(
      config.rows.map((r) => ({ ...r, label: null })),
      'X',
    );
    expect(plain.map((r) => r.name)).toEqual(['X-LD', 'X-BD1', 'X-BD2', 'X-RV']);
  });

  it('worktree 與唯讀規則和手動建立相同：依角色規則（null）或照存的值，不是 git 一律不開', () => {
    const rows = presetToPlanRows(
      [
        { kind: 'lead', permissionMode: 'default', model: null, useWorktree: null, label: null },
        {
          kind: 'worker',
          permissionMode: 'acceptEdits',
          model: null,
          useWorktree: null,
          label: null,
        },
        { kind: 'tester', permissionMode: 'default', model: null, useWorktree: false, label: null },
      ],
      'Q',
    );
    expect(rows.map((r) => rowUsesWorktree(r, true))).toEqual([false, true, false]);
    expect(rows.map((r) => rowUsesWorktree(r, false))).toEqual([false, false, false]);
    // 測試沒開 worktree＝和隊長一起在主資料夾寫：validatePlan 擋（主資料夾最多一位寫入者）。
    expect(validatePlan(rows, true)).toBe('sharedWriters');
  });
});

describe('交接規則的列序號', () => {
  it('換成建好的 session；來源或目標沒建成的略過', () => {
    const rules = [
      { fromRow: 1, toRow: 3, trigger: 'on_done' as const, enabled: true },
      {
        fromRow: 2,
        toRow: 0,
        trigger: 'on_marker' as const,
        marker: '[x]',
        maxRounds: 3,
        enabled: false,
      },
      { fromRow: 0, toRow: 1, trigger: 'on_file' as const, filePattern: '*.md', enabled: true },
    ];
    expect(presetRuleInputs(rules, ['a', 'b', undefined, 'd'])).toEqual({
      inputs: [
        { fromSessionId: 'b', trigger: 'on_done', action: { toSessionId: 'd' }, enabled: true },
        {
          fromSessionId: 'a',
          trigger: 'on_file',
          action: { toSessionId: 'b', filePattern: '*.md' },
          enabled: true,
        },
      ],
      skipped: 1,
    });
    // 刪掉第 1 列：相關的規則刪掉，後面的序號往前。
    expect(rulesWithoutRow(rules, 1)).toEqual({
      rules: [
        { fromRow: 1, toRow: 0, trigger: 'on_marker', marker: '[x]', maxRounds: 3, enabled: false },
      ],
      dropped: 2,
    });
  });
});

describe('其他', () => {
  it('撞名自動加「 2」「 3」（不分大小寫）', () => {
    expect(uniqueTeamName('策略驗證', ['別的'])).toBe('策略驗證');
    expect(uniqueTeamName('策略驗證', ['策略驗證'])).toBe('策略驗證 2');
    expect(uniqueTeamName('Alpha', ['alpha', 'ALPHA 2'])).toBe('Alpha 3');
  });

  it('◈ 與略過權限的標記', () => {
    const base = TeamPresetConfig.parse(
      teamToPresetConfig(team, records(), [rule('bd1', 'rv')])!.config,
    );
    expect(presetCosts(base)).toEqual({
      firstPrompt: false,
      rules: 0,
      taskAuto: false,
      any: false,
    });
    expect(presetCosts({ ...base, leadFirstPrompt: 'go' }).any).toBe(true);
    expect(presetCosts({ ...base, taskAuto: true }).any).toBe(true);
    expect(
      presetCosts({
        ...base,
        handoffRules: base.handoffRules.map((r) => ({ ...r, enabled: true })),
      }),
    ).toMatchObject({ rules: 1, any: true });
    expect(presetHasBypass(base)).toBe(false);
    expect(
      presetHasBypass({ rows: [{ ...base.rows[1]!, permissionMode: 'bypassPermissions' }] }),
    ).toBe(true);
  });
});

describe('runPlan 套用 Preset', () => {
  function backend(options: { failSession?: string; progressFails?: boolean } = {}) {
    const specs: {
      name: string;
      firstPrompt: string | null;
      model: string | null;
      useWorktree: boolean;
    }[] = [];
    const rules: unknown[] = [];
    const progress: unknown[] = [];
    const b = {
      createTeam: async () => ({ ...team, id: 'new' }),
      createSession: async (spec: (typeof specs)[number]) => {
        if (spec.name === options.failSession) {
          throw Object.assign(new Error('conflict'), { code: 'session_conflict' });
        }
        specs.push(spec);
        return { id: `id-${spec.name}` } as Session;
      },
      putTeamMember: async (teamId: string, sessionId: string, role: TeamMember['role']) => ({
        teamId,
        sessionId,
        role,
      }),
      createHandoffRule: async (teamId: string, input: Omit<HandoffRule, 'id' | 'teamId'>) => {
        rules.push(input);
        return { ...input, id: 'r', teamId };
      },
      // P3 項目一的 PUT /api/teams/:id/progress（整合後 runPlan 直接用 saveProgress）。
      saveProgress: async (owner: { teamId: string }, body: unknown) => {
        if (options.progressFails) {
          throw Object.assign(new Error('not found'), { code: 'not_found' });
        }
        progress.push([owner.teamId, body]);
        return { revision: 1 };
      },
    } as unknown as BoardBackend;
    return { b, specs, rules, progress };
  }

  const config = TeamPresetConfig.parse({
    ...teamToPresetConfig(team, records(), [
      rule('bd1', 'rv', { enabled: true }),
      rule('ld', 'bd2'),
    ])!.config,
    initialProgress: { next: 'A' },
  });

  it('只有隊長列帶第一個指令；模型與 worktree 照列；規則對到新 session；初始進度卡用 baseRevision 0 寫入', async () => {
    const { b, specs, rules, progress } = backend();
    const rows = presetToPlanRows(config.rows, 'N');
    const result = await runPlan(
      b,
      {
        team: {
          name: 'N',
          goal: '',
          doneCriteria: '',
          color: 'teal',
          contextMd: '',
          taskAuto: true,
        },
        machineId: 'm1',
        cwd: '/repo',
        projectId: null,
        gitOk: true,
        rows,
        leadFirstPrompt: '[Progress card: N] Next: A go',
        rules: config.handoffRules,
        progress: config.initialProgress,
      },
      () => {},
    );
    expect(result.failed).toBe(0);
    expect(specs.map((s) => [s.name, s.firstPrompt, s.model, s.useWorktree])).toEqual([
      ['N-LD', '[Progress card: N] Next: A go', null, false],
      ['N-BD1', null, 'opus', true],
      ['N-data-loader', null, null, true],
      ['N-RV', null, null, false],
    ]);
    expect(rules).toEqual([
      {
        fromSessionId: 'id-N-BD1',
        trigger: 'on_done',
        action: { toSessionId: 'id-N-RV' },
        enabled: true,
      },
      {
        fromSessionId: 'id-N-LD',
        trigger: 'on_done',
        action: { toSessionId: 'id-N-data-loader' },
        enabled: false,
      },
    ]);
    expect(result.rules).toEqual({ created: 2, failed: [], skipped: 0 });
    expect(progress).toEqual([
      ['new', { baseRevision: 0, status: '', next: 'A', blockers: '', gmNotes: '' }],
    ]);
    expect(result.progress).toEqual({ state: 'written' });
  });

  it('某列失敗（409）：其他列照建、不重複建立；連到失敗列的規則略過；進度卡寫入失敗時回報 failed', async () => {
    const { b, specs, rules } = backend({ failSession: 'N-BD1', progressFails: true });
    const rows = presetToPlanRows(config.rows, 'N');
    const steps: string[] = [];
    const result = await runPlan(
      b,
      {
        team: { name: 'N', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
        machineId: 'm1',
        cwd: '/repo',
        projectId: null,
        gitOk: true,
        rows,
        rules: config.handoffRules,
        progress: config.initialProgress,
      },
      (key, step) => steps.push(`${rows.findIndex((r) => r.key === key)}:${step.step}`),
    );
    expect(result.failed).toBe(1);
    expect(specs.map((s) => s.name)).toEqual(['N-LD', 'N-data-loader', 'N-RV']);
    expect(steps.filter((s) => s.startsWith('1:'))).toEqual(['1:session', '1:sessionFailed']);
    expect(rules).toHaveLength(1);
    expect(result.rules.skipped).toBe(1);
    expect(result.progress).toMatchObject({ state: 'failed' });
  });
});
