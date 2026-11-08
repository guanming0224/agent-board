import { create } from 'zustand';

/** 頁面之間共用的介面狀態：切分頁不該忘記側欄開關與目前框出的卡。 */
interface ViewsUi {
  sideOpen: boolean;
  setSideOpen: (open: boolean) => void;
  /** 目前框出的卡。 */
  focusId: string | null;
  /** 「下一個等我的」從這裡接著往下走；點空白取消框選也不重來。 */
  cursorId: string | null;
  /** 還沒被畫布捲動過去的目標。 */
  pendingFocus: string | null;
  focusSession: (id: string) => void;
  clearFocus: () => void;
  takePendingFocus: () => string | null;
  /** 點兩下展開成 xterm 的卡。 */
  expandedIds: string[];
  toggleExpanded: (id: string) => void;
  /** 打開全尺寸終端機前的畫布鏡頭；回畫布時還原到同一個地方。 */
  canvasReturn: { x: number; y: number; zoom: number } | null;
  setCanvasReturn: (viewport: { x: number; y: number; zoom: number } | null) => void;
  /** 畫布開著時，由畫布登記「在畫面中央打開快速建立」；頁首的「新增 session」優先用它。 */
  openQuickCreate: (() => void) | null;
  setOpenQuickCreate: (open: (() => void) | null) => void;
  /** 畫布縮小（低於 xterm 門檻）時要不要換成摘要條。關掉就每張卡都一直是 xterm（GM 2026-11-06）。 */
  summaryWhenZoomedOut: boolean;
  setSummaryWhenZoomedOut: (on: boolean) => void;
  /** 收件匣的排序（GM 2026-11-08 Q1）：預設依急迫，可切依組別；每台瀏覽器自己記。 */
  inboxSort: InboxSort;
  setInboxSort: (sort: InboxSort) => void;
  /** 收件匣抽屜展開成寬版（看 diff 用）。 */
  inboxWide: boolean;
  setInboxWide: (wide: boolean) => void;
  /** 右側面板蓋住的畫布寬度：聚焦卡片時把卡放在看得到的那一塊中央。 */
  rightInset: number;
  setRightInset: (px: number) => void;
  /** 還沒被畫布框進畫面的團隊成員（開 #/team/<id> 時）。 */
  pendingTeamFocus: string[] | null;
  focusTeam: (memberIds: string[]) => void;
  takePendingTeamFocus: () => string[] | null;
}

export type InboxSort = 'urgency' | 'group';

const NARROW = '(max-width: 860px)';
/** 每台瀏覽器自己記；讀不到（私密視窗、封鎖儲存）就用預設的「開」。 */
const SUMMARY_KEY = 'agent-board.canvas.summary-when-zoomed-out';
const INBOX_SORT_KEY = 'agent-board.inbox.sort';

function readInboxSort(): InboxSort {
  try {
    return localStorage.getItem(INBOX_SORT_KEY) === 'group' ? 'group' : 'urgency';
  } catch {
    return 'urgency';
  }
}

function saveInboxSort(sort: InboxSort): void {
  try {
    localStorage.setItem(INBOX_SORT_KEY, sort);
  } catch {
    // 存不了就只在這次有效
  }
}

function readSummaryPref(): boolean {
  try {
    return localStorage.getItem(SUMMARY_KEY) !== 'off';
  } catch {
    return true;
  }
}

function saveSummaryPref(on: boolean): void {
  try {
    localStorage.setItem(SUMMARY_KEY, on ? 'on' : 'off');
  } catch {
    // 存不了就只在這次有效
  }
}

export const useViewsUi = create<ViewsUi>((set, get) => ({
  sideOpen: typeof matchMedia === 'undefined' ? true : !matchMedia(NARROW).matches,
  setSideOpen: (sideOpen) => set({ sideOpen }),
  focusId: null,
  cursorId: null,
  pendingFocus: null,
  focusSession: (id) => set({ focusId: id, cursorId: id, pendingFocus: id }),
  clearFocus: () => set({ focusId: null }),
  takePendingFocus: () => {
    const id = get().pendingFocus;
    if (id !== null) set({ pendingFocus: null });
    return id;
  },
  expandedIds: [],
  toggleExpanded: (id) =>
    set((s) => ({
      expandedIds: s.expandedIds.includes(id)
        ? s.expandedIds.filter((x) => x !== id)
        : [...s.expandedIds, id],
    })),
  canvasReturn: null,
  setCanvasReturn: (canvasReturn) => set({ canvasReturn }),
  openQuickCreate: null,
  setOpenQuickCreate: (openQuickCreate) => set({ openQuickCreate }),
  summaryWhenZoomedOut: readSummaryPref(),
  setSummaryWhenZoomedOut: (summaryWhenZoomedOut) => {
    saveSummaryPref(summaryWhenZoomedOut);
    set({ summaryWhenZoomedOut });
  },
  inboxSort: readInboxSort(),
  setInboxSort: (inboxSort) => {
    saveInboxSort(inboxSort);
    set({ inboxSort });
  },
  inboxWide: false,
  setInboxWide: (inboxWide) => set({ inboxWide }),
  rightInset: 0,
  setRightInset: (rightInset) => set({ rightInset }),
  pendingTeamFocus: null,
  focusTeam: (memberIds) => set({ pendingTeamFocus: memberIds }),
  takePendingTeamFocus: () => {
    const ids = get().pendingTeamFocus;
    if (ids !== null) set({ pendingTeamFocus: null });
    return ids;
  },
}));
