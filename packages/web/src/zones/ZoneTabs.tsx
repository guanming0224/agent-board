// 工作區分頁（P2 §2.3）＋分頁群組（GM 2026-11-14，CONTRACTS §25）：頁首原分頁列的位置。
// 每個分頁＝名稱＋該工作區「等你」數（> 0 才顯示）；選中白色底線。同類的分頁可以收進一個有名稱、有顏色的群組
// （像 Chrome 的分頁群組）：點群組標籤展開／收合（每台裝置各自記），收合時標籤寫畫布數、目前畫布在裡面會標出來。
// 沒有數量上限：放不下時整列左右捲動（觸控滑、滑鼠滾輪轉橫向、目前分頁自動捲進可見範圍），手機也一樣。
// 「+」原地輸入名稱建立並切過去；右鍵（觸控：長按）開選單：改名、加入／移出群組、往左／右移、刪除；
// 群組標籤的選單：改名、換顏色、往左／右移、取消群組（畫布保留）。桌面可拖曳分頁排序、拖進拖出群組。
// 團隊框標籤拖到分頁上放開＝把團隊移過去；拖著團隊經過收合的群組會暫時展開。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Zone, ZoneBarItem, ZoneBarMove, ZoneGroup } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { TEAM_COLORS, teamColorVar } from '../team/colors';
import { errorText } from '../views/useBoardLoad';
import { moveTeamToZone, zoneContents } from './actions';
import {
  dropMove,
  groupOpen,
  placeMenu,
  pruneCollapsed,
  revealScroll,
  stepMove,
  wheelToHorizontal,
  type BarTarget,
  type DropOver,
} from './bar';
import { useCurrentZoneId, useZoneBar, useZones, useZoneUi, useZoneWaiting } from './store';
import '../team/messages';
import '../team/team.css';
import './messages';
import './zones.css';

/** 拖曳團隊時放在 dataTransfer 的型別（只有團隊框標籤會放）。 */
export const TEAM_DRAG_TYPE = 'application/x-agent-board-team';
/** 拖曳分頁或群組標籤（頂部列內排序、拖進拖出群組）。 */
const TAB_DRAG_TYPE = 'application/x-agent-board-zone-tab';
const LONG_PRESS_MS = 550;
/** 長按時手指移動超過這麼多就當成在捲動，不開選單。 */
const LONG_PRESS_SLOP = 8;

/**
 * 只有滑鼠這類精準指標才開放拖曳排序：觸控裝置長按是開選單（Android 的 Chrome 長按 draggable 會變成拖曳），
 * 觸控用選單的「加入群組」「往左／往右移」。
 */
const canDragTabs = (): boolean => {
  try {
    return window.matchMedia('(pointer: fine)').matches;
  } catch {
    return true;
  }
};

type TeamColor = (typeof TEAM_COLORS)[number];

/** 選單開在哪一格、對齊哪個元素。 */
interface MenuState {
  target: BarTarget;
  anchor: HTMLElement;
}

function NameInput({
  initial,
  label,
  onSubmit,
  onCancel,
  testId,
  keepOnBlur = false,
}: {
  initial: string;
  label: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
  testId: string;
  /** 在選單裡（旁邊還有顏色、建立鈕）：失焦不取消。 */
  keepOnBlur?: boolean;
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
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!keepOnBlur && !busy && !error) onCancel();
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

/** 右鍵與觸控長按開選單（分頁、群組標籤共用）。長按開了選單，那次放開不算點。 */
function useMenuTrigger(open: (anchor: HTMLElement) => void) {
  const press = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const clear = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
    start.current = null;
  };
  useEffect(() => clear, []);
  return {
    /** 這次點擊是不是長按開選單後的放開（是就吃掉）。 */
    consumePress(): boolean {
      if (!pressed.current) return false;
      pressed.current = false;
      return true;
    },
    handlers: {
      onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
        e.preventDefault();
        clear();
        open(e.currentTarget);
      },
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType !== 'touch') return;
        pressed.current = false;
        clear();
        const el = e.currentTarget;
        start.current = { x: e.clientX, y: e.clientY };
        press.current = window.setTimeout(() => {
          pressed.current = true;
          open(el);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const s = start.current;
        if (!s) return;
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP) clear();
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
    },
  };
}

/** 把團隊放到某個工作區上。失敗要讓 GM 知道（PATCH 400、網路斷線）。 */
function dropTeam(teamId: string, zoneId: string): void {
  useZoneUi.getState().setDragging(null);
  moveTeamToZone(teamId, zoneId).catch((e: unknown) =>
    useZoneUi.getState().showMoveError(errorText(e)),
  );
}

/** 頂部列共用的東西（拖曳中的分頁、暫時展開的群組、開選單、搬動）。 */
interface BarApi {
  items: ZoneBarItem<Zone>[];
  tabDrag: BarTarget | null;
  setTabDrag(target: BarTarget | null): void;
  /** 拖曳中暫時展開的群組（拖曳結束前都不收，經過好幾個也不來回跳）。 */
  peek: string[];
  addPeek(groupId: string): void;
  dropPeek(groupId: string): void;
  /** 收合中的群組（只留現有的群組）。 */
  collapsed: Record<string, true>;
  /** hub 有送群組資料（舊版 hub 沒有：群組相關選單項目與拖曳都不給）。 */
  groups: boolean;
  openMenu(target: BarTarget, anchor: HTMLElement): void;
  move(move: ZoneBarMove | null): void;
  renaming: string | null;
  setRenaming(zoneId: string | null): void;
}

/** 拖曳經過時，指到左半＝放前面、右半＝放後面。 */
function sideOf(e: React.DragEvent<HTMLElement>): 'before' | 'after' {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
}

/** 一個工作區分頁（頂部列或群組裡）。 */
function ZoneTab({
  zone,
  current,
  waiting,
  bar,
}: {
  zone: Zone;
  current: boolean;
  waiting: number;
  bar: BarApi;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const setCurrent = useZoneUi((s) => s.setCurrent);
  const dragging = useZoneUi((s) => s.dragging);
  const [over, setOver] = useState<'into' | 'before' | 'after' | null>(null);
  const trigger = useMenuTrigger((anchor) => bar.openMenu({ kind: 'zone', id: zone.id }, anchor));

  if (bar.renaming === zone.id) {
    return (
      <NameInput
        initial={zone.name}
        label={t('zones.rename.aria', { name: zone.name })}
        testId="zone-rename-input"
        onCancel={() => bar.setRenaming(null)}
        onSubmit={async (name) => {
          await backend.renameZone(zone.id, name);
          bar.setRenaming(null);
        }}
      />
    );
  }

  const dropping = dragging !== null || bar.tabDrag !== null;
  return (
    <span className="zone-tab-wrap">
      <button
        type="button"
        role="tab"
        aria-selected={current}
        className={`tab zone-tab${over ? ` is-over is-${over}` : ''}${dropping ? ' is-drop' : ''}`}
        title={t('zones.tab.hint')}
        data-testid={`zone-tab-${zone.id}`}
        data-zone-name={zone.name}
        data-zone-current={current ? 'true' : undefined}
        draggable={bar.groups && canDragTabs()}
        onDragStart={(e) => {
          e.dataTransfer.setData(TAB_DRAG_TYPE, zone.id);
          e.dataTransfer.effectAllowed = 'move';
          bar.setTabDrag({ kind: 'zone', id: zone.id });
        }}
        onDragEnd={() => bar.setTabDrag(null)}
        onClick={() => {
          if (trigger.consumePress()) return;
          setCurrent(zone.id);
        }}
        {...trigger.handlers}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (types.includes(TEAM_DRAG_TYPE)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setOver('into');
          } else if (types.includes(TAB_DRAG_TYPE) && bar.tabDrag) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            setOver(sideOf(e));
          }
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => {
          setOver(null);
          const teamId = e.dataTransfer.getData(TEAM_DRAG_TYPE);
          if (teamId) {
            e.preventDefault();
            dropTeam(teamId, zone.id);
            return;
          }
          if (bar.tabDrag) {
            e.preventDefault();
            e.stopPropagation();
            bar.move(dropMove(bar.items, bar.tabDrag, { kind: 'zone', id: zone.id }, sideOf(e)));
            bar.setTabDrag(null);
          }
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
    </span>
  );
}

/** 群組標籤＋（展開時）裡面的分頁。外框和底色用群組色（同團隊框：1px 框＋淡底＋名稱標籤，不只靠顏色）。 */
function GroupChunk({
  group,
  zones,
  current,
  waiting,
  bar,
}: {
  group: ZoneGroup;
  zones: Zone[];
  current: string;
  waiting: Map<string, number>;
  bar: BarApi;
}) {
  const t = useT();
  const setCollapsed = useZoneUi((s) => s.setCollapsed);
  const dragging = useZoneUi((s) => s.dragging);
  const [over, setOver] = useState<'into' | 'before' | 'after' | null>(null);
  const open = groupOpen(group.id, bar.collapsed, bar.peek);
  const inside = zones.find((z) => z.id === current);
  const total = zones.reduce((n, z) => n + (waiting.get(z.id) ?? 0), 0);
  const trigger = useMenuTrigger((anchor) => bar.openMenu({ kind: 'group', id: group.id }, anchor));
  const dropping = dragging !== null || bar.tabDrag !== null;

  return (
    <span
      className={`zone-group${open ? ' is-open' : ' is-closed'}`}
      style={{ '--gc': teamColorVar(group.color) } as React.CSSProperties}
      data-testid={`zone-group-wrap-${group.id}`}
      data-group-name={group.name}
    >
      <button
        type="button"
        className={`zone-group-tag${over ? ` is-over is-${over}` : ''}${dropping ? ' is-drop' : ''}`}
        aria-expanded={open}
        aria-label={t('zones.group.aria', { name: group.name, n: zones.length })}
        aria-current={!open && inside ? 'true' : undefined}
        title={t('zones.group.hint')}
        data-testid={`zone-group-${group.id}`}
        data-zone-current={!open && inside ? 'true' : undefined}
        draggable={canDragTabs()}
        onDragStart={(e) => {
          e.dataTransfer.setData(TAB_DRAG_TYPE, group.id);
          e.dataTransfer.effectAllowed = 'move';
          bar.setTabDrag({ kind: 'group', id: group.id });
        }}
        onDragEnd={() => bar.setTabDrag(null)}
        onClick={() => {
          if (trigger.consumePress()) return;
          setCollapsed(group.id, open);
          bar.dropPeek(group.id);
        }}
        {...trigger.handlers}
        onDragEnter={(e) => {
          // 拖著團隊或分頁經過收合的群組：暫時展開（放開或拖走結束後收回去），原本「更多」的等價做法。
          const types = e.dataTransfer.types;
          if (types.includes(TEAM_DRAG_TYPE) || (types.includes(TAB_DRAG_TYPE) && bar.tabDrag)) {
            if (!open) bar.addPeek(group.id);
          }
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE) || !bar.tabDrag) return;
          if (bar.tabDrag.id === group.id) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          setOver(bar.tabDrag.kind === 'zone' ? 'into' : sideOf(e));
        }}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => {
          setOver(null);
          if (!bar.tabDrag) return;
          e.preventDefault();
          e.stopPropagation();
          bar.move(dropMove(bar.items, bar.tabDrag, { kind: 'group', id: group.id }, sideOf(e)));
          bar.setTabDrag(null);
        }}
      >
        <i className="swatch" aria-hidden="true" />
        <span className="zone-tab-name">{group.name}</span>
        {!open && (
          <>
            <span
              className="zone-group-count num"
              title={t('zones.group.count', { n: zones.length })}
            >
              {zones.length}
            </span>
            {inside && (
              <span
                className="zone-group-current"
                title={t('zones.group.current', { name: inside.name })}
                data-testid={`zone-group-current-${group.id}`}
              >
                {inside.name}
              </span>
            )}
            {total > 0 && (
              <b className="zone-waiting num" aria-label={t('zones.tab.waiting', { n: total })}>
                {total}
              </b>
            )}
          </>
        )}
        <span className="zone-group-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open &&
        zones.map((z) => (
          <ZoneTab
            key={z.id}
            zone={z}
            current={z.id === current}
            waiting={waiting.get(z.id) ?? 0}
            bar={bar}
          />
        ))}
    </span>
  );
}

/** 選單切換子畫面（加入群組 ▸、新群組…、換顏色 ▸）後把焦點移到子畫面第一個元素。 */
const MenuFocus = createContext<() => void>(() => undefined);

/** 選單內容切換畫面時呼叫（view 變了就把焦點放到第一個元素）。 */
function useMenuView<V>(view: V): void {
  const focusFirst = useContext(MenuFocus);
  useEffect(() => {
    focusFirst();
  }, [view, focusFirst]);
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)';

/**
 * 浮層選單：掛在 body 上（頂部列會橫向捲動，選單放在裡面會被切掉），對齊開它的那一格。下面放不下就往上翻，
 * 高度不超過可視範圍（選單自己捲）。鍵盤：↑↓ 在項目間移動（Home／End 到頭尾）、Esc 關並回到分頁、Tab 離開＝關。
 */
function Popover({
  anchor,
  label,
  onClose,
  children,
  testId,
}: {
  anchor: HTMLElement;
  label: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  // 每次畫完都重算（子畫面換了高度會變）；值一樣就不 setState，不會一直重畫。
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const next = placeMenu(
      r,
      { width: el.offsetWidth, height: el.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((p) =>
      p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next,
    );
  });
  useEffect(() => {
    const onResize = () => setPos(null);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // 子畫面有輸入框（新群組、改名）就先給輸入框，打字就好；沒有就給第一個項目。
  const focusFirst = useCallback(() => {
    const el = box.current;
    (
      el?.querySelector<HTMLElement>('input:not(:disabled)') ??
      el?.querySelector<HTMLElement>(FOCUSABLE)
    )?.focus();
  }, []);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
      if (anchor.isConnected) anchor.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [anchor, onClose]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // 離開選單＝關掉（焦點照瀏覽器的 Tab 順序走）。
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    // 輸入框裡的 Home／End 是移游標，不搶。
    if ((e.key === 'Home' || e.key === 'End') && e.target instanceof HTMLInputElement) return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (at + 1) % items.length
            : (at - 1 + items.length) % items.length;
    items[next]!.focus();
  };
  return createPortal(
    <div
      ref={box}
      className="menu zone-menu"
      role="menu"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
      style={
        pos
          ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
          : // 還沒量好位置：先透明（不用 visibility: hidden，那樣焦點放不進去）。
            { left: 0, top: 0, opacity: 0 }
      }
    >
      <MenuFocus.Provider value={focusFirst}>{children}</MenuFocus.Provider>
    </div>,
    document.body,
  );
}

function ColorChoices({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (color: TeamColor) => void;
}) {
  const t = useT();
  return (
    <div className="color-picker zone-colors" role="group" aria-label={t('zones.group.color')}>
      {TEAM_COLORS.map((color) => {
        const name = t(`team.color.${color}`);
        return (
          <button
            key={color}
            type="button"
            className="icon sm color-pick"
            aria-label={name}
            title={name}
            aria-pressed={value === color}
            data-color={color}
            data-testid={`zone-group-color-${color}`}
            onClick={() => onPick(color)}
          >
            <i className="swatch" style={{ background: teamColorVar(color) }} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/** 新群組（從分頁選單「加入群組 → 新群組…」）：名稱＋顏色＋建立，建立時帶這個分頁。 */
function NewGroupForm({ zoneId, onDone }: { zoneId: string; onDone: () => void }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [color, setColor] = useState<TeamColor>(TEAM_COLORS[0]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await backend.createZoneGroup({ name: trimmed, color, zoneIds: [zoneId] });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="zone-group-form">
      <input
        autoFocus
        aria-label={t('zones.group.name.aria')}
        placeholder={t('zones.group.newName')}
        value={name}
        maxLength={40}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        data-testid="zone-group-name-input"
      />
      <ColorChoices value={color} onPick={setColor} />
      <button
        type="button"
        className="sm primary"
        disabled={!name.trim() || busy}
        onClick={() => void submit()}
        data-testid="zone-group-create"
      >
        {t('zones.group.create')}
      </button>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 分頁的選單：改名、加入群組 ▸、移出群組、往左／右移、刪除。 */
function ZoneMenuBody({
  zone,
  bar,
  isLast,
  onClose,
}: {
  zone: Zone;
  bar: BarApi;
  isLast: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [view, setView] = useState<'main' | 'groups' | 'new'>('main');
  useMenuView(view);
  const [error, setError] = useState<string | null>(null);
  const contents = zoneContents(zone.id);
  const blocked = contents.teams > 0 || contents.sessions > 0;
  const groups = bar.items.flatMap((i) => (i.kind === 'group' ? [i] : []));
  const mine = groups.find((g) => g.zones.some((z) => z.id === zone.id))?.group ?? null;
  const left = stepMove(bar.items, { kind: 'zone', id: zone.id }, -1);
  const right = stepMove(bar.items, { kind: 'zone', id: zone.id }, 1);
  const run = (task: () => Promise<unknown>) => {
    task().then(onClose, (e: unknown) => setError(errorText(e)));
  };
  const err = error && (
    <p className="msg err" role="alert">
      {error}
    </p>
  );

  if (view === 'new') {
    return (
      <>
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => setView('groups')}
        >
          ‹ {t('zones.menu.back')}
        </button>
        <NewGroupForm zoneId={zone.id} onDone={onClose} />
      </>
    );
  }
  if (view === 'groups') {
    return (
      <>
        <button type="button" role="menuitem" className="menu-item" onClick={() => setView('main')}>
          ‹ {t('zones.menu.back')}
        </button>
        {groups
          .filter((g) => g.group.id !== mine?.id)
          .map((g) => (
            <button
              key={g.group.id}
              type="button"
              role="menuitem"
              className="menu-item zone-menu-group"
              style={{ '--gc': teamColorVar(g.group.color) } as React.CSSProperties}
              data-testid={`zone-join-${g.group.id}`}
              onClick={() =>
                run(() =>
                  backend.moveZoneBarItem({
                    kind: 'zone',
                    id: zone.id,
                    groupId: g.group.id,
                    before: null,
                  }),
                )
              }
            >
              <span>
                <i className="swatch" aria-hidden="true" />
                {t('zones.menu.addToGroupItem', { name: g.group.name })}
              </span>
            </button>
          ))}
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => setView('new')}
          data-testid="zone-new-group"
        >
          {t('zones.menu.newGroup')}
        </button>
        {err}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={() => {
          onClose();
          bar.setRenaming(zone.id);
        }}
        data-testid="zone-rename"
      >
        {t('zones.menu.rename')}
      </button>
      {/* 連到舊版 hub（快照沒有 zoneGroups）：沒有群組 API，群組與排序的項目都不給。 */}
      {bar.groups && (
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          aria-haspopup="menu"
          onClick={() => setView('groups')}
          data-testid="zone-add-to-group"
        >
          {t('zones.menu.addToGroup')} ▸
        </button>
      )}
      {bar.groups && mine && (
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() =>
            run(() => backend.moveZoneBarItem({ kind: 'zone', id: zone.id, groupId: null }))
          }
          data-testid="zone-ungroup-tab"
        >
          {t('zones.menu.ungroupTab')}
        </button>
      )}
      {bar.groups && (
        <>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!left}
            onClick={() => left && run(() => backend.moveZoneBarItem(left))}
            data-testid="zone-move-left"
          >
            {t('zones.menu.left')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!right}
            onClick={() => right && run(() => backend.moveZoneBarItem(right))}
            data-testid="zone-move-right"
          >
            {t('zones.menu.right')}
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        disabled={blocked || isLast}
        onClick={() => run(() => backend.deleteZone(zone.id))}
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
      {err}
    </>
  );
}

/**
 * 群組標籤的選單：改名、換顏色、往左／右移、取消群組（畫布保留）。取消群組不會刪任何東西，所以不用確認
 * （原本另有「刪除群組」，資料上和取消群組相同，審查 N10 合併成一項）。
 */
function GroupMenuBody({
  group,
  count,
  bar,
  onClose,
}: {
  group: ZoneGroup;
  count: number;
  bar: BarApi;
  onClose: () => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [view, setView] = useState<'main' | 'rename' | 'color'>('main');
  useMenuView(view);
  const [error, setError] = useState<string | null>(null);
  const left = stepMove(bar.items, { kind: 'group', id: group.id }, -1);
  const right = stepMove(bar.items, { kind: 'group', id: group.id }, 1);
  const run = (task: () => Promise<unknown>) => {
    task().then(onClose, (e: unknown) => setError(errorText(e)));
  };
  const err = error && (
    <p className="msg err" role="alert">
      {error}
    </p>
  );
  if (view === 'rename') {
    return (
      <NameInput
        initial={group.name}
        label={t('zones.group.name.aria')}
        testId="zone-group-rename-input"
        keepOnBlur
        onCancel={() => setView('main')}
        onSubmit={async (name) => {
          await backend.updateZoneGroup(group.id, { name });
          onClose();
        }}
      />
    );
  }
  if (view === 'color') {
    return (
      <>
        <button type="button" role="menuitem" className="menu-item" onClick={() => setView('main')}>
          ‹ {t('zones.menu.back')}
        </button>
        <ColorChoices
          value={group.color}
          onPick={(color) => run(() => backend.updateZoneGroup(group.id, { color }))}
        />
        {err}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={() => setView('rename')}
        data-testid="zone-group-rename"
      >
        {t('zones.group.rename')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={() => setView('color')}
        data-testid="zone-group-recolor"
      >
        {t('zones.group.color')} ▸
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        disabled={!left}
        onClick={() => left && run(() => backend.moveZoneBarItem(left))}
        data-testid="zone-group-left"
      >
        {t('zones.menu.left')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        disabled={!right}
        onClick={() => right && run(() => backend.moveZoneBarItem(right))}
        data-testid="zone-group-right"
      >
        {t('zones.menu.right')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="menu-item"
        onClick={() => run(() => backend.deleteZoneGroup(group.id))}
        data-testid="zone-group-ungroup"
      >
        {t('zones.group.ungroup')}
        <span className="sub">{t('zones.group.ungroup.sub', { n: count })}</span>
      </button>
      {err}
    </>
  );
}

export function ZoneTabs() {
  const t = useT();
  const zones = useZones();
  const items = useZoneBar();
  const current = useCurrentZoneId();
  const waiting = useZoneWaiting();
  const backend = useBoard((s) => s.backend);
  const setCurrent = useZoneUi((s) => s.setCurrent);
  const dragging = useZoneUi((s) => s.dragging);
  const storedCollapsed = useZoneUi((s) => s.collapsed);
  const keepCollapsed = useZoneUi((s) => s.keepCollapsed);
  const rawGroups = useBoard((s) => s.zoneGroups);
  const groupsSupported = rawGroups !== undefined;
  const groupIds = useMemo(
    () => items.flatMap((i) => (i.kind === 'group' ? [i.group.id] : [])),
    [items],
  );
  const groupKey = groupIds.join(',');
  // 收合記錄只看現有的群組（別台刪掉的群組不留）。連到舊 hub（沒有群組資料）時不清，換回新 hub 還在。
  const collapsed = useMemo(
    () => (groupsSupported ? pruneCollapsed(storedCollapsed, groupIds) : storedCollapsed),
    [storedCollapsed, groupIds, groupsSupported],
  );
  useEffect(() => {
    if (groupsSupported) keepCollapsed(groupKey ? groupKey.split(',') : []);
  }, [groupsSupported, groupKey, keepCollapsed]);
  const showMoveError = useZoneUi((s) => s.showMoveError);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [tabDrag, setTabDrag] = useState<BarTarget | null>(null);
  const [peek, setPeek] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [endOver, setEndOver] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // 拖曳結束（團隊放下或取消、分頁放下）：暫時展開的群組收回去（拖曳中都不收）。
  useEffect(() => {
    if (dragging === null && tabDrag === null) setPeek((p) => (p.length ? [] : p));
  }, [dragging, tabDrag]);

  // 滑鼠滾輪轉成橫向捲動（React 的 onWheel 是 passive，不能 preventDefault，所以自己掛）。
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = wheelToHorizontal(e, el);
      if (dx === null) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 目前分頁（或收合著、裝著目前分頁的群組標籤）自動捲進可見範圍。只在目前畫布或收合狀態變了才做：
  // 別台改了群組或順序不要把人拉回來。
  useLayoutEffect(() => {
    const el = scroller.current;
    const target = el?.querySelector<HTMLElement>('[data-zone-current="true"]');
    if (!el || !target) return;
    const box = el.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const next = revealScroll(el, { left: r.left - box.left + el.scrollLeft, width: r.width });
    if (next !== null) el.scrollLeft = next;
  }, [current, collapsed]);

  const move = useCallback(
    (m: ZoneBarMove | null) => {
      if (!m) return;
      backend.moveZoneBarItem(m).catch((e: unknown) => showMoveError(errorText(e)));
    },
    [backend, showMoveError],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  const bar: BarApi = {
    items,
    tabDrag,
    setTabDrag,
    peek,
    addPeek: (id) => setPeek((p) => (p.includes(id) ? p : [...p, id])),
    dropPeek: (id) => setPeek((p) => (p.includes(id) ? p.filter((x) => x !== id) : p)),
    collapsed,
    groups: groupsSupported,
    openMenu: (target, anchor) => setMenu({ target, anchor }),
    move,
    renaming,
    setRenaming,
  };

  const menuZone = menu?.target.kind === 'zone' ? zones.find((z) => z.id === menu.target.id) : null;
  const menuGroup =
    menu?.target.kind === 'group'
      ? items.find(
          (i): i is Extract<ZoneBarItem<Zone>, { kind: 'group' }> =>
            i.kind === 'group' && i.group.id === menu.target.id,
        )
      : undefined;

  return (
    <nav className="zone-bar" aria-label={t('zones.aria')} data-testid="zone-bar">
      <div className="zone-strip">
        <div
          ref={scroller}
          className={`zone-tabs${endOver ? ' is-end-over' : ''}`}
          role="tablist"
          data-testid="zone-scroll"
          onScroll={() => menu && setMenu(null)}
          onDragOver={(e) => {
            // 放在空白處（最後面）＝移出群組、排到最後。分頁和群組標籤自己會攔下 dragover。
            if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE) || !tabDrag) return;
            e.preventDefault();
            setEndOver(true);
          }}
          onDragLeave={(e) => {
            if (e.target === e.currentTarget) setEndOver(false);
          }}
          onDrop={(e) => {
            setEndOver(false);
            if (!tabDrag) return;
            e.preventDefault();
            const end: DropOver = { kind: 'end' };
            move(dropMove(items, tabDrag, end, 'after'));
            setTabDrag(null);
          }}
        >
          {items.map((item) =>
            item.kind === 'zone' ? (
              <ZoneTab
                key={item.zone.id}
                zone={item.zone}
                current={item.zone.id === current}
                waiting={waiting.get(item.zone.id) ?? 0}
                bar={bar}
              />
            ) : (
              <GroupChunk
                key={item.group.id}
                group={item.group}
                zones={item.zones}
                current={current}
                waiting={waiting}
                bar={bar}
              />
            ),
          )}
        </div>
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
            className="icon sm zone-add"
            aria-label={t('zones.add.aria')}
            title={t('zones.add.aria')}
            onClick={() => setAdding(true)}
            data-testid="zone-add"
          >
            +
          </button>
        )}
      </div>
      {menu && menuZone && (
        <Popover
          anchor={menu.anchor}
          label={t('zones.menu.aria', { name: menuZone.name })}
          onClose={closeMenu}
          testId="zone-menu"
        >
          <ZoneMenuBody zone={menuZone} bar={bar} isLast={zones.length <= 1} onClose={closeMenu} />
        </Popover>
      )}
      {menu && menuGroup && (
        <Popover
          anchor={menu.anchor}
          label={t('zones.group.menu.aria', { name: menuGroup.group.name })}
          onClose={closeMenu}
          testId="zone-group-menu"
        >
          <GroupMenuBody
            group={menuGroup.group}
            count={menuGroup.zones.length}
            bar={bar}
            onClose={closeMenu}
          />
        </Popover>
      )}
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
        <button
          type="button"
          className="close"
          onClick={clear}
          aria-label={t('zones.notice.close')}
          title={t('zones.notice.close')}
        >
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
        className="sm"
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
