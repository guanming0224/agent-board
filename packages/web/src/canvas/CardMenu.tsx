// 卡片標題列的「⋯」：重新命名、接續（已結束才有）、封存。選單展開在標題列下方（不浮在 xterm 上，規則三之一）。
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { canResume, errorText, useResume } from '../views';
import { requestArchive } from './archive';

export function MenuButton({
  session,
  open,
  onToggle,
}: {
  session: Session;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="menu-btn nodrag"
      aria-label={t('canvas.menu.aria', { name: session.name })}
      title={t('canvas.menu.aria', { name: session.name })}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onToggle}
    >
      ⋯
    </button>
  );
}

export function CardMenu({
  session,
  onRename,
  onClose,
}: {
  session: Session;
  onRename: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const { resume, busy, error } = useResume();
  useEffect(() => {
    box.current?.querySelector('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 告訴 App 這個 Esc 已經用掉了（Esc 只關最上層）。
        e.preventDefault();
        onClose();
      }
    };
    // 點卡片外面就收起來；點「⋯」本身由按鈕自己切換。
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (box.current?.contains(target) || target.closest?.('.menu-btn')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);
  return (
    <div ref={box} className="card-menu nodrag nopan" role="menu">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        {t('canvas.menu.rename')}
      </button>
      {canResume(session) && (
        <button
          type="button"
          role="menuitem"
          title={t('views.resume.hint')}
          disabled={busy}
          // 失敗時選單留著，錯誤訊息才看得到。
          onClick={() => void resume(session).then((ok) => ok && onClose())}
        >
          {busy ? t('views.resume.busy') : t('views.resume')}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          requestArchive([session.id]);
        }}
      >
        {t('canvas.menu.archive')}
      </button>
      {error && (
        <p className="msg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 原地改名：Enter 或離開輸入框就存，Esc 取消。 */
export function RenameInput({ session, onDone }: { session: Session; onDone: () => void }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [value, setValue] = useState(session.name);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const save = async () => {
    if (saving.current) return;
    const name = value.trim();
    if (!name || name === session.name) {
      onDone();
      return;
    }
    saving.current = true;
    try {
      await backend.updateSession(session.id, { name });
      onDone();
    } catch (e) {
      setError(t('canvas.menu.renameFailed', { detail: errorText(e) }));
    } finally {
      saving.current = false;
    }
  };
  return (
    <span className="rename nodrag nopan">
      <input
        className="cmd"
        aria-label={t('canvas.menu.renameAria')}
        value={value}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
      />
      {error && (
        <span className="msg" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
