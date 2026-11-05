// 畫面只透過這個介面存取資料。Phase 1 接 fakeBackend，Phase 2 由 Lead 接真 hub。
import type {
  Approval,
  ApprovalDecision,
  AuditEntry,
  HandoffRule,
  Layout,
  Machine,
  Note,
  Project,
  PurgeOptions,
  PurgeResult,
  RepoInfo,
  ResourceSample,
  Session,
  SessionEvent,
  SessionInspect,
  SessionSpec,
  Settings,
  Task,
  Team,
  TeamMember,
  Template,
  TranscriptPage,
  UsageSummary,
  User,
} from '@agent-board/protocol';
import type { TerminalStream } from './terminal-contract';

export interface BoardSnapshot {
  machines: Machine[];
  sessions: Session[];
  approvals: Approval[];
}

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

  createSession(input: SessionSpec & { machineId: string }): Promise<Session>;
  updateSession(
    id: string,
    patch: { name?: string; archived?: boolean; markDone?: true },
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

  getLayouts(workspace: string): Promise<Layout[]>;
  saveLayouts(layouts: Layout[]): Promise<void>;
  getNotes(workspace: string): Promise<Note[]>;
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
  createTeam(input: Omit<Team, 'id'>): Promise<Team>;
  updateTeam(id: string, patch: Partial<Omit<Team, 'id'>>): Promise<Team>;
  deleteTeam(id: string): Promise<void>;
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
  /** 由舊到新。請隊長拆解從這裡讀回覆；最近的交接紀錄也是。 */
  sessionEvents(sessionId: string): Promise<SessionEvent[]>;
}
