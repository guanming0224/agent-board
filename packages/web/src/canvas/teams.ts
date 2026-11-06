// 把 hub 的團隊與交接規則換算成畫布上的框和線。資料在 team/store.ts。
import type { HandoffRule, Team, TeamMember } from '@agent-board/protocol';
import type { Rect } from './layout';

export interface CanvasTeam {
  id: string;
  name: string;
  color: string;
  memberIds: string[];
}

export function canvasTeams(teams: readonly Team[], members: readonly TeamMember[]): CanvasTeam[] {
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    color: team.color,
    memberIds: members.filter((m) => m.teamId === team.id).map((m) => m.sessionId),
  }));
}

/** 畫布上一條線：同一對 session 的多條規則（不同觸發條件）畫成一條。 */
export interface Handoff {
  id: string;
  source: string;
  target: string;
  triggers: HandoffRule['trigger'][];
  ruleIds: string[];
  enabled: boolean;
}

const handoffId = (source: string, target: string) => `${source}->${target}`;

export function groupHandoffs(rules: readonly HandoffRule[]): Handoff[] {
  const grouped = new Map<string, Handoff>();
  for (const rule of rules) {
    const source = rule.fromSessionId;
    const target = rule.action.toSessionId;
    const id = handoffId(source, target);
    const line = grouped.get(id) ?? {
      id,
      source,
      target,
      triggers: [],
      ruleIds: [],
      enabled: false,
    };
    if (!line.triggers.includes(rule.trigger)) line.triggers.push(rule.trigger);
    line.ruleIds.push(rule.id);
    line.enabled ||= rule.enabled;
    grouped.set(id, line);
  }
  return [...grouped.values()];
}

/** 從卡片拖線建立規則要歸在哪個團隊：來源的優先，其次目標。 */
export function teamForHandoff(
  source: string,
  target: string,
  members: readonly TeamMember[],
): string | null {
  const teamOf = (id: string) => members.find((m) => m.sessionId === id)?.teamId ?? null;
  return teamOf(source) ?? teamOf(target);
}

export const TEAM_PADDING = 32;

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
