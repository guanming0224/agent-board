// 對話框：封存確認、刪除確認共用。不用原生 confirm（STYLE.md 邏輯 6）。
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]';

/**
 * 放在 body 底下，不受畫布縮放影響。Esc 關閉、Tab 留在框裡、關掉後焦點回到原本的按鈕。
 * 點背景不關：危險操作的框被誤點關掉，使用者會以為已經做了。
 */
export function Dialog({
  title,
  onClose,
  children,
  testId,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 先聚焦整個框而不是第一顆按鈕：Enter 不會直接按到「封存」或「刪除」。
    box.current?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
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

  return createPortal(
    <div className="flows dialog-host">
      <div
        ref={box}
        className="dialog form-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
