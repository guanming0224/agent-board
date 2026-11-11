// WebSocket 訊息。兩條通道：/ws/daemon（機器 token）、/ws/client（登入 cookie）。
// 每則都是一個 JSON 物件，以 `type` 區分。
import { z } from 'zod';
import { TeamPreset } from './presets';
import {
  AgentKind,
  TeamActivity,
  Approval,
  BoardPauseState,
  Broadcast,
  Team,
  Zone,
  ClaudeSessionId,
  DEFAULT_WAITING_LIMIT,
  NOT_PAUSED,
  PurgeOptions,
  PurgeResult,
  SessionInspect,
  TranscriptPage,
  ApprovalDecision,
  Id,
  IsoTime,
  Machine,
  MachineCapabilities,
  MachineOs,
  PermissionMode,
  ResourceSample,
  Session,
  SessionEvent,
  SessionStatus,
  UsageSummary,
} from './models';
import { AgentBoardTool, ProgressCard } from './progress';
import { UsageDetail } from './usage';
import { ReleaseTarget, UpdateState } from './release';
import {
  DeepSearchLimits,
  DeepSearchMachine,
  DeepSearchRequest,
  DeepSearchState,
  DeepSearchTarget,
  SEARCH_DEEP_FEATURE,
  SEARCH_QUERY_MAX,
  SearchItem,
} from './search';

export const WS_PATHS = { daemon: '/ws/daemon', client: '/ws/client' } as const;

/** daemon 在 hello 的 `features` 宣告的協定功能。 */
export const DAEMON_FEATURES = {
  /** 認得 `terminal.signal.onlyIfStatus`，並回 `terminal.signalResult`（全部暫停「立刻中斷」用）。 */
  signalGuard: 'signal.onlyIfStatus',
  /**
   * 認得 `hub.welcome.memory`，會掛進度卡工具（get_progress／update_progress，P3 項目一）。
   * 舊版 daemon 沒有這個旗標：照舊只掛派工工具（hub 不需要知道每個 session 掛了什麼）。
   */
  memory: 'mcp.memory',
  /**
   * 認得 `search.request`／`search.cancel`，會搜本機的對話紀錄與終端機畫面（P3 項目三 ③b 深層搜尋）。
   * 舊版 daemon 沒有：hub 不送請求，那台機器標「版本太舊不支援」。
   */
  search: SEARCH_DEEP_FEATURE,
  /**
   * 開得了 Codex session（`SessionSpec.agent: 'codex'`，Codex 接口第一版）。只有偵測到 codex 的 daemon 才宣告；
   * 舊版 daemon 不認得 agent 欄位、會照 Claude 開，所以 hub 只把 Codex 的 spec 送給有這個旗標的 daemon。
   */
  codex: 'agent.codex',
} as const;

export const TerminalSignal = z.enum(['escape', 'ctrl_c', 'terminate']);
export type TerminalSignal = z.infer<typeof TerminalSignal>;

const TerminalData = z.object({
  sessionId: Id,
  /** 每個 session 從 1 遞增；收方發現跳號就要重新訂閱。 */
  seq: z.number().int().positive(),
  data: z.string(),
});

const TerminalSnapshot = z.object({
  sessionId: Id,
  /** 快照涵蓋到的 seq；之後只接受更大的 seq。 */
  seq: z.number().int().nonnegative(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** @xterm/addon-serialize 的輸出，直接 write 進 xterm 即可還原。 */
  data: z.string(),
});

const Resize = z.object({
  sessionId: Id,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** POSIX 或 Windows 的絕對路徑。 */
export const AbsolutePath = z.string().regex(/^(\/|[A-Za-z]:[\\/])/);

/** 建立 session 的參數。 */
export const SessionSpec = z.object({
  name: z.string().min(1),
  projectId: Id.nullable(),
  cwd: z.string().min(1),
  useWorktree: z.boolean(),
  permissionMode: PermissionMode,
  model: z.string().nullable(),
  /** 絕對路徑（daemon 拿它找對話紀錄、設 CLAUDE_CONFIG_DIR）。 */
  accountProfile: AbsolutePath.nullable(),
  resumeClaudeSessionId: ClaudeSessionId.nullable(),
  firstPrompt: z.string().nullable(),
  /**
   * 唯讀：daemon 用 `--disallowedTools` 拿掉改檔工具（`READ_ONLY_DISALLOWED_TOOLS`）。
   * 只擋這些工具，透過 Bash 仍然寫得了檔案。建立後不能改，接續與 daemon 重啟照舊套用。
   */
  readOnly: z.boolean().default(false),
  /**
   * 開哪個 CLI。不送＝Claude Code。Codex：`resumeClaudeSessionId` 是 Codex 的 thread id；`accountProfile`
   * 不適用（hub 拒絕）；權限模式照 `codexPermissionArgs` 換算成 sandbox／approval（CONTRACTS §19）。
   */
  agent: AgentKind.optional(),
});
export type SessionSpec = z.infer<typeof SessionSpec>;

/** 新資料夾名稱：一層、不能是 . 或 ..、不含路徑分隔字元與 NUL。 */
export const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => v !== '.' && v !== '..' && !/[\\/\0]/.test(v), { message: 'invalid_folder_name' });

/** daemon 處理已結束 session 的檔案時需要的位置資訊。 */
export const SessionLocator = z.object({
  sessionId: Id,
  cwd: z.string().min(1),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  claudeSessionId: ClaudeSessionId.nullable(),
  accountProfile: z.string().nullable(),
});
export type SessionLocator = z.infer<typeof SessionLocator>;

export const DirEntry = z.object({ name: z.string(), isDir: z.boolean(), isGitRepo: z.boolean() });

/**
 * 資料夾所在的 git working tree。`root` 相同才是同一份檔案（會互相改到）；
 * `commonDir` 相同代表同一個 repo，但可能是不同的 linked worktree。
 */
export const RepoInfo = z.object({ root: z.string(), commonDir: z.string() });
export type RepoInfo = z.infer<typeof RepoInfo>;

/** daemon 回報的 session 欄位：hub 擁有的（archived、projectId…）不在內。 */
export const SessionRuntime = Session.pick({
  id: true,
  cwd: true,
  branch: true,
  worktreePath: true,
  status: true,
  statusDetail: true,
  claudeSessionId: true,
  lastLines: true,
  lastOutputAt: true,
  statusSince: true,
  contextTokens: true,
  contextWindow: true,
  repoRoot: true,
  repoCommonDir: true,
  endedAt: true,
}).extend({
  /**
   * 畫面最下面是 claude 平常的輸入框（橫線下一行 `❯`），沒有被對話框（權限、額度選單）蓋住。
   * hub 只拿它判斷限流中的 session 能不能送自動接續；舊版 daemon 不送（當成 false）。
   */
  inputReady: z.boolean().optional(),
});
export type SessionRuntime = z.infer<typeof SessionRuntime>;

// ── daemon → hub ─────────────────────────────────────────────
export const DaemonToHub = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('daemon.hello'),
    name: z.string(),
    os: MachineOs,
    version: z.string(),
    capabilities: MachineCapabilities,
    /** 目前活著的 session，hub 用來對帳（重連、daemon 重啟）。 */
    sessions: z.array(SessionRuntime),
    pendingApprovals: z.array(Approval),
    /**
     * daemon 支援的協定功能（見 `DAEMON_FEATURES`）。舊版 daemon 不送＝空。hub 依此決定要不要用新功能，
     * 例如「立刻中斷」只對支援 `signal.onlyIfStatus` 的 daemon 送 Esc。
     */
    features: z.array(z.string()).default([]),
    /** hub ↔ daemon 協定版本（CONTRACTS §21.4）；舊 daemon 不送＝`LEGACY_PROTOCOL_VERSION`。 */
    protocolVersion: z.number().int().positive().optional(),
    /** 發布檔的 BUILD_ID（內容雜湊）；開發模式是 `dev`。舊 daemon 不送。 */
    buildId: z.string().optional(),
    /** `platformKey(os, arch)`，例如 `darwin-arm64`、`win-x64`。舊 daemon 不送（沒有自動更新）。 */
    platform: z.string().optional(),
    /** 上一版（可回滾到的版本）；開發模式或不知道為 null。 */
    previousVersion: z.string().nullable().optional(),
    /** 這台也裝了 hub（安裝程式的 roles 有 hub）：hub 自己的更新走這台 daemon。 */
    hostsHub: z.boolean().optional(),
    /**
     * `process.versions.modules`（Node 原生模組 ABI）。只對沒自帶 Node 的舊成品比對（不合不發目標）；
     * 自帶 Node 的成品不比，只供顯示（CONTRACTS §21.10）。舊 daemon 不送。
     */
    nodeAbi: z.string().optional(),
    /** `<dataDir>/update-state.json` 的內容（上次更新的結果）。壞掉當沒送。 */
    update: UpdateState.nullable().optional().catch(undefined),
  }),
  z.object({ type: z.literal('session.created'), requestId: Id, session: SessionRuntime }),
  z.object({ type: z.literal('session.createFailed'), requestId: Id, error: z.string() }),
  z.object({ type: z.literal('session.runtime'), session: SessionRuntime }),
  z.object({ type: z.literal('session.event'), event: SessionEvent }),
  /** 更新狀態變了（延後、下載中、結果；CONTRACTS §21.3）。 */
  z.object({ type: z.literal('update.status'), state: UpdateState }),
  /**
   * 帶 `onlyIfStatus` 的 `terminal.signal` 處理結果（不帶的不回）。sent＝已送出；false＝daemon 看到的狀態不符
   * 或找不到 session，沒送。status 是 daemon 當下看到的狀態（找不到 session 時為 null）。
   */
  z.object({
    type: z.literal('terminal.signalResult'),
    sessionId: Id,
    signal: TerminalSignal,
    sent: z.boolean(),
    status: SessionStatus.nullable(),
  }),
  TerminalData.extend({ type: z.literal('terminal.output') }),
  TerminalSnapshot.extend({ type: z.literal('terminal.snapshot') }),
  z.object({ type: z.literal('approval.requested'), approval: Approval }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: Id,
    sessionId: Id,
    /** web：網頁決定；terminal：在終端機處理了或 session 已結束；timeout：等太久、hook 已離開或機器被移除。 */
    by: z.enum(['web', 'terminal', 'timeout']),
  }),
  z.object({ type: z.literal('resources'), sample: ResourceSample.omit({ machineId: true }) }),
  z.object({
    type: z.literal('usage'),
    summary: UsageSummary.omit({ machineId: true }),
    /**
     * 細項（GM 2026-11-09）；舊 daemon 不送。壞掉或超過上限時當沒送（`catch`），總數照收。
     */
    detail: UsageDetail.optional().catch(undefined),
  }),
  z.object({
    type: z.literal('fs.listResult'),
    requestId: Id,
    path: z.string(),
    entries: z.array(DirEntry),
    /** 列出的資料夾本身所在的 repo；不是 git 或舊版 daemon 為 null。 */
    repo: RepoInfo.nullable().default(null),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal('session.inspectResult'),
    requestId: Id,
    inspect: SessionInspect.omit({
      hooksShared: true,
      worktreeShared: true,
      transcriptShared: true,
    }).nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal('session.purgeResult'),
    requestId: Id,
    result: PurgeResult.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal('session.transcriptResult'),
    requestId: Id,
    page: TranscriptPage.nullable(),
    error: z.string().nullable(),
  }),
  /**
   * session 裡的 Claude 呼叫了 agent-board 工具（派工 CONTRACTS §11、進度卡 §14）。daemon 已用該 session 的密鑰驗過是它本人；
   * 能不能做（團隊、上限、權限）由 hub 判斷，回 `dispatch.reply`。
   */
  z.object({
    type: z.literal('dispatch.request'),
    requestId: Id,
    sessionId: Id,
    tool: AgentBoardTool,
    args: z.record(z.string(), z.unknown()),
  }),
  /**
   * 深層搜尋（P3 ③b）找到的一批片段（邊搜邊回）。kind 只會是 transcript／screen，machineId 由 hub 補；
   * 遮蔽模式時 daemon 已遮好。hub 只轉給發起的那條連線，不存。
   */
  z.object({ type: z.literal('search.result'), searchId: Id, items: z.array(SearchItem) }),
  /** 這台機器搜完了（或時間、讀檔量到上限）。被取消的不回。 */
  z.object({
    type: z.literal('search.done'),
    searchId: Id,
    state: z.enum(['done', 'timeout']),
    scannedSessions: z.number().int().nonnegative(),
    totalSessions: z.number().int().nonnegative(),
  }),
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

// ── hub → daemon ─────────────────────────────────────────────
export const HubToDaemon = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hub.welcome'),
    machineId: Id,
    dangerRules: z.array(z.string()),
    stuckMinutes: z.number().int().positive(),
    /** `Settings.dispatch`：新開的 claude 要不要掛派工工具。舊版 hub 不送 → 不掛（它也不認得派工請求）。 */
    dispatch: z.boolean().optional(),
    /** `Settings.memory`：新開的 claude 要不要掛進度卡工具（P3 項目一）。舊版 hub 不送 → 不掛。 */
    memory: z.boolean().optional(),
    /** hub 的協定版本（CONTRACTS §21.4）。舊 hub 不送。 */
    protocolVersion: z.number().int().positive().optional(),
    /** 這台的更新目標（依通道）；null＝沒有。舊 hub 不送。 */
    release: ReleaseTarget.nullable().optional(),
  }),
  /**
   * 更新目標變了（新版、升 stable、切通道）或面板按「立即更新」（force：不管版本新舊、上次失敗過都照做，
   * 延後條件仍然要過）。target null＝沒有目標。
   */
  z.object({
    type: z.literal('release.target'),
    target: ReleaseTarget.nullable(),
    force: z.boolean(),
  }),
  /** 面板按「回滾到上一版」。 */
  z.object({ type: z.literal('release.rollback') }),
  /**
   * 協定版本差太多，hub 不接受這個 daemon（送完就斷線）。needs_update：daemon 太舊，`release` 是可以更新到的版本
   * （下載走 HTTP，不用 WebSocket）；hub_too_old：hub 太舊。daemon 改成每 5 分鐘重試一次。
   */
  z.object({
    type: z.literal('daemon.rejected'),
    reason: z.enum(['needs_update', 'hub_too_old']),
    hubProtocolVersion: z.number().int().positive(),
    release: ReleaseTarget.nullable(),
  }),
  z.object({ type: z.literal('session.create'), requestId: Id, sessionId: Id, spec: SessionSpec }),
  z.object({ type: z.literal('session.stop'), sessionId: Id }),
  z.object({ type: z.literal('terminal.subscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.unsubscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.input'), sessionId: Id, data: z.string() }),
  Resize.extend({ type: z.literal('terminal.resize') }),
  z.object({
    type: z.literal('terminal.signal'),
    sessionId: Id,
    signal: TerminalSignal,
    /**
     * 只在 daemon 看到的狀態是這個時才送（全部暫停「立刻中斷」用 running）：hub 看到的 RUN 可能正要轉成
     * 權限請求，那時 Esc 會變成拒絕。沒帶＝照送（使用者自己按的）。帶了 daemon 會回 `terminal.signalResult`。
     * 舊版 daemon 不認得、會照送，所以 hub 只對 hello `features` 有 `signal.onlyIfStatus` 的 daemon 帶。
     */
    onlyIfStatus: SessionStatus.optional(),
  }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: Id,
    sessionId: Id,
    decision: ApprovalDecision,
  }),
  z.object({ type: z.literal('resources.watch'), watching: z.boolean() }),
  z.object({ type: z.literal('fs.list'), requestId: Id, path: z.string() }),
  /** 在 parent 底下建一層新資料夾（parent 要已存在、不覆蓋），成功後回 fs.listResult（path 是新資料夾）。 */
  z.object({ type: z.literal('fs.mkdir'), requestId: Id, parent: z.string(), name: FolderName }),
  /** 封存與刪除用（CONTRACTS §9）：hub 從資料庫帶齊 session 的路徑，daemon 不必還記得這個 session。 */
  z.object({ type: z.literal('session.inspect'), requestId: Id, target: SessionLocator }),
  z.object({
    type: z.literal('session.purge'),
    requestId: Id,
    target: SessionLocator,
    options: PurgeOptions,
  }),
  z.object({
    type: z.literal('session.transcript'),
    requestId: Id,
    claudeSessionId: ClaudeSessionId,
    accountProfile: z.string().nullable(),
    cursor: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(500),
    query: z.string().max(200).nullable(),
  }),
  /** 派工工具的結果：`text` 原樣交給 Claude（成功是 JSON 或一句話，失敗是 Claude 看得懂、能照著改的原因）。 */
  z.object({
    type: z.literal('dispatch.reply'),
    requestId: Id,
    ok: z.boolean(),
    text: z.string(),
  }),
  /**
   * 深層搜尋（P3 ③b）：只送給 hello `features` 有 `search.v1` 的 daemon。terms 是 hub 用 parseSearchTerms
   * 拆好的詞（daemon 不再自己拆，比對規則才一致）；since 之前的對話與修改時間在那之前的檔案不讀。
   * daemon 只讀本機檔案與記憶體裡的畫面，回片段，不送任何字進 session、不對外連線。
   */
  z.object({
    type: z.literal('search.request'),
    searchId: Id,
    terms: z.array(z.string().min(1).max(SEARCH_QUERY_MAX)).min(1).max(SEARCH_QUERY_MAX),
    mask: z.boolean(),
    since: IsoTime,
    sessions: z.array(DeepSearchTarget),
    limits: DeepSearchLimits,
  }),
  /** 取消深層搜尋：daemon 停止讀檔，不再回 result／done。 */
  z.object({ type: z.literal('search.cancel'), searchId: Id }),
]);
export type HubToDaemon = z.infer<typeof HubToDaemon>;

/**
 * 終端機尺寸由誰決定（CONTRACTS §6.1 第 6 點）。you：你的 resize 會套用到 PTY；
 * other：另一個瀏覽器擁有尺寸，你照 cols/rows 顯示、不要送 resize；none：還沒人擁有，第一個送 resize 的就是。
 */
export const TerminalSizeOwner = z.enum(['you', 'other', 'none']);

// ── browser → hub ────────────────────────────────────────────
export const ClientToHub = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal.subscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.unsubscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.input'), sessionId: Id, data: z.string() }),
  Resize.extend({
    type: z.literal('terminal.resize'),
    /** 使用者在這個終端機打字或點擊：搶下尺寸擁有權。沒帶時只有擁有者（或還沒人擁有）的 resize 會生效。 */
    claim: z.boolean().optional(),
  }),
  z.object({ type: z.literal('terminal.signal'), sessionId: Id, signal: TerminalSignal }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: Id,
    sessionId: Id,
    decision: ApprovalDecision,
  }),
  z.object({ type: z.literal('resources.watch'), watching: z.boolean() }),
  z.object({ type: z.literal('ping'), at: IsoTime }),
  /**
   * 深層搜尋（P3 ③b，按 Enter 才送）：同一個使用者同時只有一個，新的會取消舊的。auth user 即可；
   * 結果只推給這條連線。舊版 hub 不認得 → 回 error invalid_message（前端當成不支援）。
   */
  DeepSearchRequest.safeExtend({ type: z.literal('search.deep') }),
  z.object({ type: z.literal('search.cancel'), searchId: Id }),
]);
export type ClientToHub = z.infer<typeof ClientToHub>;

// ── hub → browser ────────────────────────────────────────────
export const HubToClient = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('board.state'),
    machines: z.array(Machine),
    sessions: z.array(Session),
    approvals: z.array(Approval),
    /** 同時等你的上限（`Settings.notifications.waitingLimit`）：設定只有 owner 讀得到，橫幅每個人都要。 */
    waitingLimit: z.number().int().positive().default(DEFAULT_WAITING_LIMIT),
    /** 全部暫停的狀態與排隊統計（P2 項目三）。舊版 hub 不送＝沒暫停。 */
    pause: BoardPauseState.default(NOT_PAUSED),
    /** 工作區（P2 項目二）。舊版 hub 不送＝空（前端當成只有預設工作區）。 */
    zones: z.array(Zone).default([]),
    /** hub 記憶體裡的群發（hub 重啟就清空）。 */
    broadcasts: z.array(Broadcast).default([]),
    /** 進度卡（P3 項目一，含自動事實）。只有寫過的卡；舊版 hub 不送＝空。 */
    progress: z.array(ProgressCard).default([]),
    /** 團隊 Presets（P3 項目二），照 position 排。舊版 hub 不送＝空。 */
    presets: z.array(TeamPreset).default([]),
    /** 團隊動態（隊長自主擴編，新的在前）。舊版 hub 不送＝空。 */
    teamActivity: z.array(TeamActivity).default([]),
  }),
  /** 團隊動態變了（新增、標已讀、清除）：整份推給每個 client。 */
  z.object({ type: z.literal('team.activity'), items: z.array(TeamActivity) }),
  /** 進度卡寫入、鎖定、還原：整張卡推給每個 client（1 秒內更新）。 */
  z.object({ type: z.literal('progress.updated'), card: ProgressCard }),
  /** 團隊 Presets 清單變了（建立、改名、修改、排序、刪除、套用後的最後使用時間）：整份推給每個 client。 */
  z.object({ type: z.literal('preset.list'), presets: z.array(TeamPreset) }),
  /** 工作區清單變了（建立、改名、刪除）：整份推給每個 client。 */
  z.object({ type: z.literal('zone.list'), zones: z.array(Zone) }),
  /** 團隊建立或改了（含換工作區）：推給每個 client，不等輪詢。 */
  z.object({ type: z.literal('team.updated'), team: Team }),
  z.object({ type: z.literal('team.removed'), teamId: Id }),
  /** 一則群發的對象狀態變了。 */
  z.object({ type: z.literal('broadcast.updated'), broadcast: Broadcast }),
  /** 上限改了。 */
  z.object({ type: z.literal('board.waitingLimit'), waitingLimit: z.number().int().positive() }),
  /** 全部暫停的狀態或排隊統計變了（暫停、繼續、暫停中排隊數變化）：推給每個 client。 */
  z.object({ type: z.literal('board.pause'), pause: BoardPauseState }),
  TerminalData.extend({ type: z.literal('terminal.output') }),
  TerminalSnapshot.extend({ type: z.literal('terminal.snapshot') }),
  /** PTY 目前的尺寸與擁有者。快照之後、尺寸或擁有者改變時送給該 session 的每個訂閱者。 */
  Resize.extend({ type: z.literal('terminal.size'), owner: TerminalSizeOwner }),
  z.object({ type: z.literal('session.updated'), session: Session }),
  z.object({ type: z.literal('session.removed'), sessionId: Id }),
  z.object({ type: z.literal('session.event'), event: SessionEvent }),
  z.object({ type: z.literal('machine.updated'), machine: Machine }),
  z.object({ type: z.literal('machine.removed'), machineId: Id }),
  z.object({ type: z.literal('approval.requested'), approval: Approval }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: Id,
    sessionId: Id,
    by: z.enum(['web', 'terminal', 'timeout']),
  }),
  z.object({ type: z.literal('resources'), sample: ResourceSample }),
  z.object({ type: z.literal('pong'), at: IsoTime }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  /** 深層搜尋開始：要搜的機器與各自的 session 數（沒有符合範圍的 session 的機器不列）。只推給發起的連線。 */
  z.object({
    type: z.literal('search.deepStarted'),
    searchId: Id,
    machines: z.array(DeepSearchMachine),
  }),
  /** 某台機器找到的一批片段（items 都帶 machineId）。 */
  z.object({
    type: z.literal('search.deepResult'),
    searchId: Id,
    machineId: Id,
    items: z.array(SearchItem),
  }),
  /** 某台機器結束：done／offline（失聯沒搜到）／unsupported（版本太舊）／timeout（只搜了一部分）。 */
  z.object({
    type: z.literal('search.deepDone'),
    searchId: Id,
    machineId: Id,
    state: DeepSearchState,
    scannedSessions: z.number().int().nonnegative(),
    totalSessions: z.number().int().nonnegative(),
  }),
]);
export type HubToClient = z.infer<typeof HubToClient>;
