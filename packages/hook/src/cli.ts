#!/usr/bin/env node
// agent-board-hook <EventName>：把 Claude Code 的 hook 事件轉給 daemon（CONTRACTS.md §4.2、§4.3）。
// 跑在使用者每一次工具呼叫的路徑上：只用 node 內建模組，runtime 不 import protocol（zod 太慢）。
// 鐵律：永遠 exit 0、stdout 只會有一個 JSON 物件或什麼都沒有。
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { HookPayload, HookRequest } from '@agent-board/protocol';
import {
  BLOCKING_EVENTS,
  CONNECT_DEADLINE_MS,
  HOOK_EVENTS,
  HOOK_WAIT_MS,
  SEND_DEADLINE_MS,
  SESSION_ID_ENV,
  SOCKET_ENV,
  STDIN_DEADLINE_MS,
  WAIT_OVERRIDE_ENV,
} from './cli-constants.ts';

type Output = Record<string, unknown> | null;

let finished = false;

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

function waitMs(): number {
  const override = Number(process.env[WAIT_OVERRIDE_ENV]);
  return override > 0 && override < HOOK_WAIT_MS ? override : HOOK_WAIT_MS;
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
): void {
  setTimeout(() => finish(timeoutOutput), waitMs());
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

async function main(): Promise<void> {
  const sessionId = process.env[SESSION_ID_ENV];
  if (!sessionId) return finish();
  const event = process.argv[2];
  if (event === undefined || !HOOK_EVENTS.includes(event)) return finish();

  const payload: unknown = JSON.parse(await readStdin());
  if (!isRecord(payload)) return finish();

  // §4.3：只有 Bash 要檢查危險指令，檢查不了就要往安全的方向。
  const isBashCheck = event === 'PreToolUse' && payload.tool_name === 'Bash';
  const unreachable = isBashCheck
    ? preToolUseDecision('ask', 'Agent Board daemon unreachable: dangerous-command check skipped.')
    : null;
  const timeoutOutput = isBashCheck
    ? preToolUseDecision('deny', 'Agent Board: no decision received before the time limit.')
    : null;

  const socketPath = process.env[SOCKET_ENV];
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
  };
  const line = `${JSON.stringify(request)}\n`;
  if (BLOCKING_EVENTS.includes(event)) {
    sendAndWait(socketPath, line, requestId, unreachable, timeoutOutput);
  } else {
    sendAndLeave(socketPath, line);
  }
}

// 任何例外、被訊號終止、stdout 另一端關掉都走 exit 0。
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => process.exit(0));
}
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
main().catch(() => process.exit(0));
