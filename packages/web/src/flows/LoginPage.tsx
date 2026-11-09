// 登入。失敗訊息不轉述伺服器文字，帳號不存在和密碼錯誤對使用者一模一樣。
import { useEffect, useRef, useState } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, Page, type Note, type T } from './common';
import { LanguagePicker } from './LanguagePicker';
import { applyAccountLocale } from './locale';

/** 後端丟出的錯誤帶 HTTP 狀態與 ApiError.code；限速時另有 retry-after 秒數。 */
interface LoginError {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
}

function limitedMessage(t: T, seconds: number | undefined): string {
  if (!seconds) return t('flows.login.limited');
  if (seconds < 90) return t('flows.login.limitedSec', { n: seconds });
  return t('flows.login.limitedMin', { n: Math.ceil(seconds / 60) });
}

export function LoginPage() {
  const t = useT();
  const { backend } = useBoard();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const unlock = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(unlock.current), []);

  const submit = async () => {
    if (busy || locked) return;
    if (!name.trim() || !password) {
      setNote({ text: t('flows.login.required'), tone: 'err' });
      return;
    }
    setBusy(true);
    setNote({ text: t('flows.login.sending') });
    try {
      const user = await backend.login({ name: name.trim(), password });
      // 登入後畫面跟帳號的語言，不再跟登入前選的。
      applyAccountLocale(user);
      setPassword('');
      setNote(null);
      location.hash = '#/canvas';
    } catch (e) {
      const { status, code, retryAfterSeconds } = (e ?? {}) as LoginError;
      if (status === 429 || code === 'rate_limited') {
        setNote({ text: limitedMessage(t, retryAfterSeconds), tone: 'err' });
        if (retryAfterSeconds) {
          setLocked(true);
          unlock.current = setTimeout(() => {
            setLocked(false);
            setNote(null);
          }, retryAfterSeconds * 1000);
        }
      } else if (status === 401 || code === 'invalid_credentials') {
        setPassword('');
        setNote({ text: t('flows.login.invalid'), tone: 'err' });
        passwordRef.current?.focus();
      } else {
        setNote({ text: t('flows.login.failed', { error: errorText(e) }), tone: 'err' });
      }
    } finally {
      setBusy(false);
    }
  };

  // 還沒登入時 WebSocket 本來就連不上，不能把它當成資料過期。
  return (
    <Page narrow ignoreHub>
      <header className="page-head">
        <h1>{t('flows.login.title')}</h1>
        <span className="waiting-slot">
          <LanguagePicker />
        </span>
      </header>
      <form
        className="form-card login-form"
        aria-label={t('flows.login.title')}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="login-name">{t('flows.login.name')}</label>
          <input
            id="login-name"
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">{t('flows.user.password')}</label>
          <input
            id="login-password"
            ref={passwordRef}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="acts">
          <button type="submit" className="primary" disabled={busy || locked}>
            {t('flows.login.submit')}
          </button>
          <Msg note={note} />
        </div>
      </form>
      {/* 忘記密碼：別的管理員可以在設定頁重設；只有一個管理員時只能在 hub 機器上用指令。 */}
      <p className="hint" data-testid="login-forgot">
        {t('flows.login.forgotOwner')} {t('flows.login.forgotCli')}{' '}
        <code>{`agent-board-hub reset-password <${t('flows.login.forgotArg')}>`}</code>
      </p>
    </Page>
  );
}
