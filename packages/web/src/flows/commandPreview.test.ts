// 新增 session 右側預覽：Codex 和 daemon 用同一套權限換算（CONTRACTS §19）。
import { describe, expect, it } from 'vitest';
import { commandPreview } from './commandPreview';

const base = {
  name: 'n',
  cwd: '/work',
  useWorktree: false,
  permissionMode: 'default' as const,
  model: null,
  accountProfile: null,
  resumeClaudeSessionId: null,
  readOnly: false,
};

describe('commandPreview', () => {
  it('Claude Code 照舊', () => {
    expect(commandPreview(base)).toEqual([
      'cd /work',
      'claude --session-id <uuid> --permission-mode manual --name n',
    ]);
  });

  it('Codex：沙盒／核准換算、模型、hook 信任只對這次', () => {
    expect(commandPreview({ ...base, agent: 'codex', model: 'gpt-x' })).toEqual([
      'cd /work',
      'codex -s read-only -a on-request -m gpt-x --dangerously-bypass-hook-trust -c <hooks>',
    ]);
  });

  it('團隊模式（§27）：Claude --append-system-prompt、Codex -c developer_instructions（守則全文另外顯示）', () => {
    const teamLead = { autoStaff: true, presetMembers: false };
    expect(commandPreview({ ...base, teamLead })[1]).toBe(
      'claude --session-id <uuid> --permission-mode manual --append-system-prompt <team-mode guide> --name n',
    );
    expect(commandPreview({ ...base, agent: 'codex', teamLead })[1]).toBe(
      `codex -s read-only -a on-request -c 'developer_instructions="<team-mode guide>"' --dangerously-bypass-hook-trust -c <hooks>`,
    );
  });

  it('推理強度與備援模型（§26）：和 daemon 的參數一樣的順序', () => {
    expect(
      commandPreview({ ...base, model: 'opus', effort: 'xhigh', fallbackModel: 'sonnet' })[1],
    ).toBe(
      'claude --session-id <uuid> --permission-mode manual --model opus --effort xhigh --fallback-model sonnet --name n',
    );
    expect(commandPreview({ ...base, agent: 'codex', model: 'gpt-x', effort: 'minimal' })[1]).toBe(
      `codex -s read-only -a on-request -m gpt-x -c 'model_reasoning_effort="minimal"' --dangerously-bypass-hook-trust -c <hooks>`,
    );
  });

  it('Codex：acceptEdits、auto 用可寫工作區（GM 2026-11-10）', () => {
    for (const permissionMode of ['acceptEdits', 'auto'] as const) {
      expect(commandPreview({ ...base, agent: 'codex', permissionMode })[1]).toBe(
        'codex -s workspace-write -a on-request --dangerously-bypass-hook-trust -c <hooks>',
      );
    }
  });

  it('Codex 接續與 bypass', () => {
    const id = '0199a3c2-1111-7000-8000-000000000abc';
    expect(
      commandPreview({
        ...base,
        agent: 'codex',
        permissionMode: 'bypassPermissions',
        resumeClaudeSessionId: id,
      })[1],
    ).toBe(
      `codex resume ${id} --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -c <hooks>`,
    );
  });
});
