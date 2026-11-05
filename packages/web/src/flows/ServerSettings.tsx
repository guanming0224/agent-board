// hub 端設定（只有 owner）：分散在「通知」「Session 與額度」「安全」三個分類，共用一份草稿與一個儲存列。
// 草稿放在設定頁這一層，切換分類不會不見；選單用 dirtyCategories 標出哪些分類還沒存。
import { useEffect, useState } from 'react';
import type { Settings } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, type Note } from './common';
import { KEY_CATEGORY, settingsHash, type Category } from './settingsNav';
import { Section } from './settingsParts';
import { listenAddressError, originError } from './validation';

type SettingsKey = keyof Settings;

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const POSITIVE_INT = /^[1-9]\d*$/;

/** 輸入框裡的原始文字：不合法的值不寫進草稿，但要留在框裡讓人改。 */
interface Texts {
  deny: string;
  max: string;
  stuck: string;
  newRule: string;
}

const textsOf = (s: Settings | null): Texts => ({
  deny: s?.quotaGuards.denyReadPaths.join('\n') ?? '',
  max: s?.quotaGuards.maxConcurrentSessions?.toString() ?? '',
  stuck: s ? String(s.stuckMinutes) : '',
  newRule: '',
});

export interface ServerSettingsForm {
  draft: Settings;
  texts: Texts;
  setText: (key: keyof Texts, value: string) => void;
  patch: (next: Partial<Settings>) => void;
  dirtyKeys: SettingsKey[];
  isDirty: (...keys: SettingsKey[]) => boolean;
  dirtyCategories: ReadonlySet<Category>;
  /** 有欄位不合法的分類；按儲存時由儲存列決定要不要切過去。 */
  invalidCategories: ReadonlySet<Category>;
  addressError: ReturnType<typeof listenAddressError>;
  badOrigin: boolean;
  stuckValid: boolean;
  maxValid: boolean;
  quietInvalid: boolean;
  ruleNote: Note | null;
  addRule: () => void;
  busy: boolean;
  note: Note | null;
  save: () => Promise<void>;
  revert: () => void;
}

/** 第一次讀到設定才填入；之後重新讀取不會蓋掉草稿（和原本只在掛上時讀一次相同）。 */
export function useServerSettings(loaded: Settings | null): ServerSettingsForm | null {
  const t = useT();
  const { backend } = useBoard();
  const [saved, setSaved] = useState<Settings | null>(loaded);
  const [draft, setDraft] = useState<Settings | null>(loaded);
  const [texts, setTexts] = useState<Texts>(() => textsOf(loaded));
  const [ruleNote, setRuleNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  if (loaded && !saved) {
    setSaved(loaded);
    setDraft(loaded);
    setTexts(textsOf(loaded));
  }

  const dirtyKeys =
    saved && draft
      ? (Object.keys(saved) as SettingsKey[]).filter((key) => !sameValue(saved[key], draft[key]))
      : [];

  // 離開前提醒，免得改了半天沒存。
  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirtyKeys.length]);

  if (!saved || !draft) return null;

  const patch = (next: Partial<Settings>) => {
    setDraft((d) => (d ? { ...d, ...next } : d));
    setNote(null);
  };
  const setText = (key: keyof Texts, value: string) =>
    setTexts((prev) => ({ ...prev, [key]: value }));

  const addressError = listenAddressError(draft.listenAddress);
  const badOrigin = originError(draft.publicOrigin ?? '');
  const stuckValid = POSITIVE_INT.test(texts.stuck.trim());
  const maxValid = texts.max.trim() === '' || POSITIVE_INT.test(texts.max.trim());
  const quiet = draft.notifications.quietHours;
  const quietInvalid = quiet !== null && (!quiet.start || !quiet.end);

  const invalidCategories = new Set<Category>();
  if (quietInvalid) invalidCategories.add('notify');
  if (!stuckValid || !maxValid) invalidCategories.add('sessions');
  if (addressError !== null || badOrigin) invalidCategories.add('security');

  const addRule = () => {
    const rule = texts.newRule.trim().replace(/\s+/g, ' ');
    if (!rule) return setRuleNote({ text: t('flows.security.ruleEmpty'), tone: 'err' });
    if (draft.dangerRules.includes(rule)) {
      return setRuleNote({ text: t('flows.security.ruleDuplicate'), tone: 'err' });
    }
    patch({ dangerRules: [...draft.dangerRules, rule] });
    setText('newRule', '');
    setRuleNote(null);
  };

  const save = async () => {
    if (invalidCategories.size > 0) {
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
    setTexts(textsOf(saved));
    setRuleNote(null);
    setNote(null);
  };

  return {
    draft,
    texts,
    setText,
    patch,
    dirtyKeys,
    isDirty: (...keys) => keys.some((key) => dirtyKeys.includes(key)),
    dirtyCategories: new Set(dirtyKeys.map((key) => KEY_CATEGORY[key])),
    invalidCategories,
    addressError,
    badOrigin,
    stuckValid,
    maxValid,
    quietInvalid,
    ruleNote,
    addRule,
    busy,
    note,
    save,
    revert,
  };
}

export function NotifySection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch, quietInvalid } = form;
  const quiet = draft.notifications.quietHours;
  return (
    <Section id="notify" title={t('flows.settings.notify')} dirty={form.isDirty('notifications')}>
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
  );
}

export function StuckSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { texts, stuckValid } = form;
  return (
    <Section id="stuck" title={t('flows.settings.stuck')} dirty={form.isDirty('stuckMinutes')}>
      <div className="field">
        <label htmlFor="st-stuck">{t('flows.security.stuck')}</label>
        <input
          id="st-stuck"
          className="short num"
          inputMode="numeric"
          value={texts.stuck}
          aria-invalid={!stuckValid}
          onChange={(e) => {
            form.setText('stuck', e.target.value);
            if (POSITIVE_INT.test(e.target.value.trim())) {
              form.patch({ stuckMinutes: Number(e.target.value) });
            }
          }}
        />
        {!stuckValid && <p className="field-error">{t('flows.security.positiveInt')}</p>}
      </div>
    </Section>
  );
}

export function SecuritySection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch, addressError, badOrigin } = form;
  return (
    <Section
      id="security"
      title={t('flows.settings.security')}
      dirty={form.isDirty('listenAddress', 'publicOrigin', 'dangerRules')}
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
                onClick={() => patch({ dangerRules: draft.dangerRules.filter((r) => r !== rule) })}
              >
                {t('flows.security.remove')}
              </button>
            </li>
          ))}
        </ul>
        <div className="input-row">
          <input
            className="mono"
            value={form.texts.newRule}
            aria-label={t('flows.security.newRule')}
            placeholder={t('flows.security.newRule')}
            onChange={(e) => form.setText('newRule', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                form.addRule();
              }
            }}
          />
          <button type="button" onClick={form.addRule}>
            {t('flows.security.add')}
          </button>
        </div>
        <Msg note={form.ruleNote} />
      </div>
    </Section>
  );
}

export function QuotaSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch, texts, maxValid } = form;
  return (
    <Section id="quota" title={t('flows.settings.quota')} dirty={form.isDirty('quotaGuards')}>
      <div className="field">
        <label htmlFor="st-deny">{t('flows.quota.deny')}</label>
        <textarea
          id="st-deny"
          className="mono"
          rows={4}
          value={texts.deny}
          onChange={(e) => {
            form.setText('deny', e.target.value);
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
          value={texts.max}
          aria-invalid={!maxValid}
          onChange={(e) => {
            const value = e.target.value;
            form.setText('max', value);
            if (value.trim() === '' || POSITIVE_INT.test(value.trim())) {
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
  );
}

/**
 * 唯一的儲存按鈕：一次存三個分類的修改。
 * 有欄位不合法而且不在眼前這個分類時，先切過去，使用者才看得到哪裡標紅。
 */
export function SaveBar({
  form,
  current,
  order,
}: {
  form: ServerSettingsForm;
  current: Category;
  order: readonly Category[];
}) {
  const t = useT();
  const { connected } = useBoard();
  const { dirtyKeys, busy } = form;
  const save = () => {
    const bad = order.filter((c) => form.invalidCategories.has(c));
    if (bad.length > 0 && !bad.includes(current)) location.hash = settingsHash(bad[0]!);
    void form.save();
  };
  return (
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
          onClick={save}
        >
          {t('flows.settings.save')}
        </button>
        <button type="button" disabled={busy || dirtyKeys.length === 0} onClick={form.revert}>
          {t('flows.settings.revert')}
        </button>
        <Msg note={form.note} />
      </div>
    </div>
  );
}
