// 新增 session 右側預覽：daemon 實際會執行的指令（CONTRACTS.md §3.1）。尖括號的值由 daemon 建立時產生。
import { codexPermissionArgs, type SessionSpec } from '@agent-board/protocol';

export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Codex（CONTRACTS §19）：和 daemon 的 buildCodexArgs 同一套權限換算；hook 設定很長，用 <hooks> 代表。 */
function codexCommand(spec: Omit<SessionSpec, 'projectId' | 'firstPrompt'>): string {
  const codex = ['codex'];
  if (spec.resumeClaudeSessionId) codex.push(`resume ${shellQuote(spec.resumeClaudeSessionId)}`);
  codex.push(...codexPermissionArgs(spec.permissionMode, spec.readOnly));
  if (spec.model) codex.push(`-m ${shellQuote(spec.model)}`);
  // 推理強度（§26）：和 daemon 的 buildCodexArgs 一樣用設定覆寫。
  if (spec.effort) codex.push(`-c ${shellQuote(`model_reasoning_effort="${spec.effort}"`)}`);
  // 團隊模式（§27）：固定守則很長，用 <隊長守則> 代表（全文在預覽下方）。
  if (spec.teamLead) codex.push(`-c 'developer_instructions="<team-mode guide>"'`);
  codex.push('--dangerously-bypass-hook-trust', '-c <hooks>');
  return codex.join(' ');
}

export function commandPreview(spec: Omit<SessionSpec, 'projectId' | 'firstPrompt'>): string[] {
  if (spec.agent === 'codex') {
    const cwd = spec.cwd ? shellQuote(spec.cwd) : '<cwd>';
    const command = codexCommand(spec);
    if (!spec.useWorktree) return [`cd ${cwd}`, command];
    const worktree = `${cwd}/../.agent-board-wt/<slug>`;
    return [`cd ${cwd}`, `git worktree add ${worktree} -b ab/<slug>`, `cd ${worktree}`, command];
  }
  const claude = ['claude'];
  claude.push(
    spec.resumeClaudeSessionId
      ? `--resume ${shellQuote(spec.resumeClaudeSessionId)}`
      : '--session-id <uuid>',
  );
  claude.push(
    `--permission-mode ${spec.permissionMode === 'default' ? 'manual' : spec.permissionMode}`,
  );
  if (spec.model) claude.push(`--model ${shellQuote(spec.model)}`);
  if (spec.effort) claude.push(`--effort ${spec.effort}`);
  if (spec.fallbackModel) claude.push(`--fallback-model ${shellQuote(spec.fallbackModel)}`);
  // 團隊模式（§27）：同上，全文在預覽下方。
  if (spec.teamLead) claude.push('--append-system-prompt <team-mode guide>');
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
