// 進度卡的介面狀態：畫布上展開的是哪一張、Memory 面板看目前工作區還是全部（記在這台瀏覽器）。
import { create } from 'zustand';

const SCOPE_KEY = 'agent-board.memory.scope';

export type MemoryScope = 'current' | 'all';

function readScope(): MemoryScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'all' ? 'all' : 'current';
  } catch {
    return 'current';
  }
}

interface ProgressUi {
  /** 畫布上展開的卡（擁有者鍵 `team:<id>`／`session:<id>`）；一次一張。 */
  expanded: string | null;
  setExpanded: (key: string | null) => void;
  /** 收合時第一次點開的那張：Memory 點列、收件匣點「下一步」都會設。 */
  scope: MemoryScope;
  setScope: (scope: MemoryScope) => void;
}

export const useProgressUi = create<ProgressUi>((set) => ({
  expanded: null,
  setExpanded: (expanded) => set({ expanded }),
  scope: readScope(),
  setScope: (scope) => {
    try {
      localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      // 存不了就只在這次有效
    }
    set({ scope });
  },
}));
