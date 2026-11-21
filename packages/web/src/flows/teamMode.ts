// 團隊模式（GM 2026-11-21，CONTRACTS §27）的純函式：新增 session 勾團隊模式、選了 Preset（團隊組合）時，
// 隊長就是這個 session，隊員照 Preset 的列開（同一台、同 cwd、沿用 Preset 的權限／模型／worktree 規則），
// 數量受團隊人數上限（含隊長）限制。畫面在 NewSessionPage。
import type {
  PermissionMode,
  Session,
  Team,
  TeamPreset,
  TeamPresetRule,
} from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { createRules } from '../team/handoffRules';
import { presetRuleInputs, presetToPlanRows } from '../team/presetPlan';
import { runPlan } from '../team/runPlan';
import {
  presetRows,
  validatePlan,
  type PlanError,
  type PlanRow,
  type PresetId,
} from '../team/teamPlan';

/** 選了哪一種組合：內建（小隊、標準、探索）或存好的 Preset。'' ＝ 不帶隊員，只開隊長。 */
export type TeamModeChoice = '' | `builtin:${Exclude<PresetId, 'none'>}` | `preset:${string}`;

export interface TeamModeMembers {
  /** 要開的隊員（不含隊長），已依上限截斷。 */
  rows: PlanRow[];
  /** 超過上限沒開的隊員數。 */
  dropped: number;
  /** 存好的 Preset 的交接規則（列序號是 Preset 原本的列）；內建組合沒有。 */
  rules: TeamPresetRule[];
  /**
   * 開好的 session 對到 Preset 原本第幾列：`rowIndex[i]` 是 `rows[i]` 在 Preset 裡的列序號；隊長列另外給
   * （`leadIndex`），建交接規則時換成這個 session。
   */
  rowIndex: number[];
  leadIndex: number | null;
}

const NONE: TeamModeMembers = { rows: [], dropped: 0, rules: [], rowIndex: [], leadIndex: null };

/**
 * 隊員清單。`teamName` 是團隊名稱（＝session 名稱）；`teamLimit` 是團隊人數上限（含隊長），隊員最多
 * `teamLimit - 1` 位；`taken` 是已經存在的 session 名稱（撞名往後編號）。
 */
export function teamModeMembers(
  choice: TeamModeChoice,
  presets: readonly TeamPreset[],
  teamName: string,
  teamLimit: number,
  taken: ReadonlySet<string> = new Set(),
): TeamModeMembers {
  const room = Math.max(0, teamLimit - 1);
  if (choice.startsWith('builtin:')) {
    const id = choice.slice('builtin:'.length) as Exclude<PresetId, 'none'>;
    const all = presetRows(id, teamName, { hasLead: true, taken });
    return {
      rows: all.slice(0, room),
      dropped: Math.max(0, all.length - room),
      rules: [],
      rowIndex: all.slice(0, room).map((_, i) => i + 1),
      leadIndex: 0,
    };
  }
  if (choice.startsWith('preset:')) {
    const preset = presets.find((p) => p.id === choice.slice('preset:'.length));
    if (!preset) return NONE;
    const all = presetToPlanRows(preset.config.rows, teamName, taken);
    const leadIndex = all.findIndex((r) => r.role === 'lead');
    const members = all
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.role !== 'lead');
    const kept = members.slice(0, room);
    return {
      rows: kept.map((m) => m.row),
      dropped: members.length - kept.length,
      rules: preset.config.handoffRules,
      rowIndex: kept.map((m) => m.index),
      leadIndex: leadIndex >= 0 ? leadIndex : null,
    };
  }
  return NONE;
}

/**
 * 隊長＋隊員合起來檢查（同 NewTeamForm 的 validatePlan）：名稱不能重複、主資料夾最多一位會改檔案的
 * （隊長沒開 worktree 又有不開 worktree 的 worker 時）。只有隊長時一律通過。
 */
export function teamModePlanError(
  lead: { name: string; mode: PermissionMode; useWorktree: boolean },
  members: readonly PlanRow[],
  gitOk: boolean,
): PlanError {
  if (members.length === 0) return null;
  const leadRow: PlanRow = {
    key: 'team-mode-lead',
    kind: 'lead',
    role: 'lead',
    nameEdited: true,
    name: lead.name,
    mode: lead.mode,
    worktree: lead.useWorktree,
  };
  return validatePlan([leadRow, ...members], gitOk);
}

/**
 * Preset 的交接規則要用的 session id 陣列（依 Preset 原本的列序號）：隊長列換成這個 session，隊員列換成開好的，
 * 沒開（超過上限、失敗）的是 undefined（presetRuleInputs 會略過指到它的規則）。
 */
export function ruleSessionIds(
  members: TeamModeMembers,
  leadSessionId: string,
  created: ReadonlyMap<string, string>,
): (string | undefined)[] {
  const ids: (string | undefined)[] = [];
  if (members.leadIndex !== null) ids[members.leadIndex] = leadSessionId;
  members.rows.forEach((row, i) => {
    ids[members.rowIndex[i]!] = created.get(row.key);
  });
  return ids;
}

export interface TeamModeStartResult {
  /** 隊長所在的團隊（找不到＝hub 沒建，例如舊 hub）。 */
  teamId: string | null;
  created: number;
  failed: number;
  rulesCreated: number;
  rulesFailed: number;
}

/**
 * 隊長建好之後開隊員：找到 hub 建的團隊（名稱＝session 名稱、隊長＝這個 session），沿用 runPlan 補成員
 * （同機器、同 cwd、worktree 照 Preset 的列與角色規則，部分失敗保留已建的），再照 Preset 建交接規則。
 */
export async function startTeamMembers(
  backend: BoardBackend,
  input: {
    lead: Session;
    members: TeamModeMembers;
    machineId: string;
    cwd: string;
    projectId: string | null;
    gitOk: boolean;
  },
): Promise<TeamModeStartResult> {
  const { lead, members } = input;
  const empty = { created: 0, failed: 0, rulesCreated: 0, rulesFailed: 0 };
  let team: Team | null = null;
  for (const candidate of (await backend.listTeams()).filter((t) => t.name === lead.name)) {
    const roster = await backend.listTeamMembers(candidate.id);
    if (roster.some((m) => m.sessionId === lead.id && m.role === 'lead')) {
      team = candidate;
      break;
    }
  }
  if (!team) return { teamId: null, ...empty };
  if (members.rows.length === 0) return { teamId: team.id, ...empty };
  const result = await runPlan(
    backend,
    {
      team: { existing: team },
      machineId: input.machineId,
      cwd: input.cwd,
      projectId: input.projectId,
      gitOk: input.gitOk,
      rows: members.rows,
    },
    () => {},
  );
  let rulesCreated = 0;
  let rulesFailed = 0;
  if (members.rules.length > 0) {
    const { inputs } = presetRuleInputs(
      members.rules,
      ruleSessionIds(members, lead.id, result.sessionIds),
    );
    const made = await createRules(backend, team.id, inputs);
    rulesCreated = made.created.length;
    rulesFailed = made.failed.length;
  }
  return {
    teamId: team.id,
    created: result.sessionIds.size,
    failed: result.failed,
    rulesCreated,
    rulesFailed,
  };
}
