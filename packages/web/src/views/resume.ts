// 接續已結束的 session（`claude --resume`）：卡片選單、完成提示、舊資料頁共用。
import { useCallback, useState } from 'react';
import type { Session } from '@agent-board/protocol';
import { errorCode } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useViewsUi } from './uiStore';
import { errorText } from './useBoardLoad';

type T = ReturnType<typeof useT>;

/** 已結束、而且有 Claude 對話 id 才能接續（沒有 id 就沒有對話可以接）。 */
export const canResume = (session: Pick<Session, 'endedAt' | 'claudeSessionId'>) =>
  session.endedAt !== null && session.claudeSessionId !== null;

/** hub 的錯誤碼換成白話；不認得的照原文。 */
export function resumeErrorText(t: T, e: unknown, machineName: string): string {
  switch (errorCode(e)) {
    case 'session_active':
      return t('views.resume.err.active');
    case 'no_claude_session':
      return t('views.resume.err.noConversation');
    case 'machine_offline':
      return t('views.resume.err.offline', { machine: machineName });
    case 'invalid_account_profile':
      return t('views.resume.err.account');
    case 'session_deleting':
      return t('views.resume.err.deleting');
    default:
      return t('views.resume.err.other', { error: errorText(e) });
  }
}

/**
 * 回傳 resume(session)：成功就回到畫布並框出這張卡（hub 會自動還原已封存的）。
 * 失敗時 error 是白話訊息，呼叫端自己決定放哪裡。
 */
export function useResume() {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const machines = useBoard((s) => s.machines);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resume = useCallback(
    async (session: Session): Promise<boolean> => {
      setBusy(true);
      setError('');
      try {
        await backend.resumeSession(session.id);
        useViewsUi.getState().focusSession(session.id);
        if (!location.hash.startsWith('#/canvas')) location.hash = '#/canvas';
        return true;
      } catch (e) {
        const machine = machines.find((m) => m.id === session.machineId)?.name ?? session.machineId;
        setError(resumeErrorText(t, e, machine));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [backend, machines, t],
  );
  return { resume, busy, error };
}
