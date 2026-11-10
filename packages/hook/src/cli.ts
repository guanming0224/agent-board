#!/usr/bin/env node
// agent-board-hook [--agent codex] <EventName>：把 Claude Code／Codex 的 hook 事件轉給 daemon
// （CONTRACTS.md §4.2、§4.3、§19）。
// 跑在使用者每一次工具呼叫的路徑上：只用 node 內建模組，runtime 不 import protocol（zod 太慢）。
// 鐵律：永遠 exit 0、stdout 只會有一個 JSON 物件或什麼都沒有。
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { HookPayload, HookRequest } from '@agent-board/protocol';
import {
  AGENT_FLAG,
  AGENTS,
  BLOCKING_EVENTS,
  CODEX_PERMISSION_HOOK_WAIT_MS,
  CODEX_SHELL_TOOLS,
  CONNECT_DEADLINE_MS,
  HOOK_EVENTS,
  HOOK_WAIT_MS,
  SEND_DEADLINE_MS,
  SESSION_FLAG,
  SESSION_ID_ENV,
  SOCKET_ENV,
  SOCKET_FLAG,
  STDIN_DEADLINE_MS,
  WAIT_OVERRIDE_ENV,
} from './cli-constants.ts';

type Output = Record<string, unknown> | null;

let finished = false;
/**
 * 意外失敗（stdin 不是 JSON、未捕捉的例外）時的輸出。Codex 的 PreToolUse 不輸出＝放行，所以設成 deny；
 * 其他情況維持安靜結束。
 */
let failOutput: Output = null;

function finish(output: Output = null): void {
  if (finished) return;
  finished = true;
  if (output === null) process.exit(0);
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preToolUseDecision(decision: 'ask' | 'deny', reason: string): Output {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

function waitMs(limit: number): number {
  const override = Number(process.env[WAIT_OVERRIDE_ENV]);
  return override > 0 && override < limit ? override : limit;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const deadline = setTimeout(() => reject(new Error('stdin deadline')), STDIN_DEADLINE_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => (text += chunk));
    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      clearTimeout(deadline);
      resolve(text);
    });
  });
}

/** 送出就走。任何失敗都安靜結束。 */
function sendAndLeave(socketPath: string, line: string): void {
  setTimeout(finish, SEND_DEADLINE_MS);
  const socket = connect(socketPath);
  socket.on('error', () => finish());
  socket.end(line, () => finish());
}

/**
 * 等 daemon 回答。不呼叫 socket.end()：連線保持開著，daemon 才能用斷線判斷 hook 已不在。
 * unreachable 用在連不上、中途斷線、回答壞掉；timeoutOutput 用在 daemon 活著但一直沒回答。
 */
function sendAndWait(
  socketPath: string,
  line: string,
  requestId: string,
  unreachable: Output,
  timeoutOutput: Output,
  limit: number,
): void {
  setTimeout(() => finish(timeoutOutput), waitMs(limit));
  const connectDeadline = setTimeout(() => finish(unreachable), CONNECT_DEADLINE_MS);
  const socket: Socket = connect(socketPath);
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    clearTimeout(connectDeadline);
    socket.write(line);
  });
  socket.on('error', () => finish(unreachable));
  socket.on('close', () => finish(unreachable));
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const replyLine = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleReply(replyLine, requestId, unreachable);
    }
  });
}

function handleReply(line: string, requestId: string, unreachable: Output): void {
  let reply: unknown;
  try {
    reply = JSON.parse(line);
  } catch {
    finish(unreachable);
    return;
  }
  if (!isRecord(reply) || reply.type !== 'hook.reply') {
    finish(unreachable);
    return;
  }
  if (reply.requestId !== requestId) return;
  if (reply.output === null) finish(null);
  else if (isRecord(reply.output)) finish(reply.output);
  else finish(unreachable);
}

interface ParsedArgs {
  agent: string;
  event: string;
  sessionId: string | null;
  socketPath: string | null;
}

/**
 * `[--agent <claude|codex>] [--session <id>] [--socket <path>] <EventName>`（選項順序不拘）；
 * 認不得就回 null（安靜結束）。
 */
function parseArgs(argv: readonly string[]): ParsedArgs | null {
  let agent = 'claude';
  let sessionId: string | null = null;
  let socketPath: string | null = null;
  let i = 0;
  for (; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === AGENT_FLAG) agent = value ?? '';
    else if (flag === SESSION_FLAG) sessionId = value || null;
    else if (flag === SOCKET_FLAG) socketPath = value || null;
    else break;
  }
  const event = argv[i];
  if (!AGENTS.includes(agent) || event === undefined || !HOOK_EVENTS.includes(event)) return null;
  return { agent, event, sessionId, socketPath };
}

/** POSIX shell 的單引號：陣列指令接成字串後，daemon 解析出來的還是同樣的幾個參數。 */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Codex 的 shell 工具統一成 Bash、指令統一成字串，daemon 的危險指令比對才認得（§19）。
 * 陣列形式（`["bash","-lc","git push --force"]`）每個參數加引號再接起來：只用空白接的話
 * `bash -lc git push --force` 的腳本只剩 `git`，daemon 解不開 `bash -c` 裡的指令。
 */
function normalizeCodexPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const tool = payload.tool_name;
  const input = isRecord(payload.tool_input) ? payload.tool_input : {};
  const command = input.command ?? input.cmd;
  // 名稱不在清單裡（Codex 改了工具名），但看得出是在跑指令：一樣當成 Bash 檢查，不只看名稱。
  const looksLikeShell =
    typeof command === 'string' ||
    (Array.isArray(command) && command.some((part) => typeof part === 'string'));
  if (!(typeof tool === 'string' && CODEX_SHELL_TOOLS.includes(tool)) && !looksLikeShell) {
    return payload;
  }
  const text = Array.isArray(command)
    ? command
        .filter((part): part is string => typeof part === 'string')
        .map(shellQuote)
        .join(' ')
    : command;
  return { ...payload, tool_name: 'Bash', tool_input: { ...input, command: text } };
}

const CODEX_BLOCKED_PREFIX =
  'Agent Board: dangerous-command check could not run, so this command was blocked';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) return finish();
  const { agent, event } = parsed;
  const codex = agent === 'codex';
  // Codex 的 PreToolUse 不輸出＝放行、不支援 ask：任何意外都往安全的方向（deny）。
  if (codex && event === 'PreToolUse') {
    failOutput = preToolUseDecision('deny', `${CODEX_BLOCKED_PREFIX} (hook error).`);
  }
  // Codex 的 hook 指令直接帶 --session／--socket（§19.2）；沒有才看環境變數（Claude 一直是環境變數）。
  const sessionId = parsed.sessionId ?? process.env[SESSION_ID_ENV];
  if (!sessionId) {
    return finish(
      codex && event === 'PreToolUse'
        ? preToolUseDecision('deny', `${CODEX_BLOCKED_PREFIX} (no Agent Board session).`)
        : null,
    );
  }

  const raw: unknown = JSON.parse(await readStdin());
  if (!isRecord(raw)) return finish();
  const payload = codex ? normalizeCodexPayload(raw) : raw;

  // §4.3：只有 Bash 要檢查危險指令，檢查不了就要往安全的方向。
  // Codex 的 PreToolUse 不支援 ask（會當成 hook 失敗、照樣執行），所以連不上時改成 deny（§19.4）。
  const isBashCheck = event === 'PreToolUse' && payload.tool_name === 'Bash';
  const unreachable = isBashCheck
    ? codex
      ? preToolUseDecision(
          'deny',
          'Agent Board daemon unreachable: dangerous-command check could not run, so this command was blocked.',
        )
      : preToolUseDecision(
          'ask',
          'Agent Board daemon unreachable: dangerous-command check skipped.',
        )
    : null;
  const timeoutOutput = isBashCheck
    ? preToolUseDecision('deny', 'Agent Board: no decision received before the time limit.')
    : null;

  const socketPath = parsed.socketPath ?? process.env[SOCKET_ENV];
  // daemon 用 zod 驗 HookPayload，缺這兩個欄位送過去也只會被丟掉。
  if (
    !socketPath ||
    typeof payload.session_id !== 'string' ||
    typeof payload.hook_event_name !== 'string'
  ) {
    return finish(unreachable);
  }

  const requestId = crypto.randomUUID();
  const request: HookRequest = {
    type: 'hook',
    requestId,
    sessionId,
    event: event as HookRequest['event'],
    payload: payload as HookPayload,
    ...(codex ? { agent: 'codex' as const } : {}),
  };
  const line = `${JSON.stringify(request)}\n`;
  if (BLOCKING_EVENTS.includes(event)) {
    const limit =
      codex && event === 'PermissionRequest' ? CODEX_PERMISSION_HOOK_WAIT_MS : HOOK_WAIT_MS;
    sendAndWait(socketPath, line, requestId, unreachable, timeoutOutput, limit);
  } else {
    sendAndLeave(socketPath, line);
  }
}

// 任何例外、被訊號終止、stdout 另一端關掉都走 exit 0。
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => process.exit(0));
}
/** 意外失敗：Codex 的 PreToolUse 回 deny（failOutput），其他安靜結束。已經在輸出就直接離開。 */
function fail(): void {
  if (finished || failOutput === null) process.exit(0);
  finish(failOutput);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.stdout.on('error', () => process.exit(0));
main().catch(fail);
