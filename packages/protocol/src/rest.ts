// REST 介面表：hub 依此註冊路由並驗證，web 依此產生型別。路徑一律在 /api 底下。
import { z } from 'zod';
import {
  AuditEntry,
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
  Session,
  SessionEvent,
  Settings,
  Task,
  TaskColumn,
  Team,
  TeamMember,
  TeamRole,
  Template,
  TemplateConfig,
  UsageSummary,
  User,
  UserRole,
} from './models';
import { DirEntry, RepoInfo, SessionSpec } from './ws';

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

export const ApiError = z.object({ code: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

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
  machineUsage: route({
    method: 'GET',
    path: '/api/machines/:id/usage',
    auth: 'user',
    response: UsageSummary.nullable(),
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
    body: SessionSpec.extend({ machineId: Id }),
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
    query: z.object({ workspace: z.string() }),
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

  // 團隊（Phase 3 實作，合約先定）
  teamsList: route({ method: 'GET', path: '/api/teams', auth: 'user', response: z.array(Team) }),
  teamsCreate: route({
    method: 'POST',
    path: '/api/teams',
    auth: 'user',
    body: Team.omit({ id: true }),
    response: Team,
  }),
  teamsUpdate: route({
    method: 'PATCH',
    path: '/api/teams/:id',
    auth: 'user',
    body: Team.omit({ id: true }).partial(),
    response: Team,
  }),
  teamsDelete: route({ method: 'DELETE', path: '/api/teams/:id', auth: 'user', response: Ok }),
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
    body: z.object({ role: TeamRole }),
    response: TeamMember,
  }),
  teamMembersDelete: route({
    method: 'DELETE',
    path: '/api/teams/:id/members/:sessionId',
    auth: 'user',
    response: Ok,
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
  settingsGet: route({ method: 'GET', path: '/api/settings', auth: 'owner', response: Settings }),
  settingsUpdate: route({
    method: 'PATCH',
    path: '/api/settings',
    auth: 'owner',
    body: Settings.partial(),
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
