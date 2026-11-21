// 用量詳情的「全部」期間（GM 2026-11-21，CONTRACTS §27）：資料是 hub 的 GET /api/usage/history
// （hub 每天存的歷史 ∪ 各機器目前的掃描，每格取較大者），以月為單位。可依機器、來源（Claude／Codex）篩選，
// 依 token 類型、機器、來源堆疊，依模型、機器、來源看分布。沒有 session 排行（hub 歷史不存 session）。
// 只讀 hub 的資料，不呼叫任何模型。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UsageHistoryReport } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { formatTokens, formatTokensFull } from '../views/usage';
import {
  filterHistory,
  hasCodexHistory,
  historyByMachine,
  historyByModel,
  historyBySource,
  historyRange,
  historyTotals,
  monthly,
  type HistoryStackBy,
} from './history';
import { measureOf, todayOf, type AgentFilter, type Measure } from './model';
import { Breakdown, Seg, Shares } from './parts';
import { TrendChart, type SeriesLabel } from './TrendChart';

/** hub 讀資料表，比 /api/usage 稍貴，但一樣很小；開著時每分鐘重讀。 */
const REFRESH_MS = 60_000;

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; report: UsageHistoryReport; refreshing: boolean }
  | { state: 'error'; detail: string; report: UsageHistoryReport | null };

function useHistory(): { loaded: Loaded; reload: () => void } {
  const backend = useBoard((s) => s.backend);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoaded((prev) => (prev.state === 'ready' ? { ...prev, refreshing: true } : prev));
    backend.usageHistory().then(
      (report) => live && setLoaded({ state: 'ready', report, refreshing: false }),
      (e: unknown) =>
        live &&
        setLoaded((prev) => ({
          state: 'error',
          detail: e instanceof Error ? e.message : String(e),
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

/**
 * x 軸的月份：一月與第一個月帶年份（「26年1月」／“Jan 26”），其餘只寫月（「5月」／“May”），
 * 標籤短才不會在最右邊被切掉。完整的 `YYYY-MM` 在提示框與表格。
 */
function monthLabel(locale: string, first: string): (month: string) => string {
  const withYear = new Intl.DateTimeFormat(locale, {
    year: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
  const short = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  return (month) => {
    const date = new Date(`${month}-01T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return month;
    return (month.endsWith('-01') || month === first ? withYear : short).format(date);
  };
}

export function AllTime({
  filters,
  measure,
  agent,
  onAgent,
}: {
  /** 上層的期間、計算切換（和其他期間同一列）。 */
  filters: ReactNode;
  measure: Measure;
  agent: AgentFilter;
  onAgent: (agent: AgentFilter) => void;
}) {
  const t = useT();
  const { loaded, reload } = useHistory();
  const report = loaded.state === 'loading' ? null : loaded.report;
  return (
    <div
      className={`usage-alltime${loaded.state === 'ready' && loaded.refreshing ? ' refreshing' : ''}`}
      data-testid="usage-alltime"
    >
      {loaded.state === 'error' && (
        <div className="alert" role="alert" data-testid="usage-history-error">
          <span aria-hidden="true">✕</span>
          <div>{t('usage.error', { detail: loaded.detail })}</div>
          <button type="button" className="sm" onClick={reload}>
            {t('usage.retry')}
          </button>
        </div>
      )}
      {loaded.state === 'loading' && (
        <>
          <div className="usage-filters">{filters}</div>
          <p className="hint" role="status">
            {t('usage.loading')}
          </p>
        </>
      )}
      {report && (
        <HistoryView
          report={report}
          filters={filters}
          measure={measure}
          agent={agent}
          onAgent={onAgent}
        />
      )}
    </div>
  );
}

function HistoryView({
  report,
  filters,
  measure,
  agent,
  onAgent,
}: {
  report: UsageHistoryReport;
  filters: ReactNode;
  measure: Measure;
  agent: AgentFilter;
  onAgent: (agent: AgentFilter) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const mask = useMaskText();
  const [machine, setMachine] = useState('all');
  const [stackBy, setStackBy] = useState<HistoryStackBy>('type');
  const codex = hasCodexHistory(report);
  const source = codex ? agent : 'all';
  // 選的機器不在報表裡了（例如資料重讀後）：回到全部。
  const machineId = report.machines.some((m) => m.machineId === machine) ? machine : 'all';
  const rows = useMemo(
    () => filterHistory(report, { source, machine: machineId }),
    [report, source, machineId],
  );
  const thisMonth = todayOf(new Date()).slice(0, 7);
  const trend = useMemo(
    () =>
      monthly(report, rows, stackBy === 'source' && !codex ? 'type' : stackBy, measure, thisMonth),
    [report, rows, stackBy, codex, measure, thisMonth],
  );
  const range = historyRange(report, rows);
  const total = historyTotals(rows);
  const machineName = (id: string) => {
    const m = report.machines.find((x) => x.machineId === id);
    if (!m) return mask(id);
    return m.removed ? `${mask(m.name)}${t('usage.history.removedTag')}` : mask(m.name);
  };
  const labels: SeriesLabel[] = trend.series.map((s) => ({
    key: s.key,
    slot: s.slot,
    label:
      stackBy === 'type' || (stackBy === 'source' && !codex)
        ? t(`usage.kind.${s.key}`)
        : stackBy === 'source'
          ? t(s.key === 'codex' ? 'usage.agent.codex' : 'usage.agent.claude')
          : s.key === 'other-machines'
            ? t('usage.otherMachines')
            : machineName(s.key),
  }));
  const caption = `${t('usage.period.all')} · ${t(measure === 'all' ? 'usage.all' : 'usage.conversation')}`;
  const withData = report.machines.filter((m) => m.firstDay !== null);

  return (
    <>
      <div className="usage-filters">
        {filters}
        {codex && (
          <Seg
            label={t('usage.agent')}
            value={agent}
            options={[
              { value: 'all', label: t('usage.agent.all') },
              { value: 'claude', label: t('usage.agent.claude') },
              { value: 'codex', label: t('usage.agent.codex') },
            ]}
            onChange={onAgent}
            testId="usage-agent"
          />
        )}
        {report.machines.length > 1 && (
          <label className="usage-control">
            <span className="usage-control-label">{t('usage.history.machine')}</span>
            <select
              value={machineId}
              onChange={(e) => setMachine(e.target.value)}
              data-testid="usage-history-machine"
            >
              <option value="all">{t('usage.history.allMachines')}</option>
              {report.machines.map((m) => (
                <option key={m.machineId} value={m.machineId}>
                  {machineName(m.machineId)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <section
        className="usage-card"
        aria-labelledby="usage-history-h"
        data-testid="usage-history-summary"
      >
        <h3 id="usage-history-h">
          {t('usage.history.total')}
          <span className="usage-caption">
            {range
              ? t('usage.history.range', { from: range.first, to: range.last })
              : t('usage.chart.noData')}
          </span>
        </h3>
        <p
          className="usage-tile-value num"
          title={formatTokensFull(measureOf(total, measure), locale)}
        >
          {formatTokens(measureOf(total, measure), locale)}
          <span className="hint-inline">
            {' '}
            {t(measure === 'all' ? 'usage.all' : 'usage.conversation')}
          </span>
        </p>
        <Breakdown counts={total} />
        <ul className="usage-machines usage-coverage" data-testid="usage-history-coverage">
          {withData.map((m) => (
            <li key={m.machineId} data-testid={`usage-history-machine-${m.machineId}`}>
              <span aria-hidden="true">{m.removed ? '⊘' : m.completeAt ? '●' : '◌'}</span>
              <span>
                {t('usage.history.machineRange', {
                  name: machineName(m.machineId),
                  from: m.firstDay ?? '',
                  to: m.lastDay ?? '',
                })}
                {!m.removed && !m.completeAt && (
                  <span className="hint-inline"> · {t('usage.history.noBackfill')}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="hint" data-testid="usage-history-note">
          {t('usage.history.note')}
        </p>
      </section>

      <section className="usage-card" aria-labelledby="usage-monthly-h">
        <div className="usage-card-head">
          <h3 id="usage-monthly-h">{t('usage.history.trend')}</h3>
          <div className="usage-controls">
            <Seg
              label={t('usage.stack')}
              value={stackBy}
              options={[
                { value: 'type', label: t('usage.stack.type') },
                { value: 'machine', label: t('usage.stack.machine') },
                ...(codex ? [{ value: 'source' as const, label: t('usage.stack.source') }] : []),
              ]}
              onChange={setStackBy}
              testId="usage-history-stack"
            />
          </div>
        </div>
        <TrendChart
          data={trend}
          series={labels}
          testId="usage-monthly"
          shortLabel={monthLabel(locale, trend.days[0] ?? '')}
          columnLabel={t('usage.history.month')}
          ariaLabel={t('usage.history.chartAria', {
            from: trend.days[0] ?? '',
            to: trend.days[trend.days.length - 1] ?? '',
          })}
        />
      </section>

      <div className="usage-shares-row">
        <Shares
          title={t('usage.share.model')}
          shares={historyByModel(report, rows, measure)}
          testId="usage-history-by-model"
          caption={caption}
          labelOf={(s) => s.label || t('usage.share.noModel')}
        />
        <Shares
          title={t('usage.share.machine')}
          shares={historyByMachine(report, rows, measure)}
          testId="usage-history-by-machine"
          caption={caption}
          labelOf={(s) => machineName(s.key)}
        />
        {codex && (
          <Shares
            title={t('usage.share.agent')}
            shares={historyBySource(rows, measure)}
            testId="usage-history-by-agent"
            caption={caption}
            labelOf={(s) => t(s.label === 'codex' ? 'usage.agent.codex' : 'usage.agent.claude')}
          />
        )}
      </div>
      <p className="hint">{t('usage.history.noRanking')}</p>
    </>
  );
}
