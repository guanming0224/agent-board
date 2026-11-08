// 全域搜尋視窗（P3 §3.3、§3.4）。桌面是置中次畫面，手機是全螢幕頁 `#/search`（App 依網址決定外框）。
// 輸入時（停 250ms、至少 2 字）只跑快速層（hub 已有的資料）；按 Enter（沒選任何一列時）或「也搜對話與終端機」鈕
// 才跑深層（③b）：各台機器即時搜對話紀錄與活著的 session 的終端機畫面，結果逐台串流進「對話與終端機」組。
// 改字、改範圍或再按一次 Enter 會取消上一次深層搜尋（hub 再叫各台 daemon 停止讀檔）。手機不自動跑，要按鈕。
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
import type { DeepSearchHandle } from '../shared/backend';
import { terminalHash } from '../canvas/terminalRoute';
import { focusProgressOwner, useProgressUi } from '../progress';
import { useMaskMode } from '../security';
import { secretRanges } from '../security/secretPatterns';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { refreshTeams, useTeams } from '../team/store';
import { closeModal, useOverlay } from '../views/overlayStore';
import {
  inboxHash,
  MEMORY_HASH,
  searchHash,
  searchQueryOf,
  teamHash,
  transcriptHash,
} from '../views/overlay';
import { formatSpan, Lamp, useNow } from '../views/session';
import { useViewsUi } from '../views/uiStore';
import { useCurrentZoneId } from '../zones/store';
import { reduceDeep, type DeepMachine, type DeepState } from './deep';
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

/** ⌘Enter（或 ⌘點擊）：開該 session 的對話紀錄並捲到命中的那則（深層結果帶 transcriptIndex）。 */
function openTranscript(item: SearchItem, lookup: Lookup): boolean {
  const session = lookup.session(item.sessionId);
  if (!session) return false;
  location.hash = transcriptHash(session.id, item.transcriptIndex);
  return true;
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
  onPick: (withMeta: boolean) => void;
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
      onClick={(e) => onPick(e.metaKey || e.ctrlKey)}
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
        {item.field ? (
          <span className="search-field">{t(`search.field.${item.field}`)}</span>
        ) : item.kind === 'transcript' ? (
          <span className="search-field">
            {item.transcriptIndex === undefined
              ? t('search.kind.transcript')
              : t('search.kind.transcriptAt', { n: item.transcriptIndex + 1 })}
          </span>
        ) : item.kind === 'screen' ? (
          <span className="search-field">{t('search.kind.screen')}</span>
        ) : null}
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
  onPick: (item: SearchItem, withMeta: boolean) => void;
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
              onPick={(withMeta) => onPick(item, withMeta)}
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
  const [deep, setDeep] = useState<DeepState>({ state: 'idle' });
  const deepHandle = useRef<DeepSearchHandle | null>(null);
  const machines = useBoard((s) => s.machines);
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
    // 改字、改範圍或遮蔽模式：上一次深層搜尋取消（hub 叫各台 daemon 停止讀檔），舊結果不再顯示。
    deepHandle.current?.cancel();
    deepHandle.current = null;
    setDeep({ state: 'idle' });
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

  // 關掉視窗：進行中的深層搜尋取消。
  useEffect(
    () => () => {
      deepHandle.current?.cancel();
      deepHandle.current = null;
    },
    [],
  );

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

  // 深層結果：同快速層的排序（等你的與 RUN 在前，其餘依時間新到舊；沒時間的照到達順序排後面）。
  const deepGroup: SearchGroup | null = useMemo(() => {
    if (deep.state === 'idle' || deep.state === 'blocked' || deep.items.length === 0) return null;
    const rank = (item: SearchItem) => {
      const session = lookup.session(item.sessionId);
      return session && (lookup.waiting(session.id) || session.status === 'running') ? 0 : 1;
    };
    const items = deep.items
      .map((item, i) => ({ item, i, r: rank(item) }))
      .sort((a, b) => a.r - b.r || (b.item.at ?? '').localeCompare(a.item.at ?? '') || a.i - b.i)
      .map((x) => x.item);
    return { kind: 'transcript', total: items.length, capped: false, items };
  }, [deep, lookup]);

  const rowKey = (group: SearchGroup, i: number) => `search-${group.kind}-${i}`;
  const flat = useMemo(() => {
    const out: { key: string; item: SearchItem }[] = [];
    for (const group of [...(results?.groups ?? []), ...(deepGroup ? [deepGroup] : [])]) {
      const shown = expanded.has(group.kind) ? group.items : group.items.slice(0, FIRST_ROWS);
      shown.forEach((item, i) => out.push({ key: rowKey(group, i), item }));
    }
    return out;
  }, [results, deepGroup, expanded]);
  const selectedKey = flat[selected]?.key ?? null;

  const maskQueryHit = masking && secretRanges(draft).length > 0;
  const stale = !connected;

  /** 深層搜尋：取消上一次、送新的。遮蔽模式下查詢字像金鑰就不送（§3.5）。 */
  const startDeep = () => {
    if (terms.length === 0) return;
    deepHandle.current?.cancel();
    deepHandle.current = null;
    if (maskQueryHit) {
      setDeep({ state: 'blocked' });
      return;
    }
    let searchId = '';
    const handle = backend.deepSearch(request, (event) => {
      if (event.searchId !== searchId) return;
      setDeep((prev) => reduceDeep(prev, event));
    });
    searchId = handle.searchId;
    deepHandle.current = handle;
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete('transcript');
      return next;
    });
    setDeep({ state: 'running', searchId, machines: [], items: [] });
  };

  const pick = (item: SearchItem, withMeta: boolean) => {
    if (withMeta && openTranscript(item, lookup)) return;
    go(item, lookup);
  };

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
      if (picked) pick(picked.item, e.metaKey || e.ctrlKey);
      // 沒選任何一列：Enter 是「也搜對話與終端機」（深層）；再按一次會取消上一次、重新搜。
      // 手機不自動跑（省流量與電），要按鈕。
      else if (terms.length > 0 && !isPhone()) startDeep();
    } else if (e.key === 'Escape') {
      // 搜尋框裡的 Esc 也關視窗（App 的 Esc 不攔輸入框）。
      e.preventDefault();
      if (draft) setDraft('');
      else closeModal();
    }
  };

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
            onPick={pick}
          />
        ))}
      </>
    );
  }

  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  const deepRunning = deep.state === 'running';
  const deepSection = (
    <section
      className="search-group search-deep"
      data-testid="search-deep"
      data-state={deep.state}
      aria-busy={deepRunning}
    >
      <h3 id="search-group-transcript">
        {deepGroup
          ? t('search.group.transcriptN', { n: deepGroup.total })
          : t('search.group.transcript')}
        {deepRunning && <span className="search-deep-busy"> {t('search.deep.running')}</span>}
      </h3>
      {(deep.state === 'running' || deep.state === 'finished' || deep.state === 'failed') &&
        deep.machines.length > 0 && (
          <ul className="search-deep-machines" role="status" data-testid="search-deep-machines">
            {deep.machines.map((m) => (
              <li
                key={m.machineId}
                data-testid={`search-deep-machine-${m.machineId}`}
                data-state={m.state}
              >
                {deepMachineText(t, machineName(m.machineId), m)}
              </li>
            ))}
          </ul>
        )}
      {deepGroup && (
        <>
          <ul
            role="group"
            aria-labelledby="search-group-transcript"
            data-testid="search-group-transcript"
          >
            {(expanded.has('transcript')
              ? deepGroup.items
              : deepGroup.items.slice(0, FIRST_ROWS)
            ).map((item, i) => {
              const key = rowKey(deepGroup, i);
              return (
                <Row
                  key={key}
                  id={key}
                  item={item}
                  lookup={lookup}
                  selected={key === selectedKey}
                  onPick={(withMeta) => pick(item, withMeta)}
                />
              );
            })}
          </ul>
          {deepGroup.items.length > FIRST_ROWS && (
            <button
              type="button"
              className="search-more"
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has('transcript')) next.delete('transcript');
                  else next.add('transcript');
                  return next;
                })
              }
            >
              {expanded.has('transcript')
                ? t('search.showLess')
                : t('search.showAll', { n: deepGroup.total })}
            </button>
          )}
        </>
      )}
      {deep.state === 'finished' && !deepGroup && (
        <p className="search-note asked" role="status" data-testid="search-deep-empty">
          {deep.machines.length === 0 ? t('search.deep.none') : t('search.deep.empty')}
        </p>
      )}
      {deep.state === 'failed' && (
        <p className="search-note err" role="alert" data-testid="search-deep-failed">
          {t('search.deep.failed')}
        </p>
      )}
      {deep.state === 'blocked' && (
        <p className="search-note asked" role="status" data-testid="search-deep-blocked">
          {t('search.deep.blocked')}
        </p>
      )}
      <div className="search-deep-actions">
        <button
          type="button"
          onClick={startDeep}
          disabled={terms.length === 0 || stale}
          aria-describedby="search-deep-note"
          data-testid="search-deep-button"
        >
          {deep.state === 'idle' || deep.state === 'blocked'
            ? t('search.deep.button')
            : t('search.deep.again')}
        </button>
      </div>
      <p id="search-deep-note" className="search-note" data-testid="search-deep-note">
        {t('search.deep.hint')}
      </p>
    </section>
  );

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
          {deepSection}
        </div>
      </div>
      <p className="search-keys" aria-hidden="true">
        {t('search.keys')}
      </p>
    </div>
  );
}

/** 一台機器的深層進度（§3.3：搜尋中／完成 N 筆／失聯沒搜到／版本太舊不支援／逾時只搜了部分）。 */
function deepMachineText(t: ReturnType<typeof useT>, machine: string, m: DeepMachine): string {
  switch (m.state) {
    case 'searching':
      return t('search.deep.searching', { machine });
    case 'offline':
      return t('search.deep.offline', { machine });
    case 'unsupported':
      return t('search.deep.unsupported', { machine });
    case 'timeout':
      return t('search.deep.timeout', { machine, n: m.items, scanned: m.scanned, total: m.total });
    case 'done':
      return m.scanned < m.total
        ? t('search.deep.donePartial', { machine, n: m.items, scanned: m.scanned, total: m.total })
        : t('search.deep.done', { machine, n: m.items });
  }
}
