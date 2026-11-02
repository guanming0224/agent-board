import { create } from 'zustand';
import type { BoardBackend, BoardSnapshot } from './backend';
import { createFakeBackend } from './fakeBackend';
import { createHubBackend } from './hubBackend';

interface BoardState extends BoardSnapshot {
  backend: BoardBackend;
  connected: boolean;
}

/** 範例資料只出現在 demo 模式（DISPATCH §1.2）：`?demo=1`，或測試用的建置環境變數。 */
export const isDemo =
  import.meta.env.VITE_AGENT_BOARD_DEMO === '1' ||
  new URLSearchParams(location.search).get('demo') === '1';

const backend: BoardBackend = isDemo ? createFakeBackend() : createHubBackend();

export const useBoard = create<BoardState>(() => ({
  backend,
  connected: isDemo,
  machines: [],
  sessions: [],
  approvals: [],
}));

backend.watchBoard((snapshot) => useBoard.setState(snapshot));
backend.watchConnection?.((connected) => useBoard.setState({ connected }));
