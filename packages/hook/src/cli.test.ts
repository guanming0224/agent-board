// 用真的子行程跑 cli.ts，對面是臨時 socket 上的假 daemon。不會執行 claude。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCKING_HOOK_EVENTS,
  CODEX_PERMISSION_HOOK_WAIT_MS,
  CODEX_PERMISSION_WAIT_MS,
  codexHookTimeout,
  HOOK_AGENT_FLAG,
  HOOK_ENV,
  HOOK_SESSION_FLAG,
  HOOK_SOCKET_FLAG,
  HOOK_TIMEOUT_SECONDS,
  HOOK_WAIT_MS,
  HookEventName,
  HookRequest,
} from '@agent-board/protocol';
import {
  AGENT_FLAG,
  BLOCKING_EVENTS,
  CODEX_PERMISSION_HOOK_WAIT_MS as CLI_CODEX_PERMISSION_WAIT_MS,
  HOOK_EVENTS,
  SESSION_FLAG,
  SOCKET_FLAG,
  HOOK_WAIT_MS as CLI_HOOK_WAIT_MS,
  SESSION_ID_ENV,
  SOCKET_ENV,
  WAIT_OVERRIDE_ENV,
} from './cli-constants.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

// 欄位取自 docs/claude-code-notes.md。
const base = { session_id: 'claude-1', transcript_path: '/tmp/t.jsonl', cwd: '/tmp' };
const stopInput = { ...base, permission_mode: 'default', hook_event_name: 'Stop' };
const bashInput = {
  ...base,
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push --force' },
  tool_use_id: 'toolu_1',
};
const readInput = { ...bashInput, tool_name: 'Read', tool_input: { file_path: '/tmp/x' } };
const permissionInput = {
  ...base,
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  permission_suggestions: [],
};

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  ms: number;
}

interface RunOptions {
  args: string[];
  env?: Record<string, string>;
  /** undefined 表示關閉 stdin 不寫東西。 */
  stdin?: string;
  onSpawn?: (kill: (signal: NodeJS.Signals) => void) => void;
}

function runCli({ args, env = {}, stdin, onSpawn }: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // 不繼承外面的環境，確保不會碰到真的 session 或 daemon。
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, ms: Date.now() - started });
    });
    child.stdin.end(stdin);
    onSpawn?.((signal) => child.kill(signal));
  });
}

type OnRequest = (request: HookRequest, socket: Socket) => void;

interface FakeDaemon {
  path: string;
  requests: HookRequest[];
  /** 每個連線是否被 hook 端關閉，用來確認阻塞事件保持連線。 */
  server: Server;
  close: () => Promise<void>;
}

async function startDaemon(
  dir: string,
  onRequest: OnRequest = () => undefined,
): Promise<FakeDaemon> {
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agent-board-test-${crypto.randomUUID()}`
      : join(dir, 'd.sock');
  const requests: HookRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        // 用正式 schema 驗證：CLI 沒載入 zod，這裡保證它送的東西 daemon 收得下。
        const request = HookRequest.parse(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        requests.push(request);
        onRequest(request, socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    server,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function reply(socket: Socket, requestId: string, output: Record<string, unknown> | null): void {
  socket.write(`${JSON.stringify({ type: 'hook.reply', requestId, output })}\n`);
}

function decisionOf(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return parsed.hookSpecificOutput.permissionDecision;
}

describe('agent-board-hook CLI', () => {
  let dir: string;
  let daemon: FakeDaemon | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ab-hook-'));
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    await rm(dir, { recursive: true, force: true });
  });

  function env(socket?: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      [HOOK_ENV.sessionId]: 'board-1',
      ...(socket ? { [HOOK_ENV.socket]: socket } : {}),
      ...extra,
    };
  }

  function missingSocket(): string {
    return join(dir, 'nobody-listening.sock');
  }

  function expectSilentExit(result: RunResult): void {
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('');
  }

  describe('常數與 protocol 一致', () => {
    it('抄寫的常數沒有分岔', () => {
      expect(SESSION_ID_ENV).toBe(HOOK_ENV.sessionId);
      expect(SOCKET_ENV).toBe(HOOK_ENV.socket);
      expect(CLI_HOOK_WAIT_MS).toBe(HOOK_WAIT_MS);
      expect([...HOOK_EVENTS]).toEqual([...HookEventName.options]);
      expect([...BLOCKING_EVENTS]).toEqual([...BLOCKING_HOOK_EVENTS]);
      expect(AGENT_FLAG).toBe(HOOK_AGENT_FLAG);
      expect(SESSION_FLAG).toBe(HOOK_SESSION_FLAG);
      expect(SOCKET_FLAG).toBe(HOOK_SOCKET_FLAG);
      expect(CLI_CODEX_PERMISSION_WAIT_MS).toBe(CODEX_PERMISSION_HOOK_WAIT_MS);
    });

    it('Codex PermissionRequest：daemon 先放棄、CLI 再放棄、最後才是 Codex 的 timeout（各差 5 秒）', () => {
      expect(CODEX_PERMISSION_WAIT_MS + 5_000).toBe(CLI_CODEX_PERMISSION_WAIT_MS);
      expect(CLI_CODEX_PERMISSION_WAIT_MS + 5_000).toBe(
        codexHookTimeout('PermissionRequest') * 1000,
      );
    });

    it('等待上限小於寫進設定的 hook timeout', () => {
      expect(CLI_HOOK_WAIT_MS).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1000);
    });

    it('cli.ts 與 cli-constants.ts 在 runtime 不載入 protocol 或任何第三方套件', async () => {
      for (const file of ['./cli.ts', './cli-constants.ts']) {
        const source = await readFile(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
        const imports = [...source.matchAll(/^import (?!type )[^;]*?from '([^']+)'/gms)].map(
          (match) => match[1] ?? '',
        );
        for (const specifier of imports) {
          expect(specifier).toMatch(/^(node:|\.\/)/);
        }
      }
    });
  });

  describe('鐵律：exit 0 且 stdout 空', () => {
    it('沒有 AGENT_BOARD_SESSION_ID', async () => {
      daemon = await startDaemon(dir);
      const result = await runCli({
        args: ['PreToolUse'],
        env: { [HOOK_ENV.socket]: daemon.path },
        stdin: JSON.stringify(bashInput),
      });
      expectSilentExit(result);
      expect(daemon.requests).toEqual([]);
    });

    it('AGENT_BOARD_SESSION_ID 是空字串', async () => {
      expectSilentExit(
        await runCli({
          args: ['Stop'],
          env: { [HOOK_ENV.sessionId]: '' },
          stdin: JSON.stringify(stopInput),
        }),
      );
    });

    it('沒有 env 時不等 stdin（stdin 一直開著也立刻結束）', async () => {
      const child = spawn(process.execPath, [CLI, 'Stop'], {
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      const code = await new Promise((resolve) => child.on('close', resolve));
      child.stdin.destroy();
      expect(code).toBe(0);
    });

    it('有 env 但 stdin 一直不關：到期限後 exit 0', { timeout: 15_000 }, async () => {
      const child = spawn(process.execPath, [CLI, 'PreToolUse'], {
        env: { PATH: process.env.PATH ?? '', ...env(missingSocket()) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      const code = await new Promise((resolve) => child.on('close', resolve));
      child.stdin.destroy();
      expect(code).toBe(0);
      expect(stdout).toBe('');
    });

    it.runIf(process.platform !== 'win32')('可以靠 shebang 直接執行（bin 的用法）', async () => {
      const result = spawnSync(CLI, ['Stop'], {
        env: { PATH: process.env.PATH ?? '' },
        input: '',
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.toString()).toBe('');
    });

    it.each(['NotARealEvent', 'stop', '--help', ''])('未知事件 %j', async (event) => {
      daemon = await startDaemon(dir);
      const result = await runCli({
        args: [event],
        env: env(daemon.path),
        stdin: JSON.stringify(stopInput),
      });
      expectSilentExit(result);
      expect(daemon.requests).toEqual([]);
    });

    it('沒有事件參數', async () => {
      expectSilentExit(await runCli({ args: [], env: env(missingSocket()), stdin: '{}' }));
    });

    it.each([
      ['壞 JSON', '{ not json'],
      ['空 stdin', ''],
      ['JSON 陣列', '[]'],
      ['JSON 字串', '"x"'],
      ['JSON null', 'null'],
    ])('stdin 是%s', async (_name, stdin) => {
      daemon = await startDaemon(dir);
      for (const event of ['PreToolUse', 'PermissionRequest', 'Stop']) {
        expectSilentExit(await runCli({ args: [event], env: env(daemon.path), stdin }));
      }
      expect(daemon.requests).toEqual([]);
    });

    it('欄位不足的非 Bash payload 不送、不輸出', async () => {
      daemon = await startDaemon(dir);
      expectSilentExit(await runCli({ args: ['Stop'], env: env(daemon.path), stdin: '{"foo":1}' }));
      expect(daemon.requests).toEqual([]);
    });

    it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
      '等待中被 %s 終止也 exit 0',
      async (signal) => {
        let kill: ((value: NodeJS.Signals) => void) | undefined;
        daemon = await startDaemon(dir, () => kill?.(signal));
        const result = await runCli({
          args: ['PermissionRequest'],
          env: env(daemon.path),
          stdin: JSON.stringify(permissionInput),
          onSpawn: (killer) => {
            kill = killer;
          },
        });
        expectSilentExit(result);
      },
    );
  });

  describe('連不上 socket', () => {
    it.each([
      ['Stop', stopInput],
      ['PostToolUse', { ...bashInput, hook_event_name: 'PostToolUse', tool_response: {} }],
      ['PostToolUseFailure', { ...bashInput, hook_event_name: 'PostToolUseFailure', error: 'x' }],
      ['Notification', { ...base, hook_event_name: 'Notification', notification_type: 'x' }],
      ['SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'startup' }],
      ['SessionEnd', { ...base, hook_event_name: 'SessionEnd', reason: 'other' }],
      ['UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }],
      ['StopFailure', { ...base, hook_event_name: 'StopFailure', error: 'rate_limit' }],
      ['PermissionRequest', permissionInput],
      ['PreToolUse', readInput],
    ])('%s（非 PreToolUse + Bash）exit 0 不輸出', async (event, input) => {
      expectSilentExit(
        await runCli({
          args: [event],
          env: env(missingSocket()),
          stdin: JSON.stringify(input),
        }),
      );
    });

    it('PreToolUse + Bash 回 ask（§4.3）', async () => {
      const result = await runCli({
        args: ['PreToolUse'],
        env: env(missingSocket()),
        stdin: JSON.stringify(bashInput),
      });
      expect(result.code).toBe(0);
      expect(decisionOf(result.stdout)).toBe('ask');
    });

    it('沒有 AGENT_BOARD_SOCKET：PreToolUse + Bash 回 ask，其他安靜', async () => {
      const bash = await runCli({
        args: ['PreToolUse'],
        env: env(),
        stdin: JSON.stringify(bashInput),
      });
      expect(bash.code).toBe(0);
      expect(decisionOf(bash.stdout)).toBe('ask');
      expectSilentExit(
        await runCli({ args: ['Stop'], env: env(), stdin: JSON.stringify(stopInput) }),
      );
    });

    it('Bash 但缺 session_id（無法檢查）回 ask', async () => {
      daemon = await startDaemon(dir);
      const input = { ...bashInput, session_id: undefined };
      const result = await runCli({
        args: ['PreToolUse'],
        env: env(daemon.path),
        stdin: JSON.stringify(input),
      });
      expect(result.code).toBe(0);
      expect(decisionOf(result.stdout)).toBe('ask');
    });
  });

  describe('非 blocking 事件', () => {
    it.each([
      ['Stop', stopInput],
      ['PostToolUse', { ...bashInput, hook_event_name: 'PostToolUse', tool_response: {} }],
      ['PostToolUseFailure', { ...bashInput, hook_event_name: 'PostToolUseFailure', error: 'x' }],
      ['StopFailure', { ...base, hook_event_name: 'StopFailure', error: 'rate_limit' }],
      [
        'Notification',
        { ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' },
      ],
      ['SessionStart', { ...base, hook_event_name: 'SessionStart', source: 'clear' }],
      ['SessionEnd', { ...base, hook_event_name: 'SessionEnd', reason: 'exit' }],
      ['UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: '中文 🙂' }],
    ])('%s 送出就走，內容完整，不等回答', async (event, input) => {
      daemon = await startDaemon(dir); // 假 daemon 永遠不回答。
      const result = await runCli({
        args: [event],
        env: env(daemon.path),
        stdin: JSON.stringify(input),
      });
      expectSilentExit(result);
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]).toMatchObject({
        type: 'hook',
        sessionId: 'board-1',
        event,
        payload: input,
      });
    });

    it('daemon 不讀資料：到期限後 exit 0，不會卡住', async () => {
      const path = join(dir, 'paused.sock');
      const sockets: Socket[] = [];
      const server = createServer({ pauseOnConnect: true }, (socket) => sockets.push(socket));
      await new Promise<void>((resolve) => server.listen(path, resolve));
      try {
        const result = await runCli({
          args: ['Stop'],
          env: env(path),
          stdin: JSON.stringify({ ...stopInput, last_assistant_message: 'x'.repeat(4_000_000) }),
        });
        expectSilentExit(result);
        expect(result.ms).toBeLessThan(4_000);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('未列在 HookPayload 的欄位原樣保留', async () => {
      daemon = await startDaemon(dir);
      await runCli({
        args: ['Stop'],
        env: env(daemon.path),
        stdin: JSON.stringify({ ...stopInput, future_field: { a: 1 } }),
      });
      expect(daemon.requests[0]?.payload.future_field).toEqual({ a: 1 });
    });

    it('很大的 payload 也完整送達', async () => {
      daemon = await startDaemon(dir);
      const big = 'x'.repeat(2_000_000);
      expectSilentExit(
        await runCli({
          args: ['Stop'],
          env: env(daemon.path),
          stdin: JSON.stringify({ ...stopInput, last_assistant_message: big }),
        }),
      );
      expect(daemon.requests[0]?.payload.last_assistant_message).toBe(big);
    });

    it('每次都用不同的 requestId', async () => {
      daemon = await startDaemon(dir);
      for (let i = 0; i < 2; i += 1) {
        await runCli({ args: ['Stop'], env: env(daemon.path), stdin: JSON.stringify(stopInput) });
      }
      const [first, second] = daemon.requests;
      expect(first?.requestId).not.toBe(second?.requestId);
    });
  });

  describe('blocking 事件', () => {
    it('PermissionRequest：等 daemon，把 output 原樣印出', async () => {
      const output = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      };
      daemon = await startDaemon(dir, (request, socket) => {
        setTimeout(() => reply(socket, request.requestId, output), 100);
      });
      const result = await runCli({
        args: ['PermissionRequest'],
        env: env(daemon.path),
        stdin: JSON.stringify(permissionInput),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(output);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(result.ms).toBeGreaterThanOrEqual(100);
    });

    it('未命中（output: null）：exit 0 不輸出', async () => {
      daemon = await startDaemon(dir, (request, socket) => {
        reply(socket, request.requestId, null);
      });
      expectSilentExit(
        await runCli({
          args: ['PreToolUse'],
          env: env(daemon.path),
          stdin: JSON.stringify(bashInput),
        }),
      );
      expect(daemon.requests[0]?.payload.tool_name).toBe('Bash');
    });

    it.each(['allow', 'deny'])('危險指令：daemon 決定 %s 就印出', async (decision) => {
      daemon = await startDaemon(dir, (request, socket) => {
        reply(socket, request.requestId, {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision },
        });
      });
      const result = await runCli({
        args: ['PreToolUse'],
        env: env(daemon.path),
        stdin: JSON.stringify(bashInput),
      });
      expect(result.code).toBe(0);
      expect(decisionOf(result.stdout)).toBe(decision);
    });

    it('等待中保持連線，不半關閉', async () => {
      let endedBeforeReply: boolean | null = null;
      daemon = await startDaemon(dir, (request, socket) => {
        setTimeout(() => {
          endedBeforeReply = socket.readableEnded;
          reply(socket, request.requestId, null);
        }, 100);
      });
      await runCli({
        args: ['PreToolUse'],
        env: env(daemon.path),
        stdin: JSON.stringify(readInput),
      });
      expect(endedBeforeReply).toBe(false);
    });

    it('requestId 不符的回答不算，繼續等', async () => {
      daemon = await startDaemon(dir, (request, socket) => {
        reply(socket, 'someone-else', {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
        });
        setTimeout(() => {
          reply(socket, request.requestId, {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
          });
        }, 50);
      });
      const result = await runCli({
        args: ['PreToolUse'],
        env: env(daemon.path),
        stdin: JSON.stringify(bashInput),
      });
      expect(decisionOf(result.stdout)).toBe('deny');
    });

    it('回答被切成多個 chunk 也能解析', async () => {
      daemon = await startDaemon(dir, (request, socket) => {
        const line = `${JSON.stringify({ type: 'hook.reply', requestId: request.requestId, output: null })}\n`;
        socket.write(line.slice(0, 10));
        setTimeout(() => socket.write(line.slice(10)), 50);
      });
      expectSilentExit(
        await runCli({
          args: ['PreToolUse'],
          env: env(daemon.path),
          stdin: JSON.stringify(readInput),
        }),
      );
    });

    const fast = { [WAIT_OVERRIDE_ENV]: '200' };

    it('超時：PreToolUse + Bash 回 deny（§4.3）', async () => {
      daemon = await startDaemon(dir);
      const result = await runCli({
        args: ['PreToolUse'],
        env: env(daemon.path, fast),
        stdin: JSON.stringify(bashInput),
      });
      expect(result.code).toBe(0);
      expect(decisionOf(result.stdout)).toBe('deny');
      expect(result.ms).toBeGreaterThanOrEqual(200);
    });

    it('超時：PermissionRequest exit 0 不輸出，交回原生流程', async () => {
      daemon = await startDaemon(dir);
      const result = await runCli({
        args: ['PermissionRequest'],
        env: env(daemon.path, fast),
        stdin: JSON.stringify(permissionInput),
      });
      expectSilentExit(result);
      expect(result.ms).toBeGreaterThanOrEqual(200);
    });

    it('超時：PreToolUse 非 Bash exit 0 不輸出', async () => {
      daemon = await startDaemon(dir);
      expectSilentExit(
        await runCli({
          args: ['PreToolUse'],
          env: env(daemon.path, fast),
          stdin: JSON.stringify(readInput),
        }),
      );
    });

    it('等待上限的 override 不能超過 HOOK_WAIT_MS，壞值會被忽略', async () => {
      for (const value of ['abc', '-1', '0', String(HOOK_WAIT_MS * 2)]) {
        daemon = await startDaemon(dir, (request, socket) => {
          // 若 override 被採用（立刻超時）就會是 deny；被忽略才等得到這個回答。
          setTimeout(() => reply(socket, request.requestId, null), 50);
        });
        expectSilentExit(
          await runCli({
            args: ['PreToolUse'],
            env: env(daemon.path, { [WAIT_OVERRIDE_ENV]: value }),
            stdin: JSON.stringify(bashInput),
          }),
        );
        await daemon.close();
        daemon = null;
        await rm(join(dir, 'd.sock'), { force: true });
      }
    });

    describe('daemon 中途出問題', () => {
      const closeNow: OnRequest = (_request, socket) => {
        socket.destroy();
      };
      const garbage: OnRequest = (_request, socket) => {
        socket.write('this is not json\n');
      };
      const wrongShape: OnRequest = (request, socket) => {
        socket.write(
          `${JSON.stringify({ type: 'hook.reply', requestId: request.requestId, output: 'x' })}\n`,
        );
      };

      it.each([
        ['斷線', closeNow],
        ['回垃圾', garbage],
        ['output 型別不對', wrongShape],
      ])('%s：Bash 回 ask', async (_name, handler) => {
        daemon = await startDaemon(dir, handler);
        const result = await runCli({
          args: ['PreToolUse'],
          env: env(daemon.path),
          stdin: JSON.stringify(bashInput),
        });
        expect(result.code).toBe(0);
        expect(decisionOf(result.stdout)).toBe('ask');
      });

      it.each([
        ['斷線', closeNow],
        ['回垃圾', garbage],
        ['output 型別不對', wrongShape],
      ])('%s：PermissionRequest exit 0 不輸出，垃圾不會漏到 stdout', async (_name, handler) => {
        daemon = await startDaemon(dir, handler);
        expectSilentExit(
          await runCli({
            args: ['PermissionRequest'],
            env: env(daemon.path),
            stdin: JSON.stringify(permissionInput),
          }),
        );
      });
    });
  });

  // Codex（`--agent codex`，CONTRACTS §19）：欄位取自官方 hooks 文件；PreToolUse 不支援 ask。
  describe('Codex', () => {
    const codexBase = {
      session_id: '0199a3c2-0000-7000-8000-000000000001',
      transcript_path: null,
      cwd: '/tmp',
      model: 'gpt-test',
      turn_id: 'turn-1',
      permission_mode: 'default',
    };
    const codexBash = {
      ...codexBase,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force' },
      tool_use_id: 'call_1',
    };

    it('帶 --agent codex：request 標 agent codex，事件照送', async () => {
      daemon = await startDaemon(dir);
      expectSilentExit(
        await runCli({
          args: ['--agent', 'codex', 'Stop'],
          env: env(daemon.path),
          stdin: JSON.stringify({ ...codexBase, hook_event_name: 'Stop' }),
        }),
      );
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]?.agent).toBe('codex');
      expect(daemon.requests[0]?.event).toBe('Stop');
    });

    it('Codex 才有的事件（Interrupt、PostModelRequest）也送', async () => {
      daemon = await startDaemon(dir);
      for (const event of ['Interrupt', 'PostModelRequest']) {
        expectSilentExit(
          await runCli({
            args: ['--agent', 'codex', event],
            env: env(daemon.path),
            stdin: JSON.stringify({ ...codexBase, hook_event_name: event }),
          }),
        );
      }
      expect(daemon.requests.map((r) => r.event)).toEqual(['Interrupt', 'PostModelRequest']);
    });

    it('不帶 --agent：request 沒有 agent（Claude Code，舊行為）', async () => {
      daemon = await startDaemon(dir);
      await runCli({ args: ['Stop'], env: env(daemon.path), stdin: JSON.stringify(stopInput) });
      expect(daemon.requests[0]?.agent).toBeUndefined();
    });

    it('認不得的 agent 或缺事件：安靜結束、不送', async () => {
      daemon = await startDaemon(dir);
      for (const args of [['--agent', 'gemini', 'Stop'], ['--agent', 'codex'], ['--agent']]) {
        expectSilentExit(
          await runCli({ args, env: env(daemon.path), stdin: JSON.stringify(stopInput) }),
        );
      }
      expect(daemon.requests).toEqual([]);
    });

    it('shell 工具統一成 Bash、陣列指令加引號接成字串，daemon 才解得開 bash -c', async () => {
      daemon = await startDaemon(dir, (request, socket) => reply(socket, request.requestId, null));
      await runCli({
        args: ['--agent', 'codex', 'PreToolUse'],
        env: env(daemon.path),
        stdin: JSON.stringify({
          ...codexBash,
          tool_name: 'shell',
          tool_input: { command: ['bash', '-lc', 'rm -rf /'] },
        }),
      });
      expect(daemon.requests[0]?.payload.tool_name).toBe('Bash');
      expect(daemon.requests[0]?.payload.tool_input).toEqual({ command: "bash -lc 'rm -rf /'" });
    });

    it('連不上：PreToolUse + Bash 回 deny（Codex 不支援 ask）', async () => {
      const result = await runCli({
        args: ['--agent', 'codex', 'PreToolUse'],
        env: env(missingSocket()),
        stdin: JSON.stringify(codexBash),
      });
      expect(result.code).toBe(0);
      expect(decisionOf(result.stdout)).toBe('deny');
    });

    it('超時：PreToolUse + Bash 回 deny', async () => {
      daemon = await startDaemon(dir);
      const result = await runCli({
        args: ['--agent', 'codex', 'PreToolUse'],
        env: env(daemon.path, { [WAIT_OVERRIDE_ENV]: '300' }),
        stdin: JSON.stringify(codexBash),
      });
      expect(decisionOf(result.stdout)).toBe('deny');
    });

    it('連不上：PermissionRequest 安靜結束（照常跳 Codex 原生確認）', async () => {
      expectSilentExit(
        await runCli({
          args: ['--agent', 'codex', 'PermissionRequest'],
          env: env(missingSocket()),
          stdin: JSON.stringify({
            ...codexBase,
            hook_event_name: 'PermissionRequest',
            tool_name: 'Bash',
            tool_input: { command: 'touch a.txt' },
          }),
        }),
      );
    });

    it('--session／--socket 參數：不靠環境變數也送得到，且優先於環境變數', async () => {
      daemon = await startDaemon(dir);
      expectSilentExit(
        await runCli({
          args: ['--agent', 'codex', '--session', 'board-arg', '--socket', daemon.path, 'Stop'],
          env: {},
          stdin: JSON.stringify({ ...codexBase, hook_event_name: 'Stop' }),
        }),
      );
      expectSilentExit(
        await runCli({
          args: ['--agent', 'codex', '--session', 'board-arg', '--socket', daemon.path, 'Stop'],
          env: env(missingSocket()),
          stdin: JSON.stringify({ ...codexBase, hook_event_name: 'Stop' }),
        }),
      );
      expect(daemon.requests.map((r) => r.sessionId)).toEqual(['board-arg', 'board-arg']);
    });

    it('拿不到 session：PreToolUse 回 deny（不安靜放行），其他事件安靜結束', async () => {
      const result = await runCli({
        args: ['--agent', 'codex', 'PreToolUse'],
        env: {},
        stdin: JSON.stringify(codexBash),
      });
      expect(result.code).toBe(0);
      expect(decisionOf(result.stdout)).toBe('deny');
      expectSilentExit(
        await runCli({
          args: ['--agent', 'codex', 'Stop'],
          env: {},
          stdin: JSON.stringify({ ...codexBase, hook_event_name: 'Stop' }),
        }),
      );
    });

    it('stdin 不是 JSON：PreToolUse 回 deny；Claude 照舊安靜結束', async () => {
      const codexResult = await runCli({
        args: ['--agent', 'codex', 'PreToolUse'],
        env: env(missingSocket()),
        stdin: 'not json',
      });
      expect(codexResult.code).toBe(0);
      expect(decisionOf(codexResult.stdout)).toBe('deny');
      expectSilentExit(
        await runCli({ args: ['PreToolUse'], env: env(missingSocket()), stdin: 'not json' }),
      );
    });

    it('不在清單裡的工具名，只要有 command 也當成 Bash 檢查', async () => {
      daemon = await startDaemon(dir, (request, socket) => reply(socket, request.requestId, null));
      await runCli({
        args: ['--agent', 'codex', 'PreToolUse'],
        env: env(daemon.path),
        stdin: JSON.stringify({
          ...codexBash,
          tool_name: 'run_terminal_v9',
          tool_input: { cmd: 'git push --force' },
        }),
      });
      expect(daemon.requests[0]?.payload.tool_name).toBe('Bash');
      expect(daemon.requests[0]?.payload.tool_input).toMatchObject({ command: 'git push --force' });
    });

    it('PermissionRequest：daemon 的回答原樣印出', async () => {
      const output = {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      };
      daemon = await startDaemon(dir, (request, socket) =>
        reply(socket, request.requestId, output),
      );
      const result = await runCli({
        args: ['--agent', 'codex', 'PermissionRequest'],
        env: env(daemon.path),
        stdin: JSON.stringify({
          ...codexBase,
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'touch a.txt' },
        }),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(output);
    });
  });
});
