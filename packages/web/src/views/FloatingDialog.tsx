// 浮動對話框（GM 2026-11-14）：建立型的對話框（新增 session、新增團隊、補成員、套用 Preset）用這一份。
// 不蓋暗化遮罩、不攔背後畫布的指標事件，畫布照樣能看、能點卡、能捲動縮放；按住標題列可以拖到任何位置，
// 位置記在 localStorage（每個對話框各記各的），下次開在同一個地方，並夾在視窗範圍內。
// 手機（≤ 640px）不用這個：呼叫端維持全螢幕頁或原本的內嵌行為（useFloatDialogs）。規則：STYLE §5.2。
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { PHONE_QUERY } from '../shared/breakpoints';
import { useT } from '../shared/i18n';
import {
  centerPos,
  clampPos,
  floatBounds,
  keyMove,
  readPos,
  safeStorage,
  shouldFloat,
  writePos,
  type Bounds,
  type Pos,
  type Size,
} from './floatPosition';
import { CloseButton } from './CloseButton';
import { useViewsUi } from './uiStore';
import './messages';

/** 比手機寬就浮動；視窗縮放跨過手機斷點時跟著換。 */
export function useFloatDialogs(): boolean {
  const query = () =>
    typeof matchMedia === 'undefined'
      ? shouldFloat(typeof innerWidth === 'number' ? innerWidth : 1024)
      : !matchMedia(PHONE_QUERY).matches;
  const [float, setFloat] = useState(query);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const list = matchMedia(PHONE_QUERY);
    const onChange = () => setFloat(!list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return float;
}

/** 打字中（輸入框、終端機）：Esc 交給它，不關對話框（和 App 的全域 Esc 同一條規則）。 */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, .xterm, [role="textbox"]') !== null)
  );
}

/** 頁首下緣：浮動框不會蓋到頁首（頁首會隨換行、橫幅改變高度）。 */
function headerBottom(): number {
  const head = document.querySelector('.shell-head');
  return head ? head.getBoundingClientRect().bottom : 0;
}

function currentBounds(): Bounds {
  return floatBounds({ width: innerWidth, height: innerHeight }, headerBottom());
}

export function FloatingDialog({
  id,
  label,
  onClose,
  testId,
  className,
  open = true,
  children,
}: {
  /** 記位置用的名字（localStorage `agent-board.float.<id>`）。 */
  id: string;
  /** 標題列的字，也是對話框的可存取名稱。 */
  label: string;
  onClose: () => void;
  testId: string;
  /** 加在框上的 class（決定寬度與內容的版面）。 */
  className?: string;
  /** false：藏起來但不卸載（內嵌表單改成浮動後，關掉再開已填的內容還在）。 */
  open?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const hintId = useId();
  const box = useRef<HTMLDivElement>(null);
  /** 使用者要的位置（拖過、鍵盤移過、或打開時算好的置中位置）；實際顯示一律再夾進範圍。 */
  const [desired, setDesired] = useState<Pos | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointer: number; startX: number; startY: number; from: Pos } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  const shown = desired && size && bounds ? clampPos(desired, size, bounds) : null;
  const shownRef = useRef<Pos | null>(null);
  shownRef.current = shown;

  // 打開時量框的大小與可放的範圍，位置用記住的，沒有就置中（避開右側面板）。
  // 置中的結果也存成 desired：內容長高時框不會跟著跳。
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const measured = { width: box.current.offsetWidth, height: box.current.offsetHeight };
    const area = currentBounds();
    setSize(measured);
    setBounds(area);
    setDesired(
      readPos(id, safeStorage()) ?? centerPos(measured, area, useViewsUi.getState().rightInset),
    );
  }, [open, id]);

  // 視窗縮放、換螢幕、頁首換行：重算範圍（記住的位置不改，視窗變回來時框也回到原處）。內容長高：重量大小。
  useEffect(() => {
    if (!open || !box.current) return;
    const element = box.current;
    // 值沒變就沿用舊物件：不多 render，也不會在 ResizeObserver 裡連鎖觸發。
    const onResize = () =>
      setBounds((prev) => {
        const next = currentBounds();
        return prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.right === next.right &&
          prev.bottom === next.bottom
          ? prev
          : next;
      });
    const observer = new ResizeObserver(() => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
      onResize();
    });
    observer.observe(element);
    const head = document.querySelector('.shell-head');
    if (head) observer.observe(head);
    addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      removeEventListener('resize', onResize);
    };
  }, [open]);

  // 打開時焦點先進對話框；關掉時焦點還在框裡（或掉到 body）才還給原本的元素，
  // 使用者已經去點畫布了就不搶回來。浮動模式不鎖焦點：Tab 可以離開框去操作背後。
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = box.current;
    element?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (element?.contains(active) ?? false);
      if (lost && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  // 焦點不在任何地方（框裡按過的元素被換掉，例如 Preset 預覽回清單）時按 Esc：一樣關這個框，
  // 不會變成關掉後面的右側面板。焦點在畫布或面板上的 Esc 照舊交給它們與 App。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      e.preventDefault();
      close.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  const recenter = useCallback(() => {
    if (!box.current) return;
    const measured = { width: box.current.offsetWidth, height: box.current.offsetHeight };
    const area = currentBounds();
    setSize(measured);
    setBounds(area);
    setDesired(centerPos(measured, area, useViewsUi.getState().rightInset));
    writePos(id, null, safeStorage());
  }, [id]);

  const moveTo = (pos: Pos) => {
    if (!size || !bounds) return;
    const next = clampPos(pos, size, bounds);
    setDesired(next);
    return next;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !shown) return;
    // 標題列上的按鈕（回到中間、✕）照常按，不開始拖。
    if ((e.target as Element).closest('button, a, input, select, textarea')) return;
    // 擋掉預設動作：拖的時候不會選到文字、觸控不會捲動頁面。
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, from: shown };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    moveTo({ x: d.from.x + e.clientX - d.startX, y: d.from.y + e.clientY - d.startY });
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const moved = e.clientX !== d.startX || e.clientY !== d.startY;
    if (moved && shownRef.current) writePos(id, shownRef.current, safeStorage());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      // 裡面的元件（資料夾瀏覽、Preset 預覽）先處理過的 Esc 不再關整個框；打字中也不關。
      if (isTyping(e.target)) return;
      e.preventDefault();
      close.current();
      return;
    }
    // Alt＋方向鍵移動整個框（加 Shift 走大步）。打字中也可以：Alt＋方向鍵在輸入框裡沒有別的用途。
    if (e.altKey && !e.metaKey && !e.ctrlKey && shown) {
      const delta = keyMove(e.key, e.shiftKey);
      if (!delta) return;
      e.preventDefault();
      const next = moveTo({ x: shown.x + delta.x, y: shown.y + delta.y });
      if (next) writePos(id, next, safeStorage());
    }
  };

  return createPortal(
    <div
      ref={box}
      className={`float-box${className ? ` ${className}` : ''}${dragging ? ' is-dragging' : ''}`}
      role="dialog"
      // 非模態：背後的畫布、頁首、面板都還能操作。
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      tabIndex={-1}
      hidden={!open}
      data-testid={testId}
      data-floating="true"
      style={
        shown
          ? { left: shown.x, top: shown.y }
          : // 還沒量好大小：先透明（只差一個 layout effect，看不到閃動）。不用 visibility: hidden，
            // 那樣打開時的 focus() 會失敗（焦點要先進對話框）。
            { left: 0, top: 0, opacity: 0 }
      }
      onKeyDown={onKeyDown}
    >
      <div
        className="float-head"
        data-testid={`${testId}-handle`}
        title={t('views.float.dragHint')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          if ((e.target as Element).closest('button, a')) return;
          recenter();
        }}
      >
        <span className="float-grip" aria-hidden="true">
          ⠿
        </span>
        <h2 id={titleId} className="float-title">
          {label}
        </h2>
        <span id={hintId} className="sr-only">
          {t('views.float.hint')}
        </span>
        <div className="float-acts">
          <button
            type="button"
            className="sm icon"
            aria-label={t('views.float.center')}
            title={t('views.float.center')}
            onClick={recenter}
            data-testid={`${testId}-center`}
          >
            <span aria-hidden="true">⊕</span>
          </button>
          <CloseButton onClose={() => close.current()} testId={`${testId}-close`} />
        </div>
      </div>
      <div className="float-body">{children}</div>
    </div>,
    document.body,
  );
}
