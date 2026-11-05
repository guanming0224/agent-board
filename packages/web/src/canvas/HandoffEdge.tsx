import { useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useHandoffActivity } from './handoffActivity';
import { firstLine, type HandoffActivity } from './handoffActivityState';

export type HandoffEdgeType = Edge<
  {
    labelKeys: string[];
    enabled: boolean;
    /** 沒有規則線的兩張卡之間交接時，暫時畫的線（只在動畫期間）。 */
    temporary?: boolean;
    /** 交接紀錄的 key；規則線的 id 本身就是 key。 */
    activityKey?: string;
  },
  'handoff'
>;

const clock = (receivedAt: number, locale: string) =>
  new Date(receivedAt).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** 「來源 → 目標：摘要第一行 · 時間」；擋下或取消時寫原因。 */
function useTalkLine(activity: HandoffActivity | undefined): string | null {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const fromName = useBoard((s) => s.sessions.find((x) => x.id === activity?.from)?.name);
  const toName = useBoard((s) => s.sessions.find((x) => x.id === activity?.to)?.name);
  if (!activity) return null;
  let text: string;
  if (activity.kind === 'fired') {
    text = firstLine(activity.summary) ?? t('canvas.talk.noSummary');
  } else {
    const key = `canvas.talk.${activity.kind}.${activity.reason ?? ''}`;
    const reason = t(key);
    // 沒翻譯的新原因：照 hub 給的代碼顯示，不吞掉。
    text = reason === key ? (activity.reason ?? activity.kind) : reason;
  }
  return t('canvas.talk.line', {
    from: fromName ?? t('canvas.talk.gone'),
    to: toName ?? t('canvas.talk.gone'),
    // 摘要來自 agent 的回覆，可能含金鑰。
    text: mask(text),
    time: clock(activity.receivedAt, locale),
  });
}

/**
 * 線是流程，不是狀態：平常不上色（STYLE.md §5）。
 * 交接的那幾秒例外：成功是 agent 藍、沿著線往目標流；擋下或取消閃琥珀（要你看一下）。動畫全在 CSS。
 */
export function HandoffEdge(props: EdgeProps<HandoffEdgeType>) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const key = props.data?.activityKey ?? props.id;
  const activity = useHandoffActivity((s) => s.activities.get(key));
  const line = useTalkLine(activity);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const [path, labelX, labelY] = getBezierPath(props);
  const temporary = props.data?.temporary === true;
  const talk = activity ? ` talk-${activity.kind} talk-${activity.phase}` : '';
  const showTip = line !== null && (hover || focused || props.selected === true);
  const tipId = `handoff-tip-${props.id}`;

  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          className={`edge-handoff${props.selected ? ' selected' : ''}${temporary ? ' temporary' : ''}${talk}`}
        />
        {/* key 用 seq：同一條線連續交接時重播動畫。 */}
        {activity?.phase === 'active' && (
          <path
            key={activity.seq}
            d={path}
            className={activity.kind === 'fired' ? 'edge-talk-flow' : 'edge-talk-flash'}
            data-testid={`handoff-anim-${activity.from}-${activity.to}`}
          />
        )}
      </g>
      <EdgeLabelRenderer>
        <div
          className="edge-label nodrag nopan"
          data-enabled={props.data?.enabled}
          data-talk={activity?.kind}
          data-phase={activity?.phase}
          data-testid={`handoff-label-${props.source}-${props.target}`}
          tabIndex={activity ? 0 : undefined}
          aria-describedby={showTip ? tipId : undefined}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(calc(1 / var(--z, 1)))`,
          }}
        >
          {temporary ? (
            <span>{t('canvas.talk.temp')}</span>
          ) : (
            <>
              <span data-testid={`handoff-${props.source}-${props.target}`}>
                {(props.data?.labelKeys ?? []).map((k) => t(k)).join('、')}
              </span>
              {!props.data?.enabled && <span className="edge-off">{t('canvas.handoff.off')}</span>}
            </>
          )}
          {activity && (
            <span className="edge-talk-at">
              {t(`canvas.talk.${activity.kind}`, { time: clock(activity.receivedAt, locale) })}
            </span>
          )}
          {showTip && (
            <span role="tooltip" id={tipId} className="edge-tip" data-testid="handoff-tip">
              {line}
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
