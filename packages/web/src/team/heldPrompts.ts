// 全部暫停中套用 Preset：隊長第一個指令不隨建立送出（P3 §2.3、D7），改成隊長卡片上的「送出第一個指令」，
// GM 按下才經 hub 的群發送字佇列（SafeDelivery manual：只在隊長等輸入時送，忙就排隊）送出。
// 還沒送的指令記在這台瀏覽器（localStorage），重新整理後按鈕還在；其他裝置看不到（hub 不存）。
import { create } from 'zustand';

const KEY = 'agent-board.preset.heldPrompts';

export interface HeldPrompt {
  teamId: string;
  text: string;
  at: string;
}

function read(): Record<string, HeldPrompt> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, HeldPrompt] => {
          const v = entry[1] as Partial<HeldPrompt> | null;
          return typeof v?.teamId === 'string' && typeof v.text === 'string';
        },
      ),
    );
  } catch {
    return {};
  }
}

function write(held: Record<string, HeldPrompt>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    // 存不了（私密視窗等）：只在這次有效。
  }
}

interface HeldState {
  /** 隊長 session id → 還沒送的第一個指令。 */
  held: Record<string, HeldPrompt>;
  hold(sessionId: string, prompt: HeldPrompt): void;
  release(sessionId: string): void;
}

export const useHeldPrompts = create<HeldState>((set, get) => ({
  held: read(),
  hold(sessionId, prompt) {
    const held = { ...get().held, [sessionId]: prompt };
    write(held);
    set({ held });
  },
  release(sessionId) {
    if (!(sessionId in get().held)) return;
    const held = { ...get().held };
    delete held[sessionId];
    write(held);
    set({ held });
  },
}));
