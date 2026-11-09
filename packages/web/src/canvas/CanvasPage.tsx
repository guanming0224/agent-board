import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { zoneMoveShift, type Layout, type Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { codeClass, statusCode } from '../shared/status';
import { useBoard } from '../shared/store';
import { QuickCreate } from '../flows';
import { CostChip } from '../team/common';
import { PresetsButton } from '../team/PresetPicker';
import { refreshTeams, useTeams, useTeamSync } from '../team/store';
import {
  EmptyState,
  ErrorState,
  errorText,
  LoadingState,
  CommandBar,
  PageShell,
  useBoardLoad,
  useViewsUi,
} from '../views';
import {
  ArchiveConfirm,
  ArchiveSelection,
  ArchiveToast,
  requestArchive,
  useArchiveUi,
} from './archive';
import { EDGE_LABEL_BADGE_W, EDGE_LABEL_H, EDGE_LABEL_MARGIN, TIDY_FIT_MIN_ZOOM } from './arrange';
import { HandoffEdge, type LinkEdgeType } from './HandoffEdge';
import { useHandoffActivity, useHandoffEvents, useLinkFilters } from './handoffActivity';
import { activityKey, type Channel } from './handoffActivityState';
import { buildLinks, COUNT_MS, trafficHosts } from './interactions';
import { placeLabels, textWidth, type LabelSpot } from './labelPlacement';
import { anchor, routeEdge, type Route } from './edgeRoute';
import { LinkPanel } from './LinkPanel';
import { useLinkPick } from './linkPick';
import { motion } from './motion';
import {
  CARD_H,
  CARD_W,
  COMPACT_ZOOM,
  fitCardZoom,
  layoutRows,
  loadLayouts,
  loadPreviousLayouts,
  reconcileRects,
  saveLayouts,
  zoomPercent,
  type Rect,
} from './layout';
import { TidyPanel, TidyToast, useTidy, type TidyState } from './tidy';
import { SessionNode, TERMINAL_ZOOM, type SessionNodeType } from './SessionNode';
import { TeamFrames } from './TeamFrames';
import { CanvasProgress } from '../progress/CanvasProgress';
import { canvasTeams, groupHandoffs, teamForHandoff, teamRect } from './teams';
import { teamHash } from '../views/overlay';
import { useCurrentZoneId, useSessionZones, useZoneUi } from '../zones';
import './canvas.css';
import './links.css';
import './messages';

const nodeTypes = { session: SessionNode };
const edgeTypes = { handoff: HandoffEdge };

/** 「全部顯示」不跨過 xterm 門檻，總覽一定是摘要條。 */
/**
 * 全部顯示：左右留 6%；上面讓開左上「線」與右上「整理畫布」那一列（top 8＋精簡鈕 32＋8），
 * 下面讓開底部指令列（離底 16＋高 42＋6），卡片的標題列與輸入框才不會被浮動工具蓋住。
 */
const FIT_OPTIONS = {
  padding: { x: 0.06, top: '56px', bottom: '64px' },
  maxZoom: TERMINAL_ZOOM - 0.05,
  minZoom: 0.05,
} as const;
const SAVE_DEBOUNCE_MS = 400;
/** 平移、縮放停下來多久才把團隊框的模糊放回去（連續滾輪縮放時不反覆切換）。 */
const MOVE_SETTLE_MS = 120;
const DELETE_KEYS = ['Backspace', 'Delete'];
/** 快速建立小卡的寬度（flows.css .quick-create）＋邊距，用來把小卡留在畫面裡。 */
const QUICK_W = 392;
const QUICK_MIN_ROOM = 240;

/** 雙擊到這些東西上不算「空白處」。 */
const NOT_BLANK =
  '.react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__minimap, .react-flow__controls, .quick-create';

interface QuickSpot {
  /** 小卡在畫布容器裡的位置（px）。 */
  left: number;
  top: number;
  /** 新卡片左上角在畫布座標的位置。 */
  at: { x: number; y: number };
}

const toNode = (id: string, rect: Rect): SessionNodeType => ({
  id,
  type: 'session',
  position: { x: rect.x, y: rect.y },
  width: rect.w,
  height: rect.h,
  data: { sessionId: id },
  deletable: false,
});

/** 正在打字或在對話框裡：Delete／Backspace 是編輯文字，不是封存。xterm 的輸入也是 textarea。 */
const isTyping = (target: EventTarget | null) =>
  target instanceof Element &&
  (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null ||
    target.closest('.term-slot') !== null);

const rectOf = (node: Node): Rect => ({
  x: node.position.x,
  y: node.position.y,
  w: node.width ?? 0,
  h: node.height ?? 0,
});

function ZoomPanel() {
  const t = useT();
  const zoom = useStore((s) => s.transform[2]);
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const summary = useViewsUi((s) => s.summaryWhenZoomedOut);
  const setSummary = useViewsUi((s) => s.setSummaryWhenZoomedOut);
  return (
    <Panel
      position="bottom-right"
      className="zoom"
      role="group"
      aria-label={t('canvas.zoom.controls')}
    >
      <button
        className="icon sm"
        aria-label={t('canvas.zoom.out')}
        title={t('canvas.zoom.out')}
        onClick={() => void zoomOut({ duration: 0 })}
      >
        −
      </button>
      <span className="num" data-testid="zoom-level">
        {zoomPercent(zoom)}%
      </span>
      <button
        className="icon sm"
        aria-label={t('canvas.zoom.in')}
        title={t('canvas.zoom.in')}
        onClick={() => void zoomIn({ duration: 0 })}
      >
        +
      </button>
      <button className="sm" onClick={() => void fitView({ ...FIT_OPTIONS, duration: motion() })}>
        {t('canvas.zoom.fit')}
      </button>
      {/* 縮小時要不要換成摘要條（GM 2026-11-06）；只記在這台瀏覽器。 */}
      <button
        type="button"
        className="sm summary-toggle"
        aria-pressed={summary}
        title={t('canvas.summaryMode.hint')}
        onClick={() => setSummary(!summary)}
      >
        {t(summary ? 'canvas.summaryMode.on' : 'canvas.summaryMode.off')}
      </button>
    </Panel>
  );
}

/**
 * 外框、標籤要維持螢幕上的粗細與字級，CSS 用 --z 反向換算。
 * 同時標出「縮得很小」（data-compact）：只動 .canvas 一個屬性，不必讓每張卡重新 render。
 */
function ZoomVariable({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
  const zoom = useStore((s) => s.transform[2]);
  useEffect(() => {
    host.current?.style.setProperty('--z', String(zoom));
    host.current?.toggleAttribute('data-compact', zoom < COMPACT_ZOOM);
  }, [host, zoom]);
  return null;
}

function Flow({
  sessions,
  layouts,
  previous,
}: {
  sessions: Session[];
  layouts: Layout[];
  /** 「上一次擺設」（一鍵整理前的位置）。 */
  previous: Layout[];
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const rules = useTeams((s) => s.rules);
  const handoffs = useMemo(() => groupHandoffs(rules), [rules]);
  useHandoffEvents(backend);
  const filters = useLinkFilters((s) => s.filters);
  // 最近有往來（10 分鐘內）或正在播動畫的一對與用到的類別。字串比較：只有這個集合變了才重算線。
  const trafficSig = useHandoffActivity((s) => {
    const out = new Map<string, Set<Channel>>();
    const add = (key: string, channel: Channel) =>
      out.set(key, (out.get(key) ?? new Set()).add(channel));
    for (const [key, list] of s.history) {
      for (const i of list) if (s.clock - i.updatedAt < COUNT_MS) add(key, i.channel);
    }
    for (const a of s.activities.values()) if (a.phase === 'active') add(a.key, a.channel);
    return [...out]
      .map(([key, channels]) => `${key}=${[...channels].sort().join(',')}`)
      .sort()
      .join('|');
  });
  const members = useTeams((s) => s.members);
  const teamLoadError = useTeams((s) => s.detail);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const clearFocus = useViewsUi((s) => s.clearFocus);
  const focusId = useViewsUi((s) => s.focusId);
  const pendingFocus = useViewsUi((s) => s.pendingFocus);
  const pendingTeamFocus = useViewsUi((s) => s.pendingTeamFocus);
  const flow = useReactFlow();
  const initialized = useNodesInitialized();
  const host = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 從全尺寸終端機回來：一開始就放在離開時的鏡頭，不先全部顯示再跳。
  const [returnViewport] = useState(() => useViewsUi.getState().canvasReturn);

  // cards 是全部（沒封存的）session 的卡，畫布只畫目前工作區的（P2 §2.3）。座標共用同一個版面組，
  // 存檔一律送全部，別的工作區的位置才不會被 PUT 洗掉。
  const [cards, setCards] = useState<SessionNodeType[]>(() =>
    [...reconcileRects(sessions, new Map(), layouts)].map(([id, r]) => toNode(id, r)),
  );
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const currentZone = useCurrentZoneId();
  const zoneOf = useSessionZones();
  const teamsReady = useTeams((s) => s.status === 'ready');
  const visibleIds = useMemo(
    () => new Set(sessions.filter((s) => zoneOf(s) === currentZone).map((s) => s.id)),
    [sessions, zoneOf, currentZone],
  );
  const visibleSessions = useMemo(
    () => sessions.filter((s) => visibleIds.has(s.id)),
    [sessions, visibleIds],
  );
  const nodes = useMemo(() => cards.filter((n) => visibleIds.has(n.id)), [cards, visibleIds]);
  const visibleCardsRef = useRef(nodes);
  visibleCardsRef.current = nodes;
  /** 從畫布雙擊建立的 session：等它出現在清單裡就放到雙擊的位置。 */
  const placeAt = useRef(new Map<string, Rect>());

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 「上一次擺設」與整理動畫的目標位置：存檔時用，動畫中途存才不會存到半路的位置。 */
  const tidyState = useRef<TidyState>({
    previous:
      previous.length > 0
        ? new Map(previous.map((l) => [l.sessionId, { x: l.x, y: l.y, w: l.w, h: l.h }]))
        : null,
    target: null,
  });
  /** 立刻存：目前位置（rects 沒給就用畫面上的）＋上一次擺設，一次送出。 */
  const saveNow = useCallback(
    (rects?: ReadonlyMap<string, Rect>) => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const { previous: snap, target } = tidyState.current;
      // 一律存全部的卡：rects 只有一部分（例如只整理了目前工作區）時，蓋在目前位置上。
      const current = new Map(
        cardsRef.current.map((n) => [n.id, target?.get(n.id) ?? rectOf(n)] as const),
      );
      for (const [id, rect] of rects ?? []) current.set(id, rect);
      // 快照裡被刪掉（不是封存）的 session，hub 存不進去（外鍵），整批會失敗：只送還在的。
      const known = new Set(useBoard.getState().sessions.map((s) => s.id));
      const snapRows = snap ? [...snap].filter(([id]) => known.has(id)) : null;
      saveLayouts(backend, layoutRows(current, snapRows)).then(
        () => setSaveError(null),
        (e: unknown) => setSaveError(errorText(e)),
      );
    },
    [backend],
  );
  const flushSave = useCallback(() => saveNow(), [saveNow]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  const sessionKey = sessions.map((s) => s.id).join('|');
  useEffect(() => {
    // 先取出來：updater 會晚一點才執行，那時 placeAt 已經清掉了。
    const placed = new Map<string, Rect>();
    for (const s of sessions) {
      const rect = placeAt.current.get(s.id);
      if (rect) placed.set(s.id, rect);
    }
    for (const id of placed.keys()) placeAt.current.delete(id);
    setCards((prev) => {
      const current = new Map(prev.map((n) => [n.id, rectOf(n)]));
      for (const [id, rect] of placed) current.set(id, rect);
      const kept = new Map(prev.map((n) => [n.id, n]));
      return [...reconcileRects(sessions, current, layouts)].map(([id, r]) => {
        const node = kept.get(id);
        return placed.has(id) || !node ? toNode(id, r) : node;
      });
    });
    if (placed.size > 0) scheduleSave();
    // sessions 只有 id 集合變動才需要重排。
  }, [sessionKey, layouts]);

  useEffect(
    () => () => {
      if (saveTimer.current === null) return;
      clearTimeout(saveTimer.current);
      flushSave();
    },
    [flushSave],
  );

  const fitAfterTidy = useCallback(
    (ids: string[] | null) =>
      void flow.fitView({
        ...FIT_OPTIONS,
        // 整理畫布後全部顯示：縮放不低於 TIDY_FIT_MIN_ZOOM，團隊之間在畫面上至少 48px（P2 §4.2）；
        // 放不下的部分留給捲動（例如手機寬度）。
        ...(ids ? { nodes: ids.map((id) => ({ id })) } : { minZoom: TIDY_FIT_MIN_ZOOM }),
        duration: motion(),
      }),
    [flow],
  );
  const tidyView = useCallback(() => {
    const box = host.current?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? { w: box.width, h: box.height } : null;
  }, []);
  // 「一鍵整理」只整理目前工作區（P2 §2.3）。
  const tidy = useTidy({
    sessions: visibleSessions,
    cardsRef: visibleCardsRef,
    setCards,
    tidyState,
    saveNow,
    rectOf,
    fit: fitAfterTidy,
    viewSize: tidyView,
  });
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // 拖了卡就不能再「復原」上一次整理（上一次擺設還在，工具列可以換回去）。
      if (changes.some((c) => c.type === 'position' && c.dragging)) tidy.dragged();
      setCards((prev) => applyNodeChanges(changes, prev as Node[]) as SessionNodeType[]);
      if (changes.some((c) => c.type === 'position' && !c.dragging)) scheduleSave();
    },
    [scheduleSave, tidy],
  );

  // ── 快速建立：雙擊空白處，或頁首／空畫布的「新增 session」（畫面中央） ──
  const [quick, setQuick] = useState<QuickSpot | null>(null);
  const openQuickAt = useCallback(
    (clientX: number, clientY: number) => {
      const box = host.current?.getBoundingClientRect();
      if (!box) return;
      const x = clientX - box.left;
      const y = clientY - box.top;
      setQuick({
        left: Math.max(12, Math.min(x, box.width - QUICK_W)),
        top: Math.max(12, Math.min(y, box.height - QUICK_MIN_ROOM)),
        at: flow.screenToFlowPosition({ x: clientX, y: clientY }),
      });
    },
    [flow],
  );
  const openQuickCentered = useCallback(() => {
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    const center = flow.screenToFlowPosition({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    });
    setQuick({
      left: Math.max(12, (box.width - QUICK_W) / 2),
      top: Math.max(12, box.height / 2 - QUICK_MIN_ROOM),
      // 卡片中心放在畫面中央。
      at: { x: center.x - CARD_W / 2, y: center.y - CARD_H / 2 },
    });
  }, [flow]);
  useEffect(() => {
    useViewsUi.getState().setOpenQuickCreate(openQuickCentered);
    return () => useViewsUi.getState().setOpenQuickCreate(null);
  }, [openQuickCentered]);
  const closeQuick = useCallback(() => setQuick(null), []);
  const onQuickCreated = useCallback(
    (session: Session) => {
      if (!quick) return;
      const rect = { ...quick.at, w: CARD_W, h: CARD_H };
      setQuick(null);
      // 還沒出現在清單裡：等 sessions 更新時由上面的 effect 放到這裡。
      placeAt.current.set(session.id, rect);
      // 廣播可能比回應先到，卡片已經（或即將）排進空位：用 updater 才看得到排隊中的更新，搬到雙擊的位置。
      setCards((prev) => {
        if (!prev.some((n) => n.id === session.id)) return prev;
        placeAt.current.delete(session.id);
        return prev.map((n) => (n.id === session.id ? toNode(session.id, rect) : n));
      });
      scheduleSave();
    },
    [quick, scheduleSave],
  );
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('.react-flow__pane') || target.closest(NOT_BLANK)) return;
      openQuickAt(e.clientX, e.clientY);
    },
    [openQuickAt],
  );

  // 畫面上的卡（目前工作區）：團隊框、線、標籤都只看這些。
  const rects = useMemo(() => new Map(nodes.map((n) => [n.id, rectOf(n)])), [nodes]);

  // ── 封存：選取卡片後 Delete／Backspace 開確認；框選（Shift＋拖曳）多張時出現按鈕 ──
  const selectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);
  const selectedKey = selectedIds.join('|');
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.defaultPrevented || isTyping(e.target) || useArchiveUi.getState().confirm) return;
      e.preventDefault();
      requestArchive(selectedIds, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // selectedKey 代表 selectedIds 的內容。
  }, [selectedKey]);

  const liveIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  // 標籤避開卡片要用螢幕上的大小換算；縮放取到 0.05，拖曳縮放時不每格重算。
  const zoom = useStore((s) => Math.round(s.transform[2] * 20) / 20);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  /**
   * 拖曳中的卡（null＝沒在拖）。拖曳時每一格都會改 nodes，全部線重算路線和標籤太慢（審查 tidy-edges #1）：
   * 拖曳中只有連到被拖的卡的線畫簡單曲線，其他線沿用拖之前算好的路線與標籤；放開後整張重算。
   */
  const [draggingIds, setDraggingIds] = useState<ReadonlySet<string> | null>(null);
  const routed = useRef<{
    routes: ReadonlyMap<string, Route>;
    spots: ReadonlyMap<string, LabelSpot>;
  } | null>(null);
  // 派工的關係只看 dispatchedBy：其他欄位（狀態、最後幾行）變了不重算線。
  const dispatchSig = sessions.map((s) => `${s.id}<${s.dispatchedBy ?? ''}`).join('|');
  const edges = useMemo<Edge[]>(() => {
    const traffic = new Map(
      (trafficSig ? trafficSig.split('|') : []).flatMap((entry) => {
        const [key = '', list = ''] = entry.split('=');
        const at = key.indexOf('->');
        if (at < 0) return [];
        const pair = {
          from: key.slice(0, at),
          to: key.slice(at + 2),
          channels: new Set(list.split(',') as Channel[]),
        };
        return [[key, pair] as const];
      }),
    );
    const links = buildLinks({
      sessions: dispatchSig
        ? dispatchSig.split('|').map((x) => {
            const [id = '', by = ''] = x.split('<');
            return { id, dispatchedBy: by || null };
          })
        : [],
      handoffs,
      members,
      live: liveIds,
      filters,
      traffic,
    });
    const hosts = trafficHosts(links);
    const toEdge = (
      link: (typeof links)[number],
      route: Route | undefined,
      label: LabelSpot | undefined,
    ): LinkEdgeType => ({
      id: link.id,
      type: 'handoff',
      source: link.source,
      target: link.target,
      selected: selectedEdges.has(link.id),
      // 只有交接規則線能刪（刪的是規則）；其他線是算出來的。
      deletable: link.kind === 'handoff',
      data: {
        kind: link.kind,
        labelKeys: link.handoff?.triggers.map((trigger) => `canvas.handoff.${trigger}`) ?? [],
        enabled: link.handoff?.enabled ?? true,
        offset: link.offset,
        host: hosts.get(activityKey(link.source, link.target)) === link.id,
        label,
        route,
      },
      // 隊長 → 成員是編制，不是流程：不畫箭頭。
      markerEnd:
        link.kind === 'team' ? undefined : { type: MarkerType.ArrowClosed, color: 'var(--muted)' },
    });
    const prev = routed.current;
    if (draggingIds && prev) {
      return links.map((link) =>
        draggingIds.has(link.source) || draggingIds.has(link.target)
          ? toEdge(link, undefined, undefined)
          : toEdge(link, prev.routes.get(link.id), prev.spots.get(link.id)),
      );
    }
    // 每條線走卡片之間的空隙，不從卡片底下穿過（GM 2026-11-09：整理後關係線被壓住看不到）。
    const cards = [...rects.values()];
    const routes = new Map<string, Route>();
    for (const l of links) {
      const from = rects.get(l.source);
      const to = rects.get(l.target);
      if (from && to) routes.set(l.id, routeEdge(from, to, cards, l.offset));
    }
    // 標籤位置：規則線（一直有字）先放，再放有往來的線的次數徽章；都避開卡片與彼此。
    const z = zoom || 1;
    const labeled = links
      .filter(
        (l) =>
          l.kind === 'handoff' ||
          (traffic.has(activityKey(l.source, l.target)) &&
            hosts.get(activityKey(l.source, l.target)) === l.id),
      )
      .sort((a, b) => Number(b.kind === 'handoff') - Number(a.kind === 'handoff'));
    const spots = placeLabels(
      labeled.flatMap((l) => {
        const from = rects.get(l.source);
        const to = rects.get(l.target);
        if (!from || !to) return [];
        const key = activityKey(l.source, l.target);
        const badge = traffic.has(key) && hosts.get(key) === l.id ? EDGE_LABEL_BADGE_W : 0;
        const rule = l.handoff
          ? textWidth(
              l.handoff.triggers.map((x) => t(`canvas.handoff.${x}`)).join('、') +
                (l.handoff.enabled ? '' : t('canvas.handoff.off')),
            )
          : 0;
        const wide = Math.max(rule + badge, EDGE_LABEL_BADGE_W);
        return [
          {
            id: l.id,
            source: anchor(from, 'right', l.offset),
            target: anchor(to, 'left', l.offset),
            route: routes.get(l.id),
            w: wide / z,
            h: EDGE_LABEL_H / z,
          },
        ];
      }),
      cards,
      EDGE_LABEL_MARGIN / z,
    );
    routed.current = { routes, spots };
    return links.map((link) => toEdge(link, routes.get(link.id), spots.get(link.id)));
  }, [
    handoffs,
    members,
    liveIds,
    selectedEdges,
    trafficSig,
    dispatchSig,
    filters,
    rects,
    zoom,
    t,
    draggingIds,
  ]);

  // Esc 關掉點線打開的小視窗（取消選取線）。
  useEffect(() => {
    if (selectedEdges.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTyping(e.target)) return;
      e.preventDefault();
      setSelectedEdges(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdges]);

  const changeHandoffs = useCallback(
    (change: () => Promise<unknown>) => {
      setHandoffError(null);
      change()
        .then(() => refreshTeams(backend))
        .catch((e: unknown) =>
          setHandoffError(t('canvas.handoff.failed', { detail: errorText(e) })),
        );
    },
    [backend, t],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])));
      const ruleIds = handoffs.filter((h) => removed.has(h.id)).flatMap((h) => h.ruleIds);
      if (ruleIds.length > 0) {
        changeHandoffs(() => Promise.all(ruleIds.map((id) => backend.deleteHandoffRule(id))));
      }
      setSelectedEdges((prev) => {
        const next = new Set(prev);
        for (const c of changes) {
          if (c.type !== 'select') continue;
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        }
        return next;
      });
    },
    [backend, changeHandoffs, handoffs],
  );

  const onConnect = useCallback(
    ({ source, target }: Connection) => {
      if (handoffs.some((h) => h.source === source && h.target === target)) return;
      const { members } = useTeams.getState();
      const teamId = teamForHandoff(source, target, members);
      if (!teamId) {
        setHandoffError(t('canvas.handoff.noTeam'));
        return;
      }
      // 先關著：開啟才會花額度，要使用者自己按（STYLE.md 規則三之二）。
      changeHandoffs(() =>
        backend.createHandoffRule(teamId, {
          fromSessionId: source,
          trigger: 'on_done',
          action: { toSessionId: target },
          enabled: false,
        }),
      );
    },
    [backend, changeHandoffs, handoffs, t],
  );

  // ── 「建立交接線…」選目標模式（P2 §4.2）：點另一張卡＝和拖線一樣建立規則；點空白、Esc、✕ 取消 ──
  const pickFrom = useLinkPick((s) => s.from);
  const cancelPick = useLinkPick((s) => s.cancel);
  const pickTarget = useCallback(
    (target: string) => {
      const source = useLinkPick.getState().from;
      // 點到出發的那張卡不算選好，繼續等。
      if (!source || source === target) return;
      useLinkPick.getState().cancel();
      // 選單是明確的「建立」：已經有同方向的交接線就說一聲，不要什麼都沒發生。
      if (handoffs.some((h) => h.source === source && h.target === target)) {
        setHandoffError(t('canvas.handoff.exists'));
        return;
      }
      onConnect({ source, target, sourceHandle: null, targetHandle: null });
    },
    [handoffs, onConnect, t],
  );
  useEffect(() => {
    if (!pickFrom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 焦點在終端機或輸入框：Esc 交給它（終端機裡是中斷 Claude），不取消。
        if (isTyping(e.target)) return;
        // 這次 Esc 只用來取消選目標，不再關掉別的東西（交接線小視窗、聚焦…）。
        e.stopPropagation();
        cancelPick();
        return;
      }
      // 鍵盤：Tab 到目標卡（xyflow 節點可取得焦點）按 Enter／空白鍵。
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = e.target instanceof Element ? e.target : null;
      const id = el?.classList.contains('react-flow__node') ? el.getAttribute('data-id') : null;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      pickTarget(id);
    };
    // 捕獲階段：先於 xyflow 節點自己的 Enter（選取）。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickFrom, cancelPick, pickTarget]);
  // 離開畫布就不再停在選目標模式。
  useEffect(() => () => useLinkPick.getState().cancel(), []);

  // 拖線中所有卡的目標把手都要看得到；平移、縮放中暫時拿掉團隊框的毛玻璃（效能退路）。
  // 直接改 DOM 屬性（canvas.css 讀），不為了這個重畫整張畫布。
  const flag = useCallback((name: 'connecting' | 'moving', on: boolean) => {
    const el = host.current;
    if (!el) return;
    if (on) el.dataset[name] = 'true';
    else delete el.dataset[name];
  }, []);

  // 拖線：出發的卡標 data-connect-source，它自己的目標把手不顯示（不能連到自己）。
  const connectStart = useCallback(
    (nodeId: string | null) => {
      flag('connecting', true);
      if (!nodeId) return;
      const node = host.current?.querySelector(
        `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
      );
      if (node instanceof HTMLElement) node.dataset.connectSource = 'true';
    },
    [flag],
  );
  const connectEnd = useCallback(() => {
    flag('connecting', false);
    for (const el of host.current?.querySelectorAll<HTMLElement>('[data-connect-source]') ?? []) {
      delete el.dataset.connectSource;
    }
  }, [flag]);

  // 平移、縮放：mousedown 就會收到 start（xyflow），畫面真的動了才拿掉模糊，
  // 只在空白處點一下不會讓團隊框閃一下。停下來 MOVE_SETTLE_MS 後才放回模糊，連續滾輪不會反覆切換。
  const moveFrom = useRef<Viewport | null>(null);
  const moveTimer = useRef<number | null>(null);
  const clearMoveTimer = () => {
    if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    moveTimer.current = null;
  };
  const moveStart = useCallback((vp: Viewport) => {
    moveFrom.current = vp;
  }, []);
  const moving = useCallback(
    (vp: Viewport) => {
      const from = moveFrom.current;
      if (from && from.x === vp.x && from.y === vp.y && from.zoom === vp.zoom) return;
      clearMoveTimer();
      if (!host.current?.dataset.moving) flag('moving', true);
    },
    [flag],
  );
  const moveEnd = useCallback(() => {
    moveFrom.current = null;
    clearMoveTimer();
    if (!host.current?.dataset.moving) return;
    moveTimer.current = window.setTimeout(() => {
      moveTimer.current = null;
      flag('moving', false);
    }, MOVE_SETTLE_MS);
  }, [flag]);
  useEffect(() => clearMoveTimer, []);

  const selectedHandoff =
    selectedEdges.size === 1 ? handoffs.find((h) => selectedEdges.has(h.id)) : undefined;
  const toggleHandoff = (id: string) => {
    const line = handoffs.find((h) => h.id === id);
    if (!line) return;
    changeHandoffs(() =>
      Promise.all(
        line.ruleIds.map((ruleId) => backend.updateHandoffRule(ruleId, { enabled: !line.enabled })),
      ),
    );
  };

  // ── 工作區（P2 §2.3） ──
  // 切換：記下離開的工作區畫面位置；到新的工作區還原它上次的位置，沒有就全部顯示。
  // 有聚焦目標（跨工作區的「下一個」、在畫布上看、#/team/<id>）時交給下面的聚焦，不先 fit 再跳。
  const shownZone = useRef(currentZone);
  useEffect(() => {
    if (shownZone.current === currentZone) return;
    useZoneUi.getState().saveViewport(shownZone.current, flow.getViewport());
    shownZone.current = currentZone;
    const ui = useViewsUi.getState();
    if (ui.pendingFocus || ui.pendingTeamFocus) return;
    const saved = useZoneUi.getState().viewports[currentZone];
    const frame = requestAnimationFrame(() => {
      if (saved) void flow.setViewport(saved, { duration: 0 });
      else void flow.fitView({ ...FIT_OPTIONS, duration: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentZone, flow]);

  // 團隊或 session 換了工作區：排到目標工作區現有內容的右側空白處（座標共用，不能疊在別人上面）。
  // 每台開著畫布的裝置都會在自己的版面上排一次（版面每個使用者各自存）。
  const zoneMap = useMemo(
    () => (teamsReady ? new Map(sessions.map((s) => [s.id, zoneOf(s)] as const)) : null),
    [sessions, zoneOf, teamsReady],
  );
  const lastZones = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const before = lastZones.current;
    lastZones.current = zoneMap;
    if (!before || !zoneMap) return;
    const movedTo = new Map<string, string[]>();
    for (const [id, zone] of zoneMap) {
      const was = before.get(id);
      if (was !== undefined && was !== zone) movedTo.set(zone, [...(movedTo.get(zone) ?? []), id]);
    }
    if (movedTo.size === 0) return;
    setCards((prev) => {
      let next = prev;
      for (const [zone, ids] of movedTo) {
        const moving = new Set(ids);
        const group = next.filter((n) => moving.has(n.id)).map(rectOf);
        const others = next
          .filter((n) => !moving.has(n.id) && zoneMap.get(n.id) === zone)
          .map(rectOf);
        // 和 hub 排存好的版面用同一個規則（團隊框外緣再加 240 畫布 px，同整理畫布時團隊之間）。
        const shift = zoneMoveShift(group, others);
        if (!shift) continue;
        const { dx, dy } = shift;
        next = next.map((n) =>
          moving.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
        );
      }
      return next;
    });
    scheduleSave();
  }, [zoneMap, scheduleSave]);

  /** 點畫布空白處：落在團隊框裡（沒有拖動）就開那個團隊的面板（P2 §1.2、§4.2 驗收 6）。 */
  const openFrameAt = useCallback(
    (clientX: number, clientY: number) => {
      const point = flow.screenToFlowPosition({ x: clientX, y: clientY });
      const { teams, members } = useTeams.getState();
      const hit = canvasTeams(teams, members)
        .map((team) => ({ team, rect: teamRect(team, rects) }))
        .filter(
          ({ rect }) =>
            rect !== null &&
            point.x >= rect.x &&
            point.x <= rect.x + rect.w &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.h,
        )
        // 框疊在一起時取最小的（最裡面的）那個。
        .sort((a, b) => a.rect!.w * a.rect!.h - b.rect!.w * b.rect!.h)[0];
      if (hit) location.hash = teamHash(hit.team.id);
    },
    [flow, rects],
  );

  // 初次顯示與「下一個等我的」都要等節點量好尺寸。有目標就直接去，不先全部顯示再跳一次。
  // 目標在別的工作區：先切過去（P2 §2.3 跨工作區導航），切完這裡會再跑一次。
  const fitted = useRef(false);
  useEffect(() => {
    if (!initialized) return;
    const ui = useViewsUi.getState();
    const wanted = ui.pendingFocus ?? ui.pendingTeamFocus?.[0] ?? null;
    const wantedSession = wanted ? sessions.find((s) => s.id === wanted) : undefined;
    if (wantedSession && zoneOf(wantedSession) !== currentZone) {
      useZoneUi.getState().setCurrent(zoneOf(wantedSession));
      return;
    }
    const target = ui.takePendingFocus();
    const team = target ? null : ui.takePendingTeamFocus();
    // 右側面板蓋住的寬度：卡要放在看得到的那一塊中央（面板開著時「下一個」「在畫布上看」照常可用）。
    const inset = ui.rightInset;
    const box = host.current?.getBoundingClientRect();
    if (target) {
      const node = cardsRef.current.find((n) => n.id === target);
      if (node) {
        const r = rectOf(node);
        const fit = box ? fitCardZoom(r, Math.max(1, box.width - inset), box.height) : 0.5;
        // 放大不超過一張卡能完整看見的程度，已經比這更大就維持目前縮放。
        // 至少到 COMPACT_ZOOM：卡片很大時放大後仍在 30% 以下，按鈕會被藏起來（Q4）。
        const zoom = Math.max(flow.getZoom(), COMPACT_ZOOM, Math.min(0.5, fit));
        void flow.setCenter(r.x + r.w / 2 + inset / 2 / zoom, r.y + r.h / 2, {
          zoom,
          duration: motion(),
        });
      }
    } else if (team) {
      // 開團隊面板：把成員（團隊框）整個框進看得到的那一塊。
      const rects = cardsRef.current.filter((n) => team.includes(n.id)).map(rectOf);
      if (rects.length > 0 && box) {
        const x = Math.min(...rects.map((r) => r.x));
        const y = Math.min(...rects.map((r) => r.y));
        const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
        const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
        const usable = Math.max(1, box.width - inset);
        // 不低於 COMPACT_ZOOM：大團隊框不完整也沒關係，卡片上的按鈕要看得到（Q4，審查 canvas #8）。
        const zoom = Math.min(
          1,
          Math.max(COMPACT_ZOOM, Math.min((usable * 0.85) / w, (box.height * 0.85) / h)),
        );
        void flow.setCenter(x + w / 2 + inset / 2 / zoom, y + h / 2, {
          zoom,
          duration: motion(),
        });
      }
    } else if (!fitted.current && !returnViewport) {
      void flow.fitView({ ...FIT_OPTIONS, duration: 0 });
    }
    fitted.current = true;
    useViewsUi.getState().setCanvasReturn(null);
    // sessions、zoneOf 只用來判斷目標在不在這個工作區，不必因為它們變了就重跑。
  }, [initialized, pendingFocus, pendingTeamFocus, flow, returnViewport, currentZone]);

  const minimapColor = (node: Node) => {
    const session = useBoard.getState().sessions.find((s) => s.id === node.id);
    return session ? `var(--${codeClass(statusCode(session))})` : 'var(--idle)';
  };

  return (
    <div
      ref={host}
      className="canvas"
      role="region"
      aria-label={t('canvas.aria')}
      data-focus={focusId ?? undefined}
      data-picking={pickFrom ? 'true' : undefined}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_, node, dragged) =>
          setDraggingIds(new Set([node.id, ...dragged.map((n) => n.id)]))
        }
        onNodeDragStop={() => setDraggingIds(null)}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={(_, { nodeId }) => connectStart(nodeId)}
        onConnectEnd={connectEnd}
        onMoveStart={(_, vp) => moveStart(vp)}
        onMove={(_, vp) => moving(vp)}
        onMoveEnd={moveEnd}
        onNodeClick={(_, node) => {
          if (useLinkPick.getState().from) pickTarget(node.id);
        }}
        isValidConnection={(c) => c.source !== c.target}
        onPaneClick={(e) => {
          clearFocus();
          setQuick(null);
          // 選交接目標中：點空白只是取消，不開團隊面板。
          if (useLinkPick.getState().from) cancelPick();
          else openFrameAt(e.clientX, e.clientY);
        }}
        onDoubleClick={onDoubleClick}
        defaultViewport={returnViewport ?? undefined}
        colorMode="dark"
        minZoom={0.05}
        maxZoom={2}
        zoomOnDoubleClick={false}
        attributionPosition="bottom-left"
        // 有選取卡片時 Delete 鍵交給上面的封存；沒有時照舊刪除選取的交接線。卡片本身 deletable: false。
        deleteKeyCode={selectedIds.length > 0 ? null : DELETE_KEYS}
      >
        <ZoomVariable host={host} />
        <TeamFrames rects={rects} onTidy={tidy.tidyTeam} />
        <CanvasProgress rects={rects} />
        <Background
          variant={BackgroundVariant.Dots}
          color="var(--canvas-dot)"
          gap={22}
          size={1.2}
        />
        <MiniMap
          className="minimap"
          style={{ width: 140, height: 96 }}
          ariaLabel={t('canvas.minimap')}
          nodeColor={minimapColor}
          maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
          pannable
          zoomable
          position="bottom-right"
        />
        <ZoomPanel />
        <LinkPanel />
        <TidyPanel tidy={tidy} empty={sessions.length === 0} />
        {/* 畫面下方的提示疊在同一欄，讓開底部指令列與縮放列（canvas.css .toast-stack）。 */}
        <Panel position="bottom-center" className="toast-stack">
          <ArchiveToast />
          <TidyToast tidy={tidy} />
        </Panel>
        <ArchiveSelection ids={selectedIds} />
        {pickFrom && (
          <Panel position="top-center" className="pick-hint" data-testid="link-pick">
            <span role="status">{t('canvas.pick.hint')}</span>
            <button
              type="button"
              className="close"
              aria-label={t('canvas.pick.cancel')}
              title={t('canvas.pick.cancel')}
              onClick={cancelPick}
            >
              ✕
            </button>
          </Panel>
        )}
        {selectedHandoff && (
          <Panel position="top-center" className="edge-panel" data-testid="handoff-panel">
            <button
              className="sm"
              aria-pressed={selectedHandoff.enabled}
              onClick={() => toggleHandoff(selectedHandoff.id)}
            >
              {/* 開關寫「狀態」，和團隊面板同一套（按下樣式＝開著）。 */}
              {selectedHandoff.enabled ? t('team.rules.on') : t('team.rules.off')}
            </button>
            <CostChip />
            <span className="sub">{t('canvas.handoff.panelHint')}</span>
          </Panel>
        )}
        {(handoffError ?? teamLoadError) && (
          <Panel position="top-center" className="save-error">
            <div className="alert" role="alert">
              <span aria-hidden="true">✕</span>
              <div>{handoffError ?? t('canvas.error.teams', { detail: teamLoadError ?? '' })}</div>
            </div>
          </Panel>
        )}
        {sessions.length === 0 && !quick && (
          <Panel position="top-center" className="canvas-empty">
            <EmptyState
              text={t('canvas.empty')}
              action={
                <button className="primary" onClick={openQuickCentered}>
                  {t('views.newSession')}
                </button>
              }
            />
          </Panel>
        )}
        {saveError && (
          <Panel position="top-center" className="save-error">
            <div className="alert" role="alert">
              <span aria-hidden="true">✕</span>
              <div>{t('canvas.saveFailed', { detail: saveError })}</div>
            </div>
          </Panel>
        )}
      </ReactFlow>
      <ArchiveConfirm />
      {quick && (
        <QuickCreate
          left={quick.left}
          top={quick.top}
          onCreated={onQuickCreated}
          onClose={closeQuick}
        />
      )}
    </div>
  );
}

function useLayouts() {
  const backend = useBoard((s) => s.backend);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; layouts: Layout[]; previous: Layout[] }
    | { status: 'error'; detail: string }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    // 上一次擺設讀不到不算錯：只是沒有「回到上一次擺設」可按。
    Promise.all([loadLayouts(backend), loadPreviousLayouts(backend).catch(() => [])]).then(
      ([layouts, previous]) => alive && setState({ status: 'ready', layouts, previous }),
      (e: unknown) => alive && setState({ status: 'error', detail: errorText(e) }),
    );
    return () => {
      alive = false;
    };
  }, [backend, attempt]);

  return { state, retry: () => setAttempt((n) => n + 1) };
}

export function CanvasPage() {
  const t = useT();
  const board = useBoardLoad();
  const { state: layouts, retry } = useLayouts();
  const teamSync = useTeamSync();
  // 團隊還沒讀到時不知道誰屬於哪個工作區（成員跟著團隊）：先等，別的工作區的卡才不會先畫出來、訂閱終端機。
  // 第一次就讀失敗：顯示錯誤＋再試一次，不畫卡片（成員自己的 zoneId 被忽略，照它畫會畫錯工作區）。
  // 只等第一次讀到：之後重讀失敗（保留舊資料）或按「重試」不能把整張畫布卸載。
  const teamsSeen = useRef(false);
  const teamStatus = useTeams((s) => s.status);
  const teamDetail = useTeams((s) => s.detail);
  if (teamStatus === 'ready') teamsSeen.current = true;
  const teamsLoading = !teamsSeen.current && teamStatus === 'loading';
  const teamsFailed = !teamsSeen.current && teamStatus === 'error';
  const sessions = useBoard().sessions.filter((s) => !s.archived);

  let body;
  if (board.status === 'error') {
    body = (
      <ErrorState text={t('views.error.board', { detail: board.detail })} onRetry={board.retry} />
    );
  } else if (layouts.status === 'error') {
    body = (
      <ErrorState text={t('canvas.error.layout', { detail: layouts.detail })} onRetry={retry} />
    );
  } else if (teamsFailed) {
    body = (
      <ErrorState
        text={t('canvas.error.teamsFirst', { detail: teamDetail ?? '' })}
        onRetry={teamSync.retry}
      />
    );
  } else if (board.status === 'loading' || layouts.status === 'loading' || teamsLoading) {
    body = <LoadingState />;
  } else {
    body = (
      <ReactFlowProvider>
        <Flow sessions={sessions} layouts={layouts.layouts} previous={layouts.previous} />
      </ReactFlowProvider>
    );
  }

  return (
    <PageShell>
      {body}
      <CommandBar presets={<PresetsButton />} />
    </PageShell>
  );
}
