import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { useT } from '../shared/i18n';

export type HandoffEdgeType = Edge<{ labelKeys: string[]; enabled: boolean }, 'handoff'>;

/** 線是流程，不是狀態：不上色（STYLE.md §5）。 */
export function HandoffEdge(props: EdgeProps<HandoffEdgeType>) {
  const t = useT();
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        className={`edge-handoff${props.selected ? ' selected' : ''}`}
      />
      <EdgeLabelRenderer>
        <div
          className="edge-label"
          data-enabled={props.data?.enabled}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(calc(1 / var(--z, 1)))`,
          }}
        >
          <span data-testid={`handoff-${props.source}-${props.target}`}>
            {(props.data?.labelKeys ?? []).map((key) => t(key)).join('、')}
          </span>
          {!props.data?.enabled && <span className="edge-off">{t('canvas.handoff.off')}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
