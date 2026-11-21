// 團隊模式（GM 2026-11-21，CONTRACTS §27）：固定守則、claude --help 偵測、協定只收布林。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOSTAFF_OFF_GUIDE,
  LEAD_STAFFING_RHYTHM,
  TEAM_MODE_GUIDE_CHARS,
  TEAM_MODE_INTRO,
  TEAM_MODE_PRESET_MEMBERS,
  teamModeGuide,
} from './leadGuide';
import {
  parseClaudeHelp,
  TEAM_MODE_CODEX_MIN_VERSION,
  teamModeSupport,
  versionAtLeast,
} from './modelOptions';
import { MachineCapabilities, Session, Settings, TeamModeInfo } from './models';
import { routes } from './rest';
import { SessionSpec } from './ws';

// claude 2.1.329 `--help` 的實際寫法（節錄，2026-11-21 本機）。
const HELP_2_1_329 = `Usage: claude [options] [command] [prompt]

Options:
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
      Edit")
  --append-system-prompt <prompt>       Add text to the end of the default
                                        system prompt
  --autocompact <auto|tokens>           Auto-compact window size (auto, or at
                                        least 100k tokens)
`;

describe('團隊模式的守則（固定文字）', () => {
  const all = [
    { autoStaff: true, presetMembers: false },
    { autoStaff: true, presetMembers: true },
    { autoStaff: false, presetMembers: false },
    { autoStaff: false, presetMembers: true },
  ];

  it('四種組合（窮舉）等於 fixtures/team-mode-guides.json 寫死的全文：改守則要連 fixture 一起改、一起審', () => {
    const fixed = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/team-mode-guides.json'), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(fixed)).toHaveLength(4);
    for (const flags of all) {
      const key = `autoStaff=${flags.autoStaff},presetMembers=${flags.presetMembers}`;
      expect(teamModeGuide(flags), key).toBe(fixed[key]);
    }
    // 只收兩個布林：多給的欄位不影響結果（型別上也只收這兩個）。
    expect(teamModeGuide({ autoStaff: true, presetMembers: false, text: 'x' } as never)).toBe(
      fixed['autoStaff=true,presetMembers=false'],
    );
  });

  it('四種組合都只有 cmd.exe／TOML 安全的字元、不太長', () => {
    for (const flags of all) {
      const text = teamModeGuide(flags);
      expect(text, JSON.stringify(flags)).toMatch(TEAM_MODE_GUIDE_CHARS);
      expect(text.length).toBeLessThan(3000);
    }
  });

  it('開頭說你是隊長、先 list_members；Preset 隊員那句只在 presetMembers 時出現', () => {
    const plain = teamModeGuide({ autoStaff: true, presetMembers: false });
    expect(plain.startsWith(TEAM_MODE_INTRO)).toBe(true);
    expect(plain).toContain('list_members');
    expect(plain).toContain('spawn_member');
    expect(plain).toContain('release_member');
    expect(plain).toContain('send_task');
    expect(plain).not.toContain(TEAM_MODE_PRESET_MEMBERS);
    expect(teamModeGuide({ autoStaff: true, presetMembers: true })).toContain(
      TEAM_MODE_PRESET_MEMBERS,
    );
  });

  it('隊長自主擴編關著：改成只能用現有隊員（AUTOSTAFF_OFF_GUIDE 的意思），不叫它 spawn_member', () => {
    const fixed = teamModeGuide({ autoStaff: false, presetMembers: false });
    expect(AUTOSTAFF_OFF_GUIDE).toMatch(/cannot add or release members/);
    expect(fixed).toMatch(/cannot add or release members/);
    expect(fixed).not.toContain('spawn_member');
  });

  it('節奏以 LEAD_STAFFING_RHYTHM 為基礎（同樣五步）', () => {
    const text = teamModeGuide({ autoStaff: true, presetMembers: false });
    for (const step of ['(1)', '(2)', '(3)', '(4)', '(5)']) {
      expect(LEAD_STAFFING_RHYTHM).toContain(step);
      expect(text).toContain(step);
    }
  });
});

describe('claude --help：--append-system-prompt', () => {
  it('2.1.329 有這個選項（互動模式可用）', () => {
    expect(parseClaudeHelp(HELP_2_1_329).appendSystemPrompt).toBe(true);
  });

  it('沒有、只能配 --print、只有 -file 變體：都當不支援', () => {
    expect(parseClaudeHelp('Options:\n  --model <m>  Model.\n').appendSystemPrompt).toBe(false);
    expect(
      parseClaudeHelp('Options:\n  --append-system-prompt <p>  Append (only works with --print)\n')
        .appendSystemPrompt,
    ).toBe(false);
    expect(
      parseClaudeHelp('Options:\n  --append-system-prompt-file <f>  Append file\n')
        .appendSystemPrompt,
    ).toBe(false);
  });

  it('teamModeSupport：daemon 太舊＝unavailable；Claude 看 appendSystemPrompt；Codex 不看 claude', () => {
    const flags = { effort: true, efforts: null, fallbackModel: true };
    expect(teamModeSupport('claude', undefined)).toBe('unavailable');
    expect(teamModeSupport('claude', { claudeFlags: { ...flags, appendSystemPrompt: true } })).toBe(
      'unavailable',
    );
    expect(
      teamModeSupport('claude', {
        teamMode: true,
        claudeFlags: { ...flags, appendSystemPrompt: true },
      }),
    ).toBe('ok');
    // 0.1.15 的偵測結果沒有這個鍵＝不知道＝不帶。
    expect(teamModeSupport('claude', { teamMode: true, claudeFlags: flags })).toBe('no_guide');
    expect(teamModeSupport('claude', { teamMode: true, claudeFlags: null })).toBe('no_guide');
    expect(
      teamModeSupport('codex', { teamMode: true, claudeFlags: null, codexVersion: '0.167.0' }),
    ).toBe('ok');
    expect(teamModeSupport('codex', { teamMode: true, codexVersion: '0.170.2' })).toBe('ok');
    expect(teamModeSupport('codex', {})).toBe('unavailable');
    // Codex 太舊或版本讀不到（W4）：Codex 不能開團隊模式。
    expect(teamModeSupport('codex', { teamMode: true, codexVersion: '0.166.9' })).toBe(
      'codex_too_old',
    );
    expect(teamModeSupport('codex', { teamMode: true, codexVersion: null })).toBe('codex_too_old');
    expect(teamModeSupport('codex', { teamMode: true, codexVersion: 'garbage' })).toBe(
      'codex_too_old',
    );
  });

  it('versionAtLeast：只比前三段', () => {
    expect(versionAtLeast('0.167.0', TEAM_MODE_CODEX_MIN_VERSION)).toBe(true);
    expect(versionAtLeast('1.0.0', '0.167.0')).toBe(true);
    expect(versionAtLeast('0.167.0-alpha.1', '0.167.0')).toBe(true);
    expect(versionAtLeast('0.99.99', '0.167.0')).toBe(false);
    expect(versionAtLeast(undefined, '0.167.0')).toBe(false);
  });
});

describe('協定：只收布林', () => {
  const base = {
    name: 'x',
    projectId: null,
    cwd: '/a',
    useWorktree: false,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    resumeClaudeSessionId: null,
    firstPrompt: null,
  };

  it('SessionSpec.teamLead 只有兩個布林，多的欄位（例如文字）拒絕', () => {
    expect(
      SessionSpec.parse({ ...base, teamLead: { autoStaff: true, presetMembers: false } }).teamLead,
    ).toEqual({ autoStaff: true, presetMembers: false });
    expect(
      SessionSpec.safeParse({
        ...base,
        teamLead: { autoStaff: true, presetMembers: false, text: 'hi' },
      }).success,
    ).toBe(false);
    expect(SessionSpec.safeParse({ ...base, teamLead: 'be a lead' }).success).toBe(false);
  });

  it('REST 建立 session：teamMode 只收布林、隊員只收結構化列（不收自由文字欄位），teamLead 被丟掉', () => {
    const body = routes.sessionsCreate.body;
    const machine = { ...base, machineId: '00000000-0000-4000-8000-000000000001' };
    const member = {
      name: 'x-BD1',
      role: 'worker',
      permissionMode: 'acceptEdits',
      model: null,
      useWorktree: true,
    };
    const parsed = body.parse({
      ...machine,
      teamMode: true,
      teamMembers: [member],
      teamLead: { autoStaff: true, presetMembers: true },
    }) as Record<string, unknown>;
    expect(parsed.teamMode).toBe(true);
    expect(parsed.teamMembers).toEqual([member]);
    expect(parsed).not.toHaveProperty('teamLead');
    expect(body.safeParse({ ...machine, teamMode: 'on' }).success).toBe(false);
    for (const bad of [
      { ...member, prompt: 'be nice' },
      { ...member, role: 'lead' },
      { ...member, model: 'a b' },
      { ...member, name: '' },
    ]) {
      expect(body.safeParse({ ...machine, teamMode: true, teamMembers: [bad] }).success).toBe(
        false,
      );
    }
    expect(
      body.safeParse({ ...machine, teamMode: true, teamMembers: Array(20).fill(member) }).success,
    ).toBe(false);
  });

  it('舊資料相容：Settings 沒有 teamModeDefault＝false；Session、capabilities 的欄位是選填', () => {
    const caps = { hasGpu: false, gpuName: null, cpuCores: 1, memoryBytes: 0, claudeVersion: null };
    expect(MachineCapabilities.parse(caps).teamMode).toBeUndefined();
    expect(MachineCapabilities.parse({ ...caps, teamMode: true }).teamMode).toBe(true);
    expect(Session.shape.teamMode.safeParse(undefined).success).toBe(true);
    expect(Session.shape.teamMode.safeParse(false).success).toBe(false);
    expect(Settings.shape.teamModeDefault.parse(undefined)).toBe(false);
    expect(
      TeamModeInfo.parse({
        defaultOn: true,
        dispatch: true,
        codexMcp: false,
        autoStaff: true,
        teamLimit: 12,
      }).defaultOn,
    ).toBe(true);
  });
});
