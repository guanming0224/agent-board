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
