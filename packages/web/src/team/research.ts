// 學術研究團隊（GM 2026-11-06）：成員的分工、換階段時的差異、建立時預設的雙向交接。純函式。
import {
  isReadOnlyMember,
  RESEARCH_KIND_ROLE,
  sameWorkingTree,
  type ResearchKind,
  type ResearchPhase,
  type Session,
  type TeamMember,
} from '@agent-board/protocol';
import { DEFAULT_MARKER, triggerChoice, twoWayRules, type RuleInput } from './handoffRules';
import { PHASE_PRESETS, type ExistingTeam, type PlanRow } from './teamPlan';

/**
 * 實驗交給寫作：回覆含 [結果完成]。不用「改到 results/**」：實驗結果多半是跑程式（Bash）產生的，
 * 只看得到 Write／Edit 的 on_file 幾乎不會觸發。
 */
export const RESULTS_MARKER = '[結果完成]';

const ROLE_KIND: Record<TeamMember['role'], ResearchKind> = {
  lead: 'ld',
  researcher: 'lr',
  worker: 'ex',
  reviewer: 'rv',
  // 研究團隊沒有測試分工；萬一有測試成員，當成實驗（同樣會寫檔）。
  tester: 'ex',
};

/** 成員實際的分工：存的 kind 和角色對得上才用；否則照角色推（worker 當實驗）。 */
export function memberKind(member: Pick<TeamMember, 'role' | 'kind'>): ResearchKind {
  return member.kind && RESEARCH_KIND_ROLE[member.kind] === member.role
    ? member.kind
    : ROLE_KIND[member.role];
}

export interface PhaseDiff {
  /** 新階段的組合裡用不到的現有成員（依原順序；同分工多出來的取後面的）。 */
  extra: string[];
  /** 新階段還缺的分工（依組合的順序）。 */
  missing: ResearchKind[];
}

/** 換階段：現有成員依分工對上新組合，多的列出來給使用者決定要不要封存，少的要補。 */
export function phaseDiff(
  members: readonly Pick<TeamMember, 'sessionId' | 'role' | 'kind'>[],
  phase: ResearchPhase,
): PhaseDiff {
  const remaining = new Map<ResearchKind, number>();
  for (const kind of PHASE_PRESETS[phase]) remaining.set(kind, (remaining.get(kind) ?? 0) + 1);
  const extra: string[] = [];
  for (const member of members) {
    const kind = memberKind(member);
    const left = remaining.get(kind) ?? 0;
    if (left > 0) remaining.set(kind, left - 1);
    else extra.push(member.sessionId);
  }
  const missing: ResearchKind[] = [];
  for (const kind of PHASE_PRESETS[phase]) {
    const left = remaining.get(kind) ?? 0;
    if (left > 0) {
      missing.push(kind);
      remaining.set(kind, left - 1);
    }
  }
  return { extra, missing };
}

/**
 * 補成員時要一起算的現有成員：沒封存的。主資料夾寫入者＝同機器、同一個 working tree、
 * 沒有自己的 worktree、不是只讀成員（和 hub 的同資料夾規則相同）。
 */
export function existingTeam(
  members: readonly { member: Pick<TeamMember, 'role'>; session: Session }[],
  place: { machineId: string; cwd: string },
  allSessions: readonly Session[],
): ExistingTeam {
  const live = members.filter(({ session }) => !session.archived);
  return {
    members: live.length,
    leads: live.filter(({ member }) => member.role === 'lead').length,
    mainWriters: live.filter(
      ({ member, session }) =>
        session.machineId === place.machineId &&
        session.worktreePath === null &&
        !isReadOnlyMember(member.role, session) &&
        session.endedAt === null &&
        sameWorkingTree(
          { dir: session.cwd, repoRoot: session.repoRoot },
          { dir: place.cwd, repoRoot: null },
        ),
    ).length,
    names: new Set(allSessions.map((s) => s.name.trim())),
  };
}

/**
 * 研究團隊建好後預設的雙向交接：第一位實驗 ⇄ 第一位寫作。
 * EX→WR：回覆含 [結果完成]；WR→EX：回覆含 [需要實驗]。共用輪數上限，建好先關著。
 * 沒有成功建立的實驗或寫作就不建（回傳 null）。
 */
export function researchPairRules(
  rows: readonly PlanRow[],
  sessionIds: ReadonlyMap<string, string>,
  maxRounds: number,
): [RuleInput, RuleInput] | null {
  const first = (kind: ResearchKind) =>
    rows.map((r) => (r.kind === kind ? sessionIds.get(r.key) : undefined)).find(Boolean);
  const ex = first('ex');
  const wr = first('wr');
  if (!ex || !wr) return null;
  return twoWayRules(
    ex,
    wr,
    triggerChoice('on_marker', { marker: RESULTS_MARKER }),
    triggerChoice('on_marker', { marker: DEFAULT_MARKER }),
    maxRounds,
  );
}

export const planHasPair = (rows: readonly PlanRow[]) =>
  rows.some((r) => r.kind === 'ex') && rows.some((r) => r.kind === 'wr');
