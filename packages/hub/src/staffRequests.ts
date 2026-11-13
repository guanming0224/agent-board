// 加開申請（GM 2026-11-13，CONTRACTS §23）：隊長 spawn_member 碰到團隊總人數上限（team_full）或同隊 10 分鐘
// 新增上限（spawn_rate）時，dispatch.ts 不直接拒絕，改成在這裡記一件申請，GM 在收件匣同意或拒絕。
//   - 申請時記下完整的 spawn 參數；GM 同意 → 照參數再走一次 DispatchEngine 的 spawn，只略過申請時超過的上限
//     （全面板暫停、全隊暫停／停止、帳號限流、設定關掉等照舊，被擋就算失敗）。
//   - 拒絕、30 分鐘沒處理（失效）、開不起來都告訴隊長。
//   - 送給隊長的字一律走 SafeDelivery（只在隊長等輸入時送），開頭固定 `[Agent Board]`，內容是固定英文＋名稱與代碼，
//     不帶 Claude 寫的 prompt；推播只有隊長名稱與上限種類（不帶理由、prompt）。
//   - 同一隊同時最多一件待處理。存在 settings 表 `staffRequest:<id>`（不升 schema）：待處理的、以及已處理但通知
//     還沒送到隊長的；hub 重啟後重排失效計時器、重新排送通知。通知送到（或隊長已結束）就刪掉這一列。
// 中控台不呼叫模型：這裡只有固定規則與固定文字（docs/no-llm-review.md）。
import { randomUUID } from 'node:crypto';
import {
  STAFF_PROMPT_PREVIEW_MAX,
  StaffRequest,
  type Session,
  type StaffRequestLimit,
  type TeamActivityKind,
  type User,
} from '@agent-board/protocol';
import { z } from 'zod';
import type { SafeDelivery } from './delivery';
import type { StaffRequestPort } from './dispatch';
import { conflict, notFound } from './errors';
import { cleanLine } from './handoff';
import type { Store } from './store';

export const STAFF_REQUEST_PREFIX = 'staffRequest:';
const NAME_MAX = 60;
const MESSAGE_DETAIL_MAX = 300;

/** 存在 settings 表的樣子：給 GM 看的欄位，加上完整的 spawn 參數與還沒送到的通知。 */
const StoredStaffRequest = StaffRequest.extend({
  /** 隊長呼叫 spawn_member 時的參數（已驗證過；同意時照用）。 */
  args: z.record(z.string(), z.unknown()),
  /** 已處理、還沒送到隊長的通知（一行，`[Agent Board]` 開頭）。 */
  notice: z.string().optional(),
});
type StoredStaffRequest = z.infer<typeof StoredStaffRequest>;

const clip = (text: string, max: number) => {
  const chars = [...cleanLine(text)];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

const LIMIT_TEXT: Record<StaffRequestLimit, string> = {
  team_full: 'over the team size limit',
  spawn_rate: 'too many members added in 10 minutes',
};

/** 給 GM 看的：zod 預設丟掉 schema 以外的欄位，完整參數（args）與通知（notice）不會出去。 */
const publicView = (r: StoredStaffRequest): StaffRequest => StaffRequest.parse(r);

export interface StaffRequestDeps {
  store: Store;
  now(): Date;
  /** 多久沒處理就失效（預設 STAFF_REQUEST_TTL_MS；測試縮短）。 */
  ttlMs: number;
  delivery: SafeDelivery;
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void;
  /** 照申請開成員（hub 接到 DispatchEngine.spawnApproved）。 */
  spawn(
    leadId: string,
    args: Record<string, unknown>,
    bypass: readonly StaffRequestLimit[],
  ): { member: Session } | { code: string; message: string };
  /** 記一筆團隊動態（收件匣）。 */
  activity(entry: {
    kind: TeamActivityKind;
    request: StaffRequest;
    member?: Session;
    error?: string;
  }): void;
  /** 待處理清單變了：推 staff.requests。 */
  changed(items: StaffRequest[]): void;
  /** 新申請的推播（固定文字：隊長名稱＋上限種類）。 */
  notify(request: StaffRequest): void;
  guarded(label: string, fn: () => void): void;
}

export class StaffRequestEngine implements StaffRequestPort {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: StaffRequestDeps) {}

  // ── 讀寫 ────────────────────────────────────────────

  private all(): StoredStaffRequest[] {
    return this.deps.store
      .listRawJson(STAFF_REQUEST_PREFIX)
      .flatMap(({ value }) => {
        const parsed = StoredStaffRequest.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  private get(id: string): StoredStaffRequest | null {
    const parsed = StoredStaffRequest.safeParse(
      this.deps.store.getRawJson(`${STAFF_REQUEST_PREFIX}${id}`),
    );
    return parsed.success ? parsed.data : null;
  }

  private save(r: StoredStaffRequest): void {
    this.deps.store.setRawJson(`${STAFF_REQUEST_PREFIX}${r.id}`, r);
  }

  private remove(id: string): void {
    this.deps.store.setRawJson(`${STAFF_REQUEST_PREFIX}${id}`, null);
  }

  /** 待處理的（舊的在前）。 */
  list(): StaffRequest[] {
    return this.all()
      .filter((r) => r.status === 'pending')
      .map(publicView);
  }

  pendingFor(teamId: string): StaffRequest | null {
    const found = this.all().find((r) => r.status === 'pending' && r.teamId === teamId);
    return found ? publicView(found) : null;
  }

  // ── 申請 ────────────────────────────────────────────

  create(input: Parameters<StaffRequestPort['create']>[0]): StaffRequest {
    const { team, lead, limits, teamSize, teamLimit, args, reason } = input;
    const now = this.deps.now();
    const name = args.name ? clip(args.name, NAME_MAX) : '';
    const request: StoredStaffRequest = {
      id: randomUUID(),
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.deps.ttlMs).toISOString(),
      teamId: team.id,
      teamName: team.name,
      leadSessionId: lead.id,
      leadName: lead.name,
      limit: limits[0]!,
      limits,
      teamSize,
      teamLimit,
      role: args.role,
      ...(name ? { name } : {}),
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(args.useWorktree !== undefined ? { useWorktree: args.useWorktree } : {}),
      ...(args.model ? { model: clip(args.model, 100) } : {}),
      reason,
      promptPreview: clip(args.prompt, STAFF_PROMPT_PREVIEW_MAX),
      status: 'pending',
      args: { ...args, reason },
    };
    this.save(request);
    this.deps.audit(
      null,
      lead.id,
      'staff_request.created',
      JSON.stringify({
        requestId: request.id,
        teamId: team.id,
        limit: request.limit,
        limits,
        role: request.role,
        reason,
        teamSize,
        teamLimit,
      }),
    );
    const view = publicView(request);
    this.deps.activity({ kind: 'staff_requested', request: view });
    this.schedule(request);
    this.deps.changed(this.list());
    this.deps.notify(view);
    return view;
  }

  // ── GM 處理 ─────────────────────────────────────────

  /** 還在等的才能處理；到期了（計時器還沒跑到）先標成失效。 */
  private pending(id: string): StoredStaffRequest {
    const request = this.get(id);
    if (!request) throw notFound('Staff request');
    if (
      request.status === 'pending' &&
      Date.parse(request.expiresAt) <= this.deps.now().getTime()
    ) {
      this.expire(id);
      throw conflict('request_decided', 'This request is already expired.');
    }
    if (request.status !== 'pending') {
      throw conflict('request_decided', `This request is already ${request.status}.`);
    }
    return request;
  }

  approve(id: string, user: User): StaffRequest {
    const request = this.pending(id);
    this.clearTimer(id);
    const decided = {
      decidedAt: this.deps.now().toISOString(),
      decidedBy: user.name,
    };
    let result: ReturnType<StaffRequestDeps['spawn']>;
    try {
      result = this.deps.spawn(request.leadSessionId, request.args, request.limits);
    } catch {
      // 意料外的錯（不是 HttpError）：當成開不起來，申請不能卡在「待處理」。
      result = { code: 'internal', message: 'Agent Board could not start the member.' };
    }
    let next: StoredStaffRequest;
    if ('member' in result) {
      const member = result.member;
      next = {
        ...request,
        ...decided,
        status: 'approved',
        memberSessionId: member.id,
        memberName: member.name,
        notice: `[Agent Board] The user approved your request to add a member (${LIMIT_TEXT[request.limit]}). ${clip(member.name, NAME_MAX)} (${request.role}) has been started with your prompt; its result comes back to you as "[Result from ${clip(member.name, NAME_MAX)}] …" when it finishes its turn.`,
      };
      this.deps.audit(
        user.id,
        request.leadSessionId,
        'staff_request.approved',
        JSON.stringify({
          requestId: id,
          teamId: request.teamId,
          limits: request.limits,
          memberSessionId: member.id,
          memberName: member.name,
        }),
      );
      this.deps.activity({ kind: 'staff_approved', request: publicView(next), member });
    } else {
      next = {
        ...request,
        ...decided,
        status: 'failed',
        error: clip(result.code, 100),
        notice: `[Agent Board] The user approved your request to add a ${request.role} member, but it could not be started: ${clip(result.code, 100)}: ${clip(result.message, MESSAGE_DETAIL_MAX)}`,
      };
      this.deps.audit(
        user.id,
        request.leadSessionId,
        'staff_request.failed',
        JSON.stringify({ requestId: id, teamId: request.teamId, code: result.code }),
      );
      this.deps.activity({ kind: 'staff_failed', request: publicView(next), error: next.error });
    }
    this.finish(next);
    return publicView(next);
  }

  reject(id: string, user: User): StaffRequest {
    const request = this.pending(id);
    this.clearTimer(id);
    const next: StoredStaffRequest = {
      ...request,
      status: 'rejected',
      decidedAt: this.deps.now().toISOString(),
      decidedBy: user.name,
      notice: `[Agent Board] The user rejected your request to add a ${request.role} member. Nothing was started. Continue with your current members (send_task) or do the work yourself.`,
    };
    this.deps.audit(
      user.id,
      request.leadSessionId,
      'staff_request.rejected',
      JSON.stringify({ requestId: id, teamId: request.teamId }),
    );
    this.deps.activity({ kind: 'staff_rejected', request: publicView(next) });
    this.finish(next);
    return publicView(next);
  }

  /** 30 分鐘沒處理：失效，告訴隊長。 */
  private expire(id: string): void {
    this.clearTimer(id);
    const request = this.get(id);
    if (!request || request.status !== 'pending') return;
    const next: StoredStaffRequest = {
      ...request,
      status: 'expired',
      decidedAt: this.deps.now().toISOString(),
      notice: `[Agent Board] Your request to add a ${request.role} member expired: the user did not answer within ${Math.round(this.deps.ttlMs / 60_000)} minutes. Nothing was started. Continue with your current members; call spawn_member again later only if it is still needed.`,
    };
    this.deps.audit(
      null,
      request.leadSessionId,
      'staff_request.expired',
      JSON.stringify({ requestId: id, teamId: request.teamId }),
    );
    this.deps.activity({ kind: 'staff_expired', request: publicView(next) });
    this.finish(next);
  }

  /** 已處理：存下（等通知送到才刪）、排送通知、推新的待處理清單。 */
  private finish(next: StoredStaffRequest): void {
    this.save(next);
    this.enqueueNotice(next);
    this.deps.changed(this.list());
  }

  // ── 通知隊長 ────────────────────────────────────────

  private enqueueNotice(r: StoredStaffRequest): void {
    if (!r.notice) {
      this.remove(r.id);
      return;
    }
    const leadId = r.leadSessionId;
    const done = (action: string | null, reason?: string) => {
      this.remove(r.id);
      if (action) {
        this.deps.audit(
          null,
          leadId,
          action,
          JSON.stringify({ requestId: r.id, ...(reason ? { reason } : {}) }),
        );
      }
    };
    this.deps.delivery.enqueue({
      key: `staff-request:${r.id}`,
      targetId: leadId,
      message: r.notice,
      check: () => null,
      dropped: (reason) => done('staff_request.notice_dropped', reason),
      aborted: () => done('staff_request.notice_dropped', 'target_busy'),
      delivered: () => done('staff_request.notice_delivered'),
    });
  }

  // ── 計時與重啟 ──────────────────────────────────────

  private schedule(r: StoredStaffRequest): void {
    this.clearTimer(r.id);
    const delay = Math.max(0, Date.parse(r.expiresAt) - this.deps.now().getTime());
    const timer = setTimeout(() => {
      this.timers.delete(r.id);
      this.deps.guarded('staff request expire', () => this.expire(r.id));
    }, delay);
    timer.unref();
    this.timers.set(r.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /** hub 啟動：待處理的重排失效計時器（已過期的馬上失效）；已處理但通知還沒送到的重新排進送字佇列。 */
  restore(): void {
    for (const r of this.all()) {
      if (r.status === 'pending') this.schedule(r);
      else this.enqueueNotice(r);
    }
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
