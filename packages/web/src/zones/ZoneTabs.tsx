// 工作區分頁（P2 §2.3）：頁首原分頁列的位置。每個分頁＝名稱＋該工作區「等你」數（> 0 才顯示）；選中白色底線。
// 「+」原地輸入名稱建立並切過去；右鍵（觸控：長按）改名、刪除；超過 VISIBLE_TABS 個收進「更多」。
// 團隊框標籤拖到分頁上放開＝把團隊移過去。手機（≤ 640px）改成單一下拉，每項帶等你數。
import { useEffect, useRef, useState } from 'react';
import type { Zone } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText } from '../views/useBoardLoad';
import { moveTeamToZone, zoneContents } from './actions';
import { useCurrentZoneId, useZones, useZoneUi, useZoneWaiting, VISIBLE_TABS } from './store';
import './messages';
import './zones.css';

/** 拖曳團隊時放在 dataTransfer 的型別（只有團隊框標籤會放）。 */
export const TEAM_DRAG_TYPE = 'application/x-agent-board-team';
const LONG_PRESS_MS = 550;

function NameInput({
  initial,
  label,
  onSubmit,
  onCancel,
  testId,
}: {
  initial: string;
  label: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
  testId: string;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await onSubmit(name);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <span className="zone-name-input">
      <input
        autoFocus
        aria-label={label}
        value={value}
        maxLength={40}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy && !error) onCancel();
        }}
        data-testid={testId}
      />
      {error && (
        <span className="msg err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function ZoneMenu({
  zone,
  isLast,
  onRename,
  onClose,
}: {
  zone: Zone;
  isLast: boolean;
  onRename: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [error, setError] = useState<string | null>(null);
  const contents = zoneContents(zone.id);
  const blocked = contents.teams > 0 || contents.sessions > 0;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const remove = async () => {
    try {
      await backend.deleteZone(zone.id);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div
      ref={box}
      className="zone-menu"
      role="menu"
      aria-label={t('zones.menu.aria', { name: zone.name })}
      data-testid="zone-menu"
    >
      <button type="button" role="menuitem" onClick={onRename} data-testid="zone-rename">
        {t('zones.menu.rename')}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={blocked || isLast}
        onClick={() => void remove()}
        data-testid="zone-delete"
      >
        {t('zones.menu.delete')}
      </button>
      {(blocked || isLast) && (
        <p className="sub" data-testid="zone-delete-blocked">
          {isLast
            ? t('zones.menu.lastOne')
            : t('zones.menu.notEmpty', { teams: contents.teams, sessions: contents.sessions })}
        </p>
      )}
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 把團隊放到某個工作區上（分頁或「更多」裡的項目）。失敗要讓 GM 知道（PATCH 400、網路斷線）。 */
function dropTeam(teamId: string, zoneId: string): void {
  useZoneUi.getState().setDragging(null);
  moveTeamToZone(teamId, zoneId).catch((e: unknown) =>
    useZoneUi.getState().showMoveError(errorText(e)),
  );
}

/**
 * 一個工作區：頂部分頁，或「更多」清單裡的一項（item）。兩種都能點選、右鍵（觸控長按）改名或刪除、
 * 當團隊的拖放目標（§2.3 的右鍵選單不分是否收在「更多」裡）。
 */
function ZoneTab({
  zone,
  current,
  waiting,
  isLast,
  item = false,
  onChosen,
}: {
  zone: Zone;
  current: boolean;
  waiting: number;
  isLast: boolean;
  /** 「更多」清單裡的一項。 */
  item?: boolean;
  /** 點選或放下團隊之後（「更多」要收起來）。 */
  onChosen?: () => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const setCurrent = useZoneUi((s) => s.setCurrent);
  const dragging = useZoneUi((s) => s.dragging);
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const press = useRef<number | null>(null);
  const pressed = useRef(false);

  const clearPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };

  if (renaming) {
    return (
      <NameInput
        initial={zone.name}
        label={t('zones.rename.aria', { name: zone.name })}
        testId="zone-rename-input"
        onCancel={() => setRenaming(false)}
        onSubmit={async (name) => {
          await backend.renameZone(zone.id, name);
          setRenaming(false);
        }}
      />
    );
  }

  return (
    <span className={`zone-tab-wrap${item ? ' is-item' : ''}`}>
      <button
        type="button"
        role={item ? 'menuitem' : 'tab'}
        aria-selected={item ? undefined : current}
        aria-current={item && current ? 'true' : undefined}
        className={`${item ? 'zone-item' : 'zone-tab'}${over ? ' is-over' : ''}${dragging ? ' is-drop' : ''}`}
        title={t('zones.tab.hint')}
        data-testid={item ? `zone-more-${zone.id}` : `zone-tab-${zone.id}`}
        data-zone-name={zone.name}
        onClick={() => {
          // 長按開了選單：這次放開不算點。
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          setCurrent(zone.id);
          onChosen?.();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          pressed.current = false;
          clearPress();
          press.current = window.setTimeout(() => {
            pressed.current = true;
            setMenu(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TEAM_DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const teamId = e.dataTransfer.getData(TEAM_DRAG_TYPE);
          if (!teamId) return;
          e.preventDefault();
          dropTeam(teamId, zone.id);
          onChosen?.();
        }}
      >
        <span className="zone-tab-name">{zone.name}</span>
        {waiting > 0 && (
          <b
            className="zone-waiting num"
            aria-label={t('zones.tab.waiting', { n: waiting })}
            data-testid={`zone-waiting-${zone.id}`}
          >
            {waiting}
          </b>
        )}
      </button>
      {menu && (
        <ZoneMenu
          zone={zone}
          isLast={isLast}
          onClose={() => setMenu(false)}
          onRename={() => {
            setMenu(false);
            setRenaming(true);
          }}
        />
      )}
    </span>
  );
}

/**
 * 「更多 ▾」：超過 VISIBLE_TABS 個的工作區。目前工作區在裡面時按鈕寫它的名稱。
 * 清單裡每一項和分頁一樣能右鍵改名、刪除，也能放團隊；拖著團隊經過「更多」會自動展開清單。
 */
function MoreZones({
  zones,
  current,
  waiting,
  isLast,
}: {
  zones: Zone[];
  current: string;
  waiting: Map<string, number>;
  isLast: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const active = zones.find((z) => z.id === current);
  const total = zones.reduce((n, z) => n + (waiting.get(z.id) ?? 0), 0);
  useEffect(() => {
    if (!open) return;
    // 點清單外面或按 Esc 收起來（右鍵選單、改名輸入框都在清單裡面；改名時的 Esc 只取消改名）。
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="zone-tab-wrap" ref={box}>
      <button
        type="button"
        className="zone-tab zone-more"
        aria-expanded={open}
        aria-selected={active !== undefined}
        onClick={() => setOpen((v) => !v)}
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes(TEAM_DRAG_TYPE)) setOpen(true);
        }}
        data-testid="zone-more"
      >
        <span className="zone-tab-name">{active ? active.name : t('zones.more')}</span>
        {total > 0 && <b className="zone-waiting num">{total}</b>}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div className="zone-menu zone-more-menu" role="menu" data-testid="zone-more-menu">
          {zones.map((z) => (
            <ZoneTab
              key={z.id}
              zone={z}
              current={z.id === current}
              waiting={waiting.get(z.id) ?? 0}
              isLast={isLast}
              item
              onChosen={() => setOpen(false)}
            />
          ))}
        </div>
      )}
    </span>
  );
}

export function ZoneTabs() {
  const t = useT();
  const zones = useZones();
  const current = useCurrentZoneId();
  const waiting = useZoneWaiting();
  const backend = useBoard((s) => s.backend);
  const setCurrent = useZoneUi((s) => s.setCurrent);
  const [adding, setAdding] = useState(false);
  const shown = zones.slice(0, VISIBLE_TABS);
  const rest = zones.slice(VISIBLE_TABS);

  return (
    <nav className="zone-bar" aria-label={t('zones.aria')} data-testid="zone-bar">
      <div className="zone-tabs" role="tablist">
        {shown.map((z) => (
          <ZoneTab
            key={z.id}
            zone={z}
            current={z.id === current}
            waiting={waiting.get(z.id) ?? 0}
            isLast={zones.length <= 1}
          />
        ))}
        {rest.length > 0 && (
          <MoreZones zones={rest} current={current} waiting={waiting} isLast={zones.length <= 1} />
        )}
        {adding ? (
          <NameInput
            initial=""
            label={t('zones.add.aria')}
            testId="zone-add-input"
            onCancel={() => setAdding(false)}
            onSubmit={async (name) => {
              const zone = await backend.createZone(name);
              setAdding(false);
              setCurrent(zone.id);
            }}
          />
        ) : (
          <button
            type="button"
            className="zone-add"
            aria-label={t('zones.add.aria')}
            title={t('zones.add.aria')}
            onClick={() => setAdding(true)}
            data-testid="zone-add"
          >
            +
          </button>
        )}
      </div>
      {/* 手機：單一下拉，每項帶等你數。 */}
      <label className="zone-select">
        <span className="sr-only">{t('zones.aria')}</span>
        <select
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          data-testid="zone-select"
        >
          {zones.map((z) => {
            const n = waiting.get(z.id) ?? 0;
            return (
              <option key={z.id} value={z.id}>
                {n > 0 ? t('zones.option.waiting', { name: z.name, n }) : z.name}
              </option>
            );
          })}
        </select>
      </label>
      <MoveNoticeLine />
    </nav>
  );
}

/** 「已移到『交易』［前往］」：移走團隊或 session 後，畫面停在原工作區。 */
function MoveNoticeLine() {
  const t = useT();
  const notice = useZoneUi((s) => s.notice);
  const moveError = useZoneUi((s) => s.moveError);
  const clear = useZoneUi((s) => s.clearNotice);
  const setCurrent = useZoneUi((s) => s.setCurrent);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clear, 8000);
    return () => window.clearTimeout(timer);
  }, [notice, clear]);
  if (moveError) {
    // 沒移過去：留著直到 GM 關掉或下一次移動（不自動消失，免得錯過）。
    return (
      <span className="zone-notice is-error" role="alert" data-testid="zone-move-error">
        {t('zones.moveFailed', { detail: moveError })}
        <button type="button" onClick={clear} aria-label={t('zones.notice.close')}>
          ✕
        </button>
      </span>
    );
  }
  if (!notice) return null;
  return (
    <span className="zone-notice" role="status" data-testid="zone-notice">
      {t('zones.moved', { name: notice.zoneName })}
      <button
        type="button"
        onClick={() => {
          setCurrent(notice.zoneId);
          clear();
        }}
        data-testid="zone-notice-go"
      >
        {t('zones.moved.go')}
      </button>
    </span>
  );
}
