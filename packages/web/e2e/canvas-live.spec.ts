// GM 2026-11-16（0.1.12 正式環境）：畫布上的卡「送出了但看不到回覆」「打不了字」。
// 0.1.11 起畫布的 xterm 有名額（canvas/terminalPool.ts），畫面內的終端機卡超過名額時只放 lastLines
// 的靜態文字：看不到即時輸出、點進去也打不了字。這裡做接近正式的情境（30 張卡、持續輸出、
// 大螢幕、縮放 75%／83%／95%／100%、摘要條開與關），確認畫面內顯示成終端機的卡：
// 每張都有即時的 xterm、點進去打字送得出去、卡片下方輸入框送出後看得到回顯與回覆。
// 跑法：e2e/terminal-budget.config.ts（chromium 與 webkit 各一輪）。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const VIEWS = '/src/views/index.ts';
const CONTROLLER = '/src/terminal/controller.ts';
const SESSIONS = 30;

test.use({ locale: 'zh-TW' });
test.describe.configure({ timeout: 180_000 });

let problems: string[];
test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
});
test.afterEach(() => {
  expect(problems, 'console 不該有錯誤').toEqual([]);
});

/** 補到 30 個活著的 session，每 250ms 對每個 session 送一行輸出（tick-<n>）。 */
async function setup(page: Page, summary: 'on' | 'off') {
  await page.addInitScript((summary) => {
    localStorage.setItem('agent-board.canvas.summary-when-zoomed-out', summary);
  }, summary);
  // 接近 Mac mini 的大螢幕：畫面內同時有很多張卡。
  await page.setViewportSize({ width: 2560, height: 1440 });
  // 在全尺寸頁補 session（畫布不在）：畫布開著時一口氣建 26 個，React Flow 的 setNodes 會連鎖更新，
  // 機器忙時 React 開發版會在 console 印 Maximum update depth（只發生在測試這種瞬間大量建立）。
  await page.goto('/#/canvas');
  await expect(page.getByTestId('card-s-auth')).toBeVisible();
  await page.evaluate(() => (location.hash = '#/terminal/s-auth'));
  await expect(page.getByTestId('full-s-auth')).toBeVisible();
  await page.evaluate(
    async ({ url, total }) => {
      const { useBoard } = await import(/* @vite-ignore */ url);
      for (let i = 0; i < 100 && useBoard.getState().sessions.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const backend = useBoard.getState().backend;
      const live = useBoard
        .getState()
        .sessions.filter((s: { status: string }) => s.status !== 'offline').length;
      for (let i = live; i < total; i += 1) {
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
      const w = window as never as { __tick: number; __paused: boolean };
      w.__tick = 0;
      w.__paused = false;
      setInterval(() => {
        // 打字的回顯是一個字一個字送的，中間插進 tick 會把字拆到不同行；打字時先停。
        if (w.__paused) return;
        w.__tick += 1;
        for (const s of useBoard.getState().sessions) {
          if (s.status !== 'offline') backend.terminal.emit(s.id, `tick-${w.__tick}\r\n`);
        }
      }, 250);
    },
    { url: STORE, total: SESSIONS },
  );
}

/** 把畫布鏡頭放在指定倍率（從全尺寸頁回來的路徑：一開始就是這個鏡頭）。 */
async function showAt(page: Page, zoom: number) {
  // 全尺寸頁會把畫布卸載；在那裡設好回來的鏡頭再回畫布。
  await page.evaluate(() => (location.hash = '#/terminal/s-auth'));
  await expect(page.getByTestId('full-s-auth')).toBeVisible();
  await page.evaluate(
    async ({ url, zoom }) => {
      const { useViewsUi } = await import(/* @vite-ignore */ url);
      useViewsUi.getState().setCanvasReturn({ x: 40, y: 80, zoom });
    },
    { url: VIEWS, zoom },
  );
  await page.evaluate(() => (location.hash = '#/canvas'));
  await expect(page.getByTestId('card-s-auth')).toBeAttached();
}

const zoomLevel = async (page: Page) =>
  parseInt((await page.getByTestId('zoom-level').textContent()) ?? '0', 10);

/** 準備好鏡頭：83% 是從 100% 縮小一格（門檻有緩衝區間，往下縮到 80% 以上仍是終端機）。 */
async function arrange(page: Page, zoom: number) {
  if (zoom === 0.83) {
    await showAt(page, 1);
    await expect.poll(() => zoomLevel(page)).toBe(100);
    await page.getByRole('button', { name: '縮小' }).click();
    await expect.poll(() => zoomLevel(page)).toBe(83);
  } else {
    await showAt(page, zoom);
    await expect.poll(() => zoomLevel(page)).toBe(Math.round(zoom * 100));
  }
}

/** 某個 session 卡片上 xterm buffer 的全部文字；沒有 xterm 回 null。 */
function bufferText(page: Page, id: string) {
  return page.evaluate(
    async ({ url, id }) => {
      const { terminalForTest } = (await import(/* @vite-ignore */ url)) as {
        terminalForTest: (el: HTMLElement) =>
          | {
              buffer: {
                active: {
                  length: number;
                  getLine(i: number): { translateToString(trim: boolean): string } | undefined;
                };
              };
            }
          | undefined;
      };
      const el = document.querySelector<HTMLElement>(
        `[data-testid="card-${id}"] [data-testid="terminal-slot"] [data-terminal-session]`,
      );
      const buffer = el ? terminalForTest(el)?.buffer.active : undefined;
      if (!buffer) return null;
      let text = '';
      for (let i = 0; i < buffer.length; i += 1) {
        text += (buffer.getLine(i)?.translateToString(true) ?? '') + '\n';
      }
      return text;
    },
    { url: CONTROLLER, id },
  );
}

/** 真的在可視範圍內（不只是外框碰到邊）、而且中心點點得到的終端機卡。 */
function clickableTerminalCards(page: Page) {
  return page.evaluate(() => {
    const out: { id: string; live: boolean; slot: { x: number; y: number } }[] = [];
    for (const card of document.querySelectorAll<HTMLElement>('[data-mode="terminal"]')) {
      const slot = card.querySelector<HTMLElement>('[data-testid="terminal-slot"]');
      const input = card.querySelector<HTMLElement>('input.cmd');
      if (!slot || !input) continue;
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (!slot.contains(document.elementFromPoint(x, y))) continue;
      const ir = input.getBoundingClientRect();
      const ix = ir.left + ir.width / 2;
      const iy = ir.top + ir.height / 2;
      if (ix < 0 || iy < 0 || ix >= innerWidth || iy >= innerHeight) continue;
      if (document.elementFromPoint(ix, iy) !== input) continue;
      out.push({
        id: card.dataset.testid!.replace(/^card-/, ''),
        live: slot.dataset.terminal === 'live',
        slot: { x, y },
      });
    }
    return out;
  });
}

/** 畫面內每張終端機卡都有 xterm，而且最新的輸出（最近 2 秒內的 tick）在畫面上。 */
async function allVisibleTerminalsLive(page: Page) {
  await expect
    .poll(
      async () => {
        const ids = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-mode="terminal"] [data-testid="terminal-slot"][data-visible="true"]',
            ),
          ].map((slot) => ({
            id: slot.closest<HTMLElement>('[data-mode]')!.dataset.testid!.replace(/^card-/, ''),
            live: slot.dataset.terminal === 'live',
          })),
        );
        if (ids.length === 0) return 'no-visible-terminal';
        const idle = ids.filter((x) => !x.live).map((x) => x.id);
        if (idle.length) return `idle ${idle.length}/${ids.length}: ${idle.slice(0, 5).join(',')}`;
        const tick = await page.evaluate(() => (window as never as { __tick: number }).__tick);
        for (const { id } of ids) {
          const text = (await bufferText(page, id)) ?? '';
          const last = Math.max(0, ...[...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1])));
          if (tick - last > 8) return `stale ${id}: last ${last}, now ${tick}`;
        }
        return 'ok';
      },
      { timeout: 6000 },
    )
    .toBe('ok');
}

const inputs = (page: Page) =>
  page.evaluate(
    () => (window as never as { __inputs: { sessionId: string; data: string }[] }).__inputs,
  );

async function spyInput(page: Page) {
  await page.evaluate(async (url) => {
    const { useBoard } = await import(/* @vite-ignore */ url);
    const term = useBoard.getState().backend.terminal;
    const w = window as never as { __inputs: unknown[] };
    w.__inputs = [];
    const send = term.send.bind(term);
    term.send = (m: { type: string }) => {
      if (m.type === 'terminal.input') w.__inputs.push(m);
      send(m);
    };
  }, STORE);
}

/** crowded：畫面內的終端機卡超過 0.1.11–0.1.12 的名額 8 張（正式環境 2560 寬、摘要條關、縮小時）。 */
const SCENARIOS: { zoom: number; summary: 'on' | 'off'; crowded?: boolean }[] = [
  { zoom: 0.5, summary: 'off', crowded: true },
  { zoom: 0.75, summary: 'off' },
  { zoom: 0.83, summary: 'on' },
  { zoom: 0.83, summary: 'off' },
  { zoom: 0.95, summary: 'on' },
  { zoom: 0.95, summary: 'off' },
  { zoom: 1, summary: 'on' },
  { zoom: 1, summary: 'off' },
];

for (const { zoom, summary, crowded } of SCENARIOS) {
  test(`畫布 ${Math.round(zoom * 100)}%、摘要條${summary === 'on' ? '開' : '關'}：畫面內的終端機卡即時輸出、點進去能打字、下方輸入框送出看得到回覆`, async ({
    page,
  }) => {
    await setup(page, summary);
    await arrange(page, zoom);
    await expect(page.locator('[data-mode="terminal"]').first()).toBeAttached();
    if (crowded) {
      await expect
        .poll(() =>
          page
            .locator('[data-mode="terminal"] [data-testid="terminal-slot"][data-visible="true"]')
            .count(),
        )
        .toBeGreaterThan(8);
    }
    // 一開始沒有任何操作：畫面內的終端機卡都在即時更新。
    await allVisibleTerminalsLive(page);

    const cards = await clickableTerminalCards(page);
    expect(cards.length, '要有點得到的終端機卡').toBeGreaterThanOrEqual(2);
    // 優先挑還沒有 xterm 的卡（最壞情況）。
    cards.sort((a, b) => Number(a.live) - Number(b.live));
    await spyInput(page);
    const pauseTicks = (paused: boolean) =>
      page.evaluate((p) => ((window as never as { __paused: boolean }).__paused = p), paused);
    await pauseTicks(true);

    // (a) 點進終端機打字送出：只點一下，就要能打字。
    const a = cards[0]!;
    await page.mouse.click(a.slot.x, a.slot.y);
    await page.keyboard.type('typed-a');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () =>
        (await inputs(page))
          .filter((m) => m.sessionId === a.id)
          .map((m) => m.data)
          .join(''),
      )
      .toContain('typed-a');
    await expect.poll(async () => (await bufferText(page, a.id)) ?? '').toContain('typed-a');

    // (b) 卡片下方的輸入框送出，(c) 等回覆：都要即時出現在卡片的終端機上。
    const b = cards[1]!;
    const input = page.locator(`[data-testid="card-${b.id}"] input.cmd`);
    await input.fill('prompt-b');
    await input.press('Enter');
    await expect.poll(async () => (await bufferText(page, b.id)) ?? '').toContain('prompt-b');
    await page.evaluate(
      async ({ url, id }) => {
        const { useBoard } = await import(/* @vite-ignore */ url);
        useBoard.getState().backend.terminal.emit(id, 'REPLY-for-b\r\n');
      },
      { url: STORE, id: b.id },
    );
    await expect.poll(async () => (await bufferText(page, b.id)) ?? '').toContain('REPLY-for-b');

    // 操作之後，畫面內其他終端機卡也仍在即時更新（沒有被擠掉）。
    await pauseTicks(false);
    await allVisibleTerminalsLive(page);
  });
}
