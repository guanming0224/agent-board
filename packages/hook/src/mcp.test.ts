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
  DISPATCH_MCP_SERVER,
  DispatchTool,
  HOOK_ENV,
  MCP_ENV,
  McpRequest,
} from '@agent-board/protocol';
import {
  MCP_SECRET_FILE_ENV,
  MCP_SERVER_NAME,
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
});
afterEach(async () => {
  child?.kill();
  child = null;
  await new Promise<void>((resolve) => (daemon ? daemon.close(() => resolve()) : resolve()));
  daemon = null;
  await rm(dir, { recursive: true, force: true });
});

/** 假 daemon：用正式 schema 驗收到的請求，回答 answer(request)。 */
async function startDaemon(
  answer: (request: McpRequest) => { ok: boolean; text: string } | null,
): Promise<string> {
  const path = join(dir, 'd.sock');
  daemon = createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const request = McpRequest.parse(JSON.parse(buffer.slice(0, index)));
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
    env: { PATH: process.env.PATH ?? '', ...env },
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

async function configured(answer: Parameters<typeof startDaemon>[0]): Promise<Server_> {
  const socket = await startDaemon(answer);
  const secretFile = join(dir, 'k.key');
  await writeFile(secretFile, `${SECRET}\n`, { mode: 0o600 });
  return startServer({
    [SESSION_ID_ENV]: 'session-1',
    [SOCKET_ENV]: socket,
    [MCP_SECRET_FILE_ENV]: secretFile,
  });
}

describe('agent-board-mcp', () => {
  it('常數和 protocol 一致', () => {
    expect(SESSION_ID_ENV).toBe(HOOK_ENV.sessionId);
    expect(SOCKET_ENV).toBe(HOOK_ENV.socket);
    expect(MCP_SECRET_FILE_ENV).toBe(MCP_ENV.secretFile);
    expect(MCP_SERVER_NAME).toBe(DISPATCH_MCP_SERVER);
  });

  it('initialize 協商版本、tools/list 列出四個工具，通知不回', async () => {
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
      tools: { name: string; inputSchema: { type: string; required?: string[] } }[];
    };
    expect(tools.map((t) => t.name)).toEqual(DispatchTool.options);
    expect(tools.find((t) => t.name === 'spawn_member')!.inputSchema.required).toEqual([
      'role',
      'prompt',
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
        : { ok: false, text: 'limit_reached: too many' },
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
      content: [{ type: 'text', text: 'limit_reached: too many' }],
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
      [SOCKET_ENV]: join(dir, 'nobody.sock'),
      [MCP_SECRET_FILE_ENV]: secretFile,
    });
    lost.send({ id: 1, method: 'tools/call', params: { name: 'get_result', arguments: {} } });
    const r = (await lost.reply(1)).result as { content: { text: string }[]; isError: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^daemon_unreachable:/);
  });

  it('stdin 關掉時等還沒回的呼叫回完才結束', async () => {
    let release: (() => void) | null = null;
    const socket = await startDaemon(() => null);
    daemon!.removeAllListeners('connection');
    daemon!.on('connection', (s: Socket) => {
      s.setEncoding('utf8');
      s.on('data', (chunk: string) => {
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
});
