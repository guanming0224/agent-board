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
}

const NARROW = '(max-width: 860px)';

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
}));
