import { create } from 'zustand';
import type { BoardBackend, BoardSnapshot } from './backend';
import { createFakeBackend } from './fakeBackend';

interface BoardState extends BoardSnapshot {
  backend: BoardBackend;
  connected: boolean;
}

// Phase 2 由 Lead 在這裡換成真後端；目前畫面都接假資料。
const backend = createFakeBackend();

export const useBoard = create<BoardState>(() => ({
  backend,
  connected: true,
  machines: [],
  sessions: [],
  approvals: [],
}));

backend.watchBoard((snapshot) => useBoard.setState(snapshot));
