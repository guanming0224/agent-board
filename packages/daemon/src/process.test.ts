// 真的把 src/index.ts 當獨立程序跑，測訊號處理與真正的程序重啟（kill -9）。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialsPath, readCredentials, writeCredentials } from './credentials';
import { Harness, waitUntil } from './test-support/harness';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let h: Harness;
let child: ChildProcess | null = null;
let stderr = '';
const closers: (() => Promise<void>)[] = [];

function startProcess(env: Record<string, string> = {}): ChildProcess {
  stderr = '';
  // 不用 tsx 執行檔：它是包裝程序，SIGKILL 只會殺到外層。
  const proc = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: h.root,
      AGENT_BOARD_HUB_URL: `http://127.0.0.1:${h.hub.port}`,
      AGENT_BOARD_MACHINE_TOKEN: 'process-test-token',
      AGENT_BOARD_DATA_DIR: h.dataDir,
      AGENT_BOARD_CLAUDE_BIN: h.bin,
      AGENT_BOARD_HOOK_BIN: h.hookBin,
      CLAUDE_CONFIG_DIR: h.claudeDir,
      FAKE_CLAUDE_LOG: h.logFile,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child = proc;
  return proc;
}

const exited = (proc: ChildProcess) =>
  new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  h = new Harness();
  await h.hub.start();
});
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = exited(child);
    child.kill('SIGKILL');
    await done;
  }
  child = null;
  for (const close of closers.splice(0)) await close();
  await h.cleanup();
});

describe('agent-board-daemon pair', () => {
  const TOKEN = 'paired-long-lived-token';

  /** 假的配對端點，綁 127.0.0.1 隨機 port；WebSocket 仍走 FakeHub。 */
  async function pairEndpoint(respond: (body: Record<string, unknown>) => [number, unknown]) {
    const seen: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => (raw += chunk));
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ url: request.url, method: request.method, ...body });
        const [status, payload] = respond(body);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, seen };
  }

  function runPair(args: string[]) {
    const proc = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'pair', ...args], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: h.root,
        AGENT_BOARD_DATA_DIR: h.dataDir,
        AGENT_BOARD_CLAUDE_BIN: h.bin,
      },
    });
    let output = '';
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    return exited(proc).then((code) => ({ code, output }));
  }

  it('成功：打 pairingExchange，token 存 0600、不印出；之後不用環境變數就能連上', async () => {
    const hub = await pairEndpoint(() => [200, { machineId: 'machine-9', token: TOKEN }]);
    const { code, output } = await runPair(['--hub', hub.origin, '--code', 'ONE-TIME']);
    expect(output).toContain('machine-9');
    expect(code).toBe(0);
    expect(output).not.toContain(TOKEN);
    expect(hub.seen[0]).toMatchObject({
      url: '/api/machines/pair',
      method: 'POST',
      code: 'ONE-TIME',
      os: process.platform,
    });
    expect((hub.seen[0]?.capabilities as { claudeVersion: string }).claudeVersion).toBe('9.9.9');

    const file = credentialsPath(h.dataDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readCredentials(h.dataDir)).toEqual({
      machineId: 'machine-9',
      token: TOKEN,
      hubUrl: hub.origin,
    });

    // 啟動時讀配對檔：hub 位址與 token 都不靠環境變數。WebSocket 端點另開，所以這裡覆寫位址時要帶 token。
    writeCredentials(h.dataDir, {
      machineId: 'machine-9',
      token: TOKEN,
      hubUrl: `http://127.0.0.1:${h.hub.port}`,
    });
    startProcess({ AGENT_BOARD_MACHINE_TOKEN: '', AGENT_BOARD_HUB_URL: '' });
    await h.hub.waitFor('daemon.hello', () => true, { timeoutMs: 20_000 });
    expect(h.hub.authHeaders).toEqual([`Bearer ${TOKEN}`]);
    expect(stderr).not.toContain(TOKEN);
  });

  it('環境變數優先於配對檔', async () => {
    writeCredentials(h.dataDir, {
      machineId: 'machine-9',
      token: TOKEN,
      hubUrl: `http://127.0.0.1:${h.hub.port}`,
    });
    startProcess({ AGENT_BOARD_MACHINE_TOKEN: 'from-env' });
    await h.hub.waitFor('daemon.hello', () => true, { timeoutMs: 20_000 });
    expect(h.hub.authHeaders).toEqual(['Bearer from-env']);
  });

  it('配對碼錯：exit 1，訊息有 hub 的原因與怎麼辦，不留憑證檔', async () => {
    const hub = await pairEndpoint(() => [400, { code: 'bad_code', message: '配對碼已過期' }]);
    const { code, output } = await runPair(['--hub', hub.origin, '--code', 'WRONG']);
    expect(code).toBe(1);
    expect(output).toContain('配對碼已過期');
    expect(output).toContain('產生新的配對碼');
    expect(existsSync(credentialsPath(h.dataDir))).toBe(false);
  });

  it('參數缺少：exit 1 並顯示用法', async () => {
    const { code, output } = await runPair(['--hub', 'http://x']);
    expect(code).toBe(1);
    expect(output).toContain("pair --hub '<origin>' --code <code>");
  });
});

describe('獨立程序', () => {
  it('缺設定時印出原因並 exit 1，不印 token', async () => {
    const proc = startProcess({ AGENT_BOARD_HUB_URL: '' });
    expect(await exited(proc)).toBe(1);
    expect(stderr).toContain('AGENT_BOARD_HUB_URL');
    expect(stderr).not.toContain('process-test-token');
  });

  it('kill -9 後重新啟動：PTY 跟著結束、新程序用 --resume 接回；token 不進 claude 也不進紀錄', async () => {
    const first = startProcess();
    await h.hub.waitFor('daemon.hello', () => true, { timeoutMs: 20_000 });
    expect(h.hub.authHeaders).toEqual(['Bearer process-test-token']);
    await waitUntil(() => stderr.includes('已啟動'), '啟動完成');
    h.hub.send({
      type: 'session.create',
      requestId: 'r1',
      sessionId: 's1',
      spec: h.spec({ cwd: h.root }),
    });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'r1');
    await waitUntil(() => h.runs().length === 1, '假 claude 啟動');
    const claudeId = h.runs()[0]?.argv[1] as string;
    expect(h.runs()[0]?.env.AGENT_BOARD_MACHINE_TOKEN).toBeNull();
    // 真的 claude 說過話才有對話紀錄；沒有的話重啟會改成重新開始而不是 --resume。
    mkdirSync(join(h.claudeDir, 'projects', 'p'), { recursive: true });
    writeFileSync(join(h.claudeDir, 'projects', 'p', `${claudeId}.jsonl`), '{}\n');

    const gone = exited(first);
    first.kill('SIGKILL');
    await gone;

    const helloCount = h.hellos().length;
    const second = startProcess();
    await waitUntil(() => h.hellos().length > helloCount, '第二個程序連上', 20_000);
    expect(h.hellos().at(-1)?.sessions[0]).toMatchObject({
      id: 's1',
      status: 'starting', // 接回後先標 starting，等 hook 回報才變（CONTRACTS §3.2）
      claudeSessionId: claudeId,
    });
    await waitUntil(() => h.runs().length === 2, '用 --resume 重開');
    expect(h.runs()[1]?.argv.slice(0, 2)).toEqual(['--resume', claudeId]);

    // SIGTERM：乾淨結束，且本機清單保留給下次接回。
    const done = exited(second);
    second.kill('SIGTERM');
    expect(await done).toBe(0);
    const saved = JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
      sessions: { sessionId: string }[];
    };
    expect(saved.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')).not.toContain(
      'process-test-token',
    );
    expect(stderr).not.toContain('process-test-token');
    expect(isRunning(second.pid as number)).toBe(false);
  });
});
