// 用量詳情（GM 2026-11-09）：置中次畫面 `#/usage`（手機是全螢幕頁），從頁首的「近 30 天 N token」或側欄用量打開。
// 由上而下：說明與各台機器狀態 → 期間（7／30／90 天，管下面全部）→ 總覽（今天、近 7 天、近 30 天，固定）→
// 每日趨勢 → 排行（團隊／session／專案）→ 依模型、依機器的分布。
// 數字是本機對話紀錄的 token，不是官方額度；這一頁只讀 hub 的彙整，不呼叫任何模型。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  sessionWaitsForUser,
  type UsageReport,
  type UsageReportMachine,
} from '@agent-board/protocol';
import { terminalHash } from '../canvas/terminalRoute';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { closeModal } from '../views/overlayStore';
import { inboxHash, teamHash } from '../views/overlay';
import { formatTokens, formatTokensFull } from '../views/usage';
import { useViewsUi } from '../views/uiStore';
import {
  byMachine,
  byModel,
  change,
  conversation,
  allTokens,
  daily,
  overview,
  periodEnding,
  ranking,
  shortPath,
  sortRows,
  sortValue,
  todayOf,
  TOKEN_KINDS,
  type Counts,
  type Measure,
  type OverviewItem,
  type RankKind,
  type RankRow,
  type RankTarget,
  type Share,
  type SortKey,
  type StackBy,
} from './model';
import { TrendChart, type SeriesLabel } from './TrendChart';
import './messages';
import './usage.css';

/** hub 只讀記憶體，很便宜；daemon 每 15 分才更新一次，每分鐘問一次就夠。 */
const REFRESH_MS = 60_000;
const PERIODS = [7, 30, 90] as const;
const FIRST_ROWS = 20;
const PHONE_QUERY = '(max-width: 640px)';

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; report: UsageReport; refreshing: boolean }
  | { state: 'error'; detail: string; report: UsageReport | null };

const errorDetail = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useReport(): { loaded: Loaded; reload: () => void } {
  const backend = useBoard((s) => s.backend);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    // 重新讀的時候保留上一次的畫面（淡一點），不閃白。
    setLoaded((prev) => (prev.state === 'ready' ? { ...prev, refreshing: true } : prev));
    backend.usageReport().then(
      (report) => live && setLoaded({ state: 'ready', report, refreshing: false }),
      (e: unknown) =>
        live &&
        setLoaded((prev) => ({
          state: 'error',
          detail: errorDetail(e),
          report: prev.state === 'loading' ? null : prev.report,
        })),
    );
    const timer = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [backend, tick]);
  return { loaded, reload: useCallback(() => setTick((n) => n + 1), []) };
}

/** 點一列：桌面在畫布上聚焦那張卡或開團隊；封存的開封存頁；手機沒有畫布，開團隊面板或全螢幕終端機。 */
function go(target: RankTarget, waiting: (id: string) => boolean): void {
  if (!target) return;
  if (target.type === 'team') {
    location.hash = teamHash(target.teamId);
    return;
  }
  if (target.archived) {
    location.hash = `#/archive/${encodeURIComponent(target.sessionId)}`;
    return;
  }
  if (typeof matchMedia !== 'undefined' && matchMedia(PHONE_QUERY).matches) {
    if (waiting(target.sessionId)) location.hash = inboxHash(target.sessionId);
    else if (target.teamId) location.hash = teamHash(target.teamId);
    else location.hash = terminalHash(target.sessionId);
    return;
  }
  useViewsUi.getState().focusSession(target.sessionId);
  closeModal();
}

function MachineStates({ machines }: { machines: readonly UsageReportMachine[] }) {
  const t = useT();
  const { locale } = useLocale();
  const mask = useMaskText();
  const time = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return (
    <ul className="usage-machines" data-testid="usage-machines">
      {machines.map((m) => {
        const name = mask(m.name);
        const text =
          m.state === 'not_reported'
            ? t('usage.machine.none', { name })
            : m.state === 'old_daemon'
              ? t('usage.machine.old', { name })
              : m.restored
                ? t('usage.machine.restored', { name, time: time(m.countedAt!) })
                : t('usage.machine.detail', { name, time: time(m.countedAt!) });
        return (
          <li
            key={m.machineId}
            className={`usage-machine st-${m.state}${m.online ? '' : ' off'}`}
            data-testid={`usage-machine-${m.machineId}`}
          >
            <span aria-hidden="true">
              {m.state === 'detail' ? (m.online ? '●' : '⊘') : m.state === 'old_daemon' ? '◌' : '—'}
            </span>
            <span>
              {text}
              {!m.online && ` ${t('usage.machine.offline')}`}
              {m.otherSessions > 0 && (
                <span className="hint-inline">
                  {' '}
                  · {t('usage.machine.other', { n: m.otherSessions })}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Seg<V extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  testId: string;
}) {
  return (
    <div className="usage-control">
      <span className="usage-control-label">{label}</span>
      <div className="seg sm" role="group" aria-label={label} data-testid={testId}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Change({ item }: { item: OverviewItem }) {
  const t = useT();
  const { locale } = useLocale();
  const now = conversation(item.current);
  const before = conversation(item.previous);
  const pct = change(now, before);
  const vs = item.days === 1 ? t('usage.vs.today') : t('usage.vs.days', { n: item.days });
  // 增減只用 ▲▼ 與文字，不用綠／紅（綠色只給 DONE 與 diff，紅色是故障，STYLE.md 規則一）。
  const text =
    pct === null
      ? t('usage.vs.none')
      : pct === 0
        ? t('usage.vs.same')
        : t(pct > 0 ? 'usage.vs.up' : 'usage.vs.down', { pct: Math.abs(pct) });
  const mark = pct === null || pct === 0 ? '' : pct > 0 ? '▲ ' : '▼ ';
  return (
    <p
      className="usage-change"
      title={t('usage.vs.title', { value: formatTokensFull(before, locale) })}
      data-testid={`usage-change-${item.days}`}
    >
      {vs} {mark}
      {text}
      {item.previousPartial && pct !== null && (
        <span className="usage-partial" title={t('usage.vs.partial')}>
          {' '}
          ⚠<span className="sr-only">{t('usage.vs.partial')}</span>
        </span>
      )}
    </p>
  );
}

function Breakdown({ counts }: { counts: Counts }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <dl className="usage-breakdown">
      {TOKEN_KINDS.map((k) => (
        <div key={k}>
          <dt>{t(`usage.kind.${k}`)}</dt>
          <dd className="num" title={formatTokensFull(counts[k], locale)}>
            {formatTokens(counts[k], locale)}
          </dd>
        </div>
      ))}
      <div className="usage-breakdown-all">
        <dt>{t('usage.all')}</dt>
        <dd className="num" title={formatTokensFull(allTokens(counts), locale)}>
          {formatTokens(allTokens(counts), locale)}
        </dd>
      </div>
    </dl>
  );
}

function Overview({ items }: { items: readonly OverviewItem[] }) {
  const t = useT();
  const { locale } = useLocale();
  const partial = items.some((i) => i.previousPartial);
  return (
    <section className="usage-card" aria-labelledby="usage-overview-h">
      <h3 id="usage-overview-h" className="sr-only">
        {t('usage.conversation')}
      </h3>
      <div className="usage-tiles" data-testid="usage-overview">
        {items.map((item) => (
          <div key={item.days} className="usage-tile" data-testid={`usage-tile-${item.days}`}>
            <p className="usage-tile-label">
              {item.days === 1 ? t('usage.today') : t('usage.lastDays', { n: item.days })}
              <span className="hint-inline"> · {t('usage.conversation')}</span>
            </p>
            <p
              className="usage-tile-value num"
              title={formatTokensFull(conversation(item.current), locale)}
            >
              {formatTokens(conversation(item.current), locale)}
            </p>
            <Change item={item} />
            <Breakdown counts={item.current} />
          </div>
        ))}
      </div>
      <p className="hint">
        {t('usage.conversation')}：{t('usage.conversationNote')}。{t('usage.todayPartial')}。
        {partial && ` ⚠ ${t('usage.vs.partial')}。`}
      </p>
    </section>
  );
}

const SORT_COLUMNS: readonly SortKey[] = [
  'conversation',
  'input',
  'output',
  'cacheRead',
  'cacheCreation',
  'all',
];

function sortLabel(key: SortKey, t: ReturnType<typeof useT>): string {
  if (key === 'conversation') return t('usage.conversation');
  if (key === 'all') return t('usage.all');
  return t(`usage.kind.${key}`);
}

function rowName(row: RankRow, kind: RankKind, t: ReturnType<typeof useT>): string {
  if (row.kind === 'noTeam') return t('usage.rank.noTeam');
  if (row.kind === 'outside') {
    // session 分頁：中控台外的每個 session 用資料夾當名字。
    return kind === 'session' && row.cwd ? shortPath(row.cwd) : t('usage.rank.outside');
  }
  if (row.kind === 'other') return t('usage.rank.other');
  if (row.kind === 'noCwd') return t('usage.rank.noCwd');
  if (kind === 'project') return shortPath(row.label ?? '');
  return row.label ?? '';
}

function Ranking({ report, period }: { report: UsageReport; period: number }) {
  const t = useT();
  const { locale } = useLocale();
  const mask = useMaskText();
  const sessions = useBoard((s) => s.sessions);
  const [kind, setKind] = useState<RankKind>('team');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'conversation',
    desc: true,
  });
  const [limit, setLimit] = useState(FIRST_ROWS);
  const today = todayOf(new Date());
  const rows = useMemo(
    () => sortRows(ranking(report, periodEnding(today, period), kind), sort.key, sort.desc),
    [report, today, period, kind, sort],
  );
  useEffect(() => setLimit(FIRST_ROWS), [kind, period]);
  const max = Math.max(1, ...rows.map((r) => sortValue(r, sort.key)));
  const isWaiting = (id: string) => sessions.some((s) => s.id === id && sessionWaitsForUser(s));
  const tabs: RankKind[] = ['team', 'session', 'project'];

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }));

  return (
    <section className="usage-card" aria-labelledby="usage-rank-h" data-testid="usage-ranking">
      <div className="usage-card-head">
        <h3 id="usage-rank-h">
          {t('usage.rank')}
          <span className="usage-caption">
            {t('usage.lastDays', { n: period })} · {t('usage.rank.sortHint')}
          </span>
        </h3>
        <div className="seg sm" role="tablist" aria-label={t('usage.rank')}>
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              data-testid={`usage-rank-tab-${k}`}
            >
              {t(`usage.rank.${k}`)}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{t('usage.rank.empty')}</p>
      ) : (
        <table className="usage-table" role="table" data-testid={`usage-rank-${kind}`}>
          <thead>
            <tr>
              <th scope="col">{t('usage.rank.name')}</th>
              {SORT_COLUMNS.map((key) => (
                <th
                  key={key}
                  scope="col"
                  className="num"
                  aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                >
                  <button
                    type="button"
                    className="link usage-sort"
                    onClick={() => onSort(key)}
                    title={t('usage.rank.sortBy', { col: sortLabel(key, t) })}
                    data-testid={`usage-sort-${key}`}
                  >
                    {sortLabel(key, t)}
                    <span aria-hidden="true">
                      {sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((row) => {
              const name = mask(rowName(row, kind, t));
              const full = row.cwd ? mask(row.cwd) : name;
              const goLabel = !row.target
                ? null
                : row.target.type === 'team'
                  ? t('usage.rank.goTeam')
                  : row.target.archived
                    ? t('usage.rank.goArchived')
                    : t('usage.rank.go');
              const sub = [
                kind !== 'project' && row.cwd && row.kind === 'board' ? shortPath(row.cwd) : null,
                row.machines.join('、'),
                // 「其他」是各台併起來的，數 session 沒有意義。
                row.sessions > 1 && row.kind !== 'other'
                  ? t('usage.rank.sessions', { n: row.sessions })
                  : null,
                row.archived ? t('usage.rank.archived') : null,
              ]
                .filter(Boolean)
                .map((s) => mask(s!))
                .join(' · ');
              return (
                <tr
                  key={row.key}
                  className={row.target ? 'go' : undefined}
                  onClick={() => go(row.target, isWaiting)}
                  data-testid={`usage-row-${row.key}`}
                >
                  <th scope="row" data-label={t('usage.rank.name')}>
                    {goLabel ? (
                      <button
                        type="button"
                        className="link usage-link"
                        title={`${goLabel}：${full}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          go(row.target, isWaiting);
                        }}
                      >
                        {name}
                      </button>
                    ) : (
                      <span
                        className="usage-name"
                        title={row.kind === 'outside' ? t('usage.rank.outsideHint') : full}
                      >
                        {name}
                      </span>
                    )}
                    <span className="usage-sub">{sub}</span>
                    <span className="usage-meter" aria-hidden="true">
                      <span style={{ width: `${(sortValue(row, sort.key) / max) * 100}%` }} />
                    </span>
                  </th>
                  {SORT_COLUMNS.map((key) => (
                    <td
                      key={key}
                      className={`num${sort.key === key ? ' sorted' : ''}`}
                      data-label={sortLabel(key, t)}
                      title={formatTokensFull(sortValue(row, key), locale)}
                    >
                      {formatTokens(sortValue(row, key), locale)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.length > limit && (
        <button type="button" className="sm" onClick={() => setLimit((n) => n + FIRST_ROWS)}>
          {t('usage.rank.more', { n: Math.min(FIRST_ROWS, rows.length - limit) })}
        </button>
      )}
    </section>
  );
}

function Shares({
  title,
  shares,
  testId,
  labelOf,
  caption,
}: {
  title: string;
  shares: readonly Share[];
  testId: string;
  labelOf: (s: Share) => string;
  caption: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const total = shares.reduce((a, s) => a + s.value, 0);
  const max = Math.max(1, ...shares.map((s) => s.value));
  return (
    <section className="usage-card" data-testid={testId}>
      <h3>
        {title}
        <span className="usage-caption">{caption}</span>
      </h3>
      {shares.length === 0 ? (
        <p className="empty">{t('usage.rank.empty')}</p>
      ) : (
        <ul className="usage-shares">
          {shares.map((s) => {
            const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
            return (
              <li key={s.key} title={formatTokensFull(s.value, locale)}>
                <span className="usage-share-label">{labelOf(s)}</span>
                <span className="usage-share-value num">
                  {formatTokens(s.value, locale)}
                  <span className="hint-inline"> {t('usage.share.pct', { pct })}</span>
                </span>
                <span className="usage-meter" aria-hidden="true">
                  <span style={{ width: `${(s.value / max) * 100}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Detail({ report, refreshing }: { report: UsageReport; refreshing: boolean }) {
  const t = useT();
  const mask = useMaskText();
  const [period, setPeriod] = useState<number>(30);
  const [stackBy, setStackBy] = useState<StackBy>('type');
  const [measure, setMeasure] = useState<Measure>('conversation');
  const today = todayOf(new Date());
  const p = periodEnding(today, period);
  const items = useMemo(() => overview(report, today), [report, today]);
  const trend = useMemo(
    () => daily(report, periodEnding(today, period), stackBy, measure),
    [report, today, period, stackBy, measure],
  );
  const machineName = (id: string) =>
    mask(report.machines.find((m) => m.machineId === id)?.name ?? id);
  const labels: SeriesLabel[] = trend.series.map((s) => ({
    key: s.key,
    slot: s.slot,
    label:
      stackBy === 'type'
        ? t(`usage.kind.${s.key}`)
        : s.key === 'other-machines'
          ? t('usage.otherMachines')
          : machineName(s.key),
  }));
  const hasDetail = report.machines.some((m) => m.state === 'detail');
  const caption = `${t('usage.lastDays', { n: period })} · ${t(
    measure === 'all' ? 'usage.all' : 'usage.conversation',
  )}`;

  return (
    <div className={`usage-detail${refreshing ? ' refreshing' : ''}`}>
      <MachineStates machines={report.machines} />
      {!hasDetail ? (
        <p className="empty" data-testid="usage-no-detail">
          {t('usage.empty')}
        </p>
      ) : (
        <>
          <div className="usage-filters">
            <Seg
              label={t('usage.period')}
              value={period}
              options={PERIODS.map((n) => ({ value: n, label: t('usage.period.days', { n }) }))}
              onChange={setPeriod}
              testId="usage-period"
            />
            <Seg
              label={t('usage.measure')}
              value={measure}
              options={[
                { value: 'conversation', label: t('usage.conversation') },
                { value: 'all', label: t('usage.all') },
              ]}
              onChange={setMeasure}
              testId="usage-measure"
            />
          </div>
          <Overview items={items} />
          <section className="usage-card" aria-labelledby="usage-trend-h">
            <div className="usage-card-head">
              <h3 id="usage-trend-h">{t('usage.trend')}</h3>
              <div className="usage-controls">
                <Seg
                  label={t('usage.stack')}
                  value={stackBy}
                  options={[
                    { value: 'type', label: t('usage.stack.type') },
                    { value: 'machine', label: t('usage.stack.machine') },
                  ]}
                  onChange={setStackBy}
                  testId="usage-stack"
                />
              </div>
            </div>
            <TrendChart data={trend} series={labels} testId="usage-trend" />
          </section>
          <Ranking report={report} period={period} />
          <div className="usage-shares-row">
            <Shares
              title={t('usage.share.model')}
              shares={byModel(report, p, measure)}
              testId="usage-by-model"
              caption={caption}
              labelOf={(s) => s.label || t('usage.share.noModel')}
            />
            <Shares
              title={t('usage.share.machine')}
              shares={byMachine(report, p, measure)}
              testId="usage-by-machine"
              caption={caption}
              labelOf={(s) => mask(s.label)}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function UsagePage() {
  const t = useT();
  const { loaded, reload } = useReport();
  const report = loaded.state === 'loading' ? null : loaded.report;
  return (
    <div className="page usage-page" data-testid="usage-page">
      <header className="panel-head usage-page-head">
        <h1>{t('usage.title')}</h1>
        <div className="panel-acts">
          <button type="button" className="sm" onClick={reload} data-testid="usage-refresh">
            {t('usage.refresh')}
          </button>
        </div>
      </header>
      <p className="usage-note" data-testid="usage-note">
        <span aria-hidden="true">ⓘ </span>
        {t('usage.note')}
      </p>
      {loaded.state === 'error' && (
        <div className="alert" role="alert" data-testid="usage-error">
          <span aria-hidden="true">✕</span>
          <div>{t('usage.error', { detail: loaded.detail })}</div>
          <button type="button" className="sm" onClick={reload}>
            {t('usage.retry')}
          </button>
        </div>
      )}
      {loaded.state === 'loading' && (
        <p className="hint" role="status">
          {t('usage.loading')}
        </p>
      )}
      {report && (
        <Detail report={report} refreshing={loaded.state === 'ready' && loaded.refreshing} />
      )}
    </div>
  );
}
