import { useEffect, useState } from 'react';
import type { Machine, ResourceSample, SessionStatus } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { STATUS_VISUAL, type HandsLine } from '../shared/status';
import { useBoard } from '../shared/store';
import { Meter, useClock } from './session';
import { useViewsUi } from './uiStore';

const LEGEND_ORDER: SessionStatus[] = [
  'waiting_permission',
  'waiting_input',
  'plan_review',
  'error',
  'stuck',
  'running',
  'starting',
  'queued',
  'rate_limited',
  'done',
  'offline',
];

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

/** 只有展開時才掛上，所以收合就會退訂 watchResources（CONTRACTS.md §6.2）。 */
function SidebarBody() {
  const t = useT();
  const { backend, machines, sessions } = useBoard();
  const [samples, setSamples] = useState<Record<string, ResourceSample>>({});
  const limited = sessions.filter((s) => !s.archived && s.status === 'rate_limited').length;

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
      <section>
        <h3>{t('views.side.quota')}</h3>
        {limited > 0 && (
          <p className="hint l-quota">{t('views.side.quotaLimited', { n: limited })}</p>
        )}
        <p className="hint">{t('views.side.quotaNone')}</p>
      </section>
      <section>
        <h3>{t('views.side.legend')}</h3>
        <ul className="legend">
          {LEGEND_ORDER.map((status) => {
            const v = STATUS_VISUAL[status];
            return (
              <li key={status} className={`l-${v.holder}`}>
                <b aria-hidden="true">{v.glyph}</b>
                {t(v.labelKey)}
              </li>
            );
          })}
        </ul>
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
        className={`side-toggle${sideOpen ? ' is-open' : ''}`}
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
