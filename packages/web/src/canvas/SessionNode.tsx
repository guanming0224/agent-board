import { useCallback, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  Handle,
  Position,
  useReactFlow,
  useStore,
  useStoreApi,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { Session } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';
import type { TerminalViewProps } from '../shared/terminal-contract';
import { TerminalView } from '../terminal';
import {
  Age,
  AutoContinueNote,
  Callsign,
  ContextUsage,
  dangerApproval,
  handsClass,
  Lamp,
  ModeChip,
  ReadOnlyChip,
  DispatchedByChip,
  useViewsUi,
} from '../views';
import { CardMenu, MenuButton, RenameInput } from './CardMenu';
import { CommandInput } from './CommandInput';
import { DoneHint } from './DoneHint';
import { useHandoffActivity } from './handoffActivity';
import { isReceiving } from './handoffActivityState';
import { fitCardZoom, STRIP_W } from './layout';
import { motion } from './motion';
import { terminalHash } from './terminalRoute';

export const TERMINAL_ZOOM = 0.9;
/** 低於這個倍率，展開的 xterm 字太小看不清。 */
const READABLE_ZOOM = 0.7;

export type SessionNodeType = Node<{ sessionId: string }, 'session'>;

/** 這些狀態沒有在跑的 PTY 可以收指令。 */
export const NO_INPUT: readonly Session['status'][] = ['offline', 'done', 'queued'];

function Actions({
  session,
  isTerminal,
  onOpenTerminal,
  inputRef,
}: {
  session: Session;
  isTerminal: boolean;
  onOpenTerminal: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const danger = useBoard((s) => dangerApproval(s.approvals, session.id));
  const [msg, setMsg] = useState('');
  const openReview = () => (location.hash = `#/review/${session.id}`);

  let body = null;
  if (danger || session.status === 'waiting_permission') {
    body = (
      <button className={danger ? 'danger' : 'primary'} onClick={openReview}>
        {t('canvas.act.decide')}
      </button>
    );
  } else if (session.status === 'plan_review') {
    body = (
      <button className="primary" onClick={openReview}>
        {t('canvas.act.plan')}
      </button>
    );
  } else if (session.status === 'waiting_input') {
    body = (
      <button className="primary" onClick={() => inputRef.current?.focus()}>
        {t('canvas.act.reply')}
      </button>
    );
  } else if (session.status === 'error' || session.status === 'stuck') {
    body = (
      <>
        {!isTerminal && <button onClick={onOpenTerminal}>{t('canvas.act.terminal')}</button>}
        <button
          disabled={!connected}
          onClick={() => {
            backend.terminal.send({
              type: 'terminal.signal',
              sessionId: session.id,
              signal: 'escape',
            });
            setMsg(t('canvas.act.escSent'));
          }}
        >
          {t('canvas.act.esc')}
        </button>
      </>
    );
  }
  if (!body) return null;
  return (
    <div className="acts nodrag">
      {body}
      {msg && (
        <span className="msg" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}

/** menu：畫布上的卡片才有「⋯」（重新命名、封存）；全尺寸頁沒有。 */
export function CardHead({ session, menu = false }: { session: Session; menu?: boolean }) {
  const t = useT();
  const danger = useBoard((s) => dangerApproval(s.approvals, session.id));
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  return (
    <>
      {danger && <div className="danger-tag">{t('canvas.danger')}</div>}
      <div className="head">
        <Lamp status={session.status} />
        {renaming ? (
          <RenameInput session={session} onDone={() => setRenaming(false)} />
        ) : (
          <span className="title">{session.name}</span>
        )}
        <Age session={session} />
        {menu && (
          <MenuButton session={session} open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} />
        )}
      </div>
      {menuOpen && (
        <CardMenu session={session} onRename={() => setRenaming(true)} onClose={closeMenu} />
      )}
      <div className="sign">
        <Callsign session={session} />
        <ModeChip mode={session.permissionMode} />
        <ReadOnlyChip session={session} />
        <DispatchedByChip session={session} />
        <AutoContinueNote session={session} />
      </div>
    </>
  );
}

type SizeOwner = Parameters<NonNullable<TerminalViewProps['onSizeOwnerChange']>>[0];

/** 尺寸由另一個畫面決定時，在 xterm 外框之外說明為什麼縮放、怎麼改回來。 */
export function useSizeNote() {
  const t = useT();
  const [owner, setOwner] = useState<SizeOwner>(null);
  const note =
    owner === 'other' ? (
      <p className="size-note" role="status" data-testid="size-note">
        {t('canvas.size.other')}
      </p>
    ) : null;
  return { note, onSizeOwnerChange: setOwner };
}

export const cardClass = (base: string, session: Session) =>
  [
    base,
    'hands-host',
    handsClass(session.permissionMode),
    STATUS_VISUAL[session.status].holder === 'you' ? 'you' : '',
    session.status === 'offline' ? 'gone' : '',
  ]
    .filter(Boolean)
    .join(' ');

export function SessionNode({
  data,
  width,
  height,
  positionAbsoluteX: x,
  positionAbsoluteY: y,
}: NodeProps<SessionNodeType>) {
  const t = useT();
  const mask = useMaskText();
  const { sessions, backend } = useBoard();
  const session = sessions.find((s) => s.id === data.sessionId);
  const w = width ?? 0;
  const h = height ?? 0;

  const zoomedIn = useStore((s) => s.transform[2] >= TERMINAL_ZOOM);
  const onScreen = useStore((s) => {
    const [tx, ty, zoom] = s.transform;
    const left = x * zoom + tx;
    const top = y * zoom + ty;
    return left < s.width && left + w * zoom > 0 && top < s.height && top + h * zoom > 0;
  });
  const expanded = useViewsUi((s) => s.expandedIds.includes(data.sessionId));
  const toggleExpanded = useViewsUi((s) => s.toggleExpanded);
  const summaryWhenZoomedOut = useViewsUi((s) => s.summaryWhenZoomedOut);
  const focused = useViewsUi((s) => s.focusId === data.sessionId);
  // 剛收到交接：外框一圈淡藍光，看得出是誰收到（動畫在 canvas.css）。
  const receiving = useHandoffActivity((s) => isReceiving(s.activities, data.sessionId));
  const flow = useReactFlow();
  const store = useStoreApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const size = useSizeNote();
  // 還沒進過畫面的卡不開 xterm，一次放大不會同時建幾十個終端機。
  const everOnScreen = useRef(false);
  if (onScreen) everOnScreen.current = true;

  if (!session) return null;

  // 失聯的機器沒有串流可接，維持凍結的最後畫面（規則四）。
  const isTerminal =
    session.status !== 'offline' && (zoomedIn || expanded || !summaryWhenZoomedOut);
  // 摘要條填滿外框的倍率。實際倍率在 CSS 依畫布縮放（--z）封頂，見 canvas.css 的 .strip。
  const fill = w / STRIP_W;
  // 外框留在原地，只移動鏡頭；停在 xterm 門檻以下，其他卡維持摘要條。
  const openTerminal = () => {
    toggleExpanded(session.id);
    if (flow.getZoom() >= READABLE_ZOOM) return;
    const { width, height } = store.getState();
    const zoom = Math.min(TERMINAL_ZOOM - 0.05, fitCardZoom({ x, y, w, h }, width, height));
    void flow.setCenter(x + w / 2, y + h / 2, { zoom, duration: motion() });
  };
  // 全尺寸頁會把畫布卸載（卡上的 xterm 也跟著退訂），記下鏡頭，回來時停在同一個地方。
  const openFull = () => {
    useViewsUi.getState().setCanvasReturn(flow.getViewport());
    location.hash = terminalHash(session.id);
  };
  const canType = !NO_INPUT.includes(session.status);
  const fromControl = (target: EventTarget) =>
    target instanceof Element && target.closest('button, input, a') !== null;

  return (
    <div
      className={`frame${focused ? ' spot' : ''}`}
      style={{ width: w, height: h }}
      data-testid={`card-${session.id}`}
      data-mode={isTerminal ? 'terminal' : 'summary'}
      data-handoff={receiving ? 'in' : undefined}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="ab-handle"
        aria-label={t('canvas.handoff.target')}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="ab-handle"
        title={t('canvas.handoff.drag')}
        aria-label={t('canvas.handoff.drag')}
      />
      {isTerminal ? (
        <article className={cardClass('termcard', session)}>
          <header
            onDoubleClick={(e) => {
              if (expanded && !fromControl(e.target)) toggleExpanded(session.id);
            }}
          >
            <CardHead session={session} menu />
            <div className="term-acts">
              <Actions session={session} isTerminal onOpenTerminal={() => {}} inputRef={inputRef} />
              <button className="nodrag" onClick={openFull} data-testid="open-full">
                {t('canvas.act.full')}
              </button>
              {expanded && !zoomedIn && (
                <button className="nodrag" onClick={() => toggleExpanded(session.id)}>
                  {t('canvas.act.summary')}
                </button>
              )}
            </div>
          </header>
          {/* xterm 外框之內不疊任何東西（規則三之一）。 */}
          <div
            className="term-slot nodrag nowheel nopan"
            data-testid="terminal-slot"
            data-visible={onScreen}
          >
            {everOnScreen.current && (
              <TerminalView
                sessionId={session.id}
                stream={backend.terminal}
                visible={onScreen}
                autoFocus={expanded}
                onSizeOwnerChange={size.onSizeOwnerChange}
              />
            )}
          </div>
          {size.note}
          {canType && <CommandInput session={session} inputRef={inputRef} />}
        </article>
      ) : (
        <article
          className={cardClass('strip', session)}
          style={{ '--fill': fill, '--card-w': `${w}px`, '--card-h': `${h}px` } as CSSProperties}
          onDoubleClick={(e) => {
            if (session.status !== 'offline' && !fromControl(e.target)) openTerminal();
          }}
        >
          <CardHead session={session} menu />
          <pre className="tail">{mask(session.lastLines.join('\n'))}</pre>
          {session.status !== 'offline' && (
            <ContextUsage tokens={session.contextTokens} window={session.contextWindow} />
          )}
          <DoneHint session={session} />
          <Actions
            session={session}
            isTerminal={false}
            onOpenTerminal={openTerminal}
            inputRef={inputRef}
          />
          {canType && <CommandInput session={session} inputRef={inputRef} />}
        </article>
      )}
    </div>
  );
}
