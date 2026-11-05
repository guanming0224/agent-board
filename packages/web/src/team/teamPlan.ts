// 建立團隊時一起開各角色的 session（GM 2026-11-06）。這裡只放純函式：預設組合、命名、權限、檢查。
import { PermissionMode, type TeamMember } from '@agent-board/protocol';
import { READ_ONLY_ROLES } from '@agent-board/protocol';

export type Role = TeamMember['role'];

/** 角色選單後面顯示的英文縮寫（GM 2026-11-06 試看用；worker 在角色規劃裡叫 Builder）。 */
export const ROLE_ABBR: Record<Role, string> = {
  lead: 'LD',
  worker: 'BD',
  researcher: 'RS',
  reviewer: 'RV',
};

/** 每個角色預設的權限模式（GM 決策）。不放 bypassPermissions、dontAsk。 */
export const ROLE_DEFAULT_MODE: Record<Role, PermissionMode> = {
  lead: 'default',
  worker: 'acceptEdits',
  researcher: 'plan',
  reviewer: 'plan',
};

export const PRESETS = {
  none: [],
  squad: ['lead', 'worker'],
  standard: ['lead', 'worker', 'worker', 'reviewer'],
  explore: ['lead', 'researcher', 'worker'],
} as const satisfies Record<string, readonly Role[]>;
export type PresetId = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export interface PlanRow {
  key: string;
  role: Role;
  /** 使用者自己改過名稱就是 true，之後團隊名稱改了也不動它。 */
  nameEdited: boolean;
  name: string;
  mode: PermissionMode;
}

let nextKey = 0;
const newKey = () => `row-${(nextKey += 1)}`;

/**
 * 預設名稱：`<團隊名>-LD`、`-BD1`、`-BD2`、`-RS`、`-RV`。
 * BD 一律編號；其他角色只有一位時不編號，兩位以上才編號。
 */
export function defaultNames(teamName: string, roles: readonly Role[]): string[] {
  const prefix = teamName.trim();
  const total = (role: Role) => roles.filter((r) => r === role).length;
  const seen = new Map<Role, number>();
  return roles.map((role) => {
    const n = (seen.get(role) ?? 0) + 1;
    seen.set(role, n);
    const numbered = role === 'worker' || total(role) > 1;
    const tag = `${ROLE_ABBR[role]}${numbered ? n : ''}`;
    return prefix ? `${prefix}-${tag}` : tag;
  });
}

/** 沒改過的名稱跟著團隊名稱與角色重新命名。 */
export function renameRows(rows: readonly PlanRow[], teamName: string): PlanRow[] {
  const names = defaultNames(
    teamName,
    rows.map((r) => r.role),
  );
  return rows.map((row, i) => (row.nameEdited ? row : { ...row, name: names[i]! }));
}

export function presetRows(preset: PresetId, teamName: string): PlanRow[] {
  const rows = PRESETS[preset].map((role): PlanRow => ({
    key: newKey(),
    role,
    nameEdited: false,
    name: '',
    mode: ROLE_DEFAULT_MODE[role],
  }));
  return renameRows(rows, teamName);
}

export function addRow(rows: readonly PlanRow[], role: Role, teamName: string): PlanRow[] {
  return renameRows(
    [...rows, { key: newKey(), role, nameEdited: false, name: '', mode: ROLE_DEFAULT_MODE[role] }],
    teamName,
  );
}

/** 每列可選的權限模式：唯讀的 RS／RV 不給 bypassPermissions（dontAsk 可選，但會提醒）。 */
export function modesFor(role: Role): PermissionMode[] {
  const all = PermissionMode.options;
  return isReadOnlyRole(role) ? all.filter((m) => m !== 'bypassPermissions') : [...all];
}

/** 換角色時權限模式跟著換成新角色的預設。 */
export function changeRole(rows: readonly PlanRow[], key: string, role: Role, teamName: string) {
  return renameRows(
    rows.map((r) => (r.key === key ? { ...r, role, mode: ROLE_DEFAULT_MODE[role] } : r)),
    teamName,
  );
}

/** 每一列的資料夾：隊長用主資料夾；BD 各自開 worktree（是 git 才開得了）；研究、審查共用主資料夾。 */
export const rowUsesWorktree = (row: Pick<PlanRow, 'role'>, gitOk: boolean) =>
  row.role === 'worker' && gitOk;

/** 研究、審查一律開成唯讀 session（daemon 拿掉改檔工具），才能和隊長共用主資料夾。 */
export const isReadOnlyRole = (role: Role) => (READ_ONLY_ROLES as readonly Role[]).includes(role);

/** 會改檔案、而且留在主資料夾的列（沒有自己的 worktree）。 */
export const sharesMainAsWriter = (row: PlanRow, gitOk: boolean) =>
  !rowUsesWorktree(row, gitOk) && !isReadOnlyRole(row.role);

export type PlanError = 'leadCount' | 'emptyName' | 'duplicateName' | 'sharedWriters' | null;

/**
 * 有列的時候：剛好一位隊長、名稱不能空白或重複、主資料夾裡最多一位會改檔案的
 * （hub 的同資料夾規則會擋第二位，先在這裡說清楚）。沒有列（只建團隊）一律通過。
 */
export function validatePlan(rows: readonly PlanRow[], gitOk: boolean): PlanError {
  if (rows.length === 0) return null;
  if (rows.filter((r) => r.role === 'lead').length !== 1) return 'leadCount';
  const names = rows.map((r) => r.name.trim());
  if (names.some((n) => n === '')) return 'emptyName';
  if (new Set(names).size !== names.length) return 'duplicateName';
  if (rows.filter((r) => sharesMainAsWriter(r, gitOk)).length > 1) return 'sharedWriters';
  return null;
}
