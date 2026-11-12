// 派工 MCP server（mcp.ts）的協定測試：真的子行程跑 stdio JSON-RPC，對面是臨時 socket 上的假 daemon。
// 不會執行 claude，不連網路。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentBoardTool,
  DISPATCH_MCP_SERVER,
  DISPATCH_ROLES,
  DispatchTool,
  HOOK_ENV,
  MCP_ENV,
  McpRequest,
  MemoryTool,
} from '@agent-board/protocol';
import {
  DISPATCH_INSTRUCTIONS,
  DISPATCH_TOOL_DESCRIPTIONS,
  LEAD_STAFFING_RHYTHM,
  MEMBER_STAFFING_GUIDE,
  RELEASE_REASON_DESCRIPTION,
  SPAWN_REASON_DESCRIPTION,
} from '@agent-board/protocol/lead-guide';
import { localProof } from '@agent-board/protocol/local-auth';
import {
  DISPATCH_TOOLS,
  LEGACY_DISPATCH_TOOLS,
  MCP_SECRET_FILE_ENV,
  MCP_SERVER_NAME,
  MCP_TOOLS_ENV,
  MEMORY_TOOLS,
  SESSION_ID_ENV,
  SOCKET_ENV,
} from './mcp-constants.ts';

const SERVER = fileURLToPath(new URL('./mcp.ts', import.meta.url));
const SECRET = 's'.repeat(43);

let dir: string;
let daemon: Server | null = null;
let child: ChildProcessWithoutNullStreams | null = null;
const requests: McpRequest[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ab-mcp-'));
  requests.length = 0;
  challenges = 0;
});
afterEach(async () => {
  child?.kill();
  child = null;
  await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()));
  daemon = null;
  await rm(dir, { recursive: true, force: true });
});

/** 假 daemon 的 hook 密鑰（W5）。 */
const HOOK_KEY = 'h'.repeat(43);
let challenges = 0;

/** Windows 沒有 Unix socket：假 daemon 改用 named pipe。 */
const socketPathIn = (name: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\agent-board-mcp-test-${name}-${crypto.randomUUID()}`
    : join(dir, `${name}.sock`);

/** 寫 hook 密鑰檔，回傳路徑。 */
async function hookKeyFile(): Promise<string> {
  const file = join(dir, 'hook.key');
  await writeFile(file, `${HOOK_KEY}\n`, { mode: 0o600 });
  return file;
}

/** auth.challenge 的回答：ok＝正確證明；wrong＝別的密鑰算的。 */
function answerChallenge(socket: Socket, line: string, mode: 'ok' | 'wrong' = 'ok'): boolean {
  const json = JSON.parse(line) as { type?: string; nonce?: string };
  if (json.type !== 'auth.challenge') return false;
  challenges += 1;
  const proof = localProof(mode === 'ok' ? HOOK_KEY : 'x'.repeat(43), 'hookServer', json.nonce!);
  socket.write(`${JSON.stringify({ type: 'auth.proof', proof })}\n`);
  return true;
}

/** 假 daemon：用正式 schema 驗收到的請求，回答 answer(request)。 */
async function startDaemon(
  answer: (request: McpRequest) => { ok: boolean; text: string } | null,
  auth: 'ok' | 'wrong' = 'ok',
): Promise<string> {
  const path = socketPathIn('d');
  daemon = createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        if (answerChallenge(socket, line, auth)) {
          buffer = buffer.slice(index + 1);
          continue;
        }
        const request = McpRequest.parse(JSON.parse(line));
        buffer = buffer.slice(index + 1);
        requests.push(request);
        const result = answer(request);
        if (result) {
          socket.write(
            `${JSON.stringify({ type: 'mcp.reply', requestId: request.requestId, ...result })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => daemon!.listen(path, resolve));
  return path;
}

interface Server_ {
  lines: Record<string, unknown>[];
  raw: () => string;
  send: (message: Record<string, unknown>) => void;
  reply: (id: number) => Promise<Record<string, unknown>>;
}

function startServer(env: Record<string, string>): Server_ {
  child = spawn(process.execPath, [SERVER], {
    // Windows 的程式少了 SystemRoot 會有系統 API（socket、加密）起不來。
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: Record<string, unknown>[] = [];
  let all = '';
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    all += chunk;
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.resume();
  return {
    lines,
    raw: () => all,
    send: (message) => child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    reply: async (id) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = lines.find((l) => l.id === id);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no reply ${id}: ${all}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

async function configured(
  answer: Parameters<typeof startDaemon>[0],
  extra: Record<string, string> = {},
): Promise<Server_> {
  const socket = await startDaemon(answer);
  const secretFile = join(dir, 'k.key');
  await writeFile(secretFile, `${SECRET}\n`, { mode: 0o600 });
  return startServer({
    [SESSION_ID_ENV]: 'session-1',
    [SOCKET_ENV]: socket,
    [MCP_SECRET_FILE_ENV]: secretFile,
    [HOOK_ENV.keyFile]: await hookKeyFile(),
    ...extra,
  });
}

async function listed(server: Server_, id: number) {
  server.send({ id, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const init = (await server.reply(id)).result as { instructions: string };
  server.send({ id: id + 1, method: 'tools/list' });
  const { tools } = (await server.reply(id + 1)).result as {
    tools: { name: string; inputSchema: { required?: string[]; properties?: object } }[];
  };
  return { instructions: init.instructions, tools };
}

describe('agent-board-mcp', () => {
  it('常數和 protocol 一致', () => {
    expect(SESSION_ID_ENV).toBe(HOOK_ENV.sessionId);
    expect(SOCKET_ENV).toBe(HOOK_ENV.socket);
    expect(MCP_SECRET_FILE_ENV).toBe(MCP_ENV.secretFile);
    expect(MCP_SERVER_NAME).toBe(DISPATCH_MCP_SERVER);
    expect(MCP_TOOLS_ENV).toBe(MCP_ENV.tools);
    expect([...DISPATCH_TOOLS]).toEqual(DispatchTool.options);
    expect([...MEMORY_TOOLS]).toEqual(MemoryTool.options);
  });

  it('進度卡（P3）：只列、只接受 daemon 給的工具；instructions 依掛了什麼加對應的句子', async () => {
    const all = await configured(() => ({ ok: true, text: '{}' }), {
      [MCP_TOOLS_ENV]: AgentBoardTool.options.join(','),
    });
    const both = await listed(all, 1);
    expect(both.tools.map((t) => t.name)).toEqual(AgentBoardTool.options);
    expect(both.instructions).toContain('delegate work');
    expect(both.instructions).toContain('first read the team progress card with get_progress');
    expect(both.instructions).toContain("gmNotes are the user's fixed rules");
    expect(both.tools.find((t) => t.name === 'update_progress')!.inputSchema.required).toEqual([
      'baseRevision',
    ]);
    // update_progress 的參數不含 gmNotes（agent 不能改 GM 備註）。
    expect(
      Object.keys(both.tools.find((t) => t.name === 'update_progress')!.inputSchema.properties!),
    ).toEqual(['baseRevision', 'status', 'next', 'blockers', 'team']);
    child!.kill();
    await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()));
    daemon = null;

    // 只開進度卡：派工工具不出現、也呼叫不了；進度卡工具原樣轉給 daemon。
    const memoryOnly = await configured(() => ({ ok: true, text: '{"revision":0}' }), {
      [MCP_TOOLS_ENV]: 'get_progress,update_progress,not_a_tool',
    });
    const only = await listed(memoryOnly, 1);
    expect(only.tools.map((t) => t.name)).toEqual(['get_progress', 'update_progress']);
    expect(only.instructions).not.toContain('delegate work');
    expect(only.instructions).toContain('get_progress');
    memoryOnly.send({
      id: 5,
      method: 'tools/call',
      params: { name: 'list_members', arguments: {} },
    });
    expect(((await memoryOnly.reply(5)).error as { code: number }).code).toBe(-32602);
    memoryOnly.send({
      id: 6,
      method: 'tools/call',
      params: { name: 'update_progress', arguments: { baseRevision: 0, next: 'x' } },
    });
    expect((await memoryOnly.reply(6)).result).toEqual({
      content: [{ type: 'text', text: '{"revision":0}' }],
      isError: false,
    });
    expect(requests.map((r) => [r.tool, r.args])).toEqual([
      ['update_progress', { baseRevision: 0, next: 'x' }],
    ]);
  });

  it('舊版 daemon（沒給工具清單）：只有舊的四個派工工具，沒有 release_member（舊 daemon 的 --allowedTools 沒有它）', async () => {
    const server = await configured(() => null);
    const { tools, instructions } = await listed(server, 1);
    expect(tools.map((t) => t.name)).toEqual([...LEGACY_DISPATCH_TOOLS]);
    expect(tools.map((t) => t.name)).not.toContain('release_member');
    // 新加的 release_member、request_review（交叉審查）都只在新 daemon 明確列出時才出現。
    expect(
      DispatchTool.options.filter((t) => t !== 'release_member' && t !== 'request_review'),
    ).toEqual([...LEGACY_DISPATCH_TOOLS]);
    expect(instructions).not.toContain('get_progress');
    server.send({
      id: 10,
      method: 'tools/call',
      params: { name: 'release_member', arguments: { member: 'x', reason: 'y' } },
    });
    expect(((await server.reply(10)).error as { code: number }).code).toBe(-32602);
  });

  it('initialize 協商版本、tools/list 列出派工工具，通知不回', async () => {
    const server = await configured(() => null);
    server.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    const init = (await server.reply(1)).result as Record<string, unknown>;
    expect(init.protocolVersion).toBe('2025-03-26');
    expect(init.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.serverInfo).toMatchObject({ name: 'agent-board' });
    expect(typeof init.instructions).toBe('string');
    // 不認得的版本回我們支援的版本。
    server.send({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(((await server.reply(2)).result as { protocolVersion: string }).protocolVersion).toBe(
      '2025-06-18',
    );
    server.send({ method: 'notifications/initialized' });
    server.send({ id: 3, method: 'tools/list' });
    const { tools } = (await server.reply(3)).result as {
      tools: {
        name: string;
        inputSchema: {
          type: string;
          required?: string[];
          properties?: Record<string, { enum?: string[] }>;
        };
      }[];
    };
    expect(tools.map((t) => t.name)).toEqual([...LEGACY_DISPATCH_TOOLS]);
    // 角色和 hub 收的一樣（P2 加了 tester，Q5）。
    expect(
      tools.find((t) => t.name === 'spawn_member')!.inputSchema.properties?.role?.enum,
    ).toEqual([...DISPATCH_ROLES]);
    expect(tools.find((t) => t.name === 'spawn_member')!.inputSchema.required).toEqual([
      'role',
      'prompt',
      'reason',
    ]);
    server.send({ id: 4, method: 'ping' });
    expect((await server.reply(4)).result).toEqual({});
    // stdout 只有 JSON-RPC：每一行都是 jsonrpc 2.0 物件，通知沒有回答。
    expect(server.lines.every((l) => l.jsonrpc === '2.0')).toBe(true);
    expect(server.lines.filter((l) => l.id === undefined)).toEqual([]);
  });

  it('tools/call 帶 session id 與密鑰交給 daemon，回答變成 text 內容；失敗標 isError', async () => {
    const server = await configured((request) =>
      request.tool === 'list_members'
        ? { ok: true, text: '{"teams":[]}' }
        : { ok: false, text: 'team_full: too many' },
    );
    server.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    expect((await server.reply(1)).result).toEqual({
      content: [{ type: 'text', text: '{"teams":[]}' }],
      isError: false,
    });
    server.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'spawn_member', arguments: { role: 'worker', prompt: 'do it' } },
    });
    expect((await server.reply(2)).result).toEqual({
      content: [{ type: 'text', text: 'team_full: too many' }],
      isError: true,
    });
    expect(requests.map((r) => [r.sessionId, r.secret, r.tool, r.args])).toEqual([
      ['session-1', SECRET, 'list_members', {}],
      ['session-1', SECRET, 'spawn_member', { role: 'worker', prompt: 'do it' }],
    ]);
    // 密鑰不會出現在 stdout（Claude 看得到的地方）。
    expect(server.raw()).not.toContain(SECRET);
  });

  it('不認得的工具 -32602、不認得的方法 -32601、壞掉的 JSON -32700', async () => {
    const server = await configured(() => ({ ok: true, text: 'x' }));
    server.send({ id: 1, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
    expect(((await server.reply(1)).error as { code: number }).code).toBe(-32602);
    server.send({ id: 2, method: 'resources/list' });
    expect(((await server.reply(2)).error as { code: number }).code).toBe(-32601);
    child!.stdin.write('{oops\n');
    const deadline = Date.now() + 5_000;
    while (!server.lines.some((l) => (l.error as { code?: number })?.code === -32700)) {
      if (Date.now() > deadline) throw new Error('no parse error');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(requests).toEqual([]);
  });

  it('不是 Agent Board 開的（沒有密鑰檔）或 daemon 連不上：回清楚的錯誤，不當掉', async () => {
    const bare = startServer({});
    bare.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    const result = (await bare.reply(1)).result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^not_configured:/);
    child!.kill();

    const secretFile = join(dir, 'k.key');
    await writeFile(secretFile, SECRET, { mode: 0o600 });
    const lost = startServer({
      [SESSION_ID_ENV]: 'session-1',
      [SOCKET_ENV]: socketPathIn('nobody'),
      [MCP_SECRET_FILE_ENV]: secretFile,
      [HOOK_ENV.keyFile]: await hookKeyFile(),
    });
    lost.send({ id: 1, method: 'tools/call', params: { name: 'get_result', arguments: {} } });
    const r = (await lost.reply(1)).result as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^daemon_unreachable:/);
  });

  it('W5：先確認對方是 daemon 才送（含密鑰）；證明不對 daemon_unreachable；密鑰檔讀不到或 pipe 沒給 not_configured', async () => {
    const ok = await configured(() => ({ ok: true, text: '{"members":[]}' }));
    ok.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    expect(((await ok.reply(1)).result as { isError: boolean }).isError).toBe(false);
    expect(challenges).toBe(1);
    expect(requests).toHaveLength(1);
    child!.kill();
    await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()));
    daemon = null;

    const socket = await startDaemon(() => ({ ok: true, text: '{}' }), 'wrong');
    const secretFile = join(dir, 'k.key');
    await writeFile(secretFile, SECRET, { mode: 0o600 });
    const base = {
      [SESSION_ID_ENV]: 'session-1',
      [SOCKET_ENV]: socket,
      [MCP_SECRET_FILE_ENV]: secretFile,
    };
    const fake = startServer({ ...base, [HOOK_ENV.keyFile]: await hookKeyFile() });
    fake.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    const r1 = (await fake.reply(1)).result as { content: { text: string }[] };
    expect(r1.content[0]!.text).toMatch(/^daemon_unreachable:/);
    // 冒充的一方拿不到請求（也就拿不到密鑰）。
    expect(requests).toHaveLength(1);
    child!.kill();

    const noKey = startServer({ ...base, [HOOK_ENV.keyFile]: join(dir, 'missing.key') });
    noKey.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    const r2 = (await noKey.reply(1)).result as { content: { text: string }[] };
    expect(r2.content[0]!.text).toMatch(/^not_configured:/);
    child!.kill();

    const pipe = startServer({ ...base, [SOCKET_ENV]: '\\\\.\\pipe\\agent-board-hook-none' });
    pipe.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    const r3 = (await pipe.reply(1)).result as { content: { text: string }[] };
    expect(r3.content[0]!.text).toMatch(/^not_configured:/);
    expect(requests).toHaveLength(1);
  });

  it('stdin 關掉時等還沒回的呼叫回完才結束', async () => {
    let release: (() => void) | null = null;
    const socket = await startDaemon(() => null);
    daemon!.removeAllListeners('connection');
    daemon!.on('connection', (s: Socket) => {
      s.setEncoding('utf8');
      s.on('data', (chunk: string) => {
        if (answerChallenge(s, chunk.trim())) return;
        const request = JSON.parse(chunk.trim()) as { requestId: string };
        release = () =>
          s.write(
            `${JSON.stringify({ type: 'mcp.reply', requestId: request.requestId, ok: true, text: 'late' })}\n`,
          );
      });
    });
    const secretFile = join(dir, 'k.key');
    await writeFile(secretFile, SECRET, { mode: 0o600 });
    const server = startServer({
      [SESSION_ID_ENV]: 'session-1',
      [SOCKET_ENV]: socket,
      [MCP_SECRET_FILE_ENV]: secretFile,
      [HOOK_ENV.keyFile]: await hookKeyFile(),
    });
    const exited = new Promise<number | null>((resolve) => child!.on('close', resolve));
    server.send({ id: 1, method: 'tools/call', params: { name: 'list_members', arguments: {} } });
    const deadline = Date.now() + 5_000;
    while (!release) {
      if (Date.now() > deadline) throw new Error('daemon never got the call');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child!.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    (release as () => void)();
    expect(await exited).toBe(0);
    expect(
      ((await server.reply(1)).result as { content: { text: string }[] }).content[0]!.text,
    ).toBe('late');
  });

  it('隊長守則（GM 2026-11-10）：工具說明與 instructions 都來自 protocol 的 leadGuide，release_member 的參數', async () => {
    const server = await configured(() => ({ ok: true, text: '{}' }), {
      [MCP_TOOLS_ENV]: AgentBoardTool.options.join(','),
    });
    const { tools, instructions } = await listed(server, 1);
    const tool = (name: string) =>
      tools.find((t) => t.name === name) as unknown as {
        description: string;
        inputSchema: { required?: string[]; properties?: Record<string, { description?: string }> };
      };
    // instructions：原本的派工說明＋擴編節奏＋成員的守則，一字不差。
    for (const line of DISPATCH_INSTRUCTIONS) expect(instructions).toContain(line);
    expect(instructions).toContain(LEAD_STAFFING_RHYTHM);
    expect(instructions).toContain(MEMBER_STAFFING_GUIDE);
    // 工具說明就是 protocol 的那份。
    for (const name of DispatchTool.options) {
      expect(tool(name).description).toBe(DISPATCH_TOOL_DESCRIPTIONS[name]);
    }
    // 守則的重點真的寫在說明裡：收到任務先評估、卡住補人、做完封存、理由必填、隊長才能動、跑著的不能封存。
    expect(tool('list_members').description).toMatch(/when you receive a task/i);
    expect(tool('list_members').description).toMatch(/size limit/);
    expect(tool('spawn_member').description).toMatch(/stuck, the workload is too large/);
    expect(tool('spawn_member').description).toMatch(/reason is required/);
    expect(tool('spawn_member').description).toMatch(/release_member a finished member first/);
    expect(tool('spawn_member').description).toMatch(/rate-limited/);
    expect(tool('release_member').description).toMatch(
      /waiting for the user's approval or plan review\) or that still owes you a result cannot be released/,
    );
    expect(tool('release_member').description).toMatch(/cannot release yourself/);
    expect(tool('release_member').description).toMatch(/Settings → Archived/);
    expect(tool('spawn_member').inputSchema.properties?.reason?.description).toBe(
      SPAWN_REASON_DESCRIPTION,
    );
    expect(tool('release_member').inputSchema.required).toEqual(['member', 'reason']);
    expect(Object.keys(tool('release_member').inputSchema.properties!)).toEqual([
      'member',
      'reason',
    ]);
    expect(tool('release_member').inputSchema.properties?.reason?.description).toBe(
      RELEASE_REASON_DESCRIPTION,
    );
    // release_member 原樣轉給 daemon。
    server.send({
      id: 9,
      method: 'tools/call',
      params: { name: 'release_member', arguments: { member: 'BD1', reason: 'Done.' } },
    });
    await server.reply(9);
    expect(requests.at(-1)).toMatchObject({
      tool: 'release_member',
      args: { member: 'BD1', reason: 'Done.' },
    });
  });
});
