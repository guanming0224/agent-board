// SQLite 存取層。欄位 snake_case ↔ API camelCase 的轉換集中在這裡。
import { randomUUID } from 'node:crypto';
import {
  AgentKind,
  AUDIT_SYSTEM_USER,
  AUTO_STAFF_DEFAULT,
  AutoContinue,
  BoardPause,
  DEFAULT_WAITING_LIMIT,
  DEFAULT_ZONE_ID,
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  DispatchWork,
  MemberAdded,
  TEAM_ACTIVITY_KEEP,
  TeamActivity,
  EMPTY_PROGRESS_FIELDS,
  ProgressFieldRevisions,
  ProgressFields,
  Settings,
  ZERO_FIELD_REVISIONS,
  type ProgressOwner,
  type ProgressSource,
  TaskAuto,
  type AuditEntry,
  type HandoffRule,
  type Layout,
  type Machine,
  type Note,
  type Project,
  type Session,
  type SessionEvent,
  type SessionSpec,
  type SessionStatus,
  type Task,
  type Team,
  TeamHold,
  type TeamMember,
  type Template,
  type User,
  type Zone,
} from '@agent-board/protocol';
import { z } from 'zod';
import type { Db } from './db';
import type { PushSubscriptionRecord, VapidKeys } from './push';

/** settings 表裡存每台機器用量的鍵前綴（不是設定，getSettings 不讀）。 */
const USAGE_KEY_PREFIX = 'usage:';

/** 存在 settings 表 `boardPause` 鍵的暫停狀態；heldInMemory 是記憶體佇列裡被擋下的則數（重啟時拿來交代）。 */
export const StoredBoardPause = BoardPause.extend({
  heldInMemory: z.number().int().nonnegative().default(0),
});
export type StoredBoardPause = z.infer<typeof StoredBoardPause>;
const BOARD_PAUSE_KEY = 'boardPause';
/** 全隊暫停／停止的記錄（CONTRACTS §17）：settings 表 `teamHold:<teamId>`，不升 schema。 */
const TEAM_HOLD_PREFIX = 'teamHold:';
/** 隊長新增成員的記錄（隊長自主擴編，GM 2026-11-10）：settings 表 `memberAdded:<sessionId>`，不升 schema。 */
const MEMBER_ADDED_PREFIX = 'memberAdded:';
/** 團隊動態（同上）：settings 表 `teamActivity`，新的在前，最多 TEAM_ACTIVITY_KEEP 筆。 */
const TEAM_ACTIVITY_KEY = 'teamActivity';
/**
 * session 跑的是哪個 CLI（Codex 接口第一版，GM 2026-11-10）：settings 表 `sessionAgent:<sessionId>`，不升 schema。
 * 只有 Codex 才寫；沒有這個鍵＝Claude Code（舊資料都是）。
 */
const SESSION_AGENT_PREFIX = 'sessionAgent:';

const DEFAULT_SETTINGS = (listenAddress: string): Settings => ({
  listenAddress,
  publicOrigin: null,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  dangerRules: [...DEFAULT_DANGER_RULES],
  quotaGuards: { denyReadPaths: [], maxConcurrentSessions: null, queueWhenRateLimited: true },
  notifications: {
    enabled: true,
    quietHours: null,
    coalesce: true,
    waitingLimit: DEFAULT_WAITING_LIMIT,
  },
  autoContinue: false,
  dispatch: true,
  memory: true,
  autoStaff: { ...AUTO_STAFF_DEFAULT },
});

interface UserRow {
  id: string;
  name: string;
  password_hash: string;
  role: User['role'];
  locale: User['locale'];
}

interface MachineRow {
  id: string;
  name: string;
  os: Machine['os'];
  last_seen_at: string | null;
  online: number;
  capabilities: string;
}

interface SessionRow {
  id: string;
  machine_id: string;
  project_id: string | null;
  name: string;
  cwd: string;
  branch: string | null;
  worktree_path: string | null;
  permission_mode: Session['permissionMode'];
  model: string | null;
  account_profile: string | null;
  status: SessionStatus;
  status_detail: string | null;
  claude_session_id: string | null;
  last_lines: string;
  last_output_at: string | null;
  status_since: string;
  context_tokens: number | null;
  context_window: number | null;
  repo_root: string | null;
  repo_common_dir: string | null;
  created_at: string;
  ended_at: string | null;
  archived: number;
  archived_at: string | null;
  read_only: number;
  auto_continue: string | null;
  dispatched_by: string | null;
  dispatch_work: string | null;
  zone_id: string;
  pending_spec: string | null;
  pre_offline_status: SessionStatus | null;
}

interface TeamRow {
  id: string;
  name: string;
  goal: string;
  done_criteria: string;
  color: string;
  context_md: string;
  phase: Team['phase'] | null;
  task_auto: number;
  zone_id: string;
}

interface TaskRow {
  id: string;
  team_id: string;
  title: string;
  owner_session_id: string | null;
  column: Task['column'];
  number: number;
  reject_count: number;
  needs_user: number;
  reviewer_session_id: string | null;
  auto: string | null;
}

interface RuleRow {
  id: string;
  team_id: string;
  from_session_id: string;
  trigger: HandoffRule['trigger'];
  action: string;
  enabled: number;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  action: string;
  detail: string;
  at: string;
}

const toUser = (r: UserRow): User => ({ id: r.id, name: r.name, role: r.role, locale: r.locale });

const toMachine = (r: MachineRow): Machine => ({
  id: r.id,
  name: r.name,
  os: r.os,
  online: r.online === 1,
  lastSeenAt: r.last_seen_at,
  capabilities: JSON.parse(r.capabilities) as Machine['capabilities'],
});

/** hub 自己寫的 JSON；讀不懂就當沒排過（不送），不能讓整個 session 讀不出來。 */
function parseAutoContinue(text: string | null): AutoContinue | null {
  if (text === null) return null;
  try {
    const parsed = AutoContinue.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  machineId: r.machine_id,
  projectId: r.project_id,
  name: r.name,
  cwd: r.cwd,
  branch: r.branch,
  worktreePath: r.worktree_path,
  permissionMode: r.permission_mode,
  model: r.model,
  accountProfile: r.account_profile,
  status: r.status,
  statusDetail: r.status_detail,
  claudeSessionId: r.claude_session_id,
  lastLines: JSON.parse(r.last_lines) as string[],
  lastOutputAt: r.last_output_at,
  statusSince: r.status_since,
  contextTokens: r.context_tokens,
  contextWindow: r.context_window,
  repoRoot: r.repo_root,
  repoCommonDir: r.repo_common_dir,
  createdAt: r.created_at,
  endedAt: r.ended_at,
  archived: r.archived === 1,
  archivedAt: r.archived_at,
  readOnly: r.read_only === 1,
  autoContinue: parseAutoContinue(r.auto_continue),
  dispatchedBy: r.dispatched_by,
  zoneId: r.zone_id,
});

interface NoteRow {
  id: string;
  zone_id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  zoneId: r.zone_id,
  x: r.x,
  y: r.y,
  text: r.text,
  color: r.color,
});

const toTeam = (r: TeamRow): Team => ({
  id: r.id,
  name: r.name,
  goal: r.goal,
  doneCriteria: r.done_criteria,
  color: r.color,
  contextMd: r.context_md,
  ...(r.phase ? { phase: r.phase } : {}),
  taskAuto: r.task_auto === 1,
  zoneId: r.zone_id,
});

const withHold = (team: Team, hold: TeamHold | undefined): Team =>
  hold ? { ...team, hold } : team;

function parseTeamHold(text: string): TeamHold | null {
  try {
    const parsed = TeamHold.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** auto 是 hub 自己寫的 JSON；讀不懂（理論上不會）就當沒有，不能讓整個任務板讀不出來。 */
function parseTaskAuto(text: string | null): TaskAuto | null {
  if (text === null) return null;
  try {
    const parsed = TaskAuto.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  teamId: r.team_id,
  title: r.title,
  ownerSessionId: r.owner_session_id,
  column: r.column,
  number: r.number,
  rejectCount: r.reject_count,
  needsUser: r.needs_user === 1,
  reviewerSessionId: r.reviewer_session_id,
  auto: parseTaskAuto(r.auto),
});

const toRule = (r: RuleRow): HandoffRule => ({
  id: r.id,
  teamId: r.team_id,
  fromSessionId: r.from_session_id,
  trigger: r.trigger,
  action: JSON.parse(r.action) as HandoffRule['action'],
  enabled: r.enabled === 1,
});

const toAudit = (r: AuditRow): AuditEntry => ({
  id: r.id,
  userId: r.user_id,
  sessionId: r.session_id,
  action: r.action,
  detail: r.detail,
  at: r.at,
});

export interface AuditFilter {
  sessionId?: string;
  action?: string;
  /** 使用者 id；AUDIT_SYSTEM_USER 表示沒有使用者的紀錄。 */
  userId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** listAudit 與匯出共用的 WHERE；值一律走參數，不拼字串。 */
function auditWhere(filter: AuditFilter): { clause: string; args: (string | number)[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.sessionId) {
    where.push('session_id = ?');
    args.push(filter.sessionId);
  }
  if (filter.action) {
    where.push('action = ?');
    args.push(filter.action);
  }
  if (filter.userId === AUDIT_SYSTEM_USER) {
    where.push('user_id IS NULL');
  } else if (filter.userId) {
    where.push('user_id = ?');
    args.push(filter.userId);
  }
  if (filter.from) {
    where.push('at >= ?');
    args.push(filter.from);
  }
  if (filter.to) {
    where.push('at <= ?');
    args.push(filter.to);
  }
  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', args };
}

/** 資料庫裡的一張進度卡（不含自動事實；名稱讀取時才查）。 */
export interface StoredProgress {
  id: string;
  teamId: string | null;
  sessionId: string | null;
  fields: ProgressFields;
  revision: number;
  locked: boolean;
  updatedAt: string | null;
  updatedByKind: 'user' | 'session' | null;
  updatedById: string | null;
  fieldRevisions: ProgressFieldRevisions;
}

export interface StoredProgressRevision {
  revision: number;
  fields: ProgressFields;
  byKind: 'user' | 'session';
  byId: string | null;
  source: ProgressSource;
  at: string;
}

interface ProgressRow {
  id: string;
  team_id: string | null;
  session_id: string | null;
  status: string;
  next: string;
  blockers: string;
  gm_notes: string;
  revision: number;
  locked: number;
  updated_at: string | null;
  updated_by_kind: 'user' | 'session' | null;
  updated_by_id: string | null;
  field_revisions: string;
}

interface ProgressRevisionRow {
  revision: number;
  fields: string;
  by_kind: 'user' | 'session';
  by_id: string | null;
  source: ProgressSource;
  at: string;
}

function toProgress(r: ProgressRow): StoredProgress {
  // 舊版或手改的 JSON 缺欄位：當成 0（沒改過），三方比對最多多擋一次，不會默默覆蓋。
  const parsed = ProgressFieldRevisions.partial().safeParse(safeJson(r.field_revisions));
  return {
    id: r.id,
    teamId: r.team_id,
    sessionId: r.session_id,
    fields: { status: r.status, next: r.next, blockers: r.blockers, gmNotes: r.gm_notes },
    revision: r.revision,
    locked: r.locked === 1,
    updatedAt: r.updated_at,
    updatedByKind: r.updated_by_kind,
    updatedById: r.updated_by_id,
    fieldRevisions: { ...ZERO_FIELD_REVISIONS, ...(parsed.success ? parsed.data : {}) },
  };
}

function toProgressRevision(r: ProgressRevisionRow): StoredProgressRevision {
  const parsed = ProgressFields.partial().safeParse(safeJson(r.fields));
  return {
    revision: r.revision,
    fields: { ...EMPTY_PROGRESS_FIELDS, ...(parsed.success ? parsed.data : {}) },
    byKind: r.by_kind,
    byId: r.by_id,
    source: r.source,
    at: r.at,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class Store {
  /**
   * 隊長新增成員的記錄（`memberAdded:*`）的快取：listTeamMembers 在熱路徑上（teamsOf 對每個團隊各呼叫一次），
   * 不每次查 settings 表。setMemberAdded、deleteSession 時清掉，下次整批重讀。
   */
  private addedCache: Map<string, MemberAdded> | null = null;
  /** `sessionAgent:*` 的快取（session 清單在熱路徑上）。setSessionAgent、deleteSession 時清掉。 */
  private agentCache: Map<string, AgentKind> | null = null;

  constructor(
    readonly db: Db,
    private readonly defaultListenAddress: string,
  ) {}

  // ── 使用者與登入 ──────────────────────────────────────
  countUsers(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  }

  /** 資料庫內單一敘述完成「沒有人才建立」，兩個同時的 setup 只有一個會成功。 */
  createFirstOwner(user: User, passwordHash: string): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO users (id, name, password_hash, role, locale)
         SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .run(user.id, user.name, passwordHash, user.role, user.locale);
    return result.changes === 1;
  }

  createUser(user: User, passwordHash: string): void {
    this.db
      .prepare('INSERT INTO users (id, name, password_hash, role, locale) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.name, passwordHash, user.role, user.locale);
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  userCredentials(name: string): { user: User; passwordHash: string } | null {
    const row = this.db.prepare('SELECT * FROM users WHERE name = ?').get(name) as
      UserRow | undefined;
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY name').all() as UserRow[]).map(toUser);
  }

  updateUser(id: string, patch: { locale?: User['locale']; passwordHash?: string }): void {
    if (patch.locale) {
      this.db.prepare('UPDATE users SET locale = ? WHERE id = ?').run(patch.locale, id);
    }
    if (patch.passwordHash) {
      this.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(patch.passwordHash, id);
    }
  }

  /** 同一個交易內檢查，同時刪兩個 owner 也不會把最後一個刪掉。 */
  deleteUser(id: string): 'ok' | 'not_found' | 'last_owner' {
    return this.db.transaction((): 'ok' | 'not_found' | 'last_owner' => {
      const user = this.getUser(id);
      if (!user) return 'not_found';
      if (user.role === 'owner') {
        const owners = this.db
          .prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'")
          .get();
        if ((owners as { n: number }).n <= 1) return 'last_owner';
      }
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return 'ok';
    })();
  }

  createAuthSession(tokenHash: string, userId: string, createdAt: string, expiresAt: string): void {
    this.db
      .prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, userId, createdAt, expiresAt);
  }

  authSessionUser(tokenHash: string, nowIso: string): User | null {
    const row = this.db
      .prepare(
        `SELECT u.* FROM auth_sessions a JOIN users u ON u.id = a.user_id
         WHERE a.token_hash = ? AND a.expires_at > ?`,
      )
      .get(tokenHash, nowIso) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** 回傳刪掉幾個登入（reset-password 指令要印出來）。 */
  deleteUserAuthSessions(userId: string, exceptTokenHash: string | null): number {
    return this.db
      .prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash IS NOT ?')
      .run(userId, exceptTokenHash).changes;
  }

  pruneExpired(nowIso: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(nowIso);
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').run(nowIso);
  }

  // ── 機器與配對 ────────────────────────────────────────
  insertPairingCode(
    codeHash: string,
    createdBy: string,
    createdAt: string,
    expiresAt: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(codeHash, createdBy, createdAt, expiresAt);
  }

  /** 配對碼換 token：核銷與建立機器在同一個交易，同時兌換只有一個成功。 */
  exchangePairingCode(
    codeHash: string,
    nowIso: string,
    machine: Omit<Machine, 'online' | 'lastSeenAt'>,
    tokenHash: string,
  ): boolean {
    return this.db.transaction((): boolean => {
      const used = this.db
        .prepare(
          `UPDATE pairing_codes SET used_at = ?
           WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .run(nowIso, codeHash, nowIso);
      if (used.changes !== 1) return false;
      this.db
        .prepare(
          `INSERT INTO machines (id, name, os, token_hash, capabilities, online)
           VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(machine.id, machine.name, machine.os, tokenHash, JSON.stringify(machine.capabilities));
      return true;
    })();
  }

  listMachines(): Machine[] {
    const rows = this.db.prepare('SELECT * FROM machines ORDER BY name').all() as MachineRow[];
    return rows.map(toMachine);
  }

  getMachine(id: string): Machine | null {
    const row = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as
      MachineRow | undefined;
    return row ? toMachine(row) : null;
  }

  machineByTokenHash(tokenHash: string): Machine | null {
    const row = this.db.prepare('SELECT * FROM machines WHERE token_hash = ?').get(tokenHash) as
      MachineRow | undefined;
    return row ? toMachine(row) : null;
  }

  renameMachine(id: string, name: string): void {
    this.db.prepare('UPDATE machines SET name = ? WHERE id = ?').run(name, id);
  }

  /** 機器名稱歸 hub（owner 可改名），hello 只更新系統資訊。 */
  machineHello(id: string, os: Machine['os'], caps: Machine['capabilities'], at: string): void {
    this.db
      .prepare(
        'UPDATE machines SET os = ?, capabilities = ?, online = 1, last_seen_at = ? WHERE id = ?',
      )
      .run(os, JSON.stringify(caps), at, id);
  }

  setMachineOffline(id: string, at: string): void {
    this.db.prepare('UPDATE machines SET online = 0, last_seen_at = ? WHERE id = ?').run(at, id);
  }

  touchMachine(id: string, at: string): void {
    this.db.prepare('UPDATE machines SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  deleteMachine(id: string): void {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  }

  // ── Session ──────────────────────────────────────────
  insertSession(session: Session, pendingSpec: SessionSpec | null): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, machine_id, project_id, name, cwd, branch, worktree_path,
           permission_mode, model, account_profile, status, status_detail, claude_session_id,
           last_lines, last_output_at, status_since, context_tokens, created_at, ended_at, archived,
           archived_at, pending_spec, context_window, repo_root, repo_common_dir, read_only,
           auto_continue, dispatched_by, zone_id)
         VALUES (@id, @machineId, @projectId, @name, @cwd, @branch, @worktreePath,
           @permissionMode, @model, @accountProfile, @status, @statusDetail, @claudeSessionId,
           @lastLines, @lastOutputAt, @statusSince, @contextTokens, @createdAt, @endedAt, @archived,
           @archivedAt, @pendingSpec, @contextWindow, @repoRoot, @repoCommonDir, @readOnly,
           @autoContinue, @dispatchedBy, @zoneId)`,
      )
      .run({
        ...session,
        autoContinue: session.autoContinue ? JSON.stringify(session.autoContinue) : null,
        lastLines: JSON.stringify(session.lastLines),
        archived: session.archived ? 1 : 0,
        readOnly: session.readOnly ? 1 : 0,
        pendingSpec: pendingSpec ? JSON.stringify(pendingSpec) : null,
      });
  }

  updateSession(session: Session): void {
    this.db
      .prepare(
        `UPDATE sessions SET project_id = @projectId, name = @name, cwd = @cwd, branch = @branch,
           worktree_path = @worktreePath, status = @status, status_detail = @statusDetail,
           claude_session_id = @claudeSessionId, last_lines = @lastLines,
           last_output_at = @lastOutputAt, status_since = @statusSince,
           context_tokens = @contextTokens, ended_at = @endedAt, archived = @archived,
           archived_at = @archivedAt, context_window = @contextWindow, repo_root = @repoRoot,
           repo_common_dir = @repoCommonDir, auto_continue = @autoContinue, zone_id = @zoneId
         WHERE id = @id`,
      )
      .run({
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        cwd: session.cwd,
        branch: session.branch,
        worktreePath: session.worktreePath,
        status: session.status,
        statusDetail: session.statusDetail,
        claudeSessionId: session.claudeSessionId,
        lastLines: JSON.stringify(session.lastLines),
        lastOutputAt: session.lastOutputAt,
        statusSince: session.statusSince,
        contextTokens: session.contextTokens,
        endedAt: session.endedAt,
        archived: session.archived ? 1 : 0,
        archivedAt: session.archivedAt,
        contextWindow: session.contextWindow,
        repoRoot: session.repoRoot,
        repoCommonDir: session.repoCommonDir,
        autoContinue: session.autoContinue ? JSON.stringify(session.autoContinue) : null,
        zoneId: session.zoneId,
      });
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  /** 資料列轉成 Session，補上存在 settings 表的 agent（只有 Codex 有）。 */
  private toSession = (row: SessionRow): Session => {
    const session = toSession(row);
    const agent = this.allAgents().get(row.id);
    return agent ? { ...session, agent } : session;
  };

  private allAgents(): Map<string, AgentKind> {
    if (this.agentCache) return this.agentCache;
    const out = new Map<string, AgentKind>();
    const rows = this.db
      .prepare(`SELECT key, value FROM settings WHERE key LIKE '${SESSION_AGENT_PREFIX}%'`)
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      const parsed = AgentKind.safeParse(safeJson(row.value));
      if (parsed.success) out.set(row.key.slice(SESSION_AGENT_PREFIX.length), parsed.data);
    }
    this.agentCache = out;
    return out;
  }

  /** 記下 session 跑的 CLI；Claude Code 是預設值，不寫。 */
  setSessionAgent(sessionId: string, agent: AgentKind): void {
    if (agent === 'claude') {
      this.db
        .prepare('DELETE FROM settings WHERE key = ?')
        .run(`${SESSION_AGENT_PREFIX}${sessionId}`);
    } else {
      this.setRaw(`${SESSION_AGENT_PREFIX}${sessionId}`, agent);
    }
    this.agentCache = null;
  }

  sessionMachineId(id: string): string | null {
    const row = this.db.prepare('SELECT machine_id FROM sessions WHERE id = ?').get(id) as
      { machine_id: string } | undefined;
    return row?.machine_id ?? null;
  }

  listSessions(archived?: boolean): Session[] {
    const rows =
      archived === undefined
        ? this.db.prepare('SELECT * FROM sessions ORDER BY created_at, rowid').all()
        : this.db
            .prepare('SELECT * FROM sessions WHERE archived = ? ORDER BY created_at, rowid')
            .all(archived ? 1 : 0);
    return (rows as SessionRow[]).map(this.toSession);
  }

  /**
   * 永久刪除（CONTRACTS §9.4）：events、layouts、團隊成員、從它出發的交接規則由外鍵 CASCADE；
   * 指向它的規則另外刪；audit 保留。
   */
  deleteSession(id: string): boolean {
    return this.db.transaction(() => {
      // 指向它的交接規則沒有外鍵可 CASCADE，一起刪掉，不留懸空的目標。
      this.db
        .prepare("DELETE FROM handoff_rules WHERE json_extract(action, '$.toSessionId') = ?")
        .run(id);
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`${MEMBER_ADDED_PREFIX}${id}`);
      this.addedCache = null;
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`${SESSION_AGENT_PREFIX}${id}`);
      this.agentCache = null;
      return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes === 1;
    })();
  }

  /** 同一台機器、同一個 cwd 的其他 session（不論是否封存）：hook 設定是共用的。 */
  countSessionsSharingCwd(machineId: string, cwd: string, exceptId: string): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM sessions WHERE machine_id = ? AND cwd = ? AND id != ?')
      .get(machineId, cwd, exceptId) as { n: number };
    return row.n;
  }

  /** 同機器另一個 session 用同一個 worktree，或 cwd 在這個 worktree 底下（§9.6）。 */
  countSessionsInWorktree(machineId: string, worktreePath: string, exceptId: string): number {
    // 不用 LIKE：路徑裡的 % 與 _ 會被當萬用字元。
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM sessions WHERE machine_id = @machineId AND id != @exceptId
           AND (worktree_path = @wt OR cwd = @wt
             OR substr(cwd, 1, length(@wt) + 1) = @wt || '/')`,
      )
      .get({ machineId, exceptId, wt: worktreePath }) as { n: number };
    return row.n;
  }

  /**
   * 同機器、同帳號（accountProfile，null 與空字串視為同一個）另一個 session 記著同一段對話。
   * id 不分大小寫：macOS 檔案系統不分大小寫，大寫 id 指到同一個 jsonl。
   */
  countSessionsSharingClaudeId(
    machineId: string,
    accountProfile: string | null,
    claudeSessionId: string,
    exceptId: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM sessions WHERE machine_id = ? AND id != ?
           AND lower(claude_session_id) = lower(?) AND coalesce(account_profile, '') = ?`,
      )
      .get(machineId, exceptId, claudeSessionId, accountProfile ?? '') as { n: number };
    return row.n;
  }

  listMachineSessions(machineId: string): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE machine_id = ? ORDER BY created_at, rowid')
      .all(machineId) as SessionRow[];
    return rows.map(this.toSession);
  }

  /** 佔用併發名額的 session：還活著、不在排隊、使用者沒標完成。 */
  countActiveSessions(): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM sessions WHERE ended_at IS NULL AND status NOT IN ('queued', 'done')",
      )
      .get() as { n: number };
    return row.n;
  }

  /** 排隊中的 session，先進先出（進入排隊的時間）。 */
  queuedSessions(): { session: Session; spec: SessionSpec }[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status = 'queued' ORDER BY status_since, rowid")
      .all() as SessionRow[];
    return rows.flatMap((row) =>
      row.pending_spec
        ? [{ session: this.toSession(row), spec: JSON.parse(row.pending_spec) as SessionSpec }]
        : [],
    );
  }

  setPendingSpec(id: string, spec: SessionSpec | null): void {
    this.db
      .prepare('UPDATE sessions SET pending_spec = ? WHERE id = ?')
      .run(spec ? JSON.stringify(spec) : null, id);
  }

  preOfflineStatus(id: string): SessionStatus | null {
    const row = this.db.prepare('SELECT pre_offline_status FROM sessions WHERE id = ?').get(id) as
      { pre_offline_status: SessionStatus | null } | undefined;
    return row?.pre_offline_status ?? null;
  }

  setPreOfflineStatus(id: string, status: SessionStatus | null): void {
    this.db.prepare('UPDATE sessions SET pre_offline_status = ? WHERE id = ?').run(status, id);
  }

  /** 派工成員手上還沒回報結果的工作（CONTRACTS §11）；hub 自己寫的 JSON，讀不懂就當沒有。 */
  dispatchWork(id: string): DispatchWork | null {
    const row = this.db.prepare('SELECT dispatch_work FROM sessions WHERE id = ?').get(id) as
      { dispatch_work: string | null } | undefined;
    if (!row?.dispatch_work) return null;
    try {
      const parsed = DispatchWork.safeParse(JSON.parse(row.dispatch_work));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  setDispatchWork(id: string, work: DispatchWork | null): void {
    this.db
      .prepare('UPDATE sessions SET dispatch_work = ? WHERE id = ?')
      .run(work ? JSON.stringify(work) : null, id);
  }

  /** 由 callerId 用 spawn_member 開的 session（含已結束、已封存的；呼叫端自己篩）。 */
  listDispatchedBy(callerId: string): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE dispatched_by = ? ORDER BY created_at, rowid')
      .all(callerId) as SessionRow[];
    return rows.map(this.toSession);
  }

  /** 回傳 false 表示 id 已存在（daemon 重送）。 */
  insertEvent(event: SessionEvent): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO session_events (id, session_id, type, payload, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(event.id, event.sessionId, event.type, JSON.stringify(event.payload), event.at);
    return result.changes === 1;
  }

  /** 最新的 limit 筆，時間由舊到新。 */
  listEvents(sessionId: string, limit = 1000): SessionEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM session_events WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
      )
      .all(sessionId, limit) as {
      id: string;
      session_id: string;
      type: string;
      payload: string;
      at: string;
    }[];
    return rows.reverse().map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      payload: JSON.parse(r.payload) as SessionEvent['payload'],
      at: r.at,
    }));
  }

  // ── 專案 ─────────────────────────────────────────────
  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
  }

  getProject(id: string): Project | null {
    return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project) ?? null;
  }

  upsertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, color) VALUES (@id, @name, @color)
         ON CONFLICT (id) DO UPDATE SET name = @name, color = @color`,
      )
      .run(p);
  }

  deleteProject(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes === 1;
  }

  sessionIdsInProject(id: string): string[] {
    const rows = this.db.prepare('SELECT id FROM sessions WHERE project_id = ?').all(id);
    return (rows as { id: string }[]).map((r) => r.id);
  }

  // ── 版面 ─────────────────────────────────────────────
  listLayouts(userId: string, workspace: string): Layout[] {
    const rows = this.db
      .prepare('SELECT * FROM layouts WHERE user_id = ? AND workspace = ?')
      .all(userId, workspace) as {
      workspace: string;
      session_id: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }[];
    return rows.map((r) => ({
      workspace: r.workspace,
      sessionId: r.session_id,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    }));
  }

  /** PUT 語意：body 提到的每個 workspace 整批取代；任何一筆失敗就全部不動。 */
  replaceLayouts(userId: string, layouts: Layout[]): void {
    this.db.transaction(() => {
      const clear = this.db.prepare('DELETE FROM layouts WHERE user_id = ? AND workspace = ?');
      for (const workspace of new Set(layouts.map((l) => l.workspace)))
        clear.run(userId, workspace);
      const insert = this.db.prepare(
        `INSERT INTO layouts (id, user_id, workspace, session_id, x, y, w, h)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, workspace, session_id)
         DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h`,
      );
      for (const l of layouts) {
        insert.run(randomUUID(), userId, l.workspace, l.sessionId, l.x, l.y, l.w, l.h);
      }
    })();
  }

  /** 在這個版面組存過座標的使用者。 */
  layoutUserIds(workspace: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT user_id FROM layouts WHERE workspace = ? ORDER BY user_id')
      .all(workspace) as { user_id: string }[];
    return rows.map((r) => r.user_id);
  }

  /** 把幾張卡一起平移（工作區移入時排到右側空白）。 */
  shiftLayouts(
    userId: string,
    workspace: string,
    sessionIds: readonly string[],
    dx: number,
    dy: number,
  ): void {
    const update = this.db.prepare(
      'UPDATE layouts SET x = x + ?, y = y + ? WHERE user_id = ? AND workspace = ? AND session_id = ?',
    );
    this.db.transaction(() => {
      for (const id of sessionIds) update.run(dx, dy, userId, workspace, id);
    })();
  }

  // ── 便利貼 ───────────────────────────────────────────
  listNotes(zoneId: string): Note[] {
    const rows = this.db.prepare('SELECT * FROM notes WHERE zone_id = ?').all(zoneId) as NoteRow[];
    return rows.map(toNote);
  }

  getNote(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  upsertNote(n: Note): void {
    this.db
      .prepare(
        `INSERT INTO notes (id, zone_id, x, y, text, color)
         VALUES (@id, @zoneId, @x, @y, @text, @color)
         ON CONFLICT (id) DO UPDATE SET zone_id = @zoneId, x = @x, y = @y, text = @text,
           color = @color`,
      )
      .run(n);
  }

  // ── 工作區（P2 項目二；程式內叫 zone，和 layouts.workspace 分開） ─────
  listZones(): Zone[] {
    const rows = this.db
      .prepare('SELECT * FROM zones ORDER BY position, created_at, rowid')
      .all() as {
      id: string;
      name: string;
      created_at: string;
      position: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      position: r.position,
    }));
  }

  /**
   * 沒指定工作區時用哪一個：排第一個的工作區。「主要」只要不是最後一個就能刪，所以不能寫死它的 id。
   * 至少一定有一個（最後一個不能刪）。
   */
  defaultZoneId(): string {
    return this.listZones()[0]?.id ?? DEFAULT_ZONE_ID;
  }

  countNotes(zoneId: string): number {
    return (
      this.db.prepare('SELECT count(*) AS n FROM notes WHERE zone_id = ?').get(zoneId) as {
        n: number;
      }
    ).n;
  }

  getZone(id: string): Zone | null {
    return this.listZones().find((z) => z.id === id) ?? null;
  }

  insertZone(input: { id: string; name: string; createdAt: string }): Zone {
    const row = this.db
      .prepare(
        `INSERT INTO zones (id, name, created_at, position)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM zones))
         RETURNING position`,
      )
      .get(input.id, input.name, input.createdAt) as { position: number };
    return { ...input, position: row.position };
  }

  renameZone(id: string, name: string): boolean {
    return this.db.prepare('UPDATE zones SET name = ? WHERE id = ?').run(name, id).changes === 1;
  }

  /**
   * 工作區裡擋住刪除的東西：團隊數，與單獨 session 數（沒封存、不是任何團隊成員的）。
   * 封存的 session、團隊成員那欄（被忽略）、便利貼不算，刪除時搬到 fallback。
   */
  zoneContents(id: string): { teams: number; sessions: number } {
    const teams = this.db.prepare('SELECT count(*) AS n FROM teams WHERE zone_id = ?').get(id) as {
      n: number;
    };
    const sessions = this.db
      .prepare(
        `SELECT count(*) AS n FROM sessions WHERE zone_id = ? AND archived = 0
           AND id NOT IN (SELECT session_id FROM team_members)`,
      )
      .get(id) as { n: number };
    return { teams: teams.n, sessions: sessions.n };
  }

  /** 刪除工作區：剩下不擋刪除的（封存的 session、成員那欄、便利貼）先搬到 fallback，同一個交易。 */
  deleteZone(id: string, fallback: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET zone_id = ? WHERE zone_id = ?').run(fallback, id);
      this.db.prepare('UPDATE notes SET zone_id = ? WHERE zone_id = ?').run(fallback, id);
      return this.db.prepare('DELETE FROM zones WHERE id = ?').run(id).changes === 1;
    })();
  }

  /** 換一個 session 的工作區（離開團隊、卡片選單「移到工作區」）。 */
  setSessionZone(id: string, zoneId: string): void {
    this.db.prepare('UPDATE sessions SET zone_id = ? WHERE id = ?').run(zoneId, id);
  }

  /** 這個 session 是哪些團隊的成員（依團隊名稱）。 */
  teamsOfSession(sessionId: string): Team[] {
    const rows = this.db
      .prepare(
        `SELECT teams.* FROM teams JOIN team_members ON team_members.team_id = teams.id
         WHERE team_members.session_id = ? ORDER BY teams.name`,
      )
      .all(sessionId) as TeamRow[];
    return rows.map(toTeam);
  }

  deleteNote(id: string): boolean {
    return this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes === 1;
  }

  // ── 範本 ─────────────────────────────────────────────
  listTemplates(): Template[] {
    const rows = this.db.prepare('SELECT * FROM templates ORDER BY name').all() as {
      id: string;
      name: string;
      config: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      config: JSON.parse(r.config) as Template['config'],
    }));
  }

  getTemplate(id: string): Template | null {
    return this.listTemplates().find((t) => t.id === id) ?? null;
  }

  upsertTemplate(t: Template): void {
    this.db
      .prepare(
        `INSERT INTO templates (id, name, config) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, config = excluded.config`,
      )
      .run(t.id, t.name, JSON.stringify(t.config));
  }

  deleteTemplate(id: string): boolean {
    return this.db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes === 1;
  }

  // ── 團隊（交接引擎是 Phase 3，這裡只有 CRUD）────────
  /** 有全隊暫停／停止記錄的團隊附上 hold（CONTRACTS §17）。 */
  listTeams(): Team[] {
    const holds = this.teamHolds();
    return (this.db.prepare('SELECT * FROM teams ORDER BY name').all() as TeamRow[]).map((r) =>
      withHold(toTeam(r), holds.get(r.id)),
    );
  }

  getTeam(id: string): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
    return row ? withHold(toTeam(row), this.getTeamHold(id) ?? undefined) : null;
  }

  /** 讀不懂的記錄（理論上不會）當沒有：按鈕回到「全隊暫停／停止」，不能讓團隊讀不出來。 */
  getTeamHold(teamId: string): TeamHold | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`${TEAM_HOLD_PREFIX}${teamId}`) as { value: string } | undefined;
    return row ? parseTeamHold(row.value) : null;
  }

  setTeamHold(teamId: string, hold: TeamHold | null): void {
    if (hold === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`${TEAM_HOLD_PREFIX}${teamId}`);
      return;
    }
    this.setRaw(`${TEAM_HOLD_PREFIX}${teamId}`, hold);
  }

  private teamHolds(): Map<string, TeamHold> {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE 'teamHold:%'")
      .all() as { key: string; value: string }[];
    const holds = new Map<string, TeamHold>();
    for (const r of rows) {
      const hold = parseTeamHold(r.value);
      if (hold) holds.set(r.key.slice(TEAM_HOLD_PREFIX.length), hold);
    }
    return holds;
  }

  upsertTeam(t: Team): void {
    this.db
      .prepare(
        `INSERT INTO teams (id, name, goal, done_criteria, color, context_md, phase, task_auto,
           zone_id)
         VALUES (@id, @name, @goal, @doneCriteria, @color, @contextMd, @phase, @taskAuto, @zoneId)
         ON CONFLICT (id) DO UPDATE SET name = @name, goal = @goal, done_criteria = @doneCriteria,
           color = @color, context_md = @contextMd, phase = @phase, task_auto = @taskAuto,
           zone_id = @zoneId`,
      )
      .run({
        id: t.id,
        name: t.name,
        goal: t.goal,
        doneCriteria: t.doneCriteria,
        color: t.color,
        contextMd: t.contextMd,
        phase: t.phase ?? null,
        taskAuto: t.taskAuto ? 1 : 0,
        zoneId: t.zoneId,
      });
  }

  deleteTeam(id: string): boolean {
    this.setTeamHold(id, null);
    return this.db.prepare('DELETE FROM teams WHERE id = ?').run(id).changes === 1;
  }

  listTeamMembers(teamId: string): TeamMember[] {
    const rows = this.db.prepare('SELECT * FROM team_members WHERE team_id = ?').all(teamId) as {
      team_id: string;
      session_id: string;
      role: TeamMember['role'];
      kind: TeamMember['kind'] | null;
    }[];
    const added = this.membersAdded(rows.map((r) => r.session_id));
    return rows.map((r) => {
      const by = added.get(r.session_id);
      return {
        teamId: r.team_id,
        sessionId: r.session_id,
        role: r.role,
        ...(r.kind ? { kind: r.kind } : {}),
        ...(by ? { added: by } : {}),
      };
    });
  }

  /** 隊長新增成員的記錄（誰加的、理由）。讀不懂的當沒有。整批讀一次後快取。 */
  private membersAdded(sessionIds: readonly string[]): Map<string, MemberAdded> {
    const out = new Map<string, MemberAdded>();
    if (sessionIds.length === 0) return out;
    const all = this.allMembersAdded();
    for (const id of sessionIds) {
      const added = all.get(id);
      if (added) out.set(id, added);
    }
    return out;
  }

  private allMembersAdded(): Map<string, MemberAdded> {
    if (this.addedCache) return this.addedCache;
    const out = new Map<string, MemberAdded>();
    const rows = this.db
      .prepare(`SELECT key, value FROM settings WHERE key LIKE '${MEMBER_ADDED_PREFIX}%'`)
      .all() as { key: string; value: string }[];
    for (const row of rows) {
      try {
        const parsed = MemberAdded.safeParse(JSON.parse(row.value));
        if (parsed.success) out.set(row.key.slice(MEMBER_ADDED_PREFIX.length), parsed.data);
      } catch {
        // 壞掉的就當沒有。
      }
    }
    this.addedCache = out;
    return out;
  }

  setMemberAdded(sessionId: string, added: MemberAdded): void {
    this.setRaw(`${MEMBER_ADDED_PREFIX}${sessionId}`, added);
    this.addedCache = null;
  }

  /** 團隊動態，新的在前。讀不懂的當沒有。 */
  listTeamActivity(): TeamActivity[] {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(TEAM_ACTIVITY_KEY) as { value: string } | undefined;
    if (!row) return [];
    try {
      const parsed = z.array(TeamActivity).safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  saveTeamActivity(items: readonly TeamActivity[]): void {
    this.setRaw(TEAM_ACTIVITY_KEY, items.slice(0, TEAM_ACTIVITY_KEEP));
  }

  upsertTeamMember(m: TeamMember): void {
    this.db
      .prepare(
        `INSERT INTO team_members (team_id, session_id, role, kind) VALUES (?, ?, ?, ?)
         ON CONFLICT (team_id, session_id) DO UPDATE SET role = excluded.role, kind = excluded.kind`,
      )
      .run(m.teamId, m.sessionId, m.role, m.kind ?? null);
  }

  deleteTeamMember(teamId: string, sessionId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM team_members WHERE team_id = ? AND session_id = ?')
      .run(teamId, sessionId);
    return result.changes === 1;
  }

  listTasks(teamId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE team_id = ? ORDER BY rowid')
      .all(teamId) as TaskRow[];
    return rows.map(toTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  /** 取用團隊的下一個任務編號：刪掉的編號不再使用，免得舊的完成標記對到新任務。 */
  takeTaskNumber(teamId: string): number {
    const row = this.db
      .prepare(
        `UPDATE teams SET task_seq = MAX(task_seq,
           (SELECT COALESCE(MAX(number), 0) FROM tasks WHERE team_id = @teamId)) + 1
         WHERE id = @teamId RETURNING task_seq AS n`,
      )
      .get({ teamId }) as { n: number } | undefined;
    if (!row) throw new Error(`unknown team ${teamId}`);
    return row.n;
  }

  upsertTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, team_id, title, owner_session_id, "column", number, reject_count,
           needs_user, reviewer_session_id, auto)
         VALUES (@id, @teamId, @title, @ownerSessionId, @column, @number, @rejectCount,
           @needsUser, @reviewerSessionId, @auto)
         ON CONFLICT (id) DO UPDATE SET title = @title, owner_session_id = @ownerSessionId,
           "column" = @column, reject_count = @rejectCount, needs_user = @needsUser,
           reviewer_session_id = @reviewerSessionId, auto = @auto`,
      )
      .run({
        ...t,
        needsUser: t.needsUser ? 1 : 0,
        auto: t.auto === null ? null : JSON.stringify(t.auto),
      });
  }

  deleteTask(id: string): boolean {
    return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes === 1;
  }

  listRules(teamId: string): HandoffRule[] {
    const rows = this.db
      .prepare('SELECT * FROM handoff_rules WHERE team_id = ? ORDER BY rowid')
      .all(teamId) as RuleRow[];
    return rows.map(toRule);
  }

  getRule(id: string): HandoffRule | null {
    const row = this.db.prepare('SELECT * FROM handoff_rules WHERE id = ?').get(id) as
      RuleRow | undefined;
    return row ? toRule(row) : null;
  }

  upsertRule(r: HandoffRule): void {
    this.db
      .prepare(
        `INSERT INTO handoff_rules (id, team_id, from_session_id, "trigger", action, enabled)
         VALUES (@id, @teamId, @fromSessionId, @trigger, @action, @enabled)
         ON CONFLICT (id) DO UPDATE SET from_session_id = @fromSessionId, "trigger" = @trigger,
           action = @action, enabled = @enabled`,
      )
      .run({ ...r, action: JSON.stringify(r.action), enabled: r.enabled ? 1 : 0 });
  }

  /** 封存時暫停從它出發或指向它的交接規則，回傳實際關掉的條數（本來就關的不算）。 */
  disableRulesTouching(sessionId: string): number {
    return this.db
      .prepare(
        `UPDATE handoff_rules SET enabled = 0
         WHERE enabled = 1 AND (from_session_id = ? OR json_extract(action, '$.toSessionId') = ?)`,
      )
      .run(sessionId, sessionId).changes;
  }

  deleteRule(id: string): boolean {
    return this.db.prepare('DELETE FROM handoff_rules WHERE id = ?').run(id).changes === 1;
  }

  // ── 進度卡（P3 項目一，schema v10）────────────────────
  /** 一張卡（沒有自動事實；事實由 progress.ts 算）。owner 是團隊或單獨 session。 */
  getProgress(owner: ProgressOwner): StoredProgress | null {
    const row = (
      'teamId' in owner
        ? this.db.prepare('SELECT * FROM progress_cards WHERE team_id = ?').get(owner.teamId)
        : this.db.prepare('SELECT * FROM progress_cards WHERE session_id = ?').get(owner.sessionId)
    ) as ProgressRow | undefined;
    return row ? toProgress(row) : null;
  }

  listProgress(): StoredProgress[] {
    const rows = this.db
      .prepare('SELECT * FROM progress_cards ORDER BY updated_at DESC, rowid')
      .all() as ProgressRow[];
    return rows.map(toProgress);
  }

  /** 新增或整張改寫（id 已存在就改）。 */
  saveProgress(card: StoredProgress): void {
    this.db
      .prepare(
        `INSERT INTO progress_cards (id, team_id, session_id, status, next, blockers, gm_notes, revision,
           locked, updated_at, updated_by_kind, updated_by_id, field_revisions)
         VALUES (@id, @teamId, @sessionId, @status, @next, @blockers, @gmNotes, @revision, @locked,
           @updatedAt, @updatedByKind, @updatedById, @fieldRevisions)
         ON CONFLICT (id) DO UPDATE SET status = @status, next = @next, blockers = @blockers,
           gm_notes = @gmNotes, revision = @revision, locked = @locked, updated_at = @updatedAt,
           updated_by_kind = @updatedByKind, updated_by_id = @updatedById,
           field_revisions = @fieldRevisions`,
      )
      .run({
        id: card.id,
        teamId: card.teamId,
        sessionId: card.sessionId,
        ...card.fields,
        revision: card.revision,
        locked: card.locked ? 1 : 0,
        updatedAt: card.updatedAt,
        updatedByKind: card.updatedByKind,
        updatedById: card.updatedById,
        fieldRevisions: JSON.stringify(card.fieldRevisions),
      });
  }

  /** 加一版歷史，並把這張卡的歷史修剪到最新 keep 版。 */
  addProgressRevision(cardId: string, entry: StoredProgressRevision, keep: number): void {
    this.db
      .prepare(
        `INSERT INTO progress_revisions (id, card_id, revision, fields, by_kind, by_id, source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        cardId,
        entry.revision,
        JSON.stringify(entry.fields),
        entry.byKind,
        entry.byId,
        entry.source,
        entry.at,
      );
    this.db
      .prepare(
        `DELETE FROM progress_revisions WHERE card_id = ? AND revision NOT IN (
           SELECT revision FROM progress_revisions WHERE card_id = ? ORDER BY revision DESC LIMIT ?
         )`,
      )
      .run(cardId, cardId, keep);
  }

  /** 新到舊。 */
  listProgressRevisions(cardId: string): StoredProgressRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM progress_revisions WHERE card_id = ? ORDER BY revision DESC')
      .all(cardId) as ProgressRevisionRow[];
    return rows.map(toProgressRevision);
  }

  getProgressRevision(cardId: string, revision: number): StoredProgressRevision | null {
    const row = this.db
      .prepare('SELECT * FROM progress_revisions WHERE card_id = ? AND revision = ?')
      .get(cardId, revision) as ProgressRevisionRow | undefined;
    return row ? toProgressRevision(row) : null;
  }

  /** 這些 session 在 since 之後的 file.changed 路徑（新到舊，含重複；呼叫端去重）。 */
  recentFileEvents(
    sessionIds: readonly string[],
    since: string,
    limit: number,
  ): { sessionId: string; path: string }[] {
    if (sessionIds.length === 0) return [];
    const marks = sessionIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT session_id, payload FROM session_events
         WHERE session_id IN (${marks}) AND type = 'file.changed' AND at >= ?
         ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(...sessionIds, since, limit) as { session_id: string; payload: string }[];
    return rows.flatMap((r) => {
      const path = (JSON.parse(r.payload) as { path?: unknown }).path;
      return typeof path === 'string' ? [{ sessionId: r.session_id, path }] : [];
    });
  }

  /**
   * 這些 session 在 after 之後最後一次回合結束（hook Stop）的時間；沒有是 null。
   * 每個 session 各查一次：沿 (session_id, at) 索引從最新倒著找、有下限、找到第一筆就停，不掃整段歷史。
   */
  lastStopAt(sessionIds: readonly string[], after: string): string | null {
    const query = this.db.prepare(
      `SELECT at FROM session_events
       WHERE session_id = ? AND at > ? AND type = 'hook' AND json_extract(payload, '$.event') = 'Stop'
       ORDER BY at DESC LIMIT 1`,
    );
    let latest: string | null = null;
    for (const id of sessionIds) {
      const row = query.get(id, after) as { at: string } | undefined;
      if (row && (latest === null || row.at > latest)) latest = row.at;
    }
    return latest;
  }

  // ── 稽核 ─────────────────────────────────────────────
  insertAudit(entry: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO audit_log (id, user_id, session_id, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entry.id, entry.userId, entry.sessionId, entry.action, entry.detail, entry.at);
  }

  listAudit(filter: AuditFilter): AuditEntry[] {
    const { clause, args } = auditWhere(filter);
    const limit = filter.limit === undefined ? '' : 'LIMIT ?';
    if (filter.limit !== undefined) args.push(filter.limit);
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, rowid DESC ${limit}`)
      .all(...args) as AuditRow[];
    return rows.map(toAudit);
  }

  /** 匯出用：由舊到新逐筆讀，不一次載進記憶體；篩選同 listAudit，但不看 limit。 */
  *iterateAudit(filter: AuditFilter = {}): Generator<AuditEntry> {
    const { clause, args } = auditWhere(filter);
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY at, rowid`)
      .iterate(...args);
    for (const row of rows) yield toAudit(row as AuditRow);
  }

  /** 最舊的 limit 筆（要匯出再清的那批）。 */
  auditOlderThan(cutoff: string, limit: number): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE at < ? ORDER BY at, rowid LIMIT ?')
      .all(cutoff, limit) as AuditRow[];
    return rows.map(toAudit);
  }

  deleteAudit(ids: readonly string[]): void {
    const statement = this.db.prepare('DELETE FROM audit_log WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) statement.run(id);
    })();
  }

  /** 先依時間清，再把總量壓到 maxRows 以內。回傳刪了幾筆。 */
  pruneEvents(cutoff: string, maxRows: number): number {
    const byAge = this.db.prepare('DELETE FROM session_events WHERE at < ?').run(cutoff).changes;
    const byCount = this.db
      .prepare(
        `DELETE FROM session_events WHERE rowid IN (
           SELECT rowid FROM session_events ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(maxRows).changes;
    return byAge + byCount;
  }

  // ── 設定與 VAPID ──────────────────────────────────────
  getSettings(): Settings {
    // 用量細項（`usage:<機器>`）、成員新增記錄、團隊動態不是設定，不讀。
    const rows = this.db
      .prepare(
        `SELECT key, value FROM settings WHERE key NOT LIKE '${USAGE_KEY_PREFIX}%'
           AND key NOT LIKE '${MEMBER_ADDED_PREFIX}%' AND key != '${TEAM_ACTIVITY_KEY}'
           AND key NOT LIKE '${SESSION_AGENT_PREFIX}%'`,
      )
      .all() as {
      key: string;
      value: string;
    }[];
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
    // 未知的鍵（vapid）會被 schema 濾掉，絕不會出現在 API 回應。
    return Settings.parse({ ...DEFAULT_SETTINGS(this.defaultListenAddress), ...stored });
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) this.setRaw(key, value);
      }
    })();
    return this.getSettings();
  }

  /**
   * 發版與自動更新（CONTRACTS §21）用的 settings 表鍵：`release.*`、`machineChannel:<id>`、`machineRelease:<id>`。
   * 和 `teamHold:` 一樣不是 `Settings` 的欄位（getSettings 會被 schema 濾掉），不升 schema。讀不懂回 null。
   */
  getRawJson(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  setRawJson(key: string, value: unknown): void {
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.setRaw(key, value);
  }

  /** `since` 之後這些機器上進入 error 的 session 狀態事件數（canary 統計）。 */
  countErrorEvents(machineIds: readonly string[], since: string): number {
    if (machineIds.length === 0) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events e JOIN sessions s ON s.id = e.session_id
          WHERE e.type = 'status' AND json_extract(e.payload, '$.to') = 'error' AND e.at >= ?
            AND s.machine_id IN (${machineIds.map(() => '?').join(',')})`,
      )
      .get(since, ...machineIds) as { n: number };
    return row.n;
  }

  private setRaw(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  /**
   * 全部暫停的狀態（P2 項目三）。和 vapid 一樣是 settings 表裡 `Settings` 以外的鍵：getSettings 會濾掉，
   * `/api/settings` 讀不到也改不到。內容壞掉就當沒暫停（回 invalid: true 讓 hub 記 log）。
   */
  getBoardPause(): { pause: StoredBoardPause | null; invalid: boolean } {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(BOARD_PAUSE_KEY) as
      { value: string } | undefined;
    if (!row) return { pause: null, invalid: false };
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      return { pause: null, invalid: true };
    }
    if (raw === null) return { pause: null, invalid: false };
    const parsed = StoredBoardPause.safeParse(raw);
    return parsed.success ? { pause: parsed.data, invalid: false } : { pause: null, invalid: true };
  }

  setBoardPause(pause: StoredBoardPause | null): void {
    if (pause === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(BOARD_PAUSE_KEY);
      return;
    }
    this.setRaw(BOARD_PAUSE_KEY, pause);
  }

  /**
   * 每台機器最新一次的用量（總數＋細項，GM 2026-11-09）。存在 settings 表的 `usage:<機器 id>` 鍵，
   * 不升 schema：hub 重啟後、下一次掃描前也能顯示上次的。內容由呼叫端驗證，這裡只存取字串。
   */
  saveUsage(machineId: string, value: unknown): void {
    this.setRaw(`${USAGE_KEY_PREFIX}${machineId}`, value);
  }

  loadUsage(): { machineId: string; value: unknown }[] {
    const rows = this.db
      .prepare(`SELECT key, value FROM settings WHERE key LIKE '${USAGE_KEY_PREFIX}%'`)
      .all() as { key: string; value: string }[];
    const out: { machineId: string; value: unknown }[] = [];
    for (const row of rows) {
      try {
        out.push({
          machineId: row.key.slice(USAGE_KEY_PREFIX.length),
          value: JSON.parse(row.value),
        });
      } catch {
        // 壞掉的就當沒存過。
      }
    }
    return out;
  }

  deleteUsage(machineId: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(`${USAGE_KEY_PREFIX}${machineId}`);
  }

  /** 首次啟動才產生，之後沿用（換金鑰會讓所有訂閱失效）。 */
  ensureVapidKeys(generate: () => VapidKeys): VapidKeys {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get() as
      { value: string } | undefined;
    if (row) return JSON.parse(row.value) as VapidKeys;
    const keys = generate();
    this.setRaw('vapid', keys);
    return keys;
  }

  // ── 推播訂閱 ──────────────────────────────────────────
  upsertPushSubscription(userId: string, sub: PushSubscriptionRecord): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, keys) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys`,
      )
      .run(randomUUID(), userId, sub.endpoint, JSON.stringify(sub.keys));
  }

  deletePushSubscription(userId: string, endpoint: string): void {
    this.db
      .prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(userId, endpoint);
  }

  deletePushEndpoint(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  listPushSubscriptions(): PushSubscriptionRecord[] {
    const rows = this.db.prepare('SELECT endpoint, keys FROM push_subscriptions').all() as {
      endpoint: string;
      keys: string;
    }[];
    return rows.map((r) => ({
      endpoint: r.endpoint,
      keys: JSON.parse(r.keys) as PushSubscriptionRecord['keys'],
    }));
  }
}
