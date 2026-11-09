// Codex 節點端對端（CONTRACTS §19）：真 hub、真 daemon、真 hook CLI（--agent codex）、真瀏覽器，只有 codex 是假的。
// 走一遍：新增頁選 Codex → NEW → RUN → PERM（網頁允許）→ ASK → 危險指令擋下 → 模型錯誤 ERR → daemon 重啟用
// codex resume 接回 → 結束 DONE。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync } from 'node:fs';
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
import { PORT } from './codex-integration.config';

const HUB = `http://127.0.0.1:${PORT}`;
const DAEMON_DIR = resolve(import.meta.dirname, '../../daemon');
const FAKE_CODEX = resolve(import.meta.dirname, 'fixtures/fake-codex.mjs');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const TSX = resolve(DAEMON_DIR, '../../node_modules/.bin/tsx');
const PASSWORD = 'codex-integration-password';

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
/** 假 codex 寫對話紀錄的地方；daemon 重啟時也只在這裡找（不碰真的 ~/.codex）。 */
let codexHome: string;
let claudeConfigDir: string;
let repo: string;
let session: Session;

function daemonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: daemonDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_CODEX_BIN: FAKE_CODEX,
    AGENT_BOARD_MACHINE_NAME: 'codex-machine',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CODEX_HOME: codexHome,
  };
}

function startDaemon(): void {
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: daemonEnv(),
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

test.beforeAll(async ({ browser }) => {
  shared = await browser.newContext({ baseURL: HUB, locale: 'zh-TW' });
  chmodSync(FAKE_CODEX, 0o755);
  chmodSync(FAKE_CLAUDE, 0o755);
  daemonDir = mkdtempSync(join(tmpdir(), 'ab-codex-e2e-daemon-'));
  codexHome = mkdtempSync(join(tmpdir(), 'ab-codex-e2e-home-'));
  claudeConfigDir = mkdtempSync(join(tmpdir(), 'ab-codex-e2e-claude-'));
  repo = mkdtempSync(join(tmpdir(), 'ab-codex-e2e-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
});

test.afterAll(async () => {
  await shared.close();
  await stopDaemon('SIGTERM');
});

test('建立管理員、配對機器：daemon 回報 Codex 版本', async ({ page }) => {
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
    env: daemonEnv(),
    stdio: 'pipe',
  });
  startDaemon();
  await expect
    .poll(
      async () => {
        const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
        return machines.find((m) => m.online)?.capabilities.codexVersion ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe('0.0.0-fake');
});

test('新增頁選 Codex：預覽是 codex 的參數；建立後卡片標 Codex、狀態 NEW', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByLabel('名稱').fill('codex-node');
  await page.getByLabel('工作目錄').fill(repo);
  const picker = page.getByTestId('agent-picker');
  await expect(picker.getByRole('radio', { name: 'Codex' })).toBeEnabled();
  await picker.getByText('Codex', { exact: true }).click();
  await expect(picker.getByRole('radio', { name: 'Codex' })).toBeChecked();
  await expect(page.getByTestId('command-preview')).toContainText(
    'codex -s read-only -a on-request --dangerously-bypass-hook-trust',
  );
  await expect(page.getByTestId('codex-mode-acceptEdits')).toContainText(
    '-s workspace-write -a on-request',
  );
  await page.getByRole('button', { name: '建立 session' }).click();
  await expect(page.getByText('已建立 codex-node')).toBeVisible();

  const sessions = (await (await page.request.get('/api/sessions')).json()) as Session[];
  session = sessions.find((s) => s.name === 'codex-node')!;
  expect(session.agent).toBe('codex');
  await expectStatus(page.request, session.id, 'waiting_input');
  const fresh = await getSession(page.request, session.id);
  expect(fresh.statusDetail).toBe('idle:start'); // NEW：剛開好、閒著
  expect(fresh.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/); // SessionStart 回報的 thread id
  // 沒有寫任何 hook 設定檔（hook 走 -c）
  expect(readdirSync(repo)).not.toContain('.claude');
  expect(readdirSync(repo)).not.toContain('.codex');

  await page.goto('/#/canvas');
  const card = page.getByTestId(`card-${session.id}`);
  await expect(card.getByTestId('agent-chip')).toHaveText('Codex');
  const screen = await readScreen(page, session.id);
  expect(screen).toContain('READY');
  expect(screen).toContain('--dangerously-bypass-hook-trust');
});

test('權限請求：RUN → PERM，網頁允許，回到 Codex 的是 allow（不帶 updatedPermissions）→ ASK', async ({
  page,
}) => {
  await page.goto('/#/inbox');
  const inbox = page.getByTestId('inbox-drawer');
  await type(page, session.id, 'ask-permission');
  await expectStatus(page.request, session.id, 'waiting_permission');
  await expect(inbox.getByText('touch a.txt').first()).toBeVisible();
  await inbox.getByRole('button', { name: '允許一次' }).first().click();
  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain(
      'DECISION {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  await expectStatus(page.request, session.id, 'waiting_input');
  expect((await getSession(page.request, session.id)).statusDetail).toBeNull(); // ASK
  // 狀態歷史：UserPromptSubmit → RUN、PermissionRequest → PERM、Stop → ASK
  const events = (await (
    await page.request.get(`/api/sessions/${session.id}/events?limit=200`)
  ).json()) as { type: string; payload: { to?: string; reason?: string } }[];
  const reasons = events
    .filter((e) => e.type === 'status')
    .map((e) => `${e.payload.to}<-${e.payload.reason}`);
  expect(reasons).toEqual(
    expect.arrayContaining([
      'running<-hook:UserPromptSubmit',
      'waiting_permission<-hook:PermissionRequest',
      'waiting_input<-hook:Stop',
    ]),
  );
});

test('危險指令：PreToolUse 卡住等網頁；拒絕 → Codex 收到 deny、指令沒跑', async ({ page }) => {
  await page.goto('/#/inbox');
  const inbox = page.getByTestId('inbox-drawer');
  await type(page, session.id, 'danger');
  await expect(inbox.getByText(/命中危險指令/).first()).toBeVisible({ timeout: 20_000 });
  await expectStatus(page.request, session.id, 'waiting_permission');
  await inbox.getByTestId(`inbox-toggle-${session.id}`).click();
  await inbox.getByRole('button', { name: '拒絕' }).first().click();
  await inbox
    .getByPlaceholder(/拒絕原因/)
    .first()
    .fill('codex-danger-denied');
  await inbox.getByRole('button', { name: '拒絕' }).first().click();
  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('BLOCKED');
  const screen = await readScreen(page, session.id);
  expect(screen).toContain('"permissionDecision":"deny"');
  expect(screen).toContain('codex-danger-denied');
  await expectStatus(page.request, session.id, 'waiting_input');
});

test('這一輪的模型請求失敗就結束：ERR', async ({ page }) => {
  await page.goto('/#/canvas');
  await type(page, session.id, 'model-error');
  await expectStatus(page.request, session.id, 'error');
  expect((await getSession(page.request, session.id)).statusDetail).toContain('500');
});

test('daemon 被殺：失聯；重啟：codex resume <thread id> 接回', async ({ page }) => {
  await page.goto('/#/canvas');
  const thread = (await getSession(page.request, session.id)).claudeSessionId;
  await stopDaemon('SIGKILL');
  await expectStatus(page.request, session.id, 'offline');
  startDaemon();
  await expectStatus(page.request, session.id, 'waiting_input');
  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain(`args=resume ${thread}`);
  expect((await getSession(page.request, session.id)).agent).toBe('codex');
});

test('Codex 自己結束（exit 0）→ DONE', async ({ page }) => {
  await page.goto('/#/canvas');
  await type(page, session.id, 'quit');
  await expectStatus(page.request, session.id, 'done');
  expect((await getSession(page.request, session.id)).endedAt).not.toBeNull();
});
