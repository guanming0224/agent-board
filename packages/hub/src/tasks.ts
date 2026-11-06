// 任務自動執行（GM 2026-11-06）：任務板 待分配 → 進行中 → 待審查 → 完成 自己跑起來。
// 全部是固定規則（純子字串比對標記），不呼叫任何模型；送字一律走 delivery.ts（只在目標等輸入時送）。
// 會花成員額度的步驟只在團隊開了「任務自動執行」（teams.task_auto，預設關）時做。
// 進度存在任務上（number、rejectCount、needsUser、reviewerSessionId、auto），送字佇列只在記憶體：
// hub 重啟後排隊中的標成「沒送出」，不自動重送。
import {
  TASK_REJECT_LIMIT,
  type SessionEvent,
  type Task,
  type TaskAuto,
  type TaskAutoState,
  type Team,
} from '@agent-board/protocol';
import { isGone, type DeliveryItem, type SafeDelivery } from './delivery';
import { cleanLine, oneSentence, reportParts, sessionReport } from './handoff';
import type { Store } from './store';

const TITLE_MAX_CHARS = 300;
const GOAL_MAX_CHARS = 500;

export type TaskSendKind = 'start' | 'reject' | 'review';

/** 送出但還沒確定送達的狀態，以及送達後換成的狀態。 */
const QUEUED: Record<TaskSendKind, TaskAutoState> = {
  start: 'queued',
  reject: 'queued',
  review: 'review_queued',
};
const SENT: Record<TaskSendKind, TaskAutoState> = {
  start: 'sent',
  reject: 'sent',
  review: 'review_sent',
};

const clip = (text: string, max: number) => {
  const chars = [...cleanLine(text)];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

export const doneMarker = (n: number) => `[完成 #${n}]`;
export const passMarker = (n: number) => `[通過 #${n}]`;
export const rejectMarker = (n: number) => `[退回 #${n}]`;

const finishLine = (n: number) =>
  `When this task is finished, reply with ${doneMarker(n)} and a one-sentence summary.`;

/**
 * 回覆裡找任務標記，純子字串比對：`[完成 #3]`（也接受 `[完成#3]`）；
 * `bareAllowed` 時也接受不帶編號的 `[完成]`（只在對方剛好只有一個相關任務時才能用）。
 * 注意 `[結果完成]` 不含 `[完成]`（研究團隊的交接標記不會被誤認）。回傳實際找到的標記。
 */
export function findTaskMarker(
  reply: string,
  word: string,
  number: number,
  bareAllowed: boolean,
): string | null {
  for (const marker of [`[${word} #${number}]`, `[${word}#${number}]`]) {
    if (reply.includes(marker)) return marker;
  }
  const bare = `[${word}]`;
  return bareAllowed && reply.includes(bare) ? bare : null;
}

/** 標記後面的一句（完成摘要、退回原因）；後面沒有字就是空字串。 */
export function afterMarker(reply: string, marker: string): string {
  const at = reply.indexOf(marker);
  if (at < 0) return '';
  const rest = cleanLine(reply.slice(at + marker.length)).replace(/^[\s:：,，.。\-–—]+/, '');
  return rest === '' ? '' : oneSentence(rest);
}

/** 一行。開頭固定 `[Task #n]`：標題與目標是使用者或隊長寫的，不能讓它以 `/`、`!` 開頭變成指令。 */
export function taskPrompt(task: Pick<Task, 'number' | 'title'>, team: Pick<Team, 'goal'>): string {
  const goal = clip(team.goal, GOAL_MAX_CHARS);
  return [
    `[Task #${task.number}] ${clip(task.title, TITLE_MAX_CHARS)}`,
    `Team goal: ${goal || 'none'}`,
    finishLine(task.number),
  ].join(' | ');
}

/** 審查退回：原因只有一句（審查的回覆清過控制字元）。 */
export function rejectPrompt(task: Pick<Task, 'number' | 'title'>, reason: string): string {
  return [
    `[Task #${task.number}] Sent back by review: ${reason || 'no reason given'}`,
    `Task: ${clip(task.title, TITLE_MAX_CHARS)}`,
    finishLine(task.number),
  ].join(' | ');
}

/** 送審：任務、負責人的一句摘要、偵測到的改動、分支（和交接同一套，不貼完整對話）。 */
export function reviewPrompt(
  task: Pick<Task, 'number' | 'title'>,
  report: { summary: string; files: readonly string[]; branch: string | null },
): string {
  const n = task.number;
  return [
    `[Review #${n}] Task: ${clip(task.title, TITLE_MAX_CHARS)}`,
    ...reportParts(report),
    `Reply with ${passMarker(n)} or ${rejectMarker(n)} followed by the reason.`,
  ].join(' | ');
}

export interface TaskDeps {
  store: Store;
  now(): Date;
  delivery: SafeDelivery;
  audit(sessionId: string | null, action: string, detail: string): void;
  addEvent(sessionId: string, type: string, payload: Record<string, unknown>, at?: string): void;
  /** 退回到上限：走一般的推播（和雙向交接的輪數上限同一條路）。 */
  notifyLimit(sessionId: string, task: Task, limit: number): void;
  rejectLimit?: number;
}

const keyOf = (taskId: string) => `task:${taskId}`;

export class TaskEngine {
  /** 每個團隊輪流分給審查的位置（只在記憶體，重啟從頭算）。 */
  private readonly rotation = new Map<string, number>();
  private readonly limit: number;

  constructor(private readonly deps: TaskDeps) {
    this.limit = deps.rejectLimit ?? TASK_REJECT_LIMIT;
  }

  /** hub 啟動時呼叫：送字佇列已經不在了，排隊中的標成沒送出（不自動重送，要重送就把卡片移回再移進來）。 */
  restore(): void {
    const { store } = this.deps;
    for (const team of store.listTeams()) {
      for (const task of store.listTasks(team.id)) {
        const state = task.auto?.state;
        if (state !== 'queued' && state !== 'review_queued') continue;
        this.save({ ...task, auto: this.auto('dropped', task.auto!.sessionId, 'hub_restarted') });
        this.deps.audit(
          task.auto!.sessionId,
          'task.dropped',
          JSON.stringify({ ...this.ids(task), reason: 'hub_restarted' }),
        );
      }
    }
  }

  /**
   * 使用者在任務板上改了任務（hub 已存好）。進入進行中（或進行中換了負責人）→ 送給負責人；
   * 進入待審查 → 送審。同一欄重存不會重送。開關關著時什麼都不送。
   */
  userChanged(prev: Task, next: Task): void {
    const columnChanged = prev.column !== next.column;
    const ownerChanged = prev.ownerSessionId !== next.ownerSessionId;
    if (!columnChanged && !ownerChanged) return;
    this.deps.delivery.cancel(keyOf(next.id));
    if (!this.automated(next.teamId)) return;
    if (next.column === 'doing' && next.ownerSessionId !== null) {
      this.sendToOwner(next, 'start', null);
    } else if (next.column === 'review' && columnChanged) {
      this.sendToReview(next, null);
    }
  }

  userDeleted(task: Task): void {
    this.deps.delivery.cancel(keyOf(task.id));
  }

  /** 關掉開關（含全隊暫停）：排隊中的不送了。已經送出的不收回。 */
  teamChanged(prev: Team, next: Team): void {
    if (!prev.taskAuto || next.taskAuto) return;
    for (const task of this.deps.store.listTasks(next.id)) {
      if (!this.deps.delivery.cancel(keyOf(task.id))) continue;
      const state = task.auto?.state;
      if (state === 'queued' || state === 'review_queued') {
        this.markDropped(task, task.auto!.sessionId, 'automation_off');
      }
    }
  }

  /** 回合結束（Stop hook）：負責人的完成標記、審查的通過／退回標記。 */
  onEvent(event: SessionEvent): void {
    if (event.type !== 'hook' || event.payload.event !== 'Stop') return;
    const reply = event.payload.last_assistant_message;
    if (typeof reply !== 'string' || reply === '') return;
    const sessionId = event.sessionId;
    const { store } = this.deps;
    const teams = store.listTeams();
    const auto = new Set(teams.filter((team) => team.taskAuto).map((team) => team.id));
    const tasks = teams.flatMap((team) => store.listTasks(team.id));

    // 不帶編號的 [完成] 只在負責人剛好只有一個進行中的任務時才算（不管哪個團隊、開關有沒有開）。
    const doing = tasks.filter((t) => t.column === 'doing' && t.ownerSessionId === sessionId);
    for (const task of doing) {
      if (!auto.has(task.teamId)) continue;
      const marker = findTaskMarker(reply, '完成', task.number, doing.length === 1);
      if (marker) this.completed(task, marker, reply);
    }

    const reviewing = tasks.filter(
      (t) =>
        t.column === 'review' &&
        t.reviewerSessionId === sessionId &&
        (t.auto?.state === 'review_sent' || t.auto?.state === 'review_queued'),
    );
    for (const task of reviewing) {
      if (!auto.has(task.teamId)) continue;
      const bare = reviewing.length === 1;
      // 同時寫了通過和退回時以退回為準（保守：不讓沒過的東西被當成完成）。
      const rejected = findTaskMarker(reply, '退回', task.number, bare);
      const passed = rejected ? null : findTaskMarker(reply, '通過', task.number, bare);
      if (rejected) this.rejected(task, sessionId, afterMarker(reply, rejected));
      else if (passed) this.passed(task, sessionId);
    }
  }

  // ── 各步驟 ───────────────────────────────────────────
  private completed(task: Task, marker: string, reply: string): void {
    const summary = afterMarker(reply, marker) || oneSentence(reply);
    const ownerId = task.ownerSessionId!;
    this.deps.delivery.cancel(keyOf(task.id));
    const next: Task = { ...task, column: 'review', auto: null };
    this.save(next);
    this.record(ownerId, 'task.completed', next, { summary });
    this.sendToReview(next, summary);
  }

  private passed(task: Task, reviewerId: string): void {
    const next: Task = {
      ...task,
      column: 'done',
      needsUser: false,
      auto: this.auto('passed', reviewerId),
    };
    this.save(next);
    this.record(reviewerId, 'task.reviewed', next, { verdict: 'pass' });
  }

  private rejected(task: Task, reviewerId: string, reason: string): void {
    const rejectCount = task.rejectCount + 1;
    const detail = { reason, rejectCount, limit: this.limit };
    if (rejectCount >= this.limit) {
      // 到上限：留在待審查，標成要使用者決定，推播通知。
      const next: Task = {
        ...task,
        rejectCount,
        needsUser: true,
        auto: this.auto('limit', reviewerId, reason),
      };
      this.save(next);
      this.record(reviewerId, 'task.rejected', next, detail);
      this.record(reviewerId, 'task.limit', next, detail);
      this.deps.notifyLimit(reviewerId, next, this.limit);
      return;
    }
    const next: Task = { ...task, rejectCount, column: 'doing', auto: null };
    this.save(next);
    this.record(reviewerId, 'task.rejected', next, detail);
    if (next.ownerSessionId !== null) this.sendToOwner(next, 'reject', reason, reviewerId);
  }

  private sendToOwner(
    task: Task,
    kind: 'start' | 'reject',
    reason: string | null,
    fromSessionId: string | null = null,
  ): void {
    const team = this.deps.store.getTeam(task.teamId);
    const ownerId = task.ownerSessionId;
    if (!team || ownerId === null) return;
    const message = kind === 'start' ? taskPrompt(task, team) : rejectPrompt(task, reason ?? '');
    this.send(task, kind, ownerId, message, fromSessionId, reason ?? undefined);
  }

  /** 送審；團隊沒有審查就停在待審查等使用者。摘要沒給（使用者自己移過來）就取負責人最後一則回覆。 */
  private sendToReview(task: Task, summary: string | null): void {
    const { store } = this.deps;
    const ownerId = task.ownerSessionId;
    const owner = ownerId ? store.getSession(ownerId) : null;
    const report = ownerId
      ? sessionReport(
          store,
          ownerId,
          (e) => e.type === 'task.dispatched' && e.payload.taskId === task.id,
        )
      : { reply: null, files: [], lastDaemonAt: null };
    const text = summary ?? oneSentence(report.reply ?? '');
    const reviewerId = this.pickReviewer(task);
    if (reviewerId === null) {
      this.save({ ...task, auto: this.auto('reported', ownerId, text || undefined) });
      return;
    }
    const message = reviewPrompt(task, {
      summary: text,
      files: report.files,
      branch: owner?.branch ?? null,
    });
    const next: Task = { ...task, reviewerSessionId: reviewerId };
    this.send(next, 'review', reviewerId, message, ownerId, text || undefined);
  }

  /** 同一個任務再送審沿用上次的審查；否則在團隊的審查（沒封存、還在跑、不是負責人）之間輪流。 */
  private pickReviewer(task: Task): string | null {
    const { store } = this.deps;
    const reviewers = store
      .listTeamMembers(task.teamId)
      .filter((m) => m.role === 'reviewer' && m.sessionId !== task.ownerSessionId)
      .map((m) => store.getSession(m.sessionId))
      .filter((s) => s !== null && !isGone(s))
      .map((s) => s!.id);
    if (reviewers.length === 0) return null;
    if (task.reviewerSessionId && reviewers.includes(task.reviewerSessionId)) {
      return task.reviewerSessionId;
    }
    const at = this.rotation.get(task.teamId) ?? 0;
    this.rotation.set(task.teamId, at + 1);
    return reviewers[at % reviewers.length]!;
  }

  private send(
    task: Task,
    kind: TaskSendKind,
    targetId: string,
    message: string,
    fromSessionId: string | null,
    note: string | undefined,
  ): void {
    const { store, delivery } = this.deps;
    const queued: Task = { ...task, auto: this.auto(QUEUED[kind], targetId, note) };
    this.save(queued);
    const extra = { kind, toSessionId: targetId, ...(fromSessionId ? { fromSessionId } : {}) };
    if (!store.getSession(targetId)) {
      this.markDropped(queued, targetId, 'target_ended');
      return;
    }
    this.deps.audit(
      targetId,
      'task.dispatched',
      JSON.stringify({ ...this.ids(task), ...extra, message }),
    );
    // 這筆事件是送審時「改過的檔案」的分界，時間接在負責人的 daemon 事件之後（同交接）。
    const boundary = sessionReport(store, targetId, () => false).lastDaemonAt;
    this.deps.addEvent(
      targetId,
      'task.dispatched',
      { ...this.ids(task), ...extra },
      boundary ?? undefined,
    );
    const item: DeliveryItem = {
      key: keyOf(task.id),
      targetId,
      message,
      check: () => this.stillWanted(task.id, kind, targetId),
      dropped: (reason) =>
        this.whenStill(task.id, kind, targetId, (t) => this.markDropped(t, targetId, reason)),
      aborted: () =>
        this.whenStill(task.id, kind, targetId, (t) =>
          this.markDropped(t, targetId, 'target_busy'),
        ),
      delivered: () =>
        this.whenStill(task.id, kind, targetId, (t) => {
          const sent: Task = { ...t, auto: this.auto(SENT[kind], targetId, t.auto?.note) };
          this.save(sent);
          this.record(targetId, 'task.delivered', sent, extra);
        }),
    };
    delivery.enqueue(item);
  }

  /** 排隊期間開關關掉、任務被移走或刪掉，就不送了。 */
  private stillWanted(taskId: string, kind: TaskSendKind, targetId: string): string | null {
    const task = this.deps.store.getTask(taskId);
    if (!task) return 'task_deleted';
    if (!this.automated(task.teamId)) return 'automation_off';
    const ok =
      kind === 'review'
        ? task.column === 'review' && task.reviewerSessionId === targetId
        : task.column === 'doing' && task.ownerSessionId === targetId;
    return ok ? null : 'task_moved';
  }

  /** 送字的結果回來時，任務還停在當初排隊的那一步才更新（使用者可能已經移走了）。 */
  private whenStill(
    taskId: string,
    kind: TaskSendKind,
    targetId: string,
    fn: (task: Task) => void,
  ): void {
    const task = this.deps.store.getTask(taskId);
    if (task?.auto?.state === QUEUED[kind] && task.auto.sessionId === targetId) fn(task);
  }

  private markDropped(task: Task, targetId: string | null, reason: string): void {
    const next: Task = { ...task, auto: this.auto('dropped', targetId, reason) };
    this.save(next);
    if (targetId && this.deps.store.getSession(targetId)) {
      this.record(targetId, 'task.dropped', next, { reason });
    } else {
      this.deps.audit(targetId, 'task.dropped', JSON.stringify({ ...this.ids(next), reason }));
    }
  }

  // ── 小工具 ───────────────────────────────────────────
  private automated(teamId: string): boolean {
    return this.deps.store.getTeam(teamId)?.taskAuto === true;
  }

  private auto(state: TaskAutoState, sessionId: string | null, note?: string): TaskAuto {
    return {
      state,
      sessionId,
      ...(note ? { note } : {}),
      at: this.deps.now().toISOString(),
    };
  }

  private ids(task: Task) {
    return { taskId: task.id, teamId: task.teamId, number: task.number };
  }

  private save(task: Task): void {
    this.deps.store.upsertTask(task);
  }

  /** audit 與事件都寫：audit 查得到是自動做的（user 是 null），事件給任務卡與畫布。 */
  private record(
    sessionId: string,
    type: string,
    task: Task,
    extra: Record<string, unknown>,
  ): void {
    const payload = { ...this.ids(task), ...extra };
    this.deps.audit(sessionId, type, JSON.stringify(payload));
    this.deps.addEvent(sessionId, type, payload);
  }
}
