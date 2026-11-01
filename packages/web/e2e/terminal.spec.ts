import { expect, test, type Page } from '@playwright/test';

const HARNESS = '/e2e/terminal-harness.html';

async function open(page: Page, query = '') {
  await page.goto(`${HARNESS}${query}`);
  await page.waitForFunction(() => window.__harness !== undefined);
  await page.waitForSelector('.xterm-screen');
}

const inputs = (page: Page) => page.evaluate(() => window.__harness.inputs());
const lines = (page: Page) => page.evaluate(() => window.__harness.lines().join('\n'));
const renderer = (page: Page) => page.evaluate(() => window.__harness.renderer());
const emit = (page: Page, data: string) =>
  page.evaluate((text) => window.__harness.emit(text), data);

/** 切換 visible 並等到 TerminalView 真的收到，之後送的輸出才算「切換後」。 */
async function setVisible(page: Page, visible: boolean) {
  await page.evaluate((value) => window.__harness.setVisible(value), visible);
  await page.waitForFunction((value) => window.__harness.visibleApplied() === value, visible);
}

const expectScreenContains = (page: Page, text: string) =>
  expect.poll(() => lines(page)).toContain(text);

/** 最後送出的 resize 等於終端機目前的尺寸。尺寸會在快照還原後才 fit，所以兩邊都要一起輪詢。 */
const expectResizeSettled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const last = window.__harness.resizes().at(-1);
        const { cols, rows } = window.__harness.size();
        return last?.cols === cols && last?.rows === rows;
      }),
    )
    .toBe(true);

// 確保無頭 Chromium 有 WebGL2 可用（軟體繪製）
test.use({
  launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

// Vite 第一次遇到 xterm 會預先打包並整頁重載，先載入一次，避免在測試途中發生。
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await open(page);
  await page.waitForLoadState('networkidle');
  await page.close();
});

test.describe('輸出', () => {
  test('快照與串流輸出顯示正確', async ({ page }) => {
    await open(page);
    await expectScreenContains(page, 'demo session e2e');
    await emit(page, 'hello from pty\r\n');
    await expectScreenContains(page, 'hello from pty');
  });

  test('ANSI 顏色保留，主題背景用 --term-bg', async ({ page }) => {
    await open(page);
    await emit(page, '\x1b[31mREDTEXT\x1b[0m plain\r\n');
    await expectScreenContains(page, 'REDTEXT');
    expect(await page.evaluate(() => window.__harness.colorOf('REDTEXT'))).toEqual({
      palette: true,
      color: 1,
    });
    expect(await page.evaluate(() => window.__harness.colorOf('plain'))).toMatchObject({
      palette: false,
    });
    expect(await page.evaluate(() => window.__harness.background())).toBe('#0a0c10');
  });

  test('跳號時重新訂閱，之後的輸出照常顯示', async ({ page }) => {
    await open(page);
    const before = await page.evaluate(() => window.__harness.subscribes());
    await page.evaluate(() => {
      window.__harness.dropNextOutput();
      window.__harness.emit('lost\r\n');
      window.__harness.emit('after-gap\r\n');
    });
    expect(await page.evaluate(() => window.__harness.subscribes())).toBe(before + 1);
    await emit(page, 'resumed\r\n');
    await expectScreenContains(page, 'resumed');
  });
});

test.describe('renderer 退回', () => {
  test('沒有 WebGL2 時退回 DOM renderer，不黑屏', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        return type === 'webgl2' ? null : original.call(this, type as '2d', ...(rest as []));
      } as unknown as typeof original;
    });
    await open(page);
    expect(await renderer(page)).toBe('dom');
    await expect(page.locator('.xterm-rows')).toContainText('demo session e2e');
    await emit(page, '\x1b[31mREDTEXT\x1b[0m\r\n');
    await expect(page.locator('.xterm-rows .xterm-fg-1')).toContainText('REDTEXT');
  });

  test('WebGL context lost 立刻退回 DOM renderer，不黑屏', async ({ page }) => {
    await open(page);
    test.skip((await renderer(page)) !== 'webgl', '這個環境的 Chromium 沒有 WebGL2');
    await page.evaluate(() => {
      for (const canvas of document.querySelectorAll('.xterm-screen canvas')) {
        const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
      }
    });
    await expect.poll(() => renderer(page), { timeout: 1000 }).toBe('dom');
    await expect(page.locator('.xterm-rows')).toContainText('demo session e2e');
    await emit(page, 'after-loss\r\n');
    await expect(page.locator('.xterm-rows')).toContainText('after-loss');
  });
});

test.describe('輸入', () => {
  test('autoFocus 後打字走 terminal.input', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => window.__harness.focusIsInTerminal())).toBe(true);
    await page.keyboard.type('ls');
    await page.keyboard.press('Control+c');
    await expect.poll(() => inputs(page)).toEqual(['l', 's', '\x03']);
  });

  test('中文輸入法：組字中不送，確定後只送一次', async ({ page, context }) => {
    await open(page);
    const cdp = await context.newCDPSession(page);
    const compose = (text: string) =>
      cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });

    await compose('ㄋ');
    await compose('ㄋㄧˇ');
    await compose('你');
    await compose('你好');
    await page.waitForTimeout(100);
    expect(await inputs(page)).toEqual([]);

    await cdp.send('Input.insertText', { text: '你好' });
    await expect.poll(() => inputs(page)).toEqual(['你好']);
    await page.waitForTimeout(200);
    expect(await inputs(page)).toEqual(['你好']);
    await expectScreenContains(page, '你好');

    // 再打一次同樣的字不能被去重吃掉
    await compose('你好');
    await cdp.send('Input.insertText', { text: '你好' });
    await expect.poll(() => inputs(page)).toEqual(['你好', '你好']);
    await page.waitForTimeout(200);
    expect(await inputs(page)).toEqual(['你好', '你好']);
  });

  test('Cmd+W、Cmd+T 不進 stream，其他照送', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Meta+w');
    await page.keyboard.press('Meta+t');
    await page.keyboard.press('a');
    await expect.poll(() => inputs(page)).toEqual(['a']);
  });

  test('貼上走 terminal.input', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'pasted 文字');
      document
        .querySelector('.xterm-helper-textarea')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
    });
    await expect.poll(() => inputs(page)).toEqual(['pasted 文字']);
  });

  test('複製取得選取內容', async ({ page }) => {
    await open(page);
    await expectScreenContains(page, 'demo session e2e');
    const copied = await page.evaluate(() => {
      window.__harness.selectAll();
      const clipboardData = new DataTransfer();
      document
        .querySelector('.xterm')!
        .dispatchEvent(
          new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }),
        );
      return clipboardData.getData('text/plain');
    });
    expect(copied).toContain('demo session e2e');
  });

  test('點擊網址開新分頁，且沒有 opener', async ({ page, context }) => {
    await open(page);
    const url = new URL(`${HARNESS}?popup=1`, page.url()).href;
    await emit(page, `${url}\r\n`);
    await expectScreenContains(page, url);
    const point = await page.evaluate((text) => window.__harness.pointOf(text), url);

    const popupPromise = context.waitForEvent('page');
    // xterm 要先 hover 才會偵測到連結
    await page.mouse.move(point!.x, point!.y);
    await page.waitForTimeout(200);
    await page.mouse.click(point!.x, point!.y);
    const popup = await popupPromise;
    await popup.waitForURL(url);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
  });
});

test.describe('尺寸', () => {
  test('容器變大送出新尺寸，同尺寸不重送', async ({ page }) => {
    await open(page);
    const current = () => page.evaluate(() => window.__harness.size());
    const resizes = () => page.evaluate(() => window.__harness.resizes());

    await expectResizeSettled(page);
    const initial = await current();
    expect(initial).not.toEqual({ cols: 80, rows: 24 });

    await page.evaluate(() => {
      window.__harness.clearSent();
      window.__harness.setFrame(1000, 600);
    });
    await expect.poll(async () => (await resizes()).length).toBe(1);
    const grown = await current();
    expect(grown.cols).toBeGreaterThan(initial.cols);
    expect(grown.rows).toBeGreaterThan(initial.rows);
    expect((await resizes())[0]).toEqual(grown);

    // 只差幾個像素，算出來的 cols/rows 不變
    await page.evaluate(() => {
      window.__harness.clearSent();
      window.__harness.setFrame(1000, 601);
    });
    await page.waitForTimeout(300);
    expect(await resizes()).toEqual([]);
  });

  test('連續拖拉只送最後一次', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(300);
    await page.evaluate(async () => {
      window.__harness.clearSent();
      for (const width of [820, 860, 900, 940, 980]) {
        window.__harness.setFrame(width, 400);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    await page.waitForTimeout(400);
    const resizes = await page.evaluate(() => window.__harness.resizes());
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toEqual(await page.evaluate(() => window.__harness.size()));
  });
});

test.describe('visible', () => {
  test('看不見時不繪製也不退訂，切回後補齊', async ({ page }) => {
    await open(page);
    const before = await page.evaluate(() => window.__harness.subscribes());
    await setVisible(page, false);
    await emit(page, 'hidden-one\r\n');
    await emit(page, 'hidden-two\r\n');
    await page.waitForTimeout(100);
    expect(await lines(page)).not.toContain('hidden-one');

    await setVisible(page, true);
    await expectScreenContains(page, 'hidden-one');
    await expectScreenContains(page, 'hidden-two');
    expect(await page.evaluate(() => window.__harness.subscribes())).toBe(before);
  });

  test('一開始就看不見，切回後快照、輸出、尺寸都補上', async ({ page }) => {
    await page.goto(`${HARNESS}?visible=0`);
    await page.waitForFunction(() => window.__harness !== undefined);
    await emit(page, 'while-hidden\r\n');
    expect(await page.evaluate(() => window.__harness.resizes())).toEqual([]);

    await setVisible(page, true);
    await expectScreenContains(page, 'demo session e2e');
    await expectScreenContains(page, 'while-hidden');
    await expectResizeSettled(page);
  });
});
