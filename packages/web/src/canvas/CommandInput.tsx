import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText } from '../views';

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
    <div className="cmd-row nodrag">
      <input
        ref={inputRef}
        className="cmd"
        value={text}
        disabled={!connected}
        placeholder={t('canvas.cmd.placeholder')}
        aria-label={t('canvas.cmd.aria', { name: session.name })}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {msg && (
        <span className="msg" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}
