// 設定頁「已封存」（CONTRACTS §9.5）：搜尋、對話大小、開啟、還原、刪除（只有 owner）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, Session } from '@agent-board/protocol';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { formatBytes, matchesArchived, sortArchived } from './archive';
import {
  Callsign,
  callsign,
  Empty,
  ErrorBox,
  Lamp,
  Loading,
  Msg,
  restoreErrorText,
  useLoad,
  useProjects,
  type Note,
} from './common';
import { PurgeDialog } from './PurgeDialog';
import { useSettingsUser } from './settingsParts';

/** 一次問幾個 inspect：每個都要 daemon 跑 git，不要一次全丟過去。 */
const INSPECT_CONCURRENCY = 3;

/**
 * 每個 session 的對話大小。機器離線、讀不到、找不到都是 null（畫面顯示「—」）。
 * 還沒問到的不在 map 裡。
 */
function useTranscriptSizes(sessions: readonly Session[]): Map<string, number | null> {
  const { backend, machines } = useBoard();
  const [sizes, setSizes] = useState(() => new Map<string, number | null>());
  const onlineKey = machines
    .filter((m) => m.online)
    .map((m) => m.id)
    .join('|');
  const idsKey = sessions.map((s) => s.id).join('|');

  useEffect(() => {
    let live = true;
    const online = new Set(onlineKey.split('|'));
    const queue = sessions.filter((s) => !sizes.has(s.id));
    const settle = (id: string, value: number | null) => {
      if (live) setSizes((prev) => new Map(prev).set(id, value));
    };
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        if (!online.has(next.machineId)) {
          settle(next.id, null);
          continue;
        }
        try {
          settle(next.id, (await backend.inspectSession(next.id)).transcriptBytes);
        } catch {
          settle(next.id, null);
        }
      }
    };
    for (let i = 0; i < INSPECT_CONCURRENCY; i += 1) void worker();
    return () => {
      live = false;
    };
    // sizes 只用來跳過已經問過的；idsKey 與 onlineKey 代表 sessions 與機器上線狀態。
  }, [backend, idsKey, onlineKey]);

  return sizes;
}

function ArchivedRow({
  session,
  projects,
  size,
  isOwner,
  onRestored,
  onDelete,
}: {
  session: Session;
  projects: readonly Project[];
  size: number | null | undefined;
  isOwner: boolean;
  onRestored: (session: Session) => void;
  onDelete: (session: Session) => void;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { backend, machines, connected } = useBoard();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const restore = async () => {
    setBusy(true);
    setNote(null);
    try {
      await backend.updateSession(session.id, { archived: false });
      onRestored(session);
    } catch (e) {
      setNote({ text: restoreErrorText(t, e), tone: 'err' });
      setBusy(false);
    }
  };
  const archivedAt = session.archivedAt ?? null;
  return (
    <li className="archived-row" data-testid={`archived-${session.id}`}>
      <div className="archived-main">
        <div className="archived-title">
          <strong>{session.name}</strong>
          <Lamp status={session.status} detail={session.statusDetail} />
        </div>
        <Callsign text={callsign(session, machines, projects)} />
        <div className="sub">
          <span title={archivedAt ? new Date(archivedAt).toLocaleString(locale) : undefined}>
            {t('flows.archived.at', {
              time: archivedAt ? new Date(archivedAt).toLocaleString(locale) : '—',
            })}
          </span>
          {' ・ '}
          <span data-testid="archived-size">
            {t('flows.archived.size', {
              size:
                size === undefined
                  ? '…'
                  : size === null
                    ? t('flows.archived.noSize')
                    : formatBytes(size),
            })}
          </span>
        </div>
      </div>
      <div className="acts">
        <a className="button" href={`#/archive/${encodeURIComponent(session.id)}`}>
          {t('flows.archived.open')}
        </a>
        <button type="button" disabled={busy || !connected} onClick={() => void restore()}>
          {t('flows.archived.restore')}
        </button>
        {isOwner && (
          <button
            type="button"
            className="danger"
            disabled={!connected}
            onClick={() => onDelete(session)}
          >
            {t('flows.archived.delete')}
          </button>
        )}
        <Msg note={note} />
      </div>
    </li>
  );
}

export function ArchivedSection() {
  const t = useT();
  const { backend, machines } = useBoard();
  const me = useSettingsUser();
  const projects = useProjects();
  const list = useLoad(useCallback(() => backend.listArchivedSessions(), [backend]));
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const isOwner = me.data?.role === 'owner';

  const sessions = useMemo(
    () => sortArchived((list.data ?? []).filter((s) => !removed.has(s.id))),
    [list.data, removed],
  );
  const sizes = useTranscriptSizes(sessions);
  const shown = sessions.filter((s) => matchesArchived(s, query, machines, projects.data ?? []));
  const known = sessions
    .map((s) => sizes.get(s.id))
    .filter((v): v is number => typeof v === 'number');
  const total = known.reduce((sum, v) => sum + v, 0);
  const drop = (id: string) => setRemoved((prev) => new Set(prev).add(id));

  return (
    <section className="form-card archived" aria-labelledby="archived" id="s-archived">
      <div className="section-head">
        <h2 id="archived">{t('flows.archived.title')}</h2>
      </div>
      <p className="sub">{t('flows.archived.lead')}</p>
      {list.error ? (
        <ErrorBox
          what={t('flows.archived.loadFailed', { error: list.error })}
          how={t('flows.retryHow')}
          onRetry={list.reload}
        />
      ) : !list.data ? (
        <Loading />
      ) : sessions.length === 0 ? (
        <Empty title={t('flows.archived.empty')} next={t('flows.archived.emptyNext')} />
      ) : (
        <>
          <p className="archived-total" data-testid="archived-total">
            {t('flows.archived.total', {
              n: sessions.length,
              size: formatBytes(total),
              known: known.length,
            })}
          </p>
          <input
            type="search"
            aria-label={t('flows.archived.search')}
            placeholder={t('flows.archived.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="hint">{t('flows.archived.noMatch', { q: query.trim() })}</p>
          ) : (
            <ul className="archived-list">
              {shown.map((s) => (
                <ArchivedRow
                  key={s.id}
                  session={s}
                  projects={projects.data ?? []}
                  size={sizes.get(s.id)}
                  isOwner={isOwner}
                  onRestored={(restored) => {
                    drop(restored.id);
                    setNote({ text: t('flows.archived.restored', { name: restored.name }) });
                  }}
                  onDelete={setDeleting}
                />
              ))}
            </ul>
          )}
        </>
      )}
      <Msg note={note} />
      {deleting && (
        <PurgeDialog
          session={deleting}
          machineName={
            machines.find((m) => m.id === deleting.machineId)?.name ?? deleting.machineId
          }
          onClose={() => setDeleting(null)}
          onDeleted={drop}
        />
      )}
    </section>
  );
}
