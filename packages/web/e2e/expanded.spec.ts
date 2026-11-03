// 全尺寸終端機（DISPATCH §5.3 畫面 5）與任務完成提示（§8-6），用 fakeBackend 操作。
// 單獨跑：corepack pnpm exec playwright test -c e2e/expanded.config.ts
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const SHOTS = process.env.EXPANDED_SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.use({ locale: 'zh-TW' });

let consoleProblems: string[];

test.beforeEach(async ({ page }) => {
  consoleProblems = [];
  await page.exposeFunction('__reportError', (m: string) => consoleProblems.push(m));
  await page.addInitScript(() => {
    addEventListener('error', (e) =>
      (window as never as { __reportError: (m: string) => void }).__reportError(e.message),
    );
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleProblems.push(m.text());
  });
  page.on('pageerror', (e) => consoleProblems.push(e.message));
});

test.afterEach(() => {
  expect(consoleProblems, 'console 不該有錯誤').toEqual([]);
});

interface Spy {
  sent: { type: string; sessionId: string; cols?: number; rows?: number; signal?: string }[];
  active: Record<string, number>;
  prompts: [string, string][];
}

const card = (page: Page, id: string) => page.getByTestId(`card-${id}`);
const spy = (page: Page) => page.evaluate(() => (window as never as { __spy: Spy }).__spy);

/** 在 Vite 的模組實例上執行；和 App 是同一份 store 與假後端。 */
async function withBackend(page: Page, body: string) {
  await page.evaluate(
    async ({ url, body }) => {
      const { useBoard } = await import(/* @vite-ignore */ url);
      await new Function('b', `return (async () => { ${body} })()`)(useBoard.getState().backend);
    },
    { url: STORE, body },
  );
}

/** 記下送出的終端機訊息、每個 session 目前的訂閱數、sendPrompt。 */
async function instrument(page: Page) {
  await withBackend(
    page,
    `const term = b.terminal;
     const spy = { sent: [], active: {}, prompts: [] };
     window.__spy = spy;
     const subscribe = term.subscribe.bind(term);
     term.subscribe = (id, cb) => {
       spy.active[id] = (spy.active[id] ?? 0) + 1;
       const stop = subscribe(id, cb);
       let stopped = false;
       return () => {
         if (!stopped) { stopped = true; spy.active[id] -= 1; }
         stop();
       };
     };
     const send = term.send.bind(term);
     term.send = (m) => { spy.sent.push(m); send(m); };
     const sendPrompt = b.sendPrompt.bind(b);
     b.sendPrompt = (id, text) => { spy.prompts.push([id, text]); sendPrompt(id, text); };`,
  );
}

async function openCanvas(page: Page) {
  await page.goto('/#/canvas');
  await expect(card(page, 's-auth')).toBeVisible();
  await expect(page.getByTestId('zoom-level')).not.toHaveText('100%');
}

const viewportTransform = (page: Page) =>
  page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth <= el.clientWidth && document.body.scrollWidth <= el.clientWidth;
  });

test('從卡片打開全尺寸：xterm 填滿、resize 送出、Esc、切換、回畫布同一個位置', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await instrument(page);

  const tests = card(page, 's-tests');
  await tests.locator('.tail').dblclick();
  await expect(tests).toHaveAttribute('data-mode', 'terminal');
  await page.waitForTimeout(300); // 等鏡頭停下
  const before = await viewportTransform(page);
  const cardCols = await page.evaluate(() =>
    (window as never as { __spy: Spy }).__spy.sent.findLast(
      (m) => m.type === 'terminal.resize' && m.sessionId === 's-tests',
    ),
  );

  await tests.getByTestId('open-full').click();
  await expect(page).toHaveURL(/#\/terminal\/s-tests$/);
  const full = page.getByTestId('full-s-tests');
  await expect(full.locator('.xterm-screen')).toBeVisible();
  // 畫布卸載了：整頁只有一個 xterm，這個 session 只有一份訂閱。
  await expect(page.locator('[data-terminal-session]')).toHaveCount(1);
  await expect.poll(async () => (await spy(page)).active['s-tests']).toBe(1);
  // 插槽裡只有 TerminalView，沒有疊任何東西（規則三之一）。
  await expect(full.getByTestId('terminal-slot').locator(':scope > *')).toHaveCount(1);

  // 全尺寸的 resize 走原本的路徑，而且比卡片上的大。
  await expect
    .poll(async () => {
      const last = (await spy(page)).sent.findLast(
        (m) => m.type === 'terminal.resize' && m.sessionId === 's-tests',
      );
      return (last?.cols ?? 0) > Math.max(95, cardCols?.cols ?? 0) && (last?.rows ?? 0) > 28;
    })
    .toBe(true);

  await shot(page, 'full-zh');
  // 其他 session 在旁邊，有狀態燈；目前這個標成選中。
  await expect(page.getByTestId('full-item-s-tests')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('full-item-s-auth').locator('.lamp')).toHaveText('◆等你允許');
  await expect(page.getByTestId('full-item-s-web').locator('.lamp')).toHaveText('⊘失聯');

  // Esc 中斷
  await full.getByRole('button', { name: 'Esc 中斷' }).click();
  await expect(full.getByRole('status')).toHaveText('已送 Esc');
  expect((await spy(page)).sent).toContainEqual({
    type: 'terminal.signal',
    sessionId: 's-tests',
    signal: 'escape',
  });

  // 切到另一個 session：舊的退訂，新的只有一份。
  await page.getByTestId('full-item-s-ml').click();
  await expect(page).toHaveURL(/#\/terminal\/s-ml$/);
  await expect(page.getByTestId('full-s-ml').locator('.xterm-screen')).toBeVisible();
  await expect(page.locator('[data-terminal-session]')).toHaveCount(1);
  await expect.poll(async () => (await spy(page)).active).toEqual({ 's-tests': 0, 's-ml': 1 });

  // 回畫布：鏡頭和離開時一樣。
  await page.getByTestId('full-back').click();
  await expect(card(page, 's-auth')).toBeVisible();
  expect(await viewportTransform(page)).toBe(before);
  await expect.poll(async () => (await spy(page)).active['s-ml']).toBe(0);
});

test('網址重新載入停在同一個 session；待決的 approval 可以直接決定；回畫布框出該卡', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/terminal/s-auth');
  await expect(page.getByTestId('full-s-auth').locator('.xterm-screen')).toBeVisible();
  await page.reload();
  const full = page.getByTestId('full-s-auth');
  await expect(full.locator('.xterm-screen')).toBeVisible();

  const review = full.getByTestId('review-a-1');
  await expect(review).toContainText('npm test -- auth');
  await expect(review.locator('.callsign').first()).toHaveText(
    'demo-studio / project @ ab/fix-auth',
  );
  await shot(page, 'full-approval');
  await review.getByRole('button', { name: '允許一次' }).click();
  await expect(review).toHaveCount(0);
  await expect(full.locator('.head .lamp')).toHaveText('●工作中');

  // 直接開網址進來沒有記下的鏡頭：回畫布時框出這張卡。
  await page.getByTestId('full-back').click();
  await expect(card(page, 's-auth')).toHaveClass(/spot/);
});

test('找不到或已封存的 session 寫下一步', async ({ page }) => {
  await page.goto('/#/terminal/nope');
  await expect(page.locator('[data-state="empty"]')).toContainText('找不到這個 session');
  await page.getByRole('main').getByRole('button', { name: '回畫布' }).click();
  await expect(card(page, 's-auth')).toBeVisible();
});

test('交接：沿用團隊規則，新規則先關著；沒有團隊時說明怎麼做', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/terminal/s-auth');
  const box = page.getByTestId('full-handoff');
  const existing = box.getByTestId('full-rule-rule-1');
  await expect(existing).toContainText('Write tests');
  await expect(existing.getByRole('button', { name: '關閉自動交接' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(existing.locator('.cost')).toHaveText('◈ 耗額度');

  await box.getByLabel('交給').selectOption({ label: 'Train model' });
  await box.getByLabel('觸發條件').selectOption('on_fail');
  await box.getByRole('button', { name: '新增交接' }).click();
  await expect(box.getByRole('status')).toContainText('已新增');
  const added = box.locator('.xpand-rules li').filter({ hasText: 'Train model' });
  await expect(added).toContainText('失敗時交接');
  await added.getByRole('button', { name: '開啟自動交接' }).click();
  await expect(added.getByRole('button', { name: '關閉自動交接' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByTestId('full-item-s-etl').click();
  const other = page.getByTestId('full-handoff');
  await other.getByLabel('交給').selectOption({ label: 'Train model' });
  await other.getByRole('button', { name: '新增交接' }).click();
  await expect(other.getByRole('alert')).toContainText('交接規則屬於團隊');
});

test('完成提示：在等輸入時標記完成可送 /clear；可封存、可關掉', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await instrument(page);

  // 在等輸入時被標記完成：PTY 還活著，可以送 /clear。
  await withBackend(
    page,
    `b.setSessionStatus('s-tests', 'waiting_input');
     await b.updateSession('s-tests', { markDone: true });`,
  );
  const hint = page.getByTestId('done-hint-s-tests');
  await expect(hint).toContainText('任務完成');
  await expect(hint).not.toHaveClass(/you|fault/);
  await shot(page, 'done-hint-strip');
  await hint.getByRole('button', { name: '送出 /clear' }).click();
  expect((await spy(page)).prompts).toEqual([['s-tests', '/clear']]);

  // 工作中被標記完成：不給送，寫原因；可以關掉。
  await withBackend(page, `await b.updateSession('s-docs', { markDone: true });`);
  const busy = page.getByTestId('done-hint-s-docs');
  await expect(busy).toContainText('標記完成時它不在等輸入');
  await expect(busy.getByRole('button', { name: '送出 /clear' })).toHaveCount(0);
  await busy.getByRole('button', { name: '不用了' }).click();
  await expect(busy).toHaveCount(0);

  // 全尺寸頁也有同一個提示，封存後這個 session 就不在了。
  await withBackend(page, `await b.updateSession('s-ml', { markDone: true });`);
  await page.goto('/#/terminal/s-ml');
  const full = page.getByTestId('done-hint-s-ml');
  await expect(full).toContainText('任務完成');
  await shot(page, 'done-hint-full');
  await full.getByRole('button', { name: '封存' }).click();
  await expect(page.locator('[data-state="empty"]')).toContainText('找不到這個 session');
  await expect(page.getByTestId('full-item-s-ml')).toHaveCount(0);
});

test('英文與窄螢幕：固定用詞，沒有整頁水平捲軸', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 760 });
  await page.goto('/#/terminal/s-auth');
  await expect(page.getByTestId('full-s-auth').locator('.xterm-screen')).toBeVisible();
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByTestId('full-back')).toHaveText('← Back to canvas');
  await expect(page.getByRole('button', { name: 'Esc to interrupt' })).toBeVisible();
  await expect(page.getByTestId('full-handoff').locator('h3')).toHaveText('Hand off');
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, 'full-en-1024');

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.getByTestId('full-s-auth')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, `full-en-${width}`);
  }
});
