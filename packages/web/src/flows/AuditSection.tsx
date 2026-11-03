// 操作紀錄：查詢、篩選、匯出（DISPATCH §7）。只有 owner 看得到，hub 也只讓 owner 讀。
import { useCallback, useMemo, useState } from 'react';
import type { AuditEntry, User } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  AUDIT_ACTIONS,
  AUDIT_MAX,
  AUDIT_PAGE,
  EMPTY_AUDIT_FORM,
  exportFileName,
  filterByUser,
  localInputToIso,
  rangeReversed,
  SYSTEM_USER,
  toAuditQuery,
  type AuditForm,
} from './audit';
import {
  Empty,
  ErrorBox,
  errorText,
  Loading,
  Msg,
  useCurrentUser,
  useLoad,
  type Note,
} from './common';

/** 使用者清單是選用的後端方法（見 SettingsPage 的 OptionalAdmin）；沒有時用 id 顯示。 */
interface OptionalUsers {
  listUsers?: () => Promise<User[]>;
}

function useActionLabel() {
  const t = useT();
  return (action: string) => {
    const key = `flows.audit.act.${action}`;
    const label = t(key);
    return label === key ? action : label;
  };
}

function AuditRow({
  entry,
  userName,
  sessionName,
}: {
  entry: AuditEntry;
  userName: string;
  sessionName: string | null;
}) {
  const locale = useLocale((s) => s.locale);
  const actionLabel = useActionLabel();
  const mask = useMaskText();
  const at = new Date(entry.at);
  return (
    <li className="rig-row audit-row" data-testid="audit-row">
      <div className="rig-name">
        <time className="sub num" dateTime={entry.at} title={at.toLocaleString(locale)}>
          {at.toLocaleString(locale, {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })}
        </time>
        <strong>{actionLabel(entry.action)}</strong>
        <code className="sub">{entry.action}</code>
      </div>
      <div className="sub">
        {userName}
        {sessionName ? ` · ${sessionName}` : ''}
      </div>
      {entry.detail && <code className="audit-detail">{mask(entry.detail)}</code>}
    </li>
  );
}

function AuditBody() {
  const t = useT();
  const { backend, sessions, machines } = useBoard();
  const actionLabel = useActionLabel();
  const me = useCurrentUser();
  const [form, setForm] = useState<AuditForm>(EMPTY_AUDIT_FORM);
  const [limit, setLimit] = useState(AUDIT_PAGE);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const query = useMemo(() => toAuditQuery(form, limit), [form, limit]);
  const entries = useLoad(useCallback(() => backend.listAudit(query), [backend, query]));
  const optional = backend as typeof backend & OptionalUsers;
  const users = useLoad(
    useCallback(async () => (optional.listUsers ? optional.listUsers() : null), [optional]),
  );

  const set = (patch: Partial<AuditForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    // 換條件就從第一頁重來，免得一換就載 1000 筆。
    setLimit(AUDIT_PAGE);
  };
  const badFrom = form.from !== '' && localInputToIso(form.from) === null;
  const badTo = form.to !== '' && localInputToIso(form.to, true) === null;
  const reversed = rangeReversed(form);

  const names = new Map<string, string>();
  for (const user of users.data ?? []) names.set(user.id, user.name);
  if (me.data) names.set(me.data.id, me.data.name);
  const userName = (id: string | null) =>
    id === null ? t('flows.audit.system') : (names.get(id) ?? id.slice(0, 8));
  const sessionName = (id: string | null) =>
    id === null ? null : (sessions.find((s) => s.id === id)?.name ?? id.slice(0, 8));

  const loaded = entries.data ?? [];
  const shown = filterByUser(loaded, form.userId);
  // 使用者選單：清單 API 給的，加上紀錄裡出現過、但清單沒有的（例如已刪除的帳號）。
  const userIds = [
    ...new Set([...names.keys(), ...loaded.flatMap((e) => (e.userId ? [e.userId] : []))]),
  ];
  const sessionOptions = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  const canLoadMore = loaded.length >= limit && limit < AUDIT_MAX;

  const exportCsv = async () => {
    setExporting(true);
    setNote({ text: t('flows.audit.exporting') });
    try {
      const blob = await backend.exportAudit();
      const name = exportFileName(new Date());
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNote({ text: t('flows.audit.exported', { name }) });
      // 匯出本身也會記一筆。
      entries.reload();
    } catch (e) {
      setNote({ text: t('flows.audit.exportFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <p className="hint">{t('flows.audit.intro')}</p>
      <div className="audit-filters" data-testid="audit-filters">
        <div>
          <label htmlFor="audit-action">{t('flows.audit.action')}</label>
          <select
            id="audit-action"
            value={form.action}
            onChange={(e) => set({ action: e.target.value })}
          >
            <option value="">{t('flows.audit.all')}</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {actionLabel(action)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-user">{t('flows.audit.user')}</label>
          <select
            id="audit-user"
            value={form.userId}
            onChange={(e) => set({ userId: e.target.value })}
          >
            <option value="">{t('flows.audit.all')}</option>
            <option value={SYSTEM_USER}>{t('flows.audit.system')}</option>
            {userIds.map((id) => (
              <option key={id} value={id}>
                {userName(id)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-session">{t('flows.audit.session')}</label>
          <select
            id="audit-session"
            value={form.sessionId}
            onChange={(e) => set({ sessionId: e.target.value })}
          >
            <option value="">{t('flows.audit.all')}</option>
            {sessionOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {`${s.name} · ${machineName(s.machineId)}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-from">{t('flows.audit.from')}</label>
          <input
            id="audit-from"
            type="datetime-local"
            value={form.from}
            aria-invalid={badFrom || reversed}
            onChange={(e) => set({ from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="audit-to">{t('flows.audit.to')}</label>
          <input
            id="audit-to"
            type="datetime-local"
            value={form.to}
            aria-invalid={badTo || reversed}
            onChange={(e) => set({ to: e.target.value })}
          />
        </div>
      </div>
      {(badFrom || badTo) && <p className="field-error">{t('flows.audit.badTime')}</p>}
      {reversed && <p className="field-error">{t('flows.audit.reversed')}</p>}
      {form.userId && (
        <p className="hint">{t('flows.audit.userFilterHint', { n: loaded.length })}</p>
      )}
      <div className="acts">
        <button
          type="button"
          onClick={() => {
            setForm(EMPTY_AUDIT_FORM);
            setLimit(AUDIT_PAGE);
          }}
        >
          {t('flows.audit.clear')}
        </button>
        <button type="button" onClick={entries.reload}>
          {t('flows.audit.refresh')}
        </button>
      </div>

      {entries.error ? (
        <ErrorBox
          what={t('flows.audit.loadFailed', { error: entries.error })}
          how={t('flows.audit.loadHow')}
          onRetry={entries.reload}
        />
      ) : !entries.data ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty title={t('flows.audit.none')} next={t('flows.audit.noneNext')} />
      ) : (
        <>
          <p className="sub" data-testid="audit-count">
            {t('flows.audit.count', { n: shown.length })}
          </p>
          <ul className="rows audit-list" data-testid="audit-list">
            {shown.map((entry) => (
              <AuditRow
                key={entry.id}
                entry={entry}
                userName={userName(entry.userId)}
                sessionName={sessionName(entry.sessionId)}
              />
            ))}
          </ul>
          {canLoadMore && (
            <button
              type="button"
              disabled={entries.loading}
              onClick={() => setLimit((n) => Math.min(AUDIT_MAX, n + AUDIT_PAGE))}
            >
              {t('flows.audit.more')}
            </button>
          )}
          {loaded.length >= AUDIT_MAX && (
            <p className="hint">{t('flows.audit.maxed', { n: AUDIT_MAX })}</p>
          )}
        </>
      )}

      <div className="audit-export">
        <div className="acts">
          <button type="button" disabled={exporting} onClick={() => void exportCsv()}>
            {t('flows.audit.export')}
          </button>
          <Msg note={note} />
        </div>
        <p className="hint">{t('flows.audit.exportHint')}</p>
      </div>
    </>
  );
}

/** 不是 owner 就整區不出現（hub 會回 403）。 */
export function AuditSection() {
  const t = useT();
  const me = useCurrentUser();
  if (me.data?.role !== 'owner') return null;
  return (
    <section className="form-card audit" aria-labelledby="audit" id="s-audit">
      <div className="section-head">
        <h2 id="audit">{t('flows.settings.audit')}</h2>
      </div>
      <AuditBody />
    </section>
  );
}
