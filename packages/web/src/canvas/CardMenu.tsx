// 卡片標題列的「⋯」：重新命名、建立交接線（P2 §4.2）、移到工作區（單獨 session，P2 §2.3 Q11）、
// 進度卡（單獨 session，P3）、在這裡 git init（資料夾不是 git、只有 owner，§24.5）、接續（已結束才有）、封存。選單展開在標題列下方（不浮在 xterm 上，規則三之一）。
import { useEffect, useRef, useState } from 'react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { canResume, errorText, useResume } from '../views';
import { requestArchive } from './archive';
import { useTeams } from '../team/store';
import { moveSessionToZone, useCurrentZoneId, useZones } from '../zones';
import { gitInitHash, newCrossReviewHash } from '../views/overlay';
import { useCurrentUser } from '../flows/common';
import { needsGitInit } from '../flows/gitInitState';
import '../flows/messages';
import '../review/messages';
import { useLinkPick } from './linkPick';
import { useProgressUi } from '../progress/uiStore';

/**
 * 「移到工作區 ▸」：只有單獨 session（不屬於任何團隊）有；團隊成員跟著團隊，要在團隊面板改。
 * 選單展開在原地（不浮在 xterm 上）。
 */
function MoveToZone({ session, onClose }: { session: Session; onClose: () => void }) {
  const t = useT();
  const zones = useZones();
  const current = useCurrentZoneId();
  const inTeam = useTeams((s) => s.members.some((m) => m.sessionId === session.id));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = zones.filter((z) => z.id !== current);
  if (inTeam || others.length === 0) return null;
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="card-move-zone"
      >
        {t('zones.moveTo')} ▸
      </button>
      {open && (
        <div className="card-submenu" role="menu" aria-label={t('zones.moveTo')}>
          {others.map((z) => (
            <button
              key={z.id}
              type="button"
              role="menuitem"
              className="sm"
              data-testid={`card-move-zone-${z.id}`}
              onClick={() =>
                void moveSessionToZone(session.id, z.id).then(onClose, (e: unknown) =>
                  setError(errorText(e)),
                )
              }
            >
              {t('zones.moveToItem', { name: z.name })}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="msg" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

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
      className="icon sm ghost menu-btn nodrag"
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

/** 「進度卡」：單獨 session 才有（團隊成員看團隊的卡），在卡片右側展開它自己的進度卡（P3 §1.2-D1）。 */
function ProgressItem({ session, onClose }: { session: Session; onClose: () => void }) {
  const t = useT();
  const inTeam = useTeams((s) => s.members.some((m) => m.sessionId === session.id));
  if (inTeam) return null;
  return (
    <button
      type="button"
      role="menuitem"
      className="sm"
      onClick={() => {
        onClose();
        useProgressUi.getState().setExpanded(`session:${session.id}`);
      }}
      data-testid="card-progress"
    >
      {t('canvas.menu.progress')}
    </button>
  );
}

/**
 * 「在這裡 git init…」（CONTRACTS §24.5）：資料夾不是 git、只有 owner（讀到使用者資料前不顯示）。
 * 打開置中次畫面（確認步驟、結果、略過的大檔都在那裡，卡片不用變高）。
 */
function GitInitItem({ session, onClose }: { session: Session; onClose: () => void }) {
  const t = useT();
  const me = useCurrentUser();
  if (!needsGitInit(session) || me.data?.role !== 'owner') return null;
  return (
    <button
      type="button"
      role="menuitem"
      className="sm"
      onClick={() => {
        onClose();
        location.hash = gitInitHash(session.id);
      }}
      data-testid="card-git-init"
    >
      {t('flows.gitInit.menu')}
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
        className="sm"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        {t('canvas.menu.rename')}
      </button>
      {/* 拖線的替代：觸控裝置看不到把手，桌面也可以用鍵盤完成（之後點目標卡，見 CanvasPage）。 */}
      <button
        type="button"
        role="menuitem"
        className="sm"
        onClick={() => {
          onClose();
          useLinkPick.getState().start(session.id);
        }}
      >
        {t('canvas.menu.link')}
      </button>
      <MoveToZone session={session} onClose={onClose} />
      <ProgressItem session={session} onClose={onClose} />
      {/* 交叉審查（Codex 第二輪）：這個 session 還沒 commit 的變更，先看檔案清單再確認。 */}
      <button
        type="button"
        role="menuitem"
        className="sm"
        onClick={() => {
          onClose();
          location.hash = newCrossReviewHash(session.id);
        }}
        data-testid="card-cross-review"
      >
        {t('review.open')}
      </button>
      <GitInitItem session={session} onClose={onClose} />
      {canResume(session) && (
        <button
          type="button"
          role="menuitem"
          className="sm"
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
        className="sm"
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
        className="cmd sm"
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
