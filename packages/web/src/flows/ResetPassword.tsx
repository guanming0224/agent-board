// 管理員重設別人的密碼（POST /api/users/:id/reset-password）。不需要對方的舊密碼，對方所有裝置登出。
// 只放在設定頁使用者清單「別人」那一列，而且只有 owner 看得到；hub 另外會擋非 owner。
import { useState } from 'react';
import type { User } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, type Note } from './common';

/** 和新增使用者、改密碼一樣（protocol 的 MIN_PASSWORD_LENGTH）。 */
const MIN_PASSWORD = 8;

/** hubBackend 有、BoardBackend 介面沒有的選用方法（同 settingsParts.tsx 的 OptionalAdmin）。 */
export interface OptionalReset {
  resetUserPassword?: (id: string, password: string) => Promise<void>;
}

export function ResetPassword({ user }: { user: User }) {
  const t = useT();
  const { backend } = useBoard();
  const reset = (backend as typeof backend & OptionalReset).resetUserPassword;
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  if (!reset) return null;

  if (!open) {
    return (
      <div className="acts">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setNote(null);
          }}
        >
          {t('flows.user.reset')}
        </button>
        <Msg note={note} />
      </div>
    );
  }

  const close = () => {
    setOpen(false);
    setNext('');
    setConfirm('');
  };
  const submit = async () => {
    if (busy) return;
    const error =
      next.length < MIN_PASSWORD
        ? t('flows.user.shortPassword')
        : next !== confirm
          ? t('flows.password.mismatch')
          : null;
    if (error) return setNote({ text: error, tone: 'err' });
    setBusy(true);
    setNote({ text: t('flows.user.resetSaving') });
    try {
      await reset(user.id, next);
      close();
      setNote({ text: t('flows.user.resetDone', { name: user.name }) });
    } catch (e) {
      setNote({ text: t('flows.user.resetFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="add-user password-form reset-password"
      aria-label={t('flows.user.resetTitle', { name: user.name })}
      data-testid={`reset-${user.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <strong>{t('flows.user.resetTitle', { name: user.name })}</strong>
      {/* 讓密碼管理員知道是哪個帳號，不要存成自己的密碼。.flows input 設了 display: block，光靠 hidden 藏不住 */}
      <input
        type="text"
        autoComplete="username"
        value={user.name}
        readOnly
        hidden
        style={{ display: 'none' }}
      />
      <label>
        {t('flows.user.resetNew')}
        <input
          type="password"
          value={next}
          autoComplete="new-password"
          autoFocus
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label>
        {t('flows.user.resetConfirm')}
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <p className="hint">{t('flows.user.resetHint', { name: user.name })}</p>
      <div className="acts">
        <button type="submit" disabled={busy}>
          {t('flows.user.resetSubmit')}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          {t('flows.user.resetCancel')}
        </button>
        <Msg note={note} />
      </div>
    </form>
  );
}
