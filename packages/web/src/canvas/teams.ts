// 團隊與交接的後端是 Phase 3。這裡是畫布內的本地狀態：團隊只有示範資料（對應 fakeBackend 的 session id，
// 正式環境的 id 對不上就什麼都不畫），交接線重新載入後會消失。
import type { HandoffRule } from '@agent-board/protocol';
import { create } from 'zustand';
import type { Rect } from './layout';

export interface CanvasTeam {
  id: string;
  nameKey: string;
  /** 使用者選的團隊框色（STYLE.md §4），不是狀態色。 */
  color: string;
  memberIds: string[];
}

export interface Handoff {
  id: string;
  source: string;
  target: string;
  trigger: HandoffRule['trigger'];
}

const DEMO_TEAMS: CanvasTeam[] = [
  {
    id: 'team-demo-auth',
    nameKey: 'canvas.team.demoAuth',
    color: 'var(--team-teal)',
    memberIds: ['s-auth', 's-tests'],
  },
];

const handoffId = (source: string, target: string) => `${source}->${target}`;

interface TeamsState {
  teams: CanvasTeam[];
  handoffs: Handoff[];
  addHandoff: (source: string, target: string) => void;
  removeHandoffs: (ids: readonly string[]) => void;
}

export const useTeams = create<TeamsState>((set) => ({
  teams: DEMO_TEAMS,
  handoffs: [
    {
      id: handoffId('s-auth', 's-tests'),
      source: 's-auth',
      target: 's-tests',
      trigger: 'on_done',
    },
  ],
  addHandoff: (source, target) =>
    set((state) => {
      const id = handoffId(source, target);
      if (source === target || state.handoffs.some((h) => h.id === id)) return state;
      return { handoffs: [...state.handoffs, { id, source, target, trigger: 'on_done' }] };
    }),
  removeHandoffs: (ids) =>
    set((state) => ({ handoffs: state.handoffs.filter((h) => !ids.includes(h.id)) })),
}));

const TEAM_PADDING = 32;

/** 框住所有成員；成員不足兩位就不畫框。 */
export function teamRect(team: CanvasTeam, rects: ReadonlyMap<string, Rect>): Rect | null {
  const members = team.memberIds.flatMap((id) => rects.get(id) ?? []);
  if (members.length < 2) return null;
  const x = Math.min(...members.map((r) => r.x)) - TEAM_PADDING;
  const y = Math.min(...members.map((r) => r.y)) - TEAM_PADDING;
  const right = Math.max(...members.map((r) => r.x + r.w)) + TEAM_PADDING;
  const bottom = Math.max(...members.map((r) => r.y + r.h)) + TEAM_PADDING;
  return { x, y, w: right - x, h: bottom - y };
}
