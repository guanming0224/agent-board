// 深層搜尋（P3 ③b）的畫面狀態：純函式，SearchPanel 與單元測試共用。
import type { DeepSearchState, SearchItem } from '@agent-board/protocol';
import type { DeepSearchEvent } from '../shared/backend';

/** 深層搜尋裡一台機器的進度。 */
export interface DeepMachine {
  machineId: string;
  state: 'searching' | DeepSearchState;
  items: number;
  scanned: number;
  total: number;
}

export type DeepState =
  | { state: 'idle' }
  /** 遮蔽模式開著、查詢字像金鑰：不送出。 */
  | { state: 'blocked' }
  | {
      state: 'running' | 'finished' | 'failed';
      searchId: string;
      machines: DeepMachine[];
      items: SearchItem[];
      /** failed 的原因（連線斷了或 hub 沒回）。 */
      error?: 'disconnected' | 'no_reply';
    };

/** 把 hub 推來的深層事件併進畫面狀態（純函式，單元測試用）。不是這次 searchId 的事件不理。 */
export function reduceDeep(prev: DeepState, event: DeepSearchEvent): DeepState {
  if (prev.state === 'idle' || prev.state === 'blocked' || prev.searchId !== event.searchId) {
    return prev;
  }
  if (event.type === 'search.deepFailed') return { ...prev, state: 'failed', error: event.error };
  let machines = prev.machines;
  let items = prev.items;
  if (event.type === 'search.deepStarted') {
    machines = event.machines.map((m) => ({
      machineId: m.machineId,
      state: 'searching',
      items: 0,
      scanned: 0,
      total: m.totalSessions,
    }));
  } else if (event.type === 'search.deepResult') {
    items = [...items, ...event.items];
    machines = machines.map((m) =>
      m.machineId === event.machineId ? { ...m, items: m.items + event.items.length } : m,
    );
  } else {
    machines = machines.map((m) =>
      m.machineId === event.machineId
        ? { ...m, state: event.state, scanned: event.scannedSessions, total: event.totalSessions }
        : m,
    );
  }
  const finished =
    event.type !== 'search.deepResult' && machines.every((m) => m.state !== 'searching');
  return { ...prev, state: finished ? 'finished' : prev.state, machines, items };
}
