// 配對指令：設定與首次引導共用。
import { useState } from 'react';
import { useMaskText } from '../security';
import type { BoardBackend } from '../shared/backend';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { CopyButton, errorText, Msg, type Note } from './common';

type Pairing = Awaited<ReturnType<BoardBackend['createPairingCode']>>;

export function PairingPanel() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const { backend, connected } = useBoard();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const create = async () => {
    setBusy(true);
    setNote(null);
    try {
      setPairing(await backend.createPairingCode());
    } catch (e) {
      setNote({ text: t('flows.pair.failed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pairing">
      {pairing && (
        <>
          <p className="sub">{t('flows.pair.step')}</p>
          <pre className="command" data-testid="pair-command">
            {mask(pairing.installCommand)}
          </pre>
          <CopyButton text={pairing.installCommand} />
          <p className="hint">
            {t('flows.pair.code', {
              code: mask(`--code ${pairing.code}`).replace('--code ', ''),
              time: new Date(pairing.expiresAt).toLocaleTimeString(locale),
            })}
          </p>
        </>
      )}
      <div className="acts">
        <button
          type="button"
          className={pairing ? '' : 'primary'}
          disabled={busy || !connected}
          onClick={() => void create()}
        >
          {pairing ? t('flows.pair.again') : t('flows.pair.create')}
        </button>
        <Msg note={note} />
      </div>
    </div>
  );
}
