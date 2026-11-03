// 真 hub、真 daemon：用量從 daemon 讀的對話紀錄一路到畫面；改密碼與操作紀錄打真的 API。
// 不開 session，所以不會執行 claude。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';
import type { Machine, UsageSummary, User } from '@agent-board/protocol';

const PORT = 5191;
const HUB = `http://127.0.0.1:${PORT}`;
const DAEMON_DIR = resolve(import.meta.dirname, '../../daemon');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const TSX = resolve(DAEMON_DIR, '../../node_modules/.bin/tsx');
const PASSWORD = 'account-owner-password';
const NEW_PASSWORD = 'account-owner-password-2';

// 同一個 context 帶著登入 cookie 走完整條流程（同 integration.spec.ts）。
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
let claudeDir: string;

function daemonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: daemonDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_MACHINE_NAME: 'usage-machine',
    // daemon 從這裡讀對話紀錄；不碰真正的 ~/.claude。
    CLAUDE_CONFIG_DIR: claudeDir,
  };
}

const expectNoErrors = (page: Page) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  return problems;
};

test.beforeAll(async ({ browser }) => {
  shared = await browser.newContext({ baseURL: HUB, locale: 'zh-TW', acceptDownloads: true });
  daemonDir = mkdtempSync(join(tmpdir(), 'ab-account-e2e-daemon-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'ab-account-e2e-claude-'));
  const project = join(claudeDir, 'projects', 'demo-project');
  mkdirSync(project, { recursive: true });
  // 同一則回應拆成兩行（usage 相同）只算一次；另一則沒有 id 的照算。
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const now = new Date().toISOString();
  writeFileSync(
    join(project, 'session.jsonl'),
    line({
      timestamp: now,
      requestId: 'r1',
      message: {
        id: 'msg-1',
        usage: {
          input_tokens: 1200,
          output_tokens: 3400,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 700,
        },
      },
    }) +
      line({
        timestamp: now,
        requestId: 'r1',
        message: { id: 'msg-1', usage: { input_tokens: 1200, output_tokens: 3400 } },
      }) +
      line({ timestamp: now, message: { usage: { input_tokens: 400, output_tokens: 0 } } }),
  );
});

test.afterAll(async () => {
  await shared.close();
  const running = daemon;
  if (running && running.exitCode === null) {
    await new Promise((done) => {
      running.once('exit', done);
      running.kill('SIGTERM');
    });
  }
});

test('建立管理員、配對機器；daemon 讀對話紀錄回報的用量出現在頁首與側欄', async ({ page }) => {
  const errors = expectNoErrors(page);
  const setup = await page.request.post('/api/auth/setup', {
    data: { name: 'owner', password: PASSWORD, locale: 'zh-TW' },
  });
  expect(setup.ok()).toBe(true);
  const pairing = (await (await page.request.post('/api/machines/pairing-codes')).json()) as {
    code: string;
  };
  execFileSync(TSX, ['src/index.ts', 'pair', '--hub', HUB, '--code', pairing.code], {
    cwd: DAEMON_DIR,
    env: daemonEnv(),
    stdio: 'pipe',
  });
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: daemonEnv(),
    stdio: 'ignore',
  });

  const machineId = await expect
    .poll(
      async () => {
        const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
        return machines.find((m) => m.online)?.id ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
      return machines[0]!.id;
    });

  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/machines/${machineId}/usage`)
          ).json()) as UsageSummary | null
        )?.outputTokens ?? null,
      { timeout: 30_000 },
    )
    .toBe(3400);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/canvas');
  // 輸入＋輸出：1200 + 400 + 3400 = 5000（快取另計）。
  await expect(page.getByTestId('usage-total')).toHaveText('近 30 天 5000 token');
  const row = page.getByTestId(`usage-${machineId}`);
  await expect(row).toContainText('usage-machine');
  await expect(row).toContainText('5000');
  await expect(row).toContainText('快取另計 5.1萬');
  await expect(page.getByTestId('usage-section')).toContainText('不是官方方案額度');
  expect(errors).toEqual([]);
});

test('改密碼：目前密碼錯誤不改；改好後其他裝置登出、舊密碼失效', async ({ page, browser }) => {
  const errors = expectNoErrors(page);
  // 另一台裝置先用舊密碼登入。
  const other = await browser.newContext({ baseURL: HUB });
  expect(
    (
      await other.request.post('/api/auth/login', { data: { name: 'owner', password: PASSWORD } })
    ).ok(),
  ).toBe(true);
  expect((await other.request.get('/api/sessions')).status()).toBe(200);

  await page.goto('/#/settings');
  const box = page.locator('#s-password');
  await box.getByLabel('目前的密碼').fill('not-the-password');
  await box.getByLabel('新密碼', { exact: true }).fill(NEW_PASSWORD);
  await box.getByLabel('再輸入一次新密碼').fill(NEW_PASSWORD);
  await box.getByRole('button', { name: '改密碼' }).click();
  await expect(box.locator('.msg.err')).toHaveText('目前的密碼不對，密碼沒有改。');
  expect((await other.request.get('/api/sessions')).status()).toBe(200);

  await box.getByLabel('目前的密碼').fill(PASSWORD);
  await box.getByRole('button', { name: '改密碼' }).click();
  await expect(box.locator('.msg')).toHaveText('已改好。其他裝置要用新密碼重新登入。');

  // 這個瀏覽器還在登入狀態，另一台被登出。
  expect((await page.request.get('/api/sessions')).status()).toBe(200);
  expect((await other.request.get('/api/sessions')).status()).toBe(401);
  expect(
    (
      await other.request.post('/api/auth/login', { data: { name: 'owner', password: PASSWORD } })
    ).status(),
  ).toBe(401);
  expect(
    (
      await other.request.post('/api/auth/login', {
        data: { name: 'owner', password: NEW_PASSWORD },
      })
    ).ok(),
  ).toBe(true);
  await other.close();
  expect(errors).toEqual([]);
});

test('操作紀錄：列出、依動作篩選、匯出整份 CSV', async ({ page }) => {
  const errors = expectNoErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/settings');
  const box = page.locator('#s-audit');
  const rows = box.getByTestId('audit-row');
  await expect(rows.first()).toBeVisible();
  await expect(box.getByTestId('audit-list')).toContainText('user.password_change_failed');
  await expect(box.getByTestId('audit-list')).toContainText('machine.pair');

  await box.getByLabel('動作', { exact: true }).selectOption('user.password_change');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('改密碼');
  await expect(rows.first()).toContainText('owner');

  await box.getByLabel('使用者', { exact: true }).selectOption({ label: '系統' });
  await expect(box.locator('[data-state=empty]')).toContainText('沒有符合的紀錄');
  await box.getByRole('button', { name: '清除篩選' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    box.getByRole('button', { name: '匯出 CSV' }).click(),
  ]);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('user.password_change');
  expect(csv).toContain('auth.setup');
  // 匯出本身也記一筆，畫面會重新整理。
  await expect(box.getByTestId('audit-list')).toContainText('audit.export');
  expect(errors).toEqual([]);
});

test('成員看不到操作紀錄、可改自己的密碼；管理員不能改別人的密碼（API 擋）', async ({
  page,
  browser,
}) => {
  const created = await page.request.post('/api/users', {
    data: { name: 'member', password: 'member-password', role: 'member', locale: 'zh-TW' },
  });
  expect(created.ok()).toBe(true);
  const member = (await created.json()) as User;

  // 管理員改別人的密碼：hub 回 403，所以介面沒有這個功能。
  const reset = await page.request.patch(`/api/users/${member.id}`, {
    data: { password: 'reset-by-owner', currentPassword: NEW_PASSWORD },
  });
  expect(reset.status()).toBe(403);

  const context = await browser.newContext({ baseURL: HUB, locale: 'zh-TW' });
  const memberPage = await context.newPage();
  const errors = expectNoErrors(memberPage);
  expect(
    (
      await memberPage.request.post('/api/auth/login', {
        data: { name: 'member', password: 'member-password' },
      })
    ).ok(),
  ).toBe(true);
  expect((await memberPage.request.get('/api/audit')).status()).toBe(403);
  await memberPage.goto('/#/settings');
  await expect(memberPage.locator('#s-users')).toContainText('member');
  await expect(memberPage.locator('#s-audit')).toHaveCount(0);

  const box = memberPage.locator('#s-password');
  await box.getByLabel('目前的密碼').fill('member-password');
  await box.getByLabel('新密碼', { exact: true }).fill('member-password-2');
  await box.getByLabel('再輸入一次新密碼').fill('member-password-2');
  await box.getByRole('button', { name: '改密碼' }).click();
  await expect(box.locator('.msg')).toHaveText('已改好。其他裝置要用新密碼重新登入。');
  await context.close();
  expect(errors).toEqual([]);
});
