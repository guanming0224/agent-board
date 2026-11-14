// GM 2026-11-14：分頁記憶體 1GB 多。畫布卡的 xterm 只給畫面內＋最近看過的（canvas/terminalPool.ts），
// WebGL 全頁共用配額（terminal/webglBudget.ts）。這裡用 25 個 session 反覆縮放確認不會超過上限。
// 單獨跑：e2e/terminal-budget.config.ts（chromium 與 webkit 各一輪）。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const CONTROLLER = '/src/terminal/controller.ts';
type TermModule = {
  terminalForTest: (el: HTMLElement) =>
    | {
        options: { scrollback?: number };
        buffer: {
          active: {
            length: number;
            getLine(i: number): { translateToString(trim: boolean): string } | undefined;
          };
        };
      }
    | undefined;
};
const CARD_XTERM_LIMIT = 8;
const WEBGL_LIMIT = 6;
const RELEASE_MS = 5000;

test.use({ locale: 'zh-TW' });
test.describe.configure({ timeout: 180_000 });

let tooMany: string[];
let problems: string[];

test.beforeEach(async ({ page }) => {
  tooMany = [];
  problems = [];
  page.on('console', (m) => {
    if (/too many active webgl contexts/i.test(m.text())) tooMany.push(m.text());
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
});

test.afterEach(() => {
  expect(tooMany, '不該撞到瀏覽器的 WebGL context 上限').toEqual([]);
  expect(problems, 'console 不該有錯誤').toEqual([]);
});

const card = (page: Page, id: string) => page.getByTestId(`card-${id}`);

async function zoomLevel(page: Page) {
  return parseInt((await page.getByTestId('zoom-level').textContent()) ?? '0', 10);
}

async function zoomUntil(page: Page, atLeast: number) {
  for (let i = 0; i < 24 && (await zoomLevel(page)) < atLeast; i += 1) {
    await page.getByRole('button', { name: '放大' }).click();
  }
  expect(await zoomLevel(page)).toBeGreaterThanOrEqual(atLeast);
}

/** 補到 25 個活著的 session，重開畫布，裝上取樣器（記錄 .xterm 與 WebGL 數的最大值）。 */
async function open25(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/canvas');
  await expect(card(page, 's-auth')).toBeVisible();
  await page.evaluate(async (url) => {
    const { useBoard } = await import(/* @vite-ignore */ url);
    const backend = useBoard.getState().backend;
    const live = useBoard
      .getState()
      .sessions.filter((s: { status: string }) => s.status !== 'offline').length;
    for (let i = live; i < 25; i += 1) {
      const s = await backend.createSession({
        name: `load-${i}`,
        machineId: 'm-studio',
        cwd: '/home/demo/project',
        useWorktree: false,
        readOnly: false,
        permissionMode: 'default',
        model: null,
        projectId: null,
        firstPrompt: null,
      });
      backend.setSessionStatus(s.id, 'running');
    }
  }, STORE);
  await page.evaluate(() => (location.hash = '#/'));
  await page.evaluate(() => (location.hash = '#/canvas'));
  await expect(card(page, 's-auth')).toBeVisible();
  await page.getByRole('button', { name: '全部顯示' }).click();
  await expect
    .poll(() => page.locator('[data-testid^="card-"]').count())
    .toBeGreaterThanOrEqual(25);
  await page.evaluate(() => {
    const w = window as never as { __max: { xterm: number; webgl: number } };
    w.__max = { xterm: 0, webgl: 0 };
    setInterval(() => {
      w.__max.xterm = Math.max(w.__max.xterm, document.querySelectorAll('.xterm').length);
      w.__max.webgl = Math.max(
        w.__max.webgl,
        document.querySelectorAll('[data-renderer="webgl"]').length,
      );
    }, 20);
  });
}

const peaks = (page: Page) =>
  page.evaluate(() => (window as never as { __max: { xterm: number; webgl: number } }).__max);
const xtermCount = (page: Page) => page.locator('.xterm').count();

/**
 * 畫面內、顯示成終端機的卡：分到 xterm（畫面內超過名額時只有名額數那麼多），
 * 而且 buffer 裡有內容（WebGL 畫的字從 DOM 讀不到）。
 */
async function visibleTerminalsShowContent(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ url, limit }) => {
            const { terminalForTest } = (await import(/* @vite-ignore */ url)) as TermModule;
            const slots = [
              ...document.querySelectorAll<HTMLElement>(
                '[data-mode="terminal"] [data-testid="terminal-slot"][data-visible="true"]',
              ),
            ];
            if (slots.length === 0) return 'no-visible-slot';
            const live = slots.filter((slot) => slot.querySelector('[data-terminal-session]'));
            if (live.length < Math.min(slots.length, limit)) {
              return `live ${live.length} / visible ${slots.length}`;
            }
            for (const slot of live) {
              const container = slot.querySelector<HTMLElement>('[data-terminal-session]')!;
              const id = slot.closest('[data-mode]')?.getAttribute('data-testid');
              const buffer = terminalForTest(container)?.buffer.active;
              let text = '';
              for (let i = 0; buffer && i < buffer.length; i += 1) {
                text += buffer.getLine(i)?.translateToString(true) ?? '';
              }
              if (!text.trim()) return `empty ${id}`;
            }
            return 'ok';
          },
          { url: CONTROLLER, limit: CARD_XTERM_LIMIT },
        ),
      { timeout: 5000 },
    )
    .toBe('ok');
}

test('縮放全覽↔放大來回 10 次：xterm、WebGL 不超過上限，畫面內的卡有內容，縮回後釋放', async ({
  page,
}) => {
  await open25(page);
  // 全覽是摘要條：一個 xterm 都沒有。
  expect(await zoomLevel(page)).toBeLessThan(80);
  await expect(page.locator('[data-mode="terminal"]')).toHaveCount(0);
  // 畫布剛開時（fitView 之前）短暫是 100%，那時畫面內的卡拿到的 xterm 在寬限期過後釋放。
  await expect.poll(() => xtermCount(page), { timeout: RELEASE_MS + 5000 }).toBe(0);

  for (let round = 0; round < 10; round += 1) {
    await zoomUntil(page, 90);
    await expect(card(page, 's-auth')).toHaveAttribute('data-mode', 'terminal');
    await visibleTerminalsShowContent(page);
    await page.getByRole('button', { name: '全部顯示' }).click();
    await expect(page.locator('[data-mode="terminal"]')).toHaveCount(0);
  }
  const peak = await peaks(page);
  expect(peak.xterm).toBeGreaterThan(0);
  expect(peak.xterm).toBeLessThanOrEqual(CARD_XTERM_LIMIT);
  expect(peak.webgl).toBeLessThanOrEqual(WEBGL_LIMIT);
  // 縮回摘要條後寬限期過了就全部釋放。
  await expect.poll(() => xtermCount(page), { timeout: RELEASE_MS + 5000 }).toBe(0);
});

test('摘要條關：全覽時畫面內 25 張都是終端機，xterm 仍不超過名額，其他卡顯示最後幾行', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('agent-board.canvas.summary-when-zoomed-out', 'off');
  });
  await open25(page);
  await expect
    .poll(() => page.locator('[data-mode="terminal"]').count())
    .toBeGreaterThanOrEqual(25);
  await expect.poll(() => page.locator('[data-terminal="live"]').count()).toBe(CARD_XTERM_LIMIT);
  // 沒分到的卡在插槽放最後幾行文字（不是空白）。
  await expect(page.locator('[data-terminal="idle"] .term-idle').first()).toBeAttached();
  for (let round = 0; round < 3; round += 1) {
    await zoomUntil(page, 90);
    await visibleTerminalsShowContent(page);
    await page.getByRole('button', { name: '全部顯示' }).click();
  }
  const peak = await peaks(page);
  expect(peak.xterm).toBeLessThanOrEqual(CARD_XTERM_LIMIT);
  expect(peak.webgl).toBeLessThanOrEqual(WEBGL_LIMIT);
});

test('放大後離開畫面的卡過幾秒釋放、留在畫面的保留；全尺寸頁正常', async ({ page }) => {
  await open25(page);
  await zoomUntil(page, 90);
  await visibleTerminalsShowContent(page);
  // 放得更大：邊角的卡被推出畫面。
  await zoomUntil(page, 170);
  const offscreen = page.locator(
    '[data-testid="terminal-slot"][data-visible="false"][data-terminal="live"]',
  );
  const stays = page.locator(
    '[data-testid="terminal-slot"][data-visible="true"][data-terminal="live"]',
  );
  await expect.poll(() => stays.count()).toBeGreaterThan(0);
  await expect.poll(() => offscreen.count(), { timeout: RELEASE_MS + 5000 }).toBe(0);
  expect(await stays.count()).toBeGreaterThan(0);
  await visibleTerminalsShowContent(page);
  const peak = await peaks(page);
  expect(peak.xterm).toBeLessThanOrEqual(CARD_XTERM_LIMIT);
  expect(peak.webgl).toBeLessThanOrEqual(WEBGL_LIMIT);

  // 全尺寸頁：只有一個 xterm，內容正常，捲動保留 1000 行（畫布小卡是 300）。
  const id = await stays
    .first()
    .locator('[data-terminal-session]')
    .getAttribute('data-terminal-session');
  const scrollback = (selector: string) =>
    page.evaluate(
      async ({ selector, url }) => {
        const { terminalForTest } = (await import(/* @vite-ignore */ url)) as TermModule;
        const el = document.querySelector<HTMLElement>(selector);
        return el ? terminalForTest(el)?.options.scrollback : null;
      },
      { selector, url: CONTROLLER },
    );
  expect(await scrollback(`[data-terminal-session="${id}"]`)).toBe(300);
  await page.evaluate((id) => (location.hash = `#/terminal/${id}`), id);
  const full = page.getByTestId(`full-${id}`);
  await expect(full.locator('.xterm-screen')).toBeVisible();
  await expect(page.locator('.xterm')).toHaveCount(1);
  expect(await scrollback(`[data-terminal-session="${id}"]`)).toBe(1000);
  await page.goBack();
  await expect(card(page, 's-auth')).toBeVisible();
});
