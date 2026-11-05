// 資料模型（DISPATCH §3、§4）。API 與 WebSocket 一律 camelCase；hub 自行對應 SQLite 的 snake_case。
import { z } from 'zod';

export const Id = z.string().min(1);
export const IsoTime = z.string().datetime({ offset: true });

/** DISPATCH §4 的 10 個狀態，加上 §8-4 排隊需要的 `queued`（Lead 增補）。 */
export const SessionStatus = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_permission',
  'waiting_input',
  'plan_review',
  'error',
  'rate_limited',
  'stuck',
  'done',
  'offline',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 需要人處理的狀態：進入時推播（§4），也是「下一個等我的」的範圍。 */
export const ATTENTION_STATUSES = [
  'waiting_permission',
  'waiting_input',
  'plan_review',
  'error',
  'stuck',
] as const satisfies readonly SessionStatus[];

export function needsAttention(status: SessionStatus): boolean {
  return (ATTENTION_STATUSES as readonly SessionStatus[]).includes(status);
}

/** `claude --permission-mode` 的值。`manual` 是 `default` 的別名，這裡統一存 `default`。 */
export const PermissionMode = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const UserRole = z.enum(['owner', 'member']);
/** 雙向交接的來回上限（`HandoffRule.action.maxRounds`）。 */
export const HANDOFF_MAX_ROUNDS = 10;
export const HANDOFF_MARKER_MAX_CHARS = 40;
export const Locale = z.enum(['zh-TW', 'en']);
export const TeamRole = z.enum(['lead', 'worker', 'researcher', 'reviewer']);
export const TaskColumn = z.enum(['todo', 'doing', 'review', 'done']);
/** on_marker：回合結束時，最後一則回覆含有指定的標記字串（GM 2026-11-06，寫作要求補實驗用）。 */
export const HandoffTrigger = z.enum(['on_done', 'on_file', 'on_fail', 'on_marker']);
/**
 * 學術研究團隊的階段（GM 2026-11-06）。團隊有這個欄位就是研究團隊；程式開發團隊沒有。
 * 選題 topic、實驗 experiment、寫作 writing、修稿／回覆審稿 revision。
 */
export const ResearchPhase = z.enum(['topic', 'experiment', 'writing', 'revision']);
export type ResearchPhase = z.infer<typeof ResearchPhase>;
/**
 * 研究團隊成員的分工，疊在 TeamRole 上：指導 ld＝lead、文獻 lr＝researcher、實驗 ex＝worker、
 * 寫作 wr＝worker、審稿 rv＝reviewer。實驗與寫作都是 worker，只能靠這個欄位分開（命名、換階段）。
 */
export const ResearchKind = z.enum(['ld', 'lr', 'ex', 'wr', 'rv']);
export type ResearchKind = z.infer<typeof ResearchKind>;
export const RESEARCH_KIND_ROLE = {
  ld: 'lead',
  lr: 'researcher',
  ex: 'worker',
  wr: 'worker',
  rv: 'reviewer',
} as const satisfies Record<ResearchKind, z.infer<typeof TeamRole>>;

export const User = z.object({
  id: Id,
  name: z.string().min(1),
  role: UserRole,
  locale: Locale,
});
export type User = z.infer<typeof User>;

export const MachineCapabilities = z.object({
  hasGpu: z.boolean(),
  gpuName: z.string().nullable(),
  cpuCores: z.number().int().positive(),
  memoryBytes: z.number().int().nonnegative(),
  claudeVersion: z.string().nullable(),
});
export type MachineCapabilities = z.infer<typeof MachineCapabilities>;

export const MachineOs = z.enum(['darwin', 'linux', 'win32']);

export const Machine = z.object({
  id: Id,
  name: z.string().min(1),
  os: MachineOs,
  online: z.boolean(),
  lastSeenAt: IsoTime.nullable(),
  capabilities: MachineCapabilities,
});
export type Machine = z.infer<typeof Machine>;

export const Project = z.object({ id: Id, name: z.string().min(1), color: z.string() });
export type Project = z.infer<typeof Project>;

export const Session = z.object({
  id: Id,
  machineId: Id,
  projectId: Id.nullable(),
  name: z.string().min(1),
  cwd: z.string().min(1),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  permissionMode: PermissionMode,
  model: z.string().nullable(),
  /** 該機器上的 CLAUDE_CONFIG_DIR 絕對路徑；null 表示用預設帳號。 */
  accountProfile: z.string().nullable(),
  status: SessionStatus,
  statusDetail: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  /** 摘要卡用：最後 4 行純文字（已去除 ANSI）。 */
  lastLines: z.array(z.string()).max(4),
  lastOutputAt: IsoTime.nullable(),
  /** 進入目前狀態的時間，用來算「等了多久」。 */
  statusSince: IsoTime,
  contextTokens: z.number().int().nonnegative().nullable(),
  /**
   * 目前模型的 context 上限（tokens），由 daemon 依模型 id 推得；不知道就是 null，前端不顯示百分比。
   * 來源與限制見 docs/claude-code-notes.md「Context 上限」。
   */
  contextWindow: z.number().int().positive().nullable().default(null),
  /** 實際工作資料夾所在 working tree 的根目錄（`git rev-parse --show-toplevel`）；不是 git 就是 null。 */
  repoRoot: z.string().nullable().default(null),
  /** 同一個 repo 的所有 worktree 共用這個值（`git rev-parse --git-common-dir` 的絕對路徑）。 */
  repoCommonDir: z.string().nullable().default(null),
  createdAt: IsoTime,
  endedAt: IsoTime.nullable(),
  archived: z.boolean(),
  /** 封存的時間；沒封存是 null。舊資料（schema 3 之前封存的）也是 null。 */
  archivedAt: IsoTime.nullable().default(null),
  /** 建立時指定的唯讀（`SessionSpec.readOnly`）：改檔工具被拿掉。Bash 仍可寫檔。 */
  readOnly: z.boolean().default(false),
});
export type Session = z.infer<typeof Session>;

// ── 封存、刪除、看舊資料（CONTRACTS §9） ─────────────────────────

/** Claude Code 的對話 id：只允許 uuid 形式，daemon 拿它組檔名，不能讓它跑出 projects 資料夾。 */
export const ClaudeSessionId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  // 一律小寫：macOS 檔案系統不分大小寫，大寫 id 會指到同一個 jsonl，共用檢查要比得到。
  .transform((id) => id.toLowerCase());

/** 刪除前的檢查：daemon 在機器上看到的狀況。 */
export const SessionInspect = z.object({
  /** 對話紀錄（`<id>.jsonl` 加同名資料夾）的大小；找不到是 null。 */
  transcriptBytes: z.number().int().nonnegative().nullable(),
  /** 實際工作資料夾（worktreePath ?? cwd）的 git 狀況；不是 git 或資料夾不見了是 null。 */
  git: z
    .object({
      dir: z.string(),
      /** `git status --porcelain` 的行數（沒 commit 的改動與未追蹤檔）。 */
      dirtyFiles: z.number().int().nonnegative(),
      /** 目前分支領先 upstream 的 commit 數；沒有 upstream 是 null。 */
      unpushedCommits: z.number().int().nonnegative().nullable(),
      branch: z.string().nullable(),
      /** 只有 session 有 worktree 時才算：它的分支有幾個 commit 不在主 worktree 的 HEAD 裡。 */
      unmergedCommits: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  /** session 的 worktree 資料夾還在不在；沒有 worktree 是 false。 */
  worktreeExists: z.boolean(),
  /** hub 填：同一個 cwd 還有別的（沒被刪的）session，hook 設定不能拿掉。 */
  hooksShared: z.boolean(),
  /** hub 填：同機器另一個 session 的 worktreePath 相同，或 cwd 在這個 worktree 裡，worktree 不能移除。 */
  worktreeShared: z.boolean().default(false),
  /** hub 填：同機器、同 accountProfile 有另一個 session 記著同一個 claudeSessionId，對話紀錄不能刪。 */
  transcriptShared: z.boolean().default(false),
});
export type SessionInspect = z.infer<typeof SessionInspect>;

export const PurgeOptions = z.object({
  /** 移除 worktree 資料夾（不加 --force，有改動就留著）並 `git branch -d`（沒合併就留著）。 */
  removeWorktree: z.boolean(),
  /** 刪掉 Claude 對話紀錄 `<config>/projects/*\/<claudeSessionId>.jsonl` 與同名資料夾。 */
  removeTranscript: z.boolean(),
  /** 從 cwd 的 `.claude/settings.local.json` 拿掉 agent-board-hook 項目（hooksShared 時 hub 拒絕）。 */
  removeHooks: z.boolean(),
});
export type PurgeOptions = z.infer<typeof PurgeOptions>;

/** removed：刪了；kept：故意留著（detail 說原因，例如有改動、分支沒合併）；not_found：本來就沒有；skipped：沒勾或做不到；failed：出錯。 */
export const PurgeOutcome = z.object({
  status: z.enum(['removed', 'kept', 'not_found', 'skipped', 'failed']),
  detail: z.string().nullable(),
});
export type PurgeOutcome = z.infer<typeof PurgeOutcome>;

export const PurgeResult = z.object({
  worktree: PurgeOutcome,
  transcript: PurgeOutcome,
  hooks: PurgeOutcome,
});
export type PurgeResult = z.infer<typeof PurgeResult>;

/** 對話紀錄的一則。tool：工具呼叫（→ 名稱 參數摘要）或工具結果，內容截短。 */
export const TranscriptEntry = z.object({
  /** 在整份對話裡的序號（從 0 起），搜尋結果也保留原序號。 */
  index: z.number().int().nonnegative(),
  role: z.enum(['user', 'assistant', 'tool']),
  at: IsoTime.nullable(),
  text: z.string(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

export const TranscriptPage = z.object({
  entries: z.array(TranscriptEntry),
  /** 整份對話的則數。 */
  total: z.number().int().nonnegative(),
  /** 有搜尋字時，符合的則數；沒搜尋是 null。 */
  matched: z.number().int().nonnegative().nullable(),
  /** 下一頁的 cursor；沒有了是 null。 */
  nextCursor: z.number().int().nonnegative().nullable(),
  /** 找不到對話紀錄檔（已刪、沒有 claude id、換了機器）。 */
  missing: z.boolean(),
});
export type TranscriptPage = z.infer<typeof TranscriptPage>;

export const SessionEvent = z.object({
  id: Id,
  sessionId: Id,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  at: IsoTime,
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const Layout = z.object({
  workspace: z.string().min(1),
  sessionId: Id,
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Layout = z.infer<typeof Layout>;

export const Note = z.object({
  id: Id,
  workspace: z.string().min(1),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  color: z.string(),
});
export type Note = z.infer<typeof Note>;

export const Team = z.object({
  id: Id,
  name: z.string().min(1),
  goal: z.string(),
  doneCriteria: z.string(),
  color: z.string(),
  contextMd: z.string(),
  /** 研究團隊目前的階段；程式開發團隊沒有（舊資料也沒有）。 */
  phase: ResearchPhase.optional(),
});
export type Team = z.infer<typeof Team>;

export const TeamMember = z.object({
  teamId: Id,
  sessionId: Id,
  role: TeamRole,
  /** 研究團隊的分工；沒有就照角色推（worker 當實驗）。和 role 對不上時以 role 為準。 */
  kind: ResearchKind.optional(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const Task = z.object({
  id: Id,
  teamId: Id,
  title: z.string().min(1),
  ownerSessionId: Id.nullable(),
  column: TaskColumn,
});
export type Task = z.infer<typeof Task>;

export const HandoffRule = z.object({
  id: Id,
  teamId: Id,
  fromSessionId: Id,
  trigger: HandoffTrigger,
  action: z.object({
    toSessionId: Id,
    filePattern: z.string().optional(),
    /**
     * 有設定就允許交接回鏈裡已經出現過的 session（雙向來回）：目標在鏈裡出現的次數 < maxRounds 才送，
     * 否則擋下（round_limit）並通知使用者。沒設定維持原本的防迴圈（目標在鏈裡就擋）。
     */
    maxRounds: z.number().int().min(1).max(HANDOFF_MAX_ROUNDS).optional(),
    /** on_marker 用：最後一則回覆含有這個字串（純子字串比對）就觸發。 */
    marker: z
      .string()
      .max(HANDOFF_MARKER_MAX_CHARS)
      .refine((m) => m.trim() !== '', 'marker must not be blank')
      .optional(),
  }),
  enabled: z.boolean(),
});
export type HandoffRule = z.infer<typeof HandoffRule>;

/** zod 物件本身不檢查欄位之間的關係：建立與修改後 hub 用這個再檢查一次，前端送出前也用。 */
export function handoffRuleProblem(
  rule: Pick<HandoffRule, 'trigger' | 'action'>,
): 'marker_required' | null {
  if (rule.trigger === 'on_marker' && !rule.action.marker?.trim()) return 'marker_required';
  return null;
}

/** §8 省額度預設。 */
export const QuotaGuards = z.object({
  denyReadPaths: z.array(z.string()),
  maxConcurrentSessions: z.number().int().positive().nullable(),
  /**
   * §8-5：同一個帳號（同機器 + 同 accountProfile）有 session 限流時，新開或接續的 session 先排隊，
   * 等該帳號沒有限流中的 session（或已知的重置時間過了）才開始。舊設定沒有這個鍵，預設開。
   */
  queueWhenRateLimited: z.boolean().default(true),
});

/** 排隊原因寫在 `statusDetail`；併發上限排隊維持 null（沿用舊行為）。 */
export const QUEUE_DETAIL_RATE_LIMITED = 'queue:rate_limited';

export const TemplateConfig = z.object({
  machineId: Id.nullable(),
  cwd: z.string().nullable(),
  permissionMode: PermissionMode,
  model: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  quotaGuards: QuotaGuards,
});

export const Template = z.object({ id: Id, name: z.string().min(1), config: TemplateConfig });
export type Template = z.infer<typeof Template>;

export const AuditEntry = z.object({
  id: Id,
  userId: Id.nullable(),
  sessionId: Id.nullable(),
  action: z.string().min(1),
  detail: z.string(),
  at: IsoTime,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/**
 * 等人決定的請求。擁有者是 daemon（hook 正卡在本機 socket 上等答案），hub 只快取與轉送，
 * 不另開資料表；決定結果寫進 audit_log 與 session_events。
 */
export const ApprovalKind = z.enum(['permission', 'danger', 'plan', 'question']);
export const Approval = z.object({
  id: Id,
  sessionId: Id,
  kind: ApprovalKind,
  toolName: z.string().nullable(),
  toolInput: z.record(z.string(), z.unknown()).nullable(),
  /** Claude Code 提供的 permission_suggestions，原樣保留給「允許並記住」。 */
  suggestions: z.array(z.unknown()),
  /** 命中的危險指令規則；非 danger 為 null。 */
  matchedRule: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: IsoTime,
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalDecision = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('allow'), remember: z.boolean().default(false) }),
  z.object({ behavior: z.literal('deny'), reason: z.string().trim().min(1) }),
  /** 回答提問（kind: question）。和 deny 分開，audit 才不會把回答記成拒絕。 */
  z.object({ behavior: z.literal('answer'), text: z.string().trim().min(1) }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ResourceSample = z.object({
  machineId: Id,
  at: IsoTime,
  cpuPercent: z.number().min(0).max(100),
  memoryUsedBytes: z.number().int().nonnegative(),
  memoryTotalBytes: z.number().int().nonnegative(),
  gpu: z
    .object({
      name: z.string(),
      utilizationPercent: z.number().min(0).max(100),
      memoryUsedBytes: z.number().int().nonnegative(),
      memoryTotalBytes: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type ResourceSample = z.infer<typeof ResourceSample>;

export const UsageSummary = z.object({
  machineId: Id,
  from: IsoTime,
  to: IsoTime,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/** Lead 增補的 `settings` 鍵值表內容（§3 沒有列，但 §5.3-7、§7、§8 都需要）。 */
export const Settings = z.object({
  listenAddress: z.string(),
  publicOrigin: z.string().url().nullable(),
  stuckMinutes: z.number().int().positive(),
  dangerRules: z.array(z.string()),
  quotaGuards: QuotaGuards,
  notifications: z.object({
    enabled: z.boolean(),
    quietHours: z.object({ start: z.string(), end: z.string() }).nullable(),
  }),
});
export type Settings = z.infer<typeof Settings>;

/** 預設危險指令清單（§7）。比對方式見 CONTRACTS.md §4.3。 */
export const DEFAULT_DANGER_RULES = ['rm -rf /', 'rm -r /', 'git push --force', 'git reset --hard'];
export const DEFAULT_STUCK_MINUTES = 10;
