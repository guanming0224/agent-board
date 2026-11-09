// 合併通知（GM 2026-11-06）：有事情要人處理時先等一小段時間，再送一則列出「現在所有在等你的」。
// 時間規則（protocol NOTIFY_*）：
// - 每個事件給 15 秒；期間有新事件就從新事件再算 15 秒（延長），但從第一個事件起最多 60 秒。
// - 權限請求最急：批次裡有權限請求時，最晚在它發生後 5 秒送出（不會被後來的事件延長）。
// 送出時才看當下的狀態：等待期間已經處理掉的不列；什麼都不剩就不送。
import {
  NOTIFY_MAX_WINDOW_MS,
  NOTIFY_PERMISSION_WINDOW_MS,
  NOTIFY_WINDOW_MS,
  type SessionStatus,
} from '@agent-board/protocol';

export interface CoalesceWindows {
  normalMs: number;
  urgentMs: number;
  maxMs: number;
}

export const DEFAULT_WINDOWS: CoalesceWindows = {
  normalMs: NOTIFY_WINDOW_MS,
  urgentMs: NOTIFY_PERMISSION_WINDOW_MS,
  maxMs: NOTIFY_MAX_WINDOW_MS,
};

export interface CoalescerDeps {
  now(): number;
  windows: CoalesceWindows;
  /** 時間到：由 hub 收集當下在等你的項目並送出。`triggered` 是這一批事件的 session id（舊到新）。 */
  flush(triggered: string[]): void;
}

/** 只管時間：哪時候送。要送什麼由 hub 在 flush 時決定。 */
export class NotifyCoalescer {
  private startedAt: number | null = null;
  private softDeadline = 0;
  private urgentDeadline: number | null = null;
  private triggered: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CoalescerDeps) {}

  /** 有新事件。`urgent` 是權限請求。 */
  add(sessionId: string | null, urgent: boolean): void {
    const now = this.deps.now();
    const { normalMs, urgentMs } = this.deps.windows;
    if (this.startedAt === null) {
      this.startedAt = now;
      this.softDeadline = now;
    }
    this.softDeadline = Math.max(this.softDeadline, now + (urgent ? urgentMs : normalMs));
    if (urgent) {
      const at = now + urgentMs;
      this.urgentDeadline = this.urgentDeadline === null ? at : Math.min(this.urgentDeadline, at);
    }
    if (sessionId !== null) {
      this.triggered = [...this.triggered.filter((id) => id !== sessionId), sessionId];
    }
    this.arm();
  }

  /** 什麼時候會送（epoch 毫秒）；沒有在等就是 null。 */
  deadline(): number | null {
    if (this.startedAt === null) return null;
    const hard = this.startedAt + this.deps.windows.maxMs;
    return Math.min(this.softDeadline, hard, this.urgentDeadline ?? Infinity);
  }

  get pending(): boolean {
    return this.startedAt !== null;
  }

  /** 馬上送（設定改成不合併時，手上這批不能丟）。 */
  flushNow(): void {
    if (this.startedAt === null) return;
    const triggered = this.triggered;
    this.reset();
    this.deps.flush(triggered);
  }

  close(): void {
    this.reset();
  }

  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.startedAt = null;
    this.urgentDeadline = null;
    this.softDeadline = 0;
    this.triggered = [];
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const deadline = this.deadline();
    if (deadline === null) return;
    this.timer = setTimeout(() => this.flushNow(), Math.max(0, deadline - this.deps.now()));
    this.timer.unref();
  }
}

/** 合併通知裡的一項：只有名稱、狀態與原因代碼，和單則推播帶的一樣，沒有對話內容。 */
export interface SummaryItem {
  sessionId: string;
  name: string;
  status: SessionStatus;
  reason?: 'handoff_round_limit' | 'task_reject_limit';
  maxRounds?: number;
  task?: number;
}

/** 合併通知裡的團隊動態（隊長自主擴編）：「LD 新增了 BD3」。只有名稱與種類，不帶理由。 */
export interface SummaryTeamItem {
  reason: 'team_member_added' | 'team_member_released';
  /** 隊長名稱。 */
  lead: string;
  /** 成員名稱。 */
  member: string;
  sessionId: string;
}

export interface SummaryPayload {
  kind: 'summary';
  /** 在等你的 session 數（不含已自動接續的）。 */
  count: number;
  /** 最多 `SUMMARY_MAX_ITEMS` 項，其餘算在 `more`。 */
  items: SummaryItem[];
  more: number;
  /** 等待期間自動接續的 session（額度恢復後）。 */
  autoContinued: { sessionId: string; name: string }[];
  /** 這一批跨過了「同時等你的上限」：值是上限。 */
  overLimit?: number;
  /** 等待期間的團隊動態（最多 SUMMARY_MAX_TEAM 項，舊到新）。沒有就不帶。 */
  team?: SummaryTeamItem[];
  at: string;
}

export const SUMMARY_MAX_ITEMS = 5;
const SUMMARY_MAX_AUTO = 3;
const SUMMARY_MAX_TEAM = 3;
/** 推播有大小上限（約 4 KB）：名稱太長就截斷。不會比單則推播多帶任何東西。 */
const NAME_MAX = 60;

const shortName = (name: string) =>
  name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;

const URGENT: ReadonlySet<SessionStatus> = new Set(['waiting_permission']);

/**
 * 排序：權限請求最前面，再來是自動流程停下等你決定的（交接、任務上限），再來是這一批觸發的（新的在前），
 * 其他照原本的順序（等最久的在前）。
 */
export function buildSummary(
  items: readonly SummaryItem[],
  triggered: readonly string[],
  autoContinued: readonly { sessionId: string; name: string }[],
  at: string,
  overLimit?: number,
  team: readonly SummaryTeamItem[] = [],
): SummaryPayload | null {
  if (items.length === 0 && autoContinued.length === 0 && team.length === 0) return null;
  const recency = (id: string) => {
    const index = triggered.indexOf(id);
    return index === -1 ? -1 : index;
  };
  const rank = (item: SummaryItem) => (URGENT.has(item.status) ? 0 : item.reason ? 1 : 2);
  const sorted = items
    .map((item, order) => ({ item, order }))
    .sort(
      (a, b) =>
        rank(a.item) - rank(b.item) ||
        recency(b.item.sessionId) - recency(a.item.sessionId) ||
        a.order - b.order,
    )
    .map(({ item }) => ({ ...item, name: shortName(item.name) }));
  return {
    kind: 'summary',
    count: items.length,
    items: sorted.slice(0, SUMMARY_MAX_ITEMS),
    more: Math.max(0, sorted.length - SUMMARY_MAX_ITEMS),
    autoContinued: autoContinued
      .slice(0, SUMMARY_MAX_AUTO)
      .map((a) => ({ sessionId: a.sessionId, name: shortName(a.name) })),
    ...(overLimit !== undefined ? { overLimit } : {}),
    ...(team.length > 0
      ? {
          team: team.slice(-SUMMARY_MAX_TEAM).map((t) => ({
            ...t,
            lead: shortName(t.lead),
            member: shortName(t.member),
          })),
        }
      : {}),
    at,
  };
}
