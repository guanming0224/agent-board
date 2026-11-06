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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Layout, Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';
import { QuickCreate } from '../flows';
import { CostChip } from '../team/common';
import { refreshTeams, useTeams, useTeamSync } from '../team/store';
import {
  EmptyState,
  ErrorState,
  errorText,
  LoadingState,
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
import { HandoffEdge, type HandoffEdgeType } from './HandoffEdge';
import { useHandoffActivity, useHandoffEvents } from './handoffActivity';
import { motion } from './motion';
import {
  CARD_H,
  CARD_W,
  fitCardZoom,
  layoutRows,
  loadLayouts,
  loadPreviousLayouts,
  reconcileRects,
  saveLayouts,
  type Rect,
} from './layout';
import { TidyPanel, TidyToast, useTidy, type TidyState } from './tidy';
import { SessionNode, TERMINAL_ZOOM, type SessionNodeType } from './SessionNode';
import { TeamFrames } from './TeamFrames';
import { groupHandoffs, teamForHandoff } from './teams';
import './canvas.css';
import './messages';

const nodeTypes = { session: SessionNode };
const edgeTypes = { handoff: HandoffEdge };

/** 「全部顯示」不跨過 xterm 門檻，總覽一定是摘要條。 */
const FIT_OPTIONS = { padding: 0.06, maxZoom: TERMINAL_ZOOM - 0.05, minZoom: 0.05 };
const SAVE_DEBOUNCE_MS = 400;
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
        aria-label={t('canvas.zoom.out')}
        title={t('canvas.zoom.out')}
        onClick={() => void zoomOut({ duration: 0 })}
      >
        −
      </button>
      <span className="num" data-testid="zoom-level">
        {Math.round(zoom * 100)}%
      </span>
      <button
        aria-label={t('canvas.zoom.in')}
        title={t('canvas.zoom.in')}
        onClick={() => void zoomIn({ duration: 0 })}
      >
        +
      </button>
      <button onClick={() => void fitView({ ...FIT_OPTIONS, duration: motion() })}>
        {t('canvas.zoom.fit')}
      </button>
      {/* 縮小時要不要換成摘要條（GM 2026-11-06）；只記在這台瀏覽器。 */}
      <button
        type="button"
        className="summary-toggle"
        aria-pressed={summary}
        title={t('canvas.summaryMode.hint')}
        onClick={() => setSummary(!summary)}
      >
        {t(summary ? 'canvas.summaryMode.on' : 'canvas.summaryMode.off')}
      </button>
    </Panel>
  );
}

/** 外框、標籤要維持螢幕上的粗細與字級，CSS 用 --z 反向換算。 */
function ZoomVariable({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
  const zoom = useStore((s) => s.transform[2]);
  useEffect(() => {
    host.current?.style.setProperty('--z', String(zoom));
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
  // 正在播放的交接（from->to）。字串比較：只有這個集合變了才重算線。
  const activeTalks = useHandoffActivity((s) =>
    [...s.activities.values()]
      .filter((a) => a.phase === 'active')
      .map((a) => a.key)
      .join('|'),
  );
  const teamLoadError = useTeams((s) => s.detail);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const clearFocus = useViewsUi((s) => s.clearFocus);
  const focusId = useViewsUi((s) => s.focusId);
  const pendingFocus = useViewsUi((s) => s.pendingFocus);
  const flow = useReactFlow();
  const initialized = useNodesInitialized();
  const host = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 從全尺寸終端機回來：一開始就放在離開時的鏡頭，不先全部顯示再跳。
  const [returnViewport] = useState(() => useViewsUi.getState().canvasReturn);

  const [cards, setCards] = useState<SessionNodeType[]>(() =>
    [...reconcileRects(sessions, new Map(), layouts)].map(([id, r]) => toNode(id, r)),
  );
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
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
      const current =
        rects ??
        new Map(cardsRef.current.map((n) => [n.id, target?.get(n.id) ?? rectOf(n)] as const));
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
        ...(ids ? { nodes: ids.map((id) => ({ id })) } : {}),
        duration: motion(),
      }),
    [flow],
  );
  const tidy = useTidy({
    sessions,
    cardsRef,
    setCards,
    tidyState,
    saveNow,
    rectOf,
    fit: fitAfterTidy,
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

  const rects = useMemo(() => new Map(cards.map((n) => [n.id, rectOf(n)])), [cards]);

  // ── 封存：選取卡片後 Delete／Backspace 開確認；框選（Shift＋拖曳）多張時出現按鈕 ──
  const selectedIds = useMemo(() => cards.filter((n) => n.selected).map((n) => n.id), [cards]);
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

  const liveIds = useMemo(() => new Set(cards.map((n) => n.id)), [cards]);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const edges = useMemo<Edge[]>(() => {
    const drawn: HandoffEdgeType[] = handoffs
      .filter((h) => liveIds.has(h.source) && liveIds.has(h.target))
      .map((h) => ({
        id: h.id,
        type: 'handoff',
        source: h.source,
        target: h.target,
        selected: selectedEdges.has(h.id),
        data: {
          labelKeys: h.triggers.map((trigger) => `canvas.handoff.${trigger}`),
          enabled: h.enabled,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted)' },
      }));
    // 兩張卡之間沒有畫出的規則線（例如規則已刪），交接當下仍暫時畫一條，播完就收掉。
    const drawnIds = new Set(drawn.map((e) => e.id));
    const temporary: HandoffEdgeType[] = (activeTalks ? activeTalks.split('|') : [])
      .filter((key) => !drawnIds.has(key))
      .flatMap((key) => {
        const activity = useHandoffActivity.getState().activities.get(key);
        if (!activity || !liveIds.has(activity.from) || !liveIds.has(activity.to)) return [];
        return [
          {
            id: `talk:${key}`,
            type: 'handoff' as const,
            source: activity.from,
            target: activity.to,
            selectable: false,
            deletable: false,
            focusable: false,
            data: { labelKeys: [], enabled: true, temporary: true, activityKey: key },
            markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted)' },
          },
        ];
      });
    return [...drawn, ...temporary];
  }, [handoffs, liveIds, selectedEdges, activeTalks]);

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

  // 初次顯示與「下一個等我的」都要等節點量好尺寸。有目標就直接去，不先全部顯示再跳一次。
  const fitted = useRef(false);
  useEffect(() => {
    if (!initialized) return;
    const target = useViewsUi.getState().takePendingFocus();
    if (target) {
      const node = cardsRef.current.find((n) => n.id === target);
      if (node) {
        const r = rectOf(node);
        const box = host.current?.getBoundingClientRect();
        const fit = box ? fitCardZoom(r, box.width, box.height) : 0.5;
        // 放大不超過一張卡能完整看見的程度，已經比這更大就維持目前縮放。
        const zoom = Math.max(flow.getZoom(), Math.min(0.5, fit));
        void flow.setCenter(r.x + r.w / 2, r.y + r.h / 2, { zoom, duration: motion() });
      }
    } else if (!fitted.current && !returnViewport) {
      void flow.fitView({ ...FIT_OPTIONS, duration: 0 });
    }
    fitted.current = true;
    useViewsUi.getState().setCanvasReturn(null);
  }, [initialized, pendingFocus, flow, returnViewport]);

  const minimapColor = (node: Node) => {
    const status = useBoard.getState().sessions.find((s) => s.id === node.id)?.status;
    return status ? `var(--${STATUS_VISUAL[status].holder})` : 'var(--idle)';
  };

  return (
    <div
      ref={host}
      className="canvas"
      role="region"
      aria-label={t('canvas.aria')}
      data-focus={focusId ?? undefined}
    >
      <ReactFlow
        nodes={cards}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(c) => c.source !== c.target}
        onPaneClick={() => {
          clearFocus();
          setQuick(null);
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
        <TidyPanel tidy={tidy} empty={sessions.length === 0} />
        <TidyToast tidy={tidy} />
        <ArchiveSelection ids={selectedIds} />
        <ArchiveToast />
        {selectedHandoff && (
          <Panel position="top-center" className="edge-panel" data-testid="handoff-panel">
            <button
              aria-pressed={selectedHandoff.enabled}
              onClick={() => toggleHandoff(selectedHandoff.id)}
            >
              {selectedHandoff.enabled ? t('canvas.handoff.turnOff') : t('canvas.handoff.turnOn')}
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
  useTeamSync();
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
  } else if (board.status === 'loading' || layouts.status === 'loading') {
    body = <LoadingState />;
  } else {
    body = (
      <ReactFlowProvider>
        <Flow sessions={sessions} layouts={layouts.layouts} previous={layouts.previous} />
      </ReactFlowProvider>
    );
  }

  return <PageShell tab="canvas">{body}</PageShell>;
}
