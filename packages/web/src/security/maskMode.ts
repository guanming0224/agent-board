// 遮蔽模式的開關。存在這台瀏覽器：重新整理後不會突然露出金鑰。
import { useCallback } from 'react';
import { create } from 'zustand';
import { maskSecrets } from './mask';

const STORAGE_KEY = 'agent-board.mask-mode';

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const useMaskMode = create<{ masking: boolean; toggle(): void }>((set, get) => ({
  masking: readStored(),
  toggle() {
    const masking = !get().masking;
    try {
      localStorage.setItem(STORAGE_KEY, masking ? '1' : '0');
    } catch {
      // 私密瀏覽等情況存不了，這次開著就好。
    }
    set({ masking });
  },
}));

/** 畫面上顯示任何 session 文字前先過這個。 */
export function useMaskText(): (text: string) => string {
  const masking = useMaskMode((s) => s.masking);
  return useCallback((text: string) => (masking ? maskSecrets(text) : text), [masking]);
}
