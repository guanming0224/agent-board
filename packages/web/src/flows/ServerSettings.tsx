// hub 端設定（只有 owner）：分散在「通知」「Session 與額度」「安全」三個分類，共用一份草稿與一個儲存列。
// 草稿放在設定頁這一層，切換分類不會不見；選單用 dirtyCategories 標出哪些分類還沒存。
import { useEffect, useState } from 'react';
import {
  NOTIFY_MAX_WINDOW_MS,
  NOTIFY_PERMISSION_WINDOW_MS,
  NOTIFY_WINDOW_MS,
  WAITING_LIMIT_MAX,
  WAITING_LIMIT_MIN,
  TEAM_SIZE_MAX,
  TEAM_SIZE_MIN,
  REVIEW_LEAD_RATE_MAX,
  type Settings,
} from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, type Note } from './common';
import { KEY_CATEGORY, settingsHash, type Category } from './settingsNav';
import { Section } from './settingsParts';
import '../review/messages';
import { listenAddressError, originError } from './validation';

type SettingsKey = keyof Settings;

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const POSITIVE_INT = /^[1-9]\d*$/;

/** 輸入框裡的原始文字：不合法的值不寫進草稿，但要留在框裡讓人改。 */
interface Texts {
  deny: string;
  max: string;
  stuck: string;
  limit: string;
  teamLimit: string;
  newRule: string;
}

const textsOf = (s: Settings | null): Texts => ({
  deny: s?.quotaGuards.denyReadPaths.join('\n') ?? '',
  max: s?.quotaGuards.maxConcurrentSessions?.toString() ?? '',
  stuck: s ? String(s.stuckMinutes) : '',
  limit: s ? String(s.notifications.waitingLimit) : '',
  teamLimit: s ? String(s.autoStaff.teamLimit) : '',
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
  limitValid: boolean;
  teamLimitValid: boolean;
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
  const limitValid = waitingLimitOf(texts.limit) !== null;
  const teamLimitValid = teamLimitOf(texts.teamLimit) !== null;

  const invalidCategories = new Set<Category>();
  if (quietInvalid || !limitValid) invalidCategories.add('notify');
  if (!stuckValid || !maxValid || !teamLimitValid) invalidCategories.add('sessions');
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
      // 框裡的字跟著 hub 存下的值（例如去空白、空行），還沒按「新增規則」的那條留著。
      setTexts((prev) => ({ ...textsOf(next), newRule: prev.newRule }));
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
    limitValid,
    teamLimitValid,
    quietInvalid,
    ruleNote,
    addRule,
    busy,
    note,
    save,
    revert,
  };
}

/** 同時等你的上限：1–20 的整數；不合法回 null。 */
function waitingLimitOf(text: string): number | null {
  const value = text.trim();
  if (!POSITIVE_INT.test(value)) return null;
  const n = Number(value);
  return n >= WAITING_LIMIT_MIN && n <= WAITING_LIMIT_MAX ? n : null;
}

/** 團隊人數上限（隊長自主擴編）：TEAM_SIZE_MIN–TEAM_SIZE_MAX 的整數；不合法回 null。 */
export function teamLimitOf(text: string): number | null {
  const value = text.trim();
  if (!POSITIVE_INT.test(value)) return null;
  const n = Number(value);
  return n >= TEAM_SIZE_MIN && n <= TEAM_SIZE_MAX ? n : null;
}

const seconds = (ms: number) => Math.round(ms / 1000);

export function NotifySection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch, quietInvalid, limitValid } = form;
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
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            data-testid="notify-coalesce"
            checked={draft.notifications.coalesce}
            onChange={(e) =>
              patch({ notifications: { ...draft.notifications, coalesce: e.target.checked } })
            }
          />
          {t('flows.notify.coalesce')}
        </label>
        <p className="hint" data-testid="notify-coalesce-hint">
          {draft.notifications.coalesce
            ? t('flows.notify.coalesceHint', {
                window: seconds(NOTIFY_WINDOW_MS),
                permission: seconds(NOTIFY_PERMISSION_WINDOW_MS),
                max: seconds(NOTIFY_MAX_WINDOW_MS),
              })
            : t('flows.notify.coalesceOff')}
        </p>
      </div>
      <div className="field">
        <label htmlFor="st-waiting-limit">{t('flows.notify.waitingLimit')}</label>
        <input
          id="st-waiting-limit"
          data-testid="notify-waiting-limit"
          className="short num"
          inputMode="numeric"
          value={form.texts.limit}
          aria-invalid={!limitValid}
          onChange={(e) => {
            form.setText('limit', e.target.value);
            const n = waitingLimitOf(e.target.value);
            if (n !== null) patch({ notifications: { ...draft.notifications, waitingLimit: n } });
          }}
        />
        <p className="hint">{t('flows.notify.waitingLimitHint')}</p>
        {!limitValid && (
          <p className="field-error">
            {t('flows.notify.waitingLimitRange', {
              min: WAITING_LIMIT_MIN,
              max: WAITING_LIMIT_MAX,
            })}
          </p>
        )}
      </div>
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
                className="sm"
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

/** 額度恢復後自動接續（會花額度，預設關；和任務自動執行一樣標 ◈）。 */
export function AutoContinueSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch } = form;
  return (
    <Section
      id="autocontinue"
      title={t('flows.settings.autoContinue')}
      dirty={form.isDirty('autoContinue')}
    >
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            data-testid="auto-continue-toggle"
            checked={draft.autoContinue}
            onChange={(e) => patch({ autoContinue: e.target.checked })}
          />
          {t('flows.autoContinue.label')}
          <span className="chip cost">◈ {t('flows.autoContinue.cost')}</span>
        </label>
        <p className="hint">{t('flows.autoContinue.hint')}</p>
      </div>
    </Section>
  );
}

/**
 * 允許 session 派工（MCP 工具，CONTRACTS §11）：預設開。工具本身不花額度，但開成員會開新的 session，所以標 ◈。
 * 關掉後新開或接續的 session 不掛工具。
 */
export function DispatchSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch } = form;
  return (
    <Section id="dispatch" title={t('flows.settings.dispatch')} dirty={form.isDirty('dispatch')}>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            data-testid="dispatch-toggle"
            checked={draft.dispatch}
            onChange={(e) => patch({ dispatch: e.target.checked })}
          />
          {t('flows.dispatch.label')}
          <span className="chip cost">◈ {t('flows.autoContinue.cost')}</span>
        </label>
        <p className="hint">{t('flows.dispatch.hint')}</p>
      </div>
    </Section>
  );
}

/**
 * 隊長自主擴編（GM 2026-11-10，CONTRACTS §11.1）：開關（關掉＝隊長不能新增也不能封存，只能用現有成員）、
 * 團隊人數上限（含隊長、沒封存的，2–20）、新增或封存成員時推播。都預設開、上限 12。
 */
export function AutoStaffSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch, texts, teamLimitValid } = form;
  const autoStaff = draft.autoStaff;
  return (
    <Section id="autostaff" title={t('flows.settings.autoStaff')} dirty={form.isDirty('autoStaff')}>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            data-testid="autostaff-toggle"
            checked={autoStaff.enabled}
            onChange={(e) => patch({ autoStaff: { ...autoStaff, enabled: e.target.checked } })}
          />
          {t('flows.autoStaff.label')}
          <span className="chip cost">◈ {t('flows.autoContinue.cost')}</span>
        </label>
        <p className="hint">{t('flows.autoStaff.hint')}</p>
        {!draft.dispatch && (
          <p className="hint" data-testid="autostaff-needs-dispatch">
            {t('flows.autoStaff.needsDispatch')}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="st-team-limit">{t('flows.autoStaff.limit')}</label>
        <input
          id="st-team-limit"
          className="short num"
          inputMode="numeric"
          data-testid="autostaff-limit"
          value={texts.teamLimit}
          aria-invalid={!teamLimitValid}
          onChange={(e) => {
            form.setText('teamLimit', e.target.value);
            const n = teamLimitOf(e.target.value);
            if (n !== null) patch({ autoStaff: { ...autoStaff, teamLimit: n } });
          }}
        />
        <p className="hint">
          {t('flows.autoStaff.limitHint', { min: TEAM_SIZE_MIN, max: TEAM_SIZE_MAX })}
        </p>
        {!teamLimitValid && (
          <p className="field-error" data-testid="autostaff-limit-error">
            {t('flows.autoStaff.limitError', { min: TEAM_SIZE_MIN, max: TEAM_SIZE_MAX })}
          </p>
        )}
      </div>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            data-testid="autostaff-push"
            checked={autoStaff.push}
            onChange={(e) => patch({ autoStaff: { ...autoStaff, push: e.target.checked } })}
          />
          {t('flows.autoStaff.push')}
        </label>
        <p className="hint">{t('flows.autoStaff.pushHint')}</p>
      </div>
    </Section>
  );
}

/**
 * 交叉審查（Codex 第二輪，CONTRACTS §22）：隊長每小時上限（每隊，0–20，0＝隊長不能發起）、兩邊的模型、
 * Codex 推理強度。GM 在網頁按確認或隊長要求才會跑，所以標 ◈。PATCH 帶整個 review 物件。
 */
export function ReviewSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch } = form;
  const review = draft.review;
  const [perHour, setPerHour] = useState(String(review.leadPerHour));
  useEffect(() => setPerHour(String(review.leadPerHour)), [review.leadPerHour]);
  const model = (value: string) => value.trim().slice(0, 100) || null;
  return (
    <Section id="review" title={t('review.settings.title')} dirty={form.isDirty('review')}>
      <p className="hint">
        {t('review.settings.hint')}{' '}
        <span className="chip cost">◈ {t('flows.autoContinue.cost')}</span>
      </p>
      <div className="field">
        <label htmlFor="st-review-per-hour">{t('review.settings.leadPerHour')}</label>
        <input
          id="st-review-per-hour"
          className="short num"
          inputMode="numeric"
          data-testid="review-per-hour"
          value={perHour}
          onChange={(e) => {
            setPerHour(e.target.value);
            const text = e.target.value.trim();
            const n = /^\d+$/.test(text) ? Number(text) : null;
            if (n !== null && n >= 0 && n <= REVIEW_LEAD_RATE_MAX) {
              patch({ review: { ...review, leadPerHour: n } });
            }
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="st-review-claude">{t('review.settings.claudeModel')}</label>
        <input
          id="st-review-claude"
          className="mono"
          data-testid="review-claude-model"
          value={review.claudeModel ?? ''}
          onChange={(e) => patch({ review: { ...review, claudeModel: model(e.target.value) } })}
        />
      </div>
      <div className="field">
        <label htmlFor="st-review-codex">{t('review.settings.codexModel')}</label>
        <input
          id="st-review-codex"
          className="mono"
          data-testid="review-codex-model"
          value={review.codexModel ?? ''}
          onChange={(e) => patch({ review: { ...review, codexModel: model(e.target.value) } })}
        />
      </div>
      <div className="field">
        <label htmlFor="st-review-effort">{t('review.settings.codexEffort')}</label>
        <select
          id="st-review-effort"
          data-testid="review-codex-effort"
          value={review.codexEffort ?? ''}
          onChange={(e) =>
            patch({
              review: {
                ...review,
                codexEffort: (e.target.value || null) as typeof review.codexEffort,
              },
            })
          }
        >
          <option value="">{t('review.settings.effort.default')}</option>
          {(['minimal', 'low', 'medium', 'high'] as const).map((effort) => (
            <option key={effort} value={effort}>
              {t(`review.settings.effort.${effort}`)}
            </option>
          ))}
        </select>
      </div>
    </Section>
  );
}

/**
 * 讓 session 讀寫進度卡（MCP 工具 get_progress／update_progress，P3 項目一）：預設開。
 * 工具本身不花額度、不會自己動（Claude 呼叫才有作用），所以不標 ◈。關掉後新開或接續的 session 不掛這兩個工具。
 */
export function MemorySection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch } = form;
  return (
    <Section id="memory" title={t('flows.settings.memory')} dirty={form.isDirty('memory')}>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            data-testid="memory-toggle"
            checked={draft.memory}
            onChange={(e) => patch({ memory: e.target.checked })}
          />
          {t('flows.memory.label')}
        </label>
        <p className="hint">{t('flows.memory.hint')}</p>
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
