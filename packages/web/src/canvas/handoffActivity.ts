// 畫布的交接動畫資料：聽後端的即時事件，只在階段變化時更新一次（動畫本身是 CSS）。
import { useEffect } from 'react';
import { create } from 'zustand';
import type { SessionEvent } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { advance, nextChangeAt, recordHandoff, type ActivityMap } from './handoffActivityState';

interface ActivityState {
  activities: ActivityMap;
  record(event: SessionEvent): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** 只排一個計時器，到下一個換階段的時間點。 */
function schedule() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const at = nextChangeAt(useHandoffActivity.getState().activities);
  if (at === null) return;
  timer = setTimeout(
    () => {
      timer = null;
      const { activities } = useHandoffActivity.getState();
      useHandoffActivity.setState({ activities: advance(activities, Date.now()) });
      schedule();
    },
    Math.max(0, at - Date.now()),
  );
}

export const useHandoffActivity = create<ActivityState>((set, get) => ({
  activities: new Map(),
  record(event) {
    const now = Date.now();
    const next = recordHandoff(advance(get().activities, now), event, now);
    if (next === get().activities) return;
    set({ activities: next });
    schedule();
  },
}));

/** 畫布開著時聽事件。離開畫布後的事件不播（看不到），回來時一分鐘內的紀錄還在。 */
export function useHandoffEvents(backend: BoardBackend) {
  useEffect(() => {
    if (!backend.watchEvents) return;
    const { record } = useHandoffActivity.getState();
    return backend.watchEvents((event) => {
      if (event.type.startsWith('handoff.')) record(event);
    });
  }, [backend]);
}
