// SQLite 存取層。欄位 snake_case ↔ API camelCase 的轉換集中在這裡。
import { randomUUID } from 'node:crypto';
import {
  AUDIT_SYSTEM_USER,
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  Settings,
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
  type TeamMember,
  type Template,
  type User,
} from '@agent-board/protocol';
import type { Db } from './db';
import type { PushSubscriptionRecord, VapidKeys } from './push';

const DEFAULT_SETTINGS = (listenAddress: string): Settings => ({
  listenAddress,
  publicOrigin: null,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  dangerRules: [...DEFAULT_DANGER_RULES],
  quotaGuards: { denyReadPaths: [], maxConcurrentSessions: null, queueWhenRateLimited: true },
  notifications: { enabled: true, quietHours: null },
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
}

interface TaskRow {
  id: string;
  team_id: string;
  title: string;
  owner_session_id: string | null;
  column: Task['column'];
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
});

const toTeam = (r: TeamRow): Team => ({
  id: r.id,
  name: r.name,
  goal: r.goal,
  doneCriteria: r.done_criteria,
  color: r.color,
  contextMd: r.context_md,
  ...(r.phase ? { phase: r.phase } : {}),
});

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  teamId: r.team_id,
  title: r.title,
  ownerSessionId: r.owner_session_id,
  column: r.column,
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

export class Store {
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
           archived_at, pending_spec, context_window, repo_root, repo_common_dir, read_only)
         VALUES (@id, @machineId, @projectId, @name, @cwd, @branch, @worktreePath,
           @permissionMode, @model, @accountProfile, @status, @statusDetail, @claudeSessionId,
           @lastLines, @lastOutputAt, @statusSince, @contextTokens, @createdAt, @endedAt, @archived,
           @archivedAt, @pendingSpec, @contextWindow, @repoRoot, @repoCommonDir, @readOnly)`,
      )
      .run({
        ...session,
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
           repo_common_dir = @repoCommonDir
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
      });
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined;
    return row ? toSession(row) : null;
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
    return (rows as SessionRow[]).map(toSession);
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
    return rows.map(toSession);
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
        ? [{ session: toSession(row), spec: JSON.parse(row.pending_spec) as SessionSpec }]
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

  // ── 便利貼 ───────────────────────────────────────────
  listNotes(workspace: string): Note[] {
    return this.db.prepare('SELECT * FROM notes WHERE workspace = ?').all(workspace) as Note[];
  }

  getNote(id: string): Note | null {
    return (this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note) ?? null;
  }

  upsertNote(n: Note): void {
    this.db
      .prepare(
        `INSERT INTO notes (id, workspace, x, y, text, color)
         VALUES (@id, @workspace, @x, @y, @text, @color)
         ON CONFLICT (id) DO UPDATE SET workspace = @workspace, x = @x, y = @y, text = @text,
           color = @color`,
      )
      .run(n);
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
  listTeams(): Team[] {
    return (this.db.prepare('SELECT * FROM teams ORDER BY name').all() as TeamRow[]).map(toTeam);
  }

  getTeam(id: string): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
    return row ? toTeam(row) : null;
  }

  upsertTeam(t: Team): void {
    this.db
      .prepare(
        `INSERT INTO teams (id, name, goal, done_criteria, color, context_md, phase)
         VALUES (@id, @name, @goal, @doneCriteria, @color, @contextMd, @phase)
         ON CONFLICT (id) DO UPDATE SET name = @name, goal = @goal, done_criteria = @doneCriteria,
           color = @color, context_md = @contextMd, phase = @phase`,
      )
      .run({ ...t, phase: t.phase ?? null });
  }

  deleteTeam(id: string): boolean {
    return this.db.prepare('DELETE FROM teams WHERE id = ?').run(id).changes === 1;
  }

  listTeamMembers(teamId: string): TeamMember[] {
    const rows = this.db.prepare('SELECT * FROM team_members WHERE team_id = ?').all(teamId) as {
      team_id: string;
      session_id: string;
      role: TeamMember['role'];
      kind: TeamMember['kind'] | null;
    }[];
    return rows.map((r) => ({
      teamId: r.team_id,
      sessionId: r.session_id,
      role: r.role,
      ...(r.kind ? { kind: r.kind } : {}),
    }));
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

  upsertTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, team_id, title, owner_session_id, "column")
         VALUES (@id, @teamId, @title, @ownerSessionId, @column)
         ON CONFLICT (id) DO UPDATE SET title = @title, owner_session_id = @ownerSessionId,
           "column" = @column`,
      )
      .run(t);
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
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
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

  private setRaw(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
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
