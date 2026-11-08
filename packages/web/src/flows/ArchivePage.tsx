// 舊資料頁 `#/archive/<id>`（CONTRACTS §9.5）：基本資料、狀態歷史、對話紀錄。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, SessionEvent, TranscriptEntry, TranscriptPage } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { isMachineOffline } from '../shared/backend';
import { useLocale, useT } from '../shared/i18n';
import { STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';
import {
  Callsign,
  callsign,
  CopyButton,
  Empty,
  ErrorBox,
  errorText,
  Lamp,
  Loading,
  ModeChip,
  Msg,
  Page,
  restoreErrorText,
  scrollPageTop,
  useCurrentUser,
  useLoad,
  useProjects,
  useTargetSession,
  type Note,
} from './common';
// 直接引用檔案，不經 views/index（views 也引用 flows，避免循環）。
import { canResume, useResume } from '../views/resume';
import { PurgeDialog } from './PurgeDialog';

/** 一次讀幾則。hub 上限 500。 */
const TRANSCRIPT_PAGE = 100;

type T = ReturnType<typeof useT>;

function useTime() {
  const locale = useLocale((s) => s.locale);
  return (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(locale) : '—');
}

function Info({ session, machineName }: { session: Session; machineName: string }) {
  const t = useT();
  const time = useTime();
  const rows: [string, React.ReactNode][] = [
    [t('flows.archive.machine'), machineName],
    [t('flows.archive.cwd'), <span className="mono">{session.cwd}</span>],
    [
      t('flows.archive.worktree'),
      session.worktreePath ? (
        <span className="mono">{session.worktreePath}</span>
      ) : (
        t('flows.archive.noWorktree')
      ),
    ],
    [
      t('flows.archive.branch'),
      session.branch ? <span className="mono">{session.branch}</span> : '—',
    ],
    [t('flows.archive.mode'), <ModeChip mode={session.permissionMode} />],
    [t('flows.archive.model'), session.model ?? t('flows.archive.defaultModel')],
    [t('flows.archive.created'), time(session.createdAt)],
    [t('flows.archive.ended'), time(session.endedAt)],
    [t('flows.archive.archived'), time(session.archivedAt)],
    [
      t('flows.archive.claudeId'),
      session.claudeSessionId ? (
        <>
          <span className="mono">{session.claudeSessionId}</span>{' '}
          <CopyButton text={session.claudeSessionId} />
        </>
      ) : (
        t('flows.archive.noClaudeId')
      ),
    ],
  ];
  return (
    <dl className="archive-info">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const isStatus = (v: unknown): v is Session['status'] =>
  typeof v === 'string' && Object.hasOwn(STATUS_VISUAL, v);

function History({ session }: { session: Session }) {
  const t = useT();
  const time = useTime();
  const { backend } = useBoard();
  const events = useLoad(
    useCallback(() => backend.sessionEvents(session.id), [backend, session.id]),
  );
  const changes = (events.data ?? []).filter(
    (e: SessionEvent) => e.type === 'status' && isStatus(e.payload.to),
  );
  return (
    <section className="form-card" aria-labelledby="archive-history">
      <h2 id="archive-history">{t('flows.archive.history')}</h2>
      {events.error ? (
        <ErrorBox
          what={t('flows.archive.historyFailed', { error: events.error })}
          how={t('flows.retryHow')}
          onRetry={events.reload}
        />
      ) : !events.data ? (
        <Loading />
      ) : changes.length === 0 ? (
        <p className="hint" data-testid="history-empty">
          {t('flows.archive.historyEmpty')}
        </p>
      ) : (
        <ol className="archive-history">
          {changes.map((e) => {
            const from = e.payload.from;
            const reason = typeof e.payload.reason === 'string' ? e.payload.reason : null;
            // hub 從 2026-11-08 起也存 detail；舊事件沒有，就當 null。
            const str = (v: unknown) => (typeof v === 'string' ? v : null);
            const fromDetail = str(e.payload.fromDetail);
            const detail = str(e.payload.detail);
            return (
              <li key={e.id}>
                <span className="sub num">{time(e.at)}</span>
                {isStatus(from) && (
                  <>
                    <Lamp status={from} detail={fromDetail} />
                    <span aria-hidden="true">→</span>
                  </>
                )}
                <Lamp status={e.payload.to as Session['status']} detail={detail} />
                {reason && <span className="sub mono">{reason}</span>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="hint">{t('flows.archive.historyKept')}</p>
    </section>
  );
}

const ROLE_LABEL: Record<TranscriptEntry['role'], string> = {
  user: 'flows.archive.role.user',
  assistant: 'flows.archive.role.assistant',
  tool: 'flows.archive.role.tool',
};

function Entry({ entry, t, focused }: { entry: TranscriptEntry; t: T; focused?: boolean }) {
  const mask = useMaskText();
  const time = useTime();
  const ref = useRef<HTMLLIElement>(null);
  // 從全域搜尋 ⌘Enter 開來的：捲到命中的那則（P3 ③b）。
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  return (
    <li
      ref={ref}
      className={focused ? `tr tr-${entry.role} tr-focus` : `tr tr-${entry.role}`}
      data-testid="transcript-entry"
      data-role={entry.role}
      data-index={entry.index}
      aria-current={focused ? 'true' : undefined}
    >
      <div className="tr-meta">
        <span className="tr-role">{t(ROLE_LABEL[entry.role])}</span>
        <span className="num">#{entry.index + 1}</span>
        {entry.at && <span>{time(entry.at)}</span>}
      </div>
      <div className="tr-text">{mask(entry.text)}</div>
    </li>
  );
}

type TranscriptState =
  | { state: 'loading' }
  | { state: 'offline' }
  | { state: 'error'; detail: string }
  | { state: 'ready'; entries: TranscriptEntry[]; last: TranscriptPage };

/** 從第幾則前面開始讀：命中的那則上面留幾則前文。 */
const FOCUS_CONTEXT = 5;

/**
 * 對話紀錄（舊資料頁與全域搜尋的 `#/transcript/<id>?at=<n>` 共用）。focusIndex 有給時從那則前面幾則開始讀、
 * 捲到那則並標出來；有「從頭看」可以回到第 1 則。
 */
export function Transcript({
  session,
  machineName,
  online,
  focusIndex = null,
}: {
  session: Session;
  machineName: string;
  online: boolean;
  focusIndex?: number | null;
}) {
  const t = useT();
  const { backend } = useBoard();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [round, setRound] = useState(0);
  const [data, setData] = useState<TranscriptState>({ state: 'loading' });
  /** 這次清單從篩選後的第幾則開始（沒搜尋時就是序號）。 */
  const [from, setFrom] = useState(() =>
    focusIndex === null ? 0 : Math.max(0, focusIndex - FOCUS_CONTEXT),
  );
  const [more, setMore] = useState<Note | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** 換了搜尋字之後，舊搜尋晚回來的「載入更多」不能接到新的清單上。 */
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setMore(null);
    if (!online) {
      setData({ state: 'offline' });
      return;
    }
    setData({ state: 'loading' });
    backend
      .sessionTranscript(session.id, {
        cursor: query ? 0 : from,
        limit: TRANSCRIPT_PAGE,
        q: query || undefined,
      })
      .then(
        (page) => {
          if (mine === generation.current) {
            setData({ state: 'ready', entries: page.entries, last: page });
          }
        },
        (e: unknown) => {
          if (mine !== generation.current) return;
          setData(
            isMachineOffline(e) ? { state: 'offline' } : { state: 'error', detail: errorText(e) },
          );
        },
      );
  }, [backend, online, query, round, session.id, from]);

  const loadMore = async () => {
    if (data.state !== 'ready' || data.last.nextCursor === null) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMore(null);
    try {
      const page = await backend.sessionTranscript(session.id, {
        cursor: data.last.nextCursor,
        limit: TRANSCRIPT_PAGE,
        q: query || undefined,
      });
      if (mine !== generation.current) return;
      setData({ state: 'ready', entries: [...data.entries, ...page.entries], last: page });
    } catch (e) {
      setMore({
        text: isMachineOffline(e)
          ? t('flows.archive.offline', { machine: machineName })
          : t('flows.archive.moreFailed', { error: errorText(e) }),
        tone: 'err',
      });
    } finally {
      setLoadingMore(false);
    }
  };

  let body;
  if (data.state === 'offline') {
    body = (
      <div className="alert" role="alert" data-testid="transcript-offline">
        <span aria-hidden="true">⊘</span>
        <div className="alert-body">
          <div>{t('flows.archive.offline', { machine: machineName })}</div>
          <div className="sub">{t('flows.archive.offlineHow')}</div>
          <button type="button" onClick={() => setRound((r) => r + 1)}>
            {t('flows.retry')}
          </button>
        </div>
      </div>
    );
  } else if (data.state === 'error') {
    body = (
      <ErrorBox
        what={t('flows.archive.transcriptFailed', { error: data.detail })}
        how={t('flows.retryHow')}
        onRetry={() => setRound((r) => r + 1)}
      />
    );
  } else if (data.state === 'loading') {
    body = <Loading />;
  } else if (data.last.missing) {
    body = (
      <p className="hint" data-testid="transcript-missing">
        {t('flows.archive.missing', { machine: machineName })}
      </p>
    );
  } else {
    const count = data.last.matched ?? data.last.total;
    const start = query ? 0 : from;
    const left = count - start - data.entries.length;
    body = (
      <>
        <p className="sub" data-testid="transcript-count">
          {data.last.matched === null
            ? t('flows.archive.count', { total: data.last.total })
            : t('flows.archive.matched', { n: data.last.matched, total: data.last.total })}
        </p>
        {start > 0 && (
          <div className="acts" data-testid="transcript-from">
            <span className="sub">{t('flows.archive.from', { n: start + 1 })}</span>
            <button type="button" onClick={() => setFrom(0)}>
              {t('flows.archive.fromStart')}
            </button>
          </div>
        )}
        {data.entries.length > 0 && (
          <ol className="transcript">
            {data.entries.map((entry) => (
              <Entry
                key={entry.index}
                entry={entry}
                t={t}
                focused={!query && entry.index === focusIndex}
              />
            ))}
          </ol>
        )}
        {data.last.nextCursor !== null && (
          <div className="acts">
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {t('flows.archive.more', { n: left })}
            </button>
            <Msg note={more} />
          </div>
        )}
      </>
    );
  }

  return (
    <section className="form-card" aria-labelledby="archive-transcript">
      <h2 id="archive-transcript">{t('flows.archive.transcript')}</h2>
      <form
        className="input-row transcript-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <input
          type="search"
          aria-label={t('flows.archive.search')}
          placeholder={t('flows.archive.search')}
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">{t('flows.archive.searchGo')}</button>
        {query && (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              setQuery('');
            }}
          >
            {t('flows.archive.searchClear')}
          </button>
        )}
      </form>
      {body}
    </section>
  );
}

export function ArchivePage() {
  const t = useT();
  const id = useTargetSession();
  const { backend, machines, connected } = useBoard();
  const me = useCurrentUser();
  const projects = useProjects();
  const list = useLoad(useCallback(() => backend.listArchivedSessions(), [backend]));
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const resumer = useResume();
  // 從設定頁下方的清單點進來時，換 hash 不會重設捲動位置。
  useEffect(() => {
    scrollPageTop();
  }, [id]);
  const session = list.data?.find((s) => s.id === id) ?? null;
  const machine = machines.find((m) => m.id === session?.machineId);
  const machineName = machine?.name ?? session?.machineId ?? '';

  const restore = async () => {
    if (!session) return;
    setBusy(true);
    setNote(null);
    try {
      await backend.updateSession(session.id, { archived: false });
      setRestored(true);
    } catch (e) {
      setNote({ text: restoreErrorText(t, e), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <a href="#/settings/archived" className="back-link">
      {t('flows.archive.back')}
    </a>
  );

  let body;
  if (list.error) {
    body = (
      <ErrorBox
        what={t('flows.archived.loadFailed', { error: list.error })}
        how={t('flows.retryHow')}
        onRetry={list.reload}
      />
    );
  } else if (!list.data) {
    body = <Loading />;
  } else if (restored || (deleted && !deleting) || !session) {
    body = (
      <Empty
        title={
          restored
            ? t('flows.archive.restoredTitle')
            : deleted
              ? t('flows.archive.deletedTitle')
              : t('flows.archive.notFound')
        }
        next={
          restored ? (
            <a href="#/canvas">{t('flows.archive.toCanvas')}</a>
          ) : (
            <a href="#/settings/archived">{t('flows.archive.back')}</a>
          )
        }
      />
    );
  } else {
    body = (
      <>
        <header className="page-head archive-head">
          <h1>{session.name}</h1>
          <Lamp status={session.status} detail={session.statusDetail} />
        </header>
        <Callsign text={callsign(session, machines, projects.data ?? [])} />
        <div className="acts">
          <button type="button" disabled={busy || !connected} onClick={() => void restore()}>
            {t('flows.archived.restore')}
          </button>
          {canResume(session) && (
            <button
              type="button"
              className="primary"
              title={t('flows.archive.resumeHint')}
              disabled={busy || resumer.busy || !connected}
              onClick={() => void resumer.resume(session)}
            >
              {resumer.busy ? t('views.resume.busy') : t('flows.archive.resume')}
            </button>
          )}
          {me.data?.role === 'owner' && (
            <button
              type="button"
              className="danger"
              disabled={!connected}
              onClick={() => setDeleting(true)}
            >
              {t('flows.archived.delete')}
            </button>
          )}
          <Msg note={resumer.error ? { text: resumer.error, tone: 'err' } : note} />
        </div>
        <div className="archive-grid">
          <section className="form-card" aria-labelledby="archive-info">
            <h2 id="archive-info">{t('flows.archive.info')}</h2>
            <Info session={session} machineName={machineName} />
          </section>
          <History session={session} />
        </div>
        <Transcript session={session} machineName={machineName} online={machine?.online ?? false} />
        {deleting && (
          <PurgeDialog
            session={session}
            machineName={machineName}
            onClose={() => setDeleting(false)}
            onDeleted={() => setDeleted(true)}
          />
        )}
      </>
    );
  }

  return (
    <Page>
      {back}
      {body}
    </Page>
  );
}
