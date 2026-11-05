// 建立團隊時一起開各角色的 session（GM 2026-11-06）。這裡只放純函式：預設組合、命名、權限、檢查。
// 學術研究團隊（GM 2026-11-06）：依研究階段組隊，分工疊在既有的四種角色上（protocol 的 ResearchKind）。
// 補成員（GM 2026-11-06）：同一套列，對已經有成員的團隊再加人（不重複隊長、名稱接著編號）。
import {
  PermissionMode,
  READ_ONLY_ROLES,
  RESEARCH_KIND_ROLE,
  ResearchKind,
  ResearchPhase,
  type TeamMember,
} from '@agent-board/protocol';

export type Role = TeamMember['role'];

/**
 * 每一列的分工。程式開發團隊就是角色本身；研究團隊用 ld／lr／ex／wr／rv。
 * 實驗（ex）與寫作（wr）都是 worker，只靠這個分開：命名、標籤、換階段都看它。
 */
export type RowKind = Role | ResearchKind;
export type TeamType = 'dev' | 'research';

/** 角色選單後面顯示的英文縮寫（GM 2026-11-06 試看用；worker 在角色規劃裡叫 Builder）。 */
export const ROLE_ABBR: Record<Role, string> = {
  lead: 'LD',
  worker: 'BD',
  researcher: 'RS',
  reviewer: 'RV',
};

export const KIND_ABBR: Record<RowKind, string> = {
  ...ROLE_ABBR,
  ld: 'LD',
  lr: 'LR',
  ex: 'EX',
  wr: 'WR',
  rv: 'RV',
};

/** 一律編號的分工：BD1、EX1（同類常常不只一位，之後再加也接得上）。 */
const ALWAYS_NUMBERED: readonly RowKind[] = ['worker', 'ex'];

export const isResearchKind = (kind: RowKind): kind is ResearchKind =>
  (ResearchKind.options as readonly string[]).includes(kind);

export const kindRole = (kind: RowKind): Role =>
  isResearchKind(kind) ? RESEARCH_KIND_ROLE[kind] : kind;

/** 這種團隊每列可選的分工。 */
export const KINDS_FOR: Record<TeamType, readonly RowKind[]> = {
  dev: ['lead', 'worker', 'researcher', 'reviewer'],
  research: ResearchKind.options,
};

/** 新增一列時預設的分工。 */
export const ADD_KIND: Record<TeamType, RowKind> = { dev: 'worker', research: 'ex' };

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

/** 研究團隊四個階段的固定組合（GM 2026-11-06）；列照樣可以改。 */
export const PHASE_PRESETS = {
  topic: ['ld', 'lr', 'lr'],
  experiment: ['ld', 'ex', 'ex', 'rv'],
  writing: ['ld', 'wr', 'rv', 'ex'],
  revision: ['ld', 'ex', 'wr', 'rv'],
} as const satisfies Record<ResearchPhase, readonly ResearchKind[]>;
export const PHASE_IDS = ResearchPhase.options;

export interface PlanRow {
  key: string;
  kind: RowKind;
  /** 由 kind 決定（kindRole），存著是為了檢查與建立時不用每次換算。 */
  role: Role;
  /** 使用者自己改過名稱就是 true，之後團隊名稱改了也不動它。 */
  nameEdited: boolean;
  name: string;
  mode: PermissionMode;
}

let nextKey = 0;
const newKey = () => `row-${(nextKey += 1)}`;

const NONE: ReadonlySet<string> = new Set();

/**
 * 預設名稱：`<團隊名>-LD`、`-BD1`、`-BD2`、`-RS`、`-RV`；研究團隊 `-LD`、`-LR`、`-EX1`、`-WR`、`-RV`。
 * BD、EX 一律編號；其他只有一位時不編號，兩位以上才編號。
 * `taken` 是已經存在的名稱（補成員時的現有 session）：撞名就往後編號，例如已有 BD1 → 新的是 BD2；
 * 已有不編號的 `-RV` → 新的是 `-RV2`。
 */
export function defaultNames(
  teamName: string,
  kinds: readonly RowKind[],
  taken: ReadonlySet<string> = NONE,
): string[] {
  const prefix = teamName.trim();
  const full = (tag: string) => (prefix ? `${prefix}-${tag}` : tag);
  const total = (kind: RowKind) => kinds.filter((k) => KIND_ABBR[k] === KIND_ABBR[kind]).length;
  const used = new Set(taken);
  const next = new Map<string, number>();
  return kinds.map((kind) => {
    const abbr = KIND_ABBR[kind];
    const numbered = ALWAYS_NUMBERED.includes(kind) || total(kind) > 1;
    if (!numbered && !used.has(full(abbr)) && !next.has(abbr)) {
      used.add(full(abbr));
      next.set(abbr, 2);
      return full(abbr);
    }
    let n = next.get(abbr) ?? (numbered ? 1 : 2);
    while (used.has(full(`${abbr}${n}`))) n += 1;
    next.set(abbr, n + 1);
    used.add(full(`${abbr}${n}`));
    return full(`${abbr}${n}`);
  });
}

/** 沒改過的名稱跟著團隊名稱與分工重新命名。改過的名稱也算已占用。 */
export function renameRows(
  rows: readonly PlanRow[],
  teamName: string,
  taken: ReadonlySet<string> = NONE,
): PlanRow[] {
  // 編號照全部的列算（改過名稱的那列也占一個號，其他列的號碼才不會跳動）。
  const edited = rows.filter((r) => r.nameEdited).map((r) => r.name.trim());
  const names = defaultNames(
    teamName,
    rows.map((r) => r.kind),
    new Set([...taken, ...edited]),
  );
  return rows.map((row, i) => (row.nameEdited ? row : { ...row, name: names[i]! }));
}

const rowOf = (kind: RowKind): PlanRow => {
  const role = kindRole(kind);
  return { key: newKey(), kind, role, nameEdited: false, name: '', mode: ROLE_DEFAULT_MODE[role] };
};

export interface PlanContext {
  /** 已經存在的 session 名稱。 */
  taken?: ReadonlySet<string>;
  /** 團隊已經有隊長：組合裡的隊長拿掉。 */
  hasLead?: boolean;
}

/** 依分工清單建列；團隊已有隊長時拿掉隊長列。 */
export function kindRows(
  kinds: readonly RowKind[],
  teamName: string,
  { taken = NONE, hasLead = false }: PlanContext = {},
): PlanRow[] {
  const rows = kinds.filter((k) => !(hasLead && kindRole(k) === 'lead')).map(rowOf);
  return renameRows(rows, teamName, taken);
}

export function presetRows(preset: PresetId, teamName: string, ctx: PlanContext = {}) {
  return kindRows(PRESETS[preset], teamName, ctx);
}

export function phaseRows(phase: ResearchPhase, teamName: string, ctx: PlanContext = {}) {
  return kindRows(PHASE_PRESETS[phase], teamName, ctx);
}

export function addRow(
  rows: readonly PlanRow[],
  kind: RowKind,
  teamName: string,
  taken: ReadonlySet<string> = NONE,
): PlanRow[] {
  return renameRows([...rows, rowOf(kind)], teamName, taken);
}

/** 每列可選的權限模式：唯讀的 RS／RV 不給 bypassPermissions（dontAsk 可選，但會提醒）。 */
export function modesFor(role: Role): PermissionMode[] {
  const all = PermissionMode.options;
  return isReadOnlyRole(role) ? all.filter((m) => m !== 'bypassPermissions') : [...all];
}

/** 換分工時角色與權限模式跟著換成新角色的預設。 */
export function changeKind(
  rows: readonly PlanRow[],
  key: string,
  kind: RowKind,
  teamName: string,
  taken: ReadonlySet<string> = NONE,
) {
  return renameRows(
    rows.map((r) =>
      r.key === key
        ? { ...r, kind, role: kindRole(kind), mode: ROLE_DEFAULT_MODE[kindRole(kind)] }
        : r,
    ),
    teamName,
    taken,
  );
}

/** 程式開發團隊的換角色（分工就是角色）。 */
export const changeRole = changeKind;

/** 每一列的資料夾：隊長用主資料夾；BD 各自開 worktree（是 git 才開得了）；研究、審查共用主資料夾。 */
export const rowUsesWorktree = (row: Pick<PlanRow, 'role'>, gitOk: boolean) =>
  row.role === 'worker' && gitOk;

/** 研究、審查一律開成唯讀 session（daemon 拿掉改檔工具），才能和隊長共用主資料夾。 */
export const isReadOnlyRole = (role: Role) => (READ_ONLY_ROLES as readonly Role[]).includes(role);

/** 會改檔案、而且留在主資料夾的列（沒有自己的 worktree）。 */
export const sharesMainAsWriter = (row: Pick<PlanRow, 'role'>, gitOk: boolean) =>
  !rowUsesWorktree(row, gitOk) && !isReadOnlyRole(row.role);

export type PlanError = 'leadCount' | 'emptyName' | 'duplicateName' | 'sharedWriters' | null;

/** 補成員時團隊現有的狀況（`existingMembers` 算出來）。新團隊不給。 */
export interface ExistingTeam {
  /** 現有成員數（沒封存的）。 */
  members: number;
  leads: number;
  /** 在同一個主資料夾、會改檔案、沒有自己 worktree 的現有成員數。 */
  mainWriters: number;
  /** 現有 session 名稱。 */
  names: ReadonlySet<string>;
}

/**
 * 有列的時候：剛好一位隊長、名稱不能空白或重複、主資料夾裡最多一位會改檔案的
 * （hub 的同資料夾規則會擋第二位，先在這裡說清楚）。沒有列（只建團隊）一律通過。
 * 補成員（`existing`）：隊長、主資料夾寫入者、名稱都連同現有成員一起算；
 * 現有成員裡本來就沒有隊長的團隊（使用者自己組的），補成員不強迫加隊長，但最多一位。
 */
export function validatePlan(
  rows: readonly PlanRow[],
  gitOk: boolean,
  existing?: ExistingTeam,
): PlanError {
  if (rows.length === 0) return null;
  const leads = rows.filter((r) => r.role === 'lead').length + (existing?.leads ?? 0);
  const needsLead = !existing || existing.members === 0;
  if (leads > 1 || (needsLead && leads !== 1)) return 'leadCount';
  const names = rows.map((r) => r.name.trim());
  if (names.some((n) => n === '')) return 'emptyName';
  if (new Set(names).size !== names.length) return 'duplicateName';
  if (existing && names.some((n) => existing.names.has(n))) return 'duplicateName';
  const writers =
    rows.filter((r) => sharesMainAsWriter(r, gitOk)).length + (existing?.mainWriters ?? 0);
  if (writers > 1) return 'sharedWriters';
  return null;
}
