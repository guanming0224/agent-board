// 額度恢復後自動接續（GM 2026-11-06）。固定規則，不呼叫模型：送的是固定一行 AUTO_CONTINUE_PROMPT。
//
// 1. session 進入 rate_limited，而且 statusDetail 讀得出重置時間（rateLimitReset.ts）→ 排在重置時間＋60 秒，
//    記在 session.autoContinue（schema v7，hub 重啟照樣會送）。同一次限流（statusSince）只排一次。
//    讀不出時間就不排、不猜。
// 2. 時間到 → 交給 SafeDelivery（文字和 Enter 分開、送 Enter 前再確認、同一個目標一次一則）。
//    能送的時候：waiting_input，或還在同一次限流而且 daemon 看到平常的輸入框（沒有額度選單等對話框）。
// 3. 期間使用者在網頁上對它打了任何字、按了 Esc／Ctrl-C，或 session 自己動起來了（Claude Code 自己接續、
//    有人在機器上直接下指令）→ 取消。設定關掉 → 取消全部。
// 自動送的字不經過使用者輸入那條路，不算使用者輸入（不重設交接鏈）。
import {
  AUTO_CONTINUE_PROMPT,
  type AutoContinue,
  type Session,
  type SessionStatus,
} from '@agent-board/protocol';
import type { SafeDelivery } from './delivery';
import { isGone } from './delivery';
import { parseRateLimitReset } from './rateLimitReset';
import type { Store } from './store';

/** 重置時間到了之後多等一下（和排隊放行同一個值），時鐘差一點就送會馬上又撞到限流。 */
export const AUTO_CONTINUE_GRACE_MS = 60_000;

/** Claude Code 自己的「等重置後自動繼續」已經開著：它會自己送，我們不要再送一次。 */
const CLAUDE_AUTO_RESUME = /continuing automatically/i;

/** 這些狀態代表 session 已經動起來或結束了：這次限流的自動接續不用了。 */
const RESUMED: ReadonlySet<SessionStatus> = new Set([
  'running',
  'waiting_permission',
  'plan_review',
  'error',
  'stuck',
  'done',
]);

export interface AutoContinueDeps {
  store: Pick<Store, 'getSession' | 'listSessions' | 'getSettings'>;
  now(): Date;
  delivery: SafeDelivery;
  /** 寫回 session.autoContinue（hub 會廣播給前端）。 */
  save(session: Session, autoContinue: AutoContinue | null): void;
  audit(sessionId: string, action: string, detail: string): void;
  addEvent(sessionId: string, type: string, payload: Record<string, unknown>): void;
  /** daemon 最後一次回報：畫面最下面是平常的輸入框。 */
  inputReady(sessionId: string): boolean;
  /** 送出了：放進合併通知（「BD1 已自動接續」）。 */
  sent(session: Session): void;
  guarded(label: string, fn: () => void): void;
}

const KEY_PREFIX = 'auto-continue:';
const keyFor = (sessionId: string) => `${KEY_PREFIX}${sessionId}`;
/** 送字佇列裡的這一則是不是自動接續（全部暫停的統計分開算）。 */
export const isAutoContinueKey = (key: string): boolean => key.startsWith(KEY_PREFIX);

export class AutoContinueEngine {
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: AutoContinueDeps) {}

  private enabled(): boolean {
    return this.deps.store.getSettings().autoContinue;
  }

  /** hub 啟動時：資料庫裡排好的照樣算（時間已過的，等 session 回來能送時再送）。 */
  restore(): void {
    this.arm();
  }

  /** 心跳時呼叫：計時器以外再確認一次（時鐘跳過、睡眠醒來）。 */
  tick(): void {
    this.arm();
  }

  onSessionChange(prev: Session, next: Session): void {
    const current = next.autoContinue;
    if (current?.state === 'scheduled') {
      if (isGone(next)) return this.cancel(next, 'ended');
      if (RESUMED.has(next.status)) return this.cancel(next, 'resumed');
      // 又撞到一次新的限流：舊的不用了，下面照新的重排。
      if (next.status === 'rate_limited' && next.statusSince !== current.limitSince) {
        this.cancel(next, 'new_limit');
      }
    }
    if (next.status === 'rate_limited') {
      const changed = prev.status !== next.status || prev.statusDetail !== next.statusDetail;
      if (changed) this.trySchedule(this.deps.store.getSession(next.id) ?? next);
    }
  }

  /** 使用者在網頁上對它打字（任何按鍵）、按 Esc／Ctrl-C、送出回覆。 */
  onUserInput(sessionId: string): void {
    const session = this.deps.store.getSession(sessionId);
    if (session?.autoContinue?.state === 'scheduled') this.cancel(session, 'user_input');
  }

  onSettingsChanged(prevOn: boolean, nextOn: boolean): void {
    if (prevOn === nextOn) return;
    for (const session of this.deps.store.listSessions()) {
      if (!nextOn) {
        if (session.autoContinue?.state === 'scheduled') this.cancel(session, 'setting_off');
      } else if (session.status === 'rate_limited' && session.endedAt === null) {
        this.trySchedule(session);
      }
    }
    this.arm();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 排定的時間（epoch 毫秒）；讀不出重置時間、或不該排就是 null。測試也用。 */
  planFor(session: Session): { at: number; resetAt: number } | null {
    if (session.status !== 'rate_limited' || session.endedAt !== null || session.archived) {
      return null;
    }
    if (session.statusDetail && CLAUDE_AUTO_RESUME.test(session.statusDetail)) return null;
    const resetAt = parseRateLimitReset(session.statusDetail, new Date(session.statusSince));
    if (resetAt === null) return null;
    // 重置時間已經過了還在限流：時間讀錯或額度根本還沒回來，送了只會再撞一次。
    if (resetAt <= this.deps.now().getTime()) return null;
    // 上一次限流我們接續過、而且是同一個重置時間：同一個上限又撞到，不要一直重送。
    const last = session.autoContinue;
    if (last?.state === 'sent' && Date.parse(last.resetAt) === resetAt) return null;
    return { at: resetAt + AUTO_CONTINUE_GRACE_MS, resetAt };
  }

  private trySchedule(session: Session): void {
    if (!this.enabled()) return;
    // 同一次限流只排一次（排過、送過、取消過都算）。
    if (session.autoContinue?.limitSince === session.statusSince) return;
    const plan = this.planFor(session);
    if (!plan) return;
    const entry: AutoContinue = {
      state: 'scheduled',
      at: new Date(plan.at).toISOString(),
      resetAt: new Date(plan.resetAt).toISOString(),
      limitSince: session.statusSince,
      reason: null,
    };
    this.deps.save(session, entry);
    this.deps.audit(
      session.id,
      'session.auto_continue',
      JSON.stringify({ state: 'scheduled', at: entry.at }),
    );
    this.arm();
  }

  private cancel(session: Session, reason: string): void {
    const current = session.autoContinue;
    if (current?.state !== 'scheduled') return;
    this.deps.delivery.cancel(keyFor(session.id));
    this.deps.save(session, { ...current, state: 'cancelled', reason });
    this.deps.audit(
      session.id,
      'session.auto_continue',
      JSON.stringify({ state: 'cancelled', reason }),
    );
    this.arm();
  }

  /** 最早的一個排定時間到時叫醒；setTimeout 上限約 24.8 天，超過就睡到上限再重算。 */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed) return;
    const now = this.deps.now().getTime();
    let earliest: number | null = null;
    for (const session of this.deps.store.listSessions()) {
      const entry = session.autoContinue;
      if (entry?.state !== 'scheduled') continue;
      const at = Date.parse(entry.at);
      if (at <= now) {
        this.enqueue(session, entry);
        continue;
      }
      if (earliest === null || at < earliest) earliest = at;
    }
    if (earliest === null) return;
    this.timer = setTimeout(
      () => this.deps.guarded('auto continue', () => this.arm()),
      Math.min(earliest - now, 2 ** 31 - 1),
    );
    this.timer.unref();
  }

  private enqueue(session: Session, entry: AutoContinue): void {
    const key = keyFor(session.id);
    if (this.deps.delivery.has(key)) return;
    if (!this.enabled()) return this.cancel(session, 'setting_off');
    const { store, delivery } = this.deps;
    const stillScheduled = (): Session | null => {
      const current = store.getSession(session.id);
      const ac = current?.autoContinue;
      return ac?.state === 'scheduled' && ac.limitSince === entry.limitSince ? current : null;
    };
    delivery.enqueue({
      key,
      targetId: session.id,
      message: AUTO_CONTINUE_PROMPT,
      ready: (target) =>
        target.status === 'waiting_input' ||
        (target.status === 'rate_limited' &&
          target.statusSince === entry.limitSince &&
          this.deps.inputReady(target.id)),
      check: () => {
        const current = stillScheduled();
        if (!current) return 'not_scheduled';
        if (!this.enabled()) return 'setting_off';
        // Claude Code 自己的自動繼續在倒數：讓它送。
        if (current.lastLines.some((line) => CLAUDE_AUTO_RESUME.test(line))) return 'claude_auto';
        return null;
      },
      dropped: (reason) => {
        const current = stillScheduled();
        if (current) this.cancel(current, reason);
      },
      aborted: () => {
        // 文字打進去了但對方在按 Enter 前不能打字了：留給使用者，不再試（不然會打兩次）。
        const current = stillScheduled();
        if (current) this.cancel(current, 'aborted');
      },
      delivered: () => {
        const current = stillScheduled();
        if (!current) return;
        const sentAt = this.deps.now().toISOString();
        this.deps.save(current, { ...entry, state: 'sent', reason: null });
        this.deps.audit(
          session.id,
          'session.auto_continue',
          JSON.stringify({ state: 'sent', at: sentAt }),
        );
        this.deps.addEvent(session.id, 'auto_continue.sent', { resetAt: entry.resetAt });
        this.deps.sent(current);
      },
    });
  }
}
