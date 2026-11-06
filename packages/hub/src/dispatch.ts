// session 派工（GM 2026-11-06，CONTRACTS §11）：畫布上某個 session 裡的 Claude 透過 MCP 工具
// （daemon 掛的 `agent-board` server）自己開成員、送工作、收結果。全部是固定規則，不呼叫任何模型：
// 送進成員的字是 Claude 自己寫的工作內容（加上固定的 `[From …]` 開頭），送回的結果只有一句摘要＋檔案＋分支。
// 送字一律走 delivery.ts（只在目標等輸入時送，和交接、任務同一條佇列）。
import { randomUUID } from 'node:crypto';
import {
  DISPATCH_ROLES,
  DISPATCH_SPAWN_LIMIT,
  isReadOnlyMember,
  PermissionMode,
  sameWorkingTree,
  type DispatchTool,
  type DispatchWork,
  type Session,
  type SessionEvent,
  type SessionSpec,
  type Team,
  type TeamMember,
} from '@agent-board/protocol';
import { z } from 'zod';
import { isGone, type DeliveryItem, type SafeDelivery } from './delivery';
import { HttpError } from './errors';
import { cleanLine, oneSentence, reportParts, sessionReport } from './handoff';
import type { Store } from './store';

/** 送進成員的工作內容上限（字元）；超過截斷。 */
const PROMPT_MAX_CHARS = 4_000;
const NAME_MAX_CHARS = 60;
/** 同一個呼叫者 10 分鐘內最多送幾則工作、收幾則結果（防迴圈的第二道防線，同交接的 RULE_MAX_FIRES）。 */
export const DISPATCH_SEND_MAX = 20;
export const DISPATCH_RESULT_MAX = 10;
const DISPATCH_WINDOW_MS = 10 * 60 * 1000;

/** 角色縮寫，和前端 team/teamPlan.ts 的 ROLE_ABBR 相同。 */
const ROLE_ABBR: Record<(typeof DISPATCH_ROLES)[number], string> = {
  worker: 'BD',
  researcher: 'RS',
  reviewer: 'RV',
};
/** 新團隊的框色（team/colors.ts 的第一個）。 */
const DEFAULT_TEAM_COLOR = 'teal';

/**
 * 權限模式的寬鬆程度：plan < default < acceptEdits < auto／dontAsk < bypassPermissions（GM 2026-11-06 定的順序）。
 * 派工開的成員不能比呼叫者寬，而且工具永遠開不出 bypassPermissions。
 */
const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  auto: 3,
  dontAsk: 3,
  bypassPermissions: 4,
};
const TOOL_MAX_RANK = 3;

export const permissionRank = (mode: PermissionMode): number => MODE_RANK[mode];

/**
 * 成員實際用的權限模式。requested 沒給就用角色的預設（worker acceptEdits、研究與審查 plan，同建立團隊表單）。
 * 上限是 min(呼叫者, auto／dontAsk)：超過就降成呼叫者的模式（呼叫者是 bypassPermissions 時降成 acceptEdits）。
 * 注意：hub 只知道呼叫者建立時的模式，Shift+Tab 中途切換看不到。
 */
export function clampPermissionMode(
  requested: PermissionMode | undefined,
  caller: PermissionMode,
  role: (typeof DISPATCH_ROLES)[number],
): { mode: PermissionMode; clamped: boolean } {
  const wanted = requested ?? (role === 'worker' ? 'acceptEdits' : 'plan');
  const cap = Math.min(permissionRank(caller), TOOL_MAX_RANK);
  if (permissionRank(wanted) <= cap) return { mode: wanted, clamped: false };
  const fallback = permissionRank(caller) <= TOOL_MAX_RANK ? caller : 'acceptEdits';
  // 呼叫者比角色預設還嚴（例如 plan 開 worker）：照呼叫者，不算使用者要求被改。
  return { mode: fallback, clamped: requested !== undefined };
}

/**
 * 預設名稱：`<團隊名>-BD1`、`-BD2`；研究與審查只有一位時不編號（`-RS`），之後 `-RS2`（同 teamPlan.defaultNames）。
 * 指定的名稱撞名就加 `-2`、`-3`。
 */
export function memberName(
  teamName: string,
  role: (typeof DISPATCH_ROLES)[number],
  wanted: string | undefined,
  taken: ReadonlySet<string>,
): string {
  const has = (name: string) => taken.has(name.toLowerCase());
  if (wanted) {
    if (!has(wanted)) return wanted;
    let n = 2;
    while (has(`${wanted}-${n}`)) n += 1;
    return `${wanted}-${n}`;
  }
  const prefix = teamName.trim();
  const full = (tag: string) => (prefix ? `${prefix}-${tag}` : tag);
  const abbr = ROLE_ABBR[role];
  if (role !== 'worker' && !has(full(abbr))) return full(abbr);
  let n = role === 'worker' ? 1 : 2;
  while (has(full(`${abbr}${n}`))) n += 1;
  return full(`${abbr}${n}`);
}

const clip = (text: string, max: number) => {
  const chars = [...cleanLine(text)];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

/** 一行。開頭固定 `[From <呼叫者>]`：內容是另一個模型寫的，不能讓它以 `/`、`!` 開頭被當成指令。 */
export function workMessage(callerName: string, text: string): string {
  return `[From ${clip(callerName, NAME_MAX_CHARS)}] ${clip(text, PROMPT_MAX_CHARS)}`;
}

/** 送回呼叫者的結果：一句摘要、改過的檔案、分支（和交接同一套 reportParts）。 */
export function resultMessage(
  memberNameText: string,
  input: { summary: string; files: readonly string[]; branch: string | null },
): string {
  return [
    `[Result from ${clip(memberNameText, NAME_MAX_CHARS)}]`,
    reportParts(input).join(' | '),
  ].join(' ');
}

const SpawnArgs = z.object({
  name: z.string().max(NAME_MAX_CHARS).optional(),
  role: z.enum(DISPATCH_ROLES),
  prompt: z.string().min(1),
  permissionMode: PermissionMode.optional(),
  useWorktree: z.boolean().optional(),
  model: z.string().max(100).optional(),
});
const SendArgs = z.object({ member: z.string().min(1), text: z.string().min(1) });
const MemberArgs = z.object({ member: z.string().min(1) });

export interface DispatchReply {
  ok: boolean;
  text: string;
}

const fail = (code: string, message: string): DispatchReply => ({
  ok: false,
  text: `${code}: ${message}`,
});
const okJson = (value: unknown): DispatchReply => ({ ok: true, text: JSON.stringify(value) });

const isLive = (s: Session) => !s.archived && s.endedAt === null;
const BOUNDARY = new Set(['dispatch.spawn', 'dispatch.delivered']);

export interface DispatchDeps {
  store: Store;
  now(): Date;
  delivery: SafeDelivery;
  /** user 一律是 null（系統）；session 是動作的來源（呼叫者或回報的成員）。 */
  audit(sessionId: string, action: string, detail: string): void;
  addEvent(sessionId: string, type: string, payload: Record<string, unknown>, at?: string): void;
  enabled(): boolean;
  /** 走 hub 開 session 的同一條路（排隊、worktree、hooks、第一個指令照常），記下是誰開的。 */
  createSession(input: SessionSpec & { machineId: string }, dispatchedBy: string): Session;
  /** 機器在線才開得了 session；離線時回 false。 */
  machineOnline(machineId: string): boolean;
}

export class DispatchEngine {
  private readonly sends = new Map<string, number[]>();
  private readonly results = new Map<string, number[]>();

  constructor(private readonly deps: DispatchDeps) {}

  /** daemon 轉來的工具呼叫。daemon 已驗證密鑰；這裡驗證呼叫者還在、設定開著、對象在範圍內。 */
  handle(callerId: string, tool: DispatchTool, args: Record<string, unknown>): DispatchReply {
    if (!this.deps.enabled()) {
      return fail(
        'dispatch_disabled',
        'Session dispatch is turned off in Agent Board settings. Ask the user to turn it on, or do the work yourself.',
      );
    }
    const caller = this.deps.store.getSession(callerId);
    if (!caller || !isLive(caller) || caller.status === 'done') {
      return fail('caller_inactive', 'This session is archived or has ended.');
    }
    switch (tool) {
      case 'list_members':
        return this.listMembers(caller);
      case 'spawn_member':
        return this.spawn(caller, args);
      case 'send_task':
        return this.send(caller, args);
      case 'get_result':
        return this.getResult(caller, args);
    }
  }

  // ── 範圍 ────────────────────────────────────────────

  private teamsOf(sessionId: string): { team: Team; members: TeamMember[] }[] {
    const { store } = this.deps;
    return store
      .listTeams()
      .map((team) => ({ team, members: store.listTeamMembers(team.id) }))
      .filter(({ members }) => members.some((m) => m.sessionId === sessionId));
  }

  /** 呼叫者能派工的對象：它當隊長的團隊的成員，加上它開的成員。不含自己。 */
  private reachable(caller: Session): Session[] {
    const { store } = this.deps;
    const ids = new Set<string>();
    for (const { members } of this.teamsOf(caller.id)) {
      const me = members.find((m) => m.sessionId === caller.id);
      if (me?.role !== 'lead') continue;
      for (const m of members) ids.add(m.sessionId);
    }
    for (const s of store.listDispatchedBy(caller.id)) ids.add(s.id);
    ids.delete(caller.id);
    return [...ids].flatMap((id) => {
      const s = store.getSession(id);
      return s && !s.archived ? [s] : [];
    });
  }

  /** 名稱（不分大小寫）或 session id。 */
  private resolve(caller: Session, ref: string): Session | DispatchReply {
    const wanted = ref.trim().toLowerCase();
    const found = this.reachable(caller).find(
      (s) => s.id === ref.trim() || s.name.toLowerCase() === wanted,
    );
    if (found) return found;
    const names = this.reachable(caller).map((s) => s.name);
    return fail(
      'not_your_member',
      `"${clip(ref, NAME_MAX_CHARS)}" is not a member you can direct. You can direct: ${
        names.length > 0 ? names.join(', ') : 'nobody yet (use spawn_member)'
      }.`,
    );
  }

  private liveSpawned(caller: Session): Session[] {
    return this.deps.store.listDispatchedBy(caller.id).filter(isLive);
  }

  private underLimit(map: Map<string, number[]>, key: string, max: number): boolean {
    const now = this.deps.now().getTime();
    const recent = (map.get(key) ?? []).filter((at) => now - at < DISPATCH_WINDOW_MS);
    if (recent.length >= max) {
      map.set(key, recent);
      return false;
    }
    map.set(key, [...recent, now]);
    return true;
  }

  // ── list_members ────────────────────────────────────

  private listMembers(caller: Session): DispatchReply {
    const { store } = this.deps;
    const teams = this.teamsOf(caller.id).map(({ team, members }) => {
      const tasks = store.listTasks(team.id).filter((t) => t.column === 'doing');
      return {
        team: team.name,
        yourRole: members.find((m) => m.sessionId === caller.id)?.role ?? null,
        members: members.flatMap((m) => {
          const s = store.getSession(m.sessionId);
          if (!s || s.archived) return [];
          const task = tasks.find((t) => t.ownerSessionId === s.id);
          const by = s.dispatchedBy ? store.getSession(s.dispatchedBy)?.name : null;
          return [
            {
              name: s.name,
              ...(s.id === caller.id ? { you: true } : {}),
              role: m.role,
              ...(m.kind ? { kind: m.kind } : {}),
              status: s.endedAt === null ? s.status : 'ended',
              task: task ? `#${task.number} ${clip(task.title, 200)}` : null,
              lastLine: s.lastLines.at(-1) ? clip(s.lastLines.at(-1)!, 200) : null,
              readOnly: isReadOnlyMember(m.role, s),
              branch: s.branch,
              dispatchedBy: by ?? null,
              working: store.dispatchWork(s.id) !== null,
            },
          ];
        }),
      };
    });
    return okJson({
      teams,
      spawned: { live: this.liveSpawned(caller).length, limit: DISPATCH_SPAWN_LIMIT },
    });
  }

  // ── spawn_member ────────────────────────────────────

  /** 呼叫者當隊長的團隊；沒有就它所在的第一個團隊；都沒有就開一個以它命名、它當隊長的團隊。 */
  private teamFor(caller: Session): { team: Team; created: boolean } {
    const { store } = this.deps;
    const teams = this.teamsOf(caller.id);
    const led = teams.find(({ members }) =>
      members.some((m) => m.sessionId === caller.id && m.role === 'lead'),
    );
    const found = led ?? teams[0];
    if (found) return { team: found.team, created: false };
    const team: Team = {
      id: randomUUID(),
      name: caller.name,
      goal: '',
      doneCriteria: '',
      color: DEFAULT_TEAM_COLOR,
      contextMd: '',
      taskAuto: false,
    };
    store.upsertTeam(team);
    store.upsertTeamMember({ teamId: team.id, sessionId: caller.id, role: 'lead' });
    return { team, created: true };
  }

  private spawn(caller: Session, raw: Record<string, unknown>): DispatchReply {
    const parsed = SpawnArgs.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'invalid_arguments',
        `role must be one of ${DISPATCH_ROLES.join(', ')}, and prompt is required. ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const args = parsed.data;
    const { store } = this.deps;
    const prompt = cleanLine(args.prompt);
    if (!prompt) return fail('invalid_arguments', 'prompt must not be empty.');
    if (args.permissionMode === 'bypassPermissions') {
      return fail(
        'permission_not_allowed',
        'bypassPermissions cannot be granted by a tool. Omit permissionMode or use acceptEdits / default / plan.',
      );
    }
    if (caller.dispatchedBy !== null) {
      const by = store.getSession(caller.dispatchedBy)?.name ?? 'the session that started you';
      return fail(
        'nested_spawn',
        `Members started by dispatch cannot start more members. Report back to ${by} instead.`,
      );
    }
    const readOnly = args.role !== 'worker';
    if (caller.readOnly && !readOnly) {
      return fail(
        'read_only_caller',
        'A read-only session cannot start members that edit files. Use role researcher or reviewer.',
      );
    }
    const live = this.liveSpawned(caller);
    if (live.length >= DISPATCH_SPAWN_LIMIT) {
      return fail(
        'limit_reached',
        `You already have ${live.length} live members (${live.map((s) => s.name).join(', ')}); the limit is ${DISPATCH_SPAWN_LIMIT}. Reuse one with send_task, or ask the user to archive one.`,
      );
    }
    if (!this.deps.machineOnline(caller.machineId)) {
      return fail('machine_offline', 'This machine is not connected to Agent Board right now.');
    }
    const { mode, clamped } = clampPermissionMode(
      args.permissionMode,
      caller.permissionMode,
      args.role,
    );
    // 寫入者預設開 worktree；不是 git（或 daemon 還沒回報）就開不了，除非明確說不要。
    const useWorktree = args.useWorktree ?? !readOnly;
    if (useWorktree && caller.repoRoot === null) {
      return fail(
        'worktree_unavailable',
        `${caller.cwd} is not a git repository (or Agent Board has not detected it yet), so a member cannot get its own worktree. Use role researcher or reviewer, or set useWorktree: false if nobody else edits files here.`,
      );
    }
    const { team, created } = this.teamFor(caller);
    const members = store.listTeamMembers(team.id);
    if (!readOnly && !useWorktree) {
      const clash = this.writerClash(caller, members);
      if (clash.length > 0) {
        return fail(
          'worktree_required',
          `Same folder as ${clash.join(', ')}. Members that edit files each need their own worktree (useWorktree: true).`,
        );
      }
    }
    const wanted = args.name ? cleanLine(args.name) : '';
    const taken = new Set(store.listSessions().map((s) => s.name.toLowerCase()));
    const name = memberName(team.name, args.role, wanted || undefined, taken);
    const message = workMessage(caller.name, prompt);
    let member: Session;
    try {
      member = this.deps.createSession(
        {
          machineId: caller.machineId,
          name,
          projectId: caller.projectId,
          cwd: caller.cwd,
          useWorktree,
          permissionMode: mode,
          model: args.model ? cleanLine(args.model) || caller.model : caller.model,
          accountProfile: caller.accountProfile,
          resumeClaudeSessionId: null,
          firstPrompt: message,
          readOnly,
        },
        caller.id,
      );
    } catch (error) {
      if (error instanceof HttpError) return fail(error.code, error.message);
      throw error;
    }
    store.upsertTeamMember({ teamId: team.id, sessionId: member.id, role: args.role });
    const workId = randomUUID();
    const work: DispatchWork = {
      from: caller.id,
      workId,
      kind: 'spawn',
      at: this.deps.now().toISOString(),
    };
    store.setDispatchWork(member.id, work);
    const summary = oneSentence(prompt);
    const detail = {
      fromSessionId: caller.id,
      toSessionId: member.id,
      workId,
      teamId: team.id,
      teamCreated: created,
      name,
      role: args.role,
      permissionMode: mode,
      useWorktree,
      readOnly,
    };
    this.deps.audit(caller.id, 'dispatch.spawn', JSON.stringify({ ...detail, summary }));
    // 記在成員：畫布畫「呼叫者 → 成員」的送達；也是成員「改過的檔案」的分界。
    this.deps.addEvent(member.id, 'dispatch.spawn', { ...detail, summary });
    return okJson({
      name,
      status: member.status,
      team: team.name,
      ...(created ? { teamCreated: true } : {}),
      role: args.role,
      permissionMode: mode,
      ...(clamped ? { note: `permissionMode lowered to ${mode} (cannot exceed yours)` } : {}),
      readOnly,
      useWorktree,
      result:
        'The prompt will be typed in once the session starts. Its result comes back to you automatically as "[Result from …]" when it finishes the turn.',
    });
  }

  /** 新成員（不開 worktree、會改檔案）和團隊裡同一個 working tree 的寫入者衝突（同 hub/worktree.ts 的規則）。 */
  private writerClash(caller: Session, members: readonly TeamMember[]): string[] {
    const { store } = this.deps;
    const place = { dir: caller.cwd, repoRoot: caller.repoRoot };
    return members.flatMap(({ sessionId, role }) => {
      const s = store.getSession(sessionId);
      if (!s || s.machineId !== caller.machineId || !isLive(s) || s.status === 'done') return [];
      if (isReadOnlyMember(role, s)) return [];
      const other = { dir: s.worktreePath ?? s.cwd, repoRoot: s.repoRoot };
      return sameWorkingTree(place, other) ? [s.name] : [];
    });
  }

  // ── send_task ───────────────────────────────────────

  private send(caller: Session, raw: Record<string, unknown>): DispatchReply {
    const parsed = SendArgs.safeParse(raw);
    if (!parsed.success) return fail('invalid_arguments', 'member and text are required.');
    const target = this.resolve(caller, parsed.data.member);
    if ('ok' in target) return target;
    if (isGone(target)) {
      return fail('member_ended', `${target.name} has ended. Spawn a new member instead.`);
    }
    const text = cleanLine(parsed.data.text);
    if (!text) return fail('invalid_arguments', 'text must not be empty.');
    if (!this.underLimit(this.sends, caller.id, DISPATCH_SEND_MAX)) {
      this.blocked(caller.id, caller.id, target.id, 'rate_limit');
      return fail(
        'rate_limit',
        `More than ${DISPATCH_SEND_MAX} tasks in 10 minutes. Wait for results before sending more.`,
      );
    }
    const key = `dispatch:${caller.id}:${target.id}`;
    const replaced = this.deps.delivery.has(key);
    const message = workMessage(caller.name, text);
    const summary = oneSentence(text);
    const workId = randomUUID();
    const detail = { fromSessionId: caller.id, toSessionId: target.id, workId };
    this.deps.audit(caller.id, 'dispatch.send', JSON.stringify({ ...detail, summary }));
    this.deps.addEvent(caller.id, 'dispatch.send', { ...detail, summary });
    this.deps.delivery.enqueue(this.sendItem(caller, target, message, summary, workId, key));
    const now = this.deps.store.getSession(target.id);
    const busy = !now || now.status !== 'waiting_input' || this.deps.store.dispatchWork(target.id);
    return okJson({
      member: target.name,
      state: busy ? 'queued' : 'sent',
      ...(replaced
        ? { note: 'Replaced your previous task to this member that was not delivered yet.' }
        : {}),
      detail: busy
        ? `${target.name} is busy (${now?.status ?? 'unknown'}); the task is typed in when it waits for input.`
        : `Typed into ${target.name}.`,
      result: 'Its result comes back to you automatically as "[Result from …]".',
    });
  }

  private sendItem(
    caller: Session,
    target: Session,
    message: string,
    summary: string,
    workId: string,
    key: string,
  ): DeliveryItem {
    const detail = { fromSessionId: caller.id, toSessionId: target.id, workId };
    return {
      key,
      targetId: target.id,
      message,
      // 上一份工作還沒回報（還沒 Stop）就不送：送了會和它的結果混在一起。
      ready: (t) => t.status === 'waiting_input' && this.deps.store.dispatchWork(t.id) === null,
      check: () => {
        if (!this.deps.enabled()) return 'dispatch_disabled';
        const current = this.deps.store.getSession(caller.id);
        return current && isLive(current) ? null : 'caller_inactive';
      },
      dropped: (reason) => this.blocked(caller.id, caller.id, target.id, reason, workId),
      aborted: () => this.blocked(caller.id, caller.id, target.id, 'target_busy', workId),
      delivered: () => {
        const { store } = this.deps;
        store.setDispatchWork(target.id, {
          from: caller.id,
          workId,
          kind: 'send',
          at: this.deps.now().toISOString(),
        });
        // 分界要接在 daemon 事件之後（各台機器的時鐘不一定和 hub 相同），同交接。
        const { lastDaemonAt } = sessionReport(store, target.id, (e) => BOUNDARY.has(e.type));
        this.deps.audit(caller.id, 'dispatch.delivered', JSON.stringify(detail));
        this.deps.addEvent(
          target.id,
          'dispatch.delivered',
          { ...detail, summary },
          lastDaemonAt ?? undefined,
        );
      },
    };
  }

  // ── get_result ──────────────────────────────────────

  private getResult(caller: Session, raw: Record<string, unknown>): DispatchReply {
    const parsed = MemberArgs.safeParse(raw);
    if (!parsed.success) return fail('invalid_arguments', 'member is required.');
    const target = this.resolve(caller, parsed.data.member);
    if ('ok' in target) return target;
    const { store } = this.deps;
    const report = sessionReport(store, target.id, (e) => BOUNDARY.has(e.type));
    return okJson({
      member: target.name,
      status: target.endedAt === null ? target.status : 'ended',
      working: store.dispatchWork(target.id) !== null,
      summary: report.reply ? oneSentence(report.reply) : null,
      files: report.files.slice(0, 20).map(cleanLine),
      branch: target.branch,
    });
  }

  // ── 結果送回 ────────────────────────────────────────

  /** daemon 的 session 事件（hub 已確認來源機器）。成員回合結束（Stop）且手上有派工的工作 → 結果送回呼叫者一次。 */
  onEvent(event: SessionEvent): void {
    if (event.type !== 'hook' || event.payload.event !== 'Stop') return;
    const { store } = this.deps;
    const work = store.dispatchWork(event.sessionId);
    if (!work) return;
    // 先清掉：同一份工作只回報一次；結果本身送進呼叫者不算新的工作，不會再觸發任何自動送字。
    store.setDispatchWork(event.sessionId, null);
    this.deps.delivery.retry(event.sessionId);
    const member = store.getSession(event.sessionId);
    if (!member) return;
    const caller = store.getSession(work.from);
    const detail = { fromSessionId: member.id, toSessionId: work.from, workId: work.workId };
    if (!caller || !isLive(caller) || caller.status === 'done') {
      this.blocked(member.id, member.id, work.from, 'target_ended', work.workId);
      return;
    }
    if (!this.deps.enabled()) {
      this.blocked(member.id, member.id, caller.id, 'dispatch_disabled', work.workId);
      return;
    }
    if (!this.underLimit(this.results, caller.id, DISPATCH_RESULT_MAX)) {
      this.blocked(member.id, member.id, caller.id, 'rate_limit', work.workId);
      return;
    }
    const reply = event.payload.last_assistant_message;
    const summary = oneSentence(typeof reply === 'string' ? reply : '');
    const { files } = sessionReport(store, member.id, (e) => BOUNDARY.has(e.type));
    const message = resultMessage(member.name, { summary, files, branch: member.branch });
    this.deps.audit(member.id, 'dispatch.result', JSON.stringify({ ...detail, message }));
    this.deps.addEvent(member.id, 'dispatch.result', { ...detail, summary }, event.at);
    this.deps.delivery.enqueue({
      key: `dispatch-result:${member.id}:${work.workId}`,
      targetId: caller.id,
      message,
      check: () => (this.deps.enabled() ? null : 'dispatch_disabled'),
      dropped: (reason) => this.blocked(member.id, member.id, caller.id, reason, work.workId),
      aborted: () => this.blocked(member.id, member.id, caller.id, 'target_busy', work.workId),
      delivered: () => {
        this.deps.audit(member.id, 'dispatch.result_delivered', JSON.stringify(detail));
        this.deps.addEvent(caller.id, 'dispatch.result_delivered', { ...detail, summary });
      },
    });
  }

  /**
   * 使用者在成員上按 Esc／Ctrl+C：中斷的回合不會有 Stop，手上的工作就不會回報。清掉，下一則才送得進去；
   * 呼叫者之後可以用 get_result 看它做到哪。
   */
  onInterrupt(sessionId: string): void {
    const work = this.deps.store.dispatchWork(sessionId);
    if (!work) return;
    this.deps.store.setDispatchWork(sessionId, null);
    this.blocked(sessionId, sessionId, work.from, 'interrupted', work.workId);
    this.deps.delivery.retry(sessionId);
  }

  /** 成員結束或封存：手上的工作不會再有結果。 */
  onSessionChange(prev: Session, next: Session): void {
    if (!(isGone(next) && !isGone(prev))) return;
    const work = this.deps.store.dispatchWork(next.id);
    if (!work) return;
    this.deps.store.setDispatchWork(next.id, null);
    this.blocked(next.id, next.id, work.from, 'member_ended', work.workId);
  }

  /** 擋下或沒送出：audit 加事件（記在來源那一邊，畫布畫成擋下）。 */
  private blocked(
    at: string,
    fromSessionId: string,
    toSessionId: string,
    reason: string,
    workId?: string,
  ): void {
    const detail = { fromSessionId, toSessionId, reason, ...(workId ? { workId } : {}) };
    this.deps.audit(at, 'dispatch.blocked', JSON.stringify(detail));
    if (this.deps.store.getSession(at)) this.deps.addEvent(at, 'dispatch.blocked', detail);
  }
}
