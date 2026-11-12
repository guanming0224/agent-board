// 交叉審查（Codex 第二輪，GM 2026-11-12，docs/codex-round2-spec.md §2、CONTRACTS §22）。
// hub 只管流程與紀錄：請 daemon 產生 diff（不跑模型）→ GM 看檔案清單按確認（隊長發起的跳過確認）→
// 請 daemon 跑兩邊（`review.run`）→ 收兩邊的結果、存表、廣播、進收件匣、推播「審查完成」、隊長發起的把摘要送回隊長。
// no-llm 界線（docs/no-llm-review.md「交叉審查」）：`review.run` 只能由 `startReview` 送出，而 `startReview` 只有
// 兩個呼叫者：GM 的 REST 動作（rest.ts）與隊長的 MCP 工具 `request_review`（dispatch.ts）。不能由排程、規則、
// 或任何自動流程觸發（scripts/check-no-llm.mjs 檢查）。
import { randomUUID } from 'node:crypto';
import {
  DAEMON_FEATURES,
  pendingSide,
  Review,
  REVIEW_BOARD_KEEP,
  REVIEW_INSTRUCTIONS_VERSION,
  REVIEW_TIMEOUT_MS,
  ReviewDiffSummary,
  ReviewRequester,
  ReviewSide,
  reviewSideFinished,
  ReviewTarget,
  type HubToDaemon,
  type Machine,
  type ReviewSettings,
  type ReviewTargetInput,
  type Session,
} from '@agent-board/protocol';
import { z } from 'zod';
import type { SafeDelivery } from './delivery';
import { conflict, HttpError, notFound } from './errors';
import { cleanLine } from './handoff';
import type { Store } from './store';

/** 等 daemon 產生 diff 的上限（大 repo 的 git diff）。 */
export const REVIEW_PREPARE_TIMEOUT_MS = 60_000;
/** 跑太久才算失敗：每一邊的逾時再多給這麼久（daemon 收尾、斷線重連補送）。 */
const REVIEW_EXPIRE_GRACE_MS = 2 * 60_000;
/** 送回隊長的摘要，每一邊最多幾個字。 */
const LEAD_SUMMARY_CHARS = 300;
const HOUR_MS = 60 * 60_000;

// ── 資料表（schema v11 `reviews`）──────────────────────────

interface Row {
  id: string;
  requested_by: string;
  team_id: string | null;
  reason: string;
  machine_id: string;
  target: string;
  status: string;
  error: string | null;
  diff: string | null;
  claude: string;
  codex: string;
  instructions_version: number;
  read: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const parseJson = <T>(schema: z.ZodType<T>, text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
};

function fromRow(row: Row): Review {
  return {
    id: row.id,
    requestedBy: parseJson(ReviewRequester, row.requested_by, { kind: 'user', id: null, name: '' }),
    teamId: row.team_id,
    reason: row.reason,
    machineId: row.machine_id,
    target: parseJson(ReviewTarget, row.target, {
      kind: 'session',
      label: '',
      sessionId: null,
      cwd: '',
      branch: null,
      base: null,
    }),
    status: Review.shape.status.catch('failed').parse(row.status),
    error: row.error,
    diff: parseJson(ReviewDiffSummary.nullable(), row.diff, null),
    claude: parseJson(ReviewSide, row.claude, pendingSide('claude')),
    codex: parseJson(ReviewSide, row.codex, pendingSide('codex')),
    instructionsVersion: row.instructions_version,
    read: row.read !== 0,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** `reviews` 表的讀寫（store.db 直接用，和其他表同一個連線、同一個交易規則）。 */
export class ReviewStore {
  constructor(private readonly store: Store) {}

  get(id: string): Review | null {
    const row = this.store.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** 新的在前。 */
  list(limit = REVIEW_BOARD_KEEP): Review[] {
    return (
      this.store.db
        .prepare('SELECT * FROM reviews ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(limit) as Row[]
    ).map(fromRow);
  }

  listByStatus(statuses: readonly Review['status'][]): Review[] {
    const marks = statuses.map(() => '?').join(',');
    return (
      this.store.db
        .prepare(`SELECT * FROM reviews WHERE status IN (${marks}) ORDER BY created_at`)
        .all(...statuses) as Row[]
    ).map(fromRow);
  }

  save(review: Review): void {
    this.store.db
      .prepare(
        `INSERT INTO reviews (id, requested_by, team_id, reason, machine_id, target, status, error, diff,
           claude, codex, instructions_version, read, created_at, started_at, completed_at)
         VALUES (@id, @requested_by, @team_id, @reason, @machine_id, @target, @status, @error, @diff,
           @claude, @codex, @instructions_version, @read, @created_at, @started_at, @completed_at)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, error = excluded.error,
           diff = excluded.diff, claude = excluded.claude, codex = excluded.codex,
           read = excluded.read, started_at = excluded.started_at, completed_at = excluded.completed_at`,
      )
      .run({
        id: review.id,
        requested_by: JSON.stringify(review.requestedBy),
        team_id: review.teamId,
        reason: review.reason,
        machine_id: review.machineId,
        target: JSON.stringify(review.target),
        status: review.status,
        error: review.error,
        diff: review.diff === null ? null : JSON.stringify(review.diff),
        claude: JSON.stringify(review.claude),
        codex: JSON.stringify(review.codex),
        instructions_version: review.instructionsVersion,
        read: review.read ? 1 : 0,
        created_at: review.createdAt,
        started_at: review.startedAt,
        completed_at: review.completedAt,
      });
  }

  /** 保留期限（同 session_events）：建立時間早於 cutoff、而且已經結束的刪掉。回傳刪了幾筆。 */
  prune(cutoff: string): number {
    return this.store.db
      .prepare(
        "DELETE FROM reviews WHERE created_at < ? AND status IN ('done', 'failed', 'cancelled')",
      )
      .run(cutoff).changes;
  }

  /** 隊長發起的次數（頻率上限用）：這一隊在 since 之後建立的。 */
  countLeadRequests(teamId: string, since: string): number {
    const row = this.store.db
      .prepare(
        `SELECT count(*) AS n FROM reviews WHERE team_id = ? AND created_at >= ?
           AND json_extract(requested_by, '$.kind') = 'lead'`,
      )
      .get(teamId, since) as { n: number };
    return row.n;
  }
}

// ── 流程 ────────────────────────────────────────────────

export interface ReviewRequest {
  target: ReviewTargetInput;
  requestedBy: ReviewRequester;
  reason: string;
  teamId: string | null;
}

export interface ReviewDeps {
  store: Store;
  now(): Date;
  delivery: SafeDelivery;
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void;
  /** 審查變了：推 `review.updated` 給每個 client。 */
  broadcast(review: Review): void;
  /** 那台機器在線時的協定功能（hello 宣告的）；離線是 null。 */
  features(machineId: string): ReadonlySet<string> | null;
  machine(machineId: string): Machine | null;
  /** 送給那台機器的 daemon；離線回 false。 */
  send(machineId: string, message: HubToDaemon): boolean;
  /** 請 daemon 產生 diff（hub 的 askDaemon）。 */
  prepare(
    machineId: string,
    message: (requestId: string) => Extract<HubToDaemon, { type: 'review.prepare' }>,
  ): Promise<{ diff: ReviewDiffSummary | null; error: string | null }>;
  settings(): ReviewSettings;
  /** 推播（只說「審查完成」或「隊長要求審查」，不帶內容）。 */
  notify(event: { kind: 'done' | 'requested'; review: Review; lead?: string }): void;
  guarded(label: string, fn: () => void): void;
}

const stamp = (date: Date) => date.toISOString();

/** 一邊的意見取「整體結論」那段的第一句；找不到就取最後一行。固定規則，不解讀內容。 */
export function verdictLine(side: ReviewSide): string {
  if (side.status !== 'done') {
    return side.status === 'skipped'
      ? `skipped (${side.error ?? 'not run'})`
      : `${side.status}${side.error ? ` (${cleanLine(side.error).slice(0, 120)})` : ''}`;
  }
  const text = side.output ?? '';
  const at = text.search(/整體結論|verdict/i);
  const tail = at >= 0 ? text.slice(at).replace(/^[^\n:：]*[:：]?/, '') : '';
  const lines = (tail || text).split('\n').map(cleanLine).filter(Boolean);
  const pick = (at >= 0 ? lines[0] : lines.at(-1)) ?? '';
  const chars = [...pick];
  return chars.length > LEAD_SUMMARY_CHARS
    ? `${chars.slice(0, LEAD_SUMMARY_CHARS).join('')}…`
    : pick || '(empty)';
}

/** 沒跑成（diff 產生不了、daemon 斷線、取消）時送回隊長的一行。 */
export const reviewFailedMessage = (review: Review): string =>
  `[Review from Agent Board] ${cleanLine(review.target.label)} | not run: ${review.error ?? review.status}`;

/** 送回隊長的一行（和 `[Result from …]` 同一種固定格式，內容先清控制字元）。 */
export function leadSummaryMessage(review: Review): string {
  return [
    `[Review from Agent Board] ${cleanLine(review.target.label)}`,
    `Claude: ${verdictLine(review.claude)}`,
    `Codex: ${verdictLine(review.codex)}`,
    'Full review is in the Agent Board inbox.',
  ].join(' | ');
}

export class ReviewEngine {
  readonly table: ReviewStore;

  constructor(private readonly deps: ReviewDeps) {
    this.table = new ReviewStore(deps.store);
  }

  list(): Review[] {
    return this.table.list();
  }

  get(id: string): Review {
    const review = this.table.get(id);
    if (!review) throw notFound('Review');
    return review;
  }

  private update(review: Review): Review {
    this.table.save(review);
    this.deps.broadcast(review);
    return review;
  }

  /** hub 重啟：上一輪沒跑完的（daemon 那邊的程序已經沒人收結果）標成失敗。 */
  recover(): void {
    for (const review of this.table.listByStatus(['preparing', 'awaiting_confirm', 'running'])) {
      this.failReview(review, 'hub_restarted');
    }
  }

  /** 對象換成 daemon 要的資料夾與描述。 */
  resolveTarget(input: ReviewTargetInput): { machineId: string; target: ReviewTarget } {
    if (input.kind === 'session') {
      const session = this.deps.store.getSession(input.sessionId);
      if (!session || session.archived) throw notFound('Session');
      return {
        machineId: session.machineId,
        target: {
          kind: 'session',
          label: `${session.name}: uncommitted changes`,
          sessionId: session.id,
          cwd: session.cwd,
          branch: session.branch,
          base: null,
        },
      };
    }
    if (!this.deps.machine(input.machineId)) throw notFound('Machine');
    const name = input.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? input.repoPath;
    return {
      machineId: input.machineId,
      target: {
        kind: 'branch',
        label: `${name}: ${input.branch} vs ${input.base}`,
        sessionId: null,
        cwd: input.repoPath,
        branch: input.branch,
        base: input.base,
      },
    };
  }

  private requireReviewDaemon(machineId: string): void {
    const features = this.deps.features(machineId);
    if (!features) throw conflict('machine_offline', 'Machine is offline');
    if (!features.has(DAEMON_FEATURES.review)) {
      throw conflict('review_unsupported', 'The daemon on this machine is too old for reviews');
    }
  }

  /**
   * 產生 diff（不跑模型）。GM 發起的停在 awaiting_confirm 等確認；回傳時 diff 已經好了（或失敗）。
   * 隊長發起的由 requestByLead 接著自動 start。
   */
  async prepare(input: ReviewRequest): Promise<Review> {
    return this.fillDiff(this.create(input));
  }

  /** 建紀錄（preparing）。對象不在、機器離線、daemon 太舊時丟 HttpError，不留紀錄。 */
  create(input: ReviewRequest): Review {
    const { machineId, target } = this.resolveTarget(input.target);
    this.requireReviewDaemon(machineId);
    const review = this.update({
      id: randomUUID(),
      requestedBy: input.requestedBy,
      teamId: input.teamId,
      reason: input.reason,
      machineId,
      target,
      status: 'preparing',
      error: null,
      diff: null,
      claude: pendingSide('claude'),
      codex: pendingSide('codex'),
      instructionsVersion: REVIEW_INSTRUCTIONS_VERSION,
      read: false,
      createdAt: stamp(this.deps.now()),
      startedAt: null,
      completedAt: null,
    });
    this.deps.audit(
      input.requestedBy.kind === 'user' ? input.requestedBy.id : null,
      input.requestedBy.kind === 'lead' ? input.requestedBy.id : target.sessionId,
      'review.prepare',
      JSON.stringify({
        reviewId: review.id,
        machineId,
        target: target.label,
        by: input.requestedBy,
        reason: input.reason,
      }),
    );
    return review;
  }

  /** 請 daemon 產生 diff；好了是 awaiting_confirm，沒有變更或失敗是 failed。 */
  private async fillDiff(created: Review): Promise<Review> {
    const { target } = created;
    let reply: { diff: ReviewDiffSummary | null; error: string | null };
    try {
      reply = await this.deps.prepare(created.machineId, (requestId) => ({
        type: 'review.prepare',
        requestId,
        reviewId: created.id,
        kind: target.kind,
        cwd: target.cwd,
        branch: target.branch,
        base: target.base,
      }));
    } catch (error) {
      reply = { diff: null, error: error instanceof HttpError ? error.code : 'prepare_failed' };
    }
    const review = this.table.get(created.id) ?? created;
    // 等的期間被取消了：不蓋回去。
    if (review.status !== 'preparing') return review;
    if (reply.error !== null || reply.diff === null) {
      return this.failReview(review, reply.error ?? 'prepare_failed');
    }
    if (reply.diff.files.length === 0) {
      return this.failReview({ ...review, diff: reply.diff }, 'no_changes');
    }
    return this.update({ ...review, status: 'awaiting_confirm', diff: reply.diff });
  }

  /**
   * 跑審查：送 `review.run`。**只有兩個呼叫者**：GM 在網頁按確認（rest.ts）、隊長的 `request_review`
   * （dispatch.ts 經 requestByLead）。不可從排程、規則或任何自動流程呼叫（no-llm 界線，check-no-llm 檢查）。
   */
  startReview(id: string, by: ReviewRequester): Review {
    const review = this.get(id);
    if (review.status !== 'awaiting_confirm') {
      throw conflict(
        'review_not_ready',
        `Review is ${review.status}, not waiting for confirmation`,
      );
    }
    this.requireReviewDaemon(review.machineId);
    const machine = this.deps.machine(review.machineId);
    const features = this.deps.features(review.machineId) ?? new Set<string>();
    const settings = this.deps.settings();
    // Windows 只跑 Claude（Codex 在 Windows 擋掉，§19／W5）；沒有 codex 的機器也只跑 Claude。
    const codexSkip =
      machine?.os === 'win32'
        ? 'windows: Codex is not available on Windows machines yet; only Claude reviewed this change.'
        : !features.has(DAEMON_FEATURES.codex)
          ? 'codex_unavailable: Codex CLI was not found on this machine.'
          : null;
    const session = review.target.sessionId
      ? this.deps.store.getSession(review.target.sessionId)
      : null;
    const sent = this.deps.send(review.machineId, {
      type: 'review.run',
      reviewId: review.id,
      claude: {
        model: settings.claudeModel,
        // 審查對象是 Claude session 時用它的帳號；其他用預設帳號。
        accountProfile:
          session && (session.agent ?? 'claude') === 'claude' ? session.accountProfile : null,
      },
      codex: codexSkip ? null : { model: settings.codexModel, effort: settings.codexEffort },
    });
    if (!sent) throw conflict('machine_offline', 'Machine is offline');
    const now = stamp(this.deps.now());
    this.deps.audit(
      by.kind === 'user' ? by.id : null,
      review.target.sessionId,
      'review.start',
      JSON.stringify({ reviewId: review.id, by, codex: codexSkip === null }),
    );
    return this.update({
      ...review,
      status: 'running',
      startedAt: now,
      claude: { ...pendingSide('claude'), status: 'running', model: settings.claudeModel },
      codex: codexSkip
        ? { ...pendingSide('codex'), status: 'skipped', error: codexSkip }
        : { ...pendingSide('codex'), status: 'running', model: settings.codexModel },
    });
  }

  cancel(id: string, userId: string): Review {
    const review = this.get(id);
    if (review.status === 'done' || review.status === 'failed' || review.status === 'cancelled') {
      return review;
    }
    this.deps.send(review.machineId, { type: 'review.cancel', reviewId: id });
    this.deps.audit(
      userId,
      review.target.sessionId,
      'review.cancel',
      JSON.stringify({ reviewId: id }),
    );
    const now = stamp(this.deps.now());
    const stop = (side: ReviewSide): ReviewSide =>
      reviewSideFinished(side) ? side : { ...side, status: 'failed', error: 'cancelled' };
    return this.update({
      ...review,
      status: 'cancelled',
      completedAt: now,
      claude: stop(review.claude),
      codex: stop(review.codex),
    });
  }

  markRead(ids: readonly string[] | undefined, userId: string): Review[] {
    const targets = ids ? ids.flatMap((id) => this.table.get(id) ?? []) : this.table.list();
    for (const review of targets) {
      if (!review.read) this.update({ ...review, read: true });
    }
    this.deps.audit(userId, null, 'review.read', JSON.stringify({ ids: ids ?? 'all' }));
    return this.table.list();
  }

  /** daemon 回報某一邊的狀態（hub 已確認來源機器）。兩邊都結束 → done、進收件匣、推播、送回隊長。 */
  onSide(machineId: string, reviewId: string, side: ReviewSide): void {
    const review = this.table.get(reviewId);
    if (!review || review.machineId !== machineId || review.status !== 'running') return;
    const key = side.agent;
    // 已經結束的那一邊不再改（例如逾時後晚到的結果）。
    if (reviewSideFinished(review[key])) return;
    const next: Review = { ...review, [key]: { ...side, agent: key } };
    if (!reviewSideFinished(next.claude) || !reviewSideFinished(next.codex)) {
      this.update(next);
      return;
    }
    this.finish({ ...next, status: 'done', completedAt: stamp(this.deps.now()) });
  }

  /**
   * 跑太久的（daemon 重啟、結果一直沒送回來）標成失敗：比每一邊的逾時多給 2 分鐘。daemon 只是斷線重連時
   * 結果會補送，所以斷線本身不算失敗。只會結束審查，不會開始任何審查（hub 心跳呼叫）。
   */
  expire(): void {
    const now = this.deps.now().getTime();
    for (const review of this.table.listByStatus(['preparing', 'running'])) {
      const since = Date.parse(review.startedAt ?? review.createdAt);
      const limit =
        review.status === 'running'
          ? REVIEW_TIMEOUT_MS + REVIEW_EXPIRE_GRACE_MS
          : REVIEW_PREPARE_TIMEOUT_MS + REVIEW_EXPIRE_GRACE_MS;
      if (now - since > limit) this.failReview(review, 'no_result');
    }
  }

  private failReview(review: Review, error: string): Review {
    const stop = (side: ReviewSide): ReviewSide =>
      reviewSideFinished(side) || review.status !== 'running'
        ? side
        : { ...side, status: 'failed', error };
    const failed: Review = {
      ...review,
      status: 'failed',
      error,
      completedAt: stamp(this.deps.now()),
      claude: stop(review.claude),
      codex: stop(review.codex),
    };
    if (review.status === 'running') return this.finish(failed);
    return this.update(failed);
  }

  private finish(review: Review): Review {
    this.update(review);
    this.deps.audit(
      null,
      review.target.sessionId,
      'review.done',
      JSON.stringify({
        reviewId: review.id,
        status: review.status,
        claude: review.claude.status,
        codex: review.codex.status,
      }),
    );
    this.deps.guarded('review notify', () => this.deps.notify({ kind: 'done', review }));
    if (review.requestedBy.kind === 'lead' && review.requestedBy.id) {
      this.deliverToLead(review, review.requestedBy.id);
    }
    return review;
  }

  /** 結果摘要送回發起的隊長（SafeDelivery，只在它等輸入時送）。送不到只記 audit，GM 在收件匣照樣看得到。 */
  private deliverToLead(review: Review, leadId: string): void {
    const lead = this.deps.store.getSession(leadId);
    if (!lead || lead.archived || lead.endedAt !== null) return;
    const message =
      review.status === 'done' ? leadSummaryMessage(review) : reviewFailedMessage(review);
    this.deps.delivery.enqueue({
      key: `review-result:${review.id}`,
      targetId: leadId,
      message,
      check: () => null,
      dropped: (reason) =>
        this.deps.audit(
          null,
          leadId,
          'review.result_blocked',
          JSON.stringify({ reviewId: review.id, reason }),
        ),
      aborted: () =>
        this.deps.audit(
          null,
          leadId,
          'review.result_blocked',
          JSON.stringify({ reviewId: review.id, reason: 'target_busy' }),
        ),
      delivered: () =>
        this.deps.audit(
          null,
          leadId,
          'review.result_delivered',
          JSON.stringify({ reviewId: review.id }),
        ),
    });
  }

  // ── 隊長的 request_review ─────────────────────────────

  /** 這一隊這個小時還能發起幾次。 */
  leadRequestsLeft(teamId: string): number {
    const since = new Date(this.deps.now().getTime() - HOUR_MS).toISOString();
    return Math.max(
      0,
      this.deps.settings().leadPerHour - this.table.countLeadRequests(teamId, since),
    );
  }

  /**
   * 隊長發起（dispatch.ts 已檢查身分、理由、頻率）：建好紀錄馬上回（工具不等 diff），推播通知 GM，
   * 之後在背景產生 diff、直接開始（跳過 GM 確認）。對象不在、機器離線、daemon 太舊時丟 HttpError。
   */
  requestByLead(input: {
    lead: Session;
    teamId: string;
    target: ReviewTargetInput;
    reason: string;
  }): Review {
    const requestedBy: ReviewRequester = { kind: 'lead', id: input.lead.id, name: input.lead.name };
    const review = this.create({
      target: input.target,
      requestedBy,
      reason: input.reason,
      teamId: input.teamId,
    });
    this.deps.guarded('review notify', () =>
      this.deps.notify({ kind: 'requested', review, lead: input.lead.name }),
    );
    void this.fillDiff(review).then((prepared) =>
      this.deps.guarded('review start', () => {
        if (prepared.status !== 'awaiting_confirm') {
          // diff 產生不了（沒有變更、git 失敗）：告訴隊長，GM 在收件匣看得到。
          this.deliverToLead(prepared, input.lead.id);
          return;
        }
        try {
          this.startReview(prepared.id, requestedBy);
        } catch (error) {
          const code = error instanceof HttpError ? error.code : 'start_failed';
          this.deliverToLead(this.failReview(prepared, code), input.lead.id);
        }
      }),
    );
    return review;
  }
}
