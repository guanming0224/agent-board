// 全域搜尋視窗（P3 §3.3、§3.4）。桌面是置中次畫面，手機是全螢幕頁 `#/search`（App 依網址決定外框）。
// 輸入時（停 250ms、至少 2 字）只跑快速層（hub 已有的資料）；按 Enter 搜各台機器的深層（③b）這一版還沒有，
// 位置與說明先留著、按鈕停用。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  parseSearchTerms,
  SEARCH_DEBOUNCE_MS,
  SEARCH_QUERY_MAX,
  sessionWaitsForUser,
  type SearchGroup,
  type SearchItem,
  type SearchResults,
  type Session,
  type Team,
} from '@agent-board/protocol';
import { terminalHash } from '../canvas/terminalRoute';
import { focusProgressOwner, useProgressUi } from '../progress';
import { useMaskMode } from '../security';
import { secretRanges } from '../security/secretPatterns';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { refreshTeams, useTeams } from '../team/store';
import { closeModal, useOverlay } from '../views/overlayStore';
import { inboxHash, MEMORY_HASH, searchHash, searchQueryOf, teamHash } from '../views/overlay';
import { formatSpan, Lamp, useNow } from '../views/session';
import { useViewsUi } from '../views/uiStore';
import { useCurrentZoneId } from '../zones/store';
import { useSearchPrefs, type SearchPrefs } from './prefs';
import './messages';
import './search.css';

/** 每組先顯示幾筆（§3.3）。 */
const FIRST_ROWS = 5;
const PHONE_QUERY = '(max-width: 640px)';

type Loaded =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; key: string; results: SearchResults }
  | { state: 'error'; detail: string };

const errorDetail = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 片段：命中詞粗體＋底線（不用顏色表達，§3.3）。 */
export function Highlight({ text, ranges }: { text: string; ranges: readonly [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start < at || end > text.length) return;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <b key={i} className="search-hit">
        {text.slice(start, end)}
      </b>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function isPhone(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(PHONE_QUERY).matches;
}

/** 讓網址跟著查詢字（手機可分享的深連結），不留歷史、不觸發換頁。 */
function syncUrl(q: string): void {
  if (!location.hash.startsWith('#/search')) return;
  const next = searchHash(q.trim() || null);
  if (location.hash !== next) history.replaceState(history.state, '', next);
}

interface Lookup {
  session(id: string | undefined): Session | undefined;
  team(id: string | undefined): Team | undefined;
  waiting(id: string): boolean;
}

/** 點結果或 Enter（§3.3、§3.4）：關掉視窗、到那個 session／團隊。 */
function go(item: SearchItem, lookup: Lookup): void {
  const session = lookup.session(item.sessionId);
  const teamId =
    item.teamId ??
    (session
      ? useTeams.getState().members.find((m) => m.sessionId === session.id)?.teamId
      : undefined);
  // 進度卡（§3.3、驗收 4）：聚焦團隊（或單獨 session）並展開卡片。手機沒有畫布：團隊卡開團隊面板
  // （名單上方就是進度卡），單獨 session 的卡開 Memory 並展開那一張。
  if (item.kind === 'progress') {
    const owner = item.teamId
      ? { teamId: item.teamId }
      : item.sessionId
        ? { sessionId: item.sessionId }
        : null;
    if (!owner) return;
    if (isPhone()) {
      if ('teamId' in owner) location.hash = teamHash(owner.teamId);
      else {
        useProgressUi.getState().setExpanded(`session:${owner.sessionId}`);
        location.hash = MEMORY_HASH;
      }
      return;
    }
    focusProgressOwner(owner);
    closeModal();
    return;
  }
  // 團隊文字、任務：開團隊面板（畫布會把團隊框進畫面）。
  if (item.kind === 'team' || item.kind === 'task') {
    if (item.teamId) location.hash = teamHash(item.teamId);
    return;
  }
  if (!session) return;
  // 封存的 session 不在畫布上：開封存頁的那一筆（可讀對話紀錄）。
  if (session.archived) {
    location.hash = `#/archive/${encodeURIComponent(session.id)}`;
    return;
  }
  if (isPhone()) {
    // 手機：有等你的動作 → 收件匣那一項；否則團隊面板或全螢幕終端機。
    if (lookup.waiting(session.id)) location.hash = inboxHash(session.id);
    else if (teamId) location.hash = teamHash(teamId);
    else location.hash = terminalHash(session.id);
    return;
  }
  // 桌面：畫布聚焦它（在別的工作區時畫布會先切過去）。
  useViewsUi.getState().focusSession(session.id);
  closeModal();
}

function Row({
  item,
  lookup,
  selected,
  id,
  onPick,
}: {
  item: SearchItem;
  lookup: Lookup;
  selected: boolean;
  id: string;
  onPick: () => void;
}) {
  const t = useT();
  const now = useNow();
  const locale = useLocale((s) => s.locale);
  const machines = useBoard((s) => s.machines);
  const session = lookup.session(item.sessionId);
  const team = lookup.team(item.teamId);
  const machine = machines.find((m) => m.id === (item.machineId ?? session?.machineId));
  // 單獨 session 的進度卡沒有團隊：顯示 session 名稱。
  const teamLike =
    item.kind === 'team' || item.kind === 'task' || (item.kind === 'progress' && !!item.teamId);
  const name = teamLike
    ? (team?.name ?? t('search.unknownTeam'))
    : (session?.name ?? t('search.unknownSession'));
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <li
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      className={selected ? 'search-row selected' : 'search-row'}
      data-testid="search-row"
      data-kind={item.kind}
      data-session={item.sessionId}
      data-team={item.teamId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      <span className="search-lamp">
        {session && !teamLike ? (
          <Lamp status={session.status} detail={session.statusDetail} />
        ) : (
          <span className="search-team-mark" aria-hidden="true">
            ▦
          </span>
        )}
      </span>
      <span className="search-name">
        {name}
        {session?.archived && !teamLike && (
          <span className="chip search-archived">{t('search.archivedChip')}</span>
        )}
      </span>
      <span className="search-snippet">
        {item.field && <span className="search-field">{t(`search.field.${item.field}`)}</span>}
        <span className={item.kind === 'file' ? 'mono' : undefined}>
          <Highlight text={item.snippet} ranges={item.matchRanges} />
        </span>
        {item.count !== undefined && (
          <span className="search-count num">{t('search.count', { n: item.count })}</span>
        )}
      </span>
      <span
        className="search-time num"
        title={item.at ? new Date(item.at).toLocaleString(locale) : ''}
      >
        {item.at ? t('search.ago', { span: formatSpan(now - Date.parse(item.at), t) }) : ''}
      </span>
      <span className="search-machine">
        {machine && <span className="chip">{machine.name}</span>}
      </span>
    </li>
  );
}

function Group({
  group,
  lookup,
  expanded,
  onToggle,
  selectedKey,
  rowKey,
  onPick,
}: {
  group: SearchGroup;
  lookup: Lookup;
  expanded: boolean;
  onToggle: () => void;
  selectedKey: string | null;
  rowKey: (group: SearchGroup, index: number) => string;
  onPick: (item: SearchItem) => void;
}) {
  const t = useT();
  const shown = expanded ? group.items : group.items.slice(0, FIRST_ROWS);
  const headingId = `search-group-${group.kind}`;
  // 被上限截斷的組顯示「50+」：符合的不只這些。
  const count = group.capped ? `${group.total}+` : String(group.total);
  return (
    <section className="search-group" data-testid={`search-group-${group.kind}`}>
      <h3 id={headingId}>{t(`search.group.${group.kind}`, { n: count })}</h3>
      <ul role="group" aria-labelledby={headingId}>
        {shown.map((item, i) => {
          const key = rowKey(group, i);
          return (
            <Row
              key={key}
              id={key}
              item={item}
              lookup={lookup}
              selected={key === selectedKey}
              onPick={() => onPick(item)}
            />
          );
        })}
      </ul>
      {group.items.length > FIRST_ROWS && (
        <button type="button" className="search-more" onClick={onToggle}>
          {expanded
            ? t('search.showLess')
            : t(group.capped ? 'search.showCapped' : 'search.showAll', { n: group.total })}
        </button>
      )}
      {group.kind === 'file' && (
        <p className="search-note" data-testid="search-file-note">
          {t('search.fileNote')}
        </p>
      )}
    </section>
  );
}

function Filters({ prefs }: { prefs: SearchPrefs & { set(patch: Partial<SearchPrefs>): void } }) {
  const t = useT();
  return (
    <div className="search-filters">
      <div className="seg" role="group" aria-label={t('search.scope')}>
        {(['zone', 'all'] as const).map((scope) => (
          <button
            key={scope}
            type="button"
            aria-pressed={prefs.scope === scope}
            onClick={() => prefs.set({ scope })}
            data-testid={`search-scope-${scope}`}
          >
            {t(`search.scope.${scope}`)}
          </button>
        ))}
      </div>
      <div
        className="seg"
        role="group"
        aria-label={t('search.since')}
        title={t('search.sinceHint')}
      >
        {(['24h', '7d', '30d'] as const).map((since) => (
          <button
            key={since}
            type="button"
            aria-pressed={prefs.since === since}
            onClick={() => prefs.set({ since })}
            data-testid={`search-since-${since}`}
          >
            {t(`search.since.${since}`)}
          </button>
        ))}
      </div>
      <label className="search-archived-toggle">
        <input
          type="checkbox"
          checked={prefs.archived}
          onChange={(e) => prefs.set({ archived: e.target.checked })}
          data-testid="search-archived"
        />
        {t('search.archived')}
      </label>
    </div>
  );
}

export function SearchPanel() {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const boardSessions = useBoard((s) => s.sessions);
  const approvals = useBoard((s) => s.approvals);
  const teams = useTeams((s) => s.teams);
  const teamsStatus = useTeams((s) => s.status);
  const masking = useMaskMode((s) => s.masking);
  const zoneId = useCurrentZoneId();
  const prefs = useSearchPrefs();
  const [draft, setDraft] = useState(() => searchQueryOf(location.hash));
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(-1);
  const [deepAsked, setDeepAsked] = useState(false);
  const [archived, setArchived] = useState<Session[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // 次畫面的外框打開時會把焦點放在框上；等它放完再交給搜尋框。⌘K 再按一次（已開著）也回到搜尋框。
  const modalOpen = useOverlay((s) => s.modal === 'search');
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [modalOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') input.current?.focus();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // 手機直接開 #/search 時畫布沒掛著，團隊清單可能還沒讀過。
  useEffect(() => {
    if (teamsStatus === 'loading') void refreshTeams(backend).catch(() => undefined);
  }, [backend, teamsStatus]);

  const terms = useMemo(() => parseSearchTerms(draft), [draft]);
  const request = useMemo(
    () => ({
      q: draft,
      scope: prefs.scope,
      ...(prefs.scope === 'zone' ? { zoneId } : {}),
      since: prefs.since,
      archived: prefs.archived,
      mask: masking,
    }),
    [draft, prefs.scope, prefs.since, prefs.archived, masking, zoneId],
  );
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    syncUrl(draft);
    setSelected(-1);
    setDeepAsked(false);
    seq.current += 1;
    if (terms.length === 0) {
      setLoaded({ state: 'idle' });
      return;
    }
    const mine = seq.current;
    setLoaded((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }));
    const timer = setTimeout(() => {
      backend.search(request).then(
        (results) => {
          if (mine === seq.current) setLoaded({ state: 'ready', key: requestKey, results });
        },
        (e: unknown) => {
          if (mine === seq.current) setLoaded({ state: 'error', detail: errorDetail(e) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // requestKey 已涵蓋 request 的內容（request 每次 render 都是新物件，不能直接放進來）。
  }, [backend, requestKey, terms.length]);

  // 遮蔽模式切換後、新結果回來前，不顯示用舊設定拿到的片段（可能是沒遮的原文）。
  const results =
    loaded.state === 'ready' && JSON.parse(loaded.key).mask === masking ? loaded.results : null;

  // 封存的 session 不在畫布快照裡：有用到才讀一次。
  const known = useMemo(() => new Map(boardSessions.map((s) => [s.id, s])), [boardSessions]);
  const needArchived =
    results?.groups.some((g) => g.items.some((i) => i.sessionId && !known.has(i.sessionId))) ??
    false;
  useEffect(() => {
    if (!needArchived) return;
    let cancelled = false;
    backend.listArchivedSessions().then(
      (list) => !cancelled && setArchived(list),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [backend, needArchived]);

  const lookup: Lookup = useMemo(() => {
    const archivedById = new Map(archived.map((s) => [s.id, s]));
    const pending = new Set(approvals.map((a) => a.sessionId));
    return {
      session: (id) => (id ? (known.get(id) ?? archivedById.get(id)) : undefined),
      team: (id) => (id ? teams.find((x) => x.id === id) : undefined),
      waiting: (id) => {
        const s = known.get(id);
        return pending.has(id) || (s !== undefined && sessionWaitsForUser(s));
      },
    };
  }, [known, archived, teams, approvals]);

  const rowKey = (group: SearchGroup, i: number) => `search-${group.kind}-${i}`;
  const flat = useMemo(() => {
    const out: { key: string; item: SearchItem }[] = [];
    for (const group of results?.groups ?? []) {
      const shown = expanded.has(group.kind) ? group.items : group.items.slice(0, FIRST_ROWS);
      shown.forEach((item, i) => out.push({ key: rowKey(group, i), item }));
    }
    return out;
  }, [results, expanded]);
  const selectedKey = flat[selected]?.key ?? null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      // -1 是「沒選任何一列」（Enter＝深層）；往上到頂回到 -1，往下停在最後一列。
      setSelected((i) =>
        e.key === 'ArrowDown' ? Math.min(i + 1, flat.length - 1) : Math.max(i - 1, -1),
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = flat[selected];
      if (picked) go(picked.item, lookup);
      // 沒選任何一列：Enter 是「也搜對話與終端機」（深層，這一版還沒有，只亮出說明）。
      else if (terms.length > 0) setDeepAsked(true);
    } else if (e.key === 'Escape') {
      // 搜尋框裡的 Esc 也關視窗（App 的 Esc 不攔輸入框）。
      e.preventDefault();
      if (draft) setDraft('');
      else closeModal();
    }
  };

  const maskQueryHit = masking && secretRanges(draft).length > 0;
  const stale = !connected;

  let body: ReactNode;
  if (terms.length === 0) {
    body = <p className="search-hint">{t('search.tooShort')}</p>;
  } else if (loaded.state === 'error') {
    body = (
      <p className="search-hint err" role="alert">
        {t('search.failed', { error: loaded.detail })}
      </p>
    );
  } else if (!results) {
    body = (
      <p className="search-hint" role="status">
        {t('search.loading')}
      </p>
    );
  } else if (results.groups.length === 0) {
    body = (
      <div className="search-empty" data-testid="search-empty">
        <p>{t('search.empty')}</p>
        <p className="search-hint">{t('search.emptyNext')}</p>
      </div>
    );
  } else {
    body = (
      <>
        {results.partial && (
          <p className="search-hint" role="status" data-testid="search-partial">
            {t('search.partial')}
          </p>
        )}
        {results.groups.map((group) => (
          <Group
            key={group.kind}
            group={group}
            lookup={lookup}
            expanded={expanded.has(group.kind)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(group.kind)) next.delete(group.kind);
                else next.add(group.kind);
                return next;
              })
            }
            selectedKey={selectedKey}
            rowKey={rowKey}
            onPick={(item) => go(item, lookup)}
          />
        ))}
      </>
    );
  }

  return (
    <div className={stale ? 'search-panel stale' : 'search-panel'} data-testid="search-panel">
      <div className="search-top">
        <div className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="search-results"
            aria-activedescendant={selectedKey ?? undefined}
            aria-label={t('search.input')}
            placeholder={t('search.placeholder')}
            maxLength={SEARCH_QUERY_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="search-input"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Filters prefs={prefs} />
        {stale && (
          <p className="search-hint err" role="status" data-testid="search-stale">
            {t('search.stale')}
          </p>
        )}
        {maskQueryHit && (
          <p className="search-hint" role="status" data-testid="search-mask-query">
            {t('search.maskQuery')}
          </p>
        )}
      </div>
      <div className="search-results">
        <div id="search-results" role="listbox" aria-label={t('search.results')}>
          {body}
        </div>
        <section className="search-group search-deep" data-testid="search-deep">
          <h3>{t('search.group.transcript')}</h3>
          <button type="button" disabled aria-describedby="search-deep-note">
            {t('search.deep.button')}
          </button>
          <p
            id="search-deep-note"
            className={deepAsked ? 'search-note asked' : 'search-note'}
            role={deepAsked ? 'status' : undefined}
            data-testid="search-deep-note"
          >
            {t('search.deep.unavailable')}
          </p>
        </section>
      </div>
      <p className="search-keys" aria-hidden="true">
        {t('search.keys')}
      </p>
    </div>
  );
}
