import { useState } from 'react';
import { Panel } from '@xyflow/react';
import { useT } from '../shared/i18n';
import { useLinkFilters } from './handoffActivity';
import { FILTER_KEYS } from './interactions';

/** 圖例裡的線型樣本（和 canvas.css 的線同一套樣式）。 */
function Sample({ kind }: { kind: string }) {
  return (
    <svg className={`link-sample s-${kind}`} width="34" height="10" aria-hidden="true">
      <line x1="1" y1="5" x2="33" y2="5" />
    </svg>
  );
}

const LEGEND = ['handoff', 'dispatch', 'team', 'traffic', 'flow', 'flash'] as const;

/**
 * 畫布左上的「線」：四個開關（交接／派工／任務／關係線，每台瀏覽器自己記）＋線型圖例。
 * 寬螢幕開關一直看得到，按「線」打開圖例；手機收成一顆按鈕，按了才出現開關和圖例，不擋卡片。
 */
export function LinkPanel() {
  const t = useT();
  const filters = useLinkFilters((s) => s.filters);
  const toggle = useLinkFilters((s) => s.toggle);
  const [open, setOpen] = useState(false);
  const on = FILTER_KEYS.filter((k) => filters[k]).length;
  return (
    <Panel
      position="top-left"
      className={`link-panel${open ? ' open' : ''}`}
      data-testid="link-panel"
    >
      <div className="link-row">
        <button
          type="button"
          className="link-panel-toggle"
          aria-expanded={open}
          aria-controls="link-legend"
          title={t('canvas.link.legend')}
          onClick={() => setOpen((v) => !v)}
        >
          {t('canvas.link.panel', { on, all: FILTER_KEYS.length })}
          <span aria-hidden="true">{open ? ' ▴' : ' ▾'}</span>
        </button>
        <div role="group" aria-label={t('canvas.link.filters')} className="link-filters">
          {FILTER_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="link-filter"
              aria-pressed={filters[key]}
              data-testid={`link-filter-${key}`}
              title={t(`canvas.link.filter.${key}.hint`)}
              onClick={() => toggle(key)}
            >
              <span aria-hidden="true">{filters[key] ? '✓' : '○'}</span>
              {t(`canvas.link.filter.${key}`)}
            </button>
          ))}
        </div>
      </div>
      {open && (
        <ul id="link-legend" className="link-legend" aria-label={t('canvas.link.legend')}>
          {LEGEND.map((kind) => (
            <li key={kind}>
              <Sample kind={kind} />
              {t(`canvas.link.legend.${kind}`)}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
