// 「等你」的數量與超過上限的橫幅（GM 2026-11-06）。定義在 protocol attention.ts，hub 的推播用同一份。
import { create } from 'zustand';
import { DEFAULT_WAITING_LIMIT, waitingSessions, type Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useClock } from './session';

/** 在等你的 session 數與上限。 */
export function useWaiting(): { count: number; limit: number } {
  const count = useBoard((s) => waitingSessions(s.sessions, s.approvals).length);
  const limit = useBoard((s) => s.waitingLimit ?? DEFAULT_WAITING_LIMIT);
  return { count, limit };
}

/**
 * 每次「跨過」上限算一次（crossing 加一），回到上限以內才重設。按「知道了」只收起這一次，
 * 下次再超過又會出現。頁首和收件匣各自掛橫幅，狀態放在這裡共用。
 */
interface BannerState {
  over: boolean;
  crossing: number;
  dismissed: number;
  dismiss(): void;
}

export const useWaitingBanner = create<BannerState>((set) => ({
  over: false,
  crossing: 0,
  dismissed: 0,
  dismiss: () => set((s) => ({ dismissed: s.crossing })),
}));

const track = (state: {
  sessions: Session[];
  approvals: { sessionId: string }[];
  waitingLimit?: number;
}) => {
  const count = waitingSessions(state.sessions, state.approvals).length;
  const over = count > (state.waitingLimit ?? DEFAULT_WAITING_LIMIT);
  const current = useWaitingBanner.getState();
  if (over === current.over) return;
  useWaitingBanner.setState(over ? { over, crossing: current.crossing + 1 } : { over });
};
track(useBoard.getState());
useBoard.subscribe(track);

export function WaitingBanner() {
  const t = useT();
  const { count, limit } = useWaiting();
  const { over, crossing, dismissed, dismiss } = useWaitingBanner();
  if (!over || dismissed === crossing) return null;
  return (
    <div className="waiting-banner" role="alert" data-testid="waiting-banner">
      <span className="text">{t('views.waiting.over', { n: count, limit })}</span>
      <a href="#/inbox" className="go">
        {t('views.waiting.goInbox')}
      </a>
      <button type="button" onClick={dismiss} data-testid="waiting-banner-dismiss">
        {t('views.waiting.dismiss')}
      </button>
    </div>
  );
}

/** 卡片上：額度恢復後會自動接續的時間（hub 排定的，Session.autoContinue）。 */
export function AutoContinueNote({ session }: { session: Session }) {
  const t = useT();
  const clock = useClock();
  const entry = session.autoContinue;
  if (entry?.state !== 'scheduled') return null;
  return (
    <span
      className="chip auto-continue"
      data-testid={`auto-continue-${session.id}`}
      title={t('views.autoContinue.title')}
    >
      {t('views.autoContinue.at', { time: clock(entry.at) })}
    </span>
  );
}
