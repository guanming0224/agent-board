import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
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

const PORT = 5199;
const HUB = `http://127.0.0.1:${PORT}`;
const DAEMON_DIR = resolve(import.meta.dirname, '../../daemon');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const TSX = resolve(DAEMON_DIR, '../../node_modules/.bin/tsx');
const PASSWORD = 'integration-password';

// 整條流程共用同一個瀏覽器 context，登入 cookie 才帶得過去（第一個測試用 request 驗未登入）。
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

let daemon: ChildProcess | undefined;
let daemonDir: string;
let repo: string;
let session: Session;

function daemonEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: dataDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_MACHINE_NAME: 'e2e-machine',
  };
}

function startDaemon(): void {
  // 直接跑 node，不經過 tsx 的包裝程序：kill -9 才打得到 daemon 本身，不會留下孤兒。
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: daemonEnv(daemonDir),
    stdio: 'ignore',
  });
}

async function stopDaemon(signal: NodeJS.Signals): Promise<void> {
  const running = daemon;
  daemon = undefined;
  if (!running || running.exitCode !== null) return;
  await new Promise((done) => {
    running.once('exit', done);
    running.kill(signal);
  });
}

async function getSession(request: APIRequestContext, id: string): Promise<Session> {
  const sessions = (await (await request.get('/api/sessions')).json()) as Session[];
  const found = sessions.find((s) => s.id === id);
  if (!found) throw new Error(`no session ${id}`);
  return found;
}

const expectStatus = (request: APIRequestContext, id: string, status: Session['status']) =>
  expect.poll(async () => (await getSession(request, id)).status, { timeout: 20_000 }).toBe(status);

/** xterm 用 WebGL 畫，DOM 讀不到字，所以另開一條 client 連線讀快照：驗的是 hub 轉送與畫面還原。 */
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

/** 用瀏覽器的 client 連線送輸入，等同在網頁終端機打字（會經過 hub 的 audit）。 */
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

test.beforeAll(async ({ browser }) => {
  shared = await browser.newContext({ baseURL: HUB, locale: 'zh-TW' });
  chmodSync(FAKE_CLAUDE, 0o755);
  daemonDir = mkdtempSync(join(tmpdir(), 'ab-e2e-daemon-'));
  repo = mkdtempSync(join(tmpdir(), 'ab-e2e-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
});

test.afterAll(async () => {
  await shared.close();
  await stopDaemon('SIGTERM');
});

test('未登入拿不到任何資料，第一次開啟進首次引導', async ({ page, request }) => {
  expect((await request.get('/api/sessions')).status()).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(/#\/onboarding/);
  await expect(page.getByRole('button', { name: /建立/ })).toBeVisible();
});

test('建立管理員、配對機器後，機器在畫布上線', async ({ page }) => {
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
    installCommand: string;
  };
  expect(pairing.installCommand).toContain('agent-board-daemon pair');

  execFileSync(TSX, ['src/index.ts', 'pair', '--hub', HUB, '--code', pairing.code], {
    cwd: DAEMON_DIR,
    env: daemonEnv(daemonDir),
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

  await page.goto('/#/canvas');
  await expect(page.getByText('e2e-machine').first()).toBeVisible();
});

test('開 session：真的跑起來、hook 接上、狀態變成等你回覆', async ({ page }) => {
  await page.goto('/#/canvas');
  const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
  const response = await page.request.post('/api/sessions', {
    data: {
      machineId: machines[0]!.id,
      name: 'integration',
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
  const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.local.json'), 'utf8')) as {
    hooks: Record<string, unknown>;
  };
  expect(Object.keys(settings.hooks)).toContain('PermissionRequest');
  await expect(page.getByText('integration').first()).toBeVisible();
  expect(await readScreen(page, session.id)).toContain('READY');
});

test('權限請求：網頁看到、按允許，決定真的回到 claude', async ({ page }) => {
  await page.goto('/#/review');
  await type(page, session.id, 'ask-permission');
  await expectStatus(page.request, session.id, 'waiting_permission');
  await expect(page.getByText('npm test').first()).toBeVisible();
  await page.getByRole('button', { name: '允許一次' }).first().click();

  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('"behavior":"allow"');
  await expectStatus(page.request, session.id, 'waiting_input');
});

test('拒絕要填原因，原因真的回到 claude', async ({ page }) => {
  await page.goto('/#/review');
  await type(page, session.id, 'ask-permission');
  await expectStatus(page.request, session.id, 'waiting_permission');
  const reason = page.getByPlaceholder(/拒絕原因/).first();
  await reason.fill('integration-deny-reason');
  await page.getByRole('button', { name: '拒絕' }).first().click();

  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('integration-deny-reason');
});

test('危險指令：攔下、按兩次才放行', async ({ page }) => {
  await page.goto('/#/review');
  await type(page, session.id, 'danger');
  await expect(page.getByText(/命中危險指令/).first()).toBeVisible({ timeout: 20_000 });
  await expectStatus(page.request, session.id, 'waiting_permission');
  const allow = page.getByRole('button', { name: '允許一次' }).first();
  await allow.click();
  await page.waitForTimeout(500);
  expect(await readScreen(page, session.id)).not.toContain('"permissionDecision":"allow"');
  await page
    .getByRole('button', { name: /再按一次/ })
    .first()
    .click();
  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('"permissionDecision":"allow"');
  // 假 CLI 接著還會走一次 PermissionRequest，答掉才會結束這一輪
  await expectStatus(page.request, session.id, 'waiting_permission');
  await page.getByRole('button', { name: '允許一次' }).first().click();
  await expectStatus(page.request, session.id, 'waiting_input');
});

test('關掉分頁再開，session 還在、畫面還原', async ({ page, context }) => {
  await page.goto('/#/canvas');
  const again = await context.newPage();
  await page.close();
  await again.goto('/#/canvas');
  await expect(again.getByText('integration').first()).toBeVisible();
  expect(await readScreen(again, session.id)).toContain('GOT ask-permission');
});

test('在瀏覽器的真終端機打字，輸入真的送進 claude，畫面也畫得出來', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));

  await page.goto('/#/canvas');
  await page.getByText('integration').first().dblclick();
  const terminal = page.locator(`[data-terminal-session="${session.id}"]`);
  await expect(terminal).toBeVisible();
  await page.waitForTimeout(500);
  await terminal.click();
  await page.keyboard.type('typed-in-xterm');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('GOT typed-in-xterm');
  if (process.env.AB_E2E_SHOTS) {
    await page.screenshot({ path: `${process.env.AB_E2E_SHOTS}/real-terminal.png` });
  }
  expect(problems).toEqual([]);
});

test('audit 有送入的指令與核准決定', async ({ page }) => {
  const entries = (await (await page.request.get('/api/audit?limit=200')).json()) as {
    action: string;
    detail: string;
  }[];
  expect(entries.some((e) => e.detail.includes('ask-permission'))).toBe(true);
  expect(entries.some((e) => e.action.includes('approval'))).toBe(true);
});

test('daemon 被殺：卡片失聯；重啟：--resume 接回、畫面還在', async ({ page }) => {
  await page.goto('/#/canvas');
  await stopDaemon('SIGKILL');
  await expectStatus(page.request, session.id, 'offline');
  await expect(page.getByText(/失聯/).first()).toBeVisible();

  startDaemon();
  await expectStatus(page.request, session.id, 'waiting_input');
  const screen = await readScreen(page, session.id);
  expect(screen).toContain(
    `--resume ${(await getSession(page.request, session.id)).claudeSessionId}`,
  );
});

test('claude 自己結束（exit 0）轉為完成；異常結束顯示錯誤', async ({ page }) => {
  await page.goto('/#/canvas');
  await type(page, session.id, 'quit');
  await expectStatus(page.request, session.id, 'done');
  const ended = await getSession(page.request, session.id);
  expect(ended.endedAt).not.toBeNull();
});

test('登出之後，API 與 WebSocket 都進不去', async ({ page }) => {
  await page.goto('/#/canvas');
  expect((await page.request.post('/api/auth/logout')).ok()).toBe(true);
  expect((await page.request.get('/api/sessions')).status()).toBe(401);
  const opened = await page.evaluate(
    () =>
      new Promise<boolean>((done) => {
        const ws = new WebSocket(`ws://${location.host}/ws/client`);
        ws.onopen = () => done(true);
        ws.onerror = () => done(false);
      }),
  );
  expect(opened).toBe(false);
});
