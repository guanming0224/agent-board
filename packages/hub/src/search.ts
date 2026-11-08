// 全域搜尋的快速層（P3 §3，CONTRACTS §16）：只搜 hub SQLite 已有的資料，不碰 daemon、不送任何字。
// 每種資料是一個「來源」（QuickSearchSource）：進度卡（項目一）也是其中一個來源（progressSource）。
// 遮蔽模式開著時，整段文字先過 maskSecrets 再比對、擷取片段：金鑰不會被比對到、也不會出現在回應裡（§3.5、D9）。
// 深層（各台 daemon 搜對話紀錄與終端機畫面，③b）在 deepSearch.ts。
import {
  parseSearchTerms,
  makeSnippet,
  SEARCH_GROUP_LIMIT,
  SEARCH_GROUP_OF,
  SEARCH_GROUP_ORDER,
  SEARCH_SINCE_MS,
  SEARCH_TIMEOUT_MS,
  SEARCH_TOTAL_LIMIT,
  sessionWaitsForUser,
  type SearchField,
  type SearchGroup,
  type SearchGroupKind,
  type SearchItem,
  type SearchQuery,
  type SearchResults,
  type Session,
  type Team,
  type User,
} from '@agent-board/protocol';
import { maskSecrets } from './secretPatterns';
import type { Store } from './store';

/** 一次查詢的條件與狀態，傳給每個來源。 */
export interface SearchContext {
  /** 已拆好、轉小寫的詞（AND）。 */
  readonly terms: readonly string[];
  /** 時間範圍的起點（ISO）。只有有時間的來源（事件、audit）用。 */
  readonly since: string;
  /** 範圍內的 session（已依工作區與「含封存」篩過）。 */
  readonly sessions: ReadonlyMap<string, Session>;
  /** 範圍內的團隊。 */
  readonly teams: readonly Team[];
  /** owner 才看得到「GM 送出的指令」（和 audit 權限一致）。 */
  readonly owner: boolean;
  /** 每個來源最多回幾筆。 */
  readonly limit: number;
  /** 逾時了：來源要停下來，回已經找到的部分。 */
  expired(): boolean;
  /**
   * 來源因為 limit 停下、後面確定還有符合的（多看到一筆）時呼叫：結果標 partial、那一組標 capped。
   * 判斷方式：已有 limit 筆時又找到一筆就呼叫並停下。
   */
  truncated(kind: SearchItem['kind']): void;
  /** 比對並擷取片段（遮蔽模式開著時先遮蔽）；不符合回 null。 */
  match(text: string | null | undefined): Pick<SearchItem, 'snippet' | 'matchRanges'> | null;
}

/**
 * 一種可搜的資料。回傳的筆數不超過 ctx.limit；逾時就提早停；因 limit 停下而後面還有時呼叫 ctx.truncated。
 * 掃 SQLite 的查詢要在 WHERE 放 ALIVE（見下），並用 untilDeadline 包住 iterate：better-sqlite3 是同步的，
 * 只在 JS 端檢查逾時的話，一個「掃很多列卻沒有一列符合」的查詢會一路掃完、卡住整個 hub。
 */
export interface QuickSearchSource {
  readonly name: string;
  search(ctx: SearchContext, store: Store): SearchItem[];
}

// ── SQL 小工具 ──

/** LIKE 的萬用字元跳脫（ESCAPE '\'）。只是先篩，最後一律用 makeSnippet 在 JS 端確認。 */
const likeArg = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * SQL 先篩用的字：片語拆成單字（原文的空白可能是換行或好幾個空白，makeSnippet 會併成一個，LIKE 不會）。
 * SQLite 的 LIKE 只對 ASCII 不分大小寫；其他字元本來就沒有大小寫的居多，少數漏掉的就是漏掉（先篩只會少、不會多）。
 */
const sqlWords = (terms: readonly string[]) => [
  ...new Set(terms.flatMap((term) => term.split(' ')).filter((w) => w !== '')),
];

/**
 * 每個字一個 `expr LIKE ?`（AND）。json 不為 null 時再對原始 JSON 字串先篩一次：不用解析 JSON，快很多；
 * 會被 JSON 跳脫的字（引號、反斜線、控制字元）在原始字串裡長得不一樣，那些字跳過這一層。
 */
function likeAll(
  expr: string,
  terms: readonly string[],
  json: string | null = null,
): { sql: string; args: string[] } {
  const words = sqlWords(terms);
  const raw = json === null ? [] : words.filter((w) => !/["\\\u0000-\u001f]/.test(w));
  // 沒有英文字母的字（中文、數字、符號）沒有大小寫問題，用 instr：比 LIKE 逐字比對快很多。
  const cond = (target: string, w: string) =>
    /[a-z]/i.test(w)
      ? { sql: `${target} LIKE ? ESCAPE '\\'`, arg: likeArg(w) }
      : { sql: `instr(${target}, ?) > 0`, arg: w };
  const parts = [...raw.map((w) => cond(json!, w)), ...words.map((w) => cond(expr, w))];
  return { sql: parts.map((p) => p.sql).join(' AND '), args: parts.map((p) => p.arg) };
}

/** 範圍內 session id 的 JSON 陣列（給 json_each 用）。 */
const sessionIdsArg = (ctx: SearchContext) => JSON.stringify([...ctx.sessions.keys()]);

/**
 * 篩 session 的條件。前面的 `+` 讓 SQLite 不拿 (session_id, at) 索引：範圍內的 session 通常就是全部，
 * 用它等於掃整個時間範圍的所有事件；要用 v10 的 (type, at) 索引只掃那一種事件。
 */
const IN_SESSIONS = '+session_id IN (SELECT value FROM json_each(?))';

/**
 * 逾時檢查放進 SQL：每掃一列都會呼叫（不是 deterministic 函式，SQLite 不會只算一次），逾時就丟 SearchTimeout
 * 讓 SQLite 中止查詢。放在 WHERE 裡索引條件之後、LIKE 與 json_extract 之前，掃過但不符合的列也算得到。
 */
const ALIVE_FN = 'ab_search_alive';
const ALIVE = `${ALIVE_FN}()`;

/** SQL 裡的逾時檢查丟的錯；untilDeadline 接住它，當成「到這裡為止」。 */
export class SearchTimeout extends Error {
  constructor() {
    super('search timed out');
  }
}

/** 包住 statement.iterate：SQL 因逾時中止時安靜地停下，前面已經吐出的列照用。 */
function* untilDeadline<T>(rows: Iterable<T>): Generator<T> {
  try {
    yield* rows;
  } catch (error) {
    if (error instanceof SearchTimeout) return;
    throw error;
  }
}

/** 同上，給 .all() 用：逾時回 null。 */
function allUntilDeadline<T>(run: () => T[]): T[] | null {
  try {
    return run();
  } catch (error) {
    if (error instanceof SearchTimeout) return null;
    throw error;
  }
}

// ── 內建來源 ──

/** 相對 repo 的路徑：落在 repo（或 worktree、資料夾）底下就去掉前綴。 */
export function relativePath(session: Session, path: string): string {
  for (const base of [session.repoRoot, session.worktreePath, session.cwd]) {
    if (!base) continue;
    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/** 檔案改動（file.changed：只有 Edit／Write／MultiEdit／NotebookEdit 的路徑）。同一個 session 同一個檔一列，附次數。 */
export const fileSource: QuickSearchSource = {
  name: 'file',
  search(ctx, store) {
    // 先由新到舊掃（用 (type, at) 索引），收到 limit 個不同的（session, 檔案）就停；再只替這幾個算次數。
    // payload 只有 { path }（daemon 的 editedFilePath），同一個檔的 payload 字串一模一樣，直接拿它當鍵。
    const ids = sessionIdsArg(ctx);
    const like = likeAll("json_extract(payload, '$.path')", ctx.terms, 'payload');
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, payload, at FROM session_events
         WHERE type = 'file.changed' AND at >= ?
           AND ${ALIVE} AND ${IN_SESSIONS} AND ${like.sql}
         ORDER BY at DESC`,
      )
      .iterate(ctx.since, ids, ...like.args) as Iterable<{
      sessionId: string;
      payload: string;
      at: string;
    }>;
    const seen = new Set<string>();
    const found: { key: string; payload: string; item: SearchItem }[] = [];
    for (const row of untilDeadline(rows)) {
      if (ctx.expired()) break;
      const key = `${row.sessionId}\u0000${row.payload}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const session = ctx.sessions.get(row.sessionId);
      const path = (JSON.parse(row.payload) as { path?: unknown }).path;
      if (!session || typeof path !== 'string') continue;
      // 顯示相對路徑；詞只出現在被去掉的前綴裡（例如搜資料夾名）時改顯示完整路徑。
      const hit = ctx.match(relativePath(session, path)) ?? ctx.match(path);
      if (!hit) continue;
      if (found.length >= ctx.limit) {
        ctx.truncated('file');
        break;
      }
      found.push({
        key,
        payload: row.payload,
        item: {
          kind: 'file',
          sessionId: session.id,
          field: 'path',
          ...hit,
          at: row.at,
          machineId: session.machineId,
        },
      });
    }
    if (found.length === 0) return [];
    const counts = new Map<string, number>();
    // 次數只是附加資訊：這裡逾時就不附（畫面上不顯示次數），已找到的檔案照回。
    const countRows = allUntilDeadline(
      () =>
        store.db
          .prepare(
            `SELECT session_id AS sessionId, payload, COUNT(*) AS n FROM session_events
             WHERE type = 'file.changed' AND at >= ? AND ${ALIVE}
               AND payload IN (SELECT value FROM json_each(?)) AND ${IN_SESSIONS}
             GROUP BY session_id, payload`,
          )
          .all(
            ctx.since,
            JSON.stringify([...new Set(found.map((f) => f.payload))]),
            JSON.stringify([...new Set(found.map((f) => f.item.sessionId))]),
          ) as { sessionId: string; payload: string; n: number }[],
    );
    if (countRows === null) return found.map((f) => f.item);
    for (const row of countRows) counts.set(`${row.sessionId}\u0000${row.payload}`, row.n);
    return found.map((f) => ({ ...f.item, count: counts.get(f.key) ?? 1 }));
  },
};

/** session 本身的欄位：名稱、資料夾、分支、worktree 路徑、最後 4 行。每個 session 最多一列（第一個命中的欄位）。 */
export const sessionFieldSource: QuickSearchSource = {
  name: 'sessionFields',
  search(ctx) {
    const items: SearchItem[] = [];
    for (const session of ctx.sessions.values()) {
      if (ctx.expired()) break;
      const fields: [SearchField, string | null][] = [
        ['name', session.name],
        ['branch', session.branch],
        ['cwd', session.cwd],
        ['worktree', session.worktreePath],
        ['lastLines', session.lastLines.join('\n')],
      ];
      for (const [field, text] of fields) {
        const hit = ctx.match(text);
        if (!hit) continue;
        if (items.length >= ctx.limit) {
          ctx.truncated('session');
          return items;
        }
        items.push({
          kind: 'session',
          sessionId: session.id,
          field,
          ...hit,
          at: session.lastOutputAt ?? session.statusSince,
          machineId: session.machineId,
        });
        break;
      }
    }
    return items;
  },
};

/** 事件裡的文字：每回合最後回覆（hook Stop 的 last_assistant_message）、交接／派工／任務的一句摘要。 */
const EVENT_TEXTS: { field: SearchField; where: string; text: string }[] = [
  {
    field: 'reply',
    where: "type = 'hook'",
    text: "json_extract(payload, '$.last_assistant_message')",
  },
  {
    field: 'handoff',
    where: "type >= 'handoff.' AND type < 'handoff/'",
    text: "json_extract(payload, '$.summary')",
  },
  {
    field: 'dispatch',
    where: "type >= 'dispatch.' AND type < 'dispatch/'",
    text: "json_extract(payload, '$.summary')",
  },
  {
    field: 'taskEvent',
    where: "type >= 'task.' AND type < 'task/'",
    text: "json_extract(payload, '$.summary')",
  },
];

/**
 * 四種事件各自取最多 limit 筆（不共用額度：回覆先湊滿也不會擠掉比較新的交接、派工摘要），
 * 再合起來依時間新到舊取 limit 筆；合起來超過或任何一種被截斷就呼叫 ctx.truncated。
 */
export const eventTextSource: QuickSearchSource = {
  name: 'eventTexts',
  search(ctx, store) {
    const items: SearchItem[] = [];
    let more = false;
    const ids = sessionIdsArg(ctx);
    for (const source of EVENT_TEXTS) {
      if (ctx.expired()) break;
      const like = likeAll(source.text, ctx.terms, 'payload');
      const rows = store.db
        .prepare(
          `SELECT session_id AS sessionId, at, ${source.text} AS text FROM session_events
           WHERE ${source.where} AND at >= ?
             AND ${ALIVE} AND ${IN_SESSIONS} AND ${like.sql}
           ORDER BY at DESC`,
        )
        .iterate(ctx.since, ids, ...like.args) as Iterable<{
        sessionId: string;
        at: string;
        text: unknown;
      }>;
      let taken = 0;
      for (const row of untilDeadline(rows)) {
        if (ctx.expired()) break;
        const session = ctx.sessions.get(row.sessionId);
        if (!session || typeof row.text !== 'string') continue;
        const hit = ctx.match(row.text);
        if (!hit) continue;
        if (taken >= ctx.limit) {
          more = true;
          break;
        }
        taken += 1;
        items.push({
          kind: 'session',
          sessionId: session.id,
          field: source.field,
          ...hit,
          at: row.at,
          machineId: session.machineId,
        });
      }
    }
    if (more || items.length > ctx.limit) ctx.truncated('session');
    // 穩定排序：同一個時間維持 EVENT_TEXTS 的順序。
    return items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, ctx.limit);
  },
};

/** 團隊名稱、目標、完成條件、TEAM.md（每個團隊最多一列），以及任務標題。沒有時間，不看時間範圍。 */
export const teamSource: QuickSearchSource = {
  name: 'teams',
  search(ctx, store) {
    const items: SearchItem[] = [];
    const full = (kind: SearchItem['kind']) => {
      if (items.length < ctx.limit) return false;
      ctx.truncated(kind);
      return true;
    };
    for (const team of ctx.teams) {
      if (ctx.expired()) break;
      const fields: [SearchField, string][] = [
        ['name', team.name],
        ['goal', team.goal],
        ['doneCriteria', team.doneCriteria],
        ['contextMd', team.contextMd],
      ];
      for (const [field, text] of fields) {
        const hit = ctx.match(text);
        if (!hit) continue;
        if (full('team')) return items;
        items.push({ kind: 'team', teamId: team.id, field, ...hit });
        break;
      }
      for (const task of store.listTasks(team.id)) {
        const hit = ctx.match(task.title);
        if (!hit) continue;
        if (full('task')) return items;
        const owner = task.ownerSessionId ? ctx.sessions.get(task.ownerSessionId) : undefined;
        items.push({
          kind: 'task',
          teamId: team.id,
          field: 'title',
          ...hit,
          ...(owner ? { sessionId: owner.id, machineId: owner.machineId } : {}),
        });
      }
    }
    return items;
  },
};

/**
 * 進度卡（P3 項目一，progress_cards）：目前版本的四個欄位（狀態、下一步、阻礙、GM 備註），每張卡最多一列。
 * 範圍：團隊卡跟著團隊（ctx.teams），單獨 session 的卡跟著 session（ctx.sessions，含封存與否照查詢）。
 * 規格 §3.2：進度卡不看時間範圍（只有目前版本）；at 帶最後更新時間，組內排在團隊文字前面。
 * 卡片只有幾十張，直接讀整張表在 JS 端比對（沒有大量掃描，不需要 ALIVE）。
 */
export const progressSource: QuickSearchSource = {
  name: 'progress',
  search(ctx, store) {
    const teamIds = new Set(ctx.teams.map((t) => t.id));
    const items: SearchItem[] = [];
    for (const card of store.listProgress()) {
      if (ctx.expired()) break;
      if (card.revision === 0) continue;
      const inScope =
        card.teamId !== null
          ? teamIds.has(card.teamId)
          : card.sessionId !== null && ctx.sessions.has(card.sessionId);
      if (!inScope) continue;
      const { status, next, blockers, gmNotes } = card.fields;
      let hit: ReturnType<SearchContext['match']> = null;
      for (const text of [status, next, blockers, gmNotes]) {
        hit = ctx.match(text);
        if (hit) break;
      }
      if (!hit) continue;
      if (items.length >= ctx.limit) {
        ctx.truncated('progress');
        break;
      }
      const session = card.sessionId !== null ? ctx.sessions.get(card.sessionId) : undefined;
      items.push({
        kind: 'progress',
        ...(card.teamId !== null ? { teamId: card.teamId } : {}),
        ...(session ? { sessionId: session.id, machineId: session.machineId } : {}),
        field: 'progress',
        ...hit,
        ...(card.updatedAt ? { at: card.updatedAt } : {}),
      });
    }
    return items;
  },
};

/**
 * GM 送出的指令（audit 的 terminal.input，已遮蔽密碼提示）。只給 owner，和 audit 權限一致。
 * 只算人打的（user_id 不是 null）：自動交接、自動接續、群發由 delivery 代送的 terminal.input 寫的是 user null，
 * 混進來 GM 會以為是自己打的（CONTRACTS §16）。群發的原文在 team.broadcast audit，不在這一組。
 */
export const inputSource: QuickSearchSource = {
  name: 'inputs',
  search(ctx, store) {
    if (!ctx.owner) return [];
    const like = likeAll('detail', ctx.terms);
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, detail, at FROM audit_log
         WHERE action = 'terminal.input' AND user_id IS NOT NULL AND at >= ?
           AND ${ALIVE} AND ${IN_SESSIONS} AND ${like.sql}
         ORDER BY at DESC`,
      )
      .iterate(ctx.since, sessionIdsArg(ctx), ...like.args) as Iterable<{
      sessionId: string;
      detail: string;
      at: string;
    }>;
    const items: SearchItem[] = [];
    for (const row of untilDeadline(rows)) {
      if (ctx.expired()) break;
      const session = ctx.sessions.get(row.sessionId);
      const hit = session ? ctx.match(row.detail) : null;
      if (!session || !hit) continue;
      if (items.length >= ctx.limit) {
        ctx.truncated('input');
        break;
      }
      items.push({
        kind: 'input',
        sessionId: session.id,
        field: 'input',
        ...hit,
        at: row.at,
        machineId: session.machineId,
      });
    }
    return items;
  },
};

/** 內建來源。進度卡（P3 項目一）排在 teamSource 前面，同在「進度卡與團隊」組。 */
export const BUILTIN_SOURCES: readonly QuickSearchSource[] = [
  fileSource,
  sessionFieldSource,
  eventTextSource,
  progressSource,
  teamSource,
  inputSource,
];

// ── 範圍與排序 ──

/** session 實際所在的工作區：團隊成員跟著團隊（在幾個團隊時取名稱排序第一個，同 hub 與 web），否則看自己的。 */
function sessionZones(store: Store, teams: readonly Team[]): Map<string, string> {
  const zones = new Map<string, string>();
  for (const team of [...teams].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const m of store.listTeamMembers(team.id)) {
      if (!zones.has(m.sessionId)) zones.set(m.sessionId, team.zoneId);
    }
  }
  return zones;
}

/** 範圍：哪些 session（依工作區與「含封存」）與團隊要搜。快速層與深層（deepSearch.ts）共用。 */
export function searchScope(
  store: Store,
  query: Pick<SearchQuery, 'scope' | 'zoneId' | 'archived'>,
): { sessions: Map<string, Session>; teams: Team[] } {
  const allTeams = store.listTeams();
  const zoneId = query.scope === 'zone' ? (query.zoneId ?? null) : null;
  const memberZone = sessionZones(store, allTeams);
  const sessions = new Map<string, Session>();
  for (const s of store.listSessions(query.archived ? undefined : false)) {
    if (zoneId !== null && (memberZone.get(s.id) ?? s.zoneId) !== zoneId) continue;
    sessions.set(s.id, s);
  }
  const teams = zoneId === null ? allTeams : allTeams.filter((t) => t.zoneId === zoneId);
  return { sessions, teams };
}

/** 組內：等你的（ASK／PERM／PLAN／ERR）與 RUN 在前，其餘依時間新到舊（§3.3）。 */
function rank(item: SearchItem, sessions: ReadonlyMap<string, Session>): number {
  const session = item.sessionId ? sessions.get(item.sessionId) : undefined;
  if (!session) return 1;
  return sessionWaitsForUser(session) || session.status === 'running' ? 0 : 1;
}

export interface QuickSearchOptions {
  sources?: readonly QuickSearchSource[];
  /** 測試用。 */
  now?: () => number;
  timeoutMs?: number;
}

const EMPTY: SearchResults = { groups: [], partial: false };

/** SQL 裡的逾時檢查每幾列才真的看一次時鐘（每列都看太貴；2 秒內掃得到的列遠多於這個數）。 */
const ALIVE_EVERY = 256;

/** 每個連線一份：進行中那次查詢的逾時檢查（沒有查詢時 null，ab_search_alive 一律放行）。 */
const deadlines = new WeakMap<Store['db'], { current: (() => boolean) | null }>();

/** 在這個連線註冊 ab_search_alive（只註冊一次；同一個連線上的多個 QuickSearch 共用）。 */
function deadlineOf(db: Store['db']): { current: (() => boolean) | null } {
  let slot = deadlines.get(db);
  if (slot) return slot;
  const created: { current: (() => boolean) | null } = { current: null };
  let calls = 0;
  db.function(ALIVE_FN, { deterministic: false, directOnly: true }, () => {
    calls += 1;
    if (calls % ALIVE_EVERY === 0 && created.current?.()) throw new SearchTimeout();
    return 1;
  });
  deadlines.set(db, created);
  slot = created;
  return slot;
}

export class QuickSearch {
  private readonly sources: readonly QuickSearchSource[];
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly deadline: { current: (() => boolean) | null };

  constructor(
    private readonly store: Store,
    options: QuickSearchOptions = {},
  ) {
    this.sources = options.sources ?? BUILTIN_SOURCES;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
    this.deadline = deadlineOf(store.db);
  }

  search(query: SearchQuery, user: Pick<User, 'role'>): SearchResults {
    const terms = parseSearchTerms(query.q);
    if (terms.length === 0) return EMPTY;
    const started = this.now();
    let timedOut = false;
    const expired = () => {
      if (!timedOut && this.now() - started > this.timeoutMs) timedOut = true;
      return timedOut;
    };
    const truncatedKinds = new Set<SearchGroupKind>();
    // better-sqlite3 是同步的，同一時間只會有一次查詢在跑，一個 slot 就夠。
    this.deadline.current = expired;
    try {
      return this.run(query, user, terms, expired, truncatedKinds, () => timedOut);
    } finally {
      this.deadline.current = null;
    }
  }

  private run(
    query: SearchQuery,
    user: Pick<User, 'role'>,
    terms: string[],
    expired: () => boolean,
    truncatedKinds: Set<SearchGroupKind>,
    timedOut: () => boolean,
  ): SearchResults {
    const { sessions, teams } = searchScope(this.store, query);
    const mask = query.mask;
    const ctx: SearchContext = {
      terms,
      since: new Date(this.now() - SEARCH_SINCE_MS[query.since]).toISOString(),
      sessions,
      teams,
      owner: user.role === 'owner',
      limit: SEARCH_GROUP_LIMIT,
      expired,
      truncated(kind) {
        truncatedKinds.add(SEARCH_GROUP_OF[kind]);
      },
      match(text) {
        if (!text) return null;
        return makeSnippet(mask ? maskSecrets(text) : text, terms);
      },
    };

    const byGroup = new Map<SearchGroupKind, SearchItem[]>();
    for (const source of this.sources) {
      if (expired()) break;
      for (const item of source.search(ctx, this.store)) {
        const group = SEARCH_GROUP_OF[item.kind];
        byGroup.set(group, [...(byGroup.get(group) ?? []), item]);
      }
    }

    let room = SEARCH_TOTAL_LIMIT;
    let capped = truncatedKinds.size > 0;
    const groups: SearchGroup[] = [];
    for (const kind of SEARCH_GROUP_ORDER) {
      const found = byGroup.get(kind);
      if (!found || found.length === 0) continue;
      // 先依等你／RUN，再依時間新到舊；沒有時間的（團隊文字）排在有時間的後面，彼此維持來源的順序。
      const sorted = found
        .map((item, i) => ({ item, i, r: rank(item, sessions) }))
        .sort((a, b) => a.r - b.r || (b.item.at ?? '').localeCompare(a.item.at ?? '') || a.i - b.i)
        .map((x) => x.item);
      const take = Math.min(sorted.length, SEARCH_GROUP_LIMIT, room);
      const cut = take < sorted.length || truncatedKinds.has(kind);
      if (cut) capped = true;
      if (take === 0) continue;
      room -= take;
      groups.push({ kind, total: take, capped: cut, items: sorted.slice(0, take) });
    }
    return { groups, partial: timedOut() || capped };
  }
}
