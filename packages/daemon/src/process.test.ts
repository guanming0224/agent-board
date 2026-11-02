// 真的把 src/index.ts 當獨立程序跑，測訊號處理與真正的程序重啟（kill -9）。
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, waitUntil } from './test-support/harness';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let h: Harness;
let child: ChildProcess | null = null;
let stderr = '';

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
  await h.cleanup();
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

    const gone = exited(first);
    first.kill('SIGKILL');
    await gone;

    const helloCount = h.hellos().length;
    const second = startProcess();
    await waitUntil(() => h.hellos().length > helloCount, '第二個程序連上', 20_000);
    expect(h.hellos().at(-1)?.sessions[0]).toMatchObject({
      id: 's1',
      status: 'running', // index.ts 目前接的是占位狀態機；真實狀態機會是 starting
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
