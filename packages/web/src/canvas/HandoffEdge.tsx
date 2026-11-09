import { useMemo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useStoreApi, type Edge, type EdgeProps } from '@xyflow/react';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useHandoffActivity, useLinkFilters } from './handoffActivity';
import {
  activityKey,
  describeTalk,
  firstLine,
  isSent,
  roundLabel,
  type HandoffActivity,
} from './handoffActivityState';
import {
  enabledChannels,
  pairCount,
  pairHistory,
  type Interaction,
  type LinkKind,
} from './interactions';
import type { Route } from './edgeRoute';
import { edgeCurve, type LabelSpot } from './labelPlacement';

export type LinkEdgeType = Edge<
  {
    kind: LinkKind;
    /** 交接規則線：觸發條件的翻譯 key 與是否開著。 */
    labelKeys: string[];
    enabled: boolean;
    /** 同方向好幾條線時垂直錯開（畫布座標 px）。 */
    offset: number;
    /** 這條線負責畫 source → target 的往來動畫與次數（同方向只有一條線負責）。 */
    host: boolean;
    /** 標籤在線上的位置（CanvasPage 統一算，避開卡片與其他標籤）；沒有就放中點。 */
    label?: LabelSpot;
    /** 線的走法（edgeRoute.ts，CanvasPage 統一算，走卡片之間的空隙）；沒有就用把手位置畫曲線。 */
    route?: Pick<Route, 'd' | 'at'>;
  },
  'handoff'
>;
/** 舊名：交接規則線也是同一種線。 */
export type HandoffEdgeType = LinkEdgeType;

/** 線上的摘要很短；完整的第一行在說明框與小視窗裡。 */
const LABEL_CHARS = 28;

const clock = (at: number, locale: string) =>
  new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });

const useName = (id: string | undefined) =>
  useBoard((s) => (id ? s.sessions.find((x) => x.id === id)?.name : undefined));

/** 「來源 → 目標：摘要第一行 · 時間」；擋下或取消時寫原因。 */
function useTalkLine(activity: HandoffActivity | undefined): string | null {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  // 沒有交接紀錄時不掃 session 清單（每條線都會跑這個 selector）。
  const fromName = useName(activity?.from);
  const toName = useName(activity?.to);
  if (!activity) return null;
  return t('canvas.talk.line', {
    from: fromName ?? t('canvas.talk.gone'),
    to: toName ?? t('canvas.talk.gone'),
    // 摘要來自 agent 的回覆，可能含金鑰：describeTalk 先遮蔽再截斷。
    text: describeTalk(activity, t, mask),
    time: clock(activity.receivedAt, locale),
  });
}

/** 點線後的小視窗：兩個方向最近幾則往來（時間、做了什麼、結果、摘要）。 */
function PairPopover({
  source,
  target,
  onClose,
}: {
  source: string;
  target: string;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const filters = useLinkFilters((s) => s.filters);
  const history = useHandoffActivity((s) => s.history);
  const rows = useMemo(
    () => pairHistory(history, source, target, enabledChannels(filters)),
    [history, source, target, filters],
  );
  const sourceName = useName(source) ?? t('canvas.talk.gone');
  const targetName = useName(target) ?? t('canvas.talk.gone');
  const nameOf = (id: string) => (id === source ? sourceName : targetName);
  const id = `pair-${source}-${target}`;
  const line = (i: Interaction) => {
    const text = i.summary === null ? null : firstLine(mask(i.summary), 80);
    if (i.state === 'blocked' || i.state === 'dropped') {
      const key = `canvas.talk.${i.state}.${i.reason ?? ''}`;
      const reason = t(key, { max: '?' });
      return mask(reason === key ? (i.reason ?? '') : reason) || text;
    }
    return text;
  };
  return (
    <div
      className="pair-pop nodrag nopan nowheel"
      role="dialog"
      aria-labelledby={`${id}-title`}
      data-testid={`pair-popover-${source}-${target}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // 告訴 App 這個 Esc 已經用掉了，不要再關右側面板（Esc 只關最上層）。
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="pair-pop-head">
        <b id={`${id}-title`}>{t('canvas.link.pop.title', { a: sourceName, b: targetName })}</b>
        <button
          type="button"
          className="close pair-pop-close"
          aria-label={t('canvas.link.pop.close')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="sub">{t('canvas.link.pop.empty')}</p>
      ) : (
        <ol>
          {rows.map((i) => (
            <li key={i.id} data-state={i.state} data-testid="pair-row">
              <span className="num">{clock(i.at, locale)}</span>
              <span className="pair-dir">
                {nameOf(i.from)} → {nameOf(i.to)}
              </span>
              <span className="pair-what">
                {t(i.what)}・{t(`canvas.link.state.${i.state}`)}
              </span>
              {line(i) && <span className="pair-sum">{line(i)}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="sub">{t('canvas.link.pop.note')}</p>
    </div>
  );
}

/**
 * 線是流程，不是狀態：平常不上色（STYLE.md §5）。線型分種類：交接規則虛線、派工實線、隊長 → 成員點線、
 * 最近往來的暫時線細點線。往來的那幾秒例外：排入、送達、判定是 agent 藍、沿著線往目標流（送達時目標卡亮一圈）；
 * 擋下或取消閃琥珀（要你看一下）。動畫全在 CSS。
 */
export function HandoffEdge(props: EdgeProps<LinkEdgeType>) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const store = useStoreApi();
  const kind = props.data?.kind ?? 'handoff';
  const host = props.data?.host !== false;
  const key = activityKey(props.source, props.target);
  const filters = useLinkFilters((s) => s.filters);
  const raw = useHandoffActivity((s) => (host ? s.activities.get(key) : undefined));
  // 關掉的類別不播、不寫。
  const activity = raw && filters[raw.channel] ? raw : undefined;
  const count = useHandoffActivity((s) =>
    host ? pairCount(s.history, key, enabledChannels(filters), s.clock) : 0,
  );
  const line = useTalkLine(activity);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const offset = props.data?.offset ?? 0;
  const curve =
    props.data?.route ??
    edgeCurve(
      { x: props.sourceX, y: props.sourceY + offset },
      { x: props.targetX, y: props.targetY + offset },
    );
  const path = curve.d;
  const spot = props.data?.label ?? { t: 0.5, dx: 0, dy: 0 };
  const mid = curve.at(spot.t);
  const labelX = mid.x + spot.dx;
  const labelY = mid.y + spot.dy;
  // 完整標籤（做了什麼、結果、時間、摘要）只在播放中與播完幾秒內出現；之後收成次數徽章，
  // 滑過線或徽章、用鍵盤聚焦、點開紀錄時再展開。
  const expanded =
    activity !== undefined &&
    (activity.phase !== 'recent' || hover || focused || props.selected === true);
  const talk = activity ? ` talk-${activity.kind} talk-${activity.phase}` : '';
  const recent = kind === 'traffic' && !activity ? ' quiet' : '';
  // 點線打開紀錄時，說明框的內容已經在紀錄裡，不重複疊一層。
  const showTip = line !== null && (hover || focused) && props.selected !== true;
  const tipId = `handoff-tip-${props.id}`;
  const select = () => store.getState().addSelectedEdges([props.id]);
  const close = () => {
    const edge = store.getState().edgeLookup.get(props.id);
    if (edge) store.getState().unselectNodesAndEdges({ edges: [edge] });
  };
  const shortSum =
    activity && isSent(activity.kind) && activity.summary
      ? firstLine(mask(activity.summary), LABEL_CHARS)
      : null;
  // 規則線、暫時線用舊的 testid（其他測試依賴）；派工、隊長線另外取名，同方向不會撞名。
  const labelId =
    kind === 'handoff' || kind === 'traffic'
      ? `handoff-label-${props.source}-${props.target}`
      : `link-label-${kind}-${props.source}-${props.target}`;

  let base: React.ReactNode = null;
  if (kind === 'handoff') {
    base = (
      <>
        <span data-testid={`handoff-${props.source}-${props.target}`}>
          {(props.data?.labelKeys ?? []).map((k) => t(k)).join('、')}
        </span>
        {!props.data?.enabled && <span className="edge-off">{t('canvas.handoff.off')}</span>}
      </>
    );
  } else if (kind === 'traffic' && expanded) {
    base = (
      <span>
        {activity && activity.channel !== 'handoff' ? t(activity.what) : t('canvas.talk.temp')}
      </span>
    );
  }
  const limit = activity?.reason === 'round_limit';
  const hasLabel = base !== null || expanded || count > 0 || limit || props.selected === true;

  return (
    <>
      <g
        className={`link link-${kind}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <BaseEdge
          id={props.id}
          path={path}
          markerEnd={props.markerEnd}
          interactionWidth={16}
          className={`edge-handoff edge-${kind}${props.selected ? ' selected' : ''}${kind === 'traffic' ? ' temporary' : ''}${recent}${talk}`}
        />
        {/* key 用 seq：同一條線連續往來時重播動畫。 */}
        {activity?.phase === 'active' && (
          <path
            key={activity.seq}
            d={path}
            className={isSent(activity.kind) ? 'edge-talk-flow' : 'edge-talk-flash'}
            data-kind={activity.kind}
            data-channel={activity.channel}
            data-testid={`handoff-anim-${activity.from}-${activity.to}`}
          />
        )}
      </g>
      <EdgeLabelRenderer>
        {hasLabel && (
          <div
            className={`edge-label nodrag nopan label-${kind}`}
            data-enabled={props.data?.enabled}
            data-talk={activity?.kind}
            data-phase={activity?.phase}
            data-channel={activity?.channel}
            data-selected={props.selected === true || undefined}
            data-expanded={expanded || undefined}
            data-testid={labelId}
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
            {base}
            {expanded && activity && kind !== 'handoff' && kind !== 'traffic' && (
              <span className="edge-talk-what">{t(activity.what)}</span>
            )}
            {expanded && activity && (
              <span className="edge-talk-at">
                {t(`canvas.talk.${activity.kind}`, { time: clock(activity.receivedAt, locale) })}
              </span>
            )}
            {expanded && shortSum && (
              <span
                className="edge-talk-sum"
                data-testid={`talk-sum-${activity.from}-${activity.to}`}
              >
                {shortSum}
              </span>
            )}
            {expanded && activity && roundLabel(activity, t) && (
              <span
                className="edge-talk-round"
                data-testid={`handoff-round-${activity.from}-${activity.to}`}
              >
                {roundLabel(activity, t)}
              </span>
            )}
            {count > 0 && (
              <button
                type="button"
                className="edge-count num"
                data-testid={`pair-count-${props.source}-${props.target}`}
                aria-label={t('canvas.link.count', { n: count })}
                title={t('canvas.link.count', { n: count })}
                onClick={select}
              >
                {count}
              </button>
            )}
            {activity?.reason === 'round_limit' && (
              <span
                className="edge-talk-limit"
                role="status"
                data-testid={`handoff-limit-${activity.from}-${activity.to}`}
              >
                {t('canvas.talk.limitLabel', { max: activity.maxRounds ?? '?' })}
              </span>
            )}
            {showTip && (
              <span
                role="tooltip"
                id={tipId}
                className="edge-tip"
                data-testid={`handoff-tip-${props.source}-${props.target}`}
              >
                {line}
              </span>
            )}
            {props.selected && (
              <PairPopover source={props.source} target={props.target} onClose={close} />
            )}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
