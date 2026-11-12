// 畫面只透過這個介面存取資料。Phase 1 接 fakeBackend，Phase 2 由 Lead 接真 hub。
import type {
  Approval,
  ApprovalDecision,
  AuditEntry,
  BoardHeld,
  BoardInterruptResult,
  BoardPauseMode,
  BoardPauseState,
  Broadcast,
  DeepSearchRequest,
  HandoffRule,
  HubToClient,
  Layout,
  Machine,
  Note,
  ProgressCard,
  ProgressOwner,
  ProgressRevision,
  ProgressWrite,
  Project,
  PurgeOptions,
  PurgeResult,
  ReleaseChannel,
  ReleaseOverview,
  RepoInfo,
  ResourceSample,
  SearchQuery,
  SearchResults,
  Session,
  SessionEvent,
  SessionInspect,
  SessionSpec,
  Settings,
  Task,
  Team,
  TeamHoldMode,
  TeamHoldResult,
  TeamMember,
  TeamResumeResult,
  TeamActivity,
  Review,
  ReviewTargetInput,
  TeamPreset,
  TeamPresetConfig,
  TeamPresetUsed,
  Template,
  TranscriptPage,
  UsageReport,
  UsageSummary,
  User,
  Zone,
} from '@agent-board/protocol';
import type { TerminalStream } from './terminal-contract';

/**
 * 深層搜尋（P3 ③b）的事件：hub 推來的三種（開始、某台的一批結果、某台結束），
 * 加上前端自己的 failed（送不出去或搜到一半斷線，整次搜尋結束）。
 */
export type DeepSearchEvent =
  | Extract<HubToClient, { type: 'search.deepStarted' | 'search.deepResult' | 'search.deepDone' }>
  /**
   * 前端自己判斷的失敗：disconnected 連線斷了；no_reply hub 沒有回（例如舊版 hub 不認得 search.deep、
   * 回 error invalid_message），或過了各台的時間上限加寬限還沒全部結束。
   */
  | { type: 'search.deepFailed'; searchId: string; error: 'disconnected' | 'no_reply' };

/** 進行中的深層搜尋。cancel 會送 search.cancel（hub 再叫各台 daemon 停止讀檔）。 */
export interface DeepSearchHandle {
  readonly searchId: string;
  cancel(): void;
}

export interface BoardSnapshot {
  machines: Machine[];
  sessions: Session[];
  approvals: Approval[];
  /**
   * 同時等你的上限（`Settings.notifications.waitingLimit`）。設定只有 owner 讀得到，
   * 頁首的橫幅每個人都要，所以 hub 跟著 board.state 送。舊版 hub 沒有就是 undefined（用預設 3）。
   */
  waitingLimit?: number;
  /** 工作區（P2 項目二）。舊版 hub 沒有＝undefined（當成只有預設工作區）。 */
  zones?: Zone[];
  /**
   * 群發的結果（hub 只放在記憶體）。hub 重啟後重連時，原本還在排隊的對象會被標成 failed／hub_restarted
   * （畫面寫「沒送出（hub 重啟）」），不默默消失。
   */
  broadcasts?: Broadcast[];
  /** 全部暫停的狀態與排隊統計（P2 項目三）。舊版 hub 沒有就是 undefined（＝沒暫停）；群發送出鈕旁的「目前全部暫停中」也看它。 */
  pause?: BoardPauseState;
  /**
   * 進度卡（P3 項目一，含自動事實）：寫過的卡，hub 在 board.state 帶、每次寫入推 progress.updated。
   * 舊版 hub 沒有＝undefined（畫面當成還沒有卡）。
   */
  progress?: ProgressCard[];
  /** 團隊 Presets（P3 項目二），照 position 排。舊版 hub 沒有＝undefined（底部列與設定改用 listTeamPresets 讀）。 */
  presets?: TeamPreset[];
  /** 團隊動態（隊長自主擴編：隊長新增、封存成員），新的在前。舊版 hub 沒有＝undefined（不顯示）。 */
  teamActivity?: TeamActivity[];
  /** 交叉審查（Codex 第二輪），新的在前。舊版 hub 沒有＝undefined（不顯示）。 */
  reviews?: Review[];
}

/** 團隊建立、修改（含換工作區）或刪除：hub 用 WS 推，不等輪詢。 */
export type TeamChange = { team: Team } | { removed: string };

export type BoardListener = (snapshot: BoardSnapshot) => void;

/**
 * GET /api/audit 的篩選；匯出（/api/audit/export）吃同一組條件但沒有 limit。時間是 ISO 字串。
 * userId 是使用者 id，或 AUDIT_SYSTEM_USER（protocol）代表沒有使用者的紀錄。
 */
export interface AuditFilter {
  sessionId?: string;
  action?: string;
  userId?: string;
  from?: string;
  to?: string;
  /** 1–1000，hub 預設 100。 */
  limit?: number;
}

/** hub 錯誤的 code（ApiError.code；假後端丟同樣形狀）。沒有就是 null。 */
export const errorCode = (e: unknown): string | null => {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
};

/** hub 錯誤的 detail（ApiError.detail，例如 progress_conflict 的 ProgressConflict）。沒有就是 null。 */
export const errorDetail = (e: unknown): Record<string, unknown> | null => {
  const detail =
    typeof e === 'object' && e !== null ? (e as { detail?: unknown }).detail : undefined;
  return typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : null;
};

/** 後端回的錯誤是否為「機器離線」（hub 回 409 machine_offline）。 */
export const isMachineOffline = (e: unknown): boolean => errorCode(e) === 'machine_offline';

/** 這個 session（或同資料夾、同 worktree 的 session）正在刪除（CONTRACTS §9.6 刪除鎖）。 */
export const isSessionDeleting = (e: unknown): boolean => errorCode(e) === 'session_deleting';

export interface BoardBackend {
  readonly terminal: TerminalStream;

  /** 回傳值用來取消監聽；監聽時立刻收到一次目前狀態。 */
  watchBoard(listener: BoardListener): () => void;
  watchResources(listener: (sample: ResourceSample) => void): () => void;
  /** 即時的 session 事件（hub 的 `session.event`）；只收連線之後發生的，舊的用 sessionEvents 讀。 */
  watchEvents?(listener: (event: SessionEvent) => void): () => void;
  /** 和 hub 的連線狀態；假後端沒有這個概念。 */
  watchConnection?(listener: (connected: boolean) => void): () => void;
  /** 團隊即時變化（hub 的 team.updated／team.removed）；假後端沒有（團隊靠輪詢）。 */
  watchTeamChanges?(listener: (change: TeamChange) => void): () => void;

  needsSetup(): Promise<boolean>;
  currentUser(): Promise<User | null>;
  setup(input: { name: string; password: string; locale: User['locale'] }): Promise<User>;
  login(input: { name: string; password: string }): Promise<User>;
  logout(): Promise<void>;
  /** 改自己的密碼，要附目前的密碼。管理員重設別人的密碼見 hubBackend 的選用方法 resetUserPassword。 */
  changePassword(input: {
    userId: string;
    currentPassword: string;
    password: string;
  }): Promise<void>;
  /** 把語言存到目前登入的帳號（User.locale），登入後畫面跟著它。沒登入時什麼都不做。 */
  saveLocale(locale: User['locale']): Promise<void>;

  /** zoneId：放在哪個工作區（新建 session 放在目前工作區）；沒給＝預設工作區。 */
  createSession(input: SessionSpec & { machineId: string; zoneId?: string }): Promise<Session>;
  updateSession(
    id: string,
    patch: { name?: string; archived?: boolean; markDone?: true; zoneId?: string },
  ): Promise<Session>;
  stopSession(id: string): Promise<Session>;
  /**
   * 接續已結束的 session（`claude --resume`）。已封存的會自動還原。
   * 錯誤碼：session_active、no_claude_session、machine_offline、invalid_account_profile、session_deleting。
   */
  resumeSession(id: string): Promise<Session>;

  /** 已封存的 session（CONTRACTS §9）。board 快照不含它們，要另外讀。 */
  listArchivedSessions(): Promise<Session[]>;
  /**
   * 刪除前的檢查：對話大小、git 狀況、hook 是否共用。
   * 機器離線時丟出 code 為 `machine_offline` 的錯誤（見 isMachineOffline）。
   */
  inspectSession(id: string): Promise<SessionInspect>;
  /** 對話紀錄（看舊資料用）。cursor 是篩選後清單的位置；機器離線同上。 */
  sessionTranscript(
    id: string,
    query: { cursor?: number; limit?: number; q?: string },
  ): Promise<TranscriptPage>;
  /** 永久刪除已封存且已結束的 session（只有 owner）。回傳每一項清理的結果。 */
  deleteSession(id: string, options: PurgeOptions): Promise<PurgeResult>;
  sendPrompt(sessionId: string, text: string): void;

  /**
   * 全部暫停（P2 項目三，CONTRACTS §12）。finish_turn 擋自動送字與自動開新 session；interrupt 另外對每個 RUN 送 Esc，
   * interrupted 是每個 session 的結果（requested／offline／unsupported）。已暫停時再按＝改模式。
   */
  pauseBoard(
    mode: BoardPauseMode,
  ): Promise<{ state: BoardPauseState; interrupted: BoardInterruptResult[] }>;
  /** 全部繼續：只解除閘門，不對被中斷的 session 送「繼續」（Q8）。released 是放出的數量。 */
  resumeBoard(): Promise<{ state: BoardPauseState; released: BoardHeld }>;
  decideApproval(approval: Approval, decision: ApprovalDecision): Promise<void>;

  listProjects(): Promise<Project[]>;
  listTemplates(): Promise<Template[]>;
  saveTemplate(input: Omit<Template, 'id'>): Promise<Template>;
  browseDirectory(
    machineId: string,
    path: string,
  ): Promise<{
    path: string;
    entries: { name: string; isDir: boolean; isGitRepo: boolean }[];
    /** 列出的資料夾所在的 repo；新 session 用來判斷同 repo。舊版 daemon 沒有。 */
    repo?: RepoInfo | null;
  }>;
  /** 在 parent 底下建一層新資料夾，回傳新資料夾的列表（格式同 browseDirectory）。已存在就失敗。 */
  makeDirectory(
    machineId: string,
    parent: string,
    name: string,
  ): ReturnType<BoardBackend['browseDirectory']>;
  createProject(input: Omit<Project, 'id'>): Promise<Project>;
  createPairingCode(): Promise<{ code: string; expiresAt: string; installCommand: string }>;
  removeMachine(id: string): Promise<void>;
  /** daemon 讀本機對話紀錄算出的 token 用量（不是官方額度）；還沒回報過是 null。 */
  machineUsage(machineId: string): Promise<UsageSummary | null>;
  /** 用量詳情（GM 2026-11-09）：跨機器彙整的細項。 */
  usageReport(): Promise<UsageReport>;

  /**
   * 機器面板（發版與自動更新，docs/release-update-spec.md §7、CONTRACTS §21）。全部回最新的總覽。
   * 讀取是 user 權限；其餘是 owner（hub 也會擋）。錯誤碼 409：canary_too_new（升 stable 沒帶 confirm）、
   * not_cached、machine_offline、no_previous。
   */
  releases(): Promise<ReleaseOverview>;
  /** 「檢查新版」：hub 用已登入的 gh 查 Release、下載並驗 SHA-256。 */
  checkReleases(): Promise<ReleaseOverview>;
  /** 「升為 stable」；canary 跑不到 24 小時要第二次帶 confirm=true。 */
  promoteRelease(version: string, confirm: boolean): Promise<ReleaseOverview>;
  /** Release 所在的 GitHub repo（`owner/name`）；null 清掉。 */
  setReleaseRepo(repo: string | null): Promise<ReleaseOverview>;
  setMachineChannel(machineId: string, channel: ReleaseChannel): Promise<ReleaseOverview>;
  /** 「立即更新」：照目前目標版本更新。 */
  updateMachine(machineId: string): Promise<ReleaseOverview>;
  /** 「回滾到上一版」。 */
  rollbackMachine(machineId: string): Promise<ReleaseOverview>;
  /**
   * 未驗證平台（win-x64）的這台也自動更新（CONTRACTS §21.3）。打開要 confirm=true（400 confirm_required），
   * 不是未驗證平台 409 platform_verified；關掉不用 confirm。
   */
  setMachineAllowUnverified(
    machineId: string,
    allow: boolean,
    confirm: boolean,
  ): Promise<ReleaseOverview>;

  getLayouts(workspace: string): Promise<Layout[]>;
  saveLayouts(layouts: Layout[]): Promise<void>;
  /** 某個工作區的便利貼（畫布尚未顯示便利貼）。 */
  getNotes(zoneId: string): Promise<Note[]>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** 操作紀錄（只有 owner）。由新到舊。 */
  listAudit(filter: AuditFilter): Promise<AuditEntry[]>;
  /** CSV 檔（含 BOM），由舊到新。只匯出符合篩選的紀錄，不受 limit 限制（filter 的 limit 會被忽略）。 */
  exportAudit(filter?: AuditFilter): Promise<Blob>;

  /** 這台裝置的 Web Push 訂閱（flows/push.ts）。 */
  pushVapidKey(): Promise<string>;
  pushSubscribe(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;

  /** 團隊工作台與畫布的團隊框、交接線（Phase 3）。 */
  listTeams(): Promise<Team[]>;
  createTeam(input: Omit<Team, 'id' | 'zoneId' | 'hold'> & { zoneId?: string }): Promise<Team>;
  updateTeam(id: string, patch: Partial<Omit<Team, 'id' | 'hold'>>): Promise<Team>;
  deleteTeam(id: string): Promise<void>;
  /**
   * 全隊暫停（pause）／全隊停止（stop）（CONTRACTS §17）：hub 一次關規則與任務自動執行、送 Esc 或停 session，
   * 並記下關了哪些（Team.hold）。
   */
  holdTeam(id: string, mode: TeamHoldMode): Promise<TeamHoldResult>;
  /** 全隊繼續／全隊啟動：照 Team.hold 恢復（不自動送字）；停止後的另外 `--resume` 接回當初停掉的成員。 */
  resumeTeam(id: string): Promise<TeamResumeResult>;
  listTeamMembers(teamId: string): Promise<TeamMember[]>;
  /** `kind` 是研究團隊的分工；不帶時 hub 保留原本的。 */
  putTeamMember(
    teamId: string,
    sessionId: string,
    role: TeamMember['role'],
    kind?: TeamMember['kind'],
  ): Promise<TeamMember>;
  deleteTeamMember(teamId: string, sessionId: string): Promise<void>;
  listTasks(teamId: string): Promise<Task[]>;
  createTask(teamId: string, input: Pick<Task, 'title' | 'ownerSessionId'>): Promise<Task>;
  updateTask(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'ownerSessionId' | 'column'>>,
  ): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  listHandoffRules(teamId: string): Promise<HandoffRule[]>;
  createHandoffRule(
    teamId: string,
    input: Omit<HandoffRule, 'id' | 'teamId'>,
  ): Promise<HandoffRule>;
  updateHandoffRule(
    id: string,
    patch: Partial<Omit<HandoffRule, 'id' | 'teamId'>>,
  ): Promise<HandoffRule>;
  deleteHandoffRule(id: string): Promise<void>;
  /**
   * 群發（P2 §2.3）：hub 端走送字佇列，只在對象等輸入時送，其他排隊。targets 有給＝@ 點名。
   * 不跳確認；結果之後經 board 快照的 broadcasts 更新。
   */
  broadcastToTeam(teamId: string, text: string, targets?: string[]): Promise<Broadcast>;
  /** 取消某個對象還在排隊的群發。 */
  cancelBroadcast(broadcastId: string, sessionId: string): Promise<Broadcast>;

  /**
   * 進度卡（P3 項目一，CONTRACTS §14）。owner 是團隊或單獨 session。清單在 board 快照的 progress；
   * 單張（含最新的自動事實）用 getProgress。saveProgress 衝突時丟 code `progress_conflict`、detail 是 ProgressConflict。
   */
  getProgress(owner: ProgressOwner): Promise<ProgressCard>;
  saveProgress(owner: ProgressOwner, body: ProgressWrite): Promise<ProgressCard>;
  progressRevisions(owner: ProgressOwner): Promise<ProgressRevision[]>;
  restoreProgress(owner: ProgressOwner, revision: number): Promise<ProgressCard>;
  /** 帶入進度卡：送一行 `[Progress card: …]` 給 sessionId（hub 端 SafeDelivery manual）。 */
  deliverProgress(owner: ProgressOwner, sessionId: string): Promise<Broadcast>;
  /** 請隊長更新 ◈：送固定一行給隊長。 */
  askProgressUpdate(teamId: string): Promise<Broadcast>;

  /** 工作區（P2 項目二）。清單在 board 快照的 zones。刪除非空回 zone_not_empty、最後一個 last_zone。 */
  createZone(name: string): Promise<Zone>;
  renameZone(id: string, name: string): Promise<Zone>;
  deleteZone(id: string): Promise<void>;

  /**
   * 團隊 Presets（P3 項目二，CONTRACTS §15）。清單也在 board 快照的 presets（hub 推 preset.list）。
   * 名稱不分大小寫重複回 preset_name_taken。套用在前端走 runPlan，完成後呼叫 teamPresetUsed 回報（hub 記最後使用時間與 audit）。
   */
  listTeamPresets(): Promise<TeamPreset[]>;
  createTeamPreset(input: {
    name: string;
    config: TeamPresetConfig;
    /** 刪除後「復原」：插回原本的位置。 */
    position?: number;
  }): Promise<TeamPreset>;
  updateTeamPreset(
    id: string,
    patch: { name?: string; config?: TeamPresetConfig; position?: number },
  ): Promise<TeamPreset>;
  deleteTeamPreset(id: string): Promise<void>;
  teamPresetUsed(id: string, result: TeamPresetUsed): Promise<TeamPreset>;

  /**
   * 團隊動態（隊長自主擴編，CONTRACTS §11.1）：標已讀、清除。ids 沒給＝全部。回傳新清單（也會經 board 快照更新）。
   */
  readTeamActivity(ids?: string[]): Promise<TeamActivity[]>;
  clearTeamActivity(ids?: string[]): Promise<TeamActivity[]>;

  /**
   * 交叉審查（Codex 第二輪，CONTRACTS §22）。prepare 只請 daemon 產生 diff（不跑模型）；GM 看過檔案清單
   * 按確認才 startReview（耗額度）。清單在 board 快照的 reviews，變了推 review.updated。
   */
  getReview(id: string): Promise<Review>;
  prepareReview(target: ReviewTargetInput, reason?: string): Promise<Review>;
  startReview(id: string): Promise<Review>;
  cancelReview(id: string): Promise<Review>;
  readReviews(ids?: string[]): Promise<Review[]>;

  /** 由舊到新。請隊長拆解從這裡讀回覆；最近的交接紀錄也是。 */
  sessionEvents(sessionId: string): Promise<SessionEvent[]>;

  /**
   * 全域搜尋的快速層（P3 §3，`GET /api/search`）：只搜 hub 已有的資料。mask 為 true 時片段在 hub 就遮好。
   */
  search(query: SearchQuery): Promise<SearchResults>;

  /**
   * 全域搜尋的深層（P3 ③b，WS `search.deep`）：各台機器即時搜對話紀錄與活著的 session 的終端機畫面，
   * 結果逐台串流回來（listener）。mask 為 true 時片段在 daemon（與 hub）就遮好。只有按 Enter 才呼叫。
   */
  deepSearch(
    request: Omit<DeepSearchRequest, 'searchId'>,
    listener: (event: DeepSearchEvent) => void,
  ): DeepSearchHandle;
}
