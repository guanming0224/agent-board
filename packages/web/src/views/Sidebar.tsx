import { useEffect, useState } from 'react';
import type { Machine, ResourceSample, UsageSummary } from '@agent-board/protocol';
import { useLocale, useT } from '../shared/i18n';
import {
  codeLabelKey,
  statusCode,
  STATUS_VISUAL,
  type HandsLine,
  type StatusCode,
} from '../shared/status';
import { useBoard } from '../shared/store';
import { CodeChip, Meter, useClock } from './session';
import { useViewsUi } from './uiStore';
import {
  cacheTokens,
  conversationTokens,
  formatTokens,
  formatTokensFull,
  windowDays,
} from './usage';
import { USAGE_HASH } from './overlay';
import { useUsageStore } from './usageStore';

/**
 * 狀態圖例分三組：算「等你」的、在進行的、其他（等額度、結束、失聯）。10 個代碼，每個一色（GM 2026-11-08）。
 * 和卡片上的徽章同一套樣式，旁邊寫中文說明。
 */
const LEGEND_GROUPS: { key: 'needsYou' | 'working' | 'other'; codes: StatusCode[] }[] = [
  { key: 'needsYou', codes: ['PERM', 'ASK', 'PLAN', 'ERR'] },
  { key: 'working', codes: ['NEW', 'RUN', 'QUE'] },
  { key: 'other', codes: ['QUOTA', 'DONE', 'OFF'] },
];

/** 圖例徽章的符號：ERR 包含錯誤與卡住，用錯誤的符號。 */
const LEGEND_GLYPH: Record<StatusCode, string> = {
  NEW: STATUS_VISUAL.starting.glyph,
  RUN: STATUS_VISUAL.running.glyph,
  ASK: STATUS_VISUAL.waiting_input.glyph,
  PERM: STATUS_VISUAL.waiting_permission.glyph,
  PLAN: STATUS_VISUAL.plan_review.glyph,
  ERR: STATUS_VISUAL.error.glyph,
  QUOTA: STATUS_VISUAL.rate_limited.glyph,
  QUE: STATUS_VISUAL.queued.glyph,
  DONE: STATUS_VISUAL.done.glyph,
  OFF: STATUS_VISUAL.offline.glyph,
};

const HANDS_ORDER: HandsLine[] = ['dotted', 'dashed', 'solid', 'heavy', 'bypass'];

function Rig({ machine, sample }: { machine: Machine; sample: ResourceSample | undefined }) {
  const t = useT();
  const clock = useClock();
  const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
  return (
    <div className={`rig${machine.online ? '' : ' off'}`} data-testid={`rig-${machine.id}`}>
      <div className="name">
        {machine.online ? <span className="dot" /> : <span aria-hidden="true">⊘</span>}
        <span className="rig-name">{machine.name}</span>
      </div>
      {!machine.online ? (
        <p className="hint">
          {machine.lastSeenAt
            ? t('views.side.lastSeen', { time: clock(machine.lastSeenAt) })
            : t('views.side.lastSeenNever')}
        </p>
      ) : !sample ? (
        <p className="hint">{t('views.side.reading')}</p>
      ) : (
        <div className="bars">
          <span>CPU</span>
          <Meter percent={sample.cpuPercent} label={`${machine.name} CPU`} />
          <span>RAM</span>
          <Meter
            percent={percent(sample.memoryUsedBytes, sample.memoryTotalBytes)}
            label={`${machine.name} RAM`}
          />
          {sample.gpu && (
            <>
              <span>GPU</span>
              <Meter percent={sample.gpu.utilizationPercent} label={`${machine.name} GPU`} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function UsageRow({ machine, summary }: { machine: Machine; summary: UsageSummary | null }) {
  const t = useT();
  const { locale } = useLocale();
  const clock = useClock();
  return (
    <div className={`usage-row${machine.online ? '' : ' off'}`} data-testid={`usage-${machine.id}`}>
      <div className="usage-head">
        <span className="rig-name">{machine.name}</span>
        {summary ? (
          <b
            className="num"
            title={t('views.usage.machineTitle', {
              input: formatTokensFull(summary.inputTokens, locale),
              output: formatTokensFull(summary.outputTokens, locale),
              read: formatTokensFull(summary.cacheReadTokens, locale),
              write: formatTokensFull(summary.cacheCreationTokens, locale),
            })}
          >
            {formatTokens(conversationTokens(summary), locale)}
          </b>
        ) : (
          <span className="hint-inline">—</span>
        )}
      </div>
      <p className="hint">
        {summary
          ? t('views.usage.machineSub', {
              cache: formatTokens(cacheTokens(summary), locale),
              time: clock(summary.to),
            })
          : t('views.usage.notReported')}
      </p>
    </div>
  );
}

function UsageSection() {
  const t = useT();
  const { machines, sessions } = useBoard();
  const { byMachine, loaded, failed } = useUsageStore();
  const limited = sessions.filter((s) => !s.archived && s.status === 'rate_limited').length;
  const known = machines.map((m) => byMachine[m.id]).filter((s): s is UsageSummary => s != null);
  const days = known.length > 0 ? Math.max(...known.map(windowDays)) : null;
  return (
    <section data-testid="usage-section">
      <h3>{t('views.side.quota')}</h3>
      {limited > 0 && (
        <p className="hint l-quota">{t('views.side.quotaLimited', { n: limited })}</p>
      )}
      {machines.length === 0 ? null : !loaded ? (
        <p className="hint">{t('views.usage.loading')}</p>
      ) : (
        machines.map((m) => <UsageRow key={m.id} machine={m} summary={byMachine[m.id] ?? null} />)
      )}
      {failed && <p className="hint">{t('views.usage.failed')}</p>}
      <p className="hint">
        {days === null ? t('views.side.quotaNone') : t('views.usage.note', { days })}
      </p>
      {/* 用量詳情（GM 2026-11-09） */}
      <a className="usage-open side" href={USAGE_HASH} data-testid="usage-side-open">
        {t('usage.open')} →
      </a>
    </section>
  );
}

function StatusLegend() {
  const t = useT();
  const sessions = useBoard((s) => s.sessions);
  const counts = new Map<StatusCode, number>();
  for (const s of sessions) {
    if (s.archived) continue;
    const code = statusCode(s);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return (
    <div className="legend-groups">
      {LEGEND_GROUPS.map((group) => (
        <div key={group.key} className={`legend-group g-${group.key}`}>
          <h4>{t(`views.legend.${group.key}`)}</h4>
          <ul className="legend legend-codes">
            {group.codes.map((code) => {
              const n = counts.get(code) ?? 0;
              const label = t(codeLabelKey(code));
              return (
                <li key={code} data-testid={`legend-${code}`}>
                  <CodeChip code={code} glyph={LEGEND_GLYPH[code]} label={label} badge />
                  <span className="legend-label">{label}</span>
                  {n > 0 && (
                    <span className="legend-n num" title={t('views.legend.count', { n })}>
                      {n}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** 只有展開時才掛上，所以收合就會退訂 watchResources（CONTRACTS.md §6.2）。 */
function SidebarBody() {
  const t = useT();
  const { backend, machines } = useBoard();
  const [samples, setSamples] = useState<Record<string, ResourceSample>>({});

  useEffect(
    () =>
      backend.watchResources((sample) =>
        setSamples((prev) => ({ ...prev, [sample.machineId]: sample })),
      ),
    [backend],
  );

  return (
    <>
      <section>
        <h3>{t('views.side.machines')}</h3>
        {machines.length === 0 && <p className="hint">{t('views.side.noMachines')}</p>}
        {machines.map((m) => (
          <Rig key={m.id} machine={m} sample={samples[m.id]} />
        ))}
      </section>
      <UsageSection />
      <section>
        <h3>{t('views.side.legend')}</h3>
        <StatusLegend />
        <h3 className="legend-next">{t('views.side.hands')}</h3>
        <ul className="legend hands-legend">
          {HANDS_ORDER.map((line) => (
            <li key={line}>
              <span className={`hands-sample h-${line}`} aria-hidden="true" />
              {t(`views.hands.${line}`)}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function Sidebar() {
  const t = useT();
  const { sideOpen, setSideOpen } = useViewsUi();
  return (
    <>
      <button
        className={`icon sm side-toggle${sideOpen ? ' is-open' : ''}`}
        aria-expanded={sideOpen}
        aria-label={t(sideOpen ? 'views.side.toggleClose' : 'views.side.toggleOpen')}
        title={t(sideOpen ? 'views.side.toggleClose' : 'views.side.toggleOpen')}
        onClick={() => setSideOpen(!sideOpen)}
        data-testid="side-toggle"
      >
        {sideOpen ? '‹' : '›'}
      </button>
      {sideOpen && (
        <aside className="side" data-testid="sidebar">
          <SidebarBody />
        </aside>
      )}
    </>
  );
}
