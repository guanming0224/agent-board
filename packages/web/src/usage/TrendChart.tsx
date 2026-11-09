// 每日趨勢：手畫的 SVG 堆疊長條（不加圖表套件）。依 dataviz 的標記規格：細長條、頂端 4px 圓角貼著基線、
// 段與段之間 2px 底色間隔、格線與軸線很淡；一定有圖例（≥ 2 個系列）、滑鼠／鍵盤逐日看數字的提示框、
// 還有「表格」檢視。顏色只用 QUOTA 紫的四階（STYLE.md：額度相關用紫色，狀態色不挪用），見 usage.css。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useT } from '../shared/i18n';
import { formatTokens, formatTokensFull } from '../views/usage';
import { niceTicks, type Daily } from './model';

const HEIGHT = 200;
const PAD = { top: 10, right: 8, bottom: 24, left: 48 };
/** 每天至少佔幾 px：太窄時圖可以橫向捲（手機）。 */
const MIN_STEP = 9;
const GAP = 2;
const RADIUS = 4;

export interface SeriesLabel {
  key: string;
  slot: number;
  label: string;
}

/** 只有頂端圓角的長條（貼著基線的那端是直的）。 */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(RADIUS, w / 2, h));
  return [
    `M${x},${y + h}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

/** 11/09 這種短日期；完整日期在提示框。 */
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export function Legend({ series }: { series: readonly SeriesLabel[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="usage-legend" data-testid="usage-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className={`usage-swatch uv-s${s.slot}`} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export function TrendChart({
  data,
  series,
  testId,
}: {
  data: Daily;
  series: readonly SeriesLabel[];
  testId: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth || 640);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [table]);

  // 換期間或堆疊方式時，舊的索引可能超出範圍。
  useEffect(() => setActive(null), [data.days.length, series.length]);

  const n = data.days.length;
  const svgWidth = Math.max(width, PAD.left + PAD.right + n * MIN_STEP);
  const plotW = svgWidth - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = plotW / Math.max(1, n);
  const barW = Math.max(2, step - GAP);
  const ticks = niceTicks(data.max);
  const top = ticks[ticks.length - 1] || 1;
  const yOf = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 56))));
  const totalOf = (d: number) => data.values[d]!.reduce((a, b) => a + b, 0);

  const onKey = (e: KeyboardEvent) => {
    if (n === 0) return;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key in moves) {
      e.preventDefault();
      setActive((a) => Math.min(n - 1, Math.max(0, (a ?? n) + moves[e.key]!)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape' && active !== null) {
      // 先收提示框；沒有提示框時 Esc 照常關面板。
      e.preventDefault();
      setActive(null);
    }
  };

  const tooltip =
    active === null || active >= n ? null : (
      <div
        className="usage-tooltip"
        role="status"
        data-testid={`${testId}-tooltip`}
        style={{
          left: Math.min(
            Math.max(PAD.left + active * step + step / 2 - (box.current?.scrollLeft ?? 0), 90),
            width - 90,
          ),
        }}
      >
        <div className="usage-tooltip-day">{data.days[active]}</div>
        <div className="usage-tooltip-total num">
          <b>{formatTokensFull(totalOf(active), locale)}</b> {t('usage.chart.total')}
        </div>
        {series.length > 1 &&
          [...series].reverse().map((s) => {
            const i = series.indexOf(s);
            return (
              <div key={s.key} className="usage-tooltip-row">
                <span className={`usage-key uv-s${s.slot}`} aria-hidden="true" />
                <b className="num">{formatTokensFull(data.values[active]![i]!, locale)}</b>
                <span>{s.label}</span>
              </div>
            );
          })}
      </div>
    );

  return (
    <div className="usage-chart" data-testid={testId}>
      <div className="usage-chart-tools">
        <Legend series={series} />
        <span className="spacer" />
        <div className="seg sm" role="group" aria-label={t('usage.trend')}>
          <button type="button" aria-pressed={!table} onClick={() => setTable(false)}>
            {t('usage.chart.chart')}
          </button>
          <button
            type="button"
            aria-pressed={table}
            onClick={() => setTable(true)}
            data-testid={`${testId}-table-toggle`}
          >
            {t('usage.chart.table')}
          </button>
        </div>
      </div>
      {data.max === 0 && <p className="hint">{t('usage.chart.noData')}</p>}
      {table ? (
        <div className="usage-scroll">
          <table className="usage-data-table" data-testid={`${testId}-table`}>
            <thead>
              <tr>
                <th scope="col">{t('usage.chart.day')}</th>
                {series.length > 1 &&
                  series.map((s) => (
                    <th key={s.key} scope="col" className="num">
                      {s.label}
                    </th>
                  ))}
                <th scope="col" className="num">
                  {t('usage.chart.total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((day, d) => (
                <tr key={day}>
                  <th scope="row">{day}</th>
                  {series.length > 1 &&
                    series.map((s, i) => (
                      <td key={s.key} className="num">
                        {formatTokensFull(data.values[d]![i]!, locale)}
                      </td>
                    ))}
                  <td className="num">{formatTokensFull(totalOf(d), locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="usage-plot">
          <div
            className="usage-scroll"
            ref={box}
            tabIndex={0}
            role="group"
            aria-label={t('usage.chart.aria', {
              from: data.days[0] ?? '',
              to: data.days[n - 1] ?? '',
            })}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            data-testid={`${testId}-plot`}
          >
            <svg
              width={svgWidth}
              height={HEIGHT}
              viewBox={`0 0 ${svgWidth} ${HEIGHT}`}
              aria-hidden="true"
              onPointerLeave={() => setActive(null)}
            >
              {ticks.map((v) => (
                <g key={v}>
                  <line
                    className={v === 0 ? 'usage-axis' : 'usage-grid'}
                    x1={PAD.left}
                    x2={svgWidth - PAD.right}
                    y1={yOf(v)}
                    y2={yOf(v)}
                  />
                  <text className="usage-tick" x={PAD.left - 6} y={yOf(v) + 4} textAnchor="end">
                    {formatTokens(v, locale)}
                  </text>
                </g>
              ))}
              {active !== null && active < n && (
                <rect
                  className="usage-hover"
                  x={PAD.left + active * step}
                  y={PAD.top}
                  width={step}
                  height={plotH}
                />
              )}
              {data.days.map((day, d) => {
                const x = PAD.left + d * step + GAP / 2;
                let acc = 0;
                const values = data.values[d]!;
                const lastNonZero = values.reduce((last, v, i) => (v > 0 ? i : last), -1);
                return (
                  <g key={day}>
                    {values.map((v, i) => {
                      if (v <= 0) return null;
                      const y0 = yOf(acc);
                      acc += v;
                      const y1 = yOf(acc);
                      // 段與段之間留 2px 底色（最底下那段貼著基線）。
                      const h = Math.max(0, y0 - y1 - (acc - v > 0 ? GAP : 0));
                      if (h <= 0) return null;
                      const cls = `usage-bar uv-s${series[i]?.slot ?? 0}`;
                      return i === lastNonZero ? (
                        <path key={i} className={cls} d={topRounded(x, y1, barW, h)} />
                      ) : (
                        <rect key={i} className={cls} x={x} y={y1} width={barW} height={h} />
                      );
                    })}
                    {d % labelEvery === (n - 1) % labelEvery && (
                      <text
                        className="usage-tick"
                        x={PAD.left + d * step + step / 2}
                        y={HEIGHT - 6}
                        textAnchor="middle"
                      >
                        {shortDay(day)}
                      </text>
                    )}
                    {/* 命中區比長條大：整欄高、整格寬。 */}
                    <rect
                      className="usage-hit"
                      x={PAD.left + d * step}
                      y={PAD.top}
                      width={step}
                      height={plotH}
                      onPointerEnter={() => setActive(d)}
                      onPointerMove={() => setActive(d)}
                      data-testid={`${testId}-day-${d}`}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
          {tooltip}
        </div>
      )}
    </div>
  );
}
