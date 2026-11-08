// 團隊 Presets（P3 項目二）的純函式：Preset 的列 ↔ 建立團隊用的 PlanRow、交接規則的列序號對應、
// 從現有團隊擷取成 Preset、撞名自動編號、清單上的摘要。畫面在 Presets.tsx。
import {
  TEAM_PRESET_LABEL_MAX,
  type HandoffRule,
  type Session,
  type Team,
  type TeamMember,
  type TeamPreset,
  type TeamPresetConfig,
  type TeamPresetConfigInput,
  type TeamPresetProgress,
  type TeamPresetRow,
  type TeamPresetRule,
} from '@agent-board/protocol';
import type { RuleInput } from './handoffRules';
import { memberKind } from './research';
import {
  defaultNames,
  KIND_ABBR,
  kindRole,
  renameRows,
  type PlanRow,
  type RowKind,
} from './teamPlan';

let nextKey = 0;
const newKey = () => `preset-row-${(nextKey += 1)}`;

const fullName = (teamName: string, label: string) => {
  const prefix = teamName.trim();
  return prefix ? `${prefix}-${label}` : label;
};

/**
 * Preset 的列 → PlanRow。有 label 的列名稱是 `<團隊名>-<label>`（算「改過名稱」，不跟著重新編號）；
 * 其他照預設命名（LD、BD1…），避開 `taken`。團隊名稱改了就重新呼叫一次。
 */
export function presetToPlanRows(
  rows: readonly TeamPresetRow[],
  teamName: string,
  taken: ReadonlySet<string> = new Set(),
): PlanRow[] {
  const plan = rows.map((row): PlanRow => ({
    key: newKey(),
    kind: row.kind,
    role: kindRole(row.kind),
    nameEdited: row.label !== null,
    name: row.label !== null ? fullName(teamName, row.label) : '',
    mode: row.permissionMode,
    model: row.model,
    worktree: row.useWorktree,
  }));
  return renameRows(plan, teamName, taken);
}

/** 名稱的後綴：`<團隊名>-X` 取 X；不是這個團隊名開頭的取整個名稱。截到上限。 */
function suffixOf(name: string, teamName: string): string {
  const prefix = `${teamName.trim()}-`;
  const rest = teamName.trim() && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return rest.trim().slice(0, TEAM_PRESET_LABEL_MAX).trim();
}

/** 名稱就是預設命名（這個位置在這組分工裡的 LD、BD1…）時存 null，否則存後綴。 */
function labelsOf(
  rows: readonly { kind: RowKind; name: string }[],
  teamName: string,
): (string | null)[] {
  const defaults = defaultNames(
    teamName,
    rows.map((r) => r.kind),
  );
  return rows.map((row, i) => {
    const name = row.name.trim();
    if (name === defaults[i]) return null;
    return suffixOf(name, teamName) || null;
  });
}

/** PlanRow → Preset 的列（NewTeamForm「存成 Preset」、編輯 Preset 存檔）。 */
export function planRowsToPreset(rows: readonly PlanRow[], teamName: string): TeamPresetRow[] {
  const labels = labelsOf(rows, teamName);
  return rows.map((row, i) => ({
    kind: row.kind,
    permissionMode: row.mode,
    model: row.model?.trim() || null,
    useWorktree: row.worktree ?? null,
    label: labels[i] ?? null,
  }));
}

/**
 * 交接規則（列序號）→ 套用時要建的規則。`sessionIds[i]` 是第 i 列建好的 session（沒建成是 undefined）：
 * 來源或目標沒建成的規則略過（算在 skipped），不會指錯人。
 */
export function presetRuleInputs(
  rules: readonly TeamPresetRule[],
  sessionIds: readonly (string | undefined)[],
): { inputs: RuleInput[]; skipped: number } {
  const inputs: RuleInput[] = [];
  let skipped = 0;
  for (const rule of rules) {
    const from = sessionIds[rule.fromRow];
    const to = sessionIds[rule.toRow];
    if (!from || !to) {
      skipped += 1;
      continue;
    }
    inputs.push({
      fromSessionId: from,
      trigger: rule.trigger,
      action: {
        toSessionId: to,
        ...(rule.trigger === 'on_file' && rule.filePattern
          ? { filePattern: rule.filePattern }
          : {}),
        ...(rule.trigger === 'on_marker' && rule.marker ? { marker: rule.marker } : {}),
        ...(rule.maxRounds !== undefined ? { maxRounds: rule.maxRounds } : {}),
      },
      enabled: rule.enabled,
    });
  }
  return { inputs, skipped };
}

/** 交接規則（session id）→ Preset 的規則（列序號）。來源或目標不在 rows 裡的略過。 */
export function rulesToPreset(
  rules: readonly Pick<HandoffRule, 'fromSessionId' | 'trigger' | 'action' | 'enabled'>[],
  sessionIds: readonly string[],
): { rules: TeamPresetRule[]; skipped: number } {
  const out: TeamPresetRule[] = [];
  let skipped = 0;
  for (const rule of rules) {
    const fromRow = sessionIds.indexOf(rule.fromSessionId);
    const toRow = sessionIds.indexOf(rule.action.toSessionId);
    if (fromRow < 0 || toRow < 0 || fromRow === toRow) {
      skipped += 1;
      continue;
    }
    out.push({
      fromRow,
      toRow,
      trigger: rule.trigger,
      ...(rule.action.filePattern ? { filePattern: rule.action.filePattern } : {}),
      ...(rule.action.marker ? { marker: rule.action.marker } : {}),
      ...(rule.action.maxRounds !== undefined ? { maxRounds: rule.action.maxRounds } : {}),
      enabled: rule.enabled,
    });
  }
  return { rules: out, skipped };
}

/** 列被刪掉後，規則跟著調整：刪掉相關的、後面的序號往前移（§2.8 列序號對應的風險）。 */
export function rulesWithoutRow(
  rules: readonly TeamPresetRule[],
  removed: number,
): { rules: TeamPresetRule[]; dropped: number } {
  const kept = rules.filter((r) => r.fromRow !== removed && r.toRow !== removed);
  return {
    rules: kept.map((r) => ({
      ...r,
      fromRow: r.fromRow > removed ? r.fromRow - 1 : r.fromRow,
      toRow: r.toRow > removed ? r.toRow - 1 : r.toRow,
    })),
    dropped: rules.length - kept.length,
  };
}

export interface TeamRecord {
  member: TeamMember;
  session: Session;
}

const ROLE_ORDER: Record<TeamMember['role'], number> = {
  lead: 0,
  worker: 1,
  tester: 2,
  researcher: 3,
  reviewer: 4,
};

/**
 * 從現有團隊擷取 Preset（§2.3「存成 Preset」）。成員依隊長 → 成員 → 測試 → 研究 → 審查排（同角色照原順序），
 * 封存的成員不算。機器與資料夾取隊長的（沒有隊長取第一位）；worktree 以 `worktreePath !== null` 判斷（§6）。
 * 連到團隊外（或被封存的成員）的交接規則略過，`skippedRules` 告訴畫面要提示。進度卡預設不帶（`progress` 有給才帶）。
 */
export function teamToPresetConfig(
  team: Team,
  records: readonly TeamRecord[],
  rules: readonly HandoffRule[],
  progress?: TeamPresetProgress,
): { config: TeamPresetConfigInput; skippedRules: number } | null {
  const live = records
    .filter((r) => !r.session.archived)
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => ROLE_ORDER[a.member.role] - ROLE_ORDER[b.member.role] || a.i - b.i);
  const anchor = live.find((r) => r.member.role === 'lead') ?? live[0];
  if (!anchor) return null;
  const research = team.phase !== undefined;
  const kinds = live.map((r): RowKind => (research ? memberKind(r.member) : r.member.role));
  const labels = labelsOf(
    live.map((r, i) => ({ kind: kinds[i]!, name: r.session.name })),
    team.name,
  );
  const ids = live.map((r) => r.session.id);
  const mapped = rulesToPreset(
    rules.filter((r) => r.teamId === team.id),
    ids,
  );
  return {
    config: {
      teamType: research ? 'research' : 'dev',
      phase: team.phase ?? null,
      color: team.color,
      goal: team.goal,
      doneCriteria: team.doneCriteria,
      contextMd: team.contextMd,
      placement: {
        machineId: anchor.session.machineId,
        cwd: anchor.session.cwd,
        projectId: anchor.session.projectId,
      },
      rows: live.map((r, i) => ({
        kind: kinds[i]!,
        permissionMode: r.session.permissionMode,
        model: r.session.model,
        useWorktree: r.session.worktreePath !== null,
        label: labels[i] ?? null,
      })),
      handoffRules: mapped.rules,
      taskAuto: team.taskAuto ?? false,
      leadFirstPrompt: null,
      attachProgressCard: true,
      ...(progress ? { initialProgress: progress } : {}),
    },
    skippedRules: mapped.skipped,
  };
}

/** 撞名自動加「 2」「 3」（不分大小寫，§2.3）。 */
export function uniqueTeamName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const name = base.trim();
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** 清單上的角色縮寫串：`LD · BD · BD · RV`（不編號）。 */
export const presetAbbr = (config: Pick<TeamPresetConfig, 'rows'>) =>
  config.rows.map((r) => KIND_ABBR[r.kind]).join(' · ');

/** 套用會花額度的部分：有第一個指令、有開啟的交接規則、任務自動執行（清單與預覽標 ◈，D6）。 */
export function presetCosts(config: TeamPresetConfig): {
  firstPrompt: boolean;
  rules: number;
  taskAuto: boolean;
  any: boolean;
} {
  const firstPrompt = config.leadFirstPrompt !== null;
  const rules = config.handoffRules.filter((r) => r.enabled).length;
  return {
    firstPrompt,
    rules,
    taskAuto: config.taskAuto,
    any: firstPrompt || rules > 0 || config.taskAuto,
  };
}

export const presetHasBypass = (config: Pick<TeamPresetConfig, 'rows'>) =>
  config.rows.some((r) => r.permissionMode === 'bypassPermissions');

/** 資料夾最後一段（清單用；完整路徑在提示框）。 */
export const lastSegment = (path: string) =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop() || path;

/** 依 position 排好的清單（board 快照已經排好；保險起見再排一次）。 */
export const sortPresets = (list: readonly TeamPreset[]) =>
  [...list].sort((a, b) => a.position - b.position);
