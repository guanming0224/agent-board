// 進度卡與 Memory（P3 項目一，docs/p3-spec.md §1，CONTRACTS §14）。
// 每個團隊（或不屬於任何團隊的單獨 session）一張卡：目前狀態、下一步、阻礙、GM 備註。GM 在網頁改，
// session 裡的 Claude 用 MCP 工具 get_progress／update_progress 讀寫（走派工同一條 daemon → hub 路徑）。
// 全部是固定規則，不呼叫任何模型；寫入不會觸發任何送字。只有 GM 按「帶入進度卡」「請隊長更新」才送字，
// 那兩個走團隊群發同一條 SafeDelivery（manual）。
import { randomUUID } from 'node:crypto';
import {
  emptyProgressCard,
  overLimit,
  cleanProgressText,
  planProgressWrite,
  progressLength,
  progressLine,
  progressOwnerKey,
  AGENT_PROGRESS_FIELDS,
  EMPTY_PROGRESS_FIELDS,
  PROGRESS_ASK_UPDATE_PROMPT,
  PROGRESS_CONTEXT_MAX,
  PROGRESS_FIELDS,
  PROGRESS_FILES_MAX,
  PROGRESS_FILES_WINDOW_MS,
  PROGRESS_HISTORY_KEEP,
  PROGRESS_LIMITS,
  PROGRESS_RATE_MAX,
  PROGRESS_RATE_WINDOW_MS,
  type Broadcast,
  type MemoryTool,
  type ProgressActor,
  type ProgressCard,
  type ProgressConflict,
  type ProgressFacts,
  type ProgressField,
  type ProgressFields,
  type ProgressOwner,
  type ProgressRevision,
  type ProgressSource,
  type ProgressWrite,
  type Session,
  type Team,
  type User,
} from '@agent-board/protocol';
import { z } from 'zod';
import type { BroadcastEngine } from './broadcast';
import { HttpError, notFound } from './errors';
import type { StoredProgress, Store } from './store';

/** 寫入的人：GM（網頁）或 session 裡的 Claude（MCP）。 */
export type ProgressWriter = { kind: 'user'; user: User } | { kind: 'session'; session: Session };

export interface ProgressDeps {
  store: Store;
  now(): Date;
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void;
  /** 卡片寫入、鎖定、還原：推給每個 client。 */
  changed(card: ProgressCard): void;
  /** `Settings.memory`。 */
  enabled(): boolean;
  broadcasts: Pick<BroadcastEngine, 'direct'>;
}

export interface ProgressReply {
  ok: boolean;
  text: string;
}

type WriteResult =
  | { kind: 'ok'; card: ProgressCard; changed: ProgressField[]; lockChanged: boolean }
  | { kind: 'conflict'; conflict: ProgressConflict }
  | { kind: 'locked' }
  | { kind: 'too_long'; fields: ProgressField[] }
  | { kind: 'ahead'; revision: number };

const fail = (code: string, message: string): ProgressReply => ({
  ok: false,
  text: `${code}: ${message}`,
});
const okJson = (value: unknown): ProgressReply => ({ ok: true, text: JSON.stringify(value) });

const isLive = (s: Session) => !s.archived && s.endedAt === null;

const LABEL: Record<ProgressField, string> = {
  status: 'status',
  next: 'next',
  blockers: 'blockers',
  gmNotes: 'gmNotes',
};

const ToolTeam = z.string().trim().min(1).max(200).optional();
const GetArgs = z.object({ team: ToolTeam });
const UpdateArgs = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  status: z.string().optional(),
  next: z.string().optional(),
  blockers: z.string().optional(),
  team: ToolTeam,
});

/** 檔案路徑改成相對 repo（worktree、repo 根目錄、cwd 依序試）。 */
function relativePath(path: string, session: Session | null): string {
  if (!session) return path;
  for (const root of [session.worktreePath, session.repoRoot, session.cwd]) {
    if (root && path.startsWith(`${root.replace(/\/+$/, '')}/`)) {
      return path.slice(root.replace(/\/+$/, '').length + 1);
    }
  }
  return path;
}

/** agent 寫入嘗試（成功與否都算）的上限：10 分鐘 30 次。成功寫入另有 PROGRESS_RATE_MAX。 */
export const PROGRESS_ATTEMPT_MAX = 30;

export class ProgressEngine {
  /** agent 寫入時間：`<卡片擁有者>:<sessionId>` → 時間戳（頻率上限用，只在記憶體）。 */
  private readonly writes = new Map<string, number[]>();
  /** agent 寫入「嘗試」時間（含衝突、鎖定、沒改到）：擋重試迴圈一直寫 audit、一直回整張卡。 */
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly deps: ProgressDeps) {}

  // ── 讀 ──────────────────────────────────────────────

  /** 擁有者存在才回（團隊或 session）；不存在丟 404。 */
  private requireOwner(owner: ProgressOwner): { team: Team | null; session: Session | null } {
    const { store } = this.deps;
    if ('teamId' in owner) {
      const team = store.getTeam(owner.teamId);
      if (!team) throw notFound('Team');
      return { team, session: null };
    }
    const session = store.getSession(owner.sessionId);
    if (!session) throw notFound('Session');
    return { team: null, session };
  }

  /** 單張卡（含自動事實）；還沒寫過是空卡。 */
  card(owner: ProgressOwner): ProgressCard {
    this.requireOwner(owner);
    const stored = this.deps.store.getProgress(owner);
    return stored ? this.toCard(stored) : emptyProgressCard(owner, this.facts(owner));
  }

  /** 寫過的卡（含自動事實）。zoneId：只要這個工作區的；all 或沒給 zoneId＝全部。 */
  list(filter: { zoneId?: string; all?: boolean } = {}): ProgressCard[] {
    const { store } = this.deps;
    const cards = store.listProgress().map((c) => this.toCard(c));
    if (filter.all || !filter.zoneId) return cards;
    return cards.filter((card) => this.zoneOf(card) === filter.zoneId);
  }

  private zoneOf(card: Pick<ProgressCard, 'teamId' | 'sessionId'>): string | null {
    const { store } = this.deps;
    if (card.teamId !== null) return store.getTeam(card.teamId)?.zoneId ?? null;
    const session = store.getSession(card.sessionId!);
    if (!session) return null;
    // 已經加入團隊的 session：跟著團隊所在的工作區（同畫布的規則）。
    return store.teamsOfSession(session.id)[0]?.zoneId ?? session.zoneId;
  }

  revisions(owner: ProgressOwner): ProgressRevision[] {
    this.requireOwner(owner);
    const stored = this.deps.store.getProgress(owner);
    if (!stored) return [];
    return this.deps.store.listProgressRevisions(stored.id).map((r) => ({
      revision: r.revision,
      fields: r.fields,
      by: this.actor(r.byKind, r.byId),
      source: r.source,
      at: r.at,
    }));
  }

  private actor(kind: 'user' | 'session', id: string | null): ProgressActor {
    const { store } = this.deps;
    const name =
      id === null
        ? null
        : kind === 'user'
          ? (store.getUser(id)?.name ?? null)
          : (store.getSession(id)?.name ?? null);
    return { kind, id, name };
  }

  private toCard(stored: StoredProgress): ProgressCard {
    const owner: ProgressOwner =
      stored.teamId !== null ? { teamId: stored.teamId } : { sessionId: stored.sessionId! };
    return {
      id: stored.id,
      teamId: stored.teamId,
      sessionId: stored.sessionId,
      ...stored.fields,
      revision: stored.revision,
      locked: stored.locked,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedByKind ? this.actor(stored.updatedByKind, stored.updatedById) : null,
      fieldRevisions: stored.fieldRevisions,
      facts: this.facts(owner, stored.updatedAt),
    };
  }

  /** 自動事實：任務板數字、最近 24 小時改過的檔案、研究階段、成員狀態、最後一次回合結束。 */
  facts(owner: ProgressOwner, updatedAt: string | null = null): ProgressFacts {
    const { store } = this.deps;
    let team: Team | null = null;
    let sessions: { session: Session; role: ProgressFacts['members'][number]['role'] }[];
    if ('teamId' in owner) {
      team = store.getTeam(owner.teamId);
      sessions = team
        ? store.listTeamMembers(team.id).flatMap((m) => {
            const s = store.getSession(m.sessionId);
            return s && !s.archived ? [{ session: s, role: m.role }] : [];
          })
        : [];
    } else {
      const s = store.getSession(owner.sessionId);
      sessions = s ? [{ session: s, role: null }] : [];
    }
    const ids = sessions.map((x) => x.session.id);
    const since = new Date(this.deps.now().getTime() - PROGRESS_FILES_WINDOW_MS).toISOString();
    const byId = new Map(sessions.map((x) => [x.session.id, x.session]));
    const files: string[] = [];
    for (const { sessionId, path } of store.recentFileEvents(ids, since, 500)) {
      const rel = relativePath(path, byId.get(sessionId) ?? null);
      if (!files.includes(rel)) files.push(rel);
      if (files.length >= PROGRESS_FILES_MAX) break;
    }
    const tasks = team ? store.listTasks(team.id) : null;
    return {
      teamName: team?.name ?? null,
      tasks: tasks
        ? {
            done: tasks.filter((t) => t.column === 'done').length,
            total: tasks.length,
            doing: tasks.filter((t) => t.column === 'doing').map((t) => `#${t.number} ${t.title}`),
          }
        : null,
      recentFiles: files,
      phase: team?.phase ?? null,
      members: sessions.map(({ session, role }) => ({
        sessionId: session.id,
        name: session.name,
        role,
        status: session.status,
        statusDetail: session.statusDetail,
        ended: session.endedAt !== null,
      })),
      // 只查卡片最後更新之後有沒有回合結束（久未更新只需要這個）；沒寫過的卡不查。
      lastStopAt: updatedAt === null ? null : store.lastStopAt(ids, updatedAt),
    };
  }

  // ── 寫 ──────────────────────────────────────────────

  /**
   * 寫入核心（同一個交易）：清理欄位 → 檢查上限 → 鎖定（只擋 agent）→ 三方比對 → 寫入、加歷史、修剪到 50 版。
   * 所有寫入（含合併、衝突、鎖定切換）寫 audit；成功就推 progress.updated。
   */
  private writeCore(
    owner: ProgressOwner,
    input: Partial<ProgressFields> & { baseRevision: number; locked?: boolean },
    writer: ProgressWriter,
    source: ProgressSource,
  ): WriteResult {
    const { store } = this.deps;
    const patch: Partial<ProgressFields> = {};
    for (const f of PROGRESS_FIELDS) {
      const value = input[f];
      if (value !== undefined) patch[f] = cleanProgressText(value);
    }
    const tooLong = overLimit(patch);
    if (tooLong.length > 0) return { kind: 'too_long', fields: tooLong };
    const key = progressOwnerKey(owner);
    const userId = writer.kind === 'user' ? writer.user.id : null;
    const sessionId = writer.kind === 'session' ? writer.session.id : null;

    const result = store.db.transaction((): WriteResult => {
      const now = this.deps.now().toISOString();
      const existing = store.getProgress(owner);
      const current: StoredProgress = existing ?? {
        id: randomUUID(),
        teamId: 'teamId' in owner ? owner.teamId : null,
        sessionId: 'sessionId' in owner ? owner.sessionId : null,
        fields: { ...EMPTY_PROGRESS_FIELDS },
        revision: 0,
        locked: false,
        updatedAt: null,
        updatedByKind: null,
        updatedById: null,
        fieldRevisions: { status: 0, next: 0, blockers: 0, gmNotes: 0 },
      };
      if (writer.kind === 'session' && current.locked) return { kind: 'locked' };
      if (input.baseRevision > current.revision) {
        return { kind: 'ahead', revision: current.revision };
      }
      const plan = planProgressWrite(
        { ...current.fields, revision: current.revision, fieldRevisions: current.fieldRevisions },
        input.baseRevision,
        patch,
      );
      if (plan.conflicts.length > 0) {
        const card = this.toCard(current);
        const conflict: ProgressConflict = {
          card,
          fields: plan.conflicts.map((field) =>
            this.conflictField(current, field, input.baseRevision),
          ),
        };
        this.deps.audit(
          userId,
          sessionId,
          'progress.conflict',
          JSON.stringify({
            card: key,
            cardId: current.id,
            fields: plan.conflicts,
            baseRevision: input.baseRevision,
            revision: current.revision,
            source,
          }),
        );
        return { kind: 'conflict', conflict };
      }
      const lockChange =
        writer.kind === 'user' && input.locked !== undefined && input.locked !== current.locked;
      if (plan.changed.length === 0 && !lockChange) {
        return { kind: 'ok', card: this.toCard(current), changed: [], lockChanged: false };
      }
      let next: StoredProgress = { ...current };
      if (lockChange) {
        next = { ...next, locked: input.locked! };
        this.deps.audit(
          userId,
          null,
          'progress.lock',
          JSON.stringify({ card: key, cardId: current.id, locked: input.locked }),
        );
      }
      if (plan.changed.length > 0) {
        const revision = current.revision + 1;
        const fields = { ...current.fields, ...patch };
        const fieldRevisions = { ...current.fieldRevisions };
        for (const f of plan.changed) fieldRevisions[f] = revision;
        next = {
          ...next,
          fields,
          revision,
          fieldRevisions,
          updatedAt: now,
          updatedByKind: writer.kind,
          updatedById: writer.kind === 'user' ? writer.user.id : writer.session.id,
        };
        store.saveProgress(next);
        store.addProgressRevision(
          next.id,
          {
            revision,
            fields,
            byKind: writer.kind,
            byId: next.updatedById,
            source,
            at: now,
          },
          PROGRESS_HISTORY_KEEP,
        );
        // audit 不存欄位全文（全文在歷史表）：只記改了哪些欄位與字數。
        this.deps.audit(
          userId,
          sessionId,
          source === 'restore' ? 'progress.restore' : 'progress.update',
          JSON.stringify({
            card: key,
            cardId: next.id,
            fields: plan.changed,
            lengths: Object.fromEntries(plan.changed.map((f) => [f, progressLength(fields[f])])),
            merged: plan.merged,
            source,
            revision,
          }),
        );
      } else {
        store.saveProgress(next);
      }
      return {
        kind: 'ok',
        card: { ...this.toCard(next), ...(plan.merged ? { merged: true } : {}) },
        changed: plan.changed,
        lockChanged: lockChange,
      };
    })();
    // 只有真的改了欄位或切換了鎖定才推（body 帶了相同的 locked 不算）。
    if (result.kind === 'ok' && (result.changed.length > 0 || result.lockChanged)) {
      const card = { ...result.card };
      delete card.merged;
      this.deps.changed(card);
    }
    return result;
  }

  private conflictField(
    current: StoredProgress,
    field: ProgressField,
    baseRevision: number,
  ): ProgressConflict['fields'][number] {
    const { store } = this.deps;
    const base =
      baseRevision === 0
        ? ''
        : (store.getProgressRevision(current.id, baseRevision)?.fields[field] ?? null);
    // 最後改這一欄的人：那一版的作者。
    const last = store.getProgressRevision(current.id, current.fieldRevisions[field]);
    return {
      field,
      base,
      current: current.fields[field],
      by: last ? this.actor(last.byKind, last.byId) : null,
    };
  }

  /** 網頁寫入（GM）。錯誤丟 HttpError；衝突 409 progress_conflict，detail 是 ProgressConflict。 */
  write(owner: ProgressOwner, body: ProgressWrite, user: User): ProgressCard {
    this.requireOwner(owner);
    const result = this.writeCore(owner, body, { kind: 'user', user }, 'web');
    return this.unwrap(result);
  }

  private unwrap(result: WriteResult): ProgressCard {
    switch (result.kind) {
      case 'ok':
        return result.card;
      case 'conflict':
        throw new HttpError(
          409,
          'progress_conflict',
          `Changed by someone else since you read it: ${result.conflict.fields.map((f) => f.field).join(', ')}`,
          undefined,
          result.conflict as unknown as Record<string, unknown>,
        );
      case 'too_long':
        throw new HttpError(
          400,
          'field_too_long',
          `Too long: ${result.fields.map((f) => `${f} (max ${PROGRESS_LIMITS[f]})`).join(', ')}`,
        );
      case 'ahead':
        throw new HttpError(
          400,
          'invalid_revision',
          `baseRevision is newer than the card (revision ${result.revision})`,
        );
      case 'locked':
        throw new HttpError(409, 'card_locked', 'This progress card is locked');
    }
  }

  /** 還原這版＝以舊內容寫一個新版本（不刪歷史）。GM 明確按的，不做三方比對。 */
  restore(owner: ProgressOwner, revision: number, user: User): ProgressCard {
    this.requireOwner(owner);
    const stored = this.deps.store.getProgress(owner);
    const entry = stored ? this.deps.store.getProgressRevision(stored.id, revision) : null;
    if (!stored || !entry) throw notFound('Progress revision');
    return this.unwrap(
      this.writeCore(
        owner,
        { ...entry.fields, baseRevision: stored.revision },
        { kind: 'user', user },
        'restore',
      ),
    );
  }

  // ── 送字（GM 按的） ──────────────────────────────────

  /** 帶入進度卡：把卡片組成一行送進指定 session。卡片全空 400 progress_empty。 */
  deliver(owner: ProgressOwner, sessionId: string, user: User): Broadcast {
    const { team, session } = this.requireOwner(owner);
    const target = this.deps.store.getSession(sessionId);
    if (!target) throw notFound('Session');
    const stored = this.deps.store.getProgress(owner);
    const name = team?.name ?? session?.name ?? '';
    const line = stored ? progressLine(name, stored.fields) : null;
    if (line === null) {
      throw new HttpError(400, 'progress_empty', 'This progress card has nothing to send yet');
    }
    return this.deps.broadcasts.direct(
      {
        teamId: team?.id ?? null,
        kind: 'progress',
        cardKey: progressOwnerKey(owner),
        text: line,
        session: target,
      },
      user,
      'progress.deliver',
    );
  }

  /** 請隊長更新 ◈：送固定一行給隊長。沒有隊長 400 no_lead。 */
  askUpdate(teamId: string, user: User): Broadcast {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) throw notFound('Team');
    const lead = this.leadOf(team);
    if (!lead) throw new HttpError(400, 'no_lead', 'This team has no lead');
    return this.deps.broadcasts.direct(
      {
        teamId,
        kind: 'ask_update',
        cardKey: progressOwnerKey({ teamId }),
        text: PROGRESS_ASK_UPDATE_PROMPT,
        session: lead,
      },
      user,
      'progress.ask_update',
    );
  }

  private leadOf(team: Team): Session | null {
    const { store } = this.deps;
    for (const m of store.listTeamMembers(team.id)) {
      if (m.role !== 'lead') continue;
      const s = store.getSession(m.sessionId);
      if (s && !s.archived) return s;
    }
    return null;
  }

  // ── MCP 工具（daemon 轉來，CONTRACTS §14） ───────────

  /** daemon 已驗證密鑰、hub 已確認 session 在這台機器上。 */
  handleTool(callerId: string, tool: MemoryTool, args: Record<string, unknown>): ProgressReply {
    if (!this.deps.enabled()) {
      return fail(
        'memory_disabled',
        'Progress cards are turned off in Agent Board settings. Keep your notes in your replies instead.',
      );
    }
    const caller = this.deps.store.getSession(callerId);
    if (!caller || !isLive(caller)) {
      return fail(
        'no_card_owner',
        'This session is archived, has ended, or is not known to Agent Board, so it has no progress card.',
      );
    }
    return tool === 'get_progress' ? this.getTool(caller, args) : this.updateTool(caller, args);
  }

  /** 呼叫者的卡：所在團隊的（可用 team 指定名稱或 id），不在任何團隊就是它自己的。 */
  private ownersOf(
    caller: Session,
    teamRef: string | undefined,
  ): { owners: { owner: ProgressOwner; team: Team | null }[] } | ProgressReply {
    const teams = this.deps.store.teamsOfSession(caller.id);
    if (teamRef !== undefined) {
      const wanted = teamRef.toLowerCase();
      const team = teams.find((t) => t.id === teamRef || t.name.toLowerCase() === wanted);
      if (!team) {
        return fail(
          'invalid_arguments',
          `You are not in a team called "${teamRef}". Your teams: ${
            teams.length > 0 ? teams.map((t) => t.name).join(', ') : 'none (omit team)'
          }.`,
        );
      }
      return { owners: [{ owner: { teamId: team.id }, team }] };
    }
    if (teams.length === 0) return { owners: [{ owner: { sessionId: caller.id }, team: null }] };
    return { owners: teams.map((team) => ({ owner: { teamId: team.id }, team })) };
  }

  private toolView(
    card: ProgressCard,
    team: Team | null,
    caller: Session,
  ): Record<string, unknown> {
    const context = team?.contextMd ?? '';
    const chars = [...context];
    const truncated = chars.length > PROGRESS_CONTEXT_MAX;
    const by = card.updatedBy;
    return {
      ...(team ? { team: team.name } : { session: caller.name }),
      revision: card.revision,
      locked: card.locked,
      ...(card.locked
        ? {
            note: 'The user locked this card. Read it as usual; update_progress is refused until it is unlocked.',
          }
        : {}),
      updatedAt: card.updatedAt,
      updatedBy: by ? `${by.name ?? 'unknown'} (${by.kind === 'user' ? 'user' : 'session'})` : null,
      status: card.status,
      next: card.next,
      blockers: card.blockers,
      gmNotes: card.gmNotes,
      ...(card.gmNotes
        ? {
            gmNotesRule: "gmNotes are the user's fixed rules. Follow them; you cannot change them.",
          }
        : {}),
      ...(team
        ? {
            goal: team.goal,
            doneCriteria: team.doneCriteria,
            contextMd: truncated ? `${chars.slice(0, PROGRESS_CONTEXT_MAX).join('')}…` : context,
            ...(truncated
              ? { contextTruncated: `contextMd was cut to ${PROGRESS_CONTEXT_MAX} characters.` }
              : {}),
          }
        : {}),
      facts: {
        tasks: card.facts.tasks,
        recentFiles: card.facts.recentFiles,
        phase: card.facts.phase,
        members: card.facts.members.map((m) => ({
          name: m.name,
          ...(m.role ? { role: m.role } : {}),
          status: m.ended ? 'ended' : m.status,
        })),
      },
    };
  }

  private getTool(caller: Session, raw: Record<string, unknown>): ProgressReply {
    const parsed = GetArgs.safeParse(raw);
    if (!parsed.success) return fail('invalid_arguments', 'team must be a team name or id.');
    const found = this.ownersOf(caller, parsed.data.team);
    if ('ok' in found) return found;
    const views = found.owners.map(({ owner, team }) =>
      this.toolView(this.card(owner), team, caller),
    );
    return okJson(views.length === 1 ? views[0] : { cards: views });
  }

  private updateTool(caller: Session, raw: Record<string, unknown>): ProgressReply {
    if ('gmNotes' in raw) {
      return fail(
        'invalid_arguments',
        "gmNotes are the user's fixed rules; agents cannot change them. Send only status, next and blockers.",
      );
    }
    const parsed = UpdateArgs.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'invalid_arguments',
        `baseRevision (the revision you read with get_progress) is required; you may also send status, next, blockers and team. ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const args = parsed.data;
    const patch: Partial<ProgressFields> = {};
    for (const f of AGENT_PROGRESS_FIELDS) if (args[f] !== undefined) patch[f] = args[f];
    if (Object.keys(patch).length === 0) {
      return fail('invalid_arguments', 'Send at least one of status, next, blockers.');
    }
    const found = this.ownersOf(caller, args.team);
    if ('ok' in found) return found;
    if (found.owners.length > 1) {
      return fail(
        'invalid_arguments',
        `You are in several teams (${found.owners.map((o) => o.team!.name).join(', ')}). Pass team to say which card to update.`,
      );
    }
    const { owner, team } = found.owners[0]!;
    if (team) {
      const lead = this.leadOf(team);
      const isMember = this.deps.store
        .listTeamMembers(team.id)
        .some((m) => m.sessionId === caller.id);
      if ((lead && lead.id !== caller.id) || !isMember) {
        return fail(
          'not_lead',
          `Only the team lead${lead ? ` (${lead.name})` : ''} updates the progress card. Report your progress to the lead instead.`,
        );
      }
    }
    // 先看上限（不默默截斷，讓 Claude 自己縮短）。
    for (const f of AGENT_PROGRESS_FIELDS) {
      const value = patch[f];
      if (value === undefined) continue;
      const length = progressLength(cleanProgressText(value));
      if (length > PROGRESS_LIMITS[f]) {
        return fail(
          'invalid_arguments',
          `${LABEL[f]} is ${length} characters; the limit is ${PROGRESS_LIMITS[f]}. Shorten it and try again.`,
        );
      }
    }
    // 一個擁有者只有一張卡：用擁有者當鍵（第一次寫入時卡片還沒有 id）。
    const rateKey = `${progressOwnerKey(owner)}:${caller.id}`;
    const nowMs = this.deps.now().getTime();
    const recent = (this.writes.get(rateKey) ?? []).filter(
      (at) => nowMs - at < PROGRESS_RATE_WINDOW_MS,
    );
    this.writes.set(rateKey, recent);
    if (recent.length >= PROGRESS_RATE_MAX) {
      return fail(
        'rate_limit',
        `More than ${PROGRESS_RATE_MAX} updates to this card in 10 minutes. Update it again after you finish a larger step.`,
      );
    }
    const tried = (this.attempts.get(rateKey) ?? []).filter(
      (at) => nowMs - at < PROGRESS_RATE_WINDOW_MS,
    );
    if (tried.length >= PROGRESS_ATTEMPT_MAX) {
      this.attempts.set(rateKey, tried);
      return fail(
        'rate_limit',
        `More than ${PROGRESS_ATTEMPT_MAX} update attempts on this card in 10 minutes (including rejected ones). Stop retrying; tell the user what you wanted to change.`,
      );
    }
    this.attempts.set(rateKey, [...tried, nowMs]);
    const result = this.writeCore(
      owner,
      { ...patch, baseRevision: args.baseRevision },
      { kind: 'session', session: caller },
      'mcp',
    );
    switch (result.kind) {
      case 'locked':
        return fail(
          'card_locked',
          'The user locked this progress card. Do not retry; tell the user what you would change instead.',
        );
      case 'too_long':
        return fail('invalid_arguments', `Too long: ${result.fields.join(', ')}.`);
      case 'ahead':
        return fail(
          'invalid_arguments',
          `baseRevision ${args.baseRevision} is newer than the card (revision ${result.revision}). Call get_progress first.`,
        );
      case 'conflict': {
        const { conflict } = result;
        const fields = conflict.fields.map((f) => f.field).join(', ');
        return fail(
          'progress_conflict',
          `The user or another member just changed ${fields}; your update was not saved. Treat the current content as correct, merge your changes into it, then call update_progress again with baseRevision ${conflict.card.revision}. Current card: ${JSON.stringify(
            this.toolView(conflict.card, team, caller),
          )}`,
        );
      }
      case 'ok': {
        if (result.changed.length > 0) this.writes.set(rateKey, [...recent, nowMs]);
        return okJson({
          revision: result.card.revision,
          ...(result.card.merged
            ? {
                merged: true,
                note: 'Someone else changed other fields since you read the card; their changes were kept.',
              }
            : {}),
          updated: result.changed,
          ...(result.changed.length === 0 ? { note: 'Nothing changed.' } : {}),
        });
      }
    }
  }
}
