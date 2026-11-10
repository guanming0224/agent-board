#!/usr/bin/env node
// 整合測試用的假 codex：不連網、不呼叫 LLM，但會照 `-c hooks.<Event>=[…]` 真的執行 agent-board-hook，
// 所以 hook CLI（--agent codex）、socket、核准流程、狀態都是真的路徑（CONTRACTS §19）。
// stdin 欄位照官方 hooks 文件：session_id、transcript_path、cwd、hook_event_name、model、turn_id…
// 注意：這支程式只證明 daemon 和「我們對 Codex 的假設」一致。真 codex 的 payload 實測後要存成 fixture 回放（§19.6）。
//
// 情境開關用 `-m <model>`（新增 session 時的模型欄，每個 session 各自設定）：
// - `fake-late-start`：SessionStart 等第一句話才送（NEW 要靠畫面標題的後備判斷）。
// - `fake-no-start`：完全不送 SessionStart。
// 輸入的指令：ask-permission、danger（tool_name Bash、字串指令）、shell-danger（tool_name shell、陣列指令，
// PreToolUse 之後不送 PermissionRequest）、model-error、quota、crash、quit。
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
const model = flag('-m') ?? 'fake-model';
const permissionMode = args.includes('--dangerously-bypass-approvals-and-sandbox')
  ? 'bypassPermissions'
  : `${flag('-s')}/${flag('-a')}`;

/** TOML basic string 的內容還原（daemon 會跳脫 \ 與 "）。 */
const unescapeToml = (text) => text.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));

// hook 設定只從 -c 讀（daemon 不寫任何設定檔）。
const commands = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '-c') continue;
  const match = /^hooks\.(\w+)=.*command="((?:[^"\\]|\\.)*)"/.exec(args[i + 1] ?? '');
  if (match) commands[match[1]] = unescapeToml(match[2]);
}

// 最壞情況：hook 子程序拿不到 daemon 給 codex 的 AGENT_BOARD_* 環境變數，只能靠指令上的 --session／--socket。
const hookEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_BOARD_')),
);

let turn = 0;
function hook(event, extra = {}) {
  const command = commands[event];
  if (!command) throw new Error(`-c 沒有 ${event} 的 hook`);
  const payload = {
    session_id: threadId,
    transcript_path: null,
    cwd: process.cwd(),
    hook_event_name: event,
    model,
    turn_id: `turn-${turn}`,
    permission_mode: permissionMode,
    ...extra,
  };
  const result = spawnSync(command, {
    shell: true,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: hookEnv,
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

function preToolUse(toolName, input) {
  const pre = hook('PreToolUse', {
    tool_name: toolName,
    tool_input: input,
    tool_use_id: randomUUID(),
  });
  console.log(`PRE ${pre.stdout || 'none'}`);
  const decision = pre.stdout
    ? JSON.parse(pre.stdout).hookSpecificOutput?.permissionDecision
    : null;
  if (decision === 'deny') console.log('BLOCKED');
  else console.log('RAN');
  return decision !== 'deny';
}

function tool(input) {
  if (!preToolUse('Bash', input)) return;
  const request = hook('PermissionRequest', { tool_name: 'Bash', tool_input: input });
  console.log(`DECISION ${request.stdout || 'none'}`);
  hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: randomUUID() });
}

let started = false;
function sessionStart() {
  if (started || model === 'fake-no-start') return;
  started = true;
  hook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
}

function handle(line) {
  console.log(`GOT ${line}`);
  if (line === 'quit') process.exit(0);
  if (line === 'crash') process.exit(3);
  sessionStart();
  turn += 1;
  hook('UserPromptSubmit', { prompt: line });
  writeRollout();
  if (line === 'ask-permission') tool({ command: 'touch a.txt' });
  if (line === 'danger') tool({ command: 'git push --force origin main' });
  if (line === 'shell-danger') {
    // 舊版／內部的 shell 工具：陣列指令，沒有 PermissionRequest（沙盒內直接跑）。
    preToolUse('shell', { command: ['bash', '-lc', 'git push --force origin main'] });
  }
  if (line === 'model-error') {
    hook('PostModelRequest', { error: 'unexpected status 500 Internal Server Error' });
  } else if (line === 'quota') {
    hook('PostModelRequest', {
      error: "You've hit your usage limit. Upgrade to Pro or try again later.",
    });
  } else {
    hook('PostModelRequest', { status: 'completed' });
  }
  hook('Stop', { last_assistant_message: `done: ${line}`, stop_hook_active: false });
}

console.log(`fake codex ${threadId} args=${args.join(' ')}`);
console.log('>_ OpenAI Codex (fake)');
if (model !== 'fake-late-start') sessionStart();
console.log('READY');
if (firstPrompt) handle(firstPrompt);

process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/[\r\n]+/).filter(Boolean)) handle(line);
});
