// 團隊模式（CONTRACTS §27）：Preset 隊員清單與人數上限、隊長＋隊員的檢查、建立後照 Preset 開隊員與交接規則。
import { TeamPresetConfig, type TeamPreset } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import type { BoardBackend } from '../shared/backend';
import { createFakeBackend } from '../shared/fakeBackend';
import {
  createTeamModeRules,
  ruleSessionIds,
  teamMembersInput,
  teamModeMembers,
  teamModePlanError,
} from './teamMode';

const preset: TeamPreset = {
  id: 'p1',
  name: 'Review squad',
  config: TeamPresetConfig.parse({
    teamType: 'dev',
    color: 'lime',
    goal: '',
    doneCriteria: '',
    contextMd: '',
    placement: { machineId: 'm1', cwd: '/repo', projectId: null },
    rows: [
      {
        kind: 'worker',
        permissionMode: 'acceptEdits',
        model: 'sonnet',
        useWorktree: null,
        label: null,
      },
      { kind: 'lead', permissionMode: 'default', model: null, useWorktree: null, label: null },
      { kind: 'reviewer', permissionMode: 'plan', model: null, useWorktree: null, label: 'QA' },
    ],
    handoffRules: [
      { fromRow: 0, toRow: 2, trigger: 'on_done', enabled: true },
      { fromRow: 2, toRow: 1, trigger: 'on_done', enabled: true },
    ],
    taskAuto: false,
  }),
  position: 0,
  createdAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:00.000Z',
  lastUsedAt: null,
};

describe('teamModeMembers', () => {
  it('不選＝只開隊長', () => {
    expect(teamModeMembers('', [preset], 'Alpha', 12).rows).toEqual([]);
  });

  it('內建組合：拿掉隊長列，名稱照團隊名稱', () => {
    const m = teamModeMembers('builtin:standard', [], 'Alpha', 12);
    expect(m.rows.map((r) => [r.role, r.name])).toEqual([
      ['worker', 'Alpha-BD1'],
      ['worker', 'Alpha-BD2'],
      ['reviewer', 'Alpha-RV'],
    ]);
    expect(m.dropped).toBe(0);
  });

  it('存好的 Preset：隊長列（不一定在第一列）拿掉，沿用模式、模型、label，記下原本的列序號與規則', () => {
    const m = teamModeMembers('preset:p1', [preset], 'Alpha', 12);
    expect(m.rows.map((r) => [r.role, r.name, r.mode, r.model])).toEqual([
      ['worker', 'Alpha-BD1', 'acceptEdits', 'sonnet'],
      ['reviewer', 'Alpha-QA', 'plan', null],
    ]);
    expect(m.rowIndex).toEqual([0, 2]);
    expect(m.leadIndex).toBe(1);
    expect(m.rules).toHaveLength(2);
    // 找不到的 Preset（被刪了）＝只開隊長。
    expect(teamModeMembers('preset:gone', [preset], 'Alpha', 12).rows).toEqual([]);
  });

  it('人數上限（含隊長）：只開到上限，回報少開幾位', () => {
    const two = teamModeMembers('builtin:standard', [], 'Alpha', 2);
    expect(two.rows.map((r) => r.name)).toEqual(['Alpha-BD1']);
    expect(two.dropped).toBe(2);
    const one = teamModeMembers('preset:p1', [preset], 'Alpha', 1);
    expect(one.rows).toEqual([]);
    expect(one.dropped).toBe(2);
  });

  it('撞名往後編號', () => {
    const m = teamModeMembers('builtin:squad', [], 'Alpha', 12, new Set(['Alpha-BD1']));
    expect(m.rows.map((r) => r.name)).toEqual(['Alpha-BD2']);
  });
});

describe('teamModePlanError', () => {
  it('隊長留在主資料夾、又有不開 worktree 的 worker：sharedWriters；不是 git 時 worker 開不了 worktree 也一樣', () => {
    const lead = { name: 'Alpha', mode: 'default' as const, useWorktree: false };
    const rows = teamModeMembers('builtin:squad', [], 'Alpha', 12).rows;
    expect(teamModePlanError(lead, rows, true)).toBeNull();
    expect(teamModePlanError(lead, rows, false)).toBe('sharedWriters');
    expect(teamModePlanError(lead, [], false)).toBeNull();
    // 隊員和隊長同名。
    const clash = teamModeMembers('builtin:squad', [], 'Alpha', 12).rows.map((r) => ({
      ...r,
      name: 'Alpha',
    }));
    expect(teamModePlanError(lead, clash, true)).toBe('duplicateName');
  });
});

describe('ruleSessionIds', () => {
  it('隊長列換成這個 session，隊員換成開好的，沒開的 undefined', () => {
    const m = teamModeMembers('preset:p1', [preset], 'Alpha', 2);
    const created = new Map([[m.rows[0]!.key, 'bd']]);
    expect(ruleSessionIds(m, 'lead', created)).toEqual(['bd', 'lead']);
  });
});

/** 假後端目前的快照（watchBoard 一監聽就給一次）。 */
function snapshot(backend: BoardBackend) {
  let snap: Parameters<Parameters<BoardBackend['watchBoard']>[0]>[0] | null = null;
  backend.watchBoard((s) => {
    snap = s;
  })();
  return snap!;
}

describe('teamMembersInput／createTeamModeRules（假後端，審查 W2：隊員由 hub 在同一個請求裡開）', () => {
  const lead = (backend: BoardBackend, machineId: string, extra: Record<string, unknown>) =>
    backend.createSession({
      name: 'Alpha',
      machineId,
      projectId: null,
      cwd: '/home/demo/alpha',
      useWorktree: false,
      permissionMode: 'default',
      model: null,
      accountProfile: null,
      resumeClaudeSessionId: null,
      firstPrompt: null,
      readOnly: false,
      ...extra,
    });

  it('送給 hub 的列：角色、模式、模型、worktree 照規則（不是 git 就不開）；不帶唯讀與隊長', () => {
    const members = teamModeMembers('preset:p1', [preset], 'Alpha', 12);
    expect(teamMembersInput(members, true)).toEqual([
      {
        name: 'Alpha-BD1',
        role: 'worker',
        permissionMode: 'acceptEdits',
        model: 'sonnet',
        useWorktree: true,
      },
      {
        name: 'Alpha-QA',
        role: 'reviewer',
        permissionMode: 'plan',
        model: null,
        useWorktree: false,
      },
    ]);
    expect(teamMembersInput(members, false)[0]!.useWorktree).toBe(false);
  });

  it('一次建立：隊長＋隊員都在同一隊、回應帶 teamModeResult；交接規則照 Preset 建（指到沒開的略過）', async () => {
    const backend = createFakeBackend();
    const machine = snapshot(backend).machines.find((m) => m.online && m.capabilities.teamMode)!;
    const members = teamModeMembers('preset:p1', [preset], 'Alpha', 12);
    const created = await lead(backend, machine.id, {
      teamMode: true,
      teamMembers: teamMembersInput(members, true),
    });
    expect(created.teamMode).toBe(true);
    const result = created.teamModeResult!;
    expect(result.members.map((m) => [m.index, m.name])).toEqual([
      [0, 'Alpha-BD1'],
      [1, 'Alpha-QA'],
    ]);
    expect(result.failed).toEqual([]);
    const roster = await backend.listTeamMembers(result.teamId);
    expect(roster.map((m) => m.role).sort()).toEqual(['lead', 'reviewer', 'worker']);
    const sessions = snapshot(backend).sessions.filter((s) => s.name.startsWith('Alpha-'));
    expect(sessions.map((s) => [s.name, s.readOnly]).sort()).toEqual([
      ['Alpha-BD1', false],
      ['Alpha-QA', true],
    ]);
    expect(await createTeamModeRules(backend, created, members, result)).toEqual({
      created: 2,
      failed: 0,
    });
  });

  it('沒選組合：沒有 teamModeResult 的隊員，也不建規則', async () => {
    const backend = createFakeBackend();
    const machine = snapshot(backend).machines.find((m) => m.online && m.capabilities.teamMode)!;
    const created = await lead(backend, machine.id, { teamMode: true });
    expect(created.teamModeResult?.members).toEqual([]);
    const none = teamModeMembers('', [preset], 'Alpha', 12);
    expect(await createTeamModeRules(backend, created, none, created.teamModeResult!)).toEqual({
      created: 0,
      failed: 0,
    });
  });
});
