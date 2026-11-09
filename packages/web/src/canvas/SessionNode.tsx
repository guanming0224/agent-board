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
import { codeClass, codeWaits, statusCode } from '../shared/status';
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
  inboxHash,
  Lamp,
  ModeChip,
  ReadOnlyChip,
  DispatchedByChip,
  useViewsUi,
} from '../views';
import { HeldFirstPrompt } from '../team/HeldFirstPrompt';
import { CardMenu, MenuButton, RenameInput } from './CardMenu';
import { CommandInput } from './CommandInput';
import { DoneHint } from './DoneHint';
import { useHandoffActivity } from './handoffActivity';
import { isReceiving } from './handoffActivityState';
import { useLinkPick } from './linkPick';
import { COMPACT_ZOOM, fitCardZoom, STRIP_W } from './layout';
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
  // GM Q2：白色實心主按鈕只給目前聚焦（「下一個等我的」框出）的那張卡；
  // 其他等你的卡用狀態代碼色的框＋淡底（canvas.css 的 .cue），畫面上不會同時出現好幾塊白。
  const focused = useViewsUi((s) => s.focusId === session.id);
  const main = focused ? 'sm primary' : 'sm cue';
  const [msg, setMsg] = useState('');
  // 收件匣抽屜打開並展開這一項（畫布留在底下）。
  const openReview = () => (location.hash = inboxHash(session.id));

  let body = null;
  if (danger || session.status === 'waiting_permission') {
    body = (
      <button className={danger ? 'sm danger' : main} onClick={openReview}>
        {t('canvas.act.decide')}
      </button>
    );
  } else if (session.status === 'plan_review') {
    body = (
      <button className={main} onClick={openReview}>
        {t('canvas.act.plan')}
      </button>
    );
  } else if (session.status === 'waiting_input') {
    body = (
      <button className={main} onClick={() => inputRef.current?.focus()}>
        {t('canvas.act.reply')}
      </button>
    );
  } else if (session.status === 'error' || session.status === 'stuck') {
    // 「開啟終端機」是這張卡的主要動作（畫布審查 B4），「Esc 中斷」維持次要。
    body = (
      <>
        {!isTerminal && (
          <button className={main} onClick={onOpenTerminal}>
            {t('canvas.act.terminal')}
          </button>
        )}
        <button
          className="sm"
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
      {/* 標題列就是卡片頂端的狀態帶（canvas.css），所以危險指令的警示放在它下面。 */}
      <div className="head">
        <Lamp status={session.status} detail={session.statusDetail} badge />
        {renaming ? (
          <RenameInput session={session} onDone={() => setRenaming(false)} />
        ) : (
          <span className="title" title={session.name}>
            {session.name}
          </span>
        )}
        {/* 等待時間和 ⋯ 一起：空間不夠時一起換到下一行（canvas.css），名稱留在徽章旁邊不被擠掉。 */}
        <span className="head-end">
          <Age session={session} />
          {menu && (
            <MenuButton session={session} open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} />
          )}
        </span>
      </div>
      {danger && <div className="danger-tag">{t('canvas.danger')}</div>}
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

/** 卡片的 class：放手線、狀態代碼色（邊框、標題色帶、光圈都用它，canvas.css、expanded.css）。 */
export const cardClass = (base: string, session: Session) => {
  const code = statusCode(session);
  return [
    base,
    'hands-host',
    handsClass(session.permissionMode),
    // 算「等你」的四種（ASK、PERM、PLAN、ERR）：粗框；光圈畫在外層 .frame。
    codeWaits(code) ? 'waits' : '',
    'st-code',
    // 狀態代碼的顏色（GM 2026-11-08，shared/styles/status.css 的 .c-<code>）。
    codeClass(code),
    session.status === 'offline' ? 'gone' : '',
  ]
    .filter(Boolean)
    .join(' ');
};

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
  // 「建立交接線…」選目標中，出發的那張卡標出來。
  const pickSource = useLinkPick((s) => s.from === data.sessionId);
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
    // 至少到 COMPACT_ZOOM：卡片很大時放大後仍在 30% 以下，按鈕會被藏起來（Q4）。
    const zoom = Math.max(
      COMPACT_ZOOM,
      Math.min(TERMINAL_ZOOM - 0.05, fitCardZoom({ x, y, w, h }, width, height)),
    );
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
      className={`frame ${codeClass(statusCode(session))}${focused ? ' spot' : ''}`}
      // --fill 放在外框上：摘要條的倍率（--strip-scale）由外框算，外框的圓角才跟得上（canvas.css）。
      style={
        {
          width: w,
          height: h,
          '--fill': fill,
          '--card-w': `${w}px`,
          '--card-h': `${h}px`,
        } as CSSProperties
      }
      data-testid={`card-${session.id}`}
      data-mode={isTerminal ? 'terminal' : 'summary'}
      data-handoff={receiving ? 'in' : undefined}
      data-code={statusCode(session)}
      data-waits={codeWaits(statusCode(session)) ? 'true' : undefined}
      data-pick={pickSource ? 'source' : undefined}
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
              if (fromControl(e.target)) return;
              if (expanded) toggleExpanded(session.id);
              // 縮到 COMPACT_ZOOM 以下按鈕都藏起來了（摘要模式：關）：點兩下走和摘要條同一套放大（Q4）。
              else if (flow.getZoom() < COMPACT_ZOOM) openTerminal();
            }}
          >
            <CardHead session={session} menu />
            <div className="term-acts">
              <Actions session={session} isTerminal onOpenTerminal={() => {}} inputRef={inputRef} />
              {/* 全部暫停中套用 Preset 時留下的隊長第一個指令（P3 §2.3，GM 按了才送）。 */}
              <HeldFirstPrompt sessionId={session.id} cue={!focused} />
              <button className="sm nodrag" onClick={openFull} data-testid="open-full">
                {t('canvas.act.full')}
              </button>
              {expanded && !zoomedIn && (
                <button className="sm nodrag" onClick={() => toggleExpanded(session.id)}>
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
          <HeldFirstPrompt sessionId={session.id} cue={!focused} />
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
