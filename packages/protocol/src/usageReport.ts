// 用量詳情（GM 2026-11-09）：把各機器最新的細項合成一份給網頁，並把 Claude session id 對應到
// Agent Board 的 session、團隊、工作區、專案。純函式，hub 與網頁的 demo 後端共用（對應規則只有一份）。
// 對不到的（在 Agent Board 外直接開的 claude，或 session 換過 Claude id 之前的紀錄）boardSessionId 是 null，
// 畫面歸「中控台外的 session」並依 cwd 顯示。
import { z } from 'zod';
import type { AgentKind, Machine, Project, Session, Team, TeamMember, Zone } from './models';
import { agentOf, UsageSummary } from './models';
import {
  CodexUsage,
  USAGE_DETAIL_VERSION,
  UsageDetail,
  type UsageReport,
  type UsageReportMachine,
  type UsageReportRow,
  type UsageReportSession,
} from './usage';

/** 存在 settings 表、也放在記憶體的每台最新一筆。detail 是 null：daemon 太舊沒送細項。 */
export const StoredUsage = z.object({
  summary: UsageSummary,
  detail: UsageDetail.nullable(),
  /** Codex 的用量（Codex 第二輪）；舊資料、沒有 Codex 是 null。 */
  codex: CodexUsage.nullable().optional(),
});
export type StoredUsage = z.infer<typeof StoredUsage>;

export interface LatestUsage extends StoredUsage {
  /** hub 重啟後從資料庫讀回來、還沒收到新掃描。 */
  restored: boolean;
}

/** 看得懂的細項才留；版本不認得的當沒有（畫面會寫「daemon 版本太舊」以外的同一種提示）。 */
export const usableDetail = (detail: UsageDetail | null | undefined): UsageDetail | null =>
  detail && detail.version === USAGE_DETAIL_VERSION ? detail : null;

export interface UsageReportInput {
  now: Date;
  machines: readonly Machine[];
  latest: ReadonlyMap<string, LatestUsage>;
  /** 含封存的全部 session。 */
  sessions: readonly Session[];
  teams: readonly Team[];
  members: readonly TeamMember[];
  zones: readonly Zone[];
  projects: readonly Project[];
}

/** 同一個 Claude id 對到好幾個 Agent Board session（resume 開的新卡）：沒封存、較新的優先。 */
function pickSession(candidates: readonly Session[]): Session {
  return [...candidates].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || (a.createdAt < b.createdAt ? 1 : -1),
  )[0]!;
}

export function buildUsageReport(input: UsageReportInput): UsageReport {
  const teamById = new Map(input.teams.map((t) => [t.id, t]));
  const zoneById = new Map(input.zones.map((z) => [z.id, z]));
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  // 一個 session 可以在好幾個團隊：取名稱排序第一個（和 store.teamsOfSession 同順序）。
  const teamOf = new Map<string, Team>();
  for (const m of input.members) {
    const team = teamById.get(m.teamId);
    if (!team) continue;
    const seen = teamOf.get(m.sessionId);
    if (!seen || team.name < seen.name) teamOf.set(m.sessionId, team);
  }
  // Codex session 的 claudeSessionId 存的是 Codex 的 thread id（CONTRACTS §19.1）：依 agent 分開對。
  const byClaudeId = new Map<string, Session[]>();
  for (const s of input.sessions) {
    if (!s.claudeSessionId) continue;
    const key = `${agentOf(s)}\0${s.machineId}\0${s.claudeSessionId.toLowerCase()}`;
    const list = byClaudeId.get(key);
    if (list) list.push(s);
    else byClaudeId.set(key, [s]);
  }

  const machines: UsageReportMachine[] = [];
  const sessions: UsageReportSession[] = [];
  const rows: UsageReportRow[] = [];
  const dayIndex = new Map<string, number>();
  const modelIndex = new Map<string, number>();
  const daysSet = new Set<string>();
  for (const latest of input.latest.values()) {
    usableDetail(latest.detail)?.days.forEach((d) => daysSet.add(d));
    usableDetail(latest.codex?.detail)?.days.forEach((d) => daysSet.add(d));
  }
  const days = [...daysSet].sort();
  days.forEach((d, i) => dayIndex.set(d, i));
  const models: string[] = [];

  input.machines.forEach((machine, machineIdx) => {
    const latest = input.latest.get(machine.id) ?? null;
    const detail = usableDetail(latest?.detail);
    const codex = latest?.codex ?? null;
    const codexDetail = usableDetail(codex?.detail);
    machines.push({
      machineId: machine.id,
      name: machine.name,
      online: machine.online,
      state: latest === null ? 'not_reported' : detail === null ? 'old_daemon' : 'detail',
      summary: latest?.summary ?? null,
      countedAt: detail === null ? null : (latest?.summary.to ?? null),
      restored: latest?.restored ?? false,
      timeZone: detail?.timeZone ?? codexDetail?.timeZone ?? null,
      earliestAt: detail?.earliestAt ?? null,
      otherSessions: detail?.otherSessions ?? 0,
      codexSummary: codex ? { ...codex.summary, machineId: machine.id } : null,
      codexOtherSessions: codexDetail?.otherSessions ?? 0,
    });
    if (detail !== null) addDetail(machine, machineIdx, detail, 'claude');
    if (codexDetail !== null) addDetail(machine, machineIdx, codexDetail, 'codex');
  });

  function addDetail(
    machine: Machine,
    machineIdx: number,
    detail: UsageDetail,
    agent: AgentKind,
  ): void {
    const localSession: number[] = [];
    let otherIdx: number | null = null;
    const sessionIdx = (s: number): number => {
      if (s >= 0 && s < detail.sessions.length) {
        if (localSession[s] === undefined) {
          const raw = detail.sessions[s]!;
          const matches = byClaudeId.get(`${agent}\0${machine.id}\0${raw.id.toLowerCase()}`);
          const board = matches ? pickSession(matches) : null;
          const team = board ? (teamOf.get(board.id) ?? null) : null;
          const zoneId = board ? (team?.zoneId ?? board.zoneId) : null;
          const project = board?.projectId ? (projectById.get(board.projectId) ?? null) : null;
          localSession[s] = sessions.length;
          sessions.push({
            machineId: machine.id,
            agent,
            claudeSessionId: raw.id,
            // 對話紀錄沒寫 cwd 時用 Agent Board 記的。
            cwd: raw.cwd ?? board?.cwd ?? null,
            boardSessionId: board?.id ?? null,
            name: board?.name ?? null,
            archived: board?.archived ?? false,
            teamId: team?.id ?? null,
            teamName: team?.name ?? null,
            zoneId,
            zoneName: zoneId === null ? null : (zoneById.get(zoneId)?.name ?? null),
            projectId: project?.id ?? null,
            projectName: project?.name ?? null,
          });
        }
        return localSession[s]!;
      }
      if (otherIdx === null) {
        otherIdx = sessions.length;
        sessions.push({
          machineId: machine.id,
          agent,
          claudeSessionId: null,
          cwd: null,
          boardSessionId: null,
          name: null,
          archived: false,
          teamId: null,
          teamName: null,
          zoneId: null,
          zoneName: null,
          projectId: null,
          projectName: null,
        });
      }
      return otherIdx;
    };

    for (const [d, m, s, i, o, r, w] of detail.rows) {
      const day = detail.days[d];
      const model = detail.models[m];
      if (day === undefined || model === undefined) continue;
      let mi = modelIndex.get(model);
      if (mi === undefined) {
        mi = models.length;
        models.push(model);
        modelIndex.set(model, mi);
      }
      rows.push([machineIdx, dayIndex.get(day)!, mi, sessionIdx(s), i, o, r, w]);
    }
  }

  return { generatedAt: input.now.toISOString(), days, models, machines, sessions, rows };
}
