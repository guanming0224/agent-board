import type { Session, Team, TeamMember } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import type { BoardBackend } from '../shared/backend';
import { runPlan, type RowStep } from './runPlan';
import {
  addRow,
  changeRole,
  defaultNames,
  modesFor,
  presetRows,
  renameRows,
  isReadOnlyRole,
  ROLE_ABBR,
  ROLE_DEFAULT_MODE,
  rowUsesWorktree,
  changeKind,
  phaseRows,
  validatePlan,
  type ExistingTeam,
  type PlanRow,
} from './teamPlan';

const roles = (rows: PlanRow[]) => rows.map((r) => r.role);
const names = (rows: PlanRow[]) => rows.map((r) => r.name);

describe('預設組合與命名', () => {
  it('三種組合的角色、名稱與權限', () => {
    const squad = presetRows('squad', '搬遷');
    expect(roles(squad)).toEqual(['lead', 'worker']);
    expect(names(squad)).toEqual(['搬遷-LD', '搬遷-BD1']);
    expect(squad.map((r) => r.mode)).toEqual(['default', 'acceptEdits']);

    const standard = presetRows('standard', '搬遷');
    expect(names(standard)).toEqual(['搬遷-LD', '搬遷-BD1', '搬遷-BD2', '搬遷-RV']);
    expect(standard.map((r) => r.mode)).toEqual(['default', 'acceptEdits', 'acceptEdits', 'plan']);

    const explore = presetRows('explore', '搬遷');
    expect(names(explore)).toEqual(['搬遷-LD', '搬遷-RS', '搬遷-BD1']);
    expect(explore[1]!.mode).toBe('plan');

    expect(presetRows('none', '搬遷')).toEqual([]);
  });

  it('唯讀的 RS／RV 不能選 bypassPermissions；dontAsk 仍可選', () => {
    expect(modesFor('reviewer')).not.toContain('bypassPermissions');
    expect(modesFor('researcher')).not.toContain('bypassPermissions');
    expect(modesFor('reviewer')).toContain('dontAsk');
    expect(modesFor('worker')).toContain('bypassPermissions');
  });

  it('預設權限沒有 bypassPermissions、dontAsk', () => {
    expect(Object.values(ROLE_DEFAULT_MODE)).not.toContain('bypassPermissions');
    expect(Object.values(ROLE_DEFAULT_MODE)).not.toContain('dontAsk');
  });

  it('同角色兩位以上才編號；沒有團隊名稱時只有縮寫', () => {
    expect(defaultNames('X', ['lead', 'reviewer', 'reviewer'])).toEqual(['X-LD', 'X-RV1', 'X-RV2']);
    expect(defaultNames('  ', ['lead', 'worker'])).toEqual(['LD', 'BD1']);
  });

  it('改團隊名稱時，沒改過的名稱跟著換，改過的不動', () => {
    const rows = presetRows('squad', 'A');
    const edited = rows.map((r, i) => (i === 1 ? { ...r, name: '我的', nameEdited: true } : r));
    expect(names(renameRows(edited, 'B'))).toEqual(['B-LD', '我的']);
  });

  it('加一位、換角色：權限換成新角色的預設，名稱重新編號', () => {
    let rows = addRow(presetRows('squad', 'A'), 'worker', 'A');
    expect(names(rows)).toEqual(['A-LD', 'A-BD1', 'A-BD2']);
    rows = changeRole(rows, rows[1]!.key, 'reviewer', 'A');
    expect(names(rows)).toEqual(['A-LD', 'A-RV', 'A-BD1']);
    expect(rows[1]!.mode).toBe('plan');
  });
});

describe('validatePlan', () => {
  it('只建團隊（沒有列）一律通過', () => {
    expect(validatePlan([], true)).toBeNull();
    expect(validatePlan([], false)).toBeNull();
  });

  it('要剛好一位隊長', () => {
    const rows = presetRows('standard', 'A');
    expect(validatePlan(rows, true)).toBeNull();
    expect(validatePlan(rows.slice(1), true)).toBe('leadCount');
    expect(validatePlan(changeRole(rows, rows[1]!.key, 'lead', 'A'), true)).toBe('leadCount');
  });

  it('名稱不能空白或重複', () => {
    const rows = presetRows('squad', 'A');
    expect(validatePlan([rows[0]!, { ...rows[1]!, name: ' ' }], true)).toBe('emptyName');
    expect(validatePlan([rows[0]!, { ...rows[1]!, name: 'A-LD' }], true)).toBe('duplicateName');
  });

  it('主資料夾只能有一位會改檔案的：不是 git 時的 BD；RS／RV 不論權限模式都是唯讀', () => {
    const rows = presetRows('standard', 'A');
    expect(validatePlan(rows, true)).toBeNull();
    // 唯讀靠 session 的 readOnly（拿掉改檔工具），不靠 plan：審查改成 default 仍是唯讀。
    const defaultReviewer = rows.map((r) =>
      r.role === 'reviewer' ? { ...r, mode: 'default' as const } : r,
    );
    expect(validatePlan(defaultReviewer, true)).toBeNull();
    // 不是 git：BD 開不了 worktree，會和 LD 共用資料夾。
    expect(validatePlan(rows, false)).toBe('sharedWriters');
    // 勾了「共用資料夾」（§24）：使用者同意 BD 和 LD 共用，不擋。
    expect(validatePlan(rows, false, undefined, true)).toBeNull();
    // 其他檢查照舊。
    expect(validatePlan([...rows, { ...rows[0]! }], false, undefined, true)).toBe('leadCount');
    // 不是 git 也可以：只有 LD 會改檔案，其他人只讀。
    expect(validatePlan(presetRows('explore', 'A').slice(0, 2), false)).toBeNull();
  });

  it('只有 BD 開 worktree，而且要是 git', () => {
    expect(rowUsesWorktree({ role: 'worker' }, true)).toBe(true);
    expect(rowUsesWorktree({ role: 'worker' }, false)).toBe(false);
    expect(rowUsesWorktree({ role: 'lead' }, true)).toBe(false);
    expect(rowUsesWorktree({ role: 'reviewer' }, true)).toBe(false);
    // 測試（Q5）：會寫測試檔，和成員一樣開自己的 worktree、不唯讀，預設每步問。
    expect(rowUsesWorktree({ role: 'tester' }, true)).toBe(true);
    expect(isReadOnlyRole('tester')).toBe(false);
    expect(ROLE_DEFAULT_MODE.tester).toBe('default');
    expect(ROLE_ABBR.tester).toBe('QA');
  });
});

describe('runPlan', () => {
  const team: Team = {
    id: 't1',
    name: 'A',
    goal: '',
    doneCriteria: '',
    color: 'teal',
    contextMd: '',
    zoneId: 'main',
  };

  function fakeBackend(failSession: string[] = [], failMember: string[] = []) {
    const calls: string[] = [];
    const specs: unknown[] = [];
    const backend = {
      createTeam: async () => {
        calls.push('team');
        return team;
      },
      createSession: async (spec: { name: string }) => {
        calls.push(`session:${spec.name}`);
        specs.push(spec);
        if (failSession.includes(spec.name)) throw new Error('machine_offline');
        return { id: `id-${spec.name}` } as Session;
      },
      putTeamMember: async (
        teamId: string,
        sessionId: string,
        role: TeamMember['role'],
        kind?: string,
      ) => {
        calls.push(`member:${sessionId}:${role}${kind ? `:${kind}` : ''}`);
        if (failMember.includes(sessionId)) throw new Error('worktree_required');
        return { teamId, sessionId, role };
      },
      deleteTeam: async () => calls.push('deleteTeam'),
      deleteSession: async () => calls.push('deleteSession'),
    } as unknown as BoardBackend;
    return { backend, calls, specs };
  }

  const input = (rows: PlanRow[]) => ({
    team: { name: 'A', goal: 'g', doneCriteria: '', color: 'teal', contextMd: '' },
    machineId: 'm1',
    cwd: '/r',
    projectId: null,
    gitOk: true,
    rows,
  });

  it('建團隊、依序建 session 再加入，BD 開 worktree、其他不開', async () => {
    const { backend, calls, specs } = fakeBackend();
    const rows = presetRows('standard', 'A');
    const steps: [string, RowStep['step']][] = [];
    const result = await runPlan(backend, input(rows), (k, s) => steps.push([k, s.step]));
    expect(result.team).toEqual(team);
    expect(result.failed).toBe(0);
    expect([...result.sessionIds.values()]).toEqual(['id-A-LD', 'id-A-BD1', 'id-A-BD2', 'id-A-RV']);
    expect(calls).toEqual([
      'team',
      'session:A-LD',
      'member:id-A-LD:lead',
      'session:A-BD1',
      'member:id-A-BD1:worker',
      'session:A-BD2',
      'member:id-A-BD2:worker',
      'session:A-RV',
      'member:id-A-RV:reviewer',
    ]);
    expect(specs.map((s) => (s as { useWorktree: boolean }).useWorktree)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(specs.map((s) => (s as { readOnly: boolean }).readOnly)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(specs.map((s) => (s as { permissionMode: string }).permissionMode)).toEqual([
      'default',
      'acceptEdits',
      'acceptEdits',
      'plan',
    ]);
    expect(steps.filter(([k]) => k === rows[0]!.key).map(([, s]) => s)).toEqual([
      'session',
      'member',
      'done',
    ]);
  });

  it('部分失敗：繼續下一列，記下哪一列在哪一步失敗，不刪任何東西', async () => {
    const { backend, calls } = fakeBackend(['A-BD1'], ['id-A-RV']);
    const rows = presetRows('standard', 'A');
    const last = new Map<string, RowStep>();
    const result = await runPlan(backend, input(rows), (k, s) => last.set(k, s));
    expect(result.failed).toBe(2);
    expect(last.get(rows[0]!.key)?.step).toBe('done');
    expect(last.get(rows[1]!.key)?.step).toBe('sessionFailed');
    expect(last.get(rows[2]!.key)?.step).toBe('done');
    expect(last.get(rows[3]!.key)).toMatchObject({ step: 'memberFailed', sessionId: 'id-A-RV' });
    expect(calls).not.toContain('deleteTeam');
    expect(calls).not.toContain('deleteSession');
  });

  it('建立團隊失敗就停，不建 session', async () => {
    const { backend, calls } = fakeBackend();
    backend.createTeam = async () => {
      throw new Error('hub down');
    };
    await expect(runPlan(backend, input(presetRows('squad', 'A')), () => {})).rejects.toThrow(
      'hub down',
    );
    expect(calls).toEqual([]);
  });
});

describe('學術研究團隊（依階段組隊）', () => {
  it('四個階段的組合、命名（EX 一律編號、WR 單獨不編號）與角色', () => {
    const topic = phaseRows('topic', '論文');
    expect(names(topic)).toEqual(['論文-LD', '論文-LR1', '論文-LR2']);
    expect(roles(topic)).toEqual(['lead', 'researcher', 'researcher']);
    expect(names(phaseRows('experiment', '論文'))).toEqual([
      '論文-LD',
      '論文-EX1',
      '論文-EX2',
      '論文-RV',
    ]);
    const writing = phaseRows('writing', '論文');
    expect(names(writing)).toEqual(['論文-LD', '論文-WR', '論文-RV', '論文-EX1']);
    expect(writing.map((r) => r.kind)).toEqual(['ld', 'wr', 'rv', 'ex']);
    // 實驗、寫作都是 worker（開 worktree、acceptEdits），審稿是唯讀的 reviewer。
    expect(roles(writing)).toEqual(['lead', 'worker', 'reviewer', 'worker']);
    expect(writing.map((r) => r.mode)).toEqual(['default', 'acceptEdits', 'plan', 'acceptEdits']);
    expect(names(phaseRows('revision', '論文'))).toEqual([
      '論文-LD',
      '論文-EX1',
      '論文-WR',
      '論文-RV',
    ]);
  });

  it('研究列換分工：EX 改成 WR 還是 worker，名稱跟著換', () => {
    const rows = phaseRows('experiment', 'P');
    const next = changeKind(rows, rows[2]!.key, 'wr', 'P');
    expect(names(next)).toEqual(['P-LD', 'P-EX1', 'P-WR', 'P-RV']);
    expect(next[2]).toMatchObject({ kind: 'wr', role: 'worker', mode: 'acceptEdits' });
  });

  it('寫作階段在 git 資料夾通過檢查；不是 git 時 WR、EX 和 LD 擠在主資料夾', () => {
    expect(validatePlan(phaseRows('writing', 'P'), true)).toBeNull();
    expect(validatePlan(phaseRows('writing', 'P'), false)).toBe('sharedWriters');
    expect(validatePlan(phaseRows('topic', 'P'), false)).toBeNull();
  });
});

describe('補成員（現有團隊）', () => {
  const existing = (over: Partial<ExistingTeam> = {}): ExistingTeam => ({
    members: 2,
    leads: 1,
    mainWriters: 1,
    names: new Set(['A-LD', 'A-BD1']),
    ...over,
  });

  it('名稱接著現有的編號，不撞名', () => {
    expect(defaultNames('A', ['worker'], new Set(['A-BD1']))).toEqual(['A-BD2']);
    expect(defaultNames('A', ['worker', 'worker'], new Set(['A-BD1', 'A-BD3']))).toEqual([
      'A-BD2',
      'A-BD4',
    ]);
    expect(defaultNames('A', ['reviewer'], new Set(['A-RV']))).toEqual(['A-RV2']);
    expect(defaultNames('A', ['reviewer'], new Set(['A-RV1']))).toEqual(['A-RV']);
  });

  it('團隊已有隊長：組合裡的隊長拿掉', () => {
    const rows = presetRows('standard', 'A', { taken: new Set(['A-LD', 'A-BD1']), hasLead: true });
    expect(names(rows)).toEqual(['A-BD2', 'A-BD3', 'A-RV']);
    expect(names(phaseRows('writing', 'A', { hasLead: true }))).toEqual(['A-WR', 'A-RV', 'A-EX1']);
  });

  it('檢查連同現有成員：隊長最多一位、名稱不撞、主資料夾寫入者一起算', () => {
    const taken = new Set(['A-LD', 'A-BD1']);
    const rows = presetRows('standard', 'A', { taken, hasLead: true });
    expect(validatePlan(rows, true, existing())).toBeNull();
    // 再加一位隊長：現有的隊長也算。
    const withLead = presetRows('standard', 'A', { taken });
    expect(validatePlan(withLead, true, existing())).toBe('leadCount');
    // 使用者把名稱改成現有 session 的名稱。
    const clash = rows.map((r, i) => (i === 0 ? { ...r, name: 'A-BD1', nameEdited: true } : r));
    expect(validatePlan(clash, true, existing())).toBe('duplicateName');
    // 不是 git：新的 BD 留在主資料夾，和現有的隊長（寫入者）衝突。
    expect(validatePlan(rows, false, existing())).toBe('sharedWriters');
    // 既有團隊是（或這次勾了）共用資料夾：連同現有寫入者都不擋（§24）。
    expect(validatePlan(rows, false, existing(), true)).toBeNull();
    // 現有成員本來就沒有隊長：補成員不強迫加隊長。
    expect(validatePlan(rows, true, existing({ leads: 0, mainWriters: 0 }))).toBeNull();
    // 團隊還沒有成員：和新團隊一樣要剛好一位隊長。
    expect(validatePlan(rows, true, existing({ members: 0, leads: 0, mainWriters: 0 }))).toBe(
      'leadCount',
    );
  });

  it('runPlan 用現有團隊：不建立團隊，研究分工一起存', async () => {
    const calls: string[] = [];
    const backend = {
      createTeam: async () => {
        calls.push('team');
        return team0;
      },
      createSession: async (spec: { name: string }) => ({ id: `id-${spec.name}` }) as Session,
      putTeamMember: async (_t: string, sessionId: string, role: string, kind?: string) => {
        calls.push(`member:${sessionId}:${role}:${kind ?? '-'}`);
        return {};
      },
    } as unknown as BoardBackend;
    const team0: Team = { ...baseTeam, phase: 'writing' };
    const rows = phaseRows('writing', 'A', { hasLead: true });
    const result = await runPlan(
      backend,
      { team: { existing: team0 }, machineId: 'm', cwd: '/r', projectId: null, gitOk: true, rows },
      () => {},
    );
    expect(result.team).toBe(team0);
    expect(calls).toEqual([
      'member:id-A-WR:worker:wr',
      'member:id-A-RV:reviewer:rv',
      'member:id-A-EX1:worker:ex',
    ]);
  });
});

const baseTeam: Team = {
  id: 't0',
  name: 'A',
  goal: '',
  doneCriteria: '',
  color: 'teal',
  contextMd: '',
  zoneId: 'main',
};
