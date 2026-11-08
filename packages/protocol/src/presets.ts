// 團隊 Presets（P3 項目二，docs/p3-spec.md §2）：把一組設定好的團隊存起來，下次一鍵套用。
// 套用沿用前端的「團隊快速建立」（web/src/team/runPlan.ts）逐列建立；hub 只存設定、記使用時間與 audit。
// 和單一 session 的「範本」（Template）分開：範本＝一個 session；Preset＝整個團隊。
import { z } from 'zod';
import {
  BROADCAST_TEXT_MAX,
  HANDOFF_MARKER_MAX_CHARS,
  HANDOFF_MAX_ROUNDS,
  HandoffTrigger,
  Id,
  IsoTime,
  PermissionMode,
  ResearchKind,
  ResearchPhase,
  TeamRole,
} from './models';
import { PROGRESS_LIMITS, progressLine } from './progress';

/** Preset 名稱上限（字元），和團隊名稱輸入框一樣。 */
export const TEAM_PRESET_NAME_MAX = 80;
export const TeamPresetName = z.string().trim().min(1).max(TEAM_PRESET_NAME_MAX);
/** 一個 Preset 最多幾列（一次開這麼多 session 已經很多）。 */
export const TEAM_PRESET_ROWS_MAX = 12;
/** 交接規則最多幾條。 */
export const TEAM_PRESET_RULES_MAX = 40;
/**
 * 隊長第一個指令上限：和群發一樣（全部暫停中要改用「送出第一個指令」經群發的送字佇列送）。
 * 附上進度卡時，整段（進度卡那一行＋指令）一樣不超過這個長度（超過就截短進度卡那一行）。
 */
export const TEAM_PRESET_PROMPT_MAX = BROADCAST_TEXT_MAX;
/** 每列名稱後綴（`<團隊名>-<後綴>`）上限。 */
export const TEAM_PRESET_LABEL_MAX = 40;
/** 團隊文字（goal、doneCriteria、TEAM.md）上限：存檔用，不是畫面上的「1 頁」提示。 */
export const TEAM_PRESET_TEXT_MAX = 20_000;
/** 初始進度卡欄位上限（同 P3 §1.2 的進度卡欄位）。 */
export const PROGRESS_FIELD_MAX = PROGRESS_LIMITS.status;
export const PROGRESS_GM_NOTES_MAX = PROGRESS_LIMITS.gmNotes;

/** 每列的分工：程式開發團隊是角色本身，研究團隊是 ld／lr／ex／wr／rv（兩者沒有重疊的值）。 */
export const TeamPresetKind = z.enum([...TeamRole.options, ...ResearchKind.options]);
export type TeamPresetKind = z.infer<typeof TeamPresetKind>;

export const TeamPresetRow = z.object({
  kind: TeamPresetKind,
  permissionMode: PermissionMode,
  /** null＝預設模型。 */
  model: z.string().trim().min(1).max(100).nullable().default(null),
  /** null＝依角色規則（成員、測試在 git 資料夾開 worktree）；true／false＝存檔時的實際狀況。 */
  useWorktree: z.boolean().nullable().default(null),
  /** GM 改過的名稱後綴（建立時是 `<團隊名>-<label>`）；null＝依預設命名（LD、BD1…）。 */
  label: z.string().trim().min(1).max(TEAM_PRESET_LABEL_MAX).nullable().default(null),
});
export type TeamPresetRow = z.infer<typeof TeamPresetRow>;

/** 交接規則：以列序號（從 0 起）表示來源與目標，套用時換成新建的 session。 */
export const TeamPresetRule = z.object({
  fromRow: z.number().int().nonnegative(),
  toRow: z.number().int().nonnegative(),
  trigger: HandoffTrigger,
  filePattern: z.string().trim().min(1).max(200).optional(),
  marker: z.string().trim().min(1).max(HANDOFF_MARKER_MAX_CHARS).optional(),
  maxRounds: z.number().int().min(1).max(HANDOFF_MAX_ROUNDS).optional(),
  enabled: z.boolean(),
});
export type TeamPresetRule = z.infer<typeof TeamPresetRule>;

export const TeamPresetProgress = z.object({
  status: z.string().max(PROGRESS_FIELD_MAX).default(''),
  next: z.string().max(PROGRESS_FIELD_MAX).default(''),
  blockers: z.string().max(PROGRESS_FIELD_MAX).default(''),
  gmNotes: z.string().max(PROGRESS_GM_NOTES_MAX).default(''),
});
export type TeamPresetProgress = z.infer<typeof TeamPresetProgress>;

export const EMPTY_PRESET_PROGRESS: TeamPresetProgress = {
  status: '',
  next: '',
  blockers: '',
  gmNotes: '',
};

export const TeamPresetPlacement = z.object({
  machineId: Id,
  cwd: z.string().trim().min(1),
  projectId: Id.nullable().default(null),
});
export type TeamPresetPlacement = z.infer<typeof TeamPresetPlacement>;

const DEV_KINDS: readonly string[] = TeamRole.options;
const RESEARCH_KINDS: readonly string[] = ResearchKind.options;
const LEAD_KINDS: readonly string[] = ['lead', 'ld'];

/**
 * Preset 的內容（§2.2）。不存工作區：套用時放在目前工作區。
 * 欄位之間的關係（剛好一位隊長、分工符合團隊類型、規則指到存在的列、on_marker 要有標記）在這裡一起檢查，
 * hub 存檔時用它驗證，前端存檔前也用 `teamPresetProblem` 先說清楚。
 */
export const TeamPresetConfigFields = z.object({
  teamType: z.enum(['dev', 'research']),
  /** 研究團隊的階段；程式開發團隊是 null。 */
  phase: ResearchPhase.nullable().default(null),
  color: z.string().min(1),
  goal: z.string().max(TEAM_PRESET_TEXT_MAX).default(''),
  doneCriteria: z.string().max(TEAM_PRESET_TEXT_MAX).default(''),
  contextMd: z.string().max(TEAM_PRESET_TEXT_MAX).default(''),
  placement: TeamPresetPlacement,
  rows: z.array(TeamPresetRow).min(1).max(TEAM_PRESET_ROWS_MAX),
  handoffRules: z.array(TeamPresetRule).max(TEAM_PRESET_RULES_MAX).default([]),
  /** 任務自動執行（存原狀，套用時照原狀；開著的在清單與預覽標 ◈，D6）。 */
  taskAuto: z.boolean().default(false),
  /** 隊長第一個指令；null＝沒有。 */
  leadFirstPrompt: z.string().trim().min(1).max(TEAM_PRESET_PROMPT_MAX).nullable().default(null),
  /** 隊長第一個指令前附上進度卡那一行（預設開；卡片空白時略過）。 */
  attachProgressCard: z.boolean().default(true),
  initialProgress: TeamPresetProgress.default(EMPTY_PRESET_PROGRESS),
});
export const TeamPresetConfig = TeamPresetConfigFields.superRefine((config, ctx) => {
  const problem = teamPresetProblem(config);
  if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['rows'] });
});
export type TeamPresetConfig = z.infer<typeof TeamPresetConfig>;
export type TeamPresetConfigInput = z.input<typeof TeamPresetConfig>;

export type TeamPresetProblem =
  'lead_count' | 'kind_mismatch' | 'rule_row' | 'rule_self' | 'marker_required' | 'phase_mismatch';

/** zod 物件本身不檢查欄位之間的關係：hub 存檔時與前端存檔前都用這個。null＝沒問題。 */
export function teamPresetProblem(
  config: Pick<TeamPresetConfig, 'teamType' | 'phase' | 'rows'> & {
    handoffRules: readonly Pick<TeamPresetRule, 'fromRow' | 'toRow' | 'trigger' | 'marker'>[];
  },
): TeamPresetProblem | null {
  const allowed = config.teamType === 'dev' ? DEV_KINDS : RESEARCH_KINDS;
  if (config.rows.some((row) => !allowed.includes(row.kind))) return 'kind_mismatch';
  if ((config.teamType === 'research') !== (config.phase !== null)) return 'phase_mismatch';
  if (config.rows.filter((row) => LEAD_KINDS.includes(row.kind)).length !== 1) return 'lead_count';
  for (const rule of config.handoffRules) {
    if (rule.fromRow >= config.rows.length || rule.toRow >= config.rows.length) return 'rule_row';
    if (rule.fromRow === rule.toRow) return 'rule_self';
    if (rule.trigger === 'on_marker' && !rule.marker?.trim()) return 'marker_required';
  }
  return null;
}

export const TeamPreset = z.object({
  id: Id,
  name: z.string().min(1),
  config: TeamPresetConfig,
  /** 排序（0 起，連續）。清單、底部列都照它排。 */
  position: z.number().int().nonnegative(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
  /** 最後一次套用成功的時間；沒用過是 null。 */
  lastUsedAt: IsoTime.nullable(),
});
export type TeamPreset = z.infer<typeof TeamPreset>;

/** 套用結果回報（`POST /api/team-presets/:id/used`）：hub 更新 lastUsedAt 並寫 audit `preset.apply`。 */
export const TeamPresetUsed = z.object({
  teamId: Id,
  /** 建好而且加入團隊的列數。 */
  created: z.number().int().nonnegative(),
  /** 沒建成（或沒加入團隊）的列數。 */
  failed: z.number().int().nonnegative(),
  /** 建好的交接規則數、沒建成的條數。 */
  rulesCreated: z.number().int().nonnegative().default(0),
  rulesFailed: z.number().int().nonnegative().default(0),
  /** 全部暫停中：隊長第一個指令沒有隨建立送出，等 GM 按「送出第一個指令」（§2.3、D7）。 */
  firstPromptHeld: z.boolean().default(false),
});
export type TeamPresetUsed = z.infer<typeof TeamPresetUsed>;

/** 進度卡那一行的上限（P3 §1.5「帶入進度卡」：一行、4,000 字截斷）。 */
/**
 * 「帶入進度卡」那一行（P3 §1.5）：和項目一共用 `progressLine`（protocol/src/progress.ts），
 * `[Progress card: <團隊名>] Status: … | Next: … | Blockers: … | GM notes: …`，空欄位略過，全部空白回 null。
 * max 給了就截到那個長度（附在隊長第一個指令前時，整段不能超過 TEAM_PRESET_PROMPT_MAX）。
 */
export function progressCardLine(
  teamName: string,
  fields: TeamPresetProgress,
  max?: number,
): string | null {
  return progressLine(teamName, fields, max);
}

/**
 * 隊長的第一個指令：附上進度卡時以進度卡那一行開頭、空一格接 Preset 的指令（§2.6-3）。
 * 整段不超過 TEAM_PRESET_PROMPT_MAX（超過時截短的是進度卡那一行，Preset 的指令保持完整）。
 * 沒有指令就回 null：只有卡片內容不送（「附在第一個指令前」；單獨送卡片會讓隊長開始動、花額度，
 * 要送卡片請用項目一的「帶入進度卡」）。
 */
export function leadFirstPrompt(
  teamName: string,
  config: Pick<TeamPresetConfig, 'leadFirstPrompt' | 'attachProgressCard' | 'initialProgress'>,
): string | null {
  const prompt = config.leadFirstPrompt?.trim() || null;
  if (prompt === null || !config.attachProgressCard) return prompt;
  const room = TEAM_PRESET_PROMPT_MAX - prompt.length - 1;
  const card = room > 0 ? progressCardLine(teamName, config.initialProgress, room) : null;
  return card === null ? prompt : `${card} ${prompt}`;
}
