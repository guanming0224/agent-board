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
import { codeClass, statusCode } from '../shared/status';
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
import { HandoffEdge, type LinkEdgeType } from './HandoffEdge';
import { useHandoffActivity, useHandoffEvents, useLinkFilters } from './handoffActivity';
import { activityKey, type Channel } from './handoffActivityState';
import { buildLinks, COUNT_MS, trafficHosts } from './interactions';
import { placeLabels, textWidth } from './labelPlacement';
import { LinkPanel } from './LinkPanel';
import { useLinkPick } from './linkPick';
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
import './links.css';
import './messages';

const nodeTypes = { session: SessionNode };
const edgeTypes = { handoff: HandoffEdge };

/** 「全部顯示」不跨過 xterm 門檻，總覽一定是摘要條。 */
const FIT_OPTIONS = { padding: 0.06, maxZoom: TERMINAL_ZOOM - 0.05, minZoom: 0.05 };
const SAVE_DEBOUNCE_MS = 400;
/** 拖線把手在卡片上緣往下 28px（canvas.css .ab-handle）：線從這裡出發。 */
const HANDLE_Y = 28;
/** 線上標籤的大概大小（螢幕 px）：規則線寫觸發條件（textWidth 估），其他線只有次數徽章。 */
const LABEL_BADGE_W = 28;
const LABEL_H = 22;
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
  // 標籤避開卡片要用螢幕上的大小換算；縮放取到 0.05，拖曳縮放時不每格重算。
  const zoom = useStore((s) => Math.round(s.transform[2] * 20) / 20);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
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
        const badge = traffic.has(key) && hosts.get(key) === l.id ? LABEL_BADGE_W : 0;
        const rule = l.handoff
          ? textWidth(
              l.handoff.triggers.map((x) => t(`canvas.handoff.${x}`)).join('、') +
                (l.handoff.enabled ? '' : t('canvas.handoff.off')),
            )
          : 0;
        const wide = Math.max(rule + badge, LABEL_BADGE_W);
        return [
          {
            id: l.id,
            source: { x: from.x + from.w, y: from.y + HANDLE_Y + l.offset },
            target: { x: to.x, y: to.y + HANDLE_Y + l.offset },
            w: wide / z,
            h: LABEL_H / z,
          },
        ];
      }),
      [...rects.values()],
      6 / z,
    );
    return links.map((link): LinkEdgeType => ({
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
        label: spots.get(link.id),
      },
      // 隊長 → 成員是編制，不是流程：不畫箭頭。
      markerEnd:
        link.kind === 'team' ? undefined : { type: MarkerType.ArrowClosed, color: 'var(--muted)' },
    }));
  }, [handoffs, members, liveIds, selectedEdges, trafficSig, dispatchSig, filters, rects, zoom, t]);

  // Esc 關掉點線打開的小視窗（取消選取線）。
  useEffect(() => {
    if (selectedEdges.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isTyping(e.target)) return;
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
      onConnect({ source, target, sourceHandle: null, targetHandle: null });
    },
    [onConnect],
  );
  useEffect(() => {
    if (!pickFrom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
        nodes={cards}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => flag('connecting', true)}
        onConnectEnd={() => flag('connecting', false)}
        onMoveStart={() => flag('moving', true)}
        onMoveEnd={() => flag('moving', false)}
        onNodeClick={(_, node) => {
          if (useLinkPick.getState().from) pickTarget(node.id);
        }}
        isValidConnection={(c) => c.source !== c.target}
        onPaneClick={() => {
          clearFocus();
          setQuick(null);
          cancelPick();
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
        <LinkPanel />
        <TidyPanel tidy={tidy} empty={sessions.length === 0} />
        <TidyToast tidy={tidy} />
        <ArchiveSelection ids={selectedIds} />
        <ArchiveToast />
        {pickFrom && (
          <Panel position="top-center" className="pick-hint" data-testid="link-pick">
            <span role="status">{t('canvas.pick.hint')}</span>
            <button
              type="button"
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
