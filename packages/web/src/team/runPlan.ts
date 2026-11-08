// 依序建立團隊（或用已經存在的團隊：補成員、換階段）→ 每一列的 session → 加入團隊。session 走一般的 createSession（和畫布、#/new 同一條路，
// worktree、hooks、額度排隊都照常）。部分失敗時保留已建立的，不刪任何東西。
// 套用 Preset（P3 項目二）另外：隊長列帶第一個指令、建交接規則、寫初始進度卡（任務自動執行隨建立團隊一起設）。
import type { Team, TeamPresetProgress, TeamPresetRule } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { createRules, type RuleFailure } from './handoffRules';
import { presetRuleInputs } from './presetPlan';
import { isReadOnlyRole, isResearchKind, rowUsesWorktree, type PlanRow } from './teamPlan';

export type RowStep =
  | { step: 'waiting' }
  | { step: 'session' }
  | { step: 'member'; sessionId: string }
  | { step: 'done'; sessionId: string }
  | { step: 'sessionFailed'; error: unknown }
  | { step: 'memberFailed'; sessionId: string; error: unknown };

export interface PlanInput {
  /** 新團隊的內容，或已經存在的團隊（補成員：不再建立團隊）。 */
  team: (Omit<Team, 'id' | 'zoneId'> & { zoneId?: string }) | { existing: Team };
  machineId: string;
  cwd: string;
  projectId: string | null;
  /** 資料夾是 git（或還不確定）：BD 開 worktree。 */
  gitOk: boolean;
  rows: readonly PlanRow[];
  /** 隊長列的第一個指令（建立 session 時一起給，daemon 開好後送）；null／沒有＝不送。全部暫停中呼叫端不給（D7）。 */
  leadFirstPrompt?: string | null;
  /** 交接規則（列序號），列都建完後建立；來源或目標沒建成的略過。 */
  rules?: readonly TeamPresetRule[];
  /** 初始進度卡（P3 項目一的 PUT /api/teams/:id/progress）；全部空白就不寫。 */
  progress?: TeamPresetProgress;
}

export type ProgressResult =
  { state: 'none' } | { state: 'written' } | { state: 'failed'; error: unknown };

export interface PlanResult {
  team: Team;
  failed: number;
  sessionIds: Map<string, string>;
  rules: { created: number; failed: RuleFailure[]; skipped: number };
  progress: ProgressResult;
}

const isBlank = (fields: TeamPresetProgress) =>
  [fields.status, fields.next, fields.blockers, fields.gmNotes].every((v) => v.trim() === '');

/** 建立團隊本身失敗就丟出例外（什麼都還沒建）；之後每一列的失敗記在進度裡，繼續下一列。 */
export async function runPlan(
  backend: BoardBackend,
  input: PlanInput,
  onStep: (key: string, step: RowStep) => void,
): Promise<PlanResult> {
  const team =
    'existing' in input.team ? input.team.existing : await backend.createTeam(input.team);
  let failed = 0;
  /** 列的 key → 建好而且加入團隊的 session id。 */
  const sessionIds = new Map<string, string>();
  for (const row of input.rows) {
    onStep(row.key, { step: 'session' });
    let sessionId: string;
    try {
      const created = await backend.createSession({
        name: row.name.trim(),
        machineId: input.machineId,
        projectId: input.projectId,
        cwd: input.cwd,
        useWorktree: rowUsesWorktree(row, input.gitOk),
        permissionMode: row.mode,
        model: row.model ?? null,
        accountProfile: null,
        resumeClaudeSessionId: null,
        // 只有隊長列帶第一個指令（Preset）；其他列、內建組合都沒有。
        firstPrompt: row.role === 'lead' ? (input.leadFirstPrompt ?? null) : null,
        readOnly: isReadOnlyRole(row.role),
        // 成員跟著團隊的工作區（加入團隊前也先放在那裡，畫面不會閃到別的工作區）。
        zoneId: team.zoneId,
      });
      sessionId = created.id;
    } catch (error) {
      failed += 1;
      onStep(row.key, { step: 'sessionFailed', error });
      continue;
    }
    onStep(row.key, { step: 'member', sessionId });
    try {
      // 研究團隊的分工一起存（實驗、寫作都是 worker，靠它分開）。
      await backend.putTeamMember(
        team.id,
        sessionId,
        row.role,
        isResearchKind(row.kind) ? row.kind : undefined,
      );
      sessionIds.set(row.key, sessionId);
      onStep(row.key, { step: 'done', sessionId });
    } catch (error) {
      failed += 1;
      onStep(row.key, { step: 'memberFailed', sessionId, error });
    }
  }
  // 交接規則：照列序號換成建好的 session。和列一樣，失敗就記下來、已建的保留。
  let rules: PlanResult['rules'] = { created: 0, failed: [], skipped: 0 };
  if (input.rules && input.rules.length > 0) {
    const { inputs, skipped } = presetRuleInputs(
      input.rules,
      input.rows.map((row) => sessionIds.get(row.key)),
    );
    const made = await createRules(backend, team.id, inputs);
    rules = { created: made.created.length, failed: made.failed, skipped };
  }
  let progress: ProgressResult = { state: 'none' };
  if (input.progress && !isBlank(input.progress)) {
    // P3 項目一的 PUT /api/teams/:id/progress：新團隊還沒有卡，baseRevision 0 → revision 1。
    try {
      await backend.saveProgress({ teamId: team.id }, { baseRevision: 0, ...input.progress });
      progress = { state: 'written' };
    } catch (error) {
      progress = { state: 'failed', error };
    }
  }
  return { team, failed, sessionIds, rules, progress };
}
