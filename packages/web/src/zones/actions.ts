// 工作區的動作：移團隊、移 session、切換。移過去後畫面停在原工作區，顯示「已移到『X』［前往］」（P2 §2.3）。
import type { Zone } from '@agent-board/protocol';
import { useBoard } from '../shared/store';
import { refreshTeams, useTeams } from '../team/store';
import { useZoneUi, zonesOf } from './store';

const zoneName = (zoneId: string): string =>
  zonesOf(useBoard.getState().zones).find((z) => z.id === zoneId)?.name ?? '';

/** 把團隊（含所有成員）移到別的工作區。 */
export async function moveTeamToZone(teamId: string, zoneId: string): Promise<void> {
  const team = useTeams.getState().teams.find((t) => t.id === teamId);
  if (!team || team.zoneId === zoneId) return;
  const { backend } = useBoard.getState();
  const updated = await backend.updateTeam(teamId, { zoneId });
  // 不等輪詢：馬上換掉，畫布才會立刻把它收走。
  useTeams.setState((s) => ({ teams: s.teams.map((t) => (t.id === teamId ? updated : t)) }));
  useZoneUi.getState().showNotice(zoneId, zoneName(zoneId));
  void refreshTeams(backend).catch(() => undefined);
}

/** 把單獨 session 移到別的工作區（卡片「⋯」選單）。 */
export async function moveSessionToZone(sessionId: string, zoneId: string): Promise<void> {
  const { backend } = useBoard.getState();
  const updated = await backend.updateSession(sessionId, { zoneId });
  useBoard.setState((s) => ({
    sessions: s.sessions.map((x) => (x.id === sessionId ? updated : x)),
  }));
  useZoneUi.getState().showNotice(zoneId, zoneName(zoneId));
}

/** 工作區裡擋住刪除的東西：團隊數、單獨 session 數（沒封存、不是任何團隊成員）。和 hub 的規則相同。 */
export function zoneContents(zoneId: string): { teams: number; sessions: number } {
  const { teams, members } = useTeams.getState();
  const memberIds = new Set(members.map((m) => m.sessionId));
  return {
    teams: teams.filter((t) => t.zoneId === zoneId).length,
    sessions: useBoard
      .getState()
      .sessions.filter((s) => s.zoneId === zoneId && !s.archived && !memberIds.has(s.id)).length,
  };
}

export function switchZone(zone: Pick<Zone, 'id'>): void {
  useZoneUi.getState().setCurrent(zone.id);
}
