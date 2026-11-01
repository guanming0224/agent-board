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
import {
  EmptyState,
  ErrorState,
  errorText,
  LoadingState,
  PageShell,
  useBoardLoad,
  useViewsUi,
} from '../views';
import { HandoffEdge } from './HandoffEdge';
import { motion } from './motion';
import {
  fitCardZoom,
  loadLayouts,
  reconcileRects,
  saveLayouts,
  WORKSPACE,
  type Rect,
} from './layout';
import { SessionNode, TERMINAL_ZOOM, type SessionNodeType } from './SessionNode';
import { TeamFrames } from './TeamFrames';
import { useTeams } from './teams';
import './canvas.css';
import './messages';

const nodeTypes = { session: SessionNode };
const edgeTypes = { handoff: HandoffEdge };

/** 「全部顯示」不跨過 xterm 門檻，總覽一定是摘要條。 */
const FIT_OPTIONS = { padding: 0.06, maxZoom: TERMINAL_ZOOM - 0.05, minZoom: 0.05 };
const SAVE_DEBOUNCE_MS = 400;

const toNode = (id: string, rect: Rect): SessionNodeType => ({
  id,
  type: 'session',
  position: { x: rect.x, y: rect.y },
  width: rect.w,
  height: rect.h,
  data: { sessionId: id },
  deletable: false,
});

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

function Flow({ sessions, layouts }: { sessions: Session[]; layouts: Layout[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const { handoffs, addHandoff, removeHandoffs } = useTeams();
  const clearFocus = useViewsUi((s) => s.clearFocus);
  const focusId = useViewsUi((s) => s.focusId);
  const pendingFocus = useViewsUi((s) => s.pendingFocus);
  const flow = useReactFlow();
  const initialized = useNodesInitialized();
  const host = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [cards, setCards] = useState<SessionNodeType[]>(() =>
    [...reconcileRects(sessions, new Map(), layouts)].map(([id, r]) => toNode(id, r)),
  );
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const sessionKey = sessions.map((s) => s.id).join('|');
  useEffect(() => {
    setCards((prev) => {
      const current = new Map(prev.map((n) => [n.id, rectOf(n)]));
      const kept = new Map(prev.map((n) => [n.id, n]));
      return [...reconcileRects(sessions, current, layouts)].map(
        ([id, r]) => kept.get(id) ?? toNode(id, r),
      );
    });
    // sessions 只有 id 集合變動才需要重排。
  }, [sessionKey, layouts]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSave = useCallback(() => {
    saveTimer.current = null;
    const next: Layout[] = cardsRef.current.map((n) => ({
      workspace: WORKSPACE,
      sessionId: n.id,
      ...rectOf(n),
    }));
    saveLayouts(backend, next).then(
      () => setSaveError(null),
      (e: unknown) => setSaveError(errorText(e)),
    );
  }, [backend]);

  useEffect(
    () => () => {
      if (saveTimer.current === null) return;
      clearTimeout(saveTimer.current);
      flushSave();
    },
    [flushSave],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setCards((prev) => applyNodeChanges(changes, prev as Node[]) as SessionNodeType[]);
      if (changes.some((c) => c.type === 'position' && !c.dragging)) {
        if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
      }
    },
    [flushSave],
  );

  const rects = useMemo(() => new Map(cards.map((n) => [n.id, rectOf(n)])), [cards]);

  const liveIds = useMemo(() => new Set(cards.map((n) => n.id)), [cards]);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const edges = useMemo<Edge[]>(
    () =>
      handoffs
        .filter((h) => liveIds.has(h.source) && liveIds.has(h.target))
        .map((h) => ({
          id: h.id,
          type: 'handoff',
          source: h.source,
          target: h.target,
          selected: selectedEdges.has(h.id),
          data: { labelKey: `canvas.handoff.${h.trigger}` },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted)' },
        })),
    [handoffs, liveIds, selectedEdges],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
      if (removed.length > 0) removeHandoffs(removed);
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
    [removeHandoffs],
  );

  const onConnect = useCallback((c: Connection) => addHandoff(c.source, c.target), [addHandoff]);

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
    } else if (!fitted.current) {
      void flow.fitView({ ...FIT_OPTIONS, duration: 0 });
    }
    fitted.current = true;
  }, [initialized, pendingFocus, flow]);

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
        onPaneClick={clearFocus}
        colorMode="dark"
        minZoom={0.05}
        maxZoom={2}
        zoomOnDoubleClick={false}
        attributionPosition="bottom-left"
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <ZoomVariable host={host} />
        <TeamFrames rects={rects} />
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
        {saveError && (
          <Panel position="top-center" className="save-error">
            <div className="alert" role="alert">
              <span aria-hidden="true">✕</span>
              <div>{t('canvas.saveFailed', { detail: saveError })}</div>
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

function useLayouts() {
  const backend = useBoard((s) => s.backend);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; layouts: Layout[] }
    | { status: 'error'; detail: string }
  >({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    loadLayouts(backend).then(
      (layouts) => alive && setState({ status: 'ready', layouts }),
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
  } else if (sessions.length === 0) {
    body = (
      <EmptyState
        text={t('canvas.empty')}
        action={
          <button className="primary" onClick={() => (location.hash = '#/new')}>
            {t('views.newSession')}
          </button>
        }
      />
    );
  } else {
    body = (
      <ReactFlowProvider>
        <Flow sessions={sessions} layouts={layouts.layouts} />
      </ReactFlowProvider>
    );
  }

  return <PageShell tab="canvas">{body}</PageShell>;
}
