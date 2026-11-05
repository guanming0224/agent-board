// 依序建立團隊（或用已經存在的團隊：補成員、換階段）→ 每一列的 session → 加入團隊。session 走一般的 createSession（和畫布、#/new 同一條路，
// worktree、hooks、額度排隊都照常）。部分失敗時保留已建立的，不刪任何東西。
import type { Team } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
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
  team: Omit<Team, 'id'> | { existing: Team };
  machineId: string;
  cwd: string;
  projectId: string | null;
  /** 資料夾是 git（或還不確定）：BD 開 worktree。 */
  gitOk: boolean;
  rows: readonly PlanRow[];
}

/** 建立團隊本身失敗就丟出例外（什麼都還沒建）；之後每一列的失敗記在進度裡，繼續下一列。 */
export async function runPlan(
  backend: BoardBackend,
  input: PlanInput,
  onStep: (key: string, step: RowStep) => void,
): Promise<{ team: Team; failed: number; sessionIds: Map<string, string> }> {
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
        model: null,
        accountProfile: null,
        resumeClaudeSessionId: null,
        firstPrompt: null,
        readOnly: isReadOnlyRole(row.role),
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
  return { team, failed, sessionIds };
}
