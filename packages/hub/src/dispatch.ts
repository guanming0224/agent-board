// session 派工（GM 2026-11-06，CONTRACTS §11）：畫布上某個 session 裡的 Claude 透過 MCP 工具
// （daemon 掛的 `agent-board` server）自己開成員、送工作、收結果。全部是固定規則，不呼叫任何模型：
// 送進成員的字是 Claude 自己寫的工作內容（加上固定的 `[From …]` 開頭），送回的結果只有一句摘要＋檔案＋分支。
// 送字一律走 delivery.ts（只在目標等輸入時送，和交接、任務同一條佇列）。
// 隊長自主擴編（GM 2026-11-10，§11.1）：隊長自己新增（spawn_member，理由必填）、封存（release_member）成員；
// 團隊總人數上限看設定 `autoStaff.teamLimit`；每次都記 audit、session 事件、團隊動態（收件匣）並通知 GM。
// 守則文字（擴編節奏）在 protocol/src/leadGuide.ts，只放在工具說明與回傳裡，不會自己送字。
import { randomUUID } from 'node:crypto';
import {
  agentOf,
  AgentKind,
  AUTOSTAFF_OFF_GUIDE,
  DISPATCH_ROLES,
  DISPATCH_SPAWN_RATE_MAX,
  isReadOnlyMember,
  LEAD_STAFFING_REMINDER,
  MEMBER_STAFFING_GUIDE,
  STAFFING_REASON_MAX,
  TEAM_FULL_GUIDE,
  TEAM_HELD_GUIDE,
  TeamRole,
  type AutoStaff,
  PermissionMode,
  isAbsolutePath,
  ReviewRef,
  sameWorkingTree,
  type DispatchTool,
  type Review,
  type ReviewTargetInput,
  type DispatchWork,
  type Session,
  type SessionEvent,
  type SessionSpec,
  type Team,
  type TeamActivityKind,
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
  tester: 'QA',
};

/**
 * 會改檔案的角色：成員與測試（Q5：測試要跑測試、寫測試檔，不唯讀）。其他（研究、審查）開成唯讀。
 * 寫入者預設開自己的 worktree。
 */
export const isWriterRole = (role: (typeof DISPATCH_ROLES)[number]): boolean =>
  role === 'worker' || role === 'tester';

/** 角色的預設權限模式：成員 acceptEdits、測試 default（每步問，Q5）、研究與審查 plan。 */
export function defaultModeFor(role: (typeof DISPATCH_ROLES)[number]): PermissionMode {
  if (role === 'worker') return 'acceptEdits';
  if (role === 'tester') return 'default';
  return 'plan';
}
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
  const wanted = requested ?? defaultModeFor(role);
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
  reason: z.string(),
  permissionMode: PermissionMode.optional(),
  useWorktree: z.boolean().optional(),
  model: z.string().max(100).optional(),
  /** Codex 第二輪：開哪種 agent；沒給＝和呼叫者同一種。 */
  agent: AgentKind.optional(),
});
const SendArgs = z.object({ member: z.string().min(1), text: z.string().min(1) });
const MemberArgs = z.object({ member: z.string().min(1) });
const ReleaseArgs = z.object({ member: z.string().min(1), reason: z.string() });
const ReviewArgs = z.object({
  member: z.string().min(1).optional(),
  branch: ReviewRef.optional(),
  base: ReviewRef.optional(),
  repoPath: z.string().min(1).max(4096).refine(isAbsolutePath).optional(),
  reason: z.string(),
});

/** reason 必填（隊長自主擴編）：一行、清控制字元、截斷。空的回 null。 */
const reasonOf = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const text = clip(raw, STAFFING_REASON_MAX);
  return text ? text : null;
};

/** 正在跑（RUN）或正在開：人手資訊裡的 running 計數。 */
const isBusy = (s: Session) =>
  s.endedAt === null && (s.status === 'running' || s.status === 'starting');

/**
 * release_member 的保護：回合還沒結束的成員不能封存。除了 RUN／starting，還有等 GM 允許（GM 可能正在看權限框）
 * 與等 GM 審計畫——封存會讓 GM 的待決項直接消失、工作做到一半就斷。回傳擋下的原因（給隊長看的英文），可以封存是 null。
 */
const releaseBlock = (s: Session): string | null => {
  if (s.endedAt !== null) return null;
  switch (s.status) {
    case 'running':
      return 'working (RUN)';
    case 'starting':
      return 'starting';
    case 'waiting_permission':
      return 'waiting for the user to approve a tool (the user may be looking at it right now)';
    case 'plan_review':
      return 'waiting for the user to review its plan';
    default:
      return null;
  }
};

/** 團隊人數（含隊長、GM 配的；不含已封存的）。 */
export function teamSize(store: Store, teamId: string): number {
  return store.listTeamMembers(teamId).filter((m) => {
    const s = store.getSession(m.sessionId);
    return s !== null && !s.archived;
  }).length;
}

/** 每個角色有幾位、其中幾位在跑（RUN／starting）。 */
export type RoleCounts = Record<TeamMember['role'], { members: number; running: number }>;

/**
 * 隊長看的人手資訊（list_members、get_progress 共用）。不是隊長只回一句守則（向隊長回報，不能自己開人）。
 * addsLeft：這 10 分鐘還能新增幾位（同團隊的頻率上限）。
 */
export function staffingView(input: {
  store: Store;
  team: Team;
  isLead: boolean;
  autoStaff: AutoStaff;
  addsLeft: number;
}): Record<string, unknown> {
  const { store, team, isLead, autoStaff, addsLeft } = input;
  if (!isLead) return { guide: MEMBER_STAFFING_GUIDE };
  const roles = Object.fromEntries(
    TeamRole.options.map((r) => [r, { members: 0, running: 0 }]),
  ) as RoleCounts;
  for (const m of store.listTeamMembers(team.id)) {
    const s = store.getSession(m.sessionId);
    if (!s || s.archived) continue;
    const count = roles[m.role];
    count.members += 1;
    if (isBusy(s)) count.running += 1;
  }
  const size = Object.values(roles).reduce((n, r) => n + r.members, 0);
  const free = Math.max(0, autoStaff.teamLimit - size);
  const guide = !autoStaff.enabled
    ? AUTOSTAFF_OFF_GUIDE
    : free === 0
      ? `${LEAD_STAFFING_REMINDER} ${TEAM_FULL_GUIDE}`
      : LEAD_STAFFING_REMINDER;
  return {
    autoStaff: autoStaff.enabled,
    size,
    limit: autoStaff.teamLimit,
    free,
    roles,
    addsLeftThis10Minutes: autoStaff.enabled ? Math.min(addsLeft, free) : 0,
    guide,
  };
}

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
  /** 全部暫停中（P2 項目三）：不開新成員；送工作照收但排隊到繼續後才送。沒給＝不暫停。 */
  paused?(): boolean;
  /** 走 hub 開 session 的同一條路（排隊、worktree、hooks、第一個指令照常），記下是誰開的。 */
  createSession(
    input: SessionSpec & { machineId: string; zoneId?: string },
    dispatchedBy: string,
  ): Session;
  /** 機器在線才開得了 session；離線時回 false。 */
  machineOnline(machineId: string): boolean;
  /** 隊長自主擴編的設定（`Settings.autoStaff`）。 */
  autoStaff(): AutoStaff;
  /** 這個 session 的 Claude 帳號（同機器、同 CLAUDE_CONFIG_DIR）正在限流：不擴編。 */
  accountLimited(session: Session): boolean;
  /**
   * 封存成員：走 hub 的封存流程（停 session、暫停相關交接規則，可在設定→已封存還原，對話保留）。
   * 停不了（例如機器離線以外的錯）丟 HttpError。`by` 是下令的隊長（audit 用）。
   */
  archiveMember(member: Session, by: Session): void;
  /** 隊長新增或封存了成員：記團隊動態、推播（設定開著時）。 */
  teamActivity(entry: {
    kind: TeamActivityKind;
    team: Team;
    lead: Session;
    member: Session;
    role: TeamMember['role'];
    reason: string;
    reviewId?: string;
  }): void;
  /**
   * 交叉審查（Codex 第二輪）：隊長的 request_review。建好紀錄就回（diff 與兩邊審查在背景跑）；
   * 對象不在、機器離線、daemon 太舊時丟 HttpError。沒給＝這個 hub 不支援（測試）。
   */
  requestReview?(input: {
    lead: Session;
    teamId: string;
    target: ReviewTargetInput;
    reason: string;
  }): Review;
  /** 這一隊這個小時還能要求幾次審查（設定 `review.leadPerHour` 減去已用的）。 */
  reviewsLeft?(teamId: string): number;
  /** 設定的每小時上限（0＝隊長不能發起）。 */
  reviewLimit?(): number;
  /** 全面板（所有隊長合計）這個小時還能要求幾次（審查 W5）。 */
  boardReviewsLeft?(): number;
  /** 團隊成員變了：推 team.updated（畫面不等輪詢）。 */
  teamChanged(team: Team): void;
  /**
   * 等隊長／等成員結果（`Session.awaiting`，GM 2026-11-11）可能變了：hub 先記下 `ids` 現在的樣子、跑 `change`，
   * 有變的重新廣播；`notify` 時剛變成「等你」的照常推播。沒給＝直接跑 `change`（測試）。
   */
  awaitingChanged?(ids: readonly string[], change: () => void, notify: boolean): void;
}

/** 開始做事的狀態：成員從這裡開始新的回合，「等隊長」就結束（GM 2026-11-11）。 */
const TURN_STARTED: ReadonlySet<Session['status']> = new Set([
  'running',
  'starting',
  'waiting_permission',
  'plan_review',
]);

export class DispatchEngine {
  private readonly sends = new Map<string, number[]>();
  private readonly results = new Map<string, number[]>();
  /** 每個團隊（還沒有團隊時是呼叫者）10 分鐘內新增成員的時間。 */
  private readonly adds = new Map<string, number[]>();

  /** 寬限期到時重算成員與隊長的 awaiting（成員 id → 計時器）。 */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: DispatchDeps) {}

  /** hub 啟動：手上有工作、已經 waiting_input 的成員重新排寬限期計時器。 */
  resumeTimers(): void {
    for (const session of this.deps.store.listSessions(false)) this.scheduleGrace(session.id);
  }

  close(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  /**
   * 成員手上有工作、已經 waiting_input：寬限期（store.awaitingGraceMs）一到，它和隊長都不再算等隊長／等成員結果
   * （送字被吃掉、Stop 掉了、第一個指令沒送進去）。到時重算並照常推播。
   */
  private scheduleGrace(memberId: string): void {
    const { store } = this.deps;
    const deadline = store.awaitingGraceDeadline(memberId);
    const lead = store.dispatchWork(memberId)?.from;
    const old = this.graceTimers.get(memberId);
    if (old) clearTimeout(old);
    this.graceTimers.delete(memberId);
    if (deadline === null || lead === undefined) return;
    const timer = setTimeout(
      () => {
        this.graceTimers.delete(memberId);
        this.touch([memberId, lead], () => undefined);
      },
      Math.max(0, deadline - store.awaitingNow()) + 20,
    );
    timer.unref();
    this.graceTimers.set(memberId, timer);
  }

  /** 會影響 `ids` 的 awaiting 的變動，都包在這裡（見 DispatchDeps.awaitingChanged）。 */
  private touch(ids: readonly (string | null | undefined)[], change: () => void, notify = true) {
    const list = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    if (this.deps.awaitingChanged) this.deps.awaitingChanged(list, change, notify);
    else change();
  }

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
      case 'release_member':
        return this.release(caller, args);
      case 'request_review':
        return this.requestReview(caller, args);
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

  /** 呼叫者當隊長的團隊（可能不只一個）。 */
  private ledTeams(caller: Session): { team: Team; members: TeamMember[] }[] {
    return this.teamsOf(caller.id).filter(({ members }) =>
      members.some((m) => m.sessionId === caller.id && m.role === 'lead'),
    );
  }

  /** 10 分鐘內還能新增幾位（只看，不記）。 */
  private addsLeft(key: string): number {
    const now = this.deps.now().getTime();
    const recent = (this.adds.get(key) ?? []).filter((at) => now - at < DISPATCH_WINDOW_MS);
    this.adds.set(key, recent);
    return Math.max(0, DISPATCH_SPAWN_RATE_MAX - recent.length);
  }

  /** get_progress 也回人手資訊：呼叫者在這個團隊的角色決定看到什麼。 */
  staffingFor(caller: Session, team: Team): Record<string, unknown> {
    const isLead = this.deps.store
      .listTeamMembers(team.id)
      .some((m) => m.sessionId === caller.id && m.role === 'lead');
    return staffingView({
      store: this.deps.store,
      team,
      isLead,
      autoStaff: this.deps.autoStaff(),
      addsLeft: this.addsLeft(team.id),
    });
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
        staffing: this.staffingFor(caller, team),
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
              ...(m.added ? { addedReason: m.added.reason } : {}),
              working: store.dispatchWork(s.id) !== null,
            },
          ];
        }),
      };
    });
    const autoStaff = this.deps.autoStaff();
    return okJson({
      teams,
      ...(teams.length === 0
        ? {
            guide: autoStaff.enabled
              ? `You have no team yet. If the task needs more hands, spawn_member makes you the lead of a new team (size limit ${autoStaff.teamLimit}, you included). ${LEAD_STAFFING_REMINDER}`
              : AUTOSTAFF_OFF_GUIDE,
          }
        : {}),
    });
  }

  // ── spawn_member ────────────────────────────────────

  /** 呼叫者當隊長的團隊；沒有就它所在的第一個團隊；都沒有是 null（開成員時再開新團隊）。 */
  private teamOf(caller: Session): Team | null {
    const teams = this.teamsOf(caller.id);
    const led = teams.find(({ members }) =>
      members.some((m) => m.sessionId === caller.id && m.role === 'lead'),
    );
    return (led ?? teams[0])?.team ?? null;
  }

  /** 以呼叫者命名、它當隊長的新團隊。 */
  private createTeam(caller: Session): Team {
    const { store } = this.deps;
    const team: Team = {
      id: randomUUID(),
      name: caller.name,
      goal: '',
      doneCriteria: '',
      color: DEFAULT_TEAM_COLOR,
      contextMd: '',
      taskAuto: false,
      // 新團隊放在呼叫者目前所在的工作區（P2 §2.3：成員跟呼叫者同工作區）。
      zoneId: caller.zoneId,
    };
    store.upsertTeam(team);
    store.upsertTeamMember({ teamId: team.id, sessionId: caller.id, role: 'lead' });
    return team;
  }

  private spawn(caller: Session, raw: Record<string, unknown>): DispatchReply {
    if (this.deps.paused?.()) {
      const detail = { fromSessionId: caller.id, tool: 'spawn_member', reason: 'board_paused' };
      this.deps.audit(caller.id, 'dispatch.blocked', JSON.stringify(detail));
      return fail(
        'board_paused',
        'Agent Board is paused (the user pressed "pause all"); no new members can be started. Do not retry; wait for the user to resume, or do the work yourself.',
      );
    }
    if (!this.deps.autoStaff().enabled) {
      this.blockedTool(caller, 'spawn_member', 'autostaff_disabled');
      return fail('autostaff_disabled', AUTOSTAFF_OFF_GUIDE);
    }
    // 舊的呼叫（理由還不是必填時的寫法）：先講清楚缺什麼，再看其他參數。
    const reason = reasonOf(raw.reason);
    if (reason === null) {
      return fail(
        'reason_required',
        'spawn_member now requires reason: one short sentence on why the team needs this member (for example "No tester yet; the change needs regression tests"). It is shown to the user. Call spawn_member again with reason.',
      );
    }
    const parsed = SpawnArgs.safeParse(raw);
    if (!parsed.success) {
      return fail(
        'invalid_arguments',
        `role must be one of ${DISPATCH_ROLES.join(', ')}, and prompt and reason are required. ${parsed.error.issues
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
    // 在團隊裡、但不是任何一隊的隊長：不能自己開人（向隊長回報）。沒有團隊的 session 開第一位時自己當隊長。
    if (this.teamsOf(caller.id).length > 0 && this.ledTeams(caller).length === 0) {
      return fail('not_lead', MEMBER_STAFFING_GUIDE);
    }
    const readOnly = !isWriterRole(args.role);
    if (caller.readOnly && !readOnly) {
      return fail(
        'read_only_caller',
        'A read-only session cannot start members that edit files. Use role researcher or reviewer.',
      );
    }
    // 團隊層級的全隊暫停／停止（CONTRACTS §17）：新成員一開就會照 prompt 跑，所以也擋。
    if (this.teamOf(caller)?.hold) {
      this.blockedTool(caller, 'spawn_member', 'team_held');
      return fail('team_held', TEAM_HELD_GUIDE);
    }
    // Codex 第二輪：預設和呼叫者同一種 agent，隊長可以指定另一種（例如 Claude 隊長開 Codex 審查員）。
    // 帳號跟著 agent 走：Codex 沒有帳號資料夾；Codex 隊長開 Claude 用預設帳號。
    const callerAgent = agentOf(caller);
    const agent = args.agent ?? callerAgent;
    const accountProfile =
      agent === 'claude' && callerAgent === 'claude' ? caller.accountProfile : null;
    if (this.deps.accountLimited({ ...caller, agent, accountProfile })) {
      this.blockedTool(caller, 'spawn_member', 'account_rate_limited');
      return fail(
        'account_rate_limited',
        `This ${agent === 'codex' ? 'Codex' : 'Claude'} account is rate-limited on this machine right now; a new member would stop at the same limit. Do not add members until the limit resets; continue with the current members or yourself.`,
      );
    }
    // 從這裡的人數檢查到下面 upsertTeamMember 必須保持同步（中間不能 await）：Node 單執行緒，
    // 兩個同時的 spawn_member 才不會一起通過檢查而超過上限。
    const existingTeam = this.teamOf(caller);
    const { teamLimit } = this.deps.autoStaff();
    const size = existingTeam ? teamSize(store, existingTeam.id) : 1;
    if (size >= teamLimit) {
      const names = existingTeam
        ? store
            .listTeamMembers(existingTeam.id)
            .flatMap((m) => {
              const s = store.getSession(m.sessionId);
              return s && !s.archived && s.id !== caller.id
                ? [`${s.name} (${m.role}, ${s.status})`]
                : [];
            })
            .join(', ')
        : '';
      this.blockedTool(caller, 'spawn_member', 'team_full');
      return fail(
        'team_full',
        `Your team already has ${size} members (you included); the limit set by the user is ${teamLimit}. Members: ${names || 'none'}. release_member a member that has finished and will not be needed again, then try again — or reuse one with send_task.`,
      );
    }
    const rateKey = existingTeam?.id ?? caller.id;
    if (this.addsLeft(rateKey) === 0) {
      this.blockedTool(caller, 'spawn_member', 'spawn_rate_limit');
      return fail(
        'spawn_rate_limit',
        `More than ${DISPATCH_SPAWN_RATE_MAX} members added to this team in 10 minutes. Wait, and use the members you have (send_task).`,
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
    // 先檢查完才動資料庫：被擋下時不留下空的團隊。
    const existing = existingTeam;
    const members: TeamMember[] = existing
      ? store.listTeamMembers(existing.id)
      : [{ teamId: '', sessionId: caller.id, role: 'lead' }];
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
    const name = memberName(existing?.name ?? caller.name, args.role, wanted || undefined, taken);
    const message = workMessage(caller.name, prompt);
    const created = existing === null;
    const team = existing ?? this.createTeam(caller);
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
          // 模型名稱各家不同：換了 agent 就不沿用呼叫者的，用那個 CLI 自己的預設。
          model: args.model
            ? cleanLine(args.model) || (agent === callerAgent ? caller.model : null)
            : agent === callerAgent
              ? caller.model
              : null,
          accountProfile,
          ...(agent === 'codex' ? { agent } : {}),
          resumeClaudeSessionId: null,
          firstPrompt: message,
          readOnly,
          zoneId: team.zoneId,
        },
        caller.id,
      );
    } catch (error) {
      // 開不起來（機器剛斷線、資料夾正在刪除…）：剛開的團隊收掉。
      if (created) store.deleteTeam(team.id);
      if (error instanceof HttpError) return fail(error.code, error.message);
      throw error;
    }
    store.upsertTeamMember({ teamId: team.id, sessionId: member.id, role: args.role });
    const at = this.deps.now();
    store.setMemberAdded(member.id, {
      bySessionId: caller.id,
      byName: caller.name,
      reason,
      at: at.toISOString(),
    });
    this.adds.set(rateKey, [...(this.adds.get(rateKey) ?? []), at.getTime()]);
    if (rateKey !== team.id) this.adds.set(team.id, this.adds.get(rateKey) ?? []);
    const workId = randomUUID();
    const work: DispatchWork = {
      from: caller.id,
      workId,
      kind: 'spawn',
      at: this.deps.now().toISOString(),
    };
    this.touch([caller.id, member.id], () => store.setDispatchWork(member.id, work));
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
      reason,
      agent,
      teamSize: size + 1,
      teamLimit,
    };
    this.deps.audit(caller.id, 'dispatch.spawn', JSON.stringify({ ...detail, summary }));
    // 記在成員：畫布畫「呼叫者 → 成員」的送達；也是成員「改過的檔案」的分界。
    this.deps.addEvent(member.id, 'dispatch.spawn', { ...detail, summary });
    this.deps.teamActivity({
      kind: 'member_added',
      team,
      lead: caller,
      member,
      role: args.role,
      reason,
    });
    this.deps.teamChanged(team);
    return okJson({
      name,
      status: member.status,
      team: team.name,
      ...(created ? { teamCreated: true } : {}),
      role: args.role,
      agent,
      permissionMode: mode,
      ...(clamped ? { note: `permissionMode lowered to ${mode} (cannot exceed yours)` } : {}),
      readOnly,
      useWorktree,
      reason,
      teamSize: `${size + 1}/${teamLimit}`,
      result:
        'The prompt will be typed in once the session starts. Its result comes back to you automatically as "[Result from …]" when it finishes the turn. It is typed in only after your current turn ends, so end your turn now: do not sleep, poll or keep working just to wait for it.',
    });
  }

  // ── release_member ──────────────────────────────────

  /**
   * 隊長封存自己團隊的成員（空出名額）。保護：回合還沒結束的（RUN、starting、等 GM 允許、等 GM 審計畫）
   * 或還欠結果的（派工沒交回、送字還在排隊）不能封存、不能封存自己、只能封存自己當隊長的團隊的成員；
   * 全隊暫停／停止時擋。全部暫停時照樣可以封存、封存沒有頻率上限（GM 2026-11-10 決定拿掉這兩道）。
   * 走 hub 的封存流程，可以在設定→已封存還原。
   */
  private release(caller: Session, raw: Record<string, unknown>): DispatchReply {
    if (!this.deps.autoStaff().enabled) {
      this.blockedTool(caller, 'release_member', 'autostaff_disabled');
      return fail('autostaff_disabled', AUTOSTAFF_OFF_GUIDE);
    }
    const parsed = ReleaseArgs.safeParse(raw);
    const reason = reasonOf(raw.reason);
    if (!parsed.success || reason === null) {
      return fail(
        reason === null ? 'reason_required' : 'invalid_arguments',
        'member and reason are required: reason is one short sentence on why this member is no longer needed (shown to the user).',
      );
    }
    const { store } = this.deps;
    const led = this.ledTeams(caller);
    if (led.length === 0) return fail('not_lead', MEMBER_STAFFING_GUIDE);
    const ref = parsed.data.member.trim();
    const wanted = ref.toLowerCase();
    const candidates = led.flatMap(({ team, members }) =>
      members.flatMap((m) => {
        const s = store.getSession(m.sessionId);
        return s && !s.archived ? [{ team, member: m, session: s }] : [];
      }),
    );
    const found = candidates.find(
      ({ session }) => session.id === ref || session.name.toLowerCase() === wanted,
    );
    if (found?.session.id === caller.id) {
      return fail('cannot_release_self', 'You cannot release yourself. Only members of your team.');
    }
    if (!found) {
      const names = candidates.filter(({ session }) => session.id !== caller.id);
      return fail(
        'not_your_member',
        `"${clip(ref, NAME_MAX_CHARS)}" is not a member of a team you lead. You can release: ${
          names.length > 0 ? names.map(({ session }) => session.name).join(', ') : 'nobody'
        }.`,
      );
    }
    const { team, member, session: target } = found;
    if (team.hold) {
      this.blockedTool(caller, 'release_member', 'team_held', target.id);
      return fail('team_held', TEAM_HELD_GUIDE);
    }
    const inTurn = releaseBlock(target);
    if (inTurn !== null) {
      this.blockedTool(caller, 'release_member', 'member_busy', target.id);
      return fail(
        'member_busy',
        `${target.name} is ${inTurn}; it cannot be released now. Wait for it to finish the turn (its result comes back to you), then release it.`,
      );
    }
    // 還欠結果：手上的派工還沒交回，或送給它的工作還在排隊（封存了結果就回不來）。
    // 已經結束的 session 交不回結果了，不擋。
    if (
      target.endedAt === null &&
      (store.dispatchWork(target.id) !== null ||
        this.deps.delivery.has(`dispatch:${caller.id}:${target.id}`))
    ) {
      this.blockedTool(caller, 'release_member', 'member_busy', target.id);
      return fail(
        'member_busy',
        `${target.name} still owes you a result (a task you sent has not been delivered or answered yet). Wait for "[Result from ${target.name}]", then release it.`,
      );
    }
    try {
      this.deps.archiveMember(target, caller);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.code, error.message);
      throw error;
    }
    const detail = {
      fromSessionId: caller.id,
      toSessionId: target.id,
      teamId: team.id,
      name: target.name,
      role: member.role,
      reason,
    };
    this.deps.audit(caller.id, 'dispatch.release', JSON.stringify(detail));
    this.deps.addEvent(target.id, 'dispatch.release', detail);
    this.deps.teamActivity({
      kind: 'member_released',
      team,
      lead: caller,
      member: target,
      role: member.role,
      reason,
    });
    this.deps.teamChanged(team);
    const { teamLimit } = this.deps.autoStaff();
    return okJson({
      released: target.name,
      team: team.name,
      teamSize: `${teamSize(store, team.id)}/${teamLimit}`,
      note: 'Archived: its session is stopped and its conversation kept. The user can restore it from Settings → Archived.',
    });
  }

  /** 擴編被擋下：audit 加事件（記在呼叫者）。 */
  // ── request_review（交叉審查，Codex 第二輪）──────────────────

  /**
   * 隊長要求交叉審查。依序：沒帶理由 → reason_required；參數不對 → invalid_arguments；全部暫停 → board_paused；
   * 不是隊長 → not_lead；全隊暫停／停止 → team_held；設定上限 0 → review_disabled；這個小時用完 → review_rate_limit；
   * 對象不是自己團隊的成員 → not_your_member。跑模型的是 hub 的 ReviewEngine（no-llm 界線：只有這裡與 GM 的確認會觸發）。
   */
  private requestReview(caller: Session, raw: Record<string, unknown>): DispatchReply {
    const reason = reasonOf(raw.reason);
    if (reason === null) {
      return fail(
        'reason_required',
        'request_review requires reason: one short sentence on why this change needs a cross review now. It is shown to the user.',
      );
    }
    const parsed = ReviewArgs.safeParse(raw);
    if (
      !parsed.success ||
      (parsed.data.member === undefined) === (parsed.data.branch === undefined)
    ) {
      return fail(
        'invalid_arguments',
        'Give exactly one of member (a member of your team: its uncommitted changes) or branch (optional base, default main; optional repoPath, default your repository). Branch names cannot start with "-" or contain spaces or "..".',
      );
    }
    const args = parsed.data;
    if (!this.deps.requestReview || !this.deps.reviewsLeft) {
      return fail('review_unsupported', 'This Agent Board hub does not support cross reviews.');
    }
    if (this.deps.paused?.()) {
      this.blockedTool(caller, 'request_review', 'board_paused');
      return fail(
        'board_paused',
        'Agent Board is paused (the user pressed "pause all"); reviews cannot start now. Do not retry; wait for the user to resume.',
      );
    }
    const led = this.ledTeams(caller);
    if (led.length === 0) {
      return fail(
        'not_lead',
        'Only a team lead can request a cross review. If your work needs one, say so in your reply to your lead.',
      );
    }
    const team = led[0]!.team;
    if (team.hold) {
      this.blockedTool(caller, 'request_review', 'team_held');
      return fail(
        'team_held',
        'The user paused this team; do not request reviews until it is resumed.',
      );
    }
    const left = this.deps.reviewsLeft(team.id);
    if (this.deps.reviewLimit?.() === 0) {
      this.blockedTool(caller, 'request_review', 'review_disabled');
      return fail(
        'review_disabled',
        'The user does not allow team leads to request cross reviews. Ask the user if you need one.',
      );
    }
    if ((this.deps.boardReviewsLeft?.() ?? 1) <= 0) {
      this.blockedTool(caller, 'request_review', 'review_board_rate_limit');
      return fail(
        'review_board_rate_limit',
        'All teams together have used the cross reviews allowed this hour (limit set by the user). Try again later, or continue without one.',
      );
    }
    if (left <= 0) {
      this.blockedTool(caller, 'request_review', 'review_rate_limit');
      return fail(
        'review_rate_limit',
        'This team has used its cross reviews for this hour (limit set by the user). Try again later, or continue without one.',
      );
    }
    let targetSession: Session | null = null;
    let target: ReviewTargetInput;
    if (args.member !== undefined) {
      const found = this.resolve(caller, args.member);
      if ('ok' in found) return found;
      targetSession = found;
      target = { kind: 'session', sessionId: found.id };
    } else {
      // 審查 W1：隊長只能審自己或自己團隊成員所在的 repo（repoRoot／cwd），不能指定這台機器上任意資料夾。
      const allowed = new Set<string>();
      for (const s of [caller, ...this.reachable(caller)]) {
        if (s.machineId !== caller.machineId) continue;
        if (s.repoRoot) allowed.add(s.repoRoot);
        allowed.add(s.cwd);
      }
      const repoPath = args.repoPath ?? caller.repoRoot ?? caller.cwd;
      if (!allowed.has(repoPath)) {
        this.blockedTool(caller, 'request_review', 'invalid_repo');
        return fail(
          'invalid_repo',
          `repoPath must be your own repository or one of your members' (${[...allowed].join(', ')}).`,
        );
      }
      target = {
        kind: 'branch',
        machineId: caller.machineId,
        repoPath,
        branch: args.branch!,
        base: args.base ?? 'main',
      };
    }
    let review: Review;
    try {
      review = this.deps.requestReview({ lead: caller, teamId: team.id, target, reason });
    } catch (error) {
      if (error instanceof HttpError) {
        this.blockedTool(caller, 'request_review', error.code, targetSession?.id);
        return fail(error.code, error.message);
      }
      throw error;
    }
    this.deps.audit(
      caller.id,
      'dispatch.review',
      JSON.stringify({
        fromSessionId: caller.id,
        ...(targetSession ? { toSessionId: targetSession.id } : {}),
        reviewId: review.id,
        teamId: team.id,
        target: review.target.label,
        reason,
      }),
    );
    const role =
      (targetSession &&
        this.deps.store.listTeamMembers(team.id).find((m) => m.sessionId === targetSession.id)
          ?.role) ??
      'lead';
    this.deps.teamActivity({
      kind: 'review_requested',
      team,
      lead: caller,
      member: targetSession ?? caller,
      role,
      reason,
      reviewId: review.id,
    });
    return okJson({
      reviewId: review.id,
      status: review.status,
      target: review.target.label,
      reviewsLeftThisHour: Math.max(0, left - 1),
      result:
        'Claude and Codex review it in the background (read-only). When both finish, a one-line verdict from each is typed back to you as "[Review from Agent Board] …" after your current turn ends, so end your turn now: do not sleep or poll for it.',
    });
  }

  private blockedTool(caller: Session, tool: string, reason: string, toSessionId?: string): void {
    const detail = {
      fromSessionId: caller.id,
      tool,
      reason,
      ...(toSessionId ? { toSessionId } : {}),
    };
    this.deps.audit(caller.id, 'dispatch.blocked', JSON.stringify(detail));
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
    const paused = this.deps.paused?.() === true;
    return okJson({
      member: target.name,
      state: busy || paused ? 'queued' : 'sent',
      ...(replaced
        ? { note: 'Replaced your previous task to this member that was not delivered yet.' }
        : {}),
      detail: paused
        ? `Agent Board is paused; the task is typed into ${target.name} after the user resumes.`
        : busy
          ? `${target.name} is busy (${now?.status ?? 'unknown'}); the task is typed in when it waits for input.`
          : `Typed into ${target.name}.`,
      result: 'Its result comes back to you automatically as "[Result from …]". It is typed in only after your current turn ends, so end your turn now: do not sleep, poll or keep working just to wait for it.',
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
        // 隊長可能已經停下（等你）：從這裡起它是「等成員結果」。成員收到新工作，上一輪的「等隊長」結束。
        this.touch([caller.id, target.id], () => {
          store.setDispatchWork(target.id, {
            from: caller.id,
            workId,
            kind: 'send',
            at: this.deps.now().toISOString(),
          });
          store.clearMemberAwaiting(target.id);
        });
        this.scheduleGrace(target.id);
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
    if (event.type !== 'hook') return;
    const hook = event.payload.event;
    if (hook !== 'Stop' && hook !== 'UserPromptSubmit') return;
    const { store } = this.deps;
    const work = store.dispatchWork(event.sessionId);
    if (!work) {
      // 沒有派工的回合（GM 直接對成員下指令）：不再是等隊長，停下時照常 ASK、照常推播。
      // UserPromptSubmit 時它馬上就要開始做事，不推播；Stop 才推。
      if (store.membersAwaitingAny(event.sessionId)) {
        this.touch(
          [event.sessionId],
          () => store.clearMemberAwaiting(event.sessionId),
          hook === 'Stop',
        );
      }
      return;
    }
    if (hook !== 'Stop') return;
    // 成員（Stop 前可能已經是 waiting_input、先算成等隊長）與隊長（少了一份工作）的 awaiting 都可能變。
    this.touch([event.sessionId, work.from], () => this.reportResult(event, work));
  }

  private reportResult(event: SessionEvent, work: DispatchWork): void {
    const { store } = this.deps;
    // 先清掉：同一份工作只回報一次；結果本身送進呼叫者不算新的工作，不會再觸發任何自動送字。
    store.setDispatchWork(event.sessionId, null);
    // 這一次沒送回（下面擋下的情況）就沒有人會接手，照常 ASK；送到才標「等隊長」。
    store.clearMemberAwaiting(event.sessionId);
    this.scheduleGrace(event.sessionId);
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
    const key = `dispatch-result:${member.id}:${work.workId}`;
    // 排隊中：成員「等隊長」、隊長「等成員結果」，只記在記憶體（佇列本身也只在記憶體，hub 重啟就一起沒了）。
    store.setResultPending(caller.id, member.id, key, true);
    // 送到了：成員寫進 settings（到它開始下一個回合前都是「等隊長」），隊長馬上會開始讀結果，不推播。
    // 沒送成：兩邊都變回照常，變回在等你就推播。成員在這期間自己開始過新回合就不標。
    const settle = (delivered: boolean) =>
      this.touch(
        [caller.id, member.id],
        () => {
          const still = store.setResultPending(caller.id, member.id, key, false);
          if (delivered && still) store.setAwaitingLead(member.id, caller.id);
        },
        !delivered,
      );
    this.deps.delivery.enqueue({
      key,
      targetId: caller.id,
      message,
      check: () => (this.deps.enabled() ? null : 'dispatch_disabled'),
      dropped: (reason) => {
        settle(false);
        this.blocked(member.id, member.id, caller.id, reason, work.workId);
      },
      aborted: () => {
        settle(false);
        this.blocked(member.id, member.id, caller.id, 'target_busy', work.workId);
      },
      delivered: () => {
        settle(true);
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
    this.touch([sessionId, work.from], () => this.deps.store.setDispatchWork(sessionId, null));
    this.blocked(sessionId, sessionId, work.from, 'interrupted', work.workId);
    this.deps.delivery.retry(sessionId);
  }

  /**
   * 成員結束或封存：手上的工作不會再有結果。
   * 「等隊長」在成員開始下一個回合（或結束、封存）時清掉；隊長結束或封存時，在等它的成員改回照常並推播
   * （GM 2026-11-11）。隊長進出離線、成員狀態變了，隊長與成員的 awaiting 都重算。
   */
  onSessionChange(prev: Session, next: Session): void {
    const { store } = this.deps;
    const gone = isGone(next) && !isGone(prev);
    const statusChanged = prev.status !== next.status;
    if (
      store.membersAwaitingAny(next.id) &&
      (gone || (statusChanged && TURN_STARTED.has(next.status)))
    ) {
      store.clearMemberAwaiting(next.id);
    }
    // 這個 session 當隊長：在等它的成員、手上有它的工作的成員。
    const offlineFlip = statusChanged && (prev.status === 'offline' || next.status === 'offline');
    if (gone || offlineFlip) {
      const waiting = store.membersAwaiting(next.id);
      const related = [...waiting, ...store.membersWorkingFor(next.id)];
      if (related.length > 0) {
        this.touch(
          related,
          () => {
            if (gone) for (const id of waiting) store.clearMemberAwaiting(id);
          },
          // 機器斷線、重連常常只是一下子，不推播；隊長結束、封存才推播（GM 2026-11-11）。
          gone,
        );
      }
    }
    const work = store.dispatchWork(next.id);
    if (!work) return;
    if (gone) {
      this.touch([work.from], () => store.setDispatchWork(next.id, null));
      this.scheduleGrace(next.id);
      this.blocked(next.id, next.id, work.from, 'member_ended', work.workId);
      return;
    }
    // 這個 session 當成員：狀態變了，隊長算不算「等成員結果」可能跟著變（例如成員限流、出錯）。
    if (statusChanged) {
      this.touch([work.from], () => undefined, !offlineFlip);
      this.scheduleGrace(next.id);
    }
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
