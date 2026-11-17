// 全尺寸頁側欄「模型設定」（CONTRACTS §26.10 補救）：已結束的 session 帶著那台 claude 不接受的推理強度、備援，
// 或舊資料的模型名稱不合規則時，owner 在這裡拿掉，再按接續就不帶（daemon 本機的 spec 在接續時整份換掉）。
import { useState } from 'react';
import { isSafeModelName, type Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, useCurrentUser, type Note } from './common';

export function SessionModelPanel({ session }: { session: Session }) {
  const t = useT();
  const me = useCurrentUser();
  const backend = useBoard((s) => s.backend);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const hasOptions = !!session.effort || !!session.fallbackModel;
  const badModel = !!session.model && !isSafeModelName(session.model);
  // 只給已結束的：還在跑的 CLI 已經帶著這些參數，改記錄也不會變。
  if (session.endedAt === null || (!hasOptions && !session.model)) return null;
  if (me.data?.role !== 'owner') return null;

  const reset = async (body: { options?: boolean; model?: boolean }) => {
    setBusy(true);
    setNote(null);
    try {
      await backend.resetSessionModel(session.id, body);
      setNote({ text: t('flows.modelReset.done') });
    } catch (e) {
      setNote({ text: t('flows.modelReset.failed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="xpand-panel session-model"
      aria-labelledby={`session-model-${session.id}`}
      data-testid="session-model-panel"
    >
      <h3 id={`session-model-${session.id}`}>{t('flows.modelReset.title')}</h3>
      <p className="sub">{t(badModel ? 'flows.modelReset.badModel' : 'flows.modelReset.why')}</p>
      <div className="flows">
        <div className="row">
          {hasOptions && (
            <button type="button" disabled={busy} onClick={() => void reset({ options: true })}>
              {t('flows.modelReset.options')}
            </button>
          )}
          {session.model && (
            <button type="button" disabled={busy} onClick={() => void reset({ model: true })}>
              {t('flows.modelReset.model')}
            </button>
          )}
        </div>
        <Msg note={note} />
      </div>
    </section>
  );
}
