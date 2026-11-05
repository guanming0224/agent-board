// 設定：機器、使用者、範本、通知與勿擾、安全、省額度、語言（DISPATCH §5.3-7）。
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Machine, Settings, Template, User } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  Empty,
  ErrorBox,
  errorText,
  Loading,
  ModeChip,
  Msg,
  Page,
  useLoad,
  useTwoStep,
  type Note,
} from './common';
import { ArchivedSection } from './ArchivedSection';
import { AuditSection } from './AuditSection';
import { chooseLocale, savedLocaleChoice, type LocaleChoice } from './locale';
import { PairingPanel } from './PairingPanel';
import { currentSubscription, disablePush, enablePush, pushSupport, readPushEnv } from './push';
import { PasswordSection } from './PasswordSection';
import { ResetPassword } from './ResetPassword';
import { listenAddressError, originError } from './validation';

/**
 * REST 已有這些路由（protocol/rest.ts），但 BoardBackend 還沒開放。
 * 寫成選用：後端補上方法後畫面自動可用，沒補時照實告訴使用者。
 */
interface OptionalAdmin {
  listUsers?: () => Promise<User[]>;
  createUser?: (input: {
    name: string;
    password: string;
    role: User['role'];
    locale: User['locale'];
  }) => Promise<User>;
  deleteUser?: (id: string) => Promise<void>;
  deleteTemplate?: (id: string) => Promise<void>;
}
type AdminBackend = BoardBackend & OptionalAdmin;

function Section({
  id,
  title,
  dirty,
  children,
}: {
  id: string;
  title: string;
  dirty?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className={`form-card${dirty ? ' dirty' : ''}`} aria-labelledby={id} id={`s-${id}`}>
      <div className="section-head">
        <h2 id={id}>{title}</h2>
        {dirty && <span className="chip unsaved">{t('flows.settings.unsaved')}</span>}
      </div>
      {children}
    </section>
  );
}

function MachineRow({ machine }: { machine: Machine }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { backend, sessions, connected } = useBoard();
  const twoStep = useTwoStep();
  const [note, setNote] = useState<Note | null>(null);
  const active = sessions.filter((s) => s.machineId === machine.id && !s.archived).length;
  const { hasGpu, gpuName, cpuCores, memoryBytes } = machine.capabilities;
  const remove = () =>
    twoStep.press(() => {
      backend
        .removeMachine(machine.id)
        .catch((e: unknown) =>
          setNote({ text: t('flows.machine.removeFailed', { error: errorText(e) }), tone: 'err' }),
        );
    });
  return (
    <li className={`rig-row${machine.online ? '' : ' off'}`} data-testid={`machine-${machine.id}`}>
      <div className="rig-name">
        {machine.online ? (
          <span className="dot" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">⊘</span>
        )}
        <strong>{machine.name}</strong>
        <span className="sub">{t(machine.online ? 'flows.machine.online' : 'status.offline')}</span>
      </div>
      <div className="sub">
        {machine.os} · {cpuCores} CPU · {Math.round(memoryBytes / 1024 ** 3)} GB
        {hasGpu ? ` · ${gpuName ?? 'GPU'}` : ''}
      </div>
      {!machine.online && machine.lastSeenAt && (
        <div className="sub">
          {t('flows.machine.lastSeen', {
            time: new Date(machine.lastSeenAt).toLocaleString(locale),
          })}
        </div>
      )}
      <div className="acts">
        <button type="button" className="danger" disabled={!connected} onClick={remove}>
          {twoStep.armed ? t('flows.machine.removeAgain') : t('flows.machine.remove')}
        </button>
        {twoStep.armed ? (
          <span className="msg" role="status">
            {t('flows.machine.removeHint', { n: active })}
          </span>
        ) : (
          <Msg note={note} />
        )}
      </div>
    </li>
  );
}

function MachinesSection() {
  const t = useT();
  const { machines } = useBoard();
  return (
    <Section id="machines" title={t('flows.settings.machines')}>
      {machines.length === 0 ? (
        <Empty title={t('flows.machine.none')} next={t('flows.machine.noneNext')} />
      ) : (
        <ul className="rows">
          {machines.map((machine) => (
            <MachineRow key={machine.id} machine={machine} />
          ))}
        </ul>
      )}
      <PairingPanel />
    </Section>
  );
}

function UserRow({
  user,
  onDeleted,
  self,
  canReset = false,
}: {
  user: User;
  onDeleted: () => void;
  self: boolean;
  /** 目前登入的是 owner：可以重設別人的密碼（自己的走「改密碼」）。 */
  canReset?: boolean;
}) {
  const t = useT();
  const { backend } = useBoard();
  const admin = backend as AdminBackend;
  const twoStep = useTwoStep();
  const [note, setNote] = useState<Note | null>(null);
  return (
    <li className="rig-row">
      <div className="rig-name">
        <strong>{user.name}</strong>
        <span className="chip">{t(`flows.user.role.${user.role}`)}</span>
      </div>
      {!self && admin.deleteUser && (
        <div className="acts">
          <button
            type="button"
            className="danger"
            onClick={() =>
              twoStep.press(() => {
                admin.deleteUser?.(user.id).then(onDeleted, (e: unknown) =>
                  setNote({
                    text: t('flows.user.deleteFailed', { error: errorText(e) }),
                    tone: 'err',
                  }),
                );
              })
            }
          >
            {twoStep.armed ? t('flows.user.deleteAgain') : t('flows.user.delete')}
          </button>
          <Msg note={note} />
        </div>
      )}
      {!self && canReset && <ResetPassword user={user} />}
    </li>
  );
}

function AddUser({ onAdded }: { onAdded: () => void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { backend } = useBoard();
  const admin = backend as AdminBackend;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<User['role']>('member');
  const [note, setNote] = useState<Note | null>(null);
  const add = async () => {
    if (!name.trim()) return setNote({ text: t('flows.user.needName'), tone: 'err' });
    if (password.length < 8) return setNote({ text: t('flows.user.shortPassword'), tone: 'err' });
    try {
      await admin.createUser?.({ name: name.trim(), password, role, locale });
      setName('');
      setPassword('');
      setNote({ text: t('flows.user.added') });
      onAdded();
    } catch (e) {
      setNote({ text: t('flows.user.addFailed', { error: errorText(e) }), tone: 'err' });
    }
  };
  return (
    <div className="add-user">
      <label>
        {t('flows.user.name')}
        <input value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        {t('flows.user.password')}
        <input
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        {t('flows.user.role')}
        <select value={role} onChange={(e) => setRole(e.target.value as User['role'])}>
          <option value="member">{t('flows.user.role.member')}</option>
          <option value="owner">{t('flows.user.role.owner')}</option>
        </select>
      </label>
      <div className="acts">
        <button type="button" onClick={() => void add()}>
          {t('flows.user.add')}
        </button>
        <Msg note={note} />
      </div>
    </div>
  );
}

function UsersSection() {
  const t = useT();
  const { backend } = useBoard();
  const admin = backend as AdminBackend;
  const me = useLoad(useCallback(() => backend.currentUser(), [backend]));
  const users = useLoad(
    useCallback(async () => (admin.listUsers ? admin.listUsers() : null), [admin]),
  );
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
    <Section id="users" title={t('flows.settings.users')}>
      {me.loading && !me.data ? (
        <Loading />
      ) : me.error ? (
        <ErrorBox
          what={t('flows.user.loadFailed', { error: me.error })}
          how={t('flows.retryHow')}
          onRetry={me.reload}
        />
      ) : me.data ? (
        <div className="rig-row">
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
      {!admin.listUsers ? (
        <p className="hint" data-testid="users-unavailable">
          {t('flows.user.unavailable')}
        </p>
      ) : users.error ? (
        <ErrorBox
          what={t('flows.user.listFailed', { error: users.error })}
          how={t('flows.retryHow')}
          onRetry={users.reload}
        />
      ) : (
        <>
          <ul className="rows">
            {users.data?.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                self={user.id === me.data?.id}
                canReset={me.data?.role === 'owner'}
                onDeleted={users.reload}
              />
            ))}
          </ul>
          {admin.createUser && <AddUser onAdded={users.reload} />}
        </>
      )}
    </Section>
  );
}

function TemplateRow({ template, onDeleted }: { template: Template; onDeleted: () => void }) {
  const t = useT();
  const { backend, machines } = useBoard();
  const admin = backend as AdminBackend;
  const twoStep = useTwoStep();
  const [note, setNote] = useState<Note | null>(null);
  const { config } = template;
  const machine = machines.find((m) => m.id === config.machineId);
  return (
    <li className="rig-row">
      <div className="rig-name">
        <strong>{template.name}</strong>
        <ModeChip mode={config.permissionMode} />
      </div>
      <div className="sub">
        {machine?.name ?? t('flows.template.anyMachine')}
        {config.cwd ? ` · ${config.cwd}` : ''}
        {config.model ? ` · ${config.model}` : ''}
      </div>
      {admin.deleteTemplate && (
        <div className="acts">
          <button
            type="button"
            className="danger"
            onClick={() =>
              twoStep.press(() => {
                admin.deleteTemplate?.(template.id).then(onDeleted, (e: unknown) =>
                  setNote({
                    text: t('flows.template.deleteFailed', { error: errorText(e) }),
                    tone: 'err',
                  }),
                );
              })
            }
          >
            {twoStep.armed ? t('flows.template.deleteAgain') : t('flows.template.delete')}
          </button>
          <Msg note={note} />
        </div>
      )}
    </li>
  );
}

function TemplatesSection() {
  const t = useT();
  const { backend } = useBoard();
  const templates = useLoad(useCallback(() => backend.listTemplates(), [backend]));
  return (
    <Section id="templates" title={t('flows.settings.templates')}>
      {templates.loading && !templates.data ? (
        <Loading />
      ) : templates.error ? (
        <ErrorBox
          what={t('flows.error.templates', { error: templates.error })}
          how={t('flows.retryHow')}
          onRetry={templates.reload}
        />
      ) : templates.data?.length === 0 ? (
        <Empty
          title={t('flows.template.none')}
          next={<a href="#/new">{t('flows.template.noneNext')}</a>}
        />
      ) : (
        <>
          <ul className="rows">
            {templates.data?.map((template) => (
              <TemplateRow key={template.id} template={template} onDeleted={templates.reload} />
            ))}
          </ul>
          <p className="hint">
            <a href="#/new">{t('flows.template.noneNext')}</a>
          </p>
        </>
      )}
    </Section>
  );
}

function LanguageSection() {
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
 * 推播是每台裝置各自訂閱的，和下面「有 session 等你時推播」（hub 端總開關）分開。
 * 按下去才要通知權限：瀏覽器只准在使用者點擊時問，問了被拒就要使用者自己去設定改回來。
 */
function PushDeviceSection() {
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

type SettingsKey = keyof Settings;

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function SettingsForm({ initial }: { initial: Settings }) {
  const t = useT();
  const { backend, connected } = useBoard();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [newRule, setNewRule] = useState('');
  const [ruleNote, setRuleNote] = useState<Note | null>(null);
  const [denyText, setDenyText] = useState(initial.quotaGuards.denyReadPaths.join('\n'));
  const [maxText, setMaxText] = useState(
    initial.quotaGuards.maxConcurrentSessions?.toString() ?? '',
  );
  const [stuckText, setStuckText] = useState(String(initial.stuckMinutes));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const patch = (next: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...next }));
    setNote(null);
  };
  const dirtyKeys = (Object.keys(saved) as SettingsKey[]).filter(
    (key) => !sameValue(saved[key], draft[key]),
  );
  const isDirty = (...keys: SettingsKey[]) => keys.some((key) => dirtyKeys.includes(key));

  // 離開前提醒，免得改了半天沒存。
  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirtyKeys.length]);

  const addressError = listenAddressError(draft.listenAddress);
  const badOrigin = originError(draft.publicOrigin ?? '');
  const stuckValid = /^[1-9]\d*$/.test(stuckText.trim());
  const maxValid = maxText.trim() === '' || /^[1-9]\d*$/.test(maxText.trim());
  const quiet = draft.notifications.quietHours;
  const quietInvalid = quiet !== null && (!quiet.start || !quiet.end);
  const invalid = addressError !== null || badOrigin || !stuckValid || !maxValid || quietInvalid;

  const addRule = () => {
    const rule = newRule.trim().replace(/\s+/g, ' ');
    if (!rule) return setRuleNote({ text: t('flows.security.ruleEmpty'), tone: 'err' });
    if (draft.dangerRules.includes(rule)) {
      return setRuleNote({ text: t('flows.security.ruleDuplicate'), tone: 'err' });
    }
    patch({ dangerRules: [...draft.dangerRules, rule] });
    setNewRule('');
    setRuleNote(null);
  };

  const save = async () => {
    if (invalid) {
      setNote({ text: t('flows.settings.fixFirst'), tone: 'err' });
      return;
    }
    const changes = Object.fromEntries(dirtyKeys.map((key) => [key, draft[key]]));
    setBusy(true);
    setNote({ text: t('flows.settings.saving') });
    try {
      const next = await backend.updateSettings(changes as Partial<Settings>);
      setSaved(next);
      setDraft(next);
      setNote({ text: t('flows.settings.saved') });
    } catch (e) {
      setNote({ text: t('flows.settings.saveFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    setDraft(saved);
    setDenyText(saved.quotaGuards.denyReadPaths.join('\n'));
    setMaxText(saved.quotaGuards.maxConcurrentSessions?.toString() ?? '');
    setStuckText(String(saved.stuckMinutes));
    setNewRule('');
    setRuleNote(null);
    setNote(null);
  };

  return (
    <>
      <Section id="notify" title={t('flows.settings.notify')} dirty={isDirty('notifications')}>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.notifications.enabled}
            onChange={(e) =>
              patch({ notifications: { ...draft.notifications, enabled: e.target.checked } })
            }
          />
          {t('flows.notify.enabled')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={quiet !== null}
            onChange={(e) =>
              patch({
                notifications: {
                  ...draft.notifications,
                  quietHours: e.target.checked ? { start: '22:00', end: '08:00' } : null,
                },
              })
            }
          />
          {t('flows.notify.quiet')}
        </label>
        {quiet && (
          <div className="input-row">
            <label>
              {t('flows.notify.start')}
              <input
                type="time"
                value={quiet.start}
                onChange={(e) =>
                  patch({
                    notifications: {
                      ...draft.notifications,
                      quietHours: { ...quiet, start: e.target.value },
                    },
                  })
                }
              />
            </label>
            <label>
              {t('flows.notify.end')}
              <input
                type="time"
                value={quiet.end}
                onChange={(e) =>
                  patch({
                    notifications: {
                      ...draft.notifications,
                      quietHours: { ...quiet, end: e.target.value },
                    },
                  })
                }
              />
            </label>
          </div>
        )}
        {quietInvalid && <p className="field-error">{t('flows.notify.needTimes')}</p>}
      </Section>

      <Section
        id="security"
        title={t('flows.settings.security')}
        dirty={isDirty('listenAddress', 'publicOrigin', 'dangerRules', 'stuckMinutes')}
      >
        <div className="field">
          <label htmlFor="st-listen">{t('flows.security.listen')}</label>
          <input
            id="st-listen"
            className="mono"
            value={draft.listenAddress}
            aria-invalid={addressError !== null}
            onChange={(e) => patch({ listenAddress: e.target.value.trim() })}
          />
          <p className="hint">{t('flows.security.listenHint')}</p>
          {addressError && (
            <p className="field-error" data-testid="listen-error">
              {t(`flows.security.listenErr.${addressError}`)}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="st-origin">{t('flows.security.origin')}</label>
          <input
            id="st-origin"
            className="mono"
            value={draft.publicOrigin ?? ''}
            aria-invalid={badOrigin}
            onChange={(e) => patch({ publicOrigin: e.target.value.trim() || null })}
          />
          <p className="hint">{t('flows.security.originHint')}</p>
          {badOrigin && <p className="field-error">{t('flows.security.originErr')}</p>}
        </div>
        <div className="field">
          <label htmlFor="st-stuck">{t('flows.security.stuck')}</label>
          <input
            id="st-stuck"
            className="short num"
            inputMode="numeric"
            value={stuckText}
            aria-invalid={!stuckValid}
            onChange={(e) => {
              setStuckText(e.target.value);
              if (/^[1-9]\d*$/.test(e.target.value.trim())) {
                patch({ stuckMinutes: Number(e.target.value) });
              }
            }}
          />
          {!stuckValid && <p className="field-error">{t('flows.security.positiveInt')}</p>}
        </div>
        <div className="field">
          <span className="label">{t('flows.security.rules')}</span>
          <p className="hint">{t('flows.security.rulesHint')}</p>
          {draft.dangerRules.length === 0 && (
            <p className="field-error">{t('flows.security.rulesEmpty')}</p>
          )}
          <ul className="rule-list" data-testid="danger-rules">
            {draft.dangerRules.map((rule) => (
              <li key={rule}>
                <code>{rule}</code>
                <button
                  type="button"
                  aria-label={t('flows.security.removeRule', { rule })}
                  onClick={() =>
                    patch({ dangerRules: draft.dangerRules.filter((r) => r !== rule) })
                  }
                >
                  {t('flows.security.remove')}
                </button>
              </li>
            ))}
          </ul>
          <div className="input-row">
            <input
              className="mono"
              value={newRule}
              aria-label={t('flows.security.newRule')}
              placeholder={t('flows.security.newRule')}
              onChange={(e) => setNewRule(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addRule();
                }
              }}
            />
            <button type="button" onClick={addRule}>
              {t('flows.security.add')}
            </button>
          </div>
          <Msg note={ruleNote} />
        </div>
      </Section>

      <Section id="quota" title={t('flows.settings.quota')} dirty={isDirty('quotaGuards')}>
        <div className="field">
          <label htmlFor="st-deny">{t('flows.quota.deny')}</label>
          <textarea
            id="st-deny"
            className="mono"
            rows={4}
            value={denyText}
            onChange={(e) => {
              setDenyText(e.target.value);
              patch({
                quotaGuards: {
                  ...draft.quotaGuards,
                  denyReadPaths: e.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean),
                },
              });
            }}
          />
          <p className="hint">{t('flows.quota.denyHint')}</p>
        </div>
        <div className="field">
          <label htmlFor="st-max">{t('flows.quota.max')}</label>
          <input
            id="st-max"
            className="short num"
            inputMode="numeric"
            value={maxText}
            aria-invalid={!maxValid}
            onChange={(e) => {
              const value = e.target.value;
              setMaxText(value);
              if (value.trim() === '' || /^[1-9]\d*$/.test(value.trim())) {
                patch({
                  quotaGuards: {
                    ...draft.quotaGuards,
                    maxConcurrentSessions: value.trim() === '' ? null : Number(value),
                  },
                });
              }
            }}
          />
          <p className="hint">{t('flows.quota.maxHint')}</p>
          {!maxValid && <p className="field-error">{t('flows.security.positiveInt')}</p>}
        </div>
        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              data-testid="quota-queue-limited"
              checked={draft.quotaGuards.queueWhenRateLimited}
              onChange={(e) =>
                patch({
                  quotaGuards: { ...draft.quotaGuards, queueWhenRateLimited: e.target.checked },
                })
              }
            />
            {t('flows.quota.queueLimited')}
          </label>
          <p className="hint">{t('flows.quota.queueLimitedHint')}</p>
        </div>
      </Section>

      <div className={`save-bar${dirtyKeys.length > 0 ? ' on' : ''}`} data-testid="save-bar">
        <span className="save-count">
          {dirtyKeys.length > 0
            ? t('flows.settings.unsavedCount', { n: dirtyKeys.length })
            : t('flows.settings.allSaved')}
        </span>
        <div className="acts">
          <button
            type="button"
            className="primary"
            disabled={busy || !connected || dirtyKeys.length === 0}
            onClick={() => void save()}
          >
            {t('flows.settings.save')}
          </button>
          <button type="button" disabled={busy || dirtyKeys.length === 0} onClick={revert}>
            {t('flows.settings.revert')}
          </button>
          <Msg note={note} />
        </div>
      </div>
    </>
  );
}

export function SettingsPage() {
  const t = useT();
  const { backend } = useBoard();
  const settings = useLoad(useCallback(() => backend.getSettings(), [backend]));
  return (
    <Page>
      <header className="page-head">
        <h1>{t('flows.settings.title')}</h1>
      </header>
      <div className="settings-grid">
        <div className="settings-col">
          <LanguageSection />
          <MachinesSection />
          <UsersSection />
          <PasswordSection />
          <TemplatesSection />
        </div>
        <div className="settings-col">
          <PushDeviceSection />
          {settings.error ? (
            <ErrorBox
              what={t('flows.settings.loadFailed', { error: settings.error })}
              how={t('flows.settings.loadHow')}
              onRetry={settings.reload}
            />
          ) : settings.data ? (
            <SettingsForm initial={settings.data} />
          ) : (
            <Loading />
          )}
        </div>
      </div>
      <ArchivedSection />
      <AuditSection />
    </Page>
  );
}
