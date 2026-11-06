// 畫布的往來動畫與紀錄：聽後端的即時事件，只在階段變化時更新一次（動畫本身是 CSS）。
import { useEffect } from 'react';
import { create } from 'zustand';
import type { SessionEvent } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import {
  advance,
  nextChangeAt,
  parseHandoffEvent,
  recordHandoff,
  type ActivityMap,
} from './handoffActivityState';
import {
  nextHistoryChangeAt,
  parseFilters,
  pruneHistory,
  recordInteraction,
  type HistoryMap,
  type LinkFilters,
} from './interactions';

interface ActivityState {
  activities: ActivityMap;
  /** 最近一小時的往來（點線看）。 */
  history: HistoryMap;
  /** 次數徽章算「最近 10 分鐘」用的時間；只在有一則滿 10 分鐘時才前進，不每秒重繪。 */
  clock: number;
  record(event: SessionEvent): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** 只排一個計時器，到下一個換階段（或有一則往來過期）的時間點。 */
function schedule() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const { activities, history } = useHandoffActivity.getState();
  const now = Date.now();
  const times = [nextChangeAt(activities), nextHistoryChangeAt(history, now)].filter(
    (at): at is number => at !== null,
  );
  if (times.length === 0) return;
  timer = setTimeout(
    () => {
      timer = null;
      const state = useHandoffActivity.getState();
      const at = Date.now();
      useHandoffActivity.setState({
        activities: advance(state.activities, at),
        history: pruneHistory(state.history, at),
        clock: at,
      });
      schedule();
    },
    Math.max(0, Math.min(...times) - now),
  );
}

export const useHandoffActivity = create<ActivityState>((set, get) => ({
  activities: new Map(),
  history: new Map(),
  clock: Date.now(),
  record(event) {
    const parsed = parseHandoffEvent(event);
    if (!parsed) return;
    const now = Date.now();
    set({
      activities: recordHandoff(advance(get().activities, now), event, now),
      history: recordInteraction(pruneHistory(get().history, now), parsed, now),
      clock: now,
    });
    schedule();
  },
}));

/** 畫布開著時聽事件。離開畫布後的事件不播（看不到），回來時一小時內的紀錄還在。 */
export function useHandoffEvents(backend: BoardBackend) {
  useEffect(() => {
    if (!backend.watchEvents) return;
    const { record } = useHandoffActivity.getState();
    return backend.watchEvents((event) => {
      // 交接、派工（CONTRACTS §11）、任務自動執行：記在哪一邊的規則在 handoffActivityState。
      if (/^(handoff|dispatch|task)\./.test(event.type)) record(event);
    });
  }, [backend]);
}

// ── 篩選開關：每台瀏覽器自己記；讀不到（私密視窗、封鎖儲存）就全開 ──
const FILTER_KEY = 'agent-board.canvas.link-filters';

function readFilters(): LinkFilters {
  try {
    return parseFilters(localStorage.getItem(FILTER_KEY));
  } catch {
    return parseFilters(null);
  }
}

interface FilterState {
  filters: LinkFilters;
  toggle(key: keyof LinkFilters): void;
}

export const useLinkFilters = create<FilterState>((set, get) => ({
  filters: readFilters(),
  toggle(key) {
    const filters = { ...get().filters, [key]: !get().filters[key] };
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      // 存不了就只在這次有效
    }
    set({ filters });
  },
}));
