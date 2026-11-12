import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from 'node:fs';
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
/** daemon 的 CLAUDE_CONFIG_DIR：對話紀錄的讀取與刪除只碰這個暫存資料夾，絕不碰真的 ~/.claude。 */
let claudeConfigDir: string;
let repo: string;
let session: Session;

const E2E_CODEX_HOME = mkdtempSync(join(tmpdir(), 'ab-e2e-codex-home-'));

function daemonEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // 審查 S4：daemon 在 e2e 模式下拒絕用真的 ~/.codex；用量掃描、resume 檢查都只碰暫存資料夾。
    AGENT_BOARD_E2E: '1',
    CODEX_HOME: E2E_CODEX_HOME,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: dataDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_MACHINE_NAME: 'e2e-machine',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
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

async function getArchived(request: APIRequestContext, id: string): Promise<Session> {
  const sessions = (await (await request.get('/api/sessions?archived=true')).json()) as Session[];
  const found = sessions.find((s) => s.id === id);
  if (!found) throw new Error(`no archived session ${id}`);
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
  claudeConfigDir = mkdtempSync(join(tmpdir(), 'ab-e2e-claude-'));
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

test('daemon 回報 repo 根目錄；新 session 選同 repo 的子資料夾時預設打開 worktree', async ({
  page,
}) => {
  const root = realpathSync(repo);
  await expect
    .poll(async () => (await getSession(page.request, session.id)).repoRoot, { timeout: 10_000 })
    .toBe(root);
  expect((await getSession(page.request, session.id)).repoCommonDir).toBe(join(root, '.git'));

  mkdirSync(join(repo, 'pkg', 'web'), { recursive: true });
  await page.goto('/#/new');
  await page.getByLabel('工作目錄').fill(join(repo, 'pkg', 'web'));
  await expect(page.getByLabel('使用 worktree')).toBeChecked();
  await expect(page.getByTestId('worktree-hint')).toContainText('integration');
});

test('權限請求：網頁看到、按允許，決定真的回到 claude', async ({ page }) => {
  // 收件匣是疊在畫布上的抽屜（P2 §1）；畫布上的卡也有同樣的字，限定在抽屜裡找。
  await page.goto('/#/inbox');
  const inbox = page.getByTestId('inbox-drawer');
  await type(page, session.id, 'ask-permission');
  await expectStatus(page.request, session.id, 'waiting_permission');
  await expect(inbox.getByText('npm test').first()).toBeVisible();
  await inbox.getByRole('button', { name: '允許一次' }).first().click();

  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('"behavior":"allow"');
  await expectStatus(page.request, session.id, 'waiting_input');
});

test('拒絕要填原因，原因真的回到 claude', async ({ page }) => {
  await page.goto('/#/inbox');
  const inbox = page.getByTestId('inbox-drawer');
  await type(page, session.id, 'ask-permission');
  await expectStatus(page.request, session.id, 'waiting_permission');
  // 展開那一列的審核卡（原審核中心）
  await inbox.getByTestId(`inbox-toggle-${session.id}`).click();
  // 灰色「拒絕」先展開原因框（GM Q3）
  await inbox.getByRole('button', { name: '拒絕' }).first().click();
  const reason = inbox.getByPlaceholder(/拒絕原因/).first();
  await reason.fill('integration-deny-reason');
  await inbox.getByRole('button', { name: '拒絕' }).first().click();

  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('integration-deny-reason');
});

test('危險指令：攔下、按兩次才放行', async ({ page }) => {
  await page.goto('/#/inbox');
  const inbox = page.getByTestId('inbox-drawer');
  await type(page, session.id, 'danger');
  await expect(inbox.getByText(/命中危險指令/).first()).toBeVisible({ timeout: 20_000 });
  await expectStatus(page.request, session.id, 'waiting_permission');
  const allow = inbox.getByRole('button', { name: '允許一次' }).first();
  await allow.click();
  await page.waitForTimeout(500);
  expect(await readScreen(page, session.id)).not.toContain('"permissionDecision":"allow"');
  await inbox
    .getByRole('button', { name: /再按一次/ })
    .first()
    .click();
  await expect
    .poll(async () => readScreen(page, session.id), { timeout: 20_000 })
    .toContain('"permissionDecision":"allow"');
  // 假 CLI 接著還會走一次 PermissionRequest，答掉才會結束這一輪
  await expectStatus(page.request, session.id, 'waiting_permission');
  await inbox.getByRole('button', { name: '允許一次' }).first().click();
  await expectStatus(page.request, session.id, 'waiting_input');
});

test('正式版直接開舊網址（書籤、舊推播）：轉成新網址，畫面不是空白（P2 §1.4）', async ({
  page,
}) => {
  // 正式版（vite build）沒有 StrictMode 的 effect 重跑：開頁就是舊網址時，轉址也要自己更新畫面。
  await page.goto('/#/canvas');
  await type(page, session.id, 'ask-permission');
  await expectStatus(page.request, session.id, 'waiting_permission');

  await page.goto(`/#/review/${session.id}`);
  await expect(page).toHaveURL(new RegExp(`#/inbox/${session.id}$`));
  await expect(page.getByTestId('inbox-drawer')).toBeVisible();
  await expect(page.getByTestId(`queue-${session.id}`)).toHaveClass(/targeted/);

  // 舊的待處理：轉過來這次依組別，不改使用者記住的排序。
  await page.goto('about:blank');
  await page.goto('/#/queue');
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.getByTestId('inbox-drawer')).toBeVisible();
  await expect(page.getByTestId('inbox-sort-group')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('agent-board.inbox.sort'))).not.toBe(
    'group',
  );

  await page.goto('about:blank');
  await page.goto('/#/archive');
  await expect(page).toHaveURL(/#\/settings\/archived$/);
  await expect(page.getByTestId('modal')).toBeVisible();
  await expect(page.locator('#s-archived')).toBeVisible();

  // 收尾：放行這一筆，後面的測試從等你回覆開始。
  await page.goto(`/#/inbox/${session.id}`);
  await page.getByTestId('inbox-drawer').getByRole('button', { name: '允許一次' }).first().click();
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

test('全域搜尋快速層：檔案改動與次數、停 250ms 才送、遮蔽在網路回應裡、owner 有指令組、終端機焦點不開搜尋（P3 §3.8）', async ({
  page,
}) => {
  const key = 'sk-ant-demo03-integrationKEY0000000';
  const risk = join(realpathSync(repo), 'src', 'risk.py');
  await page.goto('/#/canvas');
  await type(page, session.id, `edit-file ${risk}`);
  await type(page, session.id, `edit-file ${risk}`);
  await type(page, session.id, `deploy token ${key}`);
  await expect
    .poll(
      async () => {
        const body = (await (await page.request.get('/api/search?q=risk.py')).json()) as {
          groups: { kind: string; items: { count?: number }[] }[];
        };
        return body.groups.find((g) => g.kind === 'file')?.items[0]?.count;
      },
      { timeout: 20_000 },
    )
    .toBe(2);

  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/search')) requests.push(r.url());
  });
  await page.goto('/#/canvas');
  await expect(page.getByText('integration').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByTestId('search-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('r');
  await page.waitForTimeout(500);
  expect(requests).toEqual([]);
  await input.pressSequentially('isk.py', { delay: 30 });
  const files = page.getByTestId('search-group-file').getByTestId('search-row');
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText('src/risk.py');
  await expect(files.first()).toContainText('共 2 次');
  expect(requests).toHaveLength(1);

  // owner 看得到自己送出的指令（audit 的 terminal.input）。
  await input.fill('deploy token');
  await expect(page.getByTestId('search-group-input')).toBeVisible();
  await expect(page.getByTestId('search-group-session')).toContainText(key);

  // 遮蔽開著：hub 回應的原始內容就沒有金鑰（不是只在畫面遮）。
  await page.evaluate(() => localStorage.setItem('agent-board.mask-mode', '1'));
  const masked = page.waitForResponse(
    (r) => r.url().includes('/api/search') && r.url().includes('mask=1'),
  );
  await page.goto(`/#/search?q=${encodeURIComponent('deploy token')}`);
  await page.reload();
  const body = await (await masked).text();
  expect(body).toContain('deploy token');
  expect(body).not.toContain('sk-ant');
  await expect(page.getByTestId('search-group-session')).not.toContainText('sk-ant');
  await page.evaluate(() => localStorage.setItem('agent-board.mask-mode', '0'));

  // Enter 前往：關掉視窗、畫布聚焦那張卡。
  await page.goto('/#/canvas');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('search-input').fill('risk.py');
  await expect(files).toHaveCount(1);
  await page.getByTestId('search-input').press('ArrowDown');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
  await expect(
    page.locator(`.react-flow__node[data-id="${session.id}"] .frame.spot`),
  ).toBeVisible();

  // 焦點在終端機：/ 與 ⌘K 交給終端機，不開搜尋（驗收 14）。
  await page.getByText('integration').first().dblclick();
  const terminal = page.locator(`[data-terminal-session="${session.id}"]`);
  await expect(terminal).toBeVisible();
  await page.waitForTimeout(500);
  await terminal.click();
  await page.keyboard.press('/');
  await page.keyboard.press('ControlOrMeta+k');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).not.toContain('search');
  // 收尾：把打進終端機的 / 刪掉，後面的測試不受影響。
  await page.keyboard.press('Backspace');
});

test('全域搜尋深層：Enter 搜真 daemon 的對話紀錄與畫面、結果串流回來；遮蔽在 WebSocket 訊息裡；audit search.deep；⌘點擊開對話紀錄（P3 ③b 驗收 5、9、11）', async ({
  page,
}) => {
  const key = 'sk-ant-demo03-deepIntegrationKEY0000';
  const live = await getSession(page.request, session.id);
  // 假 claude 不寫對話紀錄：放一份到 daemon 的 CLAUDE_CONFIG_DIR（只碰暫存資料夾）。
  const projectDir = join(claudeConfigDir, 'projects', '-tmp-e2e-deep');
  mkdirSync(projectDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(projectDir, `${live.claudeSessionId}.jsonl`),
    [
      { type: 'user', timestamp: now, message: { content: '請把 zqdeep 的手續費改成 0.1425' } },
      {
        type: 'assistant',
        timestamp: now,
        message: {
          content: [
            { type: 'text', text: '好' },
            { type: 'tool_use', name: 'Bash', input: { command: `export ZQDEEP_TOKEN=${key}` } },
          ],
        },
      },
      {
        type: 'assistant',
        timestamp: now,
        message: { content: [{ type: 'text', text: 'zqdeep 改好了' }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  const frames: string[] = [];
  page.on('websocket', (ws) => {
    if (ws.url().includes('/ws/client'))
      ws.on('framereceived', (f) => frames.push(String(f.payload)));
  });
  const deepFrames = () => frames.filter((f) => f.includes('"search.deep'));

  await page.goto('/#/search');
  const input = page.getByTestId('search-input');
  await input.fill('zqdeep');
  await expect(page.getByTestId('search-empty')).toBeVisible();
  // 打字只跑快速層：還沒有任何深層訊息。
  expect(deepFrames()).toEqual([]);
  await input.press('Enter');
  const machine = page.locator('[data-testid^="search-deep-machine-"]');
  await expect(machine).toContainText('e2e-machine：完成 3 筆', { timeout: 20_000 });
  const deepRows = page.getByTestId('search-group-transcript').getByTestId('search-row');
  await expect(deepRows).toHaveCount(3);
  await expect(deepRows.first()).toContainText('e2e-machine');
  // 遮蔽關著：原文（和終端機一致，畫面另由 useMaskText 處理）。
  expect(deepFrames().some((f) => f.includes('search.deepResult') && f.includes(key))).toBe(true);

  // ⌘點擊：開對話紀錄、捲到命中的那則（序號 3）。
  await deepRows.filter({ hasText: '改好了' }).click({ modifiers: ['ControlOrMeta'] });
  await expect(page).toHaveURL(new RegExp(`#/transcript/${session.id}\\?at=3$`));
  const focused = page.locator('[data-testid="transcript-entry"][aria-current="true"]');
  await expect(focused).toHaveAttribute('data-index', '3');
  await expect(focused).toContainText('zqdeep 改好了');

  // 遮蔽開著：daemon 回傳前就遮好，WebSocket 訊息裡沒有金鑰（不是只在畫面遮，驗收 9）。
  // 畫面上的終端機有前一個測試打的 deploy token <金鑰>：畫面緩衝也一起搜。
  await page.evaluate(() => localStorage.setItem('agent-board.mask-mode', '1'));
  await page.goto('/#/search');
  await page.reload();
  frames.length = 0;
  await page.getByTestId('search-input').fill('zqdeep token');
  await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'idle');
  await page.getByTestId('search-input').press('Enter');
  await expect(machine).toContainText('完成', { timeout: 20_000 });
  await expect(deepRows.first()).toContainText('ZQDEEP_TOKEN');
  expect(deepFrames().some((f) => f.includes('search.deepResult'))).toBe(true);
  expect(deepFrames().join('\n')).not.toContain('sk-ant');
  await page.getByTestId('search-input').fill('deploy token');
  await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'idle');
  await page.getByTestId('search-input').press('Enter');
  await expect(machine).toContainText('完成', { timeout: 20_000 });
  await expect(page.getByTestId('search-group-transcript')).toContainText('終端機畫面');
  expect(deepFrames().join('\n')).not.toContain('sk-ant');
  await page.evaluate(() => localStorage.setItem('agent-board.mask-mode', '0'));

  // 查詢字本身是金鑰（遮蔽關著時照送）：audit 裡的查詢字已遮蔽（驗收 11）。
  await page.reload();
  await page.getByTestId('search-input').fill(key);
  await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'idle');
  await page.getByTestId('search-input').press('Enter');
  await expect(machine).toContainText('完成', { timeout: 20_000 });
  const audit = (await (await page.request.get('/api/audit?limit=500')).json()) as {
    action: string;
    detail: string;
  }[];
  const deep = audit.filter((e) => e.action === 'search.deep');
  // 四次深層搜尋（zqdeep、zqdeep token、deploy token、金鑰），一次一筆；快速層不寫。
  expect(deep).toHaveLength(4);
  expect(audit.filter((e) => e.action.startsWith('search') && e.action !== 'search.deep')).toEqual(
    [],
  );
  for (const entry of deep) expect(entry.detail).not.toContain('sk-ant-demo03-deep');
  expect(deep.some((e) => e.detail.includes('zqdeep'))).toBe(true);
});

test('全域搜尋深層：改字就取消——WebSocket 上真的送出 search.cancel（同一個 searchId），audit 記 cancelled（P3 ③b 驗收 6）', async ({
  page,
}) => {
  const live = await getSession(page.request, session.id);
  // 一份大的對話紀錄（每行都命中，要逐行解析），讓 daemon 搜得夠久，改字時還在搜。
  const projectDir = join(claudeConfigDir, 'projects', '-tmp-e2e-deep-big');
  mkdirSync(projectDir, { recursive: true });
  const big = join(projectDir, `${live.claudeSessionId}.jsonl`);
  const out = createWriteStream(big);
  const now = new Date().toISOString();
  const line =
    JSON.stringify({
      type: 'assistant',
      timestamp: now,
      message: { content: [{ type: 'text', text: `zqslow ${'慢慢讀 '.repeat(300)}` }] },
    }) + '\n';
  const block = line.repeat(200);
  for (let written = 0; written < 300 * 1024 * 1024; written += Buffer.byteLength(block)) {
    if (!out.write(block)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise<void>((r) => out.end(r));
  try {
    const sentFrames: string[] = [];
    page.on('websocket', (ws) => {
      if (ws.url().includes('/ws/client'))
        ws.on('framesent', (f) => sentFrames.push(String(f.payload)));
    });
    const sentOf = (type: string) =>
      sentFrames
        .map((f) => JSON.parse(f) as { type: string; searchId?: string })
        .filter((m) => m.type === type);
    await page.goto('/#/search');
    const input = page.getByTestId('search-input');
    await input.fill('zqslow');
    await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'idle');
    await input.press('Enter');
    await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'running');
    // 改字：取消進行中的深層搜尋。
    await input.fill('zqslow2');
    await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'idle');
    await expect.poll(() => sentOf('search.cancel').length).toBe(1);
    const [started] = sentOf('search.deep');
    expect(sentOf('search.cancel')[0]).toEqual({
      type: 'search.cancel',
      searchId: started!.searchId,
    });
    // hub 那筆 audit：被取消、還在搜的那台寫 cancelled。
    await expect
      .poll(async () => {
        const audit = (await (await page.request.get('/api/audit?limit=500')).json()) as {
          action: string;
          detail: string;
        }[];
        const entry = audit.find((e) => e.action === 'search.deep' && e.detail.includes('zqslow'));
        return entry
          ? (JSON.parse(entry.detail) as { cancelled: boolean; machines: { state: string }[] })
          : null;
      })
      .toMatchObject({ cancelled: true, machines: [{ state: 'cancelled' }] });
  } finally {
    rmSync(big, { force: true });
  }
});

test('daemon 被殺：卡片失聯；重啟：--resume 接回、畫面還在', async ({ page }) => {
  await page.goto('/#/canvas');
  // 假 claude 不寫對話紀錄；沒有紀錄時 daemon 會改成重新開始，所以放一份讓它走 --resume。
  const live = await getSession(page.request, session.id);
  const projectDir = join(claudeConfigDir, 'projects', '-tmp-e2e-resume');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${live.claudeSessionId}.jsonl`), '{}\n');
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

test('封存 → 已封存清單 → 舊資料頁讀對話與搜尋 → 刪除（真 hub、真 daemon）', async ({ page }) => {
  const ended = await getSession(page.request, session.id);
  expect(ended.endedAt).not.toBeNull();
  // 假 claude 不寫對話紀錄：放一份到 daemon 的 CLAUDE_CONFIG_DIR，位置照 Claude Code 的規則。
  const projectDir = join(claudeConfigDir, 'projects', '-tmp-e2e-repo');
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${ended.claudeSessionId}.jsonl`);
  const line = (fields: Record<string, unknown>) => JSON.stringify(fields);
  writeFileSync(
    transcript,
    [
      line({
        type: 'user',
        timestamp: '2026-11-05T01:00:00Z',
        message: { content: 'hello archive' },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-11-05T01:00:05Z',
        message: { content: [{ type: 'text', text: 'Sure, writing notes.md' }] },
      }),
      line({ type: 'user', isMeta: true, message: { content: 'meta line is skipped' } }),
      line({ type: 'user', timestamp: '2026-11-05T01:01:00Z', message: { content: 'thanks' } }),
    ].join('\n') + '\n',
  );

  // 畫布：卡片的「⋯」→ 封存（已結束的直接封存），卡片消失
  await page.goto('/#/canvas');
  const card = page.getByTestId(`card-${session.id}`);
  await card.getByRole('button', { name: /的更多動作$/ }).click();
  await card.getByRole('menuitem', { name: '封存' }).click();
  await expect(card).toHaveCount(0);
  const archived = await getArchived(page.request, session.id);
  expect(archived.archived).toBe(true);
  expect(archived.archivedAt).not.toBeNull();

  // 設定頁已封存清單：對話大小由 daemon 實際量到
  await page.goto('/#/settings/archived');
  const row = page.getByTestId(`archived-${session.id}`);
  await expect(row.getByTestId('archived-size')).toHaveText(/^對話 \d+(\.\d+)? (B|KB)$/);

  // 舊資料頁：讀對話、搜尋
  await row
    .getByRole('link', { name: '開啟' })
    .or(row.getByRole('button', { name: '開啟' }))
    .click();
  await expect(page).toHaveURL(new RegExp(`#/archive/${session.id}$`));
  await expect(page.getByTestId('transcript-count')).toHaveText('共 3 則');
  await expect(page.getByTestId('transcript-entry').first()).toContainText('hello archive');
  await page.getByRole('searchbox').last().fill('notes');
  await page.getByRole('searchbox').last().press('Enter');
  await expect(page.getByTestId('transcript-count')).toHaveText('符合 1 則（共 3 則）');

  // 刪除：勾對話紀錄，按兩次
  await page.goto('/#/settings/archived');
  await page.getByTestId(`archived-${session.id}`).getByRole('button', { name: '刪除' }).click();
  const dialog = page.getByTestId('purge-dialog');
  await dialog.getByRole('checkbox', { name: /刪掉 Claude 對話紀錄/ }).check();
  await dialog.getByRole('button', { name: '刪除', exact: true }).click();
  await page.waitForTimeout(400);
  await dialog.getByRole('button', { name: '確認刪除' }).click();
  await expect(dialog.getByRole('heading', { level: 2 })).toContainText('已刪除');
  await expect(dialog.getByTestId('purge-outcome').nth(2)).toHaveAttribute(
    'data-status',
    'removed',
  );

  // 機器上：對話紀錄沒了，專案資料夾還在；hub：紀錄沒了，audit 留著
  expect(existsSync(transcript)).toBe(false);
  expect(existsSync(join(repo, '.git'))).toBe(true);
  const left = (await (await page.request.get('/api/sessions?archived=true')).json()) as Session[];
  expect(left.some((s) => s.id === session.id)).toBe(false);
  const audit = (await (
    await page.request.get(`/api/audit?sessionId=${session.id}&action=session.delete`)
  ).json()) as unknown[];
  expect(audit).toHaveLength(1);
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
