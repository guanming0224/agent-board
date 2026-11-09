import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from 'react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText } from '../views';
import { dialogBlock } from './dialogBlock';

export function CommandInput({
  session,
  inputRef,
}: {
  session: Session;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  // 原生對話框在等決定：這裡打的字會被當成選項，改指向核准按鈕（xterm 裡照原生操作）。
  const block = useBoard((s) => dialogBlock(session, s.approvals));
  const hintId = useId();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!msg) return;
    const timer = setTimeout(() => setMsg(''), 3000);
    return () => clearTimeout(timer);
  }, [msg]);

  const send = () => {
    const prompt = text.trim();
    if (!prompt) return;
    // 打字時還在等輸入、按 Enter 前對話框剛跳出來：不送，字留著。
    if (block) {
      setMsg(t('canvas.cmd.blockedSend'));
      return;
    }
    try {
      backend.sendPrompt(session.id, prompt);
      setText('');
      setMsg(t('canvas.cmd.sent'));
    } catch (e) {
      setMsg(t('canvas.cmd.failed', { detail: errorText(e) }));
    }
  };

  // 中文輸入法選字時按的 Enter 不算送出。
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={`cmd-row nodrag${block ? ' blocked' : ''}`}>
      <input
        ref={inputRef}
        className="cmd sm"
        value={text}
        disabled={!connected || block !== null}
        placeholder={t(block ? 'canvas.cmd.blocked' : 'canvas.cmd.placeholder')}
        title={block ? t(`canvas.cmd.hint.${block}`) : undefined}
        aria-label={t('canvas.cmd.aria', { name: session.name })}
        aria-describedby={block ? hintId : undefined}
        data-blocked={block ?? undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {msg && (
        <span className="msg" role="status">
          {msg}
        </span>
      )}
      {block && (
        <p id={hintId} className="cmd-hint">
          {t(`canvas.cmd.hint.${block}`)}
        </p>
      )}
    </div>
  );
}
