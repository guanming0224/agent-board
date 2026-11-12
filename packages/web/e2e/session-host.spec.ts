// session host 拆分（CONTRACTS §20）的端對端驗證：假 claude 跑到一半重啟 daemon → agent 沒死、畫面輸出不缺、狀態正確。
// 真 hub、真 session host、真 daemon、真 hook CLI；claude 是假的（e2e/fixtures/fake-claude.mjs），不花額度。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { Machine, Session } from '@agent-board/protocol';
import { PORT } from './session-host.config';

const HUB = `http://127.0.0.1:${PORT}`;
const PACKAGES = resolve(import.meta.dirname, '../..');
const DAEMON_DIR = join(PACKAGES, 'daemon');
const HOST_DIR = join(PACKAGES, 'session-host');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const TSX = resolve(PACKAGES, '../node_modules/.bin/tsx');
const PASSWORD = 'session-host-password';

let shared: BrowserContext;
const test = base.extend({
  context: async ({}, use) => {
    await use(shared);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    if (!page.isClosed()) await page.close();
  },
});

test.describe.configure({ mode: 'serial' });

let host: ChildProcess | undefined;
let daemon: ChildProcess | undefined;
let dataDir: string;
let claudeConfigDir: string;
let repo: string;
let session: Session;

const E2E_CODEX_HOME = mkdtempSync(join(tmpdir(), 'ab-e2e-codex-home-'));

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // 審查 S4：daemon 在 e2e 模式下拒絕用真的 ~/.codex；用量掃描、resume 檢查都只碰暫存資料夾。
    AGENT_BOARD_E2E: '1',
    CODEX_HOME: E2E_CODEX_HOME,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: dataDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_MACHINE_NAME: 'host-e2e-machine',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}

/** 直接跑 node（不經 tsx 的包裝程序）：訊號才打得到本人，不留孤兒。 */
function startHost(): void {
  host = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: HOST_DIR,
    env: env(),
    stdio: 'ignore',
  });
}

function startDaemon(extra: NodeJS.ProcessEnv = {}): void {
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: { ...env(), ...extra },
    stdio: 'ignore',
  });
}

async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    child.once('exit', done);
    child.kill(signal);
  });
}

async function getSession(request: APIRequestContext, id: string): Promise<Session> {
  const sessions = (await (await request.get('/api/sessions')).json()) as Session[];
  const found = sessions.find((s) => s.id === id);
  if (!found) throw new Error(`no session ${id}`);
  return found;
}

const expectStatus = (request: APIRequestContext, id: string, status: Session['status']) =>
  expect.poll(async () => (await getSession(request, id)).status, { timeout: 30_000 }).toBe(status);

/** 另開一條 client 連線讀快照（xterm 用 WebGL 畫，DOM 讀不到字）。 */
async function readScreen(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(
    (id) =>
      new Promise<string>((done, fail) => {
        const ws = new WebSocket(`ws://${location.host}/ws/client`);
        const timer = setTimeout(() => fail(new Error('no snapshot')), 10_000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'terminal.subscribe', sessionId: id }));
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; data: string };
          if (message.type !== 'terminal.snapshot') return;
          clearTimeout(timer);
          ws.close();
          done(message.data);
        };
      }),
    sessionId,
  );
}

async function type(page: Page, sessionId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, data }) =>
      new Promise<void>((done) => {
        const ws = new WebSocket(`ws://${location.host}/ws/client`);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'terminal.input', sessionId: id, data }));
          setTimeout(() => {
            ws.close();
            done();
          }, 100);
        };
      }),
    { id: sessionId, data: `${text}\r` },
  );
}

/** 畫面上假 claude 回報的 pid（`whoami` 指令）。 */
function pidsOn(screen: string): string[] {
  return [...screen.matchAll(/PID (\d+)/g)].map((match) => match[1]!);
}

/** 這台機器上跑著幾個 e2e 的假 claude（命令列含它的路徑）。 */
function fakeClaudeCount(): number {
  return execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(FAKE_CLAUDE)).length;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async ({ browser }) => {
  shared = await browser.newContext({ baseURL: HUB, locale: 'zh-TW' });
  chmodSync(FAKE_CLAUDE, 0o755);
  // macOS 的 Unix socket 路徑上限 104 bytes：資料夾放短一點（太長時 host 會改放 tmpdir 底下的固定位置）。
  dataDir = mkdtempSync(join(tmpdir(), 'ab-hd-'));
  claudeConfigDir = mkdtempSync(join(tmpdir(), 'ab-e2e-claude-'));
  repo = mkdtempSync(join(tmpdir(), 'ab-e2e-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  startHost();
  await expect
    .poll(() => existsSync(join(dataDir, 'session-host.token')), { timeout: 20_000 })
    .toBe(true);
});

test.afterAll(async () => {
  await shared.close();
  await stop(daemon, 'SIGTERM');
  // host 收到 SIGTERM 會結束它養的所有 agent：測試結束不留假 claude。
  await stop(host, 'SIGTERM');
  for (const dir of [dataDir, claudeConfigDir, repo]) rmSync(dir, { recursive: true, force: true });
});

test('配對機器：daemon 連上 session host 與 hub', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel(/帳號|名稱/)
    .first()
    .fill('owner');
  await page.getByLabel(/密碼/).first().fill(PASSWORD);
  const confirm = page.getByLabel(/確認|再輸入/);
  if (await confirm.count()) await confirm.first().fill(PASSWORD);
  await page.getByRole('button', { name: /建立/ }).click();
  await expect.poll(async () => (await page.request.get('/api/machines')).status()).toBe(200);
  const pairing = (await (await page.request.post('/api/machines/pairing-codes')).json()) as {
    code: string;
  };
  execFileSync(TSX, ['src/index.ts', 'pair', '--hub', HUB, '--code', pairing.code], {
    cwd: DAEMON_DIR,
    env: env(),
    stdio: 'pipe',
  });
  startDaemon();
  await expect
    .poll(
      async () => {
        const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
        return machines.some((m) => m.online);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test('開 session：agent 由 session host 開起來，hook 接上', async ({ page }) => {
  const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
  const response = await page.request.post('/api/sessions', {
    data: {
      machineId: machines[0]!.id,
      name: 'host-e2e',
      projectId: null,
      cwd: repo,
      useWorktree: false,
      permissionMode: 'default',
      model: null,
      accountProfile: null,
      resumeClaudeSessionId: null,
      firstPrompt: null,
    },
  });
  expect(response.ok()).toBe(true);
  session = (await response.json()) as Session;
  await expectStatus(page.request, session.id, 'waiting_input');
  await page.goto('/#/canvas');
  await type(page, session.id, 'whoami');
  await expect.poll(async () => pidsOn(await readScreen(page, session.id))).toHaveLength(1);
  const [pid] = pidsOn(await readScreen(page, session.id));
  // agent 不是 daemon 的子程序：daemon 被殺也不會跟著走。
  const parent = execFileSync('ps', ['-o', 'ppid=', '-p', pid!], { encoding: 'utf8' }).trim();
  expect(Number(parent)).not.toBe(daemon!.pid);
});

test('跑到一半重啟 daemon（SIGTERM）：agent 沒死、不用 --resume、每一行輸出都在、跑完狀態變成等你回覆', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const pid = Number(pidsOn(await readScreen(page, session.id))[0]);
  await type(page, session.id, 'slow 20');
  await expectStatus(page.request, session.id, 'running');
  await expect.poll(() => readScreen(page, session.id)).toContain('WORK 3/20');

  await stop(daemon, 'SIGTERM');
  expect(alive(pid)).toBe(true);
  // daemon 停機的這段時間 agent 繼續跑、hook 在重試。
  await new Promise((r) => setTimeout(r, 1_500));
  expect(alive(pid)).toBe(true);
  startDaemon();

  await expect.poll(() => readScreen(page, session.id), { timeout: 30_000 }).toContain('WORK DONE');
  await expectStatus(page.request, session.id, 'waiting_input');
  const screen = await readScreen(page, session.id);
  // 每一行都在、順序對（停機期間的輸出也在）。
  let at = -1;
  for (let step = 1; step <= 20; step += 1) {
    const next = screen.indexOf(`WORK ${step}/20`);
    expect(next, `WORK ${step}/20`).toBeGreaterThan(at);
    at = next;
  }
  // 同一個程序：只開過一次（沒有 --resume 重開）。
  expect(alive(pid)).toBe(true);
  expect(screen.match(/fake claude /g)).toHaveLength(1);
  expect(screen).not.toContain('--resume');
  const current = await getSession(page.request, session.id);
  expect(current.endedAt).toBeNull();

  await type(page, session.id, 'after-restart');
  await expect.poll(() => readScreen(page, session.id)).toContain('GOT after-restart');
});

test('daemon 被 kill -9（沒跑到 stop）：一樣接得回來，狀態從快照與 hook 重試補上', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const pid = Number(pidsOn(await readScreen(page, session.id))[0]);
  await type(page, session.id, 'slow 12');
  await expectStatus(page.request, session.id, 'running');
  await expect.poll(() => readScreen(page, session.id)).toContain('WORK 2/12');

  await stop(daemon, 'SIGKILL');
  await expectStatus(page.request, session.id, 'offline');
  expect(alive(pid)).toBe(true);
  startDaemon();

  await expect.poll(() => readScreen(page, session.id), { timeout: 30_000 }).toContain('WORK DONE');
  await expectStatus(page.request, session.id, 'waiting_input');
  const screen = await readScreen(page, session.id);
  for (let step = 1; step <= 12; step += 1) expect(screen).toContain(`WORK ${step}/12`);
  expect(alive(pid)).toBe(true);
  expect(screen.match(/fake claude /g)).toHaveLength(1);
});

test('host 還活著但 daemon 協定不相容：不重開第二個 agent，session 標成錯誤寫明原因；換回相容的 daemon 就接回', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const pid = Number(pidsOn(await readScreen(page, session.id))[0]);
  expect(fakeClaudeCount()).toBe(1);
  await stop(daemon, 'SIGTERM');
  startDaemon({ AGENT_BOARD_SESSION_HOST_TEST_PROTOCOL: '999' });
  await expect
    .poll(async () => (await getSession(page.request, session.id)).statusDetail ?? '', {
      timeout: 30_000,
    })
    .toContain('協定不相容');
  const blocked = await getSession(page.request, session.id);
  expect(blocked.status).toBe('error');
  expect(blocked.endedAt).toBeNull();
  // 舊的 agent 還在、沒有用 --resume 再開一個。
  expect(alive(pid)).toBe(true);
  expect(fakeClaudeCount()).toBe(1);

  await stop(daemon, 'SIGTERM');
  startDaemon();
  await expectStatus(page.request, session.id, 'waiting_input');
  expect(fakeClaudeCount()).toBe(1);
  await type(page, session.id, 'whoami');
  await expect
    .poll(async () => pidsOn(await readScreen(page, session.id)).at(-1))
    .toBe(String(pid));
});

test('agent 在 daemon 停機期間自己結束：daemon 回來後算結束（完成），結果送到 hub、最後畫面還在', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const pid = Number(pidsOn(await readScreen(page, session.id))[0]);
  await type(page, session.id, 'exit-later 1500');
  // 這一輪的 hook 都送完才停 daemon（hook 重試期間 agent 會等，計時器跑不了）。
  await expect.poll(() => readScreen(page, session.id)).toContain('EXIT SCHEDULED');
  await stop(daemon, 'SIGTERM');
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  startDaemon();
  await expectStatus(page.request, session.id, 'done');
  const ended = await getSession(page.request, session.id);
  expect(ended.endedAt).not.toBeNull();
  expect(ended.lastLines.join('\n')).toContain('EXIT SCHEDULED');
});
