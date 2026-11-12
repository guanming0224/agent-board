#!/usr/bin/env node
// 整合測試用的假 claude：不連網、不呼叫 LLM，但會真的執行 agent-board-hook，
// 所以 settings.local.json、hook CLI、socket、核准流程都是真的路徑。
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (fake)');
  process.exit(0);
}

const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/**
 * 交叉審查（Codex 第二輪）：`claude -p --output-format json`，prompt 從 stdin。不呼叫 LLM，回固定的三段意見。
 * `--model fake-review-fail` → is_error、exit 1；`fake-review-slow` → 一直不結束（測逾時）。
 * 收到的參數與 prompt 開頭記在 AB_FAKE_REVIEW_LOG（有設才寫），測試用來確認唯讀參數與 diff 內容。
 */
if (args.includes('-p')) {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) prompt += chunk;
  {
    const model = flag('--model') ?? 'fake-claude-model';
    if (process.env.AB_FAKE_REVIEW_LOG) {
      appendFileSync(
        process.env.AB_FAKE_REVIEW_LOG,
        `${JSON.stringify({ cli: 'claude', args, cwd: process.cwd(), prompt })}\n`,
      );
    }
    if (model === 'fake-review-slow') await new Promise(() => setInterval(() => undefined, 1_000));
    if (model === 'fake-review-fail') {
      console.log(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'fake failure',
        }),
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '1. 嚴重問題：無\n2. 建議：補一個測試。\n3. 整體結論：Claude 假審查：可以合併。',
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 0,
          output_tokens: 45,
        },
        duration_ms: 10,
      }),
    );
    process.exit(0);
  }
}

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
/**
 * session host 的整合測試：一個會跑好幾秒的回合（`slow <步數>`），每 300ms 印一行、跑一次工具 hook，
 * 最後才 Stop。測試在中途重啟 daemon，驗證 agent 沒死、每一行輸出都在、狀態正確。
 */
function slowWork(steps) {
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    console.log(`WORK ${step}/${steps}`);
    hook('PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: `/tmp/step-${step}` },
      tool_use_id: randomUUID(),
    });
    if (step < steps) return;
    clearInterval(timer);
    console.log('WORK DONE');
    hook('Stop', { last_assistant_message: `done: slow ${steps}`, stop_hook_active: false });
  }, 300);
}

process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/[\r\n]+/).filter(Boolean)) {
    console.log(`GOT ${line}`);
    if (line === 'quit') process.exit(0);
    if (line === 'crash') process.exit(3);
    // 派工測試：模擬送進來的字被吃掉（沒開始回合、沒有任何 hook）。
    if (line.startsWith('[From ') && line.includes('#eaten')) continue;
    hook('UserPromptSubmit', { prompt: line });
    if (line === 'whoami') console.log(`PID ${process.pid}`);
    // session host 測試：這一輪的 hook 都送完才印 EXIT SCHEDULED，過一會兒自己結束（測試在這段時間停掉 daemon）。
    if (line.startsWith('exit-later ')) {
      hook('Stop', { last_assistant_message: `done: ${line}`, stop_hook_active: false });
      console.log('EXIT SCHEDULED');
      setTimeout(() => process.exit(0), Number(line.slice('exit-later '.length)) || 1_000);
      continue;
    }
    if (line.startsWith('slow ')) {
      slowWork(Number(line.slice('slow '.length)) || 10);
      continue;
    }
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
