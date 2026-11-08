// 「建立交接線…」的選目標模式（P2 §4.2）：觸控裝置沒有 hover 看不到拖線把手，桌面也可以當成拖線的替代。
// 從卡片選單進入，點另一張卡＝建立規則（同拖線的 onConnect），點空白、Esc 或 ✕ 取消。
import { create } from 'zustand';

interface LinkPickState {
  /** 交接從哪張卡出發；null＝沒有在選目標。 */
  from: string | null;
  start: (from: string) => void;
  cancel: () => void;
}

export const useLinkPick = create<LinkPickState>((set) => ({
  from: null,
  start: (from) => set({ from }),
  cancel: () => set({ from: null }),
}));
