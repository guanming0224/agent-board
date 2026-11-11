#!/usr/bin/env node
// agent-board-mcp：派工與進度卡工具的 MCP server（stdio，CONTRACTS §11、§14）。daemon 用 `--mcp-config` 掛給每個 claude。
// 只列、只接受 daemon 在 AGENT_BOARD_MCP_TOOLS 給的工具（設定關著的功能不出現）。
// 工具說明與隊長守則（擴編節奏）在 protocol/src/leadGuide.ts，Claude 只在讀工具清單、呼叫工具時看到，中控台不送字。
// 自己不做任何決定：每個工具呼叫原樣經本機 socket 交給 daemon（daemon 比對密鑰），再由 hub 判斷能不能做。
// 不呼叫任何模型、不連網路，只連 daemon 的本機 socket。只用 node 內建模組（同 agent-board-hook，可直接 node 執行）。
// stdout 只能有 JSON-RPC 訊息；說明一律寫 stderr。
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
// 隊長守則與工具說明集中在 protocol（GM 2026-11-10）。leadGuide.ts 不 import 任何東西（沒有 zod），可以直接用 node 執行。
import {
  DISPATCH_INSTRUCTIONS,
  DISPATCH_TOOL_DESCRIPTIONS,
  RELEASE_REASON_DESCRIPTION,
  SPAWN_REASON_DESCRIPTION,
} from '@agent-board/protocol/lead-guide';
import {
  DISPATCH_TOOLS,
  LEGACY_DISPATCH_TOOLS,
  MCP_SECRET_FILE_ENV,
  MCP_SERVER_NAME,
  MCP_TOOL_TIMEOUT_MS,
  MCP_TOOLS_ENV,
  MEMORY_TOOLS,
  SESSION_ID_ENV,
  SOCKET_ENV,
} from './mcp-constants.ts';
import { authenticateDaemon, KEY_FILE_ENV, readDaemonKey } from './daemonAuth.ts';

type Json = Record<string, unknown>;

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_VERSION = '2025-06-18';

/** 進度卡（P3 項目一）：固定的兩句（docs/p3-spec.md §1.3）。 */
const MEMORY_INSTRUCTIONS = [
  'When you start new work, or after the conversation was cleared (/clear, compact), first read the team progress card with get_progress; when you finish a chunk of work, or before you stop to wait for the user, update status/next/blockers with update_progress.',
  "gmNotes are the user's fixed rules and must be followed.",
];

const ALL_TOOLS = [
  {
    name: 'list_members',
    description: DISPATCH_TOOL_DESCRIPTIONS.list_members,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spawn_member',
    description: DISPATCH_TOOL_DESCRIPTIONS.spawn_member,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['worker', 'researcher', 'reviewer', 'tester'] },
        prompt: { type: 'string', description: 'The work to do. One self-contained instruction.' },
        reason: { type: 'string', description: SPAWN_REASON_DESCRIPTION },
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
      required: ['role', 'prompt', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_task',
    description: DISPATCH_TOOL_DESCRIPTIONS.send_task,
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
    description: DISPATCH_TOOL_DESCRIPTIONS.get_result,
    inputSchema: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Member name.' } },
      required: ['member'],
      additionalProperties: false,
    },
  },
  {
    name: 'release_member',
    description: DISPATCH_TOOL_DESCRIPTIONS.release_member,
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Member name (as in list_members).' },
        reason: { type: 'string', description: RELEASE_REASON_DESCRIPTION },
      },
      required: ['member', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_progress',
    description:
      "Read your team's progress card on the Agent Board: status, next step, blockers, the user's fixed rules (gmNotes), the team goal and TEAM.md, plus facts (task board counts, files changed in the last 24 hours, member status). Also returns the card's revision, which update_progress needs. If you are in several teams and omit team, every card is returned. A session without a team gets its own card.",
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Optional team name or id.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_progress',
    description:
      "Update your team's progress card. Only the fields you send change. Pass baseRevision = the revision you read with get_progress; if the user or another member changed the same field since then, the update is refused (progress_conflict) and you get the current card to merge with. Only the team lead writes (a team without a lead: any member; a session without a team: its own card). gmNotes cannot be changed. Each field is at most 2000 characters; simple Markdown lists, bold and inline code are shown.",
    inputSchema: {
      type: 'object',
      properties: {
        baseRevision: {
          type: 'integer',
          minimum: 0,
          description: 'The revision you read with get_progress (0 if the card is empty).',
        },
        status: { type: 'string', description: 'Where the work stands now.' },
        next: { type: 'string', description: 'The next step(s).' },
        blockers: {
          type: 'string',
          description: 'What blocks progress or waits for the user to decide.',
        },
        team: {
          type: 'string',
          description: 'Team name or id; required only if you are in several teams.',
        },
      },
      required: ['baseRevision'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * daemon 給的工具清單（只認得的名稱）。沒有這個變數＝舊版 daemon：只有舊的四個派工工具（沒有 release_member）。
 * 給了但是空的不會發生（daemon 兩個功能都關時不掛 MCP server），當成沒有工具。
 */
function enabledTools(): readonly string[] {
  const raw = process.env[MCP_TOOLS_ENV];
  if (raw === undefined) return LEGACY_DISPATCH_TOOLS;
  const known: readonly string[] = ALL_TOOLS.map((tool) => tool.name);
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => known.includes(name));
}

const TOOL_NAMES = enabledTools();
const TOOLS = ALL_TOOLS.filter((tool) => TOOL_NAMES.includes(tool.name));
const INSTRUCTIONS = [
  ...(DISPATCH_TOOLS.some((name) => TOOL_NAMES.includes(name)) ? DISPATCH_INSTRUCTIONS : []),
  ...(MEMORY_TOOLS.some((name) => TOOL_NAMES.includes(name)) ? MEMORY_INSTRUCTIONS : []),
].join(' ');

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
  // W5：給了 daemon 的密鑰檔卻讀不到（或 Windows pipe 沒給）＝設定不完整，不送密鑰出去。
  const daemonKey = socketPath ? readDaemonKey(socketPath, process.env[KEY_FILE_ENV]) : null;
  if (!socketPath || !sessionId || !secret || !daemonKey || daemonKey.kind === 'missing') {
    return Promise.resolve({
      ok: false,
      text: 'not_configured: This session was not started by Agent Board with its tools.',
    });
  }
  const key = daemonKey.kind === 'key' ? daemonKey.key : null;
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
    socket.on('error', unreachable);
    socket.on('close', unreachable);
    socket.on('connect', () => {
      if (key === null) {
        listen();
        return;
      }
      // 對方先證明自己是 daemon，才送請求（含這個 session 的 MCP 密鑰）。
      void authenticateDaemon(socket, key).then((ok) => {
        if (ok) listen();
        else unreachable();
      });
    });
    const listen = () => {
      socket.setEncoding('utf8');
      socket.on('data', onData);
      socket.write(line);
    };
    const onData = (chunk: string) => {
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
    };
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
