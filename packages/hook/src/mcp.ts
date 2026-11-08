#!/usr/bin/env node
// agent-board-mcp：派工工具的 MCP server（stdio，CONTRACTS §11）。daemon 用 `--mcp-config` 掛給每個 claude。
// 自己不做任何決定：每個工具呼叫原樣經本機 socket 交給 daemon（daemon 比對密鑰），再由 hub 判斷能不能做。
// 不呼叫任何模型、不連網路，只連 daemon 的本機 socket。只用 node 內建模組（同 agent-board-hook，可直接 node 執行）。
// stdout 只能有 JSON-RPC 訊息；說明一律寫 stderr。
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import {
  MCP_SECRET_FILE_ENV,
  MCP_SERVER_NAME,
  MCP_TOOL_TIMEOUT_MS,
  SESSION_ID_ENV,
  SOCKET_ENV,
} from './mcp-constants.ts';

type Json = Record<string, unknown>;

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_VERSION = '2025-06-18';

const INSTRUCTIONS = [
  'Agent Board tools let you delegate work to other Claude Code sessions shown on the Agent Board canvas, like subagents that keep running.',
  'list_members shows your team. spawn_member starts a new member in this same project (writers — worker and tester — get their own git worktree; researcher/reviewer are read-only) and gives it your prompt.',
  'send_task types a new task into one of your members once it is waiting for input.',
  'When a member finishes the turn that handled your work, its result is typed back into this session automatically as "[Result from <name>] Summary: … | Detected file edits: … | Branch: …". Do not poll; wait for it.',
  "get_result shows a member's latest summary, files and branch on demand.",
].join(' ');

const TOOLS = [
  {
    name: 'list_members',
    description:
      'List the members of your Agent Board team(s): name, role, status, current task, last screen line, read-only, branch, who dispatched them, and whether they still owe you a result. Empty if you have no team.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spawn_member',
    description:
      'Start a new Claude Code session as a member of your team, in the same machine and project folder, and give it a first prompt. role worker edits files (gets its own git worktree by default); tester writes and runs tests (also its own worktree, asks before each step by default); researcher and reviewer are read-only and share the folder. Its permission mode cannot exceed yours. At most 4 live members per caller. The result comes back to you automatically when it finishes the turn.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['worker', 'researcher', 'reviewer', 'tester'] },
        prompt: { type: 'string', description: 'The work to do. One self-contained instruction.' },
        name: { type: 'string', description: 'Optional display name; numbered automatically.' },
        permissionMode: {
          type: 'string',
          enum: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'],
          description:
            'Optional. Defaults: worker acceptEdits, tester default, researcher/reviewer plan.',
        },
        useWorktree: {
          type: 'boolean',
          description: 'Optional. Workers and testers default to true (needs a git repo).',
        },
        model: { type: 'string', description: 'Optional model; defaults to yours.' },
      },
      required: ['role', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_task',
    description:
      'Give one of your members (a member of a team you lead, or one you spawned) a new task. It is typed in when the member is waiting for input; if it is busy the task waits in a queue. The result comes back to you automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Member name (as in list_members).' },
        text: { type: 'string', description: 'The task.' },
      },
      required: ['member', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_result',
    description:
      "Show a member's latest one-sentence summary, detected file edits and branch, and whether it is still working on your task.",
    inputSchema: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Member name.' } },
      required: ['member'],
      additionalProperties: false,
    },
  },
] as const;

const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

function write(message: Json): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function readSecret(): string | null {
  const path = process.env[MCP_SECRET_FILE_ENV];
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const secret = readSecret();

/** 一次呼叫一條連線：送一行請求，等同一個 requestId 的回答。 */
function callDaemon(tool: string, args: Json): Promise<{ ok: boolean; text: string }> {
  const socketPath = process.env[SOCKET_ENV];
  const sessionId = process.env[SESSION_ID_ENV];
  if (!socketPath || !sessionId || !secret) {
    return Promise.resolve({
      ok: false,
      text: 'not_configured: This session was not started by Agent Board with dispatch tools.',
    });
  }
  const requestId = crypto.randomUUID();
  const line = `${JSON.stringify({ type: 'mcp', requestId, sessionId, secret, tool, args })}\n`;
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    const socket = connect(socketPath);
    const done = (result: { ok: boolean; text: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const unreachable = () =>
      done({ ok: false, text: 'daemon_unreachable: Agent Board daemon is not reachable.' });
    const timer = setTimeout(
      () => done({ ok: false, text: 'timeout: Agent Board did not answer in time. Try again.' }),
      MCP_TOOL_TIMEOUT_MS,
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('error', unreachable);
    socket.on('close', unreachable);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: unknown;
        try {
          reply = JSON.parse(raw);
        } catch {
          continue;
        }
        const r = reply as { type?: unknown; requestId?: unknown; ok?: unknown; text?: unknown };
        if (r.type !== 'mcp.reply' || r.requestId !== requestId) continue;
        done({ ok: r.ok === true, text: typeof r.text === 'string' ? r.text : '' });
      }
    });
  });
}

async function handle(message: Json): Promise<void> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  // 沒有 id 的是通知（notifications/initialized 等），不回。
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      write({
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: '0.0.0' },
          instructions: INSTRUCTIONS,
        },
      });
      return;
    }
    case 'ping':
      if (isRequest) write({ id, result: {} });
      return;
    case 'tools/list':
      write({ id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!TOOL_NAMES.includes(name)) {
        write({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      const args =
        typeof params.arguments === 'object' && params.arguments !== null
          ? (params.arguments as Json)
          : {};
      const result = await callDaemon(name, args);
      write({
        id,
        result: { content: [{ type: 'text', text: result.text }], isError: !result.ok },
      });
      return;
    }
    default:
      if (isRequest) write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function main(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let closed = false;
  const exitWhenIdle = () => {
    if (closed && inFlight === 0) process.exit(0);
  };
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
    inFlight += 1;
    handle(message as Json)
      .catch((error: unknown) => {
        const id = (message as Json).id;
        process.stderr.write(`agent-board-mcp: ${String(error)}\n`);
        if (id !== undefined && id !== null) {
          write({ id, error: { code: -32603, message: 'Internal error' } });
        }
      })
      .finally(() => {
        inFlight -= 1;
        exitWhenIdle();
      });
  });
  // claude 關掉 stdin 就是要我們結束（還在等的呼叫先回完）。
  lines.on('close', () => {
    closed = true;
    exitWhenIdle();
  });
}

process.stdout.on('error', () => process.exit(0));
main();
