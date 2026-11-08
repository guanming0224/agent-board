// 工作區（P2 項目二，GM 2026-11-08）：GM 手動分的一組團隊與單獨 session，畫布一次只顯示一個。
// 程式內一律叫 zone，和 layouts.workspace（版面組 'default'）分開。清單在 hub（board 快照的 zones），
// 「目前看哪一個」每台裝置自己記（localStorage）。收件匣與頁首「等你 N」一律全域，分頁上另外顯示各自的等你數。
import { useMemo } from 'react';
import { create } from 'zustand';
import { DEFAULT_ZONE_ID, type Session, type Zone } from '@agent-board/protocol';
import { useBoard } from '../shared/store';
import { useTeams } from '../team/store';
import { validZone, zoneOfSession, zonesOf, zoneWaitingCounts } from './model';

export { validZone, zoneOfSession, zonesOf, zoneWaitingCounts } from './model';

const CURRENT_KEY = 'agent-board.zone.current';
const VIEWPORTS_KEY = 'agent-board.zone.viewports';
/** 頂部列直接顯示的分頁數；多的收進「更多」（Q4）。 */
export const VISIBLE_TABS = 6;

export interface ZoneViewport {
  x: number;
  y: number;
  zoom: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不了就只在這次有效。
  }
}

/** 移走團隊或 session 後的提示：「已移到『交易』［前往］」。 */
export interface MoveNotice {
  key: number;
  zoneId: string;
  zoneName: string;
}

interface ZoneUi {
  /** 這台裝置記住的目前工作區（可能已被刪掉；用 useCurrentZoneId 取驗證過的）。 */
  stored: string;
  setCurrent(id: string): void;
  /** 每個工作區最後的畫面位置（每台裝置各自記）。 */
  viewports: Record<string, ZoneViewport>;
  saveViewport(zoneId: string, viewport: ZoneViewport): void;
  notice: MoveNotice | null;
  showNotice(zoneId: string, zoneName: string): void;
  clearNotice(): void;
  /** 正在拖曳的團隊（拖到分頁上放開＝移過去）。 */
  dragging: string | null;
  setDragging(teamId: string | null): void;
}

export const useZoneUi = create<ZoneUi>((set) => ({
  stored: read<string>(CURRENT_KEY, DEFAULT_ZONE_ID),
  setCurrent: (id) => {
    write(CURRENT_KEY, id);
    set({ stored: id });
  },
  viewports: read<Record<string, ZoneViewport>>(VIEWPORTS_KEY, {}),
  saveViewport: (zoneId, viewport) =>
    set((s) => {
      const viewports = { ...s.viewports, [zoneId]: viewport };
      write(VIEWPORTS_KEY, viewports);
      return { viewports };
    }),
  notice: null,
  showNotice: (zoneId, zoneName) => set({ notice: { key: Date.now(), zoneId, zoneName } }),
  clearNotice: () => set({ notice: null }),
  dragging: null,
  setDragging: (dragging) => set({ dragging }),
}));

export function useZones(): Zone[] {
  const list = useBoard((s) => s.zones);
  return useMemo(() => zonesOf(list), [list]);
}

export function useCurrentZoneId(): string {
  const zones = useZones();
  const stored = useZoneUi((s) => s.stored);
  return validZone(zones, stored);
}

/** 非 hook 版（建立 session、團隊時用）。 */
export function currentZoneId(): string {
  return validZone(zonesOf(useBoard.getState().zones), useZoneUi.getState().stored);
}

export function useZoneWaiting(): Map<string, number> {
  const sessions = useBoard((s) => s.sessions);
  const approvals = useBoard((s) => s.approvals);
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  return useMemo(
    () => zoneWaitingCounts(sessions, approvals, teams, members),
    [sessions, approvals, teams, members],
  );
}

/** session id → 所在工作區（畫布篩選、跨工作區導航用）。 */
export function useSessionZones(): (session: Pick<Session, 'id' | 'zoneId'>) => string {
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  return useMemo(
    () => (session: Pick<Session, 'id' | 'zoneId'>) => zoneOfSession(session, teams, members),
    [teams, members],
  );
}

/** 非 hook 版：某個 session 現在在哪個工作區。 */
export function sessionZone(sessionId: string): string | null {
  const session = useBoard.getState().sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  const { teams, members } = useTeams.getState();
  return zoneOfSession(session, teams, members);
}
