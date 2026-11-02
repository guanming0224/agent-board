#!/usr/bin/env node
// 整合測試用的假 claude：不連網、不呼叫 LLM，但會真的執行 agent-board-hook，
// 所以 settings.local.json、hook CLI、socket、核准流程都是真的路徑。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (fake)');
  process.exit(0);
}

const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = flag('--session-id') ?? flag('--resume') ?? randomUUID();
const permissionMode = flag('--permission-mode') ?? 'default';

// Claude Code 從 settings.local.json 讀 hook 設定；這裡同樣照檔案裡的 command 執行。
const settings = JSON.parse(readFileSync('.claude/settings.local.json', 'utf8'));

function hook(event, extra = {}) {
  const command = settings.hooks[event]?.[0]?.hooks?.[0]?.command;
  if (!command) throw new Error(`settings.local.json 沒有 ${event} 的 hook`);
  const payload = {
    session_id: sessionId,
    transcript_path: '/dev/null',
    cwd: process.cwd(),
    permission_mode: permissionMode,
    hook_event_name: event,
    ...extra,
  };
  const result = spawnSync(command, {
    shell: true,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout.trim() };
}

function tool(name, input) {
  const pre = hook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: randomUUID() });
  console.log(`PRE ${pre.stdout || 'none'}`);
  const decision = pre.stdout
    ? JSON.parse(pre.stdout).hookSpecificOutput?.permissionDecision
    : null;
  if (decision === 'deny') return;
  const request = hook('PermissionRequest', { tool_name: name, tool_input: input });
  console.log(`DECISION ${request.stdout || 'none'}`);
  hook('PostToolUse', { tool_name: name, tool_input: input, tool_use_id: randomUUID() });
}

console.log(`fake claude ${sessionId} args=${args.join(' ')}`);
hook('SessionStart', { source: flag('--resume') ? 'resume' : 'startup', context_tokens: 1234 });
console.log('READY');

process.stdin.setEncoding('utf8');
// PTY 關閉（daemon 被殺）就結束，和真 claude 收到 SIGHUP 一樣。
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/[\r\n]+/).filter(Boolean)) {
    console.log(`GOT ${line}`);
    if (line === 'quit') process.exit(0);
    if (line === 'crash') process.exit(3);
    hook('UserPromptSubmit', { prompt: line });
    if (line === 'ask-permission') tool('Bash', { command: 'npm test' });
    if (line === 'danger') tool('Bash', { command: 'git push --force origin main' });
    hook('Stop', { last_assistant_message: `done: ${line}`, stop_hook_active: false });
  }
});
