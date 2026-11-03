// 兩個瀏覽器看同一個 session 時的終端機尺寸（CONTRACTS §6.1 第 6 點）。
// 真 hub、真 daemon、真瀏覽器，只有 claude 是假的。跑法：playwright test -c e2e/resize-integration.config.ts
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Machine, Session } from '@agent-board/protocol';
import { PORT } from './resize-integration.config';

const HUB = `http://127.0.0.1:${PORT}`;
const DAEMON_DIR = resolve(import.meta.dirname, '../../daemon');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const TSX = resolve(DAEMON_DIR, '../../node_modules/.bin/tsx');
const PASSWORD = 'resize-e2e-password';

let daemon: ChildProcess | undefined;
let daemonDir: string;
let repo: string;
let session: Session;
let wide: BrowserContext;
let narrow: BrowserContext;

function daemonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: daemonDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_MACHINE_NAME: 'resize-e2e-machine',
  };
}

/** PTY 現在的尺寸：另開一條 client 連線拿快照（快照照 daemon 的 headless 尺寸序列化）。 */
function ptySize(page: Page): Promise<string> {
  return page.evaluate(
    (id) =>
      new Promise<string>((done, fail) => {
        const ws = new WebSocket(`ws://${location.host}/ws/client`);
        const timer = setTimeout(() => fail(new Error('no snapshot')), 10_000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'terminal.subscribe', sessionId: id }));
        ws.onmessage = (event) => {
          const m = JSON.parse(String(event.data)) as { type: string; cols: number; rows: number };
          if (m.type !== 'terminal.snapshot') return;
          clearTimeout(timer);
          ws.close();
          done(`${m.cols}x${m.rows}`);
        };
      }),
    session.id,
  );
}

const terminal = (page: Page) => page.locator(`[data-terminal-session="${session.id}"]`);
const owner = (page: Page) => terminal(page).getAttribute('data-size-owner');

async function openFull(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/#/terminal/${session.id}`);
  await expect(terminal(page).locator('.xterm-screen')).toBeVisible();
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  chmodSync(FAKE_CLAUDE, 0o755);
  daemonDir = mkdtempSync(join(tmpdir(), 'ab-resize-e2e-daemon-'));
  repo = mkdtempSync(join(tmpdir(), 'ab-resize-e2e-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);

  // 兩個 context 就是兩個瀏覽器：各自的 cookie、各自的 WebSocket、不同的視窗大小。
  wide = await browser.newContext({
    baseURL: HUB,
    locale: 'zh-TW',
    viewport: { width: 1600, height: 1000 },
  });
  narrow = await browser.newContext({
    baseURL: HUB,
    locale: 'zh-TW',
    viewport: { width: 1000, height: 700 },
  });
  const setup = await wide.request.post('/api/auth/setup', {
    data: { name: 'owner', password: PASSWORD, locale: 'zh-TW' },
  });
  expect(setup.ok()).toBe(true);
  const login = await narrow.request.post('/api/auth/login', {
    data: { name: 'owner', password: PASSWORD },
  });
  expect(login.ok()).toBe(true);

  const pairing = (await (await wide.request.post('/api/machines/pairing-codes')).json()) as {
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
  let machines: Machine[] = [];
  await expect
    .poll(
      async () => {
        machines = (await (await wide.request.get('/api/machines')).json()) as Machine[];
        return machines.some((m) => m.online);
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const created = await wide.request.post('/api/sessions', {
    data: {
      machineId: machines[0]!.id,
      name: 'resize',
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
  expect(created.ok()).toBe(true);
  session = (await created.json()) as Session;
  await expect
    .poll(
      async () => {
        const all = (await (await wide.request.get('/api/sessions')).json()) as Session[];
        return all.find((s) => s.id === session.id)?.status;
      },
      { timeout: 20_000 },
    )
    .toBe('waiting_input');
});

test.afterAll(async () => {
  await wide?.close();
  await narrow?.close();
  const running = daemon;
  daemon = undefined;
  if (running && running.exitCode === null) {
    await new Promise((done) => {
      running.once('exit', done);
      running.kill('SIGTERM');
    });
  }
});

test('後來的人照擁有者的尺寸縮放顯示；點一下就換它決定；擁有者離開時交回', async () => {
  // 第一個人：還沒人擁有，它 fit 出來的尺寸套用到 PTY。
  const a = await openFull(wide);
  await expect.poll(() => owner(a)).toBe('you');
  await expect.poll(() => ptySize(a)).not.toBe('120x32');
  const wideSize = await ptySize(a);
  await expect(a.getByTestId('size-note')).toHaveCount(0);

  // 第二個人（視窗比較小）：不送 resize，照遠端尺寸等比縮小，外框外寫明原因。
  const b = await openFull(narrow);
  await expect.poll(() => owner(b)).toBe('other');
  await expect(b.getByTestId('size-note')).toContainText('另一個畫面決定');
  const scale = Number(await terminal(b).getAttribute('data-follow-scale'));
  expect(scale).toBeGreaterThan(0.3);
  expect(scale).toBeLessThan(1);
  // 縮放後的終端機整個放得進容器，不會被裁掉
  const box = (await terminal(b).boundingBox())!;
  const screen = (await terminal(b).locator('.xterm-screen').boundingBox())!;
  expect(screen.width).toBeLessThanOrEqual(box.width + 1);
  expect(screen.height).toBeLessThanOrEqual(box.height + 1);
  await b.setViewportSize({ width: 900, height: 650 });
  await b.waitForTimeout(400);
  expect(await ptySize(a)).toBe(wideSize);
  expect(await owner(a)).toBe('you');

  // 第二個人點進終端機：換它擁有，PTY 變成它的大小；第一個人改成照遠端顯示（比較小就留白）。
  await terminal(b).click();
  await expect.poll(() => owner(b)).toBe('you');
  await expect.poll(() => owner(a)).toBe('other');
  await expect.poll(() => ptySize(a)).not.toBe(wideSize);
  const narrowSize = await ptySize(a);
  expect(Number(narrowSize.split('x')[0])).toBeLessThan(Number(wideSize.split('x')[0]));
  await expect(b.getByTestId('size-note')).toHaveCount(0);
  await expect(a.getByTestId('size-note')).toBeVisible();
  expect(await terminal(a).getAttribute('data-follow-scale')).toBe('1.000');

  // 第一個人打字：搶回來，輸入照常送進 PTY。
  await terminal(a).locator('.xterm-screen').click();
  await expect.poll(() => owner(a)).toBe('you');
  await expect.poll(() => ptySize(a)).toBe(wideSize);
  await terminal(b).click();
  await expect.poll(() => owner(b)).toBe('you');
  await expect.poll(() => ptySize(a)).toBe(narrowSize);

  // 擁有者離開：交給還在看的人，PTY 回到它的大小。
  await b.close();
  await expect.poll(() => owner(a)).toBe('you');
  await expect.poll(() => ptySize(a)).toBe(wideSize);
  await expect(a.getByTestId('size-note')).toHaveCount(0);
  await a.close();
});

test('在擁有者的終端機直接打字照常送進 PTY；跟隨的一方打字會先搶下尺寸', async () => {
  const a = await openFull(wide);
  const b = await openFull(narrow);
  await expect.poll(() => owner(a)).toBe('you');
  await expect.poll(() => owner(b)).toBe('other');

  await terminal(b).locator('.xterm-helper-textarea').focus();
  await b.keyboard.type('typed-from-b');
  await b.keyboard.press('Enter');
  await expect.poll(() => owner(b)).toBe('you');
  await expect.poll(() => owner(a)).toBe('other');
  await expect
    .poll(() =>
      a.evaluate(
        (id) =>
          new Promise<string>((done) => {
            const ws = new WebSocket(`ws://${location.host}/ws/client`);
            ws.onopen = () =>
              ws.send(JSON.stringify({ type: 'terminal.subscribe', sessionId: id }));
            ws.onmessage = (event) => {
              const m = JSON.parse(String(event.data)) as { type: string; data: string };
              if (m.type !== 'terminal.snapshot') return;
              ws.close();
              done(m.data);
            };
          }),
        session.id,
      ),
    )
    .toContain('GOT typed-from-b');
  await a.close();
  await b.close();
});
