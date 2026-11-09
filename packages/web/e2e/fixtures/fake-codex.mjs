#!/usr/bin/env node
// 整合測試用的假 codex：不連網、不呼叫 LLM，但會照 `-c hooks.<Event>=[…]` 真的執行 agent-board-hook，
// 所以 hook CLI（--agent codex）、socket、核准流程、狀態都是真的路徑（CONTRACTS §19）。
// stdin 欄位照官方 hooks 文件：session_id、transcript_path、cwd、hook_event_name、model、turn_id…
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}

const resumeId = args[0] === 'resume' ? args[1] : null;
const threadId = resumeId ?? randomUUID();
const dash = args.indexOf('--');
const firstPrompt = dash === -1 ? null : args.slice(dash + 1).join(' ');
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const permissionMode = args.includes('--dangerously-bypass-approvals-and-sandbox')
  ? 'bypassPermissions'
  : `${flag('-s')}/${flag('-a')}`;

// hook 設定只從 -c 讀（daemon 不寫任何設定檔）。
const commands = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '-c') continue;
  const match = /^hooks\.(\w+)=.*command="([^"]+)"/.exec(args[i + 1] ?? '');
  if (match) commands[match[1]] = match[2];
}

let turn = 0;
function hook(event, extra = {}) {
  const command = commands[event];
  if (!command) throw new Error(`-c 沒有 ${event} 的 hook`);
  const payload = {
    session_id: threadId,
    transcript_path: null,
    cwd: process.cwd(),
    hook_event_name: event,
    model: 'fake-model',
    turn_id: `turn-${turn}`,
    permission_mode: permissionMode,
    ...extra,
  };
  const result = spawnSync(command, {
    shell: true,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout.trim() };
}

/** 像 codex 一樣在第一句話後留下對話紀錄，daemon 重啟才接得回來（`codex resume <id>`）。 */
function writeRollout() {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const day = join(home, 'sessions', '2026', '11', '10');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-11-10T00-00-00-${threadId}.jsonl`), '{}\n');
}

function tool(input) {
  const pre = hook('PreToolUse', {
    tool_name: 'Bash',
    tool_input: input,
    tool_use_id: randomUUID(),
  });
  console.log(`PRE ${pre.stdout || 'none'}`);
  const decision = pre.stdout
    ? JSON.parse(pre.stdout).hookSpecificOutput?.permissionDecision
    : null;
  if (decision === 'deny') {
    console.log('BLOCKED');
    return;
  }
  const request = hook('PermissionRequest', { tool_name: 'Bash', tool_input: input });
  console.log(`DECISION ${request.stdout || 'none'}`);
  hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: randomUUID() });
}

function handle(line) {
  console.log(`GOT ${line}`);
  if (line === 'quit') process.exit(0);
  if (line === 'crash') process.exit(3);
  turn += 1;
  hook('UserPromptSubmit', { prompt: line });
  writeRollout();
  if (line === 'ask-permission') tool({ command: 'touch a.txt' });
  if (line === 'danger') tool({ command: 'git push --force origin main' });
  if (line === 'model-error') {
    hook('PostModelRequest', { error: 'unexpected status 500 Internal Server Error' });
  } else {
    hook('PostModelRequest', { status: 'completed' });
  }
  hook('Stop', { last_assistant_message: `done: ${line}`, stop_hook_active: false });
}

console.log(`fake codex ${threadId} args=${args.join(' ')}`);
console.log('>_ OpenAI Codex (fake)');
hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
console.log('READY');
if (firstPrompt) handle(firstPrompt);

process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/[\r\n]+/).filter(Boolean)) handle(line);
});
