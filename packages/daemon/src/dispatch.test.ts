// 派工工具（CONTRACTS §11）在 daemon 這一段：開 PTY 時掛 --mcp-config（設定開著才掛）、設定檔與密鑰檔的權限、
// 密鑰驗證、把工具呼叫轉給 hub 再把回答交回。用假 claude、假 hub，另外用真的 MCP server（hook 套件）走一次 stdio。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpReply } from '@agent-board/protocol';
import { DAEMON_FEATURES } from '@agent-board/protocol';
import { DISPATCH_TOOL_NAMES, MEMORY_TOOL_NAMES, secretMatches } from './mcpFiles';
import { FAKE_CAPABILITIES, Harness, waitUntil } from './test-support/harness';

const MCP_SERVER = fileURLToPath(new URL('../../hook/src/mcp.ts', import.meta.url));

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const mode = (path: string) => statSync(path).mode & 0o777;

/** 像 MCP server 一樣送一則派工請求，等回答。 */
function askDaemon(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Pick<McpReply, 'ok' | 'text'>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ type: 'mcp', requestId: 'r1', ...request })}\n`),
    );
    socket.on('error', reject);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const reply = JSON.parse(buffer.slice(0, newline)) as McpReply;
      socket.destroy();
      resolve({ ok: reply.ok, text: reply.text });
    });
  });
}

async function start(
  dispatch: boolean | undefined,
  mcpServer: string | null = MCP_SERVER,
  memory: boolean | undefined = undefined,
) {
  h = new Harness();
  h.hub.dispatch = dispatch;
  h.hub.memory = memory;
  h.mcpServer = mcpServer;
  const daemon = await h.start();
  await h.createAndSubscribe('s1');
  return daemon;
}

const mcpConfigPath = () => join(h.dataDir, 'mcp', 's1.json');
const secretPath = () => join(h.dataDir, 'mcp', 's1.key');

describe('派工工具：開 PTY 的參數', () => {
  it('hub 開著派工：帶 --mcp-config 與五個派工工具（含 release_member）的 --allowedTools，最後接 --name', async () => {
    await start(true);
    const { argv, env } = h.runs()[0]!;
    const at = argv.indexOf('--mcp-config');
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe(mcpConfigPath());
    expect(argv[at + 2]).toBe('--allowedTools');
    expect(argv.slice(at + 3, at + 3 + DISPATCH_TOOL_NAMES.length)).toEqual([
      'mcp__agent-board__list_members',
      'mcp__agent-board__spawn_member',
      'mcp__agent-board__send_task',
      'mcp__agent-board__get_result',
      'mcp__agent-board__release_member',
    ]);
    expect(argv[at + 3 + DISPATCH_TOOL_NAMES.length]).toBe('--name');
    expect(argv).not.toContain('--strict-mcp-config');

    // 權限：資料夾 0700、設定與密鑰 0600。
    expect(mode(join(h.dataDir, 'mcp'))).toBe(0o700);
    expect(mode(mcpConfigPath())).toBe(0o600);
    expect(mode(secretPath())).toBe(0o600);
    const secret = readFileSync(secretPath(), 'utf8');
    expect(secret.length).toBeGreaterThanOrEqual(40);
    // 密鑰不在 argv、不在 claude 的環境變數、不在 MCP 設定檔。
    expect(JSON.stringify(argv)).not.toContain(secret);
    expect(JSON.stringify(env)).not.toContain(secret);
    const config = readFileSync(mcpConfigPath(), 'utf8');
    expect(config).not.toContain(secret);
    const server = JSON.parse(config).mcpServers['agent-board'];
    expect(server).toMatchObject({
      type: 'stdio',
      command: process.execPath,
      args: [MCP_SERVER],
      env: {
        AGENT_BOARD_SESSION_ID: 's1',
        AGENT_BOARD_SOCKET: env.AGENT_BOARD_SOCKET,
        AGENT_BOARD_MCP_SECRET_FILE: secretPath(),
      },
    });
  });

  it('設定關著、舊版 hub（沒送 dispatch）、找不到 MCP server：都不帶，也不寫檔', async () => {
    for (const [dispatch, server] of [
      [false, MCP_SERVER],
      [undefined, MCP_SERVER],
      [true, null],
    ] as const) {
      await start(dispatch, server);
      const { argv } = h.runs()[0]!;
      expect(argv).not.toContain('--mcp-config');
      expect(argv).not.toContain('--allowedTools');
      expect(existsSync(mcpConfigPath())).toBe(false);
      await h.cleanup();
    }
  });

  it('設定改關之後新開的不掛；daemon 重啟沒連上 hub 前照上次的設定', async () => {
    await start(true);
    h.hub.send({
      type: 'hub.welcome',
      machineId: 'machine-1',
      dangerRules: [],
      stuckMinutes: 7,
      dispatch: false,
    });
    await waitUntil(() => !h.daemons[0]!['dispatchEnabled'], 'dispatch 關掉');
    h.hub.send({ type: 'session.create', requestId: 'r2', sessionId: 's2', spec: h.spec() });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'r2');
    await waitUntil(() => h.runs().length === 2, '第二個 claude');
    expect(h.runs()[1]!.argv).not.toContain('--mcp-config');
  });
});

describe('進度卡工具（P3 項目一）：掛載條件', () => {
  const allowed = (argv: string[]) => {
    const at = argv.indexOf('--allowedTools');
    const end = argv.indexOf('--name');
    return at === -1 ? [] : argv.slice(at + 1, end);
  };
  const toolsEnv = () =>
    JSON.parse(readFileSync(mcpConfigPath(), 'utf8')).mcpServers['agent-board'].env
      .AGENT_BOARD_MCP_TOOLS as string;

  it('hello 宣告 mcp.memory；派工與進度卡都開：--allowedTools 七個工具，設定檔 env 列同樣的七個', async () => {
    await start(true, MCP_SERVER, true);
    const hello = h.hub.received.find((m) => m.type === 'daemon.hello');
    expect(hello && 'features' in hello ? hello.features : []).toContain(DAEMON_FEATURES.memory);
    const { argv } = h.runs()[0]!;
    expect(allowed(argv)).toEqual([...DISPATCH_TOOL_NAMES, ...MEMORY_TOOL_NAMES]);
    expect(MEMORY_TOOL_NAMES).toEqual([
      'mcp__agent-board__get_progress',
      'mcp__agent-board__update_progress',
    ]);
    expect(toolsEnv()).toBe(
      'list_members,spawn_member,send_task,get_result,release_member,get_progress,update_progress',
    );
  });

  it('只開進度卡：只掛兩個工具；只開派工：只掛五個；兩個都關或舊版 hub：完全不掛', async () => {
    await start(false, MCP_SERVER, true);
    expect(allowed(h.runs()[0]!.argv)).toEqual([...MEMORY_TOOL_NAMES]);
    expect(toolsEnv()).toBe('get_progress,update_progress');
    await h.cleanup();
    await start(true, MCP_SERVER, false);
    expect(allowed(h.runs()[0]!.argv)).toEqual([...DISPATCH_TOOL_NAMES]);
    expect(toolsEnv()).toBe('list_members,spawn_member,send_task,get_result,release_member');
    await h.cleanup();
    for (const [dispatch, memory] of [
      [false, false],
      [undefined, undefined],
    ] as const) {
      await start(dispatch, MCP_SERVER, memory);
      expect(h.runs()[0]!.argv).not.toContain('--mcp-config');
      expect(existsSync(mcpConfigPath())).toBe(false);
      await h.cleanup();
    }
  });

  it('真的 MCP server：只開進度卡時 tools/list 只有兩個；get_progress 經 daemon 到 hub 再回來', async () => {
    await start(false, MCP_SERVER, true);
    const config = JSON.parse(readFileSync(mcpConfigPath(), 'utf8')).mcpServers['agent-board'];
    const child = spawn(config.command, config.args, {
      env: { PATH: process.env.PATH, ...config.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const rpc = (id: number, method: string, params: unknown = {}) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const reply = (id: number) => waitUntil(() => lines.find((l) => l.id === id), `reply ${id}`);
    try {
      rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      await reply(1);
      rpc(2, 'tools/list');
      const tools = ((await reply(2)).result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual(['get_progress', 'update_progress']);
      rpc(3, 'tools/call', { name: 'get_progress', arguments: {} });
      const request = await h.hub.waitFor('dispatch.request');
      expect(request).toMatchObject({ sessionId: 's1', tool: 'get_progress', args: {} });
      h.hub.send({
        type: 'dispatch.reply',
        requestId: request.requestId,
        ok: true,
        text: '{"revision":0}',
      });
      expect((await reply(3)).result).toEqual({
        content: [{ type: 'text', text: '{"revision":0}' }],
        isError: false,
      });
    } finally {
      child.kill();
    }
  });
});

describe('進度卡設定關掉（P3 §1.8 驗收 8）', () => {
  it('開著時開的 session 有進度卡工具；hub 重送 welcome 關掉後新開的 session，真的 MCP server tools/list 沒有 get_progress', async () => {
    await start(true, MCP_SERVER, true);
    h.hub.send({
      type: 'hub.welcome',
      machineId: 'machine-1',
      dangerRules: h.hub.dangerRules,
      stuckMinutes: h.hub.stuckMinutes,
      dispatch: true,
      memory: false,
    });
    // welcome 是非同步套用：等 daemon 存下設定再開新的 session。
    await waitUntil(() => {
      try {
        return JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')).memory === false;
      } catch {
        return false;
      }
    }, 'memory off persisted');
    await h.createAndSubscribe('s2');
    const config = JSON.parse(readFileSync(join(h.dataDir, 'mcp', 's2.json'), 'utf8')).mcpServers[
      'agent-board'
    ];
    const child = spawn(config.command, config.args, {
      env: { PATH: process.env.PATH, ...config.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const rpc = (id: number, method: string, params: unknown = {}) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const reply = (id: number) => waitUntil(() => lines.find((l) => l.id === id), `reply ${id}`);
    try {
      rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      await reply(1);
      rpc(2, 'tools/list');
      const tools = ((await reply(2)).result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual([
        'list_members',
        'spawn_member',
        'send_task',
        'get_result',
        'release_member',
      ]);
      const argv = h.runs().at(-1)!.argv;
      expect(argv.join(' ')).not.toContain('get_progress');
      // 關掉前開的 s1 照舊（設定只影響新開的 PTY）。
      expect(h.runs()[0]!.argv.join(' ')).toContain('mcp__agent-board__get_progress');
    } finally {
      child.kill();
    }
  });
});

describe('派工工具：密鑰與轉送', () => {
  it('密鑰正確才轉給 hub；hub 的回答原樣交回', async () => {
    const daemon = await start(true);
    const secret = readFileSync(secretPath(), 'utf8');
    const pending = askDaemon(daemon.hookSocketPath, {
      sessionId: 's1',
      secret,
      tool: 'list_members',
      args: {},
    });
    const request = await h.hub.waitFor('dispatch.request');
    expect(request).toMatchObject({ sessionId: 's1', tool: 'list_members', args: {} });
    // 密鑰不會送到 hub。
    expect(JSON.stringify(request)).not.toContain(secret);
    h.hub.send({
      type: 'dispatch.reply',
      requestId: request.requestId,
      ok: true,
      text: '{"teams":[]}',
    });
    expect(await pending).toEqual({ ok: true, text: '{"teams":[]}' });
  });

  it('密鑰不對、冒用別的 session、session 已結束：一律拒絕，不轉給 hub', async () => {
    const daemon = await start(true);
    const secret = readFileSync(secretPath(), 'utf8');
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches(secret, `${secret}x`)).toBe(false);
    const wrong = await askDaemon(daemon.hookSocketPath, {
      sessionId: 's1',
      secret: 'x'.repeat(43),
      tool: 'list_members',
      args: {},
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toMatch(/^unauthorized:/);
    const other = await askDaemon(daemon.hookSocketPath, {
      sessionId: 'someone-else',
      secret,
      tool: 'spawn_member',
      args: {},
    });
    expect(other.text).toMatch(/^unauthorized:/);

    h.hub.send({ type: 'session.stop', sessionId: 's1' });
    await h.hub.waitFor('session.event', (m) => m.event.type === 'exit');
    // 結束的 session：檔案刪掉、密鑰作廢。
    await waitUntil(() => !existsSync(secretPath()), '密鑰檔刪除');
    expect(existsSync(mcpConfigPath())).toBe(false);
    const ended = await askDaemon(daemon.hookSocketPath, {
      sessionId: 's1',
      secret,
      tool: 'list_members',
      args: {},
    });
    expect(ended.text).toMatch(/^unauthorized:/);
    expect(h.hub.received.some((m) => m.type === 'dispatch.request')).toBe(false);
  });

  it('hub 不回答就逾時；格式不對的請求回 invalid_request', async () => {
    h = new Harness();
    h.hub.dispatch = true;
    h.mcpServer = MCP_SERVER;
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    const daemon = await h.startDaemon({ dispatchReplyTimeoutMs: 100 });
    await h.createAndSubscribe('s1');
    const secret = readFileSync(secretPath(), 'utf8');
    const timedOut = await askDaemon(daemon.hookSocketPath, {
      sessionId: 's1',
      secret,
      tool: 'get_result',
      args: { member: 'x' },
    });
    expect(timedOut.text).toMatch(/^timeout:/);
    const bad = await askDaemon(daemon.hookSocketPath, { sessionId: 's1', secret, tool: 'rm_rf' });
    expect(bad.text).toMatch(/^invalid_request:/);
  });

  it('真的 MCP server（stdio）：initialize → tools/list → tools/call 經 daemon 到 hub 再回來', async () => {
    await start(true);
    const config = JSON.parse(readFileSync(mcpConfigPath(), 'utf8')).mcpServers['agent-board'];
    const child = spawn(config.command, config.args, {
      env: { PATH: process.env.PATH, ...config.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines: Record<string, unknown>[] = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const rpc = (id: number, method: string, params: unknown = {}) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const reply = (id: number) => waitUntil(() => lines.find((l) => l.id === id), `reply ${id}`);
    try {
      rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      expect(((await reply(1)).result as { protocolVersion: string }).protocolVersion).toBe(
        '2025-06-18',
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      rpc(2, 'tools/list');
      const tools = ((await reply(2)).result as { tools: { name: string }[] }).tools;
      expect(tools.map((t) => t.name)).toEqual([
        'list_members',
        'spawn_member',
        'send_task',
        'get_result',
        'release_member',
      ]);
      rpc(3, 'tools/call', { name: 'send_task', arguments: { member: 'BD1', text: 'go' } });
      const request = await h.hub.waitFor('dispatch.request');
      expect(request).toMatchObject({
        sessionId: 's1',
        tool: 'send_task',
        args: { member: 'BD1', text: 'go' },
      });
      h.hub.send({
        type: 'dispatch.reply',
        requestId: request.requestId,
        ok: false,
        text: 'not_your_member: nope',
      });
      expect((await reply(3)).result).toEqual({
        content: [{ type: 'text', text: 'not_your_member: nope' }],
        isError: true,
      });
    } finally {
      child.kill();
    }
  });
});

// Codex 第二輪（GM 2026-11-12）：Codex session 用 -c 帶入同一支 MCP server、同一套密鑰。
describe.skipIf(process.platform === 'win32')('Codex 掛派工工具', () => {
  it('-c mcp_servers.agent-board.*：同一支 server、env 只有密鑰檔路徑、只露出開著的工具、免核准；密鑰驗證同 Claude', async () => {
    h = new Harness();
    h.hub.dispatch = true;
    h.mcpServer = MCP_SERVER;
    await h.start();
    const daemon = await h.restartDaemon({
      capabilities: { ...FAKE_CAPABILITIES, codexVersion: '0.167.0' },
    });
    await h.createAndSubscribe('c1', { agent: 'codex', firstPrompt: 'hi' });
    const { argv } = h.runs().at(-1)!;
    const overrides = argv.filter((_, i) => argv[i - 1] === '-c');
    const mcp = overrides.filter((o) => o.startsWith('mcp_servers.agent-board.'));
    expect(mcp.map((o) => o.split('=')[0])).toEqual([
      'mcp_servers.agent-board.command',
      'mcp_servers.agent-board.args',
      'mcp_servers.agent-board.env',
      'mcp_servers.agent-board.enabled_tools',
      'mcp_servers.agent-board.default_tools_approval_mode',
    ]);
    expect(mcp[1]).toContain('mcp.ts');
    const secretFile = join(h.dataDir, 'mcp', 'c1.key');
    const secret = readFileSync(secretFile, 'utf8');
    expect(mode(secretFile)).toBe(0o600);
    // 密鑰不在 argv（ps 看得到），只有檔案路徑。
    expect(argv.join(' ')).not.toContain(secret);
    expect(mcp[2]).toContain('AGENT_BOARD_MCP_SECRET_FILE=');
    expect(mcp[2]).toContain('AGENT_BOARD_SESSION_ID="c1"');
    expect(mcp[2]).toContain('AGENT_BOARD_HOOK_KEY_FILE=');
    expect(mcp[3]).toBe(
      'mcp_servers.agent-board.enabled_tools=["list_members","spawn_member","send_task","get_result","release_member"]',
    );
    expect(mcp[4]).toBe('mcp_servers.agent-board.default_tools_approval_mode="approve"');
    // 提示仍在最後（-- 之後）。
    expect(argv.slice(-2)).toEqual(['--', 'hi']);

    const pending = askDaemon(daemon.hookSocketPath, {
      sessionId: 'c1',
      secret,
      tool: 'list_members',
      args: {},
    });
    const request = await h.hub.waitFor('dispatch.request', (m) => m.sessionId === 'c1');
    h.hub.send({ type: 'dispatch.reply', requestId: request.requestId, ok: true, text: '{}' });
    expect(await pending).toEqual({ ok: true, text: '{}' });
  });

  it('派工與進度卡都關：Codex 也完全不掛', async () => {
    h = new Harness();
    h.hub.dispatch = false;
    h.hub.memory = false;
    h.mcpServer = MCP_SERVER;
    await h.start();
    await h.restartDaemon({ capabilities: { ...FAKE_CAPABILITIES, codexVersion: '0.167.0' } });
    await h.createAndSubscribe('c2', { agent: 'codex' });
    expect(
      h
        .runs()
        .at(-1)!
        .argv.some((a) => a.startsWith('mcp_servers.')),
    ).toBe(false);
    expect(existsSync(join(h.dataDir, 'mcp', 'c2.key'))).toBe(false);
  });
});
