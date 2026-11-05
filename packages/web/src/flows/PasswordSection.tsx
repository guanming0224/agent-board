// 改自己的密碼（PATCH /api/users/:id 帶 currentPassword）。管理員重設別人的密碼在使用者清單（ResetPassword.tsx）。
import { useState } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, type Note, type T } from './common';
import { useSettingsUser } from './settingsParts';

/** 和新增使用者、首次引導一樣（protocol 的 Password）。 */
const MIN_PASSWORD = 8;

/** 後端丟出的錯誤帶 HTTP 狀態與 ApiError.code（同 LoginPage）。 */
interface ApiFailure {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
}

function failureText(t: T, e: unknown): string {
  const { status, code, retryAfterSeconds } = (e ?? {}) as ApiFailure;
  if (code === 'invalid_current_password') return t('flows.password.wrongCurrent');
  if (status === 429 || code === 'rate_limited') {
    return retryAfterSeconds
      ? t('flows.password.limitedMin', { n: Math.max(1, Math.ceil(retryAfterSeconds / 60)) })
      : t('flows.password.limited');
  }
  return t('flows.password.failed', { error: errorText(e) });
}

export function PasswordSection() {
  const t = useT();
  const { backend } = useBoard();
  const me = useSettingsUser();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const user = me.data;
  if (!user) return null;

  const submit = async () => {
    if (busy) return;
    const error = !current
      ? t('flows.password.needCurrent')
      : next.length < MIN_PASSWORD
        ? t('flows.password.short')
        : next !== confirm
          ? t('flows.password.mismatch')
          : next === current
            ? t('flows.password.same')
            : null;
    if (error) return setNote({ text: error, tone: 'err' });
    setBusy(true);
    setNote({ text: t('flows.password.saving') });
    try {
      await backend.changePassword({ userId: user.id, currentPassword: current, password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setNote({ text: t('flows.password.done') });
    } catch (e) {
      setNote({ text: failureText(t, e), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="form-card" aria-labelledby="password" id="s-password">
      <div className="section-head">
        <h2 id="password">{t('flows.settings.password')}</h2>
      </div>
      <form
        className="add-user password-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* 讓密碼管理員知道是哪個帳號。.flows input 設了 display: block，光靠 hidden 藏不住 */}
        <input
          type="text"
          autoComplete="username"
          value={user.name}
          readOnly
          hidden
          style={{ display: 'none' }}
        />
        <label>
          {t('flows.password.current')}
          <input
            type="password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          {t('flows.password.next')}
          <input
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label>
          {t('flows.password.confirm')}
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <p className="hint">{t('flows.password.hint')}</p>
        <div className="acts">
          <button type="submit" disabled={busy}>
            {t('flows.password.submit')}
          </button>
          <Msg note={note} />
        </div>
      </form>
    </section>
  );
}
