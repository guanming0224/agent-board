// 工作區的純函式（不碰 store，單元測試直接用）。
import {
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  waitingSessions,
  type Approval,
  type Session,
  type Team,
  type TeamMember,
  type Zone,
} from '@agent-board/protocol';

/** 舊版 hub 沒送工作區時的替身：只有預設工作區。 */
const FALLBACK: Zone[] = [
  {
    id: DEFAULT_ZONE_ID,
    name: DEFAULT_ZONE_NAME,
    createdAt: new Date(0).toISOString(),
    position: 0,
  },
];

const byPosition = (a: Zone, b: Zone) =>
  a.position - b.position || a.createdAt.localeCompare(b.createdAt);

export function zonesOf(list: readonly Zone[] | undefined): Zone[] {
  return list && list.length > 0 ? [...list].sort(byPosition) : FALLBACK;
}

/** 驗證過的目前工作區：記住的那個被刪了就用第一個。 */
export function validZone(zones: readonly Zone[], stored: string): string {
  return zones.some((z) => z.id === stored) ? stored : (zones[0]?.id ?? DEFAULT_ZONE_ID);
}

/**
 * session 實際所在的工作區：是團隊成員就跟著團隊（同時在幾個團隊時取名稱排序第一個，和 hub 相同），
 * 否則看自己的 zoneId。
 */
export function zoneOfSession(
  session: Pick<Session, 'id' | 'zoneId'>,
  teams: readonly Team[],
  members: readonly TeamMember[],
): string {
  const teamIds = new Set(members.filter((m) => m.sessionId === session.id).map((m) => m.teamId));
  if (teamIds.size > 0) {
    const team = teams
      .filter((t) => teamIds.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (team) return team.zoneId ?? DEFAULT_ZONE_ID;
  }
  return session.zoneId ?? DEFAULT_ZONE_ID;
}

/** 每個工作區「等你」的數量（和頁首同一套定義，protocol attention.ts）。 */
export function zoneWaitingCounts(
  sessions: readonly Session[],
  approvals: readonly Pick<Approval, 'sessionId'>[],
  teams: readonly Team[],
  members: readonly TeamMember[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of waitingSessions(sessions, approvals)) {
    const zone = zoneOfSession(s, teams, members);
    counts.set(zone, (counts.get(zone) ?? 0) + 1);
  }
  return counts;
}
