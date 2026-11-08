// 進度卡與 Memory（P3 項目一，docs/p3-spec.md §1）。型別、上限、三方比對與送字格式都放這裡：
// hub（progress.ts）、前端假後端、畫面共用同一份規則，才不會兩邊算出不同的衝突。
// 全部是固定規則，不呼叫任何模型；卡片內容只有 GM 打的字與 session 裡的 Claude 自己用 update_progress 寫的字。
import { z } from 'zod';
import { DispatchTool, Id, IsoTime, SessionStatus, TeamRole } from './models';

/** 卡片欄位：目前狀態、下一步、阻礙／等 GM 決定、GM 備註（只有 GM 能寫）。 */
export const PROGRESS_FIELDS = ['status', 'next', 'blockers', 'gmNotes'] as const;
export type ProgressField = (typeof PROGRESS_FIELDS)[number];
/** agent（MCP update_progress）能寫的欄位：不含 gmNotes。 */
export const AGENT_PROGRESS_FIELDS = ['status', 'next', 'blockers'] as const;
export type AgentProgressField = (typeof AGENT_PROGRESS_FIELDS)[number];

/** 每個欄位的字數上限（字元，以 Unicode code point 計）。超過一律拒絕，不默默截斷。 */
export const PROGRESS_LIMITS: Record<ProgressField, number> = {
  status: 2_000,
  next: 2_000,
  blockers: 2_000,
  gmNotes: 4_000,
};
/** 每張卡保留的歷史版本數（寫入時同一個交易刪掉更舊的）。 */
export const PROGRESS_HISTORY_KEEP = 50;
/** agent 寫入頻率上限：同一張卡、同一個 session，10 分鐘最多 10 次。 */
export const PROGRESS_RATE_MAX = 10;
export const PROGRESS_RATE_WINDOW_MS = 10 * 60 * 1000;
/** 超過這麼久沒更新、而且這段時間內有回合結束（Stop）→ 卡片標「⚠ N 天沒更新」。 */
export const PROGRESS_STALE_MS = 24 * 60 * 60 * 1000;
/** get_progress 回的 TEAM.md（contextMd）上限；超過截斷並註明。 */
export const PROGRESS_CONTEXT_MAX = 8_000;
/** 「帶入進度卡」送進 session 的那一行上限。 */
export const PROGRESS_LINE_MAX = 4_000;
/** 自動事實：最近 24 小時改過的檔案最多列幾個。 */
export const PROGRESS_FILES_MAX = 10;
export const PROGRESS_FILES_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 「請隊長更新 ◈」送給隊長的固定一行（不帶任何對話內容）。 */
export const PROGRESS_ASK_UPDATE_PROMPT =
  '[Board] Please update the team progress card with update_progress (status, next, blockers).';

/** 進度卡的 MCP 工具（加在既有的 `agent-board` MCP server，全名 `mcp__agent-board__<tool>`）。 */
export const MemoryTool = z.enum(['get_progress', 'update_progress']);
export type MemoryTool = z.infer<typeof MemoryTool>;
export const isMemoryTool = (tool: string): tool is MemoryTool =>
  (MemoryTool.options as readonly string[]).includes(tool);
/** `agent-board` MCP server 的全部工具：派工 4 個＋進度卡 2 個（daemon 只掛設定開著的那些）。 */
export const AgentBoardTool = z.enum([...DispatchTool.options, ...MemoryTool.options]);
export type AgentBoardTool = z.infer<typeof AgentBoardTool>;

export const ProgressFields = z.object({
  status: z.string(),
  next: z.string(),
  blockers: z.string(),
  gmNotes: z.string(),
});
export type ProgressFields = z.infer<typeof ProgressFields>;

export const EMPTY_PROGRESS_FIELDS: ProgressFields = {
  status: '',
  next: '',
  blockers: '',
  gmNotes: '',
};

/** 每個欄位最後一次被改時的 revision（三方比對用）；沒改過是 0。 */
export const ProgressFieldRevisions = z.object({
  status: z.number().int().nonnegative(),
  next: z.number().int().nonnegative(),
  blockers: z.number().int().nonnegative(),
  gmNotes: z.number().int().nonnegative(),
});
export type ProgressFieldRevisions = z.infer<typeof ProgressFieldRevisions>;
export const ZERO_FIELD_REVISIONS: ProgressFieldRevisions = {
  status: 0,
  next: 0,
  blockers: 0,
  gmNotes: 0,
};

/** 誰寫的：GM（user）或 session 裡的 Claude（session）。名稱是讀取時查的，找不到（已刪）是 null。 */
export const ProgressActor = z.object({
  kind: z.enum(['user', 'session']),
  id: Id.nullable(),
  name: z.string().nullable(),
});
export type ProgressActor = z.infer<typeof ProgressActor>;

export const ProgressSource = z.enum(['web', 'mcp', 'restore']);
export type ProgressSource = z.infer<typeof ProgressSource>;

/**
 * 自動事實：hub 從既有資料算，不存、不呼叫模型、不可編輯。
 * tasks 只有團隊卡有（單獨 session 是 null）；recentFiles 是最近 24 小時的 `file.changed`（相對 repo 的路徑，最多 10 個）；
 * lastStopAt 是卡片最後更新之後，擁有者（團隊成員或該 session）最後一次回合結束（Stop）的時間；
 * 之後沒有回合結束、或卡片還沒寫過是 null。算「久未更新」用。
 */
export const ProgressFacts = z.object({
  /** 團隊卡：團隊名稱（畫面沒讀團隊清單時也能顯示，例如手機收件匣）；單獨 session 是 null。 */
  teamName: z.string().nullable().default(null),
  tasks: z
    .object({
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      doing: z.array(z.string()),
    })
    .nullable(),
  recentFiles: z.array(z.string()),
  phase: z.string().nullable(),
  members: z.array(
    z.object({
      sessionId: Id,
      name: z.string(),
      role: TeamRole.nullable(),
      status: SessionStatus,
      statusDetail: z.string().nullable(),
      ended: z.boolean(),
    }),
  ),
  lastStopAt: IsoTime.nullable(),
});
export type ProgressFacts = z.infer<typeof ProgressFacts>;

export const EMPTY_PROGRESS_FACTS: ProgressFacts = {
  teamName: null,
  tasks: null,
  recentFiles: [],
  phase: null,
  members: [],
  lastStopAt: null,
};

/**
 * 一張進度卡：屬於一個團隊（teamId），或一個不屬於任何團隊的單獨 session（sessionId），剛好一個不是 null。
 * 還沒寫過的卡 id 是 null、revision 0、欄位都是空字串。merged 只出現在寫入的回應：這次寫入和別人在
 * baseRevision 之後的改動沒有衝突、已合併。
 */
export const ProgressCard = ProgressFields.extend({
  id: Id.nullable(),
  teamId: Id.nullable(),
  sessionId: Id.nullable(),
  revision: z.number().int().nonnegative(),
  locked: z.boolean(),
  updatedAt: IsoTime.nullable(),
  updatedBy: ProgressActor.nullable(),
  fieldRevisions: ProgressFieldRevisions,
  facts: ProgressFacts,
  merged: z.boolean().optional(),
});
export type ProgressCard = z.infer<typeof ProgressCard>;

/** 歷史的一版（欄位快照）。restore＝以舊內容寫的新版本（不刪歷史）。 */
export const ProgressRevision = z.object({
  revision: z.number().int().positive(),
  fields: ProgressFields,
  by: ProgressActor,
  source: ProgressSource,
  at: IsoTime,
});
export type ProgressRevision = z.infer<typeof ProgressRevision>;

/**
 * 寫入衝突（409 progress_conflict 的 ApiError.detail）：目前的完整卡片，加上每個衝突欄位
 * 「你讀到的（base，歷史已修剪掉時 null）／現在的（current）」與最後改的人。
 */
export const ProgressConflict = z.object({
  card: ProgressCard,
  fields: z.array(
    z.object({
      field: z.enum(PROGRESS_FIELDS),
      base: z.string().nullable(),
      current: z.string(),
      by: ProgressActor.nullable(),
    }),
  ),
});
export type ProgressConflict = z.infer<typeof ProgressConflict>;

/** 寫入的 body（REST PUT）：只寫有帶的欄位；locked 只有 GM（網頁）能切。 */
export const ProgressWrite = z.object({
  baseRevision: z.number().int().nonnegative(),
  status: z
    .string()
    .max(PROGRESS_LIMITS.status * 2)
    .optional(),
  next: z
    .string()
    .max(PROGRESS_LIMITS.next * 2)
    .optional(),
  blockers: z
    .string()
    .max(PROGRESS_LIMITS.blockers * 2)
    .optional(),
  gmNotes: z
    .string()
    .max(PROGRESS_LIMITS.gmNotes * 2)
    .optional(),
  locked: z.boolean().optional(),
});
export type ProgressWrite = z.infer<typeof ProgressWrite>;

/** 卡片的擁有者：團隊或單獨 session。 */
export type ProgressOwner = { teamId: string } | { sessionId: string };
export const progressOwnerOf = (card: Pick<ProgressCard, 'teamId' | 'sessionId'>): ProgressOwner =>
  card.teamId !== null ? { teamId: card.teamId } : { sessionId: card.sessionId! };
export const progressOwnerKey = (owner: ProgressOwner): string =>
  'teamId' in owner ? `team:${owner.teamId}` : `session:${owner.sessionId}`;

/** 還沒寫過的空卡。 */
export function emptyProgressCard(
  owner: ProgressOwner,
  facts = EMPTY_PROGRESS_FACTS,
): ProgressCard {
  return {
    id: null,
    teamId: 'teamId' in owner ? owner.teamId : null,
    sessionId: 'sessionId' in owner ? owner.sessionId : null,
    ...EMPTY_PROGRESS_FIELDS,
    revision: 0,
    locked: false,
    updatedAt: null,
    updatedBy: null,
    fieldRevisions: { ...ZERO_FIELD_REVISIONS },
    facts,
  };
}

// ── 文字 ─────────────────────────────────────────────

const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g;
/** 卡片欄位可以多行（清單），保留 \n；其他控制字元（含 ESC、\r、NUL、U+2028/2029）一律拿掉。 */
const FIELD_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** 欄位存檔前清理：\r\n 變 \n、tab 變空白、拿掉其他控制字元與 ANSI、去掉結尾空白。 */
export function cleanProgressText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(ANSI, '')
    .replace(/\t/g, ' ')
    .replace(FIELD_CONTROL, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\s+$/, '');
}

/** 字數（code point），和上限比較用。 */
export const progressLength = (text: string): number => [...text].length;

/** 超過上限的欄位（清理後算）。 */
export function overLimit(fields: Partial<ProgressFields>): ProgressField[] {
  return PROGRESS_FIELDS.filter(
    (f) => fields[f] !== undefined && progressLength(fields[f]!) > PROGRESS_LIMITS[f],
  );
}

/** 一行：控制字元、換行都變成空白並壓成一個（要打進別人的 TUI，\r 與 ESC 一個都不能留）。 */
export function oneLine(text: string): string {
  return text.replace(ANSI, ' ').replace(LINE_CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** 第一個有字的行（去掉開頭的清單符號），收合顯示「下一步：<第一行>」用。 */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * 「帶入進度卡」送進 session 的一行：
 * `[Progress card: <名稱>] Status: … | Next: … | Blockers: … | GM notes: …`。
 * 空欄位略過、一行、清控制字元、超過 max（預設 4,000）字截斷。全部欄位都空時回 null（不送）。
 */
export function progressLine(
  name: string,
  fields: ProgressFields,
  max = PROGRESS_LINE_MAX,
): string | null {
  const parts = (
    [
      ['Status', fields.status],
      ['Next', fields.next],
      ['Blockers', fields.blockers],
      ['GM notes', fields.gmNotes],
    ] as const
  )
    .map(([label, value]) => [label, oneLine(value)] as const)
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`);
  if (parts.length === 0) return null;
  const line = `[Progress card: ${oneLine(name)}] ${parts.join(' | ')}`;
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : line;
}

// ── 三方比對（docs/p3-spec.md §1.4、§6） ───────────────────

export interface ProgressWritePlan {
  /** 這次真的會改的欄位（帶了而且和目前內容不同）。 */
  changed: ProgressField[];
  /** 要寫的欄位在 baseRevision 之後被別人改過：整筆拒絕。 */
  conflicts: ProgressField[];
  /** baseRevision 不是目前版本、但沒有衝突：合併寫入。 */
  merged: boolean;
}

/**
 * 決定一次寫入怎麼處理。base == 目前 revision → 直接寫；不相等 → 只看要寫的欄位：
 * 任何一個的 fieldRevisions[f] > base（base 之後被別人改過）就整筆拒絕，否則合併寫入（別人改的欄位保留）。
 * 帶了但和目前內容一樣的欄位不算改，也不算衝突。
 */
export function planProgressWrite(
  current: Pick<ProgressCard, 'revision' | 'fieldRevisions'> & ProgressFields,
  baseRevision: number,
  patch: Partial<ProgressFields>,
): ProgressWritePlan {
  const changed = PROGRESS_FIELDS.filter((f) => patch[f] !== undefined && patch[f] !== current[f]);
  if (baseRevision >= current.revision) return { changed, conflicts: [], merged: false };
  const conflicts = changed.filter((f) => current.fieldRevisions[f] > baseRevision);
  return { changed, conflicts, merged: conflicts.length === 0 && changed.length > 0 };
}

/**
 * 久未更新：最後更新超過 24 小時，而且之後擁有者還有回合結束（有 Stop）——有在動卻沒寫進度。
 * 卡片還沒寫過不算（畫面另外顯示「＋ 進度卡」）。
 */
export function progressStale(
  card: Pick<ProgressCard, 'updatedAt' | 'facts' | 'revision'>,
  now: number,
): boolean {
  if (card.revision === 0 || card.updatedAt === null || card.facts.lastStopAt === null) {
    return false;
  }
  const updated = Date.parse(card.updatedAt);
  return now - updated > PROGRESS_STALE_MS && Date.parse(card.facts.lastStopAt) > updated;
}

/** 沒有任何欄位有字（還沒寫過或寫成空白）。 */
export const progressIsBlank = (fields: ProgressFields): boolean =>
  PROGRESS_FIELDS.every((f) => fields[f].trim() === '');
