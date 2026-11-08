// SQLite 連線與 migration。版本號存在 PRAGMA user_version，只增不改。
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const migrations: string[] = [
  /* 1：初始結構。正式資料庫一開始是空的，這裡不放任何範例資料。 */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    locale TEXT NOT NULL
  );
  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    os TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    last_seen_at TEXT,
    online INTEGER NOT NULL DEFAULT 0,
    capabilities TEXT NOT NULL
  );
  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    permission_mode TEXT NOT NULL,
    model TEXT,
    account_profile TEXT,
    status TEXT NOT NULL,
    status_detail TEXT,
    claude_session_id TEXT,
    last_lines TEXT NOT NULL DEFAULT '[]',
    last_output_at TEXT,
    status_since TEXT NOT NULL,
    context_tokens INTEGER,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    pending_spec TEXT,
    pre_offline_status TEXT
  );
  CREATE INDEX sessions_machine ON sessions(machine_id);
  CREATE INDEX sessions_status ON sessions(status);
  CREATE TABLE session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX session_events_session ON session_events(session_id, at);
  CREATE TABLE layouts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    x REAL NOT NULL,
    y REAL NOT NULL,
    w REAL NOT NULL,
    h REAL NOT NULL,
    UNIQUE (user_id, workspace, session_id)
  );
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    text TEXT NOT NULL,
    color TEXT NOT NULL
  );
  CREATE INDEX notes_workspace ON notes(workspace);
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    done_criteria TEXT NOT NULL,
    color TEXT NOT NULL,
    context_md TEXT NOT NULL
  );
  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (team_id, session_id)
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    owner_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    "column" TEXT NOT NULL
  );
  CREATE INDEX tasks_team ON tasks(team_id);
  CREATE TABLE handoff_rules (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    from_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    "trigger" TEXT NOT NULL,
    action TEXT NOT NULL,
    enabled INTEGER NOT NULL
  );
  CREATE INDEX handoff_rules_team ON handoff_rules(team_id);
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL
  );
  -- 稽核紀錄不設外鍵：使用者或機器被移除後紀錄仍要留著。
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    session_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX audit_log_at ON audit_log(at);
  CREATE INDEX audit_log_session ON audit_log(session_id);
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /* 2：context 上限與 repo 身分，由 daemon 回報（§8-5 排隊、同 repo 建議 worktree 用）。 */ `
  ALTER TABLE sessions ADD COLUMN context_window INTEGER;
  ALTER TABLE sessions ADD COLUMN repo_root TEXT;
  ALTER TABLE sessions ADD COLUMN repo_common_dir TEXT;
  `,
  /* 3：封存時間（CONTRACTS §9）。之前封存的維持 null。 */ `
  ALTER TABLE sessions ADD COLUMN archived_at TEXT;
  `,
  /* 4：唯讀 session（建立時決定，daemon 拿掉改檔工具；團隊的只讀成員靠它）。舊資料都不是唯讀。 */ `
  ALTER TABLE sessions ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
  `,
  /*
   * 5：學術研究團隊（GM 2026-11-06）。teams.phase 是目前階段（null＝程式開發團隊），
   * team_members.kind 分開同是 worker 的實驗與寫作。舊資料都是 null。
   * 交接規則的 maxRounds、marker 放在既有的 action JSON 裡，不用改結構。
   */ `
  ALTER TABLE teams ADD COLUMN phase TEXT;
  ALTER TABLE team_members ADD COLUMN kind TEXT;
  `,
  /*
   * 6：任務自動執行（GM 2026-11-06）。teams.task_auto 是開關（舊團隊一律關）。
   * tasks.number 是團隊內的短編號，舊任務依建立順序補上（teams.task_seq 記發到哪，刪掉的不重發）；
   * reject_count、needs_user、reviewer_session_id、auto（最後一步，JSON）讓 hub 重啟後還看得到進度。
   * reviewer_session_id 不設外鍵：session 刪掉時留著舊 id 無害（送審前會重新確認是不是團隊的審查）。
   */ `
  ALTER TABLE teams ADD COLUMN task_auto INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE teams ADD COLUMN task_seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reject_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN needs_user INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reviewer_session_id TEXT;
  ALTER TABLE tasks ADD COLUMN auto TEXT;
  UPDATE tasks SET number = (
    SELECT COUNT(*) FROM tasks AS earlier
    WHERE earlier.team_id = tasks.team_id AND earlier.rowid <= tasks.rowid
  );
  UPDATE teams SET task_seq = (SELECT COUNT(*) FROM tasks WHERE tasks.team_id = teams.id);
  `,
  /*
   * 7：額度恢復後自動接續（GM 2026-11-06）。sessions.auto_continue 是 hub 寫的 JSON（`AutoContinue`），
   * 排定的時間存在這裡，hub 重啟後照樣會送。舊資料都是 null（沒排過）。
   */ `
  ALTER TABLE sessions ADD COLUMN auto_continue TEXT;
  `,
  /*
   * 8：session 派工（MCP 工具，GM 2026-11-06，CONTRACTS §11）。dispatched_by 是用 spawn_member 開它的 session
   * （不設外鍵：呼叫者刪掉後留著舊 id 無害，卡片找不到名字就不顯示）；dispatch_work 是 hub 寫的 JSON：
   * 這個成員手上還沒回報結果的那份工作（誰給的），回合結束送出結果就清掉，hub 重啟照樣會送。舊資料都是 null。
   */ `
  ALTER TABLE sessions ADD COLUMN dispatched_by TEXT;
  ALTER TABLE sessions ADD COLUMN dispatch_work TEXT;
  `,
];

export const SCHEMA_VERSION = migrations.length;

/**
 * 把資料庫升到 SCHEMA_VERSION。整段包在 BEGIN IMMEDIATE 裡、在交易內才讀 user_version：
 * 兩個行程（hub 服務與 reset-password）同時開同一個舊版資料庫時，後到的會等前一個升完，
 * 再讀到新版本號就什麼都不跑，不會重跑 ALTER TABLE 撞 duplicate column。
 * path 只用在「資料庫比程式新」的錯誤訊息裡找備份；沒給（或 :memory:）就不附還原提示。
 */
export function migrate(db: Db, path?: string): void {
  db.transaction(() => {
    const current = db.pragma('user_version', { simple: true }) as number;
    if (current > SCHEMA_VERSION) throw new Error(tooNewMessage(path, current));
    migrations.slice(current).forEach((sql, offset) => {
      db.exec(sql);
      db.pragma(`user_version = ${current + offset + 1}`);
    });
  }).immediate();
}

export interface OpenDatabaseOptions {
  /** 升級前備份的紀錄（含備份路徑）；沒給就印到 stdout，跟 hub 其他紀錄進同一個 log 檔。 */
  log?: (line: string) => void;
  /** 備份檔名用的時間；測試用。 */
  now?: () => Date;
  /** 實際做備份的函式；只有測試會換掉它（模擬備份失敗）。 */
  backup?: (db: Db, target: string) => void;
}

/**
 * 備份檔名：`hub.db.bak-YYYYMMDD-HHMMSS-v<舊版本>`，跟上架前手動 sqlite3 .backup 的命名一樣。
 * 時間是本機時間、檔名不帶時區：夏令時間結束那一小時或主機改過時區時，檔名順序可能跟實際先後不同。
 */
const BACKUP_PATTERN = /\.bak-(\d{8}-\d{6})(?:-\d+)?-v(\d+)$/;

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 線上備份：VACUUM INTO 是同步的、會拿一致的快照（含 WAL 裡還沒寫回的內容）。 */
function vacuumInto(db: Db, target: string): void {
  db.prepare('VACUUM INTO ?').run(target);
}

/**
 * 在跑 migration 之前把舊版資料庫備份到同資料夾。先用 0600 建空檔再讓 SQLite 寫進去，
 * 備份從頭到尾都不會被別人讀到（含密碼雜湊與 VAPID 私鑰）。失敗就刪掉自己建的半成品並丟錯，不升級。
 */
function backupBeforeMigrate(
  db: Db,
  path: string,
  version: number,
  options: OpenDatabaseOptions,
): string {
  const base = `${path}.bak-${stamp((options.now ?? (() => new Date()))())}`;
  let target = `${base}-v${version}`;
  // 只有自己用 'wx' 建出來的檔才可以刪：同名檔可能是別的行程（例如同一秒開同一個舊版資料庫的
  // reset-password）剛寫好的備份。檔名已被占用（EEXIST）就換下一個序號，不覆蓋也不刪別人的備份。
  let created = false;
  try {
    for (let n = 1; !created; n++) {
      target = n === 1 ? `${base}-v${version}` : `${base}-${n}-v${version}`;
      try {
        closeSync(openSync(target, 'wx', 0o600));
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    (options.backup ?? vacuumInto)(db, target);
    chmodSync(target, 0o600);
    // 確認備份真的能開、版本是舊版、內容沒有壞（例如寫到一半被截斷），才算數。
    const check = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const saved = check.pragma('user_version', { simple: true }) as number;
      if (saved !== version) throw new Error(`backup has schema v${saved}, expected v${version}`);
      const integrity = check.pragma('quick_check', { simple: true }) as string;
      if (integrity !== 'ok') throw new Error(`backup failed quick_check: ${integrity}`);
    } finally {
      check.close();
    }
  } catch (error) {
    if (created) rmSync(target, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not back up ${path} (schema v${version}) to ${target} before upgrading to v${SCHEMA_VERSION}: ${reason}. ` +
        'The database was not changed. Free disk space or fix permissions in that folder, then start the hub again.',
    );
  }
  return target;
}

/** 同資料夾最新的備份檔（看檔名裡的時間），只挑這版 hub 讀得了的版本；沒有就 null。 */
export function latestBackup(path: string, maxVersion = SCHEMA_VERSION): string | null {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, match: BACKUP_PATTERN.exec(name) }))
    .filter(
      (c): c is { name: string; match: RegExpExecArray } =>
        c.match !== null && Number(c.match[2]) <= maxVersion,
    )
    .sort((a, b) => {
      const byStamp = a.match[1]!.localeCompare(b.match[1]!);
      return byStamp !== 0
        ? byStamp
        : statSync(join(dir, a.name)).mtimeMs - statSync(join(dir, b.name)).mtimeMs;
    });
  const last = candidates.at(-1);
  return last ? join(dir, last.name) : null;
}

/** 「資料庫比程式新」的錯誤訊息（唯一來源）；有檔案路徑才去同資料夾找可還原的備份。 */
function tooNewMessage(path: string | undefined, current: number): string {
  const head = `Database schema v${current} is newer than this hub (v${SCHEMA_VERSION}). Upgrade the hub.`;
  if (path === undefined || path === ':memory:') return head;
  const backup = latestBackup(path);
  const restore = backup
    ? ` To go back to this version instead, stop the hub, copy ${backup} over ${path} ` +
      '(changes made after that backup are lost), then start this hub again.'
    : ` No backup readable by this hub (v${SCHEMA_VERSION} or older) was found next to ${path}.`;
  return `${head}${restore}`;
}

/** 資料庫含密碼雜湊與 VAPID 私鑰，資料夾與檔案都只給擁有者讀寫。 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Db {
  const inMemory = path === ':memory:';
  if (!inMemory) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // 要在 new Database 之前看：它會建出空檔，之後就分不出是不是新資料庫。
  const existed = !inMemory && existsSync(path);
  const db = new Database(path);
  try {
    if (!inMemory) chmodSync(path, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const current = db.pragma('user_version', { simple: true }) as number;
    if (current > SCHEMA_VERSION) throw new Error(tooNewMessage(path, current));
    // 新資料庫（user_version 0）沒東西可備份；已經是最新版也不用。
    if (existed && current > 0 && current < SCHEMA_VERSION) {
      const target = backupBeforeMigrate(db, path, current, options);
      (options.log ?? ((line: string) => console.log(line)))(
        `Backed up hub database (schema v${current}) to ${target} before upgrading to v${SCHEMA_VERSION}.`,
      );
    }
    migrate(db, path);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
