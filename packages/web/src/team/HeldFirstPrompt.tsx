// 「送出第一個指令」（P3 §2.3、D7）：全部暫停中套用 Preset 時，隊長的第一個指令沒有隨建立送出，
// 在隊長卡片（畫布）與團隊面板上出現這顆按鈕。GM 按下才送：走 hub 的群發（點名隊長）＝SafeDelivery manual，
// 只在隊長等輸入時送，忙就排隊；和 GM 自己打字一樣不受全部暫停擋（P2 Q6）。
import { useEffect, useState } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText } from '../views';
import { useHeldPrompts } from './heldPrompts';
import './presetMessages';

export function HeldFirstPrompt({ sessionId }: { sessionId: string }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const session = useBoard((s) => s.sessions.find((x) => x.id === sessionId));
  const held = useHeldPrompts((s) => s.held[sessionId]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);
  const gone = !session || session.archived || session.endedAt !== null;

  // 隊長已結束或被刪掉：這個指令送不出去了，不再顯示。
  useEffect(() => {
    if (held && gone) useHeldPrompts.getState().release(sessionId);
  }, [held, gone, sessionId]);

  if (!held && !msg) return null;
  const send = async () => {
    if (!held || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const broadcast = await backend.broadcastToTeam(held.teamId, held.text, [sessionId]);
      const state = broadcast.targets.find((x) => x.sessionId === sessionId)?.state;
      if (state === 'sent' || state === 'queued') {
        useHeldPrompts.getState().release(sessionId);
        setMsg({ text: t(`team.preset.firstSent.${state}`), err: false });
      } else {
        setMsg({ text: t('team.preset.firstNotSent', { state: state ?? '?' }), err: true });
      }
    } catch (e) {
      setMsg({ text: t('team.failed', { detail: errorText(e) }), err: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="held-first nodrag" data-testid={`held-first-${sessionId}`}>
      {held && (
        <>
          <button
            type="button"
            className="primary"
            disabled={busy || !connected || gone}
            title={held.text}
            onClick={() => void send()}
            data-testid="held-first-send"
          >
            {t('team.preset.sendFirst')}
          </button>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => useHeldPrompts.getState().release(sessionId)}
            data-testid="held-first-drop"
          >
            {t('team.preset.dropFirst')}
          </button>
        </>
      )}
      {msg && (
        <span className={`msg${msg.err ? ' err' : ''}`} role={msg.err ? 'alert' : 'status'}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

/** 團隊面板上：這個團隊裡還沒送出第一個指令的隊長（手機沒有畫布，從這裡送）。 */
export function TeamHeldFirstPrompts({ teamId }: { teamId: string }) {
  const held = useHeldPrompts((s) => s.held);
  const ids = Object.entries(held)
    .filter(([, h]) => h.teamId === teamId)
    .map(([id]) => id);
  const t = useT();
  if (ids.length === 0) return null;
  return (
    <div className="alert you-alert held-first-team" role="status" data-testid="team-held-first">
      <span aria-hidden="true">⏸</span>
      <div>
        <p>{t('team.preset.heldTeam')}</p>
        {ids.map((id) => (
          <HeldFirstPrompt key={id} sessionId={id} />
        ))}
      </div>
    </div>
  );
}
