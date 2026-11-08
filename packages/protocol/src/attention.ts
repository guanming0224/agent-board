// 「等你」的定義（GM 2026-11-06）：頁首的「等你：N」、超過上限的橫幅與推播、合併通知的清單都用這一份。
// hub 與 web 共用，不要各寫一份。
import { needsAttention, type Approval, type Session } from './models';

/**
 * daemon 在 `SessionStart`（source=startup）把 session 標成 waiting_input 時的 detail：
 * session 剛開好，沒有新的回覆，只是閒著（畫面上的 NEW）。source=resume（重新接回）不帶，算在等你
 * （GM 2026-11-08）。舊版 daemon 不帶，這時照舊算「等你」。
 */
export const IDLE_START_DETAIL = 'idle:start';

/** 剛開好、什麼都還沒做的 waiting_input：不算在等你（沒有新東西要看）。 */
export const isIdleStart = (session: Pick<Session, 'status' | 'statusDetail'>): boolean =>
  session.status === 'waiting_input' && session.statusDetail === IDLE_START_DETAIL;

/**
 * session 本身的狀態是否在等你：收件匣的範圍（等你允許、回覆、審計畫、錯誤、卡住），
 * 去掉封存的與剛開好就閒著的。
 */
export function sessionWaitsForUser(
  session: Pick<Session, 'status' | 'statusDetail' | 'archived'>,
): boolean {
  return !session.archived && needsAttention(session.status) && !isIdleStart(session);
}

/**
 * 在等你的 session（每個 session 只算一次）：狀態在等你，或有還沒決定的 approval
 * （危險指令命中時 session 常常還是 running）。順序照 `sessions`。
 */
export function waitingSessions(
  sessions: readonly Session[],
  approvals: readonly Pick<Approval, 'sessionId'>[],
): Session[] {
  const pending = new Set(approvals.map((a) => a.sessionId));
  return sessions.filter((s) => !s.archived && (pending.has(s.id) || sessionWaitsForUser(s)));
}

/** 超過上限的判斷：上一次的數量在上限以內、這次超過才算「跨過」（每次跨過只通知一次）。 */
export class WaitingThreshold {
  private over = false;

  /** 回傳這次是不是剛跨過上限。數量回到上限以內就重設。 */
  update(count: number, limit: number): boolean {
    if (count <= limit) {
      this.over = false;
      return false;
    }
    if (this.over) return false;
    this.over = true;
    return true;
  }

  get isOver(): boolean {
    return this.over;
  }
}
