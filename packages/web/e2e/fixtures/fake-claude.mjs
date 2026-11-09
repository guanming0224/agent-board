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

/**
 * 隊長自主擴編的整合測試：像 Claude Code 一樣照 `--mcp-config` 啟動 agent-board MCP server（stdio），
 * initialize 後呼叫一個工具，把回答印在畫面上（`MCP ok …`／`MCP error …`）。輸入列格式：`mcp <tool> <json 參數>`。
 */
function callMcp(name, input) {
  const configPath = flag('--mcp-config');
  if (!configPath) return 'MCP error no --mcp-config';
  const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['agent-board'];
  const request = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const result = spawnSync(server.command, server.args, {
    input: `${request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })}\n${request(2, 'tools/call', { name, arguments: input })}\n`,
    env: { ...process.env, ...server.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const reply = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  if (!reply?.result) return `MCP error ${JSON.stringify(reply?.error ?? result.stderr)}`;
  return `MCP ${reply.result.isError ? 'error' : 'ok'} ${reply.result.content[0].text}`;
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
    // 模擬收到交接後動手改檔：防迴圈測試需要目標在沒有人輸入的情況下再觸發規則。
    if (line.startsWith('[Handoff]')) {
      hook('PostToolUse', {
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/ab-team/after-handoff.ts' },
        tool_use_id: randomUUID(),
      });
    }
    // 只送 PostToolUse：團隊測試要的是 file.changed，不走權限流程。
    if (line.startsWith('edit-file ')) {
      hook('PostToolUse', {
        tool_name: 'Write',
        tool_input: { file_path: line.slice('edit-file '.length) },
        tool_use_id: randomUUID(),
      });
    }
    if (line === 'danger') tool('Bash', { command: 'git push --force origin main' });
    if (line.startsWith('mcp ')) {
      const [, name, ...rest] = line.split(' ');
      console.log(callMcp(name, JSON.parse(rest.join(' ') || '{}')));
    }
    // 團隊測試：假隊長回一份任務清單。
    const reply = line.startsWith('Break this team goal')
      ? 'Plan:\n```json\n[{"title":"Integration task one"},{"title":"Integration task two"}]\n```'
      : `done: ${line}`;
    hook('Stop', { last_assistant_message: reply, stop_hook_active: false });
  }
});
