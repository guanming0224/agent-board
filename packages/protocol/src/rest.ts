// REST 介面表：hub 依此註冊路由並驗證，web 依此產生型別。路徑一律在 /api 底下。
import { z } from 'zod';
import {
  AuditEntry,
  AutoStaff,
  TEAM_ACTIVITY_KEEP,
  TeamActivity,
  Broadcast,
  BROADCAST_TEXT_MAX,
  BoardHeld,
  BoardInterruptResult,
  BoardPauseMode,
  BoardPauseState,
  HandoffRule,
  Id,
  IsoTime,
  Layout,
  Locale,
  Machine,
  MachineCapabilities,
  MachineOs,
  Note,
  Project,
  PurgeOptions,
  PurgeResult,
  Session,
  SessionEvent,
  SessionInspect,
  Settings,
  Task,
  TaskColumn,
  Team,
  TeamHoldMode,
  TeamHoldResult,
  TeamMember,
  TeamResumeResult,
  TeamRole,
  ResearchKind,
  Template,
  TemplateConfig,
  TranscriptPage,
  UsageSummary,
  User,
  UserRole,
  Zone,
  ZoneName,
} from './models';
import { UsageReport } from './usage';
import { HealthInfo, ReleaseChannel, ReleaseOverview, ReleaseRepo, Version } from './release';
import { ProgressCard, ProgressRevision, ProgressWrite } from './progress';
import { SearchQuery, SearchResults } from './search';
import { TeamPreset, TeamPresetConfig, TeamPresetName, TeamPresetUsed } from './presets';
import { DirEntry, FolderName, RepoInfo, SessionSpec } from './ws';

export type Auth = 'public' | 'user' | 'owner';

interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  auth: Auth;
  body?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
}

const route = <const T extends RouteDef>(def: T): T => def;

const Ok = z.object({ ok: z.literal(true) });
/** 密碼最短長度；hub 的 reset-password 指令也用這個數字。 */
export const MIN_PASSWORD_LENGTH = 8;
const Password = z.string().min(MIN_PASSWORD_LENGTH);

/** audit 依使用者篩選時，代表「沒有使用者」的紀錄（daemon、交接引擎、登入失敗、reset-password 指令）。 */
export const AUDIT_SYSTEM_USER = 'system';

/** 操作紀錄的篩選，列表與匯出共用。userId 是使用者 id 或 AUDIT_SYSTEM_USER。 */
export const AuditQuery = z.object({
  sessionId: Id.optional(),
  action: z.string().optional(),
  userId: Id.optional(),
  from: IsoTime.optional(),
  to: IsoTime.optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  /** 給程式讀的補充資料（例如 zone_not_empty 的 ZoneNotEmpty）；大多數錯誤沒有。 */
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
/** 刪除非空工作區（409 zone_not_empty）的 detail：擋住刪除的團隊數、單獨 session 數（P2 §2.5）。 */
export const ZoneNotEmpty = z.object({
  teams: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type ZoneNotEmpty = z.infer<typeof ZoneNotEmpty>;

/**
 * 修改設定的 body：只改有帶的鍵。`Settings` 頂層有預設值的欄位（autoContinue、dispatch）在這裡拿掉預設，
 * 否則 zod 的 partial 會把沒帶的鍵補成預設值，存別的設定時就悄悄改掉它們（例如把關掉的派工又打開）。
 */
export const SettingsPatch = Settings.extend({
  autoContinue: z.boolean(),
  dispatch: z.boolean(),
  memory: z.boolean(),
  autoStaff: AutoStaff,
}).partial();

/**
 * 進度卡的路由（P3 項目一，CONTRACTS §14）：團隊卡在 `/api/teams/:id/progress…`，單獨 session 的卡在
 * `/api/sessions/:id/progress…`，兩組行為相同。auth user（手機登入的一般帳號也能用）。
 */
function progressRoutes<const P extends 'teams' | 'sessions'>(owner: P) {
  const base = `/api/${owner}/:id/progress` as const;
  return {
    /** 單張卡（含自動事實）。還沒寫過回空卡（revision 0）。 */
    get: route({ method: 'GET', path: base, auth: 'user', response: ProgressCard }),
    /**
     * 寫入：只寫有帶的欄位；baseRevision 是讀到的版本。衝突回 409 progress_conflict（ApiError.detail 是
     * ProgressConflict）；欄位超過上限 400 field_too_long；baseRevision 比目前新 400 invalid_revision。
     * 成功回卡片（merged：和別人的改動合併寫入）。locked 切換鎖定（不加版本）。
     */
    put: route({
      method: 'PUT',
      path: base,
      auth: 'user',
      body: ProgressWrite,
      response: ProgressCard,
    }),
    /** 最近 50 版，新到舊。 */
    revisions: route({
      method: 'GET',
      path: `${base}/revisions`,
      auth: 'user',
      response: z.array(ProgressRevision),
    }),
    /** 還原這版＝以舊內容寫一個新版本（不刪歷史，source restore）。 */
    restore: route({
      method: 'POST',
      path: `${base}/restore`,
      auth: 'user',
      body: z.object({ revision: z.number().int().positive() }),
      response: ProgressCard,
    }),
    /**
     * 帶入進度卡：把卡片組成一行 `[Progress card: …]` 送進指定 session（任何 session 都可以），
     * 走 SafeDelivery manual（只在等輸入時送、忙就排隊、全部暫停不擋）。卡片全空 400 progress_empty。
     */
    deliver: route({
      method: 'POST',
      path: `${base}/deliver`,
      auth: 'user',
      body: z.object({ sessionId: Id }),
      response: Broadcast,
    }),
  };
}
const teamProgress = progressRoutes('teams');
const sessionProgress = progressRoutes('sessions');

export const routes = {
  // 登入與首次引導
  authStatus: route({
    method: 'GET',
    path: '/api/auth/status',
    auth: 'public',
    response: z.object({ needsSetup: z.boolean(), user: User.nullable() }),
  }),
  authSetup: route({
    method: 'POST',
    path: '/api/auth/setup',
    auth: 'public',
    body: z.object({ name: z.string().min(1), password: Password, locale: Locale }),
    response: User,
  }),
  authLogin: route({
    method: 'POST',
    path: '/api/auth/login',
    auth: 'public',
    body: z.object({ name: z.string().min(1), password: z.string().min(1) }),
    response: User,
  }),
  authLogout: route({ method: 'POST', path: '/api/auth/logout', auth: 'user', response: Ok }),

  // 使用者
  usersList: route({ method: 'GET', path: '/api/users', auth: 'owner', response: z.array(User) }),
  usersCreate: route({
    method: 'POST',
    path: '/api/users',
    auth: 'owner',
    body: z.object({ name: z.string().min(1), password: Password, role: UserRole, locale: Locale }),
    response: User,
  }),
  usersUpdate: route({
    method: 'PATCH',
    path: '/api/users/:id',
    auth: 'user',
    body: z
      .object({
        locale: Locale.optional(),
        password: Password.optional(),
        /** 改密碼時必填，避免 cookie 被偷就能改掉密碼。 */
        currentPassword: z.string().min(1).optional(),
      })
      .refine((b) => !b.password || b.currentPassword, { path: ['currentPassword'] }),
    response: User,
  }),
  /**
   * 管理員重設「別人」的密碼：不需要對方的舊密碼，對方所有裝置登出。
   * 改自己的密碼一律走 usersUpdate（要附目前的密碼），這裡回 400 own_password。
   */
  usersResetPassword: route({
    method: 'POST',
    path: '/api/users/:id/reset-password',
    auth: 'owner',
    body: z.object({ password: Password }),
    response: Ok,
  }),
  usersDelete: route({ method: 'DELETE', path: '/api/users/:id', auth: 'owner', response: Ok }),

  // 機器與配對
  machinesList: route({
    method: 'GET',
    path: '/api/machines',
    auth: 'user',
    response: z.array(Machine),
  }),
  machinesRename: route({
    method: 'PATCH',
    path: '/api/machines/:id',
    auth: 'owner',
    body: z.object({ name: z.string().min(1) }),
    response: Machine,
  }),
  /** 撤銷 token 並移除機器。 */
  machinesDelete: route({
    method: 'DELETE',
    path: '/api/machines/:id',
    auth: 'owner',
    response: Ok,
  }),
  pairingCreate: route({
    method: 'POST',
    path: '/api/machines/pairing-codes',
    auth: 'owner',
    response: z.object({ code: z.string(), expiresAt: IsoTime, installCommand: z.string() }),
  }),
  /** daemon 用一次性配對碼換長期 token。配對碼本身就是憑證，要限速。 */
  pairingExchange: route({
    method: 'POST',
    path: '/api/machines/pair',
    auth: 'public',
    body: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      os: MachineOs,
      capabilities: MachineCapabilities,
    }),
    response: z.object({ machineId: Id, token: z.string() }),
  }),
  machineBrowse: route({
    method: 'GET',
    path: '/api/machines/:id/fs',
    auth: 'user',
    query: z.object({ path: z.string() }),
    response: z.object({
      path: z.string(),
      entries: z.array(DirEntry),
      repo: RepoInfo.nullable().default(null),
    }),
  }),
  /** 在遠端機器建一層新資料夾（新 session 選路徑用），回傳新資料夾的列表。 */
  machineMkdir: route({
    method: 'POST',
    path: '/api/machines/:id/fs',
    auth: 'user',
    body: z.object({ parent: z.string().min(1), name: FolderName }),
    response: z.object({
      path: z.string(),
      entries: z.array(DirEntry),
      repo: RepoInfo.nullable().default(null),
    }),
  }),
  machineUsage: route({
    method: 'GET',
    path: '/api/machines/:id/usage',
    auth: 'user',
    response: UsageSummary.nullable(),
  }),
  /** 用量詳情（GM 2026-11-09）：跨機器彙整的細項，Claude session 已對應到 Agent Board 的 session、團隊、工作區、專案。 */
  usageReport: route({
    method: 'GET',
    path: '/api/usage',
    auth: 'user',
    response: UsageReport,
  }),

  // Session
  sessionsList: route({
    method: 'GET',
    path: '/api/sessions',
    auth: 'user',
    query: z.object({ archived: z.stringbool().optional() }),
    response: z.array(Session),
  }),
  sessionsCreate: route({
    method: 'POST',
    path: '/api/sessions',
    auth: 'user',
    /** zoneId：放在哪個工作區（P2 §2：新建 session 放在目前工作區）；沒帶＝排第一個的工作區。 */
    body: SessionSpec.extend({ machineId: Id, zoneId: Id.optional() }),
    response: Session,
  }),
  sessionsUpdate: route({
    method: 'PATCH',
    path: '/api/sessions/:id',
    auth: 'user',
    body: z.object({
      name: z.string().min(1).optional(),
      projectId: Id.nullable().optional(),
      archived: z.boolean().optional(),
      /** 使用者標記完成（§4 的 done 只能由使用者設定）。 */
      markDone: z.literal(true).optional(),
      /** 移到別的工作區（單獨 session 用；團隊成員以團隊為準，這欄照存但不影響顯示）。 */
      zoneId: Id.optional(),
    }),
    response: Session,
  }),
  sessionsStop: route({
    method: 'POST',
    path: '/api/sessions/:id/stop',
    auth: 'user',
    response: Session,
  }),
  sessionsResume: route({
    method: 'POST',
    path: '/api/sessions/:id/resume',
    auth: 'user',
    response: Session,
  }),
  /** 刪除前的檢查（對話大小、git 狀況、hook 是否共用）。機器離線回 409 machine_offline。 */
  sessionInspect: route({
    method: 'GET',
    path: '/api/sessions/:id/inspect',
    auth: 'user',
    response: SessionInspect,
  }),
  /** 讀這個 session 的 Claude 對話紀錄（看舊資料用），可搜尋、分頁。 */
  sessionTranscript: route({
    method: 'GET',
    path: '/api/sessions/:id/transcript',
    auth: 'user',
    query: z.object({
      cursor: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().positive().max(500).default(100),
      q: z.string().max(200).optional(),
    }),
    response: TranscriptPage,
  }),
  /**
   * 永久刪除：只能刪已封存且已結束的 session（否則 409 not_archived／session_active）。
   * 勾了任何機器上的清理而機器離線 → 409 machine_offline；removeHooks 而 hook 共用 → 409 hooks_shared。
   * 成功後廣播 session.removed。操作紀錄（audit_log）保留。
   */
  sessionsDelete: route({
    method: 'POST',
    path: '/api/sessions/:id/delete',
    auth: 'owner',
    body: PurgeOptions,
    response: z.object({ result: PurgeResult }),
  }),
  sessionEvents: route({
    method: 'GET',
    path: '/api/sessions/:id/events',
    auth: 'user',
    response: z.array(SessionEvent),
  }),

  // 專案、版面、便利貼
  projectsList: route({
    method: 'GET',
    path: '/api/projects',
    auth: 'user',
    response: z.array(Project),
  }),
  projectsCreate: route({
    method: 'POST',
    path: '/api/projects',
    auth: 'user',
    body: Project.omit({ id: true }),
    response: Project,
  }),
  projectsUpdate: route({
    method: 'PATCH',
    path: '/api/projects/:id',
    auth: 'user',
    body: Project.omit({ id: true }).partial(),
    response: Project,
  }),
  projectsDelete: route({
    method: 'DELETE',
    path: '/api/projects/:id',
    auth: 'user',
    response: Ok,
  }),
  layoutsGet: route({
    method: 'GET',
    path: '/api/layouts',
    auth: 'user',
    query: z.object({ workspace: z.string() }),
    response: z.array(Layout),
  }),
  layoutsPut: route({
    method: 'PUT',
    path: '/api/layouts',
    auth: 'user',
    body: z.array(Layout),
    response: Ok,
  }),
  notesList: route({
    method: 'GET',
    path: '/api/notes',
    auth: 'user',
    query: z.object({ zoneId: Id }),
    response: z.array(Note),
  }),
  notesCreate: route({
    method: 'POST',
    path: '/api/notes',
    auth: 'user',
    body: Note.omit({ id: true }),
    response: Note,
  }),
  notesUpdate: route({
    method: 'PATCH',
    path: '/api/notes/:id',
    auth: 'user',
    body: Note.omit({ id: true }).partial(),
    response: Note,
  }),
  notesDelete: route({ method: 'DELETE', path: '/api/notes/:id', auth: 'user', response: Ok }),

  // 範本
  templatesList: route({
    method: 'GET',
    path: '/api/templates',
    auth: 'user',
    response: z.array(Template),
  }),
  templatesCreate: route({
    method: 'POST',
    path: '/api/templates',
    auth: 'user',
    body: z.object({ name: z.string().min(1), config: TemplateConfig }),
    response: Template,
  }),
  templatesUpdate: route({
    method: 'PATCH',
    path: '/api/templates/:id',
    auth: 'user',
    body: z.object({ name: z.string().min(1), config: TemplateConfig }).partial(),
    response: Template,
  }),
  templatesDelete: route({
    method: 'DELETE',
    path: '/api/templates/:id',
    auth: 'user',
    response: Ok,
  }),

  // 團隊 Presets（P3 項目二，docs/p3-spec.md §2；CONTRACTS §15）：全 hub 共用，一般使用者（手機）也能用。
  // 名稱不分大小寫不能重複：409 preset_name_taken。清單照 position 排；建立、改名、排序、刪除都推 WS preset.list。
  teamPresetsList: route({
    method: 'GET',
    path: '/api/team-presets',
    auth: 'user',
    response: z.array(TeamPreset),
  }),
  teamPresetsCreate: route({
    method: 'POST',
    path: '/api/team-presets',
    auth: 'user',
    /** position 沒帶＝排最後；有帶（刪除後「復原」）＝插回那個位置。 */
    body: z.object({
      name: TeamPresetName,
      config: TeamPresetConfig,
      position: z.number().int().nonnegative().optional(),
    }),
    response: TeamPreset,
  }),
  teamPresetsUpdate: route({
    method: 'PATCH',
    path: '/api/team-presets/:id',
    auth: 'user',
    /** position：移到第幾個（0 起；超過就放最後），其他的依序往後排。 */
    body: z
      .object({
        name: TeamPresetName,
        config: TeamPresetConfig,
        position: z.number().int().nonnegative(),
      })
      .partial(),
    response: TeamPreset,
  }),
  teamPresetsDelete: route({
    method: 'DELETE',
    path: '/api/team-presets/:id',
    auth: 'user',
    response: Ok,
  }),
  /** 套用完成（前端逐列建立後）回報：更新 lastUsedAt、寫 audit preset.apply（成功與失敗列數）。 */
  teamPresetsUsed: route({
    method: 'POST',
    path: '/api/team-presets/:id/used',
    auth: 'user',
    body: TeamPresetUsed,
    response: TeamPreset,
  }),

  // 工作區（P2 項目二）：全 hub 共用，一般使用者可改。刪除只在沒有團隊、也沒有單獨 session 時可以：
  // 非空回 409 zone_not_empty（ApiError.detail 是 ZoneNotEmpty：團隊數、session 數），最後一個回 409 last_zone。
  zonesList: route({ method: 'GET', path: '/api/zones', auth: 'user', response: z.array(Zone) }),
  zonesCreate: route({
    method: 'POST',
    path: '/api/zones',
    auth: 'user',
    body: z.object({ name: ZoneName }),
    response: Zone,
  }),
  zonesUpdate: route({
    method: 'PATCH',
    path: '/api/zones/:id',
    auth: 'user',
    body: z.object({ name: ZoneName }),
    response: Zone,
  }),
  zonesDelete: route({ method: 'DELETE', path: '/api/zones/:id', auth: 'user', response: Ok }),

  // 團隊（Phase 3 實作，合約先定）
  teamsList: route({ method: 'GET', path: '/api/teams', auth: 'user', response: z.array(Team) }),
  teamsCreate: route({
    method: 'POST',
    path: '/api/teams',
    auth: 'user',
    /** zoneId 沒帶＝排第一個的工作區。 */
    body: Team.omit({ id: true, zoneId: true, hold: true }).extend({ zoneId: Id.optional() }),
    response: Team,
  }),
  teamsUpdate: route({
    method: 'PATCH',
    path: '/api/teams/:id',
    auth: 'user',
    body: Team.omit({ id: true, hold: true }).partial(),
    response: Team,
  }),
  teamsDelete: route({ method: 'DELETE', path: '/api/teams/:id', auth: 'user', response: Ok }),
  /**
   * 全隊暫停／全隊停止（CONTRACTS §17）：hub 一次做完「關掉啟用中的交接規則與任務自動執行＋對工作中的成員送 Esc
   * （pause）或停掉活著的成員（stop）」，並記下關了哪些（Team.hold）。已有記錄時再按＝合併（停止優先）。
   */
  teamHold: route({
    method: 'POST',
    path: '/api/teams/:id/hold',
    auth: 'user',
    body: z.object({ mode: TeamHoldMode }),
    response: TeamHoldResult,
  }),
  /**
   * 全隊繼續／全隊啟動：只打開當初關掉、現在還關著的規則與任務自動執行，不自動送字；stop 另外對當初停掉、
   * 現在仍結束、機器在線的成員 `--resume` 接回。失聯的留在記錄裡，其餘清掉。
   */
  teamResume: route({
    method: 'POST',
    path: '/api/teams/:id/resume',
    auth: 'user',
    response: TeamResumeResult,
  }),
  teamMembersList: route({
    method: 'GET',
    path: '/api/teams/:id/members',
    auth: 'user',
    response: z.array(TeamMember),
  }),
  teamMembersPut: route({
    method: 'PUT',
    path: '/api/teams/:id/members/:sessionId',
    auth: 'user',
    /** kind 沒帶時保留原本的（只改角色）；研究團隊快速建立時帶。 */
    body: z.object({ role: TeamRole, kind: ResearchKind.optional() }),
    response: TeamMember,
  }),
  teamMembersDelete: route({
    method: 'DELETE',
    path: '/api/teams/:id/members/:sessionId',
    auth: 'user',
    response: Ok,
  }),
  /**
   * 群發（P2 §2.3）：對整組或點名的成員送一則指令。hub 端走 SafeDelivery（只在對象等輸入時送，其他排隊），
   * 瀏覽器不逐一送 terminal.input。全部暫停中照送（Q6，GM 親手下的）。targets 有帶＝點名，只送給這些人；
   * 不是本團隊成員回 400 not_member。後續狀態變化經 WS `broadcast.updated` 推送。
   */
  teamBroadcast: route({
    method: 'POST',
    path: '/api/teams/:id/broadcast',
    auth: 'user',
    body: z.object({
      text: z.string().trim().min(1).max(BROADCAST_TEXT_MAX),
      targets: z.array(Id).min(1).optional(),
    }),
    response: Broadcast,
  }),
  /** 取消一則群發裡某個對象還在排隊的送字（已送出、已略過的不變）。 */
  broadcastCancel: route({
    method: 'POST',
    path: '/api/broadcasts/:id/cancel',
    auth: 'user',
    body: z.object({ sessionId: Id }),
    response: Broadcast,
  }),
  tasksList: route({
    method: 'GET',
    path: '/api/teams/:id/tasks',
    auth: 'user',
    response: z.array(Task),
  }),
  tasksCreate: route({
    method: 'POST',
    path: '/api/teams/:id/tasks',
    auth: 'user',
    body: z.object({ title: z.string().min(1), ownerSessionId: Id.nullable() }),
    response: Task,
  }),
  tasksUpdate: route({
    method: 'PATCH',
    path: '/api/tasks/:id',
    auth: 'user',
    body: z
      .object({ title: z.string().min(1), ownerSessionId: Id.nullable(), column: TaskColumn })
      .partial(),
    response: Task,
  }),
  tasksDelete: route({ method: 'DELETE', path: '/api/tasks/:id', auth: 'user', response: Ok }),
  handoffRulesList: route({
    method: 'GET',
    path: '/api/teams/:id/handoff-rules',
    auth: 'user',
    response: z.array(HandoffRule),
  }),
  handoffRulesCreate: route({
    method: 'POST',
    path: '/api/teams/:id/handoff-rules',
    auth: 'user',
    body: HandoffRule.omit({ id: true, teamId: true }),
    response: HandoffRule,
  }),
  handoffRulesUpdate: route({
    method: 'PATCH',
    path: '/api/handoff-rules/:id',
    auth: 'user',
    body: HandoffRule.omit({ id: true, teamId: true }).partial(),
    response: HandoffRule,
  }),
  handoffRulesDelete: route({
    method: 'DELETE',
    path: '/api/handoff-rules/:id',
    auth: 'user',
    response: Ok,
  }),

  // 進度卡與 Memory（P3 項目一，CONTRACTS §14）
  /** 卡片清單（含自動事實）。zoneId：只回這個工作區的（團隊看 team.zoneId，單獨 session 看 session.zoneId）；all＝全部。 */
  progressList: route({
    method: 'GET',
    path: '/api/progress',
    auth: 'user',
    query: z.object({ zoneId: Id.optional(), all: z.stringbool().optional() }),
    response: z.array(ProgressCard),
  }),
  progressTeamGet: teamProgress.get,
  progressTeamPut: teamProgress.put,
  progressTeamRevisions: teamProgress.revisions,
  progressTeamRestore: teamProgress.restore,
  progressTeamDeliver: teamProgress.deliver,
  progressSessionGet: sessionProgress.get,
  progressSessionPut: sessionProgress.put,
  progressSessionRevisions: sessionProgress.revisions,
  progressSessionRestore: sessionProgress.restore,
  progressSessionDeliver: sessionProgress.deliver,
  /** 請隊長更新 ◈：送固定一行 PROGRESS_ASK_UPDATE_PROMPT 給隊長（SafeDelivery manual）。沒有隊長 400 no_lead。 */
  progressAskUpdate: route({
    method: 'POST',
    path: '/api/teams/:id/progress/ask-update',
    auth: 'user',
    response: Broadcast,
  }),

  /**
   * 全域搜尋的快速層（P3 §3，CONTRACTS §16）：只搜 hub 已有的資料（session 欄位、檔案改動、每回合最後回覆、
   * 交接／派工／任務摘要、團隊文字與任務標題；進度卡在項目一上架後加入）。「GM 送出的指令」（audit 的 terminal.input）
   * 只回給 owner。mask=1 時片段在 hub 就遮蔽。不寫 audit（太頻繁）。
   */
  search: route({
    method: 'GET',
    path: '/api/search',
    auth: 'user',
    query: SearchQuery,
    response: SearchResults,
  }),

  // 稽核與設定
  auditList: route({
    method: 'GET',
    path: '/api/audit',
    auth: 'owner',
    query: AuditQuery.extend({
      limit: z.coerce.number().int().positive().max(1000).default(100),
    }),
    response: z.array(AuditEntry),
  }),
  /** 回傳 text/csv，不經過 JSON；response 僅描述內容。篩選同 auditList，但沒有筆數上限。 */
  auditExport: route({
    method: 'GET',
    path: '/api/audit/export',
    auth: 'owner',
    query: AuditQuery,
    response: z.string(),
  }),
  // 全部暫停（P2 項目三）：user 權限（手機登入的一般帳號也要能用）。
  boardPauseGet: route({
    method: 'GET',
    path: '/api/board/pause',
    auth: 'user',
    response: BoardPauseState,
  }),
  /**
   * 暫停（已暫停時改模式）。interrupt 另外對每個 RUN session 送 Esc，interrupted 列出結果；
   * finish_turn 的 interrupted 是空陣列。
   */
  boardPause: route({
    method: 'POST',
    path: '/api/board/pause',
    auth: 'user',
    body: z.object({ mode: BoardPauseMode }),
    response: z.object({ state: BoardPauseState, interrupted: z.array(BoardInterruptResult) }),
  }),
  /** 解除暫停：只解除閘門，不對被中斷的 session 送「繼續」（Q8）。released 是放出的數量（沒暫停時全是 0）。 */
  boardResume: route({
    method: 'POST',
    path: '/api/board/resume',
    auth: 'user',
    response: z.object({ state: BoardPauseState, released: BoardHeld }),
  }),
  /**
   * 團隊動態（隊長自主擴編，CONTRACTS §11.1）：清單在 board 快照的 teamActivity，變了推 team.activity。
   * 標已讀／清除：ids 沒給＝全部。回傳整份新清單。
   */
  teamActivityRead: route({
    method: 'POST',
    path: '/api/team-activity/read',
    auth: 'user',
    body: z.object({ ids: z.array(Id).max(TEAM_ACTIVITY_KEEP).optional() }),
    response: z.array(TeamActivity),
  }),
  teamActivityClear: route({
    method: 'POST',
    path: '/api/team-activity/clear',
    auth: 'user',
    body: z.object({ ids: z.array(Id).max(TEAM_ACTIVITY_KEEP).optional() }),
    response: z.array(TeamActivity),
  }),
  settingsGet: route({ method: 'GET', path: '/api/settings', auth: 'owner', response: Settings }),
  settingsUpdate: route({
    method: 'PATCH',
    path: '/api/settings',
    auth: 'owner',
    body: SettingsPatch,
    response: Settings,
  }),

  // 推播
  pushVapidKey: route({
    method: 'GET',
    path: '/api/push/vapid-key',
    auth: 'user',
    response: z.object({ publicKey: z.string() }),
  }),
  pushSubscribe: route({
    method: 'POST',
    path: '/api/push/subscriptions',
    auth: 'user',
    body: z.object({
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string(), auth: z.string() }),
    }),
    response: Ok,
  }),
  pushUnsubscribe: route({
    method: 'DELETE',
    path: '/api/push/subscriptions',
    auth: 'user',
    body: z.object({ endpoint: z.string().url() }),
    response: Ok,
  }),

  // 發版與自動更新（CONTRACTS §21）。成品下載 `GET /api/releases/:version/:platform` 用機器 token，不在這張表。
  /** 服務活著、版本（更新程式的健康檢查）。不需登入。 */
  health: route({
    method: 'GET',
    path: '/api/health',
    auth: 'public',
    response: HealthInfo,
  }),
  /** 機器面板：canary／stable、gh 狀態、各機版本與更新狀態。 */
  releasesOverview: route({
    method: 'GET',
    path: '/api/releases',
    auth: 'user',
    response: ReleaseOverview,
  }),
  /** 「檢查新版」：用 hub 機器上已登入的 gh 查 Release、下載並驗 SHA-256，新版設為 canary。 */
  releasesCheck: route({
    method: 'POST',
    path: '/api/releases/check',
    auth: 'owner',
    response: ReleaseOverview,
  }),
  /**
   * 「升為 stable」。canary 跑不到 24 小時要帶 `confirm: true`（不帶回 409 `canary_too_new`）；
   * 版本不在 release-cache 回 409 `not_cached`。
   */
  releasesPromote: route({
    method: 'POST',
    path: '/api/releases/promote',
    auth: 'owner',
    body: z.object({ version: Version, confirm: z.boolean().default(false) }),
    response: ReleaseOverview,
  }),
  /** Release 所在的 GitHub repo（`owner/name`；null 清掉）。 */
  releasesConfig: route({
    method: 'PATCH',
    path: '/api/releases/config',
    auth: 'owner',
    body: z.object({ repo: ReleaseRepo.nullable() }),
    response: ReleaseOverview,
  }),
  /** 切換機器的通道。 */
  machineChannel: route({
    method: 'PUT',
    path: '/api/machines/:id/channel',
    auth: 'owner',
    body: z.object({ channel: ReleaseChannel }),
    response: ReleaseOverview,
  }),
  /** 「立即更新」：照目前目標版本更新（不管上次失敗過；延後條件仍然要過）。機器離線回 409 `machine_offline`。 */
  machineUpdate: route({
    method: 'POST',
    path: '/api/machines/:id/update',
    auth: 'owner',
    response: ReleaseOverview,
  }),
  /** 「回滾到上一版」。機器離線回 409 `machine_offline`，不知道上一版回 409 `no_previous`。 */
  machineRollback: route({
    method: 'POST',
    path: '/api/machines/:id/rollback',
    auth: 'owner',
    response: ReleaseOverview,
  }),
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
export type RouteResponse<N extends RouteName> = z.infer<Routes[N]['response']>;
export type RouteBody<N extends RouteName> = Routes[N] extends { body: infer B extends z.ZodType }
  ? z.input<B>
  : never;
export type RouteQuery<N extends RouteName> = Routes[N] extends { query: infer Q extends z.ZodType }
  ? z.input<Q>
  : never;
