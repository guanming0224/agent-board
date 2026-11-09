// 疊在畫布上的三種外框（P2 §1.2）：右側面板（非模態）、置中次畫面（模態）、手機的全螢幕頁。
// 內容由各功能自己畫；這裡只管位置、關閉、焦點。
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useT } from '../shared/i18n';
import { PauseStrip } from './pause';
import { useViewsUi } from './uiStore';
import './messages';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function CloseButton({
  onClose,
  testId,
  label,
}: {
  onClose: () => void;
  testId?: string;
  /** 可存取名稱；框裡另有文字「關閉」鈕時傳不同的名字（例如「關閉對話框」），兩顆才分得出來。 */
  label?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="close"
      aria-label={label ?? t('views.panel.close')}
      title={t('views.panel.closeHint')}
      onClick={onClose}
      data-testid={testId}
    >
      <span aria-hidden="true">✕</span>
    </button>
  );
}

/**
 * 右側面板的標題列（團隊、Memory、收件匣共用的長相，STYLE.md §5.1）：h1 18px、左右內距 16，
 * 右邊依序「寬版」「✕」，兩顆都是精簡 32px。捲動時黏在面板頂端。
 */
export function PanelHead({
  title,
  onClose,
  closeTestId,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  closeTestId: string;
  /** 放在 ✕ 前面的動作（通常是寬版切換）。 */
  children?: ReactNode;
}) {
  return (
    <header className="panel-head side-panel-head">
      <h1>{title}</h1>
      <div className="panel-acts">
        {children}
        <CloseButton onClose={onClose} testId={closeTestId} />
      </div>
    </header>
  );
}

/** 寬版切換：按下（aria-pressed）用全站的「按下」外觀，不只換字。 */
export function WideButton({
  wide,
  onToggle,
  label,
  hint,
  testId,
}: {
  wide: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="sm"
      aria-pressed={wide}
      onClick={onToggle}
      title={hint}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/**
 * 右側面板：從頁首下緣到底，非模態（畫布仍可拖、可點卡）。寬度由呼叫端給（收件匣 480／760、團隊 420）。
 * 蓋住的寬度記在 uiStore，畫布聚焦卡片時才會把卡放在看得到的地方。
 */
export function SidePanel({
  label,
  width,
  testId,
  children,
}: {
  label: string;
  width: number;
  testId: string;
  children: ReactNode;
}) {
  // 視窗縮放時重算：窄到面板蓋住大半畫布時，聚焦卡片就不再讓開面板的寬度。
  useLayoutEffect(() => {
    const query = matchMedia(`(max-width: ${width + 120}px)`);
    const update = () => useViewsUi.getState().setRightInset(query.matches ? 0 : width);
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
      useViewsUi.getState().setRightInset(0);
    };
  }, [width]);
  return (
    <aside
      className="side-panel"
      style={{ ['--panel-width' as string]: `${width}px` }}
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </aside>
  );
}

/**
 * 置中次畫面：背後畫布暗化 60%，焦點鎖在框裡（背後整層設 inert，由 App 負責），
 * 點暗化背景或 ✕ 關閉；Esc 由 App 統一處理（只關最上層）。
 */
export function ModalLayer({
  label,
  onClose,
  testId,
  className,
  children,
}: {
  label: string;
  onClose: () => void;
  testId: string;
  /** 加在框上的 class（例如搜尋視窗用較小的尺寸）。 */
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // 背後已經 inert；再把 Tab 在框裡繞圈，焦點不會跑到瀏覽器網址列以外的地方又繞回背後。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.closest('[hidden]') && el.getClientRects().length > 0,
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === box.current)
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-layer"
      data-testid={`${testId}-backdrop`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={className ? `modal-box ${className}` : 'modal-box'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        <div className="modal-tools">
          <CloseButton onClose={onClose} testId={`${testId}-close`} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** 手機（≤ 640px）：團隊、設定、新增都是全螢幕頁，左上「← 返回」回上一個畫面。 */
export function PhonePage({
  onBack,
  testId,
  children,
}: {
  onBack: () => void;
  testId: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="phone-page" data-testid={testId}>
      <div className="phone-top">
        <div className="phone-back">
          <button type="button" className="ghost" onClick={onBack} data-testid="phone-back">
            ← {t('views.panel.back')}
          </button>
        </div>
        {/* 暫停中每一頁都要看得到（規格 §3.3）：手機的團隊、設定、新增全螢幕頁也放一份，捲動時跟著頂端。 */}
        <PauseStrip phone />
      </div>
      {children}
    </div>
  );
}
