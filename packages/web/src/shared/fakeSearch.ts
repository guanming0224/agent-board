// 假後端的全域搜尋快速層：照 hub 的 search.ts 做同一件事（同一套比對、片段、遮蔽、分組、排序），
// demo 與畫面測試不用真 hub 也看得到結果。深層（③b）之後才做。
import {
  makeSnippet,
  parseSearchTerms,
  SEARCH_GROUP_LIMIT,
  SEARCH_GROUP_OF,
  SEARCH_GROUP_ORDER,
  SEARCH_SINCE_MS,
  SEARCH_TOTAL_LIMIT,
  sessionWaitsForUser,
  type AuditEntry,
  type ProgressCard,
  type SearchField,
  type SearchGroup,
  type SearchGroupKind,
  type SearchItem,
  type SearchQuery,
  type SearchResults,
  type Session,
  type SessionEvent,
  type Task,
  type Team,
  type TeamMember,
  type User,
} from '@agent-board/protocol';
import { maskSecrets } from '../security/secretPatterns';

export interface FakeSearchData {
  /** 含封存的。 */
  sessions: readonly Session[];
  events: readonly SessionEvent[];
  teams: readonly Team[];
  members: readonly TeamMember[];
  tasks: readonly Task[];
  audit: readonly AuditEntry[];
  /** 進度卡（P3 項目一）；舊的呼叫端沒給＝沒有。 */
  progress?: readonly ProgressCard[];
  role: User['role'];
  now: number;
}

const EVENT_FIELDS: [prefix: string, field: SearchField, key: string][] = [
  ['hook', 'reply', 'last_assistant_message'],
  ['handoff.', 'handoff', 'summary'],
  ['dispatch.', 'dispatch', 'summary'],
  ['task.', 'taskEvent', 'summary'],
];

function relativePath(session: Session, path: string): string {
  for (const base of [session.repoRoot, session.worktreePath, session.cwd]) {
    if (!base) continue;
    const prefix = base.endsWith('/') ? base : `${base}/`;
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

export function fakeSearch(query: SearchQuery, data: FakeSearchData): SearchResults {
  const terms = parseSearchTerms(query.q);
  if (terms.length === 0) return { groups: [], partial: false };
  const match = (text: string | null | undefined) =>
    text ? makeSnippet(query.mask ? maskSecrets(text) : text, terms) : null;
  const since = new Date(data.now - SEARCH_SINCE_MS[query.since]).toISOString();

  const memberZone = new Map<string, string>();
  for (const team of [...data.teams].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const m of data.members) {
      if (m.teamId === team.id && !memberZone.has(m.sessionId))
        memberZone.set(m.sessionId, team.zoneId);
    }
  }
  const zoneId = query.scope === 'zone' ? (query.zoneId ?? null) : null;
  const sessions = new Map(
    data.sessions
      .filter((s) => query.archived || !s.archived)
      .filter((s) => zoneId === null || (memberZone.get(s.id) ?? s.zoneId) === zoneId)
      .map((s) => [s.id, s] as const),
  );
  const teams = data.teams.filter((t) => zoneId === null || t.zoneId === zoneId);
  const recent = [...data.events]
    .filter((e) => e.at >= since && sessions.has(e.sessionId))
    .sort((a, b) => b.at.localeCompare(a.at));
  const items: SearchItem[] = [];

  // 檔案改動：同一個 session 同一個檔一列，附次數。
  const files = new Map<string, SearchItem>();
  for (const event of recent) {
    const path = event.payload.path;
    if (event.type !== 'file.changed' || typeof path !== 'string') continue;
    const key = `${event.sessionId}\u0000${path}`;
    const seen = files.get(key);
    if (seen) {
      seen.count = (seen.count ?? 1) + 1;
      continue;
    }
    const session = sessions.get(event.sessionId)!;
    const hit = match(relativePath(session, path)) ?? match(path);
    if (!hit || files.size >= SEARCH_GROUP_LIMIT) continue;
    const item: SearchItem = {
      kind: 'file',
      sessionId: session.id,
      field: 'path',
      ...hit,
      at: event.at,
      machineId: session.machineId,
      count: 1,
    };
    files.set(key, item);
    items.push(item);
  }

  for (const session of sessions.values()) {
    const fields: [SearchField, string | null][] = [
      ['name', session.name],
      ['branch', session.branch],
      ['cwd', session.cwd],
      ['worktree', session.worktreePath],
      ['lastLines', session.lastLines.join('\n')],
    ];
    for (const [field, text] of fields) {
      const hit = match(text);
      if (!hit) continue;
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

  for (const [prefix, field, key] of EVENT_FIELDS) {
    for (const event of recent) {
      const matches = prefix.endsWith('.') ? event.type.startsWith(prefix) : event.type === prefix;
      const text = event.payload[key];
      if (!matches || typeof text !== 'string') continue;
      const hit = match(text);
      if (!hit) continue;
      const session = sessions.get(event.sessionId)!;
      items.push({
        kind: 'session',
        sessionId: session.id,
        field,
        ...hit,
        at: event.at,
        machineId: session.machineId,
      });
    }
  }

  // 進度卡（同 hub 的 progressSource）：目前版本四欄位，不看時間範圍；團隊卡跟著團隊、單獨 session 卡跟著 session。
  const teamIds = new Set(teams.map((t) => t.id));
  for (const card of data.progress ?? []) {
    if (card.revision === 0) continue;
    const inScope =
      card.teamId !== null
        ? teamIds.has(card.teamId)
        : card.sessionId !== null && sessions.has(card.sessionId);
    if (!inScope) continue;
    let hit: ReturnType<typeof match> = null;
    for (const text of [card.status, card.next, card.blockers, card.gmNotes]) {
      hit = match(text);
      if (hit) break;
    }
    if (!hit) continue;
    const session = card.sessionId !== null ? sessions.get(card.sessionId) : undefined;
    items.push({
      kind: 'progress',
      ...(card.teamId !== null ? { teamId: card.teamId } : {}),
      ...(session ? { sessionId: session.id, machineId: session.machineId } : {}),
      field: 'progress',
      ...hit,
      ...(card.updatedAt ? { at: card.updatedAt } : {}),
    });
  }

  for (const team of teams) {
    const fields: [SearchField, string][] = [
      ['name', team.name],
      ['goal', team.goal],
      ['doneCriteria', team.doneCriteria],
      ['contextMd', team.contextMd],
    ];
    for (const [field, text] of fields) {
      const hit = match(text);
      if (!hit) continue;
      items.push({ kind: 'team', teamId: team.id, field, ...hit });
      break;
    }
    for (const task of data.tasks.filter((t) => t.teamId === team.id)) {
      const hit = match(task.title);
      if (!hit) continue;
      const owner = task.ownerSessionId ? sessions.get(task.ownerSessionId) : undefined;
      items.push({
        kind: 'task',
        teamId: team.id,
        field: 'title',
        ...hit,
        ...(owner ? { sessionId: owner.id, machineId: owner.machineId } : {}),
      });
    }
  }

  if (data.role === 'owner') {
    for (const entry of data.audit) {
      if (entry.action !== 'terminal.input' || entry.at < since || !entry.sessionId) continue;
      const session = sessions.get(entry.sessionId);
      const hit = session ? match(entry.detail) : null;
      if (!session || !hit) continue;
      items.push({
        kind: 'input',
        sessionId: session.id,
        field: 'input',
        ...hit,
        at: entry.at,
        machineId: session.machineId,
      });
    }
  }

  const rank = (item: SearchItem) => {
    const s = item.sessionId ? sessions.get(item.sessionId) : undefined;
    return s && (sessionWaitsForUser(s) || s.status === 'running') ? 0 : 1;
  };
  const byGroup = new Map<SearchGroupKind, SearchItem[]>();
  for (const item of items) {
    const group = SEARCH_GROUP_OF[item.kind];
    byGroup.set(group, [...(byGroup.get(group) ?? []), item]);
  }
  let room = SEARCH_TOTAL_LIMIT;
  let capped = false;
  const groups: SearchGroup[] = [];
  for (const kind of SEARCH_GROUP_ORDER) {
    const found = byGroup.get(kind);
    if (!found) continue;
    const sorted = found
      .map((item, i) => ({ item, i, r: rank(item) }))
      .sort((a, b) => a.r - b.r || (b.item.at ?? '').localeCompare(a.item.at ?? '') || a.i - b.i)
      .map((x) => x.item);
    const take = Math.min(sorted.length, SEARCH_GROUP_LIMIT, room);
    const cut = take < sorted.length;
    if (cut) capped = true;
    if (take === 0) continue;
    room -= take;
    groups.push({ kind, total: take, capped: cut, items: sorted.slice(0, take) });
  }
  return { groups, partial: capped };
}
