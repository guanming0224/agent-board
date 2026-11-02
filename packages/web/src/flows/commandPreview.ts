// 新增 session 右側預覽：daemon 實際會執行的指令（CONTRACTS.md §3.1）。尖括號的值由 daemon 建立時產生。
import type { SessionSpec } from '@agent-board/protocol';

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandPreview(spec: Omit<SessionSpec, 'projectId' | 'firstPrompt'>): string[] {
  const claude = ['claude'];
  claude.push(
    spec.resumeClaudeSessionId
      ? `--resume ${shellQuote(spec.resumeClaudeSessionId)}`
      : '--session-id <uuid>',
  );
  if (spec.permissionMode !== 'default') claude.push(`--permission-mode ${spec.permissionMode}`);
  if (spec.model) claude.push(`--model ${shellQuote(spec.model)}`);
  if (spec.name) claude.push(`--name ${shellQuote(spec.name)}`);

  const env = spec.accountProfile ? `CLAUDE_CONFIG_DIR=${shellQuote(spec.accountProfile)} ` : '';
  const cwd = spec.cwd ? shellQuote(spec.cwd) : '<cwd>';
  if (!spec.useWorktree) return [`cd ${cwd}`, `${env}${claude.join(' ')}`];
  const worktree = `${cwd}/../.agent-board-wt/<slug>`;
  return [
    `cd ${cwd}`,
    `git worktree add ${worktree} -b ab/<slug>`,
    `cd ${worktree}`,
    `${env}${claude.join(' ')}`,
  ];
}
