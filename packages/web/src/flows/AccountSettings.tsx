// 設定「我的帳號」：登入身分、語言、這台裝置的推播（改密碼在 PasswordSection.tsx）。
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ErrorBox, errorText, Loading, Msg, type Note } from './common';
import { chooseLocale, savedLocaleChoice, type LocaleChoice } from './locale';
import { currentSubscription, disablePush, enablePush, pushSupport, readPushEnv } from './push';
import { Section, useSettingsUser } from './settingsParts';

/** 目前登入的是誰＋登出。原本放在「使用者」區；成員也要用得到，所以搬到我的帳號。 */
export function SignedInSection() {
  const t = useT();
  const { backend } = useBoard();
  const me = useSettingsUser();
  const [note, setNote] = useState<Note | null>(null);
  const logout = async () => {
    try {
      await backend.logout();
      setNote({ text: t('flows.user.loggedOut') });
      location.hash = '#/login';
    } catch (e) {
      setNote({ text: t('flows.user.logoutFailed', { error: errorText(e) }), tone: 'err' });
    }
  };
  return (
    <Section id="account" title={t('flows.settings.signedIn')}>
      {me.loading && !me.data ? (
        <Loading />
      ) : me.error ? (
        <ErrorBox
          what={t('flows.user.loadFailed', { error: me.error })}
          how={t('flows.retryHow')}
          onRetry={me.reload}
        />
      ) : me.data ? (
        <div className="rig-row signed-in">
          <div className="rig-name">
            <span className="sub">{t('flows.user.current')}</span>
            <strong>{me.data.name}</strong>
            <span className="chip">{t(`flows.user.role.${me.data.role}`)}</span>
          </div>
          <div className="acts">
            <button type="button" onClick={() => void logout()}>
              {t('flows.user.logout')}
            </button>
            <Msg note={note} />
          </div>
        </div>
      ) : null}
    </Section>
  );
}

export function LanguageSection() {
  const t = useT();
  const { backend } = useBoard();
  const [choice, setChoice] = useState<LocaleChoice>(savedLocaleChoice);
  // 只存錯誤本身，訊息在畫面上翻譯：語言剛換過，送出當下的 t 是舊語言。
  const [saveError, setSaveError] = useState<string | null>(null);
  const options: { value: LocaleChoice; label: string }[] = [
    { value: 'auto', label: t('flows.language.auto') },
    { value: 'zh-TW', label: '繁體中文' },
    { value: 'en', label: 'English' },
  ];
  return (
    <Section id="language" title={t('flows.settings.language')}>
      <div className="segmented" role="radiogroup" aria-label={t('flows.settings.language')}>
        {options.map((option) => (
          <label key={option.value} className={choice === option.value ? 'on' : ''}>
            <input
              type="radio"
              name="locale"
              checked={choice === option.value}
              onChange={() => {
                setChoice(option.value);
                setSaveError(null);
                // 畫面先換；存到帳號失敗時照實說，下次登入可能會變回去。
                chooseLocale(backend, option.value).catch((e: unknown) =>
                  setSaveError(errorText(e)),
                );
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
      <p className="hint">{t('flows.language.hint')}</p>
      <Msg
        note={
          saveError === null
            ? null
            : { text: t('flows.language.saveFailed', { error: saveError }), tone: 'err' }
        }
      />
    </Section>
  );
}

type PushState = 'checking' | 'on' | 'off';

/**
 * 推播是每台裝置各自訂閱的，和「通知」分類的「有 session 等你時推播」（hub 端總開關）分開。
 * 按下去才要通知權限：瀏覽器只准在使用者點擊時問，問了被拒就要使用者自己去設定改回來。
 */
export function PushDeviceSection() {
  const t = useT();
  const { backend, connected } = useBoard();
  const [support] = useState(() => pushSupport(readPushEnv()));
  const [state, setState] = useState<PushState>('checking');
  const [blocked, setBlocked] = useState(
    () => support === 'ok' && Notification.permission === 'denied',
  );
  const [publicKey, setPublicKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    if (support !== 'ok') return;
    let cancelled = false;
    currentSubscription()
      .then((subscription) => {
        if (!cancelled) setState(subscription ? 'on' : 'off');
      })
      .catch(() => {
        if (!cancelled) setState('off');
      });
    // 先拿好公鑰，點擊後才能立刻要權限（Safari 不准先 await 網路）。
    backend
      .pushVapidKey()
      .then((key) => {
        if (!cancelled) setPublicKey(key);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [backend, support]);

  const enable = async () => {
    setBusy(true);
    setNote({ text: t('flows.push.enabling') });
    try {
      const result = await enablePush(backend, publicKey);
      if (result === 'on') {
        setState('on');
        setNote({ text: t('flows.push.enabled') });
      } else if (result === 'denied') {
        setBlocked(true);
        setNote(null);
      } else {
        setNote({ text: t('flows.push.dismissed'), tone: 'err' });
      }
    } catch (e) {
      setNote({ text: t('flows.push.failed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setNote({ text: t('flows.push.disabling') });
    try {
      const { hubError } = await disablePush(backend);
      setState('off');
      setNote(
        hubError
          ? { text: t('flows.push.disableHubFailed', { error: errorText(hubError) }), tone: 'err' }
          : { text: t('flows.push.disabled') },
      );
    } catch (e) {
      setNote({ text: t('flows.push.disableFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (support !== 'ok') {
    body = (
      <p className="blocked" data-testid="push-unavailable">
        {t(`flows.push.${support}`, { origin: location.origin })}
      </p>
    );
  } else if (blocked) {
    body = (
      <p className="blocked" data-testid="push-unavailable">
        {t('flows.push.denied')}
      </p>
    );
  } else if (state === 'checking') {
    body = <Loading />;
  } else {
    body = (
      <>
        <p className="hint" data-testid="push-state">
          {t(state === 'on' ? 'flows.push.isOn' : 'flows.push.isOff')}
        </p>
        <div className="acts">
          {state === 'on' ? (
            <button type="button" disabled={busy} onClick={() => void disable()}>
              {t('flows.push.disable')}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy || !connected}
              onClick={() => void enable()}
            >
              {t('flows.push.enable')}
            </button>
          )}
          <Msg note={note} />
        </div>
      </>
    );
  }

  return (
    <Section id="push" title={t('flows.push.title')}>
      {body}
      <p className="hint">{t('flows.push.hint')}</p>
    </Section>
  );
}
