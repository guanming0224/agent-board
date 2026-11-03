// 任務完成提示（DISPATCH §8-6）：建議送 /clear 或封存。不碰 DOM，方便單元測試。
import type { Session, SessionEvent } from '@agent-board/protocol';
import { create } from 'zustand';

/** 同一次完成只提示一次；重新完成（statusSince 變了）會再出現。 */
export const hintKey = (session: Pick<Session, 'id' | 'statusSince'>) =>
  `${session.id}@${session.statusSince}`;

export const showsDoneHint = (session: Pick<Session, 'status' | 'archived'>) =>
  session.status === 'done' && !session.archived;

/**
 * 標記完成之前是不是在等輸入。hub 標成 done 之後就不再採用 daemon 回報的狀態，
 * 所以只能從最後一筆「變成 done」的狀態事件找回當時的狀態。
 */
export function markedFromWaiting(events: readonly SessionEvent[]): boolean {
  const last = events.findLast((e) => e.type === 'status' && e.payload['to'] === 'done');
  return last?.payload['from'] === 'waiting_input';
}

/**
 * ready：可以送 /clear。ended：PTY 已經結束，只能封存。unreachable：hub 或機器連不到。
 * busy：標記完成時不在等輸入，打進去可能插進工作中。checking：還在讀狀態事件。
 */
export type ClearState = 'ready' | 'ended' | 'unreachable' | 'busy' | 'checking';

export function clearState(
  session: Pick<Session, 'endedAt'>,
  context: { connected: boolean; machineOnline: boolean; waitingBeforeDone: boolean | null },
): ClearState {
  if (session.endedAt !== null) return 'ended';
  if (!context.connected || !context.machineOnline) return 'unreachable';
  if (context.waitingBeforeDone === null) return 'checking';
  return context.waitingBeforeDone ? 'ready' : 'busy';
}

const STORAGE_KEY = 'agent-board.doneHint.dismissed';
/** 只記最近這麼多筆，舊的 session 早就封存了。 */
export const DISMISSED_LIMIT = 200;

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // 私密視窗或沒有 localStorage：只在這次開啟期間記得。
    return [];
  }
}

export const useDoneHints = create<{ dismissed: string[]; dismiss: (key: string) => void }>(
  (set) => ({
    dismissed: readDismissed(),
    dismiss: (key) =>
      set((s) => {
        const dismissed = [...s.dismissed.filter((k) => k !== key), key].slice(-DISMISSED_LIMIT);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissed));
        } catch {
          // 存不了就只在這次開啟期間記得。
        }
        return { dismissed };
      }),
  }),
);
