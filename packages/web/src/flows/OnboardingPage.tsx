// 首次引導：建立管理員 → 加入第一台機器 → 開第一個 session。正式環境一開始是空的，這裡不放範例資料。
import { useCallback, useState } from 'react';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ErrorBox, errorText, Loading, Msg, Page, useLoad, type Note } from './common';
import { LanguagePicker } from './LanguagePicker';
import { PairingPanel } from './PairingPanel';

const MIN_PASSWORD = 8;

function Stepper({ step }: { step: number }) {
  const t = useT();
  const labels = [t('flows.onboard.step1'), t('flows.onboard.step2'), t('flows.onboard.step3')];
  return (
    <ol className="stepper">
      {labels.map((label, i) => (
        <li
          key={label}
          className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}
          aria-current={i + 1 === step ? 'step' : undefined}
        >
          <span className="num">{i + 1 < step ? '✓' : i + 1}</span> {label}
        </li>
      ))}
    </ol>
  );
}

function CreateAdmin({ onDone }: { onDone: () => void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { backend } = useBoard();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const submit = async () => {
    if (!name.trim()) return setNote({ text: t('flows.user.needName'), tone: 'err' });
    if (password.length < MIN_PASSWORD) {
      return setNote({ text: t('flows.user.shortPassword'), tone: 'err' });
    }
    if (password !== confirm) {
      return setNote({ text: t('flows.onboard.mismatch'), tone: 'err' });
    }
    setBusy(true);
    setNote(null);
    try {
      await backend.setup({ name: name.trim(), password, locale });
      onDone();
    } catch (e) {
      setNote({ text: t('flows.onboard.setupFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form-card"
      aria-label={t('flows.onboard.step1')}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>{t('flows.onboard.step1')}</h2>
      <p className="sub">{t('flows.onboard.adminIntro')}</p>
      <div className="field">
        <label htmlFor="ob-name">{t('flows.user.name')}</label>
        <input
          id="ob-name"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="ob-password">{t('flows.user.password')}</label>
        <input
          id="ob-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="hint">{t('flows.user.passwordHint')}</p>
      </div>
      <div className="field">
        <label htmlFor="ob-confirm">{t('flows.onboard.confirm')}</label>
        <input
          id="ob-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <div className="acts">
        <button type="submit" className="primary" disabled={busy}>
          {t('flows.onboard.createAdmin')}
        </button>
        <Msg note={note} />
      </div>
    </form>
  );
}

function AddMachine({ onNext }: { onNext: () => void }) {
  const t = useT();
  const { machines } = useBoard();
  const first = machines[0];
  return (
    <section className="form-card" aria-label={t('flows.onboard.step2')}>
      <h2>{t('flows.onboard.step2')}</h2>
      <p className="sub">{t('flows.onboard.machineIntro')}</p>
      <PairingPanel />
      {first ? (
        <p className="connected" role="status" data-testid="machine-connected">
          <span className="dot" aria-hidden="true" />{' '}
          {t('flows.onboard.connected', { machine: first.name })}
        </p>
      ) : (
        <p className="hint" role="status" data-testid="machine-waiting">
          {t('flows.onboard.waitingMachine')}
        </p>
      )}
      <div className="acts">
        <button type="button" className="primary" disabled={!first} onClick={onNext}>
          {t('flows.onboard.next')}
        </button>
        {!first && (
          <button type="button" onClick={onNext}>
            {t('flows.onboard.skip')}
          </button>
        )}
      </div>
    </section>
  );
}

function FirstSession() {
  const t = useT();
  const { machines } = useBoard();
  return (
    <section className="form-card" aria-label={t('flows.onboard.step3')}>
      <h2>{t('flows.onboard.step3')}</h2>
      {machines.length > 0 ? (
        <>
          <p className="sub">{t('flows.onboard.sessionIntro')}</p>
          <p>
            <a className="button primary" href="#/new">
              {t('flows.new.title')}
            </a>
          </p>
        </>
      ) : (
        <>
          <p className="sub">{t('flows.onboard.noMachineYet')}</p>
          <p>
            <a className="button" href="#/settings">
              {t('flows.onboard.toSettings')}
            </a>
          </p>
        </>
      )}
    </section>
  );
}

export function OnboardingPage() {
  const t = useT();
  const { backend } = useBoard();
  const needsSetup = useLoad(useCallback(() => backend.needsSetup(), [backend]));
  const [step, setStep] = useState<number | null>(null);

  const current = step ?? (needsSetup.data ? 1 : 2);

  return (
    // 建立管理員之前還沒登入，WebSocket 本來就連不上。
    <Page narrow ignoreHub={current === 1}>
      <header className="page-head">
        <h1>{t('flows.onboard.title')}</h1>
        <span className="waiting-slot">
          <LanguagePicker />
        </span>
      </header>
      {needsSetup.error ? (
        <ErrorBox
          what={t('flows.onboard.loadFailed', { error: needsSetup.error })}
          how={t('flows.onboard.loadHow')}
          onRetry={needsSetup.reload}
        />
      ) : needsSetup.data === null ? (
        <Loading />
      ) : (
        <>
          <Stepper step={current} />
          {current === 1 && <CreateAdmin onDone={() => setStep(2)} />}
          {current === 2 && <AddMachine onNext={() => setStep(3)} />}
          {current === 3 && <FirstSession />}
        </>
      )}
    </Page>
  );
}
