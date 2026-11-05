import { useEffect, useState } from 'react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { canResume, errorText, useResume } from '../views';
import {
  clearState,
  hintKey,
  markedFromWaiting,
  showsDoneHint,
  useDoneHints,
  type ClearState,
} from './doneHintState';
import './expanded.css';

/** 同一次完成只讀一次事件；摘要條與全尺寸頁共用。讀失敗不留快取，下次再試。 */
const waitingCache = new Map<string, Promise<boolean>>();

function useWaitingBeforeDone(session: Session, enabled: boolean): boolean | null {
  const backend = useBoard((s) => s.backend);
  const key = hintKey(session);
  const [result, setResult] = useState<{ key: string; value: boolean } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let pending = waitingCache.get(key);
    if (!pending) {
      pending = backend.sessionEvents(session.id).then(markedFromWaiting, () => {
        waitingCache.delete(key);
        return false;
      });
      waitingCache.set(key, pending);
    }
    void pending.then((value) => {
      if (alive) setResult({ key, value });
    });
    return () => {
      alive = false;
    };
  }, [backend, enabled, key, session.id]);

  return result?.key === key ? result.value : null;
}

const REASON: Partial<Record<ClearState, string>> = {
  ended: 'canvas.done.ended',
  unreachable: 'canvas.done.unreachable',
  busy: 'canvas.done.busy',
};

/** 安靜的提示：不上狀態色，可以關掉（STYLE.md 邏輯 5）。 */
export function DoneHint({ session }: { session: Session }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const machineOnline = useBoard(
    (s) => s.machines.find((m) => m.id === session.machineId)?.online ?? false,
  );
  const key = hintKey(session);
  const dismissed = useDoneHints((s) => s.dismissed.includes(key));
  const dismiss = useDoneHints((s) => s.dismiss);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const shown = showsDoneHint(session) && (!dismissed || sent);
  const resumer = useResume();
  const waiting = useWaitingBeforeDone(session, shown && session.endedAt === null);

  if (!shown) return null;
  const state = clearState(session, { connected, machineOnline, waitingBeforeDone: waiting });
  const reason = REASON[state];

  const sendClear = () => {
    try {
      backend.sendPrompt(session.id, '/clear');
      setSent(true);
      setMsg(t('canvas.done.cleared'));
      dismiss(key);
    } catch (e) {
      setMsg(t('canvas.cmd.failed', { detail: errorText(e) }));
    }
  };
  const archive = async () => {
    setBusy(true);
    setMsg('');
    try {
      await backend.updateSession(session.id, { archived: true });
    } catch (e) {
      setMsg(t('canvas.done.archiveFailed', { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="done-hint nodrag" role="note" data-testid={`done-hint-${session.id}`}>
      {sent ? (
        <span className="msg" role="status">
          {msg}
        </span>
      ) : (
        <>
          <p>{t('canvas.done.text')}</p>
          <div className="acts">
            {state === 'ready' && <button onClick={sendClear}>{t('canvas.done.clear')}</button>}
            {state === 'ended' && canResume(session) && (
              <button
                title={t('views.resume.hint')}
                disabled={resumer.busy || !connected}
                onClick={() => void resumer.resume(session)}
              >
                {resumer.busy ? t('views.resume.busy') : t('views.resume')}
              </button>
            )}
            <button disabled={busy || !connected} onClick={() => void archive()}>
              {t('canvas.done.archive')}
            </button>
            <button className="link" onClick={() => dismiss(key)}>
              {t('canvas.done.dismiss')}
            </button>
            {(msg || resumer.error) && (
              <span className="msg" role="status">
                {resumer.error || msg}
              </span>
            )}
          </div>
          {reason && <p className="sub">{t(reason)}</p>}
        </>
      )}
    </div>
  );
}
