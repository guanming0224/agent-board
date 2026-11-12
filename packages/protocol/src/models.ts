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

/**
 * session 裡跑的是哪個官方 CLI（Codex 接口第一版，GM 2026-11-10）。都是使用者自己登入的互動式 CLI，
 * 由 daemon 開在 PTY 裡；中控台本身不呼叫模型。舊資料、舊版 hub／daemon 不送＝`claude`。
 */
export const AgentKind = z.enum(['claude', 'codex']);
export type AgentKind = z.infer<typeof AgentKind>;
/** 沒寫 agent 的 session 或 spec 一律當成 Claude Code。 */
export const agentOf = (value: { agent?: AgentKind | undefined }): AgentKind =>
  value.agent ?? 'claude';

export const UserRole = z.enum(['owner', 'member']);
/** 雙向交接的來回上限（`HandoffRule.action.maxRounds`）。 */
export const HANDOFF_MAX_ROUNDS = 10;
export const HANDOFF_MARKER_MAX_CHARS = 40;
export const Locale = z.enum(['zh-TW', 'en']);
/**
 * 團隊角色：隊長、成員、研究、審查，P2 加「測試」（tester，GM 2026-11-08 Q5）：可寫檔、權限模式預設 default（每步問）、
 * 可被派任務（同成員）、不當審查、MCP `spawn_member` 可開。
 */
export const TeamRole = z.enum(['lead', 'worker', 'researcher', 'reviewer', 'tester']);
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
  /**
   * `codex --version` 的版本號（Codex 接口第一版）。找不到 codex、或舊版 daemon 不送＝沒有；
   * 新增 session 只有這台回報了版本才能選 Codex（hub 也會擋）。
   */
  codexVersion: z.string().nullable().optional(),
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

// ── 工作區（P2 項目二，GM 2026-11-08） ─────────────────────
/**
 * 工作區：GM 手動分的一組團隊與單獨 session，畫布一次只顯示一個。全 hub 共用、至少一個。
 * 程式內一律叫 zone（`zoneId`、`zones` 表），和既有的 `layouts.workspace`（版面組 `'default'`）分開，避免混淆。
 * 團隊成員所在的工作區跟著團隊（`Team.zoneId`）；不屬於任何團隊的 session 看自己的 `Session.zoneId`。
 */
export const ZONE_NAME_MAX = 40;
export const ZoneName = z.string().trim().min(1).max(ZONE_NAME_MAX);
export const Zone = z.object({
  id: Id,
  name: ZoneName,
  createdAt: IsoTime,
  /** 排序值（建立順序，P2 不做拖曳排序）。 */
  position: z.number().int(),
});
export type Zone = z.infer<typeof Zone>;
/** schema v9 升級時建立的預設工作區（Q3：名稱「主要」）；舊資料全部歸進去。 */
export const DEFAULT_ZONE_ID = 'main';
export const DEFAULT_ZONE_NAME = '主要';
/** 畫布座標存在這個版面組（layouts.workspace）；工作區只是顯示篩選，不分版面組。 */
export const CANVAS_LAYOUT_SET = 'default';
export type Project = z.infer<typeof Project>;

/**
 * 一次限流的自動接續。`limitSince` 是進入那次限流的時間（`statusSince`），同一次限流只排一次。
 * scheduled：等 `at`（重置時間＋60 秒）到；sent：已送出；cancelled：沒送（`reason` 是原因代碼）。
 */
export const AutoContinueState = z.enum(['scheduled', 'sent', 'cancelled']);
export const AutoContinue = z.object({
  state: AutoContinueState,
  /** 預定送出的時間。 */
  at: IsoTime,
  /** 從限流訊息讀出的重置時間。 */
  resetAt: IsoTime,
  limitSince: IsoTime,
  /** cancelled 的原因：user_input、resumed、setting_off、ended 等。 */
  reason: z.string().nullable().default(null),
});
export type AutoContinue = z.infer<typeof AutoContinue>;

/** 自動接續送進 session 的固定一行（不經過模型、不帶任何對話內容）。 */
export const AUTO_CONTINUE_PROMPT =
  '[Auto] The usage limit has reset. Continue where you left off.';

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
  /**
   * 額度恢復後自動接續（GM 2026-11-06，`Settings.autoContinue`）：只有 hub 寫，schema v7 `sessions.auto_continue`。
   * 沒排過是 null。見 `AutoContinue`。
   */
  autoContinue: AutoContinue.nullable().default(null),
  /**
   * 由哪個 session 用派工工具（MCP `spawn_member`）開的；使用者自己開的是 null（GM 2026-11-06，schema v8
   * `sessions.dispatched_by`）。只有 hub 寫，卡片顯示「派工自 …」，也用來算同一個呼叫者的成員上限。
   */
  dispatchedBy: Id.nullable().default(null),
  /**
   * 單獨 session 所在的工作區（schema v9 `sessions.zone_id`）。是團隊成員時以團隊的工作區為準，這欄被忽略但保留
   * （離開團隊時 hub 把它設成團隊所在的工作區）。舊版 hub 不送＝預設工作區。
   */
  zoneId: Id.default(DEFAULT_ZONE_ID),
  /**
   * 跑的是哪個 CLI（`AgentKind`）。不送＝Claude Code（舊 hub、舊資料）。hub 存在 settings 表
   * `sessionAgent:<id>`（只有 codex 才寫，不升 schema）。`claudeSessionId` 在 Codex session 裡是 Codex 的
   * thread id（`codex resume <id>` 用）。
   */
  agent: AgentKind.optional(),
  /**
   * `waiting_input` 時其實在等誰（GM 2026-11-11，CONTRACTS §11.4）：只有 hub 算，不存資料庫欄位。
   * `lead`：派工成員的結果已送回隊長（或正要送回），在等隊長下一步；`members`：隊長手上還有派出去、
   * 結果還沒回來的工作。畫面上是 NEW（等隊長／等成員結果），不算「等你」、不推播。
   * 不是 `waiting_input` 時不送；舊 hub 不送＝照舊（ASK）。
   */
  awaiting: z.enum(['lead', 'members']).optional(),
});
export type Session = z.infer<typeof Session>;
export type SessionAwaiting = NonNullable<Session['awaiting']>;

// ── session 派工（MCP 工具，GM 2026-11-06，CONTRACTS §11） ──────────────

/** Claude Code 裡看到的 MCP server 名稱：工具全名是 `mcp__agent-board__<tool>`。 */
export const DISPATCH_MCP_SERVER = 'agent-board';
/**
 * 派工工具。只有這六個，hub 依呼叫者的團隊判斷能不能做。release_member 是隊長自主擴編（GM 2026-11-10）加的：
 * 隊長封存自己團隊的成員，空出名額。request_review 是交叉審查（Codex 第二輪，GM 2026-11-12）：隊長要求
 * Claude 與 Codex 各審一次（理由必填、每隊每小時有上限、推播通知 GM）。
 */
export const DispatchTool = z.enum([
  'list_members',
  'spawn_member',
  'send_task',
  'get_result',
  'release_member',
  'request_review',
]);
export type DispatchTool = z.infer<typeof DispatchTool>;
/**
 * 團隊總人數上限（隊長自主擴編，GM 2026-11-10）：含隊長、GM 原本配的，所有沒封存的成員。
 * 存在設定 `autoStaff.teamLimit`，設定頁可改（2–20）。取代舊的「每個呼叫者同時 4 個」。
 */
export const TEAM_SIZE_DEFAULT = 12;
export const TEAM_SIZE_MIN = 2;
export const TEAM_SIZE_MAX = 20;
/** 同一個團隊 10 分鐘內最多新增幾個成員（防爆量；和送工作的 10 分鐘上限同一個視窗）。 */
export const DISPATCH_SPAWN_RATE_MAX = 4;
/** `spawn_member` 可開的角色：隊長只能是呼叫者自己。 */
export const DISPATCH_ROLES = ['worker', 'researcher', 'reviewer', 'tester'] as const;
/**
 * 成員手上還沒回報結果的一份工作（hub 內部，存在 `sessions.dispatch_work`）：spawn 的第一個指令或 send_task 送達時寫，
 * 成員下一次回合結束（Stop）就把結果送回 `from` 並清掉，所以一份工作只回報一次。
 */
export const DispatchWork = z.object({
  from: Id,
  workId: Id,
  kind: z.enum(['spawn', 'send']),
  at: IsoTime,
});
export type DispatchWork = z.infer<typeof DispatchWork>;

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
  /** 便利貼所在的工作區（schema v9 起；原本的 `notes.workspace` 欄改名，舊資料都歸預設工作區）。 */
  zoneId: Id,
  x: z.number(),
  y: z.number(),
  text: z.string(),
  color: z.string(),
});
export type Note = z.infer<typeof Note>;

/**
 * 全隊暫停／全隊停止記下的「這次為了這個團隊關掉的東西」（GM 2026-11-09，CONTRACTS §17）。
 * 存在 hub 的 settings 表（鍵 `teamHold:<teamId>`，不升 schema），hub 重啟後仍在；「全隊繼續／全隊啟動」照它恢復，
 * 恢復完就清掉。pause＝送了 Esc；stop＝停了 session（暫停後再停止也算 stop）。
 */
export const TeamHoldMode = z.enum(['pause', 'stop']);
export type TeamHoldMode = z.infer<typeof TeamHoldMode>;

export const TeamHold = z.object({
  mode: TeamHoldMode,
  /** 第一次按暫停或停止的時間；之後再按不重算。 */
  since: IsoTime,
  /** 最後一次按的使用者。 */
  by: Id,
  byName: z.string(),
  /** 為了這個團隊關掉的交接規則（原本是開的）。 */
  ruleIds: z.array(Id),
  /** 任務自動執行原本是開的、被關掉了。 */
  taskAuto: z.boolean(),
  /** 停止時被停掉的成員（原本活著、停止要求有送出）。全隊啟動只接回這些。 */
  stoppedSessionIds: z.array(Id),
});
export type TeamHold = z.infer<typeof TeamHold>;

export const Team = z.object({
  id: Id,
  name: z.string().min(1),
  goal: z.string(),
  doneCriteria: z.string(),
  color: z.string(),
  contextMd: z.string(),
  /** 研究團隊目前的階段；程式開發團隊沒有（舊資料也沒有）。 */
  phase: ResearchPhase.optional(),
  /**
   * 任務自動執行（GM 2026-11-06，schema v6）：開著時 hub 會把進行中的任務送給負責人、把待審查的送給審查，
   * 會花成員的額度，所以預設關（舊資料也是關）。hub 回傳時一定帶；建立、修改時可以不帶。
   */
  taskAuto: z.boolean().optional(),
  /** 團隊所在的工作區（schema v9 `teams.zone_id`）；成員跟著團隊。 */
  zoneId: Id,
  /** 全隊暫停／停止後還沒恢復時才有（hub 回傳時附上；建立、修改時不能帶）。 */
  hold: TeamHold.optional(),
});
export type Team = z.infer<typeof Team>;

/** 回報結果裡提到的 session。 */
export const TeamSessionRef = z.object({ sessionId: Id, name: z.string() });
export type TeamSessionRef = z.infer<typeof TeamSessionRef>;

/** 全隊暫停／停止的結果。rules、taskAuto 是這次才關掉的（已經關著的不算）。 */
export const TeamHoldResult = z.object({
  team: Team,
  rules: z.number().int().nonnegative(),
  taskAuto: z.boolean(),
  /** pause：送了 Esc 的（工作中、卡住的）。 */
  interrupted: z.array(TeamSessionRef),
  /** pause：該送 Esc 但機器失聯、沒送到的。 */
  offline: z.array(TeamSessionRef),
  /** stop：已要求停止的。 */
  stopped: z.array(TeamSessionRef),
  /** stop：停不了的（code 例如 machine_offline）。 */
  failed: z.array(TeamSessionRef.extend({ code: z.string() })),
});
export type TeamHoldResult = z.infer<typeof TeamHoldResult>;

/** 全隊繼續／全隊啟動的結果。mode 是 null＝沒有記錄（別的裝置已經恢復過），什麼都沒做。 */
export const TeamResumeResult = z.object({
  team: Team,
  mode: TeamHoldMode.nullable(),
  rules: z.object({
    /** 這次打開的。 */
    enabled: z.number().int().nonnegative(),
    /** 暫停後已經被手動打開的（不重複開）。 */
    alreadyOn: z.number().int().nonnegative(),
    /** 暫停後被刪掉的（略過）。 */
    deleted: z.number().int().nonnegative(),
  }),
  /** enabled：這次打開；already_on：已被手動打開；none：當初沒關它。 */
  taskAuto: z.enum(['enabled', 'already_on', 'none']),
  /** stop：已用 `--resume` 接回原對話的。 */
  resumed: z.array(TeamSessionRef),
  /** stop：機器失聯、還沒接回的（記錄留著，機器回來再按一次）。 */
  offline: z.array(TeamSessionRef),
  /** stop：已經在跑（例如手動接續過）的，略過。 */
  alreadyRunning: z.array(TeamSessionRef),
  /** stop：接不回的（code 例如 no_claude_session）。 */
  failed: z.array(TeamSessionRef.extend({ code: z.string() })),
  /** stop：已刪除或已離開團隊的成員，略過的數量。 */
  gone: z.number().int().nonnegative(),
  /** 目前是全部暫停中：規則打開了，但自動送字仍會被擋。 */
  boardPaused: z.boolean(),
});
export type TeamResumeResult = z.infer<typeof TeamResumeResult>;

/** 隊長用 spawn_member 加進來的成員：誰加的、理由（隊長自主擴編，存在 settings 表 `memberAdded:<sessionId>`）。 */
export const MemberAdded = z.object({
  bySessionId: Id,
  byName: z.string(),
  reason: z.string(),
  at: IsoTime,
});
export type MemberAdded = z.infer<typeof MemberAdded>;

export const TeamMember = z.object({
  teamId: Id,
  sessionId: Id,
  role: TeamRole,
  /** 研究團隊的分工；沒有就照角色推（worker 當實驗）。和 role 對不上時以 role 為準。 */
  kind: ResearchKind.optional(),
  /** 由隊長新增的才有（hub 回傳時附上；建立、修改時帶了也不會存）。舊版 hub 不送。 */
  added: MemberAdded.optional(),
});
export type TeamMember = z.infer<typeof TeamMember>;

/**
 * 團隊動態（隊長自主擴編，GM 2026-11-10）：隊長新增或封存成員時記一筆，收件匣的「團隊動態」列出來。
 * 只是告知、不需要動作；可以標已讀、清除。存在 settings 表 `teamActivity`（最多 `TEAM_ACTIVITY_KEEP` 筆，舊的先丟）。
 */
/** review_requested：隊長用 `request_review` 要求交叉審查（Codex 第二輪；成員欄位是審查對象，分支審查時是隊長自己）。 */
export const TeamActivityKind = z.enum(['member_added', 'member_released', 'review_requested']);
export type TeamActivityKind = z.infer<typeof TeamActivityKind>;
export const TeamActivity = z.object({
  id: Id,
  at: IsoTime,
  kind: TeamActivityKind,
  teamId: Id,
  teamName: z.string(),
  leadSessionId: Id,
  leadName: z.string(),
  memberSessionId: Id,
  memberName: z.string(),
  role: TeamRole,
  /** 隊長給的理由（Claude 寫的一句，已清控制字元、截斷）。 */
  reason: z.string(),
  read: z.boolean(),
  /** review_requested 的審查 id（點了開結果）。 */
  reviewId: Id.optional(),
});
export type TeamActivity = z.infer<typeof TeamActivity>;
export const TEAM_ACTIVITY_KEEP = 100;

/** 審查退回幾次就停下等使用者（GM 2026-11-06）。 */
export const TASK_REJECT_LIMIT = 3;

/**
 * 任務自動執行最後做到哪一步，任務卡顯示用。
 * queued／review_queued：等負責人／審查有空（`waiting_input`）才送；sent／review_sent：已送出、等回覆；
 * reported：負責人回報完成、團隊沒有審查（等使用者審）；passed：審查通過；
 * limit：退回到上限，停下等使用者；dropped：沒送出（原因在 note）。
 */
export const TaskAutoState = z.enum([
  'queued',
  'sent',
  'reported',
  'review_queued',
  'review_sent',
  'passed',
  'limit',
  'dropped',
]);
export type TaskAutoState = z.infer<typeof TaskAutoState>;

export const TaskAuto = z.object({
  state: TaskAutoState,
  /** 這一步對象的 session（負責人或審查）。 */
  sessionId: Id.nullable(),
  /** reported／review_*：負責人的一句摘要；limit：退回原因；dropped：原因代碼。 */
  note: z.string().optional(),
  at: IsoTime,
});
export type TaskAuto = z.infer<typeof TaskAuto>;

export const Task = z.object({
  id: Id,
  teamId: Id,
  title: z.string().min(1),
  ownerSessionId: Id.nullable(),
  column: TaskColumn,
  /** 團隊內的短編號（#n），任務提示與完成標記用。建立時決定、不重複使用。 */
  number: z.number().int().positive(),
  /** 審查退回的次數；使用者移動卡片不會歸零。 */
  rejectCount: z.number().int().nonnegative(),
  /** 退回到上限，自動流程停下等使用者決定；使用者移動卡片或換負責人就清掉。 */
  needsUser: z.boolean(),
  /** 最近一次送審的審查 session；同一個任務再送審時沿用。 */
  reviewerSessionId: Id.nullable(),
  auto: TaskAuto.nullable(),
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

export const WAITING_LIMIT_MIN = 1;
export const WAITING_LIMIT_MAX = 20;
export const DEFAULT_WAITING_LIMIT = 3;

/** 隊長自主擴編的設定（`Settings.autoStaff`）。 */
export const AutoStaff = z.object({
  enabled: z.boolean().default(true),
  teamLimit: z.number().int().min(TEAM_SIZE_MIN).max(TEAM_SIZE_MAX).default(TEAM_SIZE_DEFAULT),
  push: z.boolean().default(true),
});
export type AutoStaff = z.infer<typeof AutoStaff>;
export const AUTO_STAFF_DEFAULT: AutoStaff = {
  enabled: true,
  teamLimit: TEAM_SIZE_DEFAULT,
  push: true,
};

/** 隊長 `request_review` 的預設頻率上限：同一隊每小時最多幾次（設定頁可改，Codex 第二輪）。 */
export const REVIEW_LEAD_RATE_DEFAULT = 3;
export const REVIEW_LEAD_RATE_MAX = 20;

/** 交叉審查的設定（`Settings.review`，Codex 第二輪，docs/codex-round2-spec.md §2）。 */
export const ReviewSettings = z.object({
  /** 隊長 `request_review` 同一隊每小時最多幾次；0＝隊長不能發起。 */
  leadPerHour: z.number().int().min(0).max(REVIEW_LEAD_RATE_MAX).default(REVIEW_LEAD_RATE_DEFAULT),
  /** Claude 那一邊的模型；null＝CLI 自己的預設。 */
  claudeModel: z.string().max(100).nullable().default(null),
  /** Codex 那一邊的模型；null＝CLI 自己的預設。 */
  codexModel: z.string().max(100).nullable().default(null),
  /** Codex 的推理強度（`-c model_reasoning_effort=…`）；null＝CLI 預設。 */
  codexEffort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().default(null),
});
export type ReviewSettings = z.infer<typeof ReviewSettings>;
export const REVIEW_SETTINGS_DEFAULT: ReviewSettings = {
  leadPerHour: REVIEW_LEAD_RATE_DEFAULT,
  claudeModel: null,
  codexModel: null,
  codexEffort: null,
};

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
    /**
     * 合併通知（GM 2026-11-06）：等一小段時間（`NOTIFY_WINDOW_MS`，權限請求 `NOTIFY_PERMISSION_WINDOW_MS`，
     * 最多 `NOTIFY_MAX_WINDOW_MS`），再送一則列出所有在等你的。關掉＝每個事件各自推播（舊行為）。舊設定沒有這個鍵，預設開。
     */
    coalesce: z.boolean().default(true),
    /** 同時等你的上限：超過時頁面顯示橫幅、推播一次（每次超過一次）。 */
    waitingLimit: z
      .number()
      .int()
      .min(WAITING_LIMIT_MIN)
      .max(WAITING_LIMIT_MAX)
      .default(DEFAULT_WAITING_LIMIT),
  }),
  /**
   * 額度恢復後自動接續（GM 2026-11-06）：session 因額度停下、知道重置時間時，到時候送 `AUTO_CONTINUE_PROMPT`。
   * 會花額度，預設關（和任務自動執行同一個原則）。
   */
  autoContinue: z.boolean().default(false),
  /**
   * 允許 session 派工（MCP 工具，GM 2026-11-06）：開著時 daemon 新開的 claude 會帶 `--mcp-config` 掛上
   * `agent-board` 工具，讓畫布上的 Claude 自己開成員、送工作、收結果。工具本身不花額度（要 Claude 決定呼叫），
   * 但開成員會開新的 session，所以設定頁標 ◈，團隊人數上限見 `autoStaff`。預設開；
   * 關掉後新開或接續的 session 不掛工具，已掛著的呼叫一律回「已關閉」。
   */
  dispatch: z.boolean().default(true),
  /**
   * 讓 session 讀寫進度卡（MCP 工具 get_progress／update_progress，P3 項目一，docs/p3-spec.md §1.3）。
   * 預設開（§7.2-D3）：工具本身不花額度、不會自己動，是 Claude 呼叫才有作用。關掉後新開或接續的 session
   * 不掛這兩個工具（派工也關著就完全不掛 MCP server）；已掛著的呼叫一律回 `memory_disabled`。
   */
  memory: z.boolean().default(true),
  /**
   * 隊長自主擴編（GM 2026-11-10，CONTRACTS §11.1）。enabled：隊長可以用 spawn_member 新增、release_member 封存成員；
   * 關掉＝兩個都回 `autostaff_disabled`，只能用現有成員。teamLimit：團隊總人數上限（含隊長、沒封存的）。
   * push：新增或封存成員時推播（收件匣的「團隊動態」不受影響）。舊設定沒有這個鍵＝全部預設。
   */
  autoStaff: AutoStaff.default(AUTO_STAFF_DEFAULT),
  /** 交叉審查（Codex 第二輪）：隊長頻率上限、兩邊的模型。舊設定沒有這個鍵＝預設。 */
  review: ReviewSettings.default(REVIEW_SETTINGS_DEFAULT),
});
export type Settings = z.infer<typeof Settings>;

// ── 全部暫停（P2 項目三，GM 2026-11-08） ─────────────────────
/**
 * finish_turn：做完這輪就停——擋所有自動送字與自動開新 session，正在跑的回合跑完。
 * interrupt：立刻中斷——同上，另外對每個 RUN（`running`）的 session 送一次 Esc。interrupt 一定包含 finish_turn 的閘門。
 */
export const BoardPauseMode = z.enum(['finish_turn', 'interrupt']);
export type BoardPauseMode = z.infer<typeof BoardPauseMode>;

/** 暫停中的狀態。存在 hub 的 settings 表（鍵 `boardPause`，不是 `Settings` 的欄位），hub 重啟後仍是暫停。 */
export const BoardPause = z.object({
  mode: BoardPauseMode,
  /** 第一次按暫停的時間；暫停中改模式不重算。 */
  since: IsoTime,
  /** 按暫停的使用者（最後一次）。 */
  by: Id.nullable(),
  byName: z.string().nullable(),
  /**
   * 暫停中 hub 重啟、記憶體裡被擋下的送字因此清掉的則數（自動接續存在資料庫，不算在內）。0＝沒有。
   * 畫面在提示列註明「hub 重啟，N 則排隊已清除」；按「全部繼續」後歸零。
   */
  clearedOnRestart: z.number().int().nonnegative().default(0),
});
export type BoardPause = z.infer<typeof BoardPause>;

/** 被暫停擋下、繼續時會放出的東西（「全部繼續」前顯示）。 */
export const BoardHeld = z.object({
  /** 排隊中的送字（交接、任務自動執行、MCP 派工送工作與回報結果）。 */
  deliveries: z.number().int().nonnegative(),
  /**
   * 繼續後會馬上開的 QUE：只因為暫停才沒開的（帳號沒限流、機器在線），再依同時 session 上限截斷。
   * 因名額不足或帳號限流而排隊的不算（繼續後也不會開），另見 `sessionsWaiting`。
   */
  sessions: z.number().int().nonnegative(),
  /** 其餘排隊中的 QUE（等名額、等帳號限流解除、機器離線）：繼續後也不會馬上開。舊版 hub 不送＝0。 */
  sessionsWaiting: z.number().int().nonnegative().default(0),
  /** 已到期、等著送出的額度恢復自動接續。 */
  autoContinues: z.number().int().nonnegative(),
});
export type BoardHeld = z.infer<typeof BoardHeld>;

/** 暫停狀態＋排隊統計。沒暫停時 paused 是 null（held 照算，QUE 可能因名額在排）。 */
export const BoardPauseState = z.object({
  paused: BoardPause.nullable(),
  held: BoardHeld,
});
export type BoardPauseState = z.infer<typeof BoardPauseState>;

export const NOT_PAUSED: BoardPauseState = {
  paused: null,
  held: { deliveries: 0, sessions: 0, sessionsWaiting: 0, autoContinues: 0 },
};

/**
 * 「立刻中斷」對每個 RUN session 的結果。requested＝已請 daemon 送 Esc（daemon 再確認狀態是 running 才送，
 * 實際結果記在 audit：送了照 Esc 處理，沒送寫 `board.interrupt_skipped`）；offline＝機器失聯沒送到；
 * unsupported＝daemon 版本太舊、無法在送之前再確認狀態，為了不把權限請求按成拒絕，沒送。
 */
export const BoardInterruptResult = z.object({
  sessionId: Id,
  name: z.string(),
  result: z.enum(['requested', 'offline', 'unsupported']),
});
export type BoardInterruptResult = z.infer<typeof BoardInterruptResult>;

// ── 群發（P2 項目二：團隊面板底部的指令框） ─────────────────
/**
 * 群發給一個對象的結果。sent：已打字並按 Enter（或正在送）；queued：對象不在等輸入（RUN、PERM、PLAN、ERR、QUOTA、QUE、OFF、
 * 啟動中），等它變回等輸入才送；skipped：對象已結束或封存，沒送；cancelled：GM 取消排隊；
 * failed：沒送出（reason：target_ended、not_waiting＝打字後狀態變了沒按 Enter、hub_restarted 由前端標）。
 */
export const BroadcastState = z.enum(['sent', 'queued', 'skipped', 'cancelled', 'failed']);
export type BroadcastState = z.infer<typeof BroadcastState>;
export const BroadcastTarget = z.object({
  sessionId: Id,
  name: z.string(),
  state: BroadcastState,
  reason: z.string().nullable(),
  /** 最後一次狀態變化的時間。 */
  at: IsoTime,
});
export type BroadcastTarget = z.infer<typeof BroadcastTarget>;
/** 一則群發（hub 只放在記憶體：hub 重啟就沒有，排隊中的前端標成「沒送出（hub 重啟）」）。 */
/**
 * 送字的種類：team＝團隊群發；progress＝進度卡「帶入進度卡」；ask_update＝「請隊長更新 ◈」（P3 項目一）。
 * 後兩種和群發同一條 SafeDelivery（manual）與同一套結果格式，畫面共用排隊中／取消的顯示。
 */
export const BroadcastKind = z.enum(['team', 'progress', 'ask_update']);
export type BroadcastKind = z.infer<typeof BroadcastKind>;
export const Broadcast = z.object({
  id: Id,
  /** 團隊群發與團隊進度卡是團隊 id；單獨 session 的進度卡帶入是 null。 */
  teamId: Id.nullable(),
  kind: BroadcastKind.default('team'),
  /** 進度卡送字：卡片擁有者（`team:<id>`／`session:<id>`，見 progressOwnerKey）；群發是 null。 */
  cardKey: z.string().nullable().default(null),
  text: z.string(),
  /** 有 @ 點名（只送給 targets 裡的人）。 */
  mentioned: z.boolean(),
  by: Id.nullable(),
  byName: z.string().nullable(),
  at: IsoTime,
  /** 送出當下全部暫停中（Q6：不擋，只提示）。 */
  boardPaused: z.boolean(),
  targets: z.array(BroadcastTarget),
});
export type Broadcast = z.infer<typeof Broadcast>;
/** 群發全文上限（字元）。 */
export const BROADCAST_TEXT_MAX = 4_000;

/** 合併通知的等待時間：第一個事件後等 15 秒，期間有新事件就從新事件再算，但從第一個事件起最多 60 秒。 */
export const NOTIFY_WINDOW_MS = 15_000;
/** 權限請求最急：批次裡有權限請求時，最晚在它發生後 5 秒送出。 */
export const NOTIFY_PERMISSION_WINDOW_MS = 5_000;
export const NOTIFY_MAX_WINDOW_MS = 60_000;

/** 預設危險指令清單（§7）。比對方式見 CONTRACTS.md §4.3。 */
export const DEFAULT_DANGER_RULES = ['rm -rf /', 'rm -r /', 'git push --force', 'git reset --hard'];
export const DEFAULT_STUCK_MINUTES = 10;
