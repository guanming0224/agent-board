// 用 fakeBackend 完整操作畫布與待處理清單。Lead 的 playwright.config.ts 也能跑；
// 單獨跑時用 e2e/canvas.config.ts（自己的埠，不會連到其他 worktree 的 dev server）。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const CONTENT_SCREENSHOTS = process.env.CANVAS_SHOTS;

test.use({ locale: 'zh-TW' });

let consoleProblems: string[];

test.beforeEach(async ({ page }) => {
  consoleProblems = [];
  // ResizeObserver 迴圈這類錯誤只走 window error 事件，console 看不到。
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

const card = (page: Page, id: string) => page.getByTestId(`card-${id}`);
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

async function openCanvas(page: Page) {
  await page.goto('/#/canvas');
  await expect(card(page, 's-auth')).toBeVisible();
  // 等 fitView 完成，避免量到還沒定位的畫面。
  await expect(page.getByTestId('zoom-level')).not.toHaveText('100%');
}

async function zoomLevel(page: Page) {
  return parseInt((await page.getByTestId('zoom-level').textContent()) ?? '0', 10);
}

async function zoomUntil(page: Page, atLeast: number) {
  for (let i = 0; i < 12 && (await zoomLevel(page)) < atLeast; i += 1) {
    await page.getByRole('button', { name: '放大' }).click();
  }
  expect(await zoomLevel(page)).toBeGreaterThanOrEqual(atLeast);
}

const position = (page: Page, id: string) =>
  node(page, id).evaluate((el) => (el as HTMLElement).style.transform);

/** 在 Vite 的模組實例上改 store；和 App 是同一份，才能模擬假後端演不出來的狀況。 */
async function patchStore(page: Page, patch: string) {
  await page.evaluate(
    async ({ url, patch }) => {
      const { useBoard } = await import(/* @vite-ignore */ url);
      new Function('useBoard', patch)(useBoard);
    },
    { url: STORE, patch },
  );
}

async function shot(page: Page, name: string) {
  if (CONTENT_SCREENSHOTS) {
    await page.screenshot({ path: `${CONTENT_SCREENSHOTS}/${name}.png` });
  }
}

test('摘要條內容與規格：放手線、晶片、呼號、失聯、等你的框', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await shot(page, 'overview-zh');

  const auth = card(page, 's-auth');
  // 狀態代碼（GM 2026-11-08）：卡上是符號＋英文代碼，完整說明在提示框與 aria-label。
  await expect(auth.locator('.lamp')).toHaveText('◆PERM');
  await expect(auth.locator('.lamp')).toHaveAttribute('title', 'PERM：等你允許');
  await expect(auth.getByRole('img', { name: 'PERM：等你允許' })).toBeVisible();
  await expect(auth.locator('.age')).toContainText('等了 12 分');
  await expect(auth.locator('.callsign')).toHaveText('demo-studio / project @ ab/fix-auth');
  await expect(auth.locator('.chip.mode')).toHaveText('default');
  await expect(auth.locator('.tail')).toContainText('Do you want to proceed?');
  await expect(auth.locator('.ctx')).toContainText('20%');
  await expect(auth.getByRole('button', { name: '檢視並決定' })).toBeVisible();
  await expect(auth.getByRole('textbox')).toBeVisible();

  // 狀態徽章：實心膠囊、深色字，每個代碼一個顏色（GM 2026-11-08）：PERM 洋紅。
  await expect(auth.locator('.lamp')).toHaveClass(/\bbadge\b/);
  await expect(auth.locator('.lamp')).toHaveCSS('background-color', 'rgb(255, 79, 216)');
  // 卡住和錯誤同一個代碼 ERR（紅），提示框分辨是哪一種。
  await expect(card(page, 's-ml').locator('.lamp')).toHaveText('⚠ERR');
  await expect(card(page, 's-ml').locator('.lamp')).toHaveAttribute('title', 'ERR：卡住');
  await expect(card(page, 's-ml').locator('.lamp')).toHaveCSS(
    'background-color',
    'rgb(240, 102, 95)',
  );
  // 工作中是 RUN 藍。
  await expect(card(page, 's-tests').locator('.lamp')).toHaveText('●RUN');
  await expect(card(page, 's-tests').locator('.lamp')).toHaveCSS(
    'background-color',
    'rgb(74, 163, 255)',
  );
  // 標題列是狀態帶：上緣 4px 代碼色。
  await expect(auth.locator('.strip > .head')).toHaveCSS('border-top-width', '4px');
  await expect(auth.locator('.strip > .head')).toHaveCSS('border-top-color', 'rgb(255, 79, 216)');

  // 邊框跟代碼同色（GM 2026-11-08）：算等你的 2px，其他 1px。外框經過 scale，看 computed 的邏輯值。
  await expect(auth.locator('.strip')).toHaveCSS('border-top-width', '2px');
  await expect(auth.locator('.strip')).toHaveCSS('border-top-color', 'rgb(255, 79, 216)');
  await expect(card(page, 's-tests').locator('.strip')).toHaveCSS('border-top-width', '1px');
  await expect(card(page, 's-tests').locator('.strip')).toHaveCSS(
    'border-top-color',
    'rgb(74, 163, 255)',
  );

  // 放手線
  const lineOf = (id: string) =>
    card(page, id)
      .locator('.strip')
      .evaluate((el) => {
        const s = getComputedStyle(el, '::before');
        return [s.borderLeftStyle, s.borderLeftWidth, s.borderLeftColor].join(' ');
      });
  expect(await lineOf('s-auth')).toMatch(/^dashed 3px/);
  expect(await lineOf('s-tests')).toMatch(/^solid 3px/);
  expect(await lineOf('s-etl')).toMatch(/^dotted 3px/);
  expect(await lineOf('s-ml')).toBe('solid 5px rgb(240, 102, 95)');
  await expect(card(page, 's-ml').locator('.chip.bypass')).toHaveText('略過權限');

  // 失聯：OFF 深灰虛線框、斜紋、45%、最後讀到時間、不能送指令
  const gone = card(page, 's-web').locator('.strip');
  await expect(gone.locator('.lamp')).toHaveText('⊘OFF');
  await expect(gone).toHaveCSS('border-top-style', 'dashed');
  await expect(gone).toHaveCSS('border-top-color', 'rgb(110, 118, 129)');
  await expect(gone).toHaveCSS('opacity', '0.45');
  await expect(gone).toHaveCSS('background-image', /repeating-linear-gradient/);
  await expect(gone.locator('.age')).toContainText(/最後讀到 \d\d:\d\d/);
  await expect(gone.getByRole('textbox')).toHaveCount(0);

  expect(await findGreenOutsideDone(page)).toEqual([]);
});

/**
 * 綠色只給 DONE（GM 2026-11-08 取消「整個介面沒有綠色」）：DONE 的徽章／狀態燈，以及 DONE 卡的邊框與狀態帶。
 * 掃所有元素算出來的顏色，其他地方出現綠色就列出來。
 */
const findGreenOutsideDone = (page: Page) =>
  page.evaluate(() => {
    const isGreen = (c: string) => {
      const m = c.match(/rgba?\((\d+), (\d+), (\d+)/);
      if (!m) return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return g > 90 && g > r * 1.3 && g > b * 1.3;
    };
    const doneStatus = (el: Element) =>
      el.closest('.lamp.c-done') !== null ||
      el.matches('.c-done, .c-done > .head, .c-done > header > .head');
    return [...document.querySelectorAll('.shell *')].flatMap((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor, s.borderTopColor].some(isGreen) && !doneStatus(el)
        ? [el.className || el.tagName]
        : [];
    });
  });

test('拖曳後重新載入，位置還原', async ({ page }) => {
  await openCanvas(page);
  const before = await position(page, 's-tests');
  const box = (await card(page, 's-tests').boundingBox())!;
  const fromX = box.x + box.width / 2;
  const fromY = box.y + 12;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX + 40, fromY + 30, { steps: 5 });
  await page.mouse.move(fromX + 90, fromY + 70, { steps: 5 });
  await page.mouse.up();
  const after = await position(page, 's-tests');
  expect(after).not.toBe(before);

  // debounce 之後才存，不等它就重載代表沒存到。
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('agent-board.layouts.default')))
    .toContain('s-tests');
  await page.reload();
  await expect(card(page, 's-tests')).toBeVisible();
  await expect.poll(() => position(page, 's-tests')).toBe(after);
});

test('存版面透過 backend.saveLayouts，失敗要講', async ({ page }) => {
  await openCanvas(page);
  await patchStore(
    page,
    `const b = useBoard.getState().backend;
     window.__saved = [];
     b.saveLayouts = async (l) => { window.__saved.push(l); throw new Error('hub 沒回應'); };`,
  );
  const box = (await card(page, 's-etl').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 50, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('alert')).toContainText('版面沒存到：hub 沒回應');
  const saved = (await page.evaluate(() => (window as never as { __saved: unknown[][] }).__saved))!;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toHaveLength(6);
  expect(saved[0]![0]).toMatchObject({ workspace: 'default', w: 680, h: 640 });
});

test('縮放切換兩種卡片，外框不跳動；點兩下也會切換', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  const auth = card(page, 's-auth');

  // 全部顯示一定是摘要條
  expect(await zoomLevel(page)).toBeLessThan(90);
  await expect(page.locator('[data-mode="terminal"]')).toHaveCount(0);

  // 點兩下：外框留在原地（畫布座標不變），變 xterm；鏡頭移過去讓字看得清楚，其他卡維持摘要
  const worldBefore = await position(page, 's-auth');
  await auth.locator('.tail').dblclick();
  await expect(auth).toHaveAttribute('data-mode', 'terminal');
  await expect(auth.getByTestId('terminal-slot')).toBeVisible();
  await expect(auth.locator('.strip')).toHaveCount(0);
  await expect.poll(() => zoomLevel(page)).toBeGreaterThanOrEqual(70);
  await expect(auth).toBeInViewport({ ratio: 0.9 });
  await expect(card(page, 's-tests')).toHaveAttribute('data-mode', 'summary');
  expect(await position(page, 's-auth')).toBe(worldBefore);
  await page.waitForTimeout(300); // 等鏡頭停下
  const frameExpanded = await auth.boundingBox();
  await shot(page, 'double-click-terminal');

  // 點在按鈕或輸入框上不算點兩下
  await card(page, 's-tests').getByRole('textbox').dblclick();
  await expect(card(page, 's-tests')).toHaveAttribute('data-mode', 'summary');

  // xterm 裡面沒有疊東西：插槽只放 TerminalView，把手也不在插槽範圍內
  const slot = (await auth.getByTestId('terminal-slot').boundingBox())!;
  for (const handle of await auth.locator('.react-flow__handle').all()) {
    const h = (await handle.boundingBox())!;
    const overlaps =
      h.x < slot.x + slot.width &&
      slot.x < h.x + h.width &&
      h.y < slot.y + slot.height &&
      slot.y < h.y + h.height;
    expect(overlaps).toBe(false);
  }

  // 回摘要
  await auth.getByRole('button', { name: '回摘要' }).click();
  await expect(auth).toHaveAttribute('data-mode', 'summary');
  // 同一個倍率下切換，外框在螢幕上完全不動
  expect(await auth.boundingBox()).toEqual(frameExpanded);

  // 放大到 ≥ 90%：全部變 xterm，失聯的卡維持凍結畫面
  const worldPos = await position(page, 's-auth');
  await zoomUntil(page, 90);
  await expect(auth).toHaveAttribute('data-mode', 'terminal');
  await expect(card(page, 's-tests')).toHaveAttribute('data-mode', 'terminal');
  await expect(card(page, 's-web')).toHaveAttribute('data-mode', 'summary');
  expect(await position(page, 's-auth')).toBe(worldPos);
  await shot(page, 'zoomed-terminal');

  // 畫面外的卡 visible=false：放到夠大，邊角的卡一定被推出畫面
  await zoomUntil(page, 170);
  const hidden = page.locator('[data-testid="terminal-slot"][data-visible="false"]');
  await expect.poll(() => hidden.count()).toBeGreaterThan(0);
  for (const slot of await hidden.all()) await expect(slot).not.toBeInViewport();

  // 縮回 < 90%：回到摘要條
  await page.getByRole('button', { name: '全部顯示' }).click();
  await expect(auth).toHaveAttribute('data-mode', 'summary');
  await expect(page.locator('[data-mode="terminal"]')).toHaveCount(0);
});

/** 用「從全尺寸頁回來」的路徑把畫布放在指定倍率：畫布重新掛載時直接套用，不經過按鈕的級距。
 * 畫布常駐（P2 §1），只有全尺寸終端機頁會卸載它。 */
async function openCanvasAt(page: Page, zoom: number) {
  await openCanvas(page);
  await page.evaluate(
    async ({ url, z }) => {
      const { useViewsUi } = await import(/* @vite-ignore */ url);
      useViewsUi.getState().setCanvasReturn({ x: 40, y: 40, zoom: z });
      location.hash = '#/terminal/none';
    },
    { url: '/src/views/uiStore.ts', z: zoom },
  );
  await expect(page.locator('.canvas')).toHaveCount(0);
  await page.evaluate(() => (location.hash = '#/canvas'));
  await expect(page.getByTestId('zoom-level')).toHaveText(`${Math.round(zoom * 100)}%`);
}

for (const zoom of [0.5, 0.7, 0.85]) {
  test(`畫布 ${zoom * 100}%：摘要條的字接近規格大小，外框照樣填滿`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvasAt(page, zoom);
    const auth = card(page, 's-auth');
    await expect(auth).toHaveAttribute('data-mode', 'summary');
    const measured = await auth.evaluate((frame) => {
      const strip = frame.querySelector<HTMLElement>('.strip')!;
      const tail = frame.querySelector<HTMLElement>('.tail')!;
      const box = strip.getBoundingClientRect();
      const frameBox = frame.getBoundingClientRect();
      // 螢幕上的倍率 = 畫布縮放 × 摘要條自己的 scale
      const screenScale = box.width / strip.offsetWidth;
      return {
        tailPx: parseFloat(getComputedStyle(tail).fontSize) * screenScale,
        widthGap: Math.abs(box.width - frameBox.width),
        heightGap: Math.abs(box.height - frameBox.height),
      };
    });
    // 規格是等寬 12px（STYLE.md §5）。修正前 70% 是 17.9px、85% 是 21.7px。
    expect(measured.tailPx).toBeGreaterThanOrEqual(11);
    expect(measured.tailPx).toBeLessThanOrEqual(14);
    expect(measured.widthGap).toBeLessThan(1);
    expect(measured.heightGap).toBeLessThan(1);
    await expect(auth.locator('.tail')).toContainText('Do you want to proceed?');
    await info.attach(`summary-${zoom * 100}`, {
      body: await auth.screenshot(),
      contentType: 'image/png',
    });
    await shot(page, `summary-zoom-${zoom * 100}`);
  });
}

test('下一個等我的：順序正確、框出、N 連按循環', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await expect(page.getByTestId('waiting-count')).toHaveText('3');

  const spot = () => page.locator('.frame.spot').evaluate((el) => el.getAttribute('data-testid'));
  // 故障最先，其次等最久的（12 分），再來 4 分
  await page.keyboard.press('n');
  await expect(page.locator('.frame.spot')).toHaveCount(1);
  expect(await spot()).toBe('card-s-ml');
  await expect(page.getByTestId('next-announce')).toContainText('Train model');

  await page.keyboard.press('n');
  await expect.poll(spot).toBe('card-s-auth');
  await page.getByTestId('next-up').click();
  await expect.poll(spot).toBe('card-s-etl');
  await shot(page, 'next-up-focus');
  await expect(card(page, 's-etl')).toBeInViewport({ ratio: 0.9 });

  // 循環
  await page.keyboard.press('n');
  await expect.poll(spot).toBe('card-s-ml');
  await expect(card(page, 's-ml')).toBeInViewport({ ratio: 0.9 });

  // 在輸入框打字時 N 不能被搶走
  const input = card(page, 's-tests').getByRole('textbox');
  await input.focus();
  await page.keyboard.type('nnn');
  await expect(input).toHaveValue('nnn');
  expect(await spot()).toBe('card-s-ml');
});

test('context 百分比用 daemon 回報的模型上限；不知道上限時只寫 token 數', async ({ page }) => {
  await openCanvas(page);
  const ctx = card(page, 's-auth').getByTestId('context-usage');
  await expect(ctx).toContainText('20%');
  await expect(ctx).toHaveAttribute('title', /20萬/);
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({ sessions: s.sessions.map((x) => x.id === 's-auth' ? { ...x, contextTokens: 300000, contextWindow: 1000000 } : x) });`,
  );
  // 1M 上限：300k 是 30%，不是用 200k 硬算的 150%。
  await expect(ctx).toContainText('30%');
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({ sessions: s.sessions.map((x) => x.id === 's-auth' ? { ...x, contextWindow: null } : x) });`,
  );
  await expect(ctx).not.toContainText('%');
  await expect(ctx).toContainText('30萬');
  await expect(ctx).toHaveAttribute('title', /還不知道/);
});

test('因帳號限流排隊的卡片寫明在等額度', async ({ page }) => {
  await openCanvas(page);
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({ sessions: s.sessions.map((x) => x.id === 's-auth' ? { ...x, status: 'queued', statusDetail: 'queue:rate_limited' } : x), approvals: [] });`,
  );
  await expect(card(page, 's-auth').locator('.age')).toContainText('等帳號額度恢復');
});

test('沒有等你的：主角換成文字，按鈕停用', async ({ page }) => {
  await openCanvas(page);
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({ sessions: s.sessions.map((x) => ({ ...x, status: 'running', permissionMode: 'default' })), approvals: [] });`,
  );
  await expect(page.getByTestId('waiting-none')).toHaveText('沒有等你的');
  await expect(page.getByTestId('waiting-count')).toHaveCount(0);
  await expect(page.getByTestId('next-up')).toBeDisabled();
  await shot(page, 'all-running-quiet');
  // 靜止時要安靜：沒有任何「等你」的粗框與光圈
  await expect(page.locator('.strip.waits')).toHaveCount(0);
  await expect(page.locator('.frame[data-waits]')).toHaveCount(0);
});

test('送指令：呼叫 sendPrompt、清空輸入、狀態跟著變', async ({ page }) => {
  await openCanvas(page);
  await patchStore(
    page,
    `const b = useBoard.getState().backend;
     const orig = b.sendPrompt;
     window.__sent = [];
     b.sendPrompt = (id, text) => { window.__sent.push([id, text]); orig(id, text); };`,
  );
  // 等你允許的卡不能送（下一個測試），所以先讓它停在等你回覆。
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({
       sessions: s.sessions.map((x) => (x.id === 's-auth' ? { ...x, status: 'waiting_input' } : x)),
       approvals: s.approvals.filter((a) => a.sessionId !== 's-auth'),
     });`,
  );
  const input = card(page, 's-auth').getByRole('textbox');

  await input.fill('   ');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as never as { __sent: unknown[] }).__sent)).toEqual([]);

  await input.fill('run the tests');
  await input.press('Enter');
  expect(await page.evaluate(() => (window as never as { __sent: unknown[] }).__sent)).toEqual([
    ['s-auth', 'run the tests'],
  ]);
  await expect(input).toHaveValue('');
  await expect(card(page, 's-auth').getByRole('status')).toHaveText('已送出');
  await expect(card(page, 's-auth').locator('.lamp')).toHaveText('●RUN');
  await expect(card(page, 's-auth').locator('.lamp')).toHaveAttribute('title', 'RUN：工作中');
});

test('原生對話框在等決定時，摘要卡輸入框不送字，改指向核准按鈕', async ({ page }) => {
  await openCanvas(page);
  await patchStore(
    page,
    `const b = useBoard.getState().backend;
     window.__sent = [];
     b.sendPrompt = (id, text) => { window.__sent.push([id, text]); };`,
  );
  const sent = () => page.evaluate(() => (window as never as { __sent: unknown[] }).__sent);

  // 等你允許：輸入框停用，說明要按「檢視並決定」或放大進終端機；按鈕就在旁邊
  const auth = card(page, 's-auth');
  const input = auth.getByRole('textbox');
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('placeholder', '先處理上方的決定');
  await expect(auth.locator('.cmd-hint')).toContainText('這裡打的字會被當成選項');
  await expect(auth.locator('.cmd-hint')).toContainText('檢視並決定');
  await expect(auth.getByRole('button', { name: '檢視並決定' })).toBeVisible();
  await input.click({ force: true });
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  expect(await sent()).toEqual([]);
  await shot(page, 'blocked-input');

  // 審計畫：指向「審核計畫」
  const etl = card(page, 's-etl');
  await expect(etl.getByRole('textbox')).toBeDisabled();
  await expect(etl.locator('.cmd-hint')).toContainText('審核計畫');

  // 提問也是 waiting_permission，指向作答
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({ approvals: s.approvals.map((a) => (a.sessionId === 's-auth' ? { ...a, kind: 'question' } : a)) });`,
  );
  await expect(auth.locator('.cmd-hint')).toContainText('回答提問');

  // 打到一半對話框才跳出來：字留著，不送；處理完再送
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({
       sessions: s.sessions.map((x) => (x.id === 's-auth' ? { ...x, status: 'waiting_input' } : x)),
       approvals: s.approvals.filter((a) => a.sessionId !== 's-auth'),
     });`,
  );
  await expect(input).toBeEnabled();
  await expect(auth.locator('.cmd-hint')).toHaveCount(0);
  await input.fill('1');
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({ sessions: s.sessions.map((x) => (x.id === 's-auth' ? { ...x, status: 'waiting_permission' } : x)) });`,
  );
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('1');
  expect(await sent()).toEqual([]);
});

test('團隊框隨成員移動；交接線可拖曳建立、可刪除', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  const team = page.locator('.team');
  await expect(team).toContainText('團隊・登入重構');
  await expect(page.getByTestId('handoff-s-auth-s-tests')).toHaveText('完成時交接');

  const teamBefore = (await team.boundingBox())!;
  const box = (await card(page, 's-auth').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + 60, { steps: 8 });
  await page.mouse.up();
  const teamAfter = (await team.boundingBox())!;
  expect(teamAfter.x).toBeLessThan(teamBefore.x - 40);

  // 從 s-tests 拖線到 s-etl
  const from = (await card(page, 's-tests').locator('.source').boundingBox())!;
  const to = (await card(page, 's-etl').locator('.target').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x - 20, to.y, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('handoff-s-tests-s-etl')).toHaveText('完成時交接');
  await shot(page, 'handoff-created');

  // 選取後 Delete 可刪除，而且不會把卡片刪掉
  await page.locator('.react-flow__edge[data-id="s-tests->s-etl"]').click({ force: true });
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('handoff-s-tests-s-etl')).toHaveCount(0);
  await expect(card(page, 's-etl')).toBeVisible();
});

test('側欄：機器與用量、失聯列、圖例；收合時退訂', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/queue');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await patchStore(
    page,
    `const b = useBoard.getState().backend;
     const orig = b.watchResources;
     window.__watch = { on: 0, off: 0 };
     b.watchResources = (l) => {
       window.__watch.on += 1;
       const stop = orig(l);
       return () => { window.__watch.off += 1; stop(); };
     };
     useBoard.setState({ backend: { ...b } });`,
  );
  const watch = () =>
    page.evaluate(() => (window as never as { __watch: { on: number; off: number } }).__watch);

  await expect.poll(async () => (await watch()).on).toBeGreaterThan(0);
  const sidebar = page.getByTestId('sidebar');
  await expect(page.getByTestId('rig-m-gpu').getByRole('meter')).toHaveCount(3);
  await expect(page.getByTestId('rig-m-studio').getByRole('meter')).toHaveCount(2);
  await expect(page.getByTestId('rig-m-laptop')).toContainText(/失聯・最後讀到 \d\d:\d\d/);
  await expect(page.getByTestId('rig-m-laptop').getByRole('meter')).toHaveCount(0);
  // GPU 64% ≥ 60% 用琥珀
  await expect(page.getByRole('meter', { name: 'demo-gpu GPU' })).toHaveClass(/\bw\b/);
  // 圖例：10 個狀態代碼（GM 2026-11-08），徽章是代碼、旁邊是中文說明，分三組，右邊是目前幾個。
  await expect(sidebar.locator('.legend-group h4')).toHaveText(['需要你', '進行中', '其他']);
  await expect(sidebar.locator('.legend-codes .lamp.badge .code')).toHaveText([
    'PERM',
    'ASK',
    'PLAN',
    'ERR',
    'NEW',
    'RUN',
    'QUE',
    'QUOTA',
    'DONE',
    'OFF',
  ]);
  await expect(sidebar.locator('.g-needsYou .lamp.badge')).toHaveCount(4);
  await expect(page.getByTestId('legend-PERM')).toHaveText('◆PERM等你允許（最急）1');
  await expect(page.getByTestId('legend-ERR')).toContainText('錯誤或卡住');
  // 假資料有一個卡住的 session：ERR 算 1；錯誤和卡住同一個代碼。
  await expect(page.getByTestId('legend-ERR').locator('.legend-n')).toHaveText('1');
  await expect(page.getByTestId('legend-ASK').locator('.legend-n')).toHaveCount(0);
  // 每個代碼的顏色都不一樣，而且是 GM 指定的色值。
  const colors = await sidebar
    .locator('.legend-codes .lamp.badge')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(colors).toEqual([
    'rgb(255, 79, 216)',
    'rgb(255, 225, 77)',
    'rgb(61, 213, 224)',
    'rgb(240, 102, 95)',
    'rgb(154, 164, 178)',
    'rgb(74, 163, 255)',
    'rgb(212, 163, 115)',
    'rgb(155, 107, 255)',
    'rgb(70, 194, 106)',
    'rgb(110, 118, 129)',
  ]);
  expect(new Set(colors).size).toBe(10);
  await expect(sidebar.locator('.hands-sample')).toHaveCount(5);

  await page.getByTestId('side-toggle').click();
  await expect(sidebar).toHaveCount(0);
  const collapsed = await watch();
  expect(collapsed.off).toBe(collapsed.on);

  await page.getByTestId('side-toggle').click();
  await expect(sidebar).toBeVisible();
  const reopened = await watch();
  // 開發模式 StrictMode 會多訂閱再退訂一次，所以看「目前還活著的訂閱數」。
  expect(reopened.on).toBeGreaterThan(collapsed.on);
  expect(reopened.on - reopened.off).toBe(1);
});

test('收件匣（舊網址 #/queue）：依組別排序、危險指令置頂、「在畫布上看」跳到該卡且抽屜不關', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/queue');
  await expect(page).toHaveURL(/#\/inbox$/);
  const ids = () =>
    page.locator('.triage-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  // 要你決定（等最久的在前）→ 錯誤、卡住（詳細的分組測試在 flows-triage.spec.ts）。額度用完不算等你，不列。
  await expect.poll(ids).toEqual(['queue-s-auth', 'queue-s-etl', 'queue-s-ml']);
  await expect(page.getByTestId('queue-s-auth')).toContainText('npm test -- auth');
  await expect(page.getByTestId('queue-s-auth')).toContainText(
    'demo-studio / project @ ab/fix-auth',
  );

  // 命中危險指令：即使 session 還是 running（hook 卡在 PreToolUse）也要置頂
  await patchStore(
    page,
    `const s = useBoard.getState();
     useBoard.setState({
       approvals: [...s.approvals, {
         id: 'a-danger', sessionId: 's-tests', kind: 'danger', toolName: 'Bash',
         toolInput: { command: 'git push --force origin main' }, suggestions: [],
         matchedRule: 'git push --force', message: null, createdAt: new Date().toISOString(),
       }],
     });`,
  );
  await expect.poll(ids).toEqual(['queue-s-tests', 'queue-s-auth', 'queue-s-etl', 'queue-s-ml']);
  await expect(page.getByTestId('queue-s-tests')).toContainText('命中危險指令清單');
  await expect(page.getByTestId('waiting-count')).toHaveText('4');
  await shot(page, 'queue-danger');

  await page.getByTestId('inbox-show-s-etl').click();
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.getByTestId('inbox-drawer')).toBeVisible();
  await expect(page.locator('.frame.spot')).toHaveAttribute('data-testid', 'card-s-etl');
  await expect(card(page, 's-etl')).toBeInViewport({ ratio: 0.9 });
  // 卡片不被抽屜蓋住：放在抽屜左邊看得到的那一塊
  const drawer = (await page.getByTestId('inbox-drawer').boundingBox())!;
  // 鏡頭有 200ms 的移動動畫，等它停下來再量。
  await expect
    .poll(async () => {
      const box = (await card(page, 's-etl').boundingBox())!;
      return box.x + box.width <= drawer.x + 1;
    })
    .toBe(true);
  // 下一個從剛才點的那列接著走，危險指令的 s-tests 在循環的第一個
  await page.keyboard.press('n');
  await expect(page.locator('.frame.spot')).toHaveAttribute('data-testid', 'card-s-tests');
  await expect(card(page, 's-tests')).toContainText('⛔ 命中危險指令');
  // 收件匣裡同一項跟著標出
  await expect(page.getByTestId('queue-s-tests')).toHaveClass(/focused/);
});

test('中英文切換：固定用詞，英文不撐爆版面', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  await expect(page.getByTestId('next-up')).toContainText('下一個等我的');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');

  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByTestId('next-up')).toContainText('Next up');
  await expect(page.locator('.waiting')).toContainText('Waiting on you');
  await expect(card(page, 's-auth').locator('.lamp')).toHaveText('◆PERM');
  await expect(card(page, 's-auth').locator('.lamp')).toHaveAttribute(
    'title',
    'PERM: Needs approval',
  );
  await expect(card(page, 's-auth').locator('.age')).toContainText('waited 12m');
  await expect(card(page, 's-ml').locator('.chip.bypass')).toHaveText('Bypass permissions');
  await expect(page.getByTestId('rig-m-laptop')).toContainText('Offline');
  await expect(page.getByTestId('inbox-button')).toContainText('Inbox');
  await expect(page.getByTestId('settings-button')).toHaveAttribute('aria-label', 'Settings');
  await shot(page, 'overview-en');

  // 每張條的內容都收在條內：指令框與按鈕不被裁掉
  for (const id of ['s-auth', 's-ml', 's-etl']) {
    const strip = (await card(page, id).locator('.strip').boundingBox())!;
    const bottom = await card(page, id)
      .locator('.strip > :last-child')
      .evaluate((el) => el.getBoundingClientRect().bottom);
    expect(bottom).toBeLessThanOrEqual(strip.y + strip.height + 0.5);
  }

  await page.getByRole('button', { name: '中', exact: true }).click();
  await expect(page.getByTestId('next-up')).toContainText('下一個等我的');
});

for (const width of [320, 375]) {
  // 手機的 #/queue 會轉成全螢幕收件匣（flows.spec 的手機收件匣測過），這裡只看畫布。
  for (const route of ['canvas']) {
    test(`${width}px ${route} 沒有整頁水平捲軸`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/#/${route}`);
      await expect(page.getByTestId('next-up')).toBeVisible();
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0);
      // 窄螢幕預設收合
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
      const noOverflow = () =>
        page.evaluate(() => {
          const el = document.documentElement;
          return el.scrollWidth <= el.clientWidth && document.body.scrollWidth <= el.clientWidth;
        });
      expect(await noOverflow()).toBe(true);
      await shot(page, `narrow-${width}-${route}`);

      await page.getByTestId('side-toggle').click();
      await expect(page.getByTestId('sidebar')).toBeVisible();
      expect(await noOverflow()).toBe(true);
      await shot(page, `narrow-${width}-${route}-side`);
    });
  }
}

test.describe('四種狀態', () => {
  test('載入中', async ({ page }) => {
    // 畫布常駐：先到全尺寸終端機頁（唯一會卸載畫布的地方）再回來。
    await page.goto('/#/terminal/none');
    await patchStore(page, `useBoard.getState().backend.getLayouts = () => new Promise(() => {});`);
    await page.evaluate(() => (location.hash = '#/canvas'));
    await expect(page.locator('[data-state="loading"]')).toBeVisible();
    await expect(page.locator('.react-flow')).toHaveCount(0);
  });

  test('空的：畫布與待處理都寫下一步', async ({ page }) => {
    await openCanvas(page);
    await patchStore(page, `useBoard.setState({ sessions: [], approvals: [] });`);
    await expect(page.locator('[data-state="empty"]')).toContainText('在畫布空白處雙擊');
    await expect(page.locator('[data-state="empty"]')).toContainText('按「新增 session」開始');
    await shot(page, 'empty');
    // 空畫布的按鈕直接在畫布上打開快速建立，不換頁。
    await page.locator('[data-state="empty"]').getByRole('button').click();
    await expect(page.getByTestId('quick-create')).toBeVisible();
    await expect(page).toHaveURL(/#\/canvas/);
    await expect(page.locator('[data-state="empty"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-create')).toHaveCount(0);

    await page.evaluate(() => (location.hash = '#/queue'));
    await expect(page.getByTestId('inbox-drawer').locator('[data-state="empty"]')).toContainText(
      '沒有等你的',
    );
  });

  test('錯誤：寫發生什麼與怎麼辦，重試成功後回到畫布', async ({ page }) => {
    await page.goto('/#/terminal/none');
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       window.__orig = b.getLayouts;
       b.getLayouts = () => Promise.reject(new Error('hub 回 500'));`,
    );
    await page.evaluate(() => (location.hash = '#/canvas'));
    const state = page.locator('[data-state="error"]');
    await expect(state).toContainText('讀不到畫布版面：hub 回 500');
    await shot(page, 'error');

    await patchStore(page, `useBoard.getState().backend.getLayouts = window.__orig;`);
    await state.getByRole('button', { name: '再試一次' }).click();
    await expect(card(page, 's-auth')).toBeVisible();
  });

  test('待處理的錯誤畫面', async ({ page }) => {
    await page.goto('/#/canvas');
    await expect(card(page, 's-auth')).toBeVisible();
    await patchStore(
      page,
      `useBoard.getState().backend.watchBoard = () => { throw new Error('連線被拒'); };`,
    );
    await page.evaluate(() => (location.hash = '#/queue'));
    await expect(page.locator('[data-state="error"]')).toContainText(
      '讀不到 session 清單：連線被拒',
    );
  });

  test('資料過期：整頁淡化、一行字、不能送指令、內容還在', async ({ page }) => {
    await openCanvas(page);
    await patchStore(page, `useBoard.setState({ connected: false });`);
    await expect(page.locator('[data-state="stale"]')).toContainText('連不到 hub');
    await expect(page.locator('.board')).toHaveCSS('opacity', '0.55');
    await expect(card(page, 's-tests').getByRole('textbox')).toBeDisabled();
    await expect(card(page, 's-auth').locator('.tail')).toContainText('Do you want to proceed?');
    await shot(page, 'stale');

    await patchStore(page, `useBoard.setState({ connected: true });`);
    await expect(page.locator('[data-state="stale"]')).toHaveCount(0);
    await expect(card(page, 's-tests').getByRole('textbox')).toBeEnabled();
  });
});

test.describe('在畫布上直接新增', () => {
  /** 縮小後畫布左緣一定是空白處。 */
  async function blankSpot(page: Page) {
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: '縮小' }).click();
    const box = await page.locator('.react-flow__pane').boundingBox();
    if (!box) throw new Error('no pane');
    return { x: box.x + 40, y: box.y + box.height / 2 };
  }

  test('雙擊空白處：建新資料夾、新專案，卡片出現在雙擊的位置', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const spot = await blankSpot(page);
    const before = await page.locator('.react-flow__node').count();

    await page.mouse.dblclick(spot.x, spot.y);
    const quick = page.getByTestId('quick-create');
    await expect(quick).toBeVisible();
    const qbox = await quick.boundingBox();
    expect(Math.abs((qbox?.x ?? 0) - spot.x)).toBeLessThan(4);
    // 預設權限模式看得見。
    await expect(quick.locator('.quick-head .chip')).toHaveText('default');

    // 沒填就建：說缺什麼。
    await quick.getByRole('button', { name: '建立 session' }).click();
    await expect(quick).toContainText('要填名稱');

    // 瀏覽 → 新資料夾 → 自動選用，名稱跟著資料夾。
    await quick.getByRole('button', { name: '瀏覽' }).click();
    await quick.getByTestId('new-folder').click();
    await quick.getByRole('textbox', { name: '新資料夾名稱' }).fill('ledger');
    await quick.getByRole('button', { name: '建立並選用' }).click();
    await expect(quick.locator('#qc-cwd')).toHaveValue(/\/ledger$/);
    await expect(quick.locator('#qc-name')).toHaveValue('ledger');
    await expect(quick.getByTestId('folder-browser')).toHaveCount(0);

    // 同名資料夾：白話說明，不覆蓋。
    await quick.getByRole('button', { name: '瀏覽' }).click();
    await quick.getByTestId('new-folder').click();
    await quick.getByRole('textbox', { name: '新資料夾名稱' }).fill('notes');
    await quick.getByRole('button', { name: '建立並選用' }).click();
    await expect(quick).toContainText('這裡已經有同名的資料夾');
    await quick.getByRole('button', { name: '關閉' }).first().click();

    // 專案：在選單裡直接新增。
    await quick.locator('#qc-project').selectOption({ label: '＋ 新增專案…' });
    await quick.getByRole('textbox', { name: '專案名稱' }).fill('記帳');
    await quick.getByRole('button', { name: '建立專案' }).click();
    await expect(quick.locator('#qc-project option:checked')).toHaveText('記帳');

    await quick.locator('#qc-first').fill('建立專案骨架');
    await quick.getByRole('button', { name: '建立 session' }).click();
    await expect(quick).toHaveCount(0);

    await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
    const created = page.locator('.react-flow__node', { hasText: 'ledger' });
    await expect(created).toBeVisible();
    await expect(created.locator('.callsign')).toContainText('/ 記帳');
    const nbox = await created.boundingBox();
    expect(Math.abs((nbox?.x ?? 0) - spot.x)).toBeLessThan(4);
    expect(Math.abs((nbox?.y ?? 0) - spot.y)).toBeLessThan(4);
  });

  test('hub 先回應、廣播晚到：卡片仍放在雙擊的位置', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    // 模擬真 hub：回應先到，session.created 的廣播 300ms 後才到。
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       const orig = b.createSession.bind(b);
       b.createSession = async (input) => {
         const before = useBoard.getState().sessions;
         const created = await orig(input);
         const after = useBoard.getState().sessions;
         useBoard.setState({ sessions: before });
         setTimeout(() => useBoard.setState({ sessions: after }), 300);
         return created;
       };`,
    );
    const spot = await blankSpot(page);
    await page.mouse.dblclick(spot.x, spot.y);
    const quick = page.getByTestId('quick-create');
    await quick.locator('#qc-name').fill('late');
    await quick.locator('#qc-cwd').fill('/tmp/late');
    await quick.getByRole('button', { name: '建立 session' }).click();
    await expect(quick).toHaveCount(0);
    const created = page.locator('.react-flow__node', { hasText: 'late' });
    await expect(created).toBeVisible();
    const nbox = await created.boundingBox();
    expect(Math.abs((nbox?.x ?? 0) - spot.x)).toBeLessThan(4);
    expect(Math.abs((nbox?.y ?? 0) - spot.y)).toBeLessThan(4);
  });

  test('雙擊卡片不會開快速建立；點空白或 Esc 關掉；指令列按鈕在畫布上原地打開', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await card(page, 's-auth').locator('.callsign').dblclick();
    await expect(page.getByTestId('quick-create')).toHaveCount(0);

    const spot = await blankSpot(page);
    await page.mouse.dblclick(spot.x, spot.y);
    await expect(page.getByTestId('quick-create')).toBeVisible();
    await page.mouse.click(spot.x, spot.y - 150);
    await expect(page.getByTestId('quick-create')).toHaveCount(0);

    // 桌面的「新增 session」在畫布底部指令列（P2 §3.3），頁首不再有。
    await expect(
      page.getByRole('banner').getByRole('button', { name: '新增 session' }),
    ).toBeHidden();
    await page.getByTestId('command-new').click();
    await expect(page.getByTestId('quick-create')).toBeVisible();
    await expect(page).toHaveURL(/#\/canvas/);
    await page.getByTestId('quick-create').getByRole('link', { name: '完整表單' }).click();
    await expect(page).toHaveURL(/#\/new/);
    await expect(page.getByTestId('modal')).toBeVisible();
    // 收件匣開著時畫布仍在底下：指令列按鈕照樣在畫布上原地打開。
    await page.evaluate(() => (location.hash = '#/inbox'));
    await page.getByTestId('command-new').click();
    await expect(page.getByTestId('quick-create')).toBeVisible();
    await expect(page).toHaveURL(/#\/inbox$/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-create')).toHaveCount(0);
    // Esc 只關最上層：快速建立關掉了，收件匣還在。
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    // 全尺寸終端機頁沒有畫布與指令列：頁首保留按鈕，去完整表單。
    await page.evaluate(() => (location.hash = '#/terminal/s-auth'));
    await page.getByRole('banner').getByRole('button', { name: '新增 session' }).click();
    await expect(page).toHaveURL(/#\/new/);
  });

  test('手機寬度：小卡固定在下方、不超出畫面', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/canvas');
    await expect(card(page, 's-auth')).toBeVisible();
    await page.getByRole('banner').getByRole('button', { name: '新增 session' }).click();
    const box = await page.getByTestId('quick-create').boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
  });
});

test('手機寬度：快速建立的資料夾選擇器可用、不超出畫面', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/canvas');
  await expect(card(page, 's-auth')).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: '新增 session' }).click();
  const quick = page.getByTestId('quick-create');
  await quick.getByRole('button', { name: '瀏覽' }).click();
  const browser = quick.getByTestId('folder-browser');
  // 最近用過：demo-studio 上的 session 資料夾
  await expect(browser.getByTestId('recent-folder').first()).toBeVisible();
  // 單擊選取：直接填入，名稱跟著資料夾，瀏覽器留著
  await browser.getByRole('button', { name: 'notes', exact: true }).click();
  await expect(quick.locator('#qc-cwd')).toHaveValue(/notes$/);
  await expect(quick.locator('#qc-name')).toHaveValue('notes');
  await expect(browser).toBeVisible();
  for (const target of [quick, browser]) {
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const overflow = await browser.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Esc 只關掉瀏覽器，不關快速建立
  await browser.getByRole('searchbox').focus();
  await page.keyboard.press('Escape');
  await expect(browser).toHaveCount(0);
  await expect(quick).toBeVisible();
});

test.describe('封存', () => {
  const menu = (page: Page, id: string) =>
    card(page, id).getByRole('button', { name: /的更多動作$/ });

  test('「⋯」選單：原地改名；已失聯的直接封存，10 秒內可復原', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);

    await menu(page, 's-etl').click();
    await card(page, 's-etl').getByRole('menuitem', { name: '重新命名' }).click();
    const input = card(page, 's-etl').getByRole('textbox', { name: '新名稱' });
    await expect(input).toBeFocused();
    await input.fill('Migrate data v2');
    await input.press('Enter');
    await expect(card(page, 's-etl').locator('.title')).toHaveText('Migrate data v2');
    // Esc 取消，不改名
    await menu(page, 's-etl').click();
    await card(page, 's-etl').getByRole('menuitem', { name: '重新命名' }).click();
    await card(page, 's-etl').getByRole('textbox', { name: '新名稱' }).fill('nope');
    await page.keyboard.press('Escape');
    await expect(card(page, 's-etl').locator('.title')).toHaveText('Migrate data v2');

    // 失聯的不用確認
    await menu(page, 's-web').click();
    await card(page, 's-web').getByRole('menuitem', { name: '封存' }).click();
    await expect(page.getByTestId('archive-confirm')).toHaveCount(0);
    await expect(card(page, 's-web')).toHaveCount(0);
    const toast = page.getByTestId('archive-toast');
    await expect(toast).toContainText('已封存 Nav tweaks');
    await toast.getByRole('button', { name: '復原' }).click();
    await expect(card(page, 's-web')).toBeVisible();
    await expect(toast).toHaveCount(0);
  });

  test('復原時 session 已在刪除：寫原因', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       const update = b.updateSession;
       b.updateSession = async (id, patch) => {
         if (patch.archived === false) throw Object.assign(new Error('x'), { code: 'session_deleting' });
         return update(id, patch);
       };`,
    );
    await menu(page, 's-web').click();
    await card(page, 's-web').getByRole('menuitem', { name: '封存' }).click();
    const toast = page.getByTestId('archive-toast');
    await toast.getByRole('button', { name: '復原' }).click();
    await expect(toast.getByRole('alert')).toContainText(
      '沒復原：這個 session 正在刪除，稍後再試。',
    );
    await expect(card(page, 's-web')).toHaveCount(0);
  });

  test('復原提示 10 秒後消失', async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await menu(page, 's-web').click();
    await card(page, 's-web').getByRole('menuitem', { name: '封存' }).click();
    await expect(page.getByTestId('archive-toast')).toBeVisible();
    await page.clock.runFor(9_000);
    await expect(page.getByTestId('archive-toast')).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(page.getByTestId('archive-toast')).toHaveCount(0);
  });

  test('還在跑的先確認「會停止」，列出會暫停的交接規則；排隊中寫取消排隊', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await expect(page.getByTestId('handoff-s-auth-s-tests')).toBeVisible();

    await menu(page, 's-tests').click();
    await card(page, 's-tests').getByRole('menuitem', { name: '封存' }).click();
    const dialog = page.getByTestId('archive-confirm');
    await expect(dialog.getByRole('heading')).toHaveText('封存「Write tests」？');
    await expect(dialog).toContainText('還在進行，會停止它');
    await expect(dialog).toContainText('會暫停 1 條交接規則');
    // 取消：什麼都沒做
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 's-tests')).toBeVisible();

    await menu(page, 's-tests').click();
    await card(page, 's-tests').getByRole('menuitem', { name: '封存' }).click();
    await page.getByTestId('archive-confirm').getByRole('button', { name: '停止並封存' }).click();
    await expect(card(page, 's-tests')).toHaveCount(0);
    await expect(page.getByTestId('archive-toast')).toContainText('暫停了 1 條交接規則');

    await patchStore(page, `useBoard.getState().backend.setSessionStatus('s-docs', 'queued');`);
    await menu(page, 's-docs').click();
    await card(page, 's-docs').getByRole('menuitem', { name: '封存' }).click();
    await expect(page.getByTestId('archive-confirm')).toContainText('還在排隊，會取消排隊');
  });

  test('選取卡片後按 Delete 開封存確認，不是刪除；打字時的 Backspace 不算', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    // 在指令框打字按 Backspace：不開確認
    const input = card(page, 's-tests').getByRole('textbox');
    await input.fill('ab');
    await input.press('Backspace');
    await expect(input).toHaveValue('a');
    await expect(page.getByTestId('archive-confirm')).toHaveCount(0);

    await card(page, 's-docs').locator('.tail').click();
    await expect(node(page, 's-docs')).toHaveClass(/selected/);
    await page.keyboard.press('Delete');
    const dialog = page.getByTestId('archive-confirm');
    await expect(dialog).toContainText('Tidy docs');
    // Esc 關掉，卡片還在
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(card(page, 's-docs')).toBeVisible();

    await card(page, 's-docs').locator('.tail').click();
    await page.keyboard.press('Backspace');
    await page.getByTestId('archive-confirm').getByRole('button', { name: '停止並封存' }).click();
    await expect(card(page, 's-docs')).toHaveCount(0);
  });

  test('Shift＋拖曳框選多張，一起封存，一起復原', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const a = (await card(page, 's-docs').boundingBox())!;
    const b = (await card(page, 's-ml').boundingBox())!;
    const left = Math.min(a.x, b.x) - 12;
    const top = Math.min(a.y, b.y) - 12;
    const right = Math.max(a.x + a.width, b.x + b.width) + 12;
    const bottom = Math.max(a.y + a.height, b.y + b.height) + 12;
    await page.keyboard.down('Shift');
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, bottom, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    const button = page.getByTestId('archive-selection').getByRole('button');
    await expect(button).toHaveText('封存選取的 2 個');
    await button.click();
    const dialog = page.getByTestId('archive-confirm');
    await expect(dialog.getByRole('heading')).toHaveText('封存 2 個 session？');
    await dialog.getByRole('button', { name: '停止並封存' }).click();
    await expect(card(page, 's-docs')).toHaveCount(0);
    await expect(card(page, 's-ml')).toHaveCount(0);
    const toast = page.getByTestId('archive-toast');
    await expect(toast).toContainText('已封存 2 個 session');
    await toast.getByRole('button', { name: '復原' }).click();
    await expect(card(page, 's-docs')).toBeVisible();
    await expect(card(page, 's-ml')).toBeVisible();
  });
});

test.describe('接續', () => {
  /** 讓 s-tests 變成「已結束、有對話 id」，並記下 resumeSession 的呼叫。 */
  async function endTests(page: Page, status: 'done' | 'error') {
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       window.__resumed = [];
       b.resumeSession = async (id) => { window.__resumed.push(id); return useBoard.getState().sessions.find((s) => s.id === id); };
       useBoard.setState((st) => ({ sessions: st.sessions.map((s) => s.id === 's-tests'
         ? { ...s, status: '${status}', endedAt: new Date().toISOString() } : s) }));`,
    );
  }
  const resumed = (page: Page) =>
    page.evaluate(() => (window as unknown as { __resumed: string[] }).__resumed);

  test('已結束的卡片：「⋯」選單有接續；還在跑的沒有', async ({ page }) => {
    await openCanvas(page);
    const menu = card(page, 's-auth').getByRole('button', { name: /的更多動作$/ });
    await menu.click();
    await expect(card(page, 's-auth').getByRole('menuitem', { name: '接續' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await endTests(page, 'error');
    await card(page, 's-tests')
      .getByRole('button', { name: /的更多動作$/ })
      .click();
    const item = card(page, 's-tests').getByRole('menuitem', { name: '接續' });
    await expect(item).toHaveAttribute('title', /claude --resume/);
    await item.click();
    await expect.poll(() => resumed(page)).toEqual(['s-tests']);
    await expect(card(page, 's-tests').getByRole('menu')).toHaveCount(0);
  });

  test('接續失敗時選單留著並寫原因', async ({ page }) => {
    await openCanvas(page);
    await endTests(page, 'error');
    await patchStore(
      page,
      `useBoard.getState().backend.resumeSession = async () => {
         throw Object.assign(new Error('x'), { status: 409, code: 'machine_offline' });
       };`,
    );
    await card(page, 's-tests')
      .getByRole('button', { name: /的更多動作$/ })
      .click();
    await card(page, 's-tests').getByRole('menuitem', { name: '接續' }).click();
    await expect(card(page, 's-tests').getByRole('menu')).toContainText('離線，上線後才能接續');
  });

  test('完成提示：已結束的有「接續」', async ({ page }) => {
    await openCanvas(page);
    await endTests(page, 'done');
    const hint = page.getByTestId('done-hint-s-tests');
    await expect(hint).toContainText('session 已經結束');
    await hint.getByRole('button', { name: '接續' }).click();
    await expect.poll(() => resumed(page)).toEqual(['s-tests']);
  });
});

test.describe('交接動畫：看得到誰在跟誰說話', () => {
  const SECRET = 'sk-ant-demo0123456789abcdefXYZ';
  const emit = (page: Page, from: string, to: string, options: object = {}) =>
    patchStore(
      page,
      `useBoard.getState().backend.emitHandoff(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(options)});`,
    );
  const label = (page: Page, from: string, to: string) =>
    page.getByTestId(`handoff-label-${from}-${to}`);
  const anim = (page: Page, from: string, to: string) =>
    page.getByTestId(`handoff-anim-${from}-${to}`);

  test('送達：線往目標流、目標卡有光圈，播完留「已送達」與說明', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // 遮蔽模式開著：摘要裡的金鑰不能出現在說明裡。
    await page.addInitScript(() => localStorage.setItem('agent-board.mask-mode', '1'));
    await openCanvas(page);
    await expect(label(page, 's-auth', 's-tests')).not.toHaveAttribute('data-phase');

    await emit(page, 's-auth', 's-tests', { summary: `Fixed the redirect.\nexport KEY=${SECRET}` });
    await expect(anim(page, 's-auth', 's-tests')).toHaveClass('edge-talk-flow');
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-phase', 'active');
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-talk', 'delivered');
    await expect(label(page, 's-auth', 's-tests')).toContainText(/已送達 \d\d:\d\d/);
    await expect(card(page, 's-tests')).toHaveAttribute('data-handoff', 'in');
    await expect(card(page, 's-auth')).not.toHaveAttribute('data-handoff');
    // 流動：虛線位移有動畫。
    const flow = await anim(page, 's-auth', 's-tests').evaluate((el) => {
      const style = getComputedStyle(el);
      return { name: style.animationName, dash: style.strokeDasharray };
    });
    expect(flow.name).toContain('talk-flow');
    expect(flow.dash).not.toBe('none');
    await shot(page, 'handoff-talk-active');

    await label(page, 's-auth', 's-tests').hover();
    const tip = page.getByTestId('handoff-tip-s-auth-s-tests');
    await expect(tip).toHaveText(/^Fix login → Write tests：Fixed the redirect\. · \d\d:\d\d$/);

    // 幾秒後動畫結束，線維持「剛說過話」，說明照樣看得到。
    await expect(anim(page, 's-auth', 's-tests')).toHaveCount(0, { timeout: 8000 });
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-phase', 'recent');
    await expect(card(page, 's-tests')).not.toHaveAttribute('data-handoff');
    await page.mouse.move(5, 5);
    await expect(tip).toHaveCount(0);
    // 鍵盤也看得到。
    await label(page, 's-auth', 's-tests').focus();
    await expect(tip).toContainText('Fix login → Write tests');

    // 金鑰在第一行時要遮掉。
    await emit(page, 's-auth', 's-tests', { summary: `Use ${SECRET} for the test.` });
    await expect(tip).toContainText('Use *');
    await expect(tip).not.toContainText(SECRET);
  });

  test('只排入（目標還在忙）：線在流，但目標卡不亮，標籤寫「已排入」', async ({ page }) => {
    await openCanvas(page);
    await emit(page, 's-auth', 's-tests', { queuedOnly: true });
    await expect(anim(page, 's-auth', 's-tests')).toHaveClass('edge-talk-flow');
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-talk', 'fired');
    await expect(label(page, 's-auth', 's-tests')).toContainText(/已排入 \d\d:\d\d/);
    await expect(card(page, 's-tests')).not.toHaveAttribute('data-handoff');
  });

  test('同一對 session 好幾條規則：後到的擋下不蓋掉送出，說明寫次數', async ({ page }) => {
    await openCanvas(page);
    await emit(page, 's-auth', 's-tests');
    await emit(page, 's-auth', 's-tests', { reason: 'rate_limit' });
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-talk', 'delivered');
    await expect(anim(page, 's-auth', 's-tests')).toHaveClass('edge-talk-flow');
    await expect(card(page, 's-tests')).toHaveAttribute('data-handoff', 'in');
    await label(page, 's-auth', 's-tests').hover();
    await expect(page.getByTestId('handoff-tip-s-auth-s-tests')).toContainText(
      '（1 則送出、1 則擋下）',
    );
  });

  test('擋下：閃一下不流動，說明寫原因，目標卡沒有光圈', async ({ page }) => {
    await openCanvas(page);
    await emit(page, 's-auth', 's-tests', { reason: 'loop' });
    await expect(anim(page, 's-auth', 's-tests')).toHaveClass('edge-talk-flash');
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-talk', 'blocked');
    await expect(label(page, 's-auth', 's-tests')).toContainText(/擋下 \d\d:\d\d/);
    await expect(card(page, 's-tests')).not.toHaveAttribute('data-handoff');
    await label(page, 's-auth', 's-tests').hover();
    await expect(page.getByTestId('handoff-tip-s-auth-s-tests')).toContainText(
      'Fix login → Write tests：擋下：會形成迴圈',
    );
    await expect(anim(page, 's-auth', 's-tests')).toHaveCount(0, { timeout: 5000 });

    await emit(page, 's-auth', 's-tests', { reason: 'rule_disabled' });
    await expect(label(page, 's-auth', 's-tests')).toHaveAttribute('data-talk', 'dropped');
    await expect(page.getByTestId('handoff-tip-s-auth-s-tests')).toContainText('取消：規則已關閉');
  });

  test('雙向交接：標籤寫第幾輪；到上限停下時寫清楚等你決定', async ({ page }) => {
    await openCanvas(page);
    await emit(page, 's-auth', 's-tests', { round: 2, maxRounds: 3 });
    await expect(page.getByTestId('handoff-round-s-auth-s-tests')).toHaveText('第 2/3 輪');
    await expect(page.getByTestId('handoff-limit-s-auth-s-tests')).toHaveCount(0);

    await emit(page, 's-tests', 's-auth', { reason: 'round_limit', round: 4, maxRounds: 3 });
    await expect(page.getByTestId('handoff-limit-s-tests-s-auth')).toHaveText(
      '來回 3 輪已到上限・等你決定',
    );
    await expect(page.getByTestId('handoff-round-s-tests-s-auth')).toHaveText('第 3/3 輪');
    await label(page, 's-tests', 's-auth').hover();
    await expect(page.getByTestId('handoff-tip-s-tests-s-auth')).toContainText(
      '停下：已來回 3 輪，等你決定',
    );
    // 單向規則沒有輪數。
    await emit(page, 's-tests', 's-docs');
    await expect(page.getByTestId('handoff-round-s-tests-s-docs')).toHaveCount(0);
  });

  test('沒有規則線的兩張卡：交接當下暫時畫一條，播完留著（最近往來）並寫次數', async ({ page }) => {
    await openCanvas(page);
    const temp = page.locator('[data-testid="rf__edge-talk:s-tests->s-docs"]');
    await expect(temp).toHaveCount(0);
    await emit(page, 's-tests', 's-docs');
    await expect(temp).toHaveCount(1);
    await expect(anim(page, 's-tests', 's-docs')).toHaveClass('edge-talk-flow');
    await expect(label(page, 's-tests', 's-docs')).toContainText('沒有規則線');
    await expect(card(page, 's-docs')).toHaveAttribute('data-handoff', 'in');
    // 播完：線留著（10 分鐘內有往來），排入＋送達算一則。
    await expect(anim(page, 's-tests', 's-docs')).toHaveCount(0, { timeout: 8000 });
    await expect(temp).toHaveCount(1);
    await expect(page.getByTestId('pair-count-s-tests-s-docs')).toHaveText('1');
  });

  test('減少動態：不流動、不閃，只有靜態的線、光圈和文字', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCanvas(page);
    await emit(page, 's-auth', 's-tests');
    const flow = anim(page, 's-auth', 's-tests');
    await expect(flow).toHaveClass('edge-talk-flow');
    const style = await flow.evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, dash: s.strokeDasharray, opacity: s.opacity };
    });
    expect(style).toEqual({ name: 'none', dash: 'none', opacity: '1' });
    expect(await card(page, 's-tests').evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'none',
    );
    await expect(card(page, 's-tests')).toHaveAttribute('data-handoff', 'in');
    await expect(label(page, 's-auth', 's-tests')).toContainText(/已送達 \d\d:\d\d/);
    await shot(page, 'handoff-talk-reduced');

    // 另一對（沒有規則線，暫時畫一條）：同一對的送出還在播，擋下不會蓋掉它。
    await emit(page, 's-tests', 's-auth', { reason: 'rate_limit' });
    const flash = anim(page, 's-tests', 's-auth');
    await expect(flash).toHaveClass('edge-talk-flash');
    expect(
      await flash.evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.animationName, s.opacity];
      }),
    ).toEqual(['none', '1']);
  });
});

test.describe('等你的數量與上限（GM 2026-11-06）', () => {
  const noOverflow = (page: Page) =>
    page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth <= el.clientWidth && document.body.scrollWidth <= el.clientWidth;
    });
  /** 再多一個在等你：假後端的 s-tests 原本在工作。 */
  const oneMore = (page: Page) =>
    patchStore(page, `useBoard.getState().backend.setSessionStatus('s-tests', 'waiting_input');`);

  test('頁首的「等你」數量連到收件匣；剛開好、閒著的不算', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await expect(page.getByTestId('waiting-count')).toHaveText('3');
    await patchStore(
      page,
      `useBoard.getState().backend.patchSession('s-tests', { status: 'waiting_input', statusDetail: 'idle:start' });`,
    );
    // 剛開好、還沒下指令：NEW 灰，不算等你，也沒有粗框與光圈（GM 2026-11-08）。
    const tests = card(page, 's-tests');
    await expect(tests.locator('.lamp')).toHaveText('◌NEW');
    await expect(tests.locator('.lamp')).toHaveAttribute('title', 'NEW：剛開好，還沒下指令');
    await expect(tests.locator('.lamp')).toHaveCSS('background-color', 'rgb(154, 164, 178)');
    await expect(tests.locator('.strip')).toHaveCSS('border-top-color', 'rgb(154, 164, 178)');
    await expect(tests.locator('.strip')).toHaveCSS('border-top-width', '1px');
    await expect(tests).not.toHaveAttribute('data-waits', 'true');
    await expect(page.getByTestId('waiting-count')).toHaveText('3');
    // 「下一個等我的」也跳過 NEW：連按一輪多一次，只巡過原本三張。
    const spot = () =>
      page.locator('.frame.spot').evaluateAll((els) => els[0]?.getAttribute('data-testid') ?? null);
    const visit = async (times: number) => {
      const seen: string[] = [];
      for (let i = 0; i < times; i += 1) {
        const before = await spot();
        await page.getByTestId('next-up').click();
        await expect.poll(spot).not.toBe(before);
        seen.push((await spot())!);
      }
      return seen;
    };
    const round = await visit(4);
    expect(round).not.toContain('card-s-tests');
    expect(new Set(round)).toEqual(new Set(['card-s-ml', 'card-s-auth', 'card-s-etl']));
    await patchStore(
      page,
      `useBoard.getState().backend.patchSession('s-tests', { statusDetail: null });`,
    );
    // 做完一回合（detail 清掉）才是 ASK 黃，算等你。
    await expect(tests.locator('.lamp')).toHaveText('◇ASK');
    await expect(tests.locator('.strip')).toHaveCSS('border-top-color', 'rgb(255, 225, 77)');
    await expect(page.getByTestId('waiting-count')).toHaveText('4');
    // 變成 ASK 之後才進入輪替。
    expect(await visit(4)).toContain('card-s-tests');
    await page.getByTestId('waiting-link').click();
    await expect(page).toHaveURL(/#\/inbox$/);
  });

  test('超過上限（預設 3）出現橫幅；知道了收起，回到上限以內再超過又出現', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await expect(page.getByTestId('waiting-banner')).toHaveCount(0);
    await oneMore(page);
    const banner = page.getByTestId('waiting-banner');
    await expect(banner).toContainText('同時有 4 個 session 在等你，超過上限 3');
    await shot(page, 'waiting-banner');
    await page.getByTestId('waiting-banner-dismiss').click();
    await expect(banner).toHaveCount(0);
    // 還在上限以上：不會自己再跳出來。
    await patchStore(page, `useBoard.getState().backend.setSessionStatus('s-docs', 'error');`);
    await expect(page.getByTestId('waiting-count')).toHaveText('5');
    await expect(banner).toHaveCount(0);
    // 回到上限以內再超過：重新出現。
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       b.setSessionStatus('s-tests', 'running');
       b.setSessionStatus('s-docs', 'running');`,
    );
    await expect(page.getByTestId('waiting-count')).toHaveText('3');
    await oneMore(page);
    await expect(banner).toBeVisible();
    await banner.getByRole('link', { name: '去收件匣' }).click();
    await expect(page).toHaveURL(/#\/inbox$/);
    // 收件匣也有同一條橫幅。
    await expect(page.getByTestId('waiting-banner')).toBeVisible();
  });

  test('上限跟著設定（hub 廣播）：改成 5 就不算超過', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await oneMore(page);
    await expect(page.getByTestId('waiting-banner')).toBeVisible();
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       void b.getSettings().then((s) =>
         b.updateSettings({ notifications: { ...s.notifications, waitingLimit: 5 } }));`,
    );
    await expect(page.getByTestId('waiting-banner')).toHaveCount(0);
  });

  test('卡片寫「額度恢復後自動接續：HH:MM」', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await patchStore(
      page,
      `useBoard.getState().backend.patchSession('s-docs', {
         autoContinue: {
           state: 'scheduled',
           at: new Date(2026, 10, 6, 15, 1).toISOString(),
           resetAt: new Date(2026, 10, 6, 15, 0).toISOString(),
           limitSince: new Date(2026, 10, 6, 14, 0).toISOString(),
           reason: null,
         },
       });`,
    );
    await expect(page.getByTestId('auto-continue-s-docs')).toHaveText('額度恢復後自動接續：15:01');
    await patchStore(
      page,
      `const s = useBoard.getState().sessions.find((x) => x.id === 's-docs');
       useBoard.getState().backend.patchSession('s-docs', {
         autoContinue: { ...s.autoContinue, state: 'cancelled', reason: 'user_input' },
       });`,
    );
    await expect(page.getByTestId('auto-continue-s-docs')).toHaveCount(0);
  });

  test('派工開的成員：卡片寫「派工自 <呼叫者>」（CONTRACTS §11）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await expect(card(page, 's-docs').getByTestId('dispatched-by')).toHaveCount(0);
    await patchStore(
      page,
      `useBoard.getState().backend.patchSession('s-docs', { dispatchedBy: 's-auth' });`,
    );
    const chip = card(page, 's-docs').getByTestId('dispatched-by');
    await expect(chip).toHaveText('派工自 Fix login');
    await expect(chip).toHaveAttribute('title', /結果會自動送回 Fix login/);
    // 呼叫者不在了（例如已刪除）：不顯示。
    await patchStore(
      page,
      `useBoard.getState().backend.patchSession('s-docs', { dispatchedBy: 'gone' });`,
    );
    await expect(card(page, 's-docs').getByTestId('dispatched-by')).toHaveCount(0);
  });

  for (const width of [320, 375]) {
    for (const route of ['canvas', 'queue', 'inbox']) {
      test(`${width}px ${route}：數量與橫幅不撐出水平捲軸`, async ({ page }) => {
        await page.setViewportSize({ width, height: 700 });
        await page.goto(`/#/${route}`);
        await expect(page.locator('[data-state="loading"]')).toHaveCount(0);
        // 手機的 #/queue 轉成全螢幕收件匣（沒有 App 頁首）。
        if (route === 'canvas') await expect(page.getByTestId('waiting-count')).toHaveText('3');
        await oneMore(page);
        await expect(page.getByTestId('waiting-banner')).toBeVisible();
        expect(await noOverflow(page)).toBe(true);
        const box = (await page.getByTestId('waiting-banner').boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await shot(page, `waiting-banner-${width}-${route}`);
      });
    }
  }
});

test.describe('一鍵整理', () => {
  const STEP_X = 680 + 140;
  const STEP_Y = 640 + 72;
  const IDS = ['s-auth', 's-tests', 's-etl', 's-ml', 's-docs', 's-web'];
  type Box = { x: number; y: number };

  async function positions(page: Page): Promise<Record<string, Box>> {
    const out: Record<string, Box> = {};
    for (const id of IDS) {
      const transform = await position(page, id);
      const m = transform.match(/translate\((-?[\d.]+)px, ?(-?[\d.]+)px\)/);
      out[id] = { x: Number(m?.[1]), y: Number(m?.[2]) };
    }
    return out;
  }

  const overlapPairs = (p: Record<string, Box>) => {
    const ids = Object.keys(p);
    return ids.flatMap((a, i) =>
      ids
        .slice(i + 1)
        .filter((b) => Math.abs(p[a]!.x - p[b]!.x) < 680 && Math.abs(p[a]!.y - p[b]!.y) < 640)
        .map((b) => `${a}×${b}`),
    );
  };

  const saveCount = (page: Page) =>
    page.evaluate(() => (window as never as { __saves: number }).__saves);

  /** 先開一次畫布、把版面副本換成指定的擺設，再重新載入。 */
  async function openWith(page: Page, layout: Record<string, Box>) {
    await page.goto('/#/canvas');
    await expect(card(page, 's-auth')).toBeVisible();
    await page.evaluate((layout) => {
      localStorage.setItem(
        'agent-board.layouts.default',
        JSON.stringify(
          Object.entries(layout).map(([sessionId, p]) => ({
            workspace: 'default',
            sessionId,
            x: p.x,
            y: p.y,
            w: 680,
            h: 640,
          })),
        ),
      );
    }, layout);
    await page.reload();
    await expect(card(page, 's-auth')).toBeVisible();
    await expect.poll(() => positions(page)).toEqual(layout);
  }

  // 團隊（s-tests 隊長、s-auth 成員）拉得很開，s-etl 疊在 s-tests 上。
  const MESSY: Record<string, Box> = {
    's-tests': { x: 0, y: 0 },
    's-auth': { x: 4 * STEP_X, y: 3 * STEP_Y },
    's-etl': { x: 100, y: 100 },
    's-ml': { x: 2 * STEP_X, y: 2 * STEP_Y },
    's-docs': { x: STEP_X, y: 0 },
    's-web': { x: -2 * STEP_X, y: STEP_Y },
  };

  /**
   * 線與線上的字看得到（GM 2026-11-09）：每條線取樣的點都不在任何卡片矩形裡（線畫在卡片底下），
   * 字不壓到卡、也沒有被卡片蓋住。
   */
  async function expectLinksVisible(page: Page, minLabels = 1) {
    const report = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.react-flow__node')].map((n) => ({
        id: n.getAttribute('data-id'),
        r: n.getBoundingClientRect(),
      }));
      const inCard = (x: number, y: number) =>
        cards
          .filter(
            (c) => x > c.r.left + 1 && x < c.r.right - 1 && y > c.r.top + 1 && y < c.r.bottom - 1,
          )
          .map((c) => c.id ?? '');
      const edges = [...document.querySelectorAll('.react-flow__edge')].map((e) => {
        const path = e.querySelector<SVGPathElement>('path.react-flow__edge-path')!;
        const len = path.getTotalLength();
        const m = path.getScreenCTM()!;
        const hidden: string[] = [];
        for (let i = 0; i <= 60; i += 1) {
          const at = path.getPointAtLength((len * i) / 60);
          const p = new DOMPoint(at.x, at.y).matrixTransform(m);
          hidden.push(...inCard(p.x, p.y));
        }
        return { id: e.getAttribute('data-id'), len, hidden };
      });
      // 畫面外的字（整理後放不下、留給捲動的部分）量不到有沒有被蓋住，只看畫面裡的。
      const host = document.querySelector('.react-flow')!.getBoundingClientRect();
      const shown = [...document.querySelectorAll<HTMLElement>('.edge-label')].filter((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return x > host.left && x < host.right && y > host.top && y < host.bottom;
      });
      const labels = shown.map((el) => {
        const r = el.getBoundingClientRect();
        const under = cards
          .filter(
            (c) =>
              r.left < c.r.right && c.r.left < r.right && r.top < c.r.bottom && c.r.top < r.bottom,
          )
          .map((c) => c.id);
        // 沒有卡片蓋在字上面（線本身透明的感應區在上面不算）。標籤平常不接滑鼠，
        // elementsFromPoint 會跳過它，量的時候暫時打開。
        const was = el.style.pointerEvents;
        el.style.pointerEvents = 'auto';
        const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        el.style.pointerEvents = was;
        const mine = stack.findIndex((x) => el.contains(x));
        const cover = stack.findIndex((x) => x.closest('.react-flow__node'));
        return { id: el.dataset.testid, under, onTop: mine >= 0 && (cover < 0 || mine < cover) };
      });
      return { edges, labels };
    });
    expect(report.edges.length).toBeGreaterThan(0);
    for (const edge of report.edges) {
      expect(edge.len, `${edge.id} 有長度`).toBeGreaterThan(20);
      expect(edge.hidden, `${edge.id} 不從卡片底下穿過`).toEqual([]);
    }
    expect(report.labels.length).toBeGreaterThanOrEqual(minLabels);
    for (const l of report.labels) {
      expect(l.under, `${l.id} 不壓到卡`).toEqual([]);
      expect(l.onTop, `${l.id} 沒被蓋住`).toBe(true);
    }
  }

  test('整理畫布：不重疊、團隊相鄰；重新載入後可回到上一次擺設，再按一次換回來', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWith(page, MESSY);
    await expect(page.getByRole('button', { name: '回到上一次擺設' })).toHaveCount(0);
    expect(overlapPairs(MESSY)).toEqual(['s-tests×s-etl']);

    await page.getByRole('button', { name: '整理畫布' }).click();
    await expect(page.getByTestId('tidy-toast')).toContainText('已整理');
    await expect.poll(async () => overlapPairs(await positions(page))).toEqual([]);
    // 動畫結束後才比位置
    await page.waitForTimeout(500);
    const tidied = await positions(page);
    expect(overlapPairs(tidied)).toEqual([]);
    // 隊長＋1 位在橫的畫面左右排：隊長在左、成員在右，同一列（收尾 2026-11-10）。
    expect(tidied['s-auth']!.y).toBeCloseTo(tidied['s-tests']!.y, 2);
    expect(tidied['s-auth']!.x).toBeCloseTo(tidied['s-tests']!.x + STEP_X, 2);
    await shot(page, 'tidy-canvas');

    // 一次存好：目前位置＋上一次擺設
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('agent-board.layouts.default')))
      .toContain('default.previous');

    await page.reload();
    await expect(card(page, 's-auth')).toBeVisible();
    await expect.poll(() => positions(page)).toEqual(tidied);
    const previous = page.getByRole('button', { name: '回到上一次擺設' });
    await previous.click();
    await expect.poll(() => positions(page)).toEqual(MESSY);
    await previous.click();
    await expect.poll(() => positions(page)).toEqual(tidied);
    // 換回來也存了：重新載入還是整理後的，而且還能再換
    await page.waitForTimeout(200);
    await page.reload();
    await expect.poll(() => positions(page)).toEqual(tidied);
    await page.getByRole('button', { name: '回到上一次擺設' }).click();
    await expect.poll(() => positions(page)).toEqual(MESSY);
  });

  test('整理畫布後關係線與線上的字看得到：線不從任何卡片底下穿過，字不壓到卡（GM 2026-11-09）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWith(page, MESSY);
    await page.getByRole('button', { name: '整理畫布' }).click();
    await expect(page.getByTestId('tidy-toast')).toBeVisible();
    await page.waitForTimeout(800);
    // 交接規則 s-auth → s-tests：成員在隊長右邊，線走兩張卡之間（以前上下排時，舊的線整條藏在兩張卡底下）。
    const label = page.getByTestId('handoff-label-s-auth-s-tests');
    await expect(label).toBeVisible();
    await expectLinksVisible(page);
    await shot(page, 'tidy-edges');
  });

  /**
   * 用假後端加 session、團隊、交接規則（GM 實際的量級）。teams[i] 是第 i 個團隊的人數；
   * 第 0 個團隊用 demo 原本的「登入重構」（s-tests 隊長、s-auth 成員），其他新建。
   * 每個團隊：隊長、開發、最後一位審查，交接鏈 開發 → … → 審查 → 隊長。
   */
  async function addTeams(page: Page, sizes: number[]) {
    await page.evaluate(
      async ({ url, teamsUrl, sizes }) => {
        const { useBoard } = await import(/* @vite-ignore */ url);
        const { refreshTeams } = await import(/* @vite-ignore */ teamsUrl);
        const b = useBoard.getState().backend;
        const spec = (name: string) => ({
          name,
          machineId: 'm-studio',
          cwd: '/home/demo/project',
          useWorktree: false,
          readOnly: false,
          permissionMode: 'default',
          model: null,
          projectId: null,
          firstPrompt: null,
        });
        for (let t = 0; t < sizes.length; t += 1) {
          const n = sizes[t]!;
          let teamId = 'team-demo-auth';
          let ids = ['s-tests', 's-auth'];
          if (t > 0) {
            const team = await b.createTeam({
              name: `團隊 ${t + 1}`,
              goal: '',
              doneCriteria: '',
              color: 'teal',
              contextMd: '',
            });
            teamId = team.id;
            ids = [];
          }
          while (ids.length < n) {
            const s = await b.createSession(spec(`T${t + 1} 成員 ${ids.length + 1}`));
            ids.push(s.id);
          }
          for (let i = 0; i < n; i += 1) {
            const role = i === 0 ? 'lead' : i === n - 1 && n > 2 ? 'reviewer' : 'worker';
            await b.putTeamMember(teamId, ids[i], role);
          }
          for (let i = 1; i < n - 1; i += 1) {
            await b.createHandoffRule(teamId, {
              fromSessionId: ids[i],
              trigger: 'on_done',
              action: { toSessionId: ids[i + 1] },
              enabled: true,
            });
          }
        }
        await refreshTeams(b);
      },
      { url: STORE, teamsUrl: '/src/team/store.ts', sizes },
    );
  }

  /** 整理後畫面上的範圍（卡片＋團隊框，螢幕 px）與畫布可視範圍。 */
  const screenRange = (page: Page) =>
    page.evaluate(() => {
      const host = document.querySelector('.react-flow')!.getBoundingClientRect();
      const rs = [...document.querySelectorAll('.react-flow__node, .team')].map((n) =>
        n.getBoundingClientRect(),
      );
      const left = Math.min(...rs.map((r) => r.left));
      const top = Math.min(...rs.map((r) => r.top));
      const right = Math.max(...rs.map((r) => r.right));
      const bottom = Math.max(...rs.map((r) => r.bottom));
      // 畫面使用率：範圍落在可視範圍裡的面積 ÷ 可視範圍面積。
      const w = Math.max(0, Math.min(right, host.right) - Math.max(left, host.left));
      const h = Math.max(0, Math.min(bottom, host.bottom) - Math.max(top, host.top));
      return {
        aspect: (right - left) / (bottom - top),
        usage: (w * h) / (host.width * host.height),
        cards: document.querySelectorAll('.react-flow__node').length,
      };
    });

  for (const [name, sizes, minUsage] of [
    ['1 個團隊 16 人', [16], 0.6],
    ['6 個團隊各 3–5 人', [3, 4, 5, 3, 4, 5], 0.6],
  ] as const) {
    test(`妥善利用空間（GM 2026-11-09）：${name}整理後全部顯示，範圍接近畫面比例、畫面使用率高；線與字看得到`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 900 });
      await openCanvas(page);
      await addTeams(page, [...sizes]);
      const total = sizes.reduce((a, b) => a + b, 0);
      await expect
        .poll(() => page.locator('.react-flow__node').count())
        .toBeGreaterThanOrEqual(total);
      await page.getByRole('button', { name: '全部顯示' }).click();
      await page.waitForTimeout(400);
      await shot(page, `tidy-space-${sizes.length}-before`);
      await page.getByRole('button', { name: '整理畫布' }).click();
      await expect(page.getByTestId('tidy-toast')).toBeVisible();
      await page.waitForTimeout(800);
      const range = await screenRange(page);
      expect(range.aspect, JSON.stringify(range)).toBeGreaterThanOrEqual(1.2);
      expect(range.aspect, JSON.stringify(range)).toBeLessThanOrEqual(2.2);
      expect(range.usage, JSON.stringify(range)).toBeGreaterThanOrEqual(minUsage);
      await expectLinksVisible(page, 0);
      await shot(page, `tidy-space-${sizes.length}-after`);
    });
  }

  test('整理團隊：只動團隊與被壓到的卡；存一次；「復原」還原；拖曳後就不能復原', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const before: Record<string, Box> = {
      's-tests': { x: 0, y: 0 },
      's-auth': { x: 3 * STEP_X, y: 2 * STEP_Y },
      // 擋在隊長右邊：整理後成員要放這裡（隊長＋1 位在橫的畫面左右排）
      's-docs': { x: STEP_X, y: 0 },
      's-etl': { x: 3 * STEP_X, y: 0 },
      's-ml': { x: 6 * STEP_X, y: 0 },
      's-web': { x: 6 * STEP_X, y: 2 * STEP_Y },
    };
    await openWith(page, before);
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       const save = b.saveLayouts.bind(b);
       window.__saves = 0;
       b.saveLayouts = async (l) => { window.__saves += 1; return save(l); };`,
    );

    await page.getByTestId('tidy-team-team-demo-auth').click();
    await expect
      .poll(() =>
        positions(page).then(
          (p) => p['s-auth'] && { x: p['s-auth'].x, y: Math.round(p['s-auth'].y) },
        ),
      )
      .toEqual({ x: STEP_X, y: 0 });
    const after = await positions(page);
    expect(after['s-tests']).toEqual({ x: 0, y: 0 });
    expect(after['s-docs']).not.toEqual(before['s-docs']);
    for (const id of ['s-etl', 's-ml', 's-web']) expect(after[id]).toEqual(before[id]);
    expect(overlapPairs(after)).toEqual([]);
    // 存一次，不是每張卡各存一次
    await expect.poll(() => saveCount(page)).toBe(1);
    // 鏡頭移到團隊：兩位成員都在畫面裡
    await expect(card(page, 's-tests')).toBeInViewport();
    await expect(card(page, 's-auth')).toBeInViewport();

    const toast = page.getByTestId('tidy-toast');
    await toast.getByRole('button', { name: '復原' }).click();
    await expect(toast).toHaveCount(0);
    await expect.poll(() => positions(page)).toEqual(before);
    await expect.poll(() => saveCount(page)).toBe(2);

    // 再整理一次，拖了卡就沒有「復原」，但工具列還是可以回到上一次擺設
    await page.getByTestId('tidy-team-team-demo-auth').click();
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: '全部顯示' }).click();
    await expect(card(page, 's-etl')).toBeInViewport({ ratio: 1 });
    const box = (await card(page, 's-etl').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 50, { steps: 6 });
    await page.mouse.up();
    await expect(toast).toHaveCount(0);
    await expect(page.getByRole('button', { name: '回到上一次擺設' })).toBeVisible();
  });

  test('「已整理」10 秒後消失', async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await page.getByRole('button', { name: '整理畫布' }).click();
    await expect(page.getByTestId('tidy-toast')).toBeVisible();
    await page.clock.runFor(9_000);
    await expect(page.getByTestId('tidy-toast')).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(page.getByTestId('tidy-toast')).toHaveCount(0);
  });

  for (const width of [320, 375]) {
    test(`手機 ${width}px：整理按鈕在畫面內、按得到`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/#/canvas');
      await expect(card(page, 's-auth')).toBeVisible();
      const tidy = page.getByRole('button', { name: '整理畫布' });
      const box = (await tidy.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(32);
      await tidy.click();
      const toast = page.getByTestId('tidy-toast');
      await expect(toast.getByRole('button', { name: '復原' })).toBeVisible();
      const t = (await toast.boundingBox())!;
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(width);
      // 不被右下角的縮放列擋住
      const zoom = (await page.locator('.zoom').boundingBox())!;
      expect(t.y + t.height).toBeLessThanOrEqual(zoom.y);
      await shot(page, `tidy-phone-${width}`);
      await page.getByRole('button', { name: '回到上一次擺設' }).click();
      await expect(toast).toHaveCount(0);
    });
  }
});

test('縮小時用摘要的開關：關掉後縮小也是終端機，重新載入還記得', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page);
  expect(await zoomLevel(page)).toBeLessThan(90);
  const toggle = page.getByRole('button', { name: /^摘要模式/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-mode="terminal"]')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('摘要模式：關');
  await expect(card(page, 's-auth')).toHaveAttribute('data-mode', 'terminal');
  await expect(card(page, 's-tests')).toHaveAttribute('data-mode', 'terminal');

  await page.reload();
  await expect(card(page, 's-auth')).toHaveAttribute('data-mode', 'terminal');
  await expect(page.getByRole('button', { name: /^摘要模式/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.getByRole('button', { name: /^摘要模式/ }).click();
  await expect(card(page, 's-auth')).toHaveAttribute('data-mode', 'summary');
});

test.describe('session 之間的往來：關係線、往來、篩選、紀錄（GM 2026-11-06）', () => {
  const SECRET = 'sk-ant-demo0123456789abcdefXYZ';
  const edge = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"]`);
  const event = (page: Page, at: string, type: string, payload: object) =>
    patchStore(
      page,
      `useBoard.getState().backend.addSessionEvent(${JSON.stringify(at)}, ${JSON.stringify(type)}, ${JSON.stringify(payload)});`,
    );
  const dispatchedBy = (page: Page, id: string, by: string | null) =>
    patchStore(
      page,
      `useBoard.getState().backend.patchSession(${JSON.stringify(id)}, { dispatchedBy: ${JSON.stringify(by)} });`,
    );

  test('關係線：派工畫實線、交接規則虛線；隊長 → 成員只在沒有其他線時畫', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await expect(edge(page, 'dispatch:s-etl->s-docs')).toHaveCount(0);
    await dispatchedBy(page, 's-docs', 's-etl');
    await expect(edge(page, 'dispatch:s-etl->s-docs')).toHaveCount(1);
    const style = (id: string) =>
      edge(page, id)
        .locator('.react-flow__edge-path')
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.strokeDasharray, s.strokeWidth];
        });
    expect(await style('dispatch:s-etl->s-docs')).toEqual(['none', '2px']);
    expect((await style('s-auth->s-tests'))[0]).not.toBe('none');
    // 隊長 s-tests 和成員 s-auth 之間已經有交接規則：不另外畫隊長線。
    await expect(edge(page, 'team:s-tests->s-auth')).toHaveCount(0);
    // 刪掉規則後就畫隊長線（點線、沒有箭頭）。
    await edge(page, 's-auth->s-tests').click({ force: true });
    await page.keyboard.press('Delete');
    await expect(edge(page, 's-auth->s-tests')).toHaveCount(0);
    const team = edge(page, 'team:s-tests->s-auth');
    await expect(team).toHaveCount(1);
    expect(await team.locator('.react-flow__edge-path').getAttribute('marker-end')).toBeNull();
    // 圖例：線型樣本。
    await page.getByTestId('link-panel').getByRole('button', { name: /^線/ }).click();
    await expect(page.locator('.link-legend li')).toHaveCount(6);
    await expect(page.locator('.link-legend')).toContainText('派工：呼叫者 → 成員');
  });

  test('沒有任何線的兩張卡也看得到往來：派工排入 → 送達，標籤寫做了什麼與摘要（遮蔽）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('agent-board.mask-mode', '1'));
    await openCanvas(page);
    const temp = edge(page, 'talk:s-etl->s-docs');
    await expect(temp).toHaveCount(0);
    const payload = {
      fromSessionId: 's-etl',
      toSessionId: 's-docs',
      workId: 'w1',
      summary: `Use ${SECRET} to fetch.`,
    };
    await event(page, 's-etl', 'dispatch.send', payload);
    await expect(temp).toHaveCount(1);
    const anim = page.getByTestId('handoff-anim-s-etl-s-docs');
    await expect(anim).toHaveClass('edge-talk-flow');
    await expect(anim).toHaveAttribute('data-channel', 'dispatch');
    await expect(anim).toHaveAttribute('data-kind', 'fired');
    const label = page.getByTestId('handoff-label-s-etl-s-docs');
    await expect(label).toContainText('派工');
    await expect(label).toContainText(/已排入 \d\d:\d\d/);
    await expect(page.getByTestId('talk-sum-s-etl-s-docs')).toContainText('Use *');
    await expect(label).not.toContainText(SECRET);
    // 只排入：目標卡不亮。
    await expect(card(page, 's-docs')).not.toHaveAttribute('data-handoff');

    await event(page, 's-docs', 'dispatch.delivered', payload);
    await expect(label).toContainText(/已送達 \d\d:\d\d/);
    await expect(anim).toHaveAttribute('data-kind', 'delivered');
    await expect(card(page, 's-docs')).toHaveAttribute('data-handoff', 'in');
    // 排入＋送達是同一則。
    await expect(page.getByTestId('pair-count-s-etl-s-docs')).toHaveText('1');

    // 回報結果是反方向：另一條暫時線。
    await event(page, 's-docs', 'dispatch.result', {
      fromSessionId: 's-docs',
      toSessionId: 's-etl',
      workId: 'w1',
      summary: 'Done.',
    });
    await expect(edge(page, 'talk:s-docs->s-etl')).toHaveCount(1);
    await expect(page.getByTestId('handoff-label-s-docs-s-etl')).toContainText('回報結果');
  });

  test('派工線上的往來畫在派工線上；任務判定也畫出來', async ({ page }) => {
    await openCanvas(page);
    await dispatchedBy(page, 's-docs', 's-etl');
    await expect(edge(page, 'dispatch:s-etl->s-docs')).toHaveCount(1);
    await event(page, 's-docs', 'dispatch.spawn', {
      fromSessionId: 's-etl',
      toSessionId: 's-docs',
      summary: 'Start.',
    });
    await expect(page.getByTestId('handoff-anim-s-etl-s-docs')).toHaveClass('edge-talk-flow');
    await expect(edge(page, 'talk:s-etl->s-docs')).toHaveCount(0);
    await expect(page.getByTestId('link-label-dispatch-s-etl-s-docs')).toContainText('派工開成員');
    await expect(page.getByTestId('pair-count-s-etl-s-docs')).toHaveText('1');

    await event(page, 's-ml', 'task.reviewed', {
      verdict: 'pass',
      fromSessionId: 's-ml',
      toSessionId: 's-docs',
      taskId: 't1',
    });
    await expect(page.getByTestId('handoff-anim-s-ml-s-docs')).toHaveAttribute(
      'data-kind',
      'verdict',
    );
    await expect(page.getByTestId('handoff-label-s-ml-s-docs')).toContainText('審查通過');
  });

  test('篩選：關掉的類別不畫、不播；重新載入還記得', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const toggle = page.getByTestId('link-filter-dispatch');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await event(page, 's-etl', 'dispatch.send', { fromSessionId: 's-etl', toSessionId: 's-docs' });
    await expect(edge(page, 'talk:s-etl->s-docs')).toHaveCount(0);
    await expect(page.getByTestId('handoff-anim-s-etl-s-docs')).toHaveCount(0);
    // 交接關掉：規則線也藏起來。
    await page.getByTestId('link-filter-handoff').click();
    await expect(edge(page, 's-auth->s-tests')).toHaveCount(0);
    await page.getByTestId('link-filter-handoff').click();
    await expect(edge(page, 's-auth->s-tests')).toHaveCount(1);
    // 打開派工：剛才的往來（還在 10 分鐘內）出現。
    await toggle.click();
    await expect(edge(page, 'talk:s-etl->s-docs')).toHaveCount(1);
    await toggle.click();

    await page.reload();
    await expect(card(page, 's-auth')).toBeVisible();
    await expect(page.getByTestId('link-filter-dispatch')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('link-filter-task')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('link-panel')).toContainText('線 3/4');
  });

  test('儲存讀寫失敗（私密視窗）：開關照常可用，一開始全開', async ({ page }) => {
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === 'agent-board.canvas.link-filters') throw new Error('blocked');
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'agent-board.canvas.link-filters') throw new Error('blocked');
        set.call(this, key, value);
      };
    });
    await openCanvas(page);
    const toggle = page.getByTestId('link-filter-task');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('點線看兩張卡最近的往來；Esc 或「關閉」收掉', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('agent-board.mask-mode', '1'));
    await openCanvas(page);
    await event(page, 's-etl', 'dispatch.send', {
      fromSessionId: 's-etl',
      toSessionId: 's-docs',
      workId: 'w1',
      summary: `First line\nkey ${SECRET}`,
    });
    await event(page, 's-etl', 'dispatch.blocked', {
      fromSessionId: 's-etl',
      toSessionId: 's-docs',
      reason: 'rate_limit',
    });
    await event(page, 's-docs', 'dispatch.result', {
      fromSessionId: 's-docs',
      toSessionId: 's-etl',
      workId: 'w1',
      summary: `Result with ${SECRET}`,
    });
    await expect(page.getByTestId('pair-count-s-etl-s-docs')).toHaveText('2');
    await page.getByTestId('pair-count-s-etl-s-docs').click();
    const pop = page.getByTestId('pair-popover-s-etl-s-docs');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Migrate data ↔ Tidy docs');
    const rows = pop.getByTestId('pair-row');
    // 兩個方向、新的在前。
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Tidy docs → Migrate data');
    await expect(rows.nth(0)).toContainText('回報結果・已排入');
    await expect(rows.nth(1)).toContainText('派工・擋下');
    await expect(rows.nth(1)).toContainText('10 分鐘內觸發太多次');
    await expect(rows.nth(2)).toContainText('派工・已排入');
    await expect(rows.nth(2)).toContainText('First line');
    await expect(pop).not.toContainText(SECRET);
    await shot(page, 'pair-popover');
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);

    // 點線本身也打開（兩條線的中點重疊、線也可能在卡片底下：直接對這條線送 click）。
    await edge(page, 'talk:s-docs->s-etl').dispatchEvent('click');
    const back = page.getByTestId('pair-popover-s-docs-s-etl');
    await expect(back).toBeVisible();
    await back.getByRole('button', { name: '關閉' }).click();
    await expect(back).toHaveCount(0);
  });

  test('手機寬度：線的開關收成一顆按鈕，不撐出水平捲軸', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await openCanvas(page);
    const panel = page.getByTestId('link-panel');
    await expect(page.getByTestId('link-filter-dispatch')).toBeHidden();
    await panel.getByRole('button', { name: /^線/ }).click();
    await expect(page.getByTestId('link-filter-dispatch')).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
});

test.describe('狀態一眼看得出來（GM 2026-11-06）', () => {
  const ring = (page: Page, id: string) =>
    card(page, id).evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return { name: s.animationName, opacity: s.opacity };
    });

  test('等你、故障的卡外圈慢慢呼吸（光圈是代碼色）；工作中的不動；故障 2px 紅框', async ({
    page,
  }) => {
    await openCanvas(page);
    expect((await ring(page, 's-auth')).name).toBe('needs-you');
    expect((await ring(page, 's-ml')).name).toBe('needs-you');
    expect(await ring(page, 's-tests')).toEqual({ name: 'none', opacity: '0' });
    const ringColor = (id: string) =>
      card(page, id).evaluate((el) => getComputedStyle(el, '::after').borderTopColor);
    expect(await ringColor('s-auth')).toBe('rgb(255, 79, 216)');
    expect(await ringColor('s-etl')).toBe('rgb(61, 213, 224)');
    await expect(card(page, 's-ml')).toHaveAttribute('data-code', 'ERR');
    await expect(card(page, 's-ml')).toHaveAttribute('data-waits', 'true');
    await expect(card(page, 's-ml').locator('.strip')).toHaveCSS('border-top-width', '2px');
    await expect(card(page, 's-ml').locator('.strip')).toHaveCSS(
      'border-top-color',
      'rgb(240, 102, 95)',
    );
  });

  test('狀態代碼（GM 2026-11-08）：每張卡的邊框色等於代碼色；DONE 是綠色且只有它能用綠', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    // 有一張結束的卡（DONE），也有剛開好的（NEW）。
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       b.setSessionStatus('s-docs', 'done');
       b.patchSession('s-tests', { status: 'waiting_input', statusDetail: 'idle:start' });`,
    );
    await expect(card(page, 's-docs').locator('.lamp')).toHaveText('✓DONE');
    await expect(card(page, 's-docs').locator('.lamp')).toHaveCSS(
      'background-color',
      'rgb(70, 194, 106)',
    );
    const expected: Record<string, string> = {
      NEW: 'rgb(154, 164, 178)',
      RUN: 'rgb(74, 163, 255)',
      ASK: 'rgb(255, 225, 77)',
      PERM: 'rgb(255, 79, 216)',
      PLAN: 'rgb(61, 213, 224)',
      ERR: 'rgb(240, 102, 95)',
      QUOTA: 'rgb(155, 107, 255)',
      QUE: 'rgb(212, 163, 115)',
      DONE: 'rgb(70, 194, 106)',
      OFF: 'rgb(110, 118, 129)',
    };
    const collect = () =>
      page.locator('.frame[data-code]').evaluateAll((els) =>
        els.map((el) => {
          const article = el.querySelector('article')!;
          const badge = el.querySelector('.head .lamp.badge')!;
          return {
            code: el.getAttribute('data-code')!,
            border: getComputedStyle(article).borderTopColor,
            badge: getComputedStyle(badge).backgroundColor,
            badgeCode: badge.querySelector('.code')!.textContent,
          };
        }),
      );
    const first = await collect();
    expect(first.map((c) => c.code).sort()).toEqual(
      ['DONE', 'ERR', 'NEW', 'OFF', 'PERM', 'PLAN'].sort(),
    );
    expect(await findGreenOutsideDone(page)).toEqual([]);
    // 第二輪把四張卡換成其餘四個代碼（RUN、ASK、QUOTA、QUE），10 個代碼都要畫過一次。
    await patchStore(
      page,
      `const b = useBoard.getState().backend;
       b.setSessionStatus('s-docs', 'rate_limited');
       b.patchSession('s-tests', { status: 'running', statusDetail: null });
       b.setSessionStatus('s-etl', 'queued');
       b.patchSession('s-ml', { status: 'waiting_input', statusDetail: null });`,
    );
    await expect(card(page, 's-etl').locator('.head .lamp .code')).toHaveText('QUE');
    await expect(card(page, 's-ml').locator('.head .lamp .code')).toHaveText('ASK');
    const second = await collect();
    expect(second.map((c) => c.code).sort()).toEqual(
      ['ASK', 'OFF', 'PERM', 'QUE', 'QUOTA', 'RUN'].sort(),
    );
    const cards = [...first, ...second];
    expect(new Set(cards.map((c) => c.code))).toEqual(new Set(Object.keys(expected)));
    for (const c of cards) {
      expect(c, c.code).toEqual({
        code: c.code,
        border: expected[c.code],
        badge: expected[c.code],
        badgeCode: c.code,
      });
    }
    expect(await findGreenOutsideDone(page)).toEqual([]);
  });

  test('減少動態：外圈靜止', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCanvas(page);
    expect(await ring(page, 's-auth')).toEqual({ name: 'none', opacity: '0.5' });
  });

  test('縮小時狀態徽章與名稱跟著放大，螢幕上仍看得清楚', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    for (let i = 0; i < 4; i += 1) {
      await page.getByRole('button', { name: '縮小' }).click();
    }
    expect(await zoomLevel(page)).toBeLessThan(30);
    const lamp = (await card(page, 's-auth').locator('.lamp').boundingBox())!;
    // 符號＋代碼在螢幕上至少約 11px 高。
    expect(lamp.height).toBeGreaterThanOrEqual(11);
    await shot(page, 'status-zoomed-out');
  });
});

test.describe('線上標籤不擋卡片（審查回饋 2026-11-06）', () => {
  const event = (page: Page, at: string, type: string, payload: object) =>
    patchStore(
      page,
      `useBoard.getState().backend.addSessionEvent(${JSON.stringify(at)}, ${JSON.stringify(type)}, ${JSON.stringify(payload)});`,
    );

  test('播完再過幾秒，完整標籤收成次數徽章；滑過線或聚焦徽章再展開', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await event(page, 's-etl', 'dispatch.send', {
      fromSessionId: 's-etl',
      toSessionId: 's-docs',
      workId: 'w1',
      summary: 'Rewrite the README.',
    });
    const label = page.getByTestId('handoff-label-s-etl-s-docs');
    await expect(label).toHaveAttribute('data-expanded', 'true');
    await expect(label).toContainText(/已排入 \d\d:\d\d/);
    await expect(label).toContainText('Rewrite the README.');
    // 動畫 4 秒＋多留 3 秒後收起。
    await expect(label).not.toHaveAttribute('data-expanded', { timeout: 10_000 });
    await expect(label).toHaveAttribute('data-phase', 'recent');
    await expect(label).not.toContainText('已排入');
    await expect(label).not.toContainText('Rewrite');
    const badge = page.getByTestId('pair-count-s-etl-s-docs');
    await expect(badge).toHaveText('1');
    // 鍵盤聚焦徽章：展開。
    await badge.focus();
    await expect(label).toHaveAttribute('data-expanded', 'true');
    await expect(label).toContainText(/已排入 \d\d:\d\d/);
    await badge.blur();
    await expect(label).not.toHaveAttribute('data-expanded');
    // 點徽章仍然打開紀錄。
    await badge.click();
    await expect(page.getByTestId('pair-popover-s-etl-s-docs')).toBeVisible();
  });

  test('相鄰卡片之間的往來：次數徽章與交接條件不壓在任何卡片上', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await patchStore(
      page,
      `useBoard.getState().backend.patchSession('s-docs', { dispatchedBy: 's-tests' });`,
    );
    const pairs: [string, string, string, object][] = [
      ['s-tests', 'dispatch.send', 's-docs', { workId: 'w1', summary: 'A' }],
      ['s-docs', 'dispatch.result', 's-tests', { workId: 'w0', summary: 'B' }],
      ['s-ml', 'dispatch.result', 's-etl', { workId: 'w2', summary: 'C' }],
      ['s-auth', 'task.dispatched', 's-etl', { taskId: 't', kind: 'review' }],
    ];
    for (const [from, type, to, extra] of pairs) {
      const at = type === 'task.dispatched' ? to : from;
      await event(page, at, type, { fromSessionId: from, toSessionId: to, ...extra });
    }
    // 收成徽章後量。
    await expect(page.locator('.edge-label[data-expanded]')).toHaveCount(0, { timeout: 10_000 });
    const cards = await page
      .locator('.react-flow__node')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
    const labels = page.locator('.edge-count, [data-testid^="handoff-s-"]');
    await expect(labels).toHaveCount(5);
    const boxes = await labels.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect),
    );
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const box of boxes) {
      for (const c of cards) expect(hit(box, c), JSON.stringify({ box, c })).toBe(false);
    }
    // 標籤彼此也不重疊。
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) expect(hit(boxes[i]!, boxes[j]!)).toBe(false);
    }
    await shot(page, 'labels-in-gaps');
  });

  test('「線」的圖例一開始收著；點別的地方或按 Esc 收起', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const toggle = page.getByTestId('link-panel').getByRole('button', { name: /^線/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.link-legend')).toHaveCount(0);
    await toggle.click();
    await expect(page.locator('.link-legend')).toBeVisible();
    // 點開關不會收起。
    await page.getByTestId('link-filter-task').click();
    await expect(page.locator('.link-legend')).toBeVisible();
    await page.getByTestId('link-filter-task').click();
    await page.mouse.click(720, 860);
    await expect(page.locator('.link-legend')).toHaveCount(0);
    await toggle.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.link-legend')).toHaveCount(0);
  });
});

test.describe('團隊框質感與拖線把手（P2 §4）', () => {
  const TEAMS = '/src/team/store.ts';
  const opacity = (loc: ReturnType<Page['locator']>) =>
    loc.evaluate((el) => getComputedStyle(el).opacity);
  const handleOf = (page: Page, id: string, kind: 'source' | 'target') =>
    card(page, id).locator(`.ab-handle.${kind}`);
  /** 畫布上目前的交接規則（團隊 store 的 rules），只取比對要用的欄位。 */
  const rules = (page: Page) =>
    page.evaluate(async (url) => {
      const { useTeams } = await import(/* @vite-ignore */ url);
      return (
        useTeams.getState().rules as {
          fromSessionId: string;
          action: { toSessionId: string };
          enabled: boolean;
        }[]
      )
        .map((r) => `${r.fromSessionId}->${r.action.toSessionId}:${r.enabled ? 'on' : 'off'}`)
        .sort();
    }, TEAMS);
  const menuOf = (page: Page, id: string) =>
    card(page, id).getByRole('button', { name: /的更多動作$/ });
  const viewport = (page: Page) =>
    page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);

  test('滑鼠：把手平常隱藏、移入卡片才出現；拖線中所有目標把手都出現，建立關閉中的交接線', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await page.mouse.move(2, 2);
    for (const h of await page.locator('.ab-handle').all()) {
      await expect.poll(() => opacity(h)).toBe('0');
    }

    // 移入卡片：只有這張卡的兩個把手出現。
    await card(page, 's-tests').locator('.tail').hover();
    await expect.poll(() => opacity(handleOf(page, 's-tests', 'source'))).toBe('1');
    await expect.poll(() => opacity(handleOf(page, 's-tests', 'target'))).toBe('1');
    expect(await opacity(handleOf(page, 's-etl', 'target'))).toBe('0');
    await shot(page, 'handles-hover');

    // 拖線中：別張卡的目標把手都看得到（來源把手不用）。
    const from = (await handleOf(page, 's-tests', 'source').boundingBox())!;
    const to = (await handleOf(page, 's-etl', 'target').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x - 60, to.y + 80, { steps: 6 });
    await expect.poll(() => opacity(handleOf(page, 's-etl', 'target'))).toBe('1');
    await expect.poll(() => opacity(handleOf(page, 's-auth', 'target'))).toBe('1');
    await expect.poll(() => opacity(handleOf(page, 's-ml', 'target'))).toBe('1');
    expect(await opacity(handleOf(page, 's-ml', 'source'))).toBe('0');
    // 出發卡自己的目標把手不算可放置（不能連到自己）。
    expect(await node(page, 's-tests').getAttribute('data-connect-source')).toBe('true');
    expect(await opacity(handleOf(page, 's-tests', 'target'))).toBe('0');
    await shot(page, 'handles-connecting');
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId('handoff-s-tests-s-etl')).toContainText('完成時交接');
    expect(await rules(page)).toContain('s-tests->s-etl:off');

    // 放開後恢復隱藏。
    await page.mouse.move(2, 2);
    await expect.poll(() => opacity(handleOf(page, 's-ml', 'target'))).toBe('0');
    await expect.poll(() => opacity(handleOf(page, 's-etl', 'target'))).toBe('0');
    expect(await page.locator('[data-connect-source]').count()).toBe(0);
  });

  test('鍵盤：Tab 到卡片時把手出現；「建立交接線…」可全程用鍵盤完成，Esc 取消', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await page.mouse.move(2, 2);
    await expect.poll(() => opacity(handleOf(page, 's-auth', 'source'))).toBe('0');
    const before = await rules(page);

    // Tab 到第一張卡（xyflow 節點可取得焦點）。
    const focusedNode = () =>
      page.evaluate(() =>
        document.activeElement?.classList.contains('react-flow__node')
          ? document.activeElement.getAttribute('data-id')
          : null,
      );
    for (let i = 0; i < 80 && !(await focusedNode()); i += 1) await page.keyboard.press('Tab');
    const first = await focusedNode();
    expect(first).not.toBeNull();
    await expect.poll(() => opacity(handleOf(page, first!, 'source'))).toBe('1');
    await expect.poll(() => opacity(handleOf(page, first!, 'target'))).toBe('1');

    // 選單：⋯ → 建立交接線…（Tab 到它、Enter）→ Tab 到目標卡按 Enter。
    await menuOf(page, 's-tests').focus();
    await page.keyboard.press('Enter');
    const item = card(page, 's-tests').getByRole('menuitem', { name: '建立交接線…' });
    await expect(card(page, 's-tests').getByRole('menuitem', { name: '重新命名' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    const hint = page.getByTestId('link-pick');
    await expect(hint).toContainText('點要交接給誰的卡片；Esc 或 ✕ 取消');
    await expect(card(page, 's-tests')).toHaveAttribute('data-pick', 'source');
    await shot(page, 'link-pick');

    // Esc 取消：不建立。
    await page.keyboard.press('Escape');
    await expect(hint).toHaveCount(0);
    await expect(card(page, 's-tests')).not.toHaveAttribute('data-pick');

    await menuOf(page, 's-tests').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(hint).toBeVisible();
    await node(page, 's-etl').focus();
    await page.keyboard.press('Enter');
    await expect(hint).toHaveCount(0);
    await expect(page.getByTestId('handoff-s-tests-s-etl')).toContainText('完成時交接');
    expect(await rules(page)).toEqual([...before, 's-tests->s-etl:off'].sort());

    // 同方向已經有了：明確說一聲，不重複建立。
    await menuOf(page, 's-tests').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await node(page, 's-etl').focus();
    await page.keyboard.press('Enter');
    await expect(hint).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('這條交接線已經有了');
    expect(await rules(page)).toEqual([...before, 's-tests->s-etl:off'].sort());

    // 選目標中按 Esc 只取消選目標：不再往下傳給其他 Esc 處理（關交接線小視窗、清除聚焦…）。
    await page.evaluate(() => {
      const w = window as never as { __esc: number };
      w.__esc = 0;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') w.__esc += 1;
      });
    });
    const escSeen = () => page.evaluate(() => (window as never as { __esc: number }).__esc);
    await menuOf(page, 's-tests').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(hint).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hint).toHaveCount(0);
    expect(await escSeen()).toBe(0);
    // 沒有在選目標時，Esc 照常傳下去。
    await page.keyboard.press('Escape');
    expect(await escSeen()).toBe(1);

    // 兩張都不在團隊：和拖線一樣的錯誤，不建立。
    await menuOf(page, 's-ml').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await node(page, 's-docs').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('交接規則屬於團隊');
    expect(await rules(page)).toHaveLength(before.length + 1);
  });

  test.describe('觸控（沒有 hover）', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

    test('把手一律隱藏；選單「建立交接線…」→ 點 B 卡建立；點空白或 ✕ 取消', async ({ page }) => {
      await openCanvas(page);
      expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
      for (const h of await page.locator('.ab-handle').all()) {
        expect(await h.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
      }
      const before = await rules(page);

      // 點空白處取消：不建立。
      await menuOf(page, 's-tests').tap();
      await card(page, 's-tests').getByRole('menuitem', { name: '建立交接線…' }).tap();
      const hint = page.getByTestId('link-pick');
      await expect(hint).toBeVisible();
      // 第二列中間那張卡下方的空白（離卡夠遠，觸控的點擊校正不會吸到卡上）。
      // 團隊框右邊的進度卡與變寬的底部指令列（P3 加了 Memory）也佔畫面：碰到就往右移到它外面。
      const docs = (await card(page, 's-docs').boundingBox())!;
      const blankY = docs.y + docs.height + 40;
      expect(blankY).toBeLessThan(768 - 40);
      let blankX = docs.x + docs.width / 2;
      for (const a of await page.locator('.progress-anchor, [data-testid="command-bar"]').all()) {
        const box = (await a.boundingBox())!;
        if (
          blankX >= box.x - 40 &&
          blankX <= box.x + box.width + 40 &&
          blankY >= box.y - 40 &&
          blankY <= box.y + box.height + 40
        ) {
          blankX = box.x + box.width + 60;
        }
      }
      await page.touchscreen.tap(blankX, blankY);
      await expect(hint).toHaveCount(0);
      expect(await rules(page)).toEqual(before);

      // ✕ 取消。
      await menuOf(page, 's-tests').tap();
      await card(page, 's-tests').getByRole('menuitem', { name: '建立交接線…' }).tap();
      await hint.getByRole('button', { name: '取消建立交接線' }).tap();
      await expect(hint).toHaveCount(0);

      // 點自己不算；點 B 卡＝建立。卡片裡的按鈕這時不吃點擊。
      await menuOf(page, 's-tests').tap();
      await card(page, 's-tests').getByRole('menuitem', { name: '建立交接線…' }).tap();
      await card(page, 's-tests').tap();
      await expect(hint).toBeVisible();
      await card(page, 's-etl').tap();
      await expect(hint).toHaveCount(0);
      await expect(page.getByTestId('handoff-s-tests-s-etl')).toContainText('完成時交接');
      expect(await rules(page)).toEqual([...before, 's-tests->s-etl:off'].sort());
    });
  });

  test('團隊框：毛玻璃、16px 圓角、中性白光暈；不含任何狀態色', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const team = page.locator('.team').first();
    // 初次「全部顯示」移鏡頭時暫時沒有模糊，停下來後才放回。
    await expect
      .poll(() => team.evaluate((el) => getComputedStyle(el).backdropFilter))
      .toContain('blur');
    const style = await team.evaluate((el) => {
      const cs = getComputedStyle(el);
      const z = Number(getComputedStyle(el.closest('.canvas')!).getPropertyValue('--z'));
      return {
        blur: cs.backdropFilter,
        radius: parseFloat(cs.borderTopLeftRadius) * z,
        shadow: cs.boxShadow,
        label: getComputedStyle(el.querySelector(':scope > span')!).backdropFilter,
      };
    });
    expect(style.blur).toContain('blur');
    expect(style.label).toContain('blur');
    expect(style.radius).toBeCloseTo(16, 0);
    // 光暈、陰影只有中性色（r = g = b）。
    const colors = [...style.shadow.matchAll(/rgba?\((\d+), (\d+), (\d+)/g)];
    expect(colors.length).toBeGreaterThan(0);
    for (const [, r, g, b] of colors) expect([r, r]).toEqual([g, b]);

    // 掃描所有樣式表裡跟團隊框有關的規則（含媒體查詢）與行內樣式：不得出現狀態色變數。
    const found = await page.evaluate(() => {
      const texts: string[] = [];
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule && /\.team(?![\w-])/.test(rule.selectorText)) {
            texts.push(rule.cssText);
          }
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
      for (const el of Array.from(document.querySelectorAll('.team, .team *'))) {
        texts.push((el as HTMLElement).style.cssText);
      }
      return texts;
    });
    expect(found.length).toBeGreaterThan(3);
    for (const text of found) {
      expect(text).not.toMatch(/--(you|fault|agent|quota|idle|c-[\w-]+|st)\b/);
    }

    // 再量實際算出來的顏色（含套到框裡按鈕的全域樣式，平常、hover、focus 各一次）：
    // 不得和任何狀態色變數解析後的顏色相同。
    const statusColors = await page.evaluate(() => {
      const names = new Set<string>();
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule) {
            for (const prop of Array.from(rule.style)) {
              if (/^--(you|fault|agent|quota|idle|c-[\w-]+)$/.test(prop)) names.add(prop);
            }
          }
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
      const probe = document.createElement('i');
      document.querySelector('.canvas')!.append(probe);
      const out: Record<string, string> = {};
      for (const name of names) {
        probe.style.color = `var(${name})`;
        out[name] = getComputedStyle(probe).color;
      }
      probe.remove();
      return out;
    });
    expect(Object.keys(statusColors)).toEqual(expect.arrayContaining(['--you', '--c-ask']));
    const computedColors = () =>
      page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('.team, .team *'))) {
          const cs = getComputedStyle(el);
          out.push(
            cs.borderTopColor,
            cs.borderLeftColor,
            cs.backgroundColor,
            cs.outlineColor,
            cs.color,
            ...[...cs.boxShadow.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0]),
          );
        }
        return out;
      });
    const assertNoStatusColor = async (when: string) => {
      const used = new Set(await computedColors());
      for (const [name, color] of Object.entries(statusColors)) {
        expect(used.has(color), `${when}：${name} ${color}`).toBe(false);
      }
    };
    await assertNoStatusColor('平常');
    const tidyButton = page.locator('.team .team-tidy').first();
    await tidyButton.hover();
    await assertNoStatusColor('hover');
    await page.mouse.move(2, 2);
    await tidyButton.focus();
    await assertNoStatusColor('focus');
    await shot(page, 'team-frame-glass');
  });

  test('在團隊框內拖動：畫布平移、不開任何東西；平移中暫時拿掉模糊；只點一下（沒拖）開團隊面板', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const auth = (await card(page, 's-auth').boundingBox())!;
    const tests = (await card(page, 's-tests').boundingBox())!;
    const frame = (await page.locator('.team').first().boundingBox())!;
    // 兩張隊員卡中間的空隙：在框裡、不在卡上。
    const left = Math.min(auth.x + auth.width, tests.x + tests.width);
    const right = Math.max(auth.x, tests.x);
    const x = (left + right) / 2;
    const y = auth.y + auth.height / 2;
    expect(x).toBeGreaterThan(frame.x);
    expect(x).toBeLessThan(frame.x + frame.width);
    const hash = await page.evaluate(() => location.hash);
    const before = await viewport(page);
    const cardBefore = await position(page, 's-auth');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 4 });
    await expect(page.locator('.canvas')).toHaveAttribute('data-moving', 'true');
    expect(
      await page
        .locator('.team')
        .first()
        .evaluate((el) => getComputedStyle(el).backdropFilter),
    ).toBe('none');
    await page.mouse.move(x + 140, y + 90, { steps: 4 });
    await page.mouse.up();

    await expect.poll(() => viewport(page)).not.toBe(before);
    await expect(page.locator('.canvas')).not.toHaveAttribute('data-moving');
    await expect
      .poll(() =>
        page
          .locator('.team')
          .first()
          .evaluate((el) => getComputedStyle(el).backdropFilter),
      )
      .toContain('blur');
    expect(await position(page, 's-auth')).toBe(cardBefore);
    // 拖動不開面板（P2 §4.4 驗收 6 前半）。
    expect(await page.evaluate(() => location.hash)).toBe(hash);
    await expect(page.getByTestId('team-panel')).toHaveCount(0);
    await expect(page.getByTestId('link-pick')).toHaveCount(0);
    await expect(page.getByTestId('quick-create')).toHaveCount(0);

    // 只點一下（沒有拖動）框內空白處：打開這個團隊的面板（P2 §1.2、§4.4 驗收 6 後半，項目二完成後）。
    // 點本身不能讓畫面動、也不能讓團隊框的模糊拿掉再放回（不閃）：在面板打開（hash 變）之前，
    // data-moving 一次都沒出現、viewport 和點之前一樣。面板打開之後依 §1 的 #/team/<id> 規則聚焦團隊框，那是另一回事。
    const clickVp = await viewport(page);
    await page.evaluate(() => {
      const el = document.querySelector('.canvas')!;
      const vp = document.querySelector<HTMLElement>('.react-flow__viewport')!;
      const w = window as never as { __movingBeforeOpen: number; __vpAtOpen: string | null };
      const start = location.hash;
      w.__movingBeforeOpen = 0;
      w.__vpAtOpen = null;
      new MutationObserver(() => {
        if (el.hasAttribute('data-moving') && location.hash === start) w.__movingBeforeOpen += 1;
      }).observe(el, { attributes: true, attributeFilter: ['data-moving'] });
      // 每一格記下面板打開（hash 變）之前最後看到的 viewport。
      const watch = () => {
        if (location.hash !== start) return;
        w.__vpAtOpen = vp.style.transform;
        requestAnimationFrame(watch);
      };
      watch();
    });
    const moved = (await page.locator('.team').first().boundingBox())!;
    await page.mouse.click(moved.x + moved.width - 12, moved.y + 12);
    await expect(page).toHaveURL(/#\/team\/team-demo-auth$/);
    const atOpen = await page.evaluate(() => {
      const w = window as never as { __movingBeforeOpen: number; __vpAtOpen: string | null };
      return { moving: w.__movingBeforeOpen, vp: w.__vpAtOpen };
    });
    expect(atOpen).toEqual({ moving: 0, vp: clickVp });
    await expect(page.getByTestId('team-panel')).toBeVisible();
    expect(await position(page, 's-auth')).toBe(cardBefore);
  });

  for (const view of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`一鍵整理後團隊之間在畫面上至少 36px（GM 2026-11-09 放寬）（${view.width}px）`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize(view);
      await page.goto('/#/canvas');
      await expect(card(page, 's-auth')).toBeVisible();
      await page.getByRole('button', { name: '整理畫布' }).click();
      await expect(page.getByTestId('tidy-toast')).toBeVisible();
      await page.waitForTimeout(300);
      const z = await page
        .locator('.canvas')
        .evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--z')));
      expect(z).toBeGreaterThanOrEqual(0.15 - 1e-6);
      // 螢幕上：團隊框和框外的卡、和別的團隊框之間的最小距離。
      const min = await page.evaluate(() => {
        type R = { x: number; y: number; r: number; b: number };
        const box = (el: Element): R => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, r: r.right, b: r.bottom };
        };
        const gap = (a: R, b: R) => Math.max(b.x - a.r, a.x - b.r, b.y - a.b, a.y - b.b);
        const frames = Array.from(document.querySelectorAll('.team')).map(box);
        const cards = Array.from(document.querySelectorAll('.react-flow__node')).map(box);
        let out = Infinity;
        for (const f of frames) {
          for (const c of cards) if (gap(f, c) > 0) out = Math.min(out, gap(f, c));
          for (const g of frames) if (g !== f && gap(f, g) > 0) out = Math.min(out, gap(f, g));
        }
        return { out, frames: frames.length };
      });
      expect(min.frames).toBeGreaterThan(0);
      expect(min.out).not.toBe(Infinity);
      // 縮放剛好停在 0.15 時是 240 × 0.15＝36，量到的螢幕座標有次像素誤差（例如 35.99995）。
      expect(min.out).toBeGreaterThanOrEqual(36 - 0.01);
    });
  }

  test('減少透明度（prefers-reduced-transparency）：沒有背景模糊，退回 1px 框＋8% 底', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    await openCanvas(page);
    expect(
      await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches),
    ).toBe(true);
    const team = page.locator('.team').first();
    const style = await team.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        blur: cs.backdropFilter,
        shadow: cs.boxShadow,
        label: getComputedStyle(el.querySelector(':scope > span')!).backdropFilter,
        bg: cs.backgroundColor,
      };
    });
    expect(style.blur).toBe('none');
    expect(style.label).toBe('none');
    expect(style.shadow).toBe('none');
    // 8% 團隊色底（不是透明的深色底）。
    expect(style.bg).toMatch(/0\.08\)$/);
  });
});

test.describe('疊加面板（P2 §1.6 驗收）', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const viewport = (page: Page) =>
    page.locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);

  /** 記下終端機的訂閱與送出的訊息：畫布若被卸載重掛，訂閱數會變多。 */
  async function watchTerminal(page: Page) {
    await patchStore(
      page,
      `const t = useBoard.getState().backend.terminal;
       window.__subs = 0; window.__sent = [];
       const sub = t.subscribe.bind(t); const send = t.send.bind(t);
       t.subscribe = (...a) => { window.__subs += 1; return sub(...a); };
       t.send = (m) => { window.__sent.push(m); return send(m); };`,
    );
  }
  const subs = (page: Page) => page.evaluate(() => (window as never as { __subs: number }).__subs);
  const sent = (page: Page) =>
    page.evaluate(
      () =>
        (window as never as { __sent: { type: string; data?: string; signal?: string }[] }).__sent,
    );

  test('1. 開關收件匣、團隊、設定：畫布位置與縮放不變，終端機不重新訂閱', async ({ page }) => {
    await openCanvas(page);
    await watchTerminal(page);
    const auth = card(page, 's-auth');
    await auth.locator('.tail').dblclick();
    await expect(auth).toHaveAttribute('data-mode', 'terminal');
    await expect(auth.locator('.xterm')).toBeVisible();
    // 平移＋縮放到別的位置
    await page.getByRole('button', { name: '放大' }).click();
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + 60, pane.y + pane.height - 60);
    await page.mouse.down();
    await page.mouse.move(pane.x + 160, pane.y + pane.height - 120, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const before = await viewport(page);
    const subscribed = await subs(page);
    expect(subscribed).toBeGreaterThan(0);

    await page.getByTestId('inbox-button').click();
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    await page.getByTestId('inbox-close').click();
    await expect(page.getByTestId('inbox-drawer')).toHaveCount(0);

    await page.evaluate(() => (location.hash = '#/team'));
    await expect(page.getByTestId('team-panel')).toBeVisible();
    await page.getByTestId('team-close').click();
    await expect(page.getByTestId('team-panel')).toHaveCount(0);

    await page.getByTestId('settings-button').click();
    await expect(page.getByTestId('modal')).toBeVisible();
    await page.getByTestId('modal-close').click();
    await expect(page.getByTestId('modal')).toHaveCount(0);

    await expect(page).toHaveURL(/#\/canvas$/);
    expect(await viewport(page)).toBe(before);
    expect(await subs(page)).toBe(subscribed);
    await expect(auth).toHaveAttribute('data-mode', 'terminal');
  });

  test('2. 直接開 #/inbox/<id>（PERM）：畫布在底、抽屜開著、那一項展開並高亮；允許一次後消失、抽屜還在', async ({
    page,
  }) => {
    await page.goto('/#/inbox/s-auth');
    await expect(card(page, 's-auth')).toBeVisible();
    const drawer = page.getByTestId('inbox-drawer');
    await expect(drawer).toBeVisible();
    const row = page.getByTestId('queue-s-auth');
    await expect(row).toHaveClass(/targeted/);
    await expect(page.getByTestId('inbox-toggle-s-auth')).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('review-a-1').getByRole('button', { name: '允許一次' }).click();
    await expect(row).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/#\/inbox\/s-auth$/);
  });

  test('3. 手機 390×844 開 #/inbox/<id>：全螢幕收件匣，那一項在可視範圍', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/inbox/s-etl');
    const item = page.getByTestId('inbox-a-2');
    await expect(item).toBeInViewport();
    await expect(item).toHaveClass(/targeted/);
    await expect(page.locator('.react-flow')).toHaveCount(0);
    await expect(page.getByTestId('inbox-drawer')).toHaveCount(0);
  });

  test('4. 推播訊息 agent-board.open：抽屜打開並捲到那一項，頁面沒有重新載入', async ({ page }) => {
    await openCanvas(page);
    await page.evaluate(() => Object.assign(window, { __sameLoad: true }));
    const post = (id: string) =>
      page.evaluate((target) => {
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'agent-board.open', url: `${location.origin}/#/inbox/${target}` },
          }),
        );
      }, id);
    await post('s-auth');
    await expect(page).toHaveURL(/#\/inbox\/s-auth$/);
    await expect(page.getByTestId('queue-s-auth')).toHaveClass(/targeted/);
    // 抽屜已開著，又來一則：捲到新的那一項
    await post('s-ml');
    await expect(page.getByTestId('queue-s-ml')).toHaveClass(/targeted/);
    await expect(page.getByTestId('queue-s-ml')).toBeInViewport();
    expect(
      await page.evaluate(() => (window as never as { __sameLoad?: boolean }).__sameLoad),
    ).toBe(true);
  });

  test('5. 舊網址 #/queue、#/review/<id> 轉成新網址，上一頁不會回到舊網址', async ({ page }) => {
    await openCanvas(page);
    await page.evaluate(() => (location.hash = '#/queue'));
    await expect(page).toHaveURL(/#\/inbox$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/canvas$/);
    await expect(page.getByTestId('inbox-drawer')).toHaveCount(0);
    await page.evaluate(() => (location.hash = '#/review/s-auth'));
    await expect(page).toHaveURL(/#\/inbox\/s-auth$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/canvas$/);
    await page.goForward();
    await expect(page).toHaveURL(/#\/inbox\/s-auth$/);
    // #/archive（沒有 id）→ 設定的封存分類
    await page.evaluate(() => (location.hash = '#/archive'));
    await expect(page).toHaveURL(/#\/settings\/archived$/);
    await expect(page.locator('#s-archived')).toBeVisible();
  });

  test('6. 焦點在終端機時 Esc 交給終端機；不在輸入元件時 Esc 關最上層', async ({ page }) => {
    await openCanvas(page);
    await watchTerminal(page);
    const auth = card(page, 's-auth');
    await auth.locator('.tail').dblclick();
    await expect(auth.locator('.xterm')).toBeVisible();
    await page.evaluate(() => (location.hash = '#/inbox'));
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    await auth.locator('.xterm').click();
    await expect(auth.locator('.xterm-helper-textarea')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    expect(
      (await sent(page)).some(
        (m) =>
          (m.type === 'terminal.input' && m.data?.includes('\x1b')) ||
          (m.type === 'terminal.signal' && m.signal === 'escape'),
      ),
    ).toBe(true);
    // I 在打字時也不觸發
    await page.keyboard.press('i');
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inbox-drawer')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/canvas$/);
    // I 開關收件匣
    await page.keyboard.press('i');
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    await page.keyboard.press('i');
    await expect(page.getByTestId('inbox-drawer')).toHaveCount(0);
  });

  test('7＋10. 收件匣與團隊互斥；設定疊在上面、焦點鎖在設定裡，關設定後右側面板還在', async ({
    page,
  }) => {
    await openCanvas(page);
    await page.getByTestId('inbox-button').click();
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    await page.evaluate(() => (location.hash = '#/team'));
    await expect(page.getByTestId('team-panel')).toBeVisible();
    await expect(page.getByTestId('inbox-drawer')).toHaveCount(0);

    await page.getByTestId('settings-button').click();
    const modal = page.getByTestId('modal');
    await expect(modal).toBeVisible();
    await expect(page.getByTestId('team-panel')).toBeVisible();
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.querySelector('[data-testid="modal"]')?.contains(document.activeElement) ??
            false,
        ),
      ).toBe(true);
    }
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(
        await page.evaluate(
          () =>
            document.querySelector('[data-testid="modal"]')?.contains(document.activeElement) ??
            false,
        ),
      ).toBe(true);
    }
    // Esc 只關最上層（焦點在連結或按鈕上，不是輸入框）
    await modal.getByRole('link', { name: '我的帳號' }).focus();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('team-panel')).toBeVisible();
    await expect(page).toHaveURL(/#\/team$/);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('team-panel')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/canvas$/);

    // 點暗化背景也關設定
    await page.getByTestId('settings-button').click();
    await expect(modal).toBeVisible();
    await page.getByTestId('modal-backdrop').click({ position: { x: 10, y: 450 } });
    await expect(modal).toHaveCount(0);
  });

  test('8. 收件匣不列 NEW；「等你 N」＝收件匣列數', async ({ page }) => {
    await openCanvas(page);
    await patchStore(
      page,
      `const s = useBoard.getState();
       useBoard.setState({ sessions: s.sessions.map((x) => x.id === 's-tests'
         ? { ...x, status: 'waiting_input', statusDetail: 'idle:start' } : x) });`,
    );
    // 剛開好的是 NEW 灰（不算等你，GM 2026-11-08 色彩決定）；收件匣不列，規則改在畫布卡片守著。
    await expect(card(page, 's-tests').locator('.lamp')).toHaveText('◌NEW');
    await expect(card(page, 's-tests').locator('.lamp')).toHaveCSS(
      'background-color',
      'rgb(154, 164, 178)',
    );
    await page.getByTestId('inbox-button').click();
    await expect(page.getByTestId('queue-s-tests')).toHaveCount(0);
    const n = Number(await page.getByTestId('waiting-count').textContent());
    await expect(page.getByTestId('inbox-drawer').locator('.triage-row')).toHaveCount(n);
    await expect(page.getByTestId('inbox-button').locator('b')).toHaveText(String(n));
  });

  test('9. 頁首沒有分頁列；原分頁的功能都還到得了', async ({ page }) => {
    await openCanvas(page);
    await expect(page.locator('nav.tabs')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '主要分頁' })).toHaveCount(0);
    // 待處理、審核：收件匣（排序切換＋展開審核卡）
    await page.getByTestId('inbox-button').click();
    await expect(page.getByTestId('inbox-sort-group')).toBeVisible();
    await page.getByTestId('inbox-toggle-s-auth').click();
    await expect(page.getByTestId('review-a-1')).toBeVisible();
    // 團隊清單、團隊詳細、找不到的團隊
    await page.evaluate(() => (location.hash = '#/team'));
    await expect(page.getByTestId('team-list')).toBeVisible();
    await page
      .getByTestId('team-panel')
      .getByRole('link', { name: /登入重構/ })
      .click();
    await expect(page).toHaveURL(/#\/team\/team-demo-auth$/);
    await expect(page.getByTestId('team-workbench')).toBeVisible();
    await page.evaluate(() => (location.hash = '#/team/nope'));
    await expect(page.getByTestId('team-not-found')).toHaveText('找不到這個團隊，可能已經被刪除。');
    await expect(page.getByTestId('team-list')).toBeVisible();
    // 設定各分類
    await page.evaluate(() => (location.hash = '#/settings/notify'));
    await expect(
      page.getByRole('navigation', { name: '設定分類' }).getByRole('link', { name: '通知' }),
    ).toHaveAttribute('aria-current', 'page');
    // 新增 session（完整表單）
    await page.evaluate(() => (location.hash = '#/new'));
    await expect(
      page.getByTestId('modal').getByRole('button', { name: '建立 session' }),
    ).toBeVisible();
  });

  test('開團隊：畫布把成員框進看得到的地方（不被面板蓋住）', async ({ page }) => {
    await openCanvas(page);
    await page.evaluate(() => (location.hash = '#/team/team-demo-auth'));
    await expect(page.getByTestId('team-workbench')).toBeVisible();
    const panel = (await page.getByTestId('team-panel').boundingBox())!;
    for (const id of ['s-auth', 's-tests']) {
      await expect(card(page, id)).toBeInViewport();
      await expect
        .poll(async () => {
          const b = (await card(page, id).boundingBox())!;
          return b.x + b.width <= panel.x + 1;
        })
        .toBe(true);
    }
  });
});

test.describe('全部暫停＋底部指令列（P2 §3）', () => {
  const bar = (page: Page) => page.getByTestId('command-bar');
  const strip = (page: Page) => page.getByTestId('pause-strip');
  const lamp = (page: Page, id: string) => card(page, id).locator('.lamp');

  test('指令列：新增 session、群組、Presets、Memory、全部暫停、全部繼續；沒暫停時「全部繼續」停用', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    // P3 項目二上線 Presets（docs/p3-spec.md §1.5 的底部列順序）；Memory 隨項目一上線。
    await expect(bar(page).getByRole('button')).toHaveText([
      /新增 session/,
      '群組',
      'Presets',
      'Memory',
      /全部暫停/,
      /全部繼續/,
    ]);
    await expect(page.getByTestId('resume-button')).toBeDisabled();
    await expect(page.getByTestId('pause-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(strip(page)).toHaveCount(0);

    // 不擋右下的小地圖與縮放列。
    const barBox = (await bar(page).boundingBox())!;
    for (const other of [page.locator('.minimap'), page.locator('.canvas .zoom')]) {
      const box = (await other.boundingBox())!;
      const overlap =
        barBox.x < box.x + box.width &&
        box.x < barBox.x + barBox.width &&
        barBox.y < box.y + box.height &&
        box.y < barBox.y + barBox.height;
      expect(overlap).toBe(false);
    }
    await shot(page, 'command-bar');

    // 群組：開右側的團隊清單，再按一次收起來。
    await page.getByTestId('command-teams').click();
    await expect(page).toHaveURL(/#\/team$/);
    await expect(page.getByTestId('team-panel')).toBeVisible();
    await expect(page.getByTestId('command-teams')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('command-teams').click();
    await expect(page.getByTestId('team-panel')).toHaveCount(0);

    // Shift＋新增 session：完整表單。
    await page.getByTestId('command-new').click({ modifiers: ['Shift'] });
    await expect(page).toHaveURL(/#\/new/);
    await expect(page.getByTestId('modal')).toBeVisible();
  });

  test('做完這輪就停：按一次就暫停；RUN 繼續跑；交接被擋下排隊，繼續後才送達', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await page.getByTestId('pause-button').click();
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-finish-turn').click();

    await expect(strip(page)).toContainText('已暫停（做完這輪就停）');
    await expect(strip(page)).toContainText('沒有排隊中的');
    await expect(strip(page)).toContainText(/\d\d:\d\d 起・demo/);
    await expect(page.getByTestId('pause-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('pause-button')).toContainText('已暫停：做完這輪就停');
    await expect(page.getByTestId('pause-msg')).toHaveText('已暫停：做完這輪就停。');
    // 暫停中再打開選單，標得出目前的模式：白框＋淡底（以前 CSS 選錯屬性，看不出來）。
    await page.getByTestId('pause-button').click();
    await expect(page.getByTestId('pause-finish-turn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('pause-finish-turn')).toHaveCSS(
      'border-top-color',
      'rgb(255, 255, 255)',
    );
    await expect(page.getByTestId('pause-finish-turn')).toHaveCSS(
      'background-color',
      'rgba(255, 255, 255, 0.1)',
    );
    // 沒選中的項目：浮層選單項目（controls.css .menu-item）沒有框，只有選中的才有白框。
    await expect(page.getByTestId('pause-interrupt')).toHaveCSS(
      'border-top-color',
      'rgba(0, 0, 0, 0)',
    );
    await page.getByTestId('pause-button').click();
    await expect(page.getByTestId('pause-menu')).toHaveCount(0);
    await expect(page.getByTestId('resume-button').first()).toBeEnabled();
    await expect(page.getByTestId('resume-release')).toHaveText('會放出：沒有排隊中的');
    // 做完這輪就停不送 Esc：RUN 照樣在跑。
    await expect(lamp(page, 's-tests')).toHaveText('●RUN');

    // 交接觸發了，但目標沒收到：排隊 +1，「全部繼續」旁先講會放出什麼。
    await patchStore(page, `useBoard.getState().backend.emitHandoff('s-auth', 's-tests');`);
    await expect(page.getByTestId('pause-held')).toHaveText('排隊：排隊送字 1 則');
    await expect(page.getByTestId('resume-release')).toHaveText('會放出：排隊送字 1 則');
    await expect(page.getByTestId('handoff-label-s-auth-s-tests')).not.toHaveAttribute(
      'data-talk',
      'delivered',
    );
    await shot(page, 'paused-finish-turn');

    // 暫停中 GM 自己在卡片指令框送字：照常送出（不受暫停影響）。
    await patchStore(
      page,
      `const s = useBoard.getState();
       useBoard.setState({
         sessions: s.sessions.map((x) => (x.id === 's-auth' ? { ...x, status: 'waiting_input' } : x)),
         approvals: s.approvals.filter((a) => a.sessionId !== 's-auth'),
       });`,
    );
    const input = card(page, 's-auth').getByRole('textbox');
    await input.fill('keep going');
    await input.press('Enter');
    await expect(card(page, 's-auth').getByRole('status')).toHaveText('已送出');

    // 提示列上的「全部繼續」：放出排隊的交接，提示列消失，「全部繼續」停用。
    await strip(page).getByTestId('resume-button').click();
    await expect(page.getByTestId('pause-msg')).toHaveText('已繼續，放出：排隊送字 1 則');
    await expect(strip(page)).toHaveCount(0);
    await expect(page.getByTestId('resume-button')).toBeDisabled();
    await expect(page.getByTestId('pause-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('handoff-label-s-auth-s-tests')).toHaveAttribute(
      'data-talk',
      'delivered',
    );
  });

  test('立刻中斷：第一次按不執行、第二次才執行；只有 RUN 被中斷，失聯的列出來', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await page.getByTestId('pause-button').click();
    const option = page.getByTestId('pause-interrupt');
    await expect(option).toContainText('立刻中斷全部（Esc）');
    await option.click();
    // 第一次只上膛：還沒暫停，RUN 還在跑。
    await expect(option).toContainText('再按一次：中斷 1 個 RUN');
    // 危險按鈕的 hover 是紅底（--fault 20%），不再被一般按鈕的 hover 蓋成中性灰 --raise。
    await option.hover();
    await expect
      .poll(() => option.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toMatch(/^color\(srgb 0\.94\d* 0\.4\d* 0\.37\d* \/ 0\.2\)$/);
    await expect(strip(page)).toHaveCount(0);
    await expect(lamp(page, 's-tests')).toHaveText('●RUN');
    // 3 秒內沒按就退回，不執行。
    await page.waitForTimeout(3300);
    await expect(option).toContainText('立刻中斷全部（Esc）');
    await expect(strip(page)).toHaveCount(0);

    await option.click();
    await expect(option).toContainText('再按一次');
    // 連點（350ms 內）不算第二下，避免手抖。
    await option.click();
    await expect(strip(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    await option.click();
    await expect(page.getByTestId('pause-msg')).toHaveText(
      '已暫停：立刻中斷。已中斷 1 個；1 個失聯沒送到',
    );
    await expect(page.getByTestId('pause-menu')).toHaveCount(0);
    await expect(strip(page)).toContainText('已暫停（立刻中斷）');
    await expect(page.getByTestId('pause-interrupt-result')).toHaveText(
      '已中斷 1 個；1 個失聯沒送到（沒送到的：Nav tweaks）',
    );
    await expect(page.getByTestId('pause-button')).toContainText('已暫停：立刻中斷');
    // RUN 收到 Esc 回到等輸入；PERM、PLAN 不動。
    await expect(lamp(page, 's-tests')).not.toHaveText('●RUN');
    await expect(lamp(page, 's-auth')).toHaveText('◆PERM');
    await expect(lamp(page, 's-etl')).toContainText('PLAN');
    await shot(page, 'paused-interrupt');

    // 全部繼續不會對被中斷的 session 送「繼續」（Q8）；中斷結果跟著清掉。
    await page.getByTestId('resume-button').first().click();
    await expect(strip(page)).toHaveCount(0);
    await expect(lamp(page, 's-tests')).not.toHaveText('●RUN');

    // 稽核（規格 §3.6 第 5 條）：一筆 board.pause，加上每個送出 Esc 的 session 各一筆 terminal.signal。
    await page.evaluate(() => (location.hash = '#/settings/data'));
    const audit = page.locator('#s-audit');
    await audit.getByLabel('動作', { exact: true }).selectOption('terminal.signal');
    await expect(audit.getByTestId('audit-row')).toHaveCount(1);
    await expect(audit.getByTestId('audit-row')).toContainText('Write tests');
    await expect(audit.getByTestId('audit-row')).toContainText('escape');
    await audit.getByLabel('動作', { exact: true }).selectOption('board.pause');
    await expect(audit.getByTestId('audit-row')).toHaveCount(1);
  });

  test('別的瀏覽器暫停、hub 重啟清掉排隊：提示列照 hub 推來的狀態顯示', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openCanvas(page);
    await patchStore(
      page,
      `useBoard.getState().backend.setPauseState({
         paused: { mode: 'finish_turn', since: new Date().toISOString(), by: 'u2', byName: 'GML', clearedOnRestart: 2 },
         held: { deliveries: 0, sessions: 1, sessionsWaiting: 2, autoContinues: 1 },
       });`,
    );
    await expect(strip(page)).toContainText('已暫停（做完這輪就停）');
    await expect(strip(page)).toContainText('・GML');
    await expect(page.getByTestId('pause-held')).toHaveText(
      '排隊：排隊 session 1 個、到期的自動接續 1 個',
    );
    await expect(strip(page)).toContainText('另有 2 個 session 在等名額');
    await expect(page.getByTestId('pause-cleared')).toHaveText(
      'hub 重啟，2 則排隊已清除（不會送出；按「全部繼續」後這行消失）。',
    );
    // 開著右側面板、次畫面時提示列一直都在。
    await page.evaluate(() => (location.hash = '#/inbox'));
    await expect(page.getByTestId('inbox-drawer')).toBeVisible();
    await expect(strip(page)).toBeVisible();
    await page.evaluate(() => (location.hash = '#/terminal/s-auth'));
    await expect(strip(page)).toBeVisible();
  });

  test('英文：指令列與提示列不撐爆', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openCanvas(page);
    await page.getByRole('group', { name: '介面語言' }).getByRole('button', { name: 'EN' }).click();
    await page.getByTestId('pause-button').click();
    await page.getByTestId('pause-finish-turn').click();
    await expect(strip(page)).toContainText('Paused (Stop after this turn)');
    await expect(page.getByTestId('resume-release')).toHaveText('Will release: nothing queued');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(1024);
    const barBox = (await bar(page).boundingBox())!;
    expect(barBox.x).toBeGreaterThanOrEqual(0);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(1024);
    // P3 整合：Presets 在 Memory 前面（docs/p3-spec.md §1.5），兩顆都在、沒被擠掉。
    await expect(bar(page).getByRole('button')).toHaveText([
      /New session/,
      'Teams',
      'Presets',
      'Memory',
      /.+/,
      /.+/,
    ]);
    await shot(page, 'command-bar-en');
    // 最窄的桌面寬度（手機版以上）：指令列換行但不超出畫面、頁面不橫向捲動。
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.getByTestId('command-memory')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      700,
    );
    const narrow = (await bar(page).boundingBox())!;
    expect(narrow.x).toBeGreaterThanOrEqual(0);
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(700);
  });

  test('手機收件匣：暫停狀態列與兩顆大按鈕，可暫停、繼續；立刻中斷同樣按兩次；沒有底部指令列', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/inbox');
    const phone = page.getByTestId('phone-pause');
    await expect(phone).toBeVisible();
    await expect(page.getByTestId('command-bar')).toBeHidden();
    const pauseButton = phone.getByTestId('pause-button');
    const resumeButton = phone.getByTestId('resume-button');
    expect((await pauseButton.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    // 沒暫停時不放一顆停用的「全部繼續」佔掉拇指區（審視報告 inbox #13）：暫停鈕自己佔滿一排。
    await expect(resumeButton).toHaveCount(0);
    expect((await pauseButton.boundingBox())!.width).toBeGreaterThan(300);

    await pauseButton.click();
    const interrupt = phone.getByTestId('pause-interrupt');
    expect((await interrupt.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    const menuBox = (await phone.getByTestId('pause-menu').boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
    await interrupt.click();
    await expect(interrupt).toContainText('再按一次：中斷 1 個 RUN');
    await expect(phone.getByTestId('pause-strip')).toHaveCount(0);
    await page.waitForTimeout(400);
    await interrupt.click();
    await expect(phone.getByTestId('pause-strip')).toContainText('已暫停（立刻中斷）');
    await expect(phone.getByTestId('pause-interrupt-result')).toContainText(
      '（沒送到的：Nav tweaks）',
    );
    await expect(phone.getByTestId('resume-release')).toHaveText('會放出：沒有排隊中的');
    expect((await resumeButton.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await shot(page, 'phone-paused');

    await resumeButton.click();
    await expect(phone.getByTestId('pause-strip')).toHaveCount(0);
    await expect(phone.getByTestId('pause-msg')).toHaveText('已繼續（沒有排隊中的）');
    await expect(resumeButton).toHaveCount(0);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });

  test('手機：團隊、設定、新增的全螢幕頁也一直看得到暫停提示列', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/inbox');
    const phone = page.getByTestId('phone-pause');
    await phone.getByTestId('pause-button').click();
    await phone.getByTestId('pause-finish-turn').click();
    await expect(phone.getByTestId('pause-strip')).toContainText('已暫停（做完這輪就停）');
    for (const [hash, id] of [
      ['#/team', 'phone-team'],
      ['#/settings', 'phone-settings'],
      ['#/new', 'phone-new'],
    ] as const) {
      await page.evaluate((h) => (location.hash = h), hash);
      const screen = page.getByTestId(id);
      await expect(screen).toBeVisible();
      await expect(screen.getByTestId('pause-strip')).toBeVisible();
      await expect(screen.getByTestId('pause-strip')).toContainText('已暫停（做完這輪就停）');
      // 全螢幕頁的「全部繼續」和收件匣一樣是 56px（會動到 session 的動作，GM Q1）；「← 返回」至少 44。
      const resume = screen.getByTestId('resume-button');
      expect((await resume.boundingBox())!.height).toBeGreaterThanOrEqual(56);
      expect((await screen.getByTestId('phone-back').boundingBox())!.height).toBeGreaterThanOrEqual(
        44,
      );
    }
    // 繼續之後就收起來。
    await page.getByTestId('phone-new').getByTestId('resume-button').click();
    await expect(page.getByTestId('pause-strip')).toHaveCount(0);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});

test.describe('設計統一：畫布區（GM 2026-11-09 Q1、Q2、Q4）', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** 螢幕上的實際大小（含畫布縮放與摘要條的 scale）。 */
  const screenBox = async (page: Page, selector: string) =>
    (await page.locator(selector).first().boundingBox())!;

  test('Q2：等你的卡用代碼色框＋淡底；只有「下一個等我的」框出那張是白色主按鈕', async ({
    page,
  }) => {
    await openCanvas(page);
    const inCards = page.locator('.react-flow__node');
    const cues = inCards.locator('.acts button.cue');
    await expect.poll(() => cues.count()).toBeGreaterThanOrEqual(2);
    // 還沒聚焦任何一張：畫布上沒有白色實心按鈕（頁首的「下一個等我的」不在畫布裡）。
    await expect(inCards.locator('button.primary')).toHaveCount(0);
    for (const b of await cues.all()) {
      const look = await b.evaluate((el) => {
        const frame = el.closest('.frame')!;
        const probe = document.createElement('i');
        probe.style.color = getComputedStyle(frame).getPropertyValue('--sc');
        frame.appendChild(probe);
        const sc = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(el);
        return { border: s.borderTopColor, bg: s.backgroundColor, sc };
      });
      expect(look.border).toBe(look.sc);
      expect(look.bg).not.toBe('rgb(255, 255, 255)');
    }
    // 按 N：框出的那張換成白色主按鈕，其他等你的卡仍是代碼色框。
    await page.keyboard.press('n');
    const spot = page.locator('.frame.spot');
    await expect(spot).toHaveCount(1);
    await expect(spot.locator('.acts button.primary')).toHaveCount(1);
    await expect(inCards.locator('button.primary')).toHaveCount(1);
    await expect(spot.locator('.acts button.cue')).toHaveCount(0);
    await shot(page, 'design-q2-focus');
  });

  test('Q4：畫布縮到 30% 以下只留標題列；點兩下照樣打開', async ({ page }) => {
    await openCanvasAt(page, 0.25);
    const auth = card(page, 's-auth');
    await expect(page.locator('.canvas')).toHaveAttribute('data-compact', '');
    await expect(auth.locator('.head .lamp')).toBeVisible();
    await expect(auth.locator('.head .title')).toBeVisible();
    // 名稱自己一行，不會被徽章與等待時間擠到看不見。
    const title = (await auth.locator('.head .title').boundingBox())!;
    expect(title.width).toBeGreaterThan(40);
    for (const sel of ['.acts', '.cmd-row', '.menu-btn', '.tail']) {
      await expect(auth.locator(sel)).toBeHidden();
    }
    await shot(page, 'design-q4-compact');
    // 30% 以上：按鈕與輸入框回來。
    await openCanvasAt(page, 0.5);
    await expect(page.locator('.canvas')).not.toHaveAttribute('data-compact', '');
    await expect(auth.locator('.cmd-row')).toBeVisible();
    await expect(auth.locator('.acts button').first()).toBeVisible();
    // 縮很小時點兩下標題列：照樣換成終端機並放大到看得清楚。
    await openCanvasAt(page, 0.25);
    await auth.locator('.head .title').dblclick();
    await expect(auth).toHaveAttribute('data-mode', 'terminal');
    await expect.poll(() => zoomLevel(page)).toBeGreaterThanOrEqual(30);
    await expect(page.locator('.canvas')).not.toHaveAttribute('data-compact', '');
  });

  test('Q4：摘要模式關掉時，縮到 30% 以下點兩下終端機卡的標題列也會放大、按鈕回來', async ({
    page,
  }) => {
    await openCanvas(page);
    const toggle = page.getByRole('button', { name: /^摘要模式/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await openCanvasAt(page, 0.25);
    const auth = card(page, 's-auth');
    await expect(auth).toHaveAttribute('data-mode', 'terminal');
    await expect(page.locator('.canvas')).toHaveAttribute('data-compact', '');
    await expect(auth.locator('.term-acts')).toBeHidden();
    await auth.locator('.termcard header .title').dblclick();
    await expect.poll(() => zoomLevel(page)).toBeGreaterThanOrEqual(30);
    await expect(page.locator('.canvas')).not.toHaveAttribute('data-compact', '');
    await expect(auth.locator('.term-acts')).toBeVisible();
  });

  test('摘要條（89%）和終端機卡（90%）的按鈕、輸入框在螢幕上一樣大，切換不跳', async ({ page }) => {
    const measure = async () =>
      card(page, 's-tests').evaluate((frame) => {
        const h = (sel: string) => frame.querySelector(sel)!.getBoundingClientRect().height;
        const f = (sel: string) => {
          const el = frame.querySelector<HTMLElement>(sel)!;
          // 螢幕上的字級＝computed 字級 × 螢幕倍率（外框的螢幕寬 ÷ 外框的 CSS 寬）
          const k = frame.getBoundingClientRect().width / (frame as HTMLElement).offsetWidth;
          const strip = el.closest<HTMLElement>('.strip');
          const s = strip ? strip.getBoundingClientRect().width / strip.offsetWidth / k : 1;
          return parseFloat(getComputedStyle(el).fontSize) * k * s;
        };
        return { input: h('input.cmd'), menu: h('.menu-btn'), font: f('input.cmd') };
      });
    await openCanvasAt(page, 0.89);
    await expect(card(page, 's-tests')).toHaveAttribute('data-mode', 'summary');
    const strip = await measure();
    await openCanvasAt(page, 0.9);
    await expect(card(page, 's-tests')).toHaveAttribute('data-mode', 'terminal');
    const term = await measure();
    // 精簡一級：螢幕上 32／13。
    for (const m of [strip, term]) {
      expect(m.input).toBeGreaterThan(31);
      expect(m.input).toBeLessThan(33);
      expect(m.menu).toBeGreaterThan(31);
      expect(m.menu).toBeLessThan(33);
      expect(m.font).toBeGreaterThan(12.5);
      expect(m.font).toBeLessThan(13.5);
    }
  });

  test('左上（側欄開關、線）和右上（整理畫布）中線對齊；縮放列和指令列一樣高', async ({ page }) => {
    await openCanvas(page);
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
    const side = await screenBox(page, '.side-toggle');
    const links = await screenBox(page, '.link-panel-toggle');
    const tidy = await page.getByRole('button', { name: '整理畫布' }).boundingBox();
    expect(Math.abs(mid(side) - mid(links))).toBeLessThan(1);
    expect(Math.abs(mid(side) - mid(tidy!))).toBeLessThan(1);
    for (const b of [side, links, tidy!]) expect(b.height).toBe(32);
    const zoom = await screenBox(page, '.canvas .zoom');
    const bar = await screenBox(page, '.command-bar');
    expect(Math.abs(zoom.height - bar.height)).toBeLessThan(1);
    expect(Math.abs(zoom.y + zoom.height - (bar.y + bar.height))).toBeLessThan(1);
    // 小地圖在縮放列上方 8px。
    const mini = await screenBox(page, '.canvas .minimap');
    expect(Math.round(zoom.y - (mini.y + mini.height))).toBe(8);
  });

  test('1280 寬、側欄開著：底部指令列不壓到右下的縮放列（看畫布寬，不看視窗寬）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openCanvas(page);
    await expect(page.locator('.board.side-open')).toHaveCount(1);
    const bar = await screenBox(page, '.command-bar');
    const zoom = await screenBox(page, '.canvas .zoom');
    const overlap =
      bar.x < zoom.x + zoom.width &&
      zoom.x < bar.x + bar.width &&
      bar.y < zoom.y + zoom.height &&
      zoom.y < bar.y + bar.height;
    expect(overlap).toBe(false);
  });

  test('封存與整理的「復原」疊在同一欄，不互相蓋住，也不蓋到指令列', async ({ page }) => {
    await openCanvas(page);
    await page.getByRole('button', { name: '整理畫布' }).click();
    await page.locator('.react-flow__node[data-id="s-web"] .menu-btn').click();
    await card(page, 's-web').getByRole('menuitem', { name: '封存' }).click();
    const archive = (await page.getByTestId('archive-toast').boundingBox())!;
    const tidy = (await page.getByTestId('tidy-toast').boundingBox())!;
    const bar = await screenBox(page, '.command-bar');
    const overlap = (a: typeof archive, b: typeof archive) =>
      a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlap(archive, tidy)).toBe(false);
    expect(Math.max(archive.y + archive.height, tidy.y + tidy.height)).toBeLessThanOrEqual(bar.y);
    await shot(page, 'design-toast-stack');
  });

  test('頁首：遮蔽開著是「按下」框線不是實心白；收件匣 0 是灰的；⚙ 和其他按鈕同高', async ({
    page,
  }) => {
    await openCanvas(page);
    const mask = page.getByTestId('mask-chip');
    if ((await mask.getAttribute('aria-pressed')) !== 'true') await mask.click();
    await expect(mask).toHaveAttribute('aria-pressed', 'true');
    // 全站「按下」樣式：白框＋10% 白底（有 0.15 秒的轉場，用 toHaveCSS 等它停下）。
    await expect(mask).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
    await expect(mask).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.1)');
    await expect(mask).toHaveCSS('font-size', '14px');
    const gear = (await page.getByTestId('settings-button').boundingBox())!;
    const inbox = (await page.getByTestId('inbox-button').boundingBox())!;
    expect(gear.height).toBe(inbox.height);
    expect(gear.width).toBe(gear.height);
    // 有等你的：數字是琥珀色；沒有：灰色。
    const count = page.getByTestId('inbox-button').locator('b');
    const amber = await count.evaluate((el) => getComputedStyle(el).color);
    await patchStore(
      page,
      `const s = useBoard.getState();
       useBoard.setState({ sessions: s.sessions.map((x) => ({ ...x, status: 'running', permissionMode: 'default' })), approvals: [] });`,
    );
    await expect(count).toHaveText('0');
    const grey = await count.evaluate((el) => getComputedStyle(el).color);
    expect(grey).not.toBe(amber);
  });

  test('摘要模式開著＝按下樣式；關掉不加框', async ({ page }) => {
    await openCanvas(page);
    const toggle = page.locator('.summary-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // 關著＝一般精簡按鈕的 --border-2 框（以前反過來：關著才加白框）。
    await expect(toggle).toHaveCSS('border-top-color', 'rgb(51, 60, 73)');
    await toggle.click();
  });
});

test.describe('session 卡片上的 git init（CONTRACTS §24.5）', () => {
  const menuBtn = (page: Page, id: string) =>
    card(page, id).getByRole('button', { name: /的更多動作$/ });
  /** 在 Vite 的模組實例上改假後端（和 App 同一份）。 */
  const fakeBackend = (page: Page, script: string) =>
    patchStore(page, `const backend = useBoard.getState().backend; ${script}`);
  const asMember = (page: Page) =>
    fakeBackend(
      page,
      `const me = backend.currentUser;
       backend.currentUser = async () => ({ ...(await me()), role: 'member' });`,
    );

  test('不是 git：卡片標示、隊長被擋的提示、⋯ 打開 git init，成功後標示自己消失', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    const docs = card(page, 's-docs');
    // s-docs 的資料夾不是 git；s-etl 是 git、s-auth 有自己的 worktree、s-web 已失聯：都沒有標示。
    await expect(docs.getByTestId('not-git')).toHaveText('不是 git');
    for (const id of ['s-etl', 's-auth', 's-web']) {
      await expect(card(page, id).getByTestId('not-git')).toHaveCount(0);
    }
    // 標示只是一行晶片：不是按鈕，不會讓卡片多出觸控高度。
    await expect(docs.locator('.sign button')).toHaveCount(0);

    // git 資料夾的卡：選單裡沒有 git init。
    await menuBtn(page, 's-etl').click();
    await expect(card(page, 's-etl').getByRole('menuitem', { name: '重新命名' })).toBeVisible();
    await expect(card(page, 's-etl').getByTestId('card-git-init')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // hub 記下隊長開成員因為不是 git 被擋（固定事件）：標示改成「開成員被擋」。
    await fakeBackend(
      page,
      `backend.addSessionEvent('s-docs', 'dispatch.not_git', { tool: 'spawn_member' });`,
    );
    await expect(docs.getByTestId('not-git-blocked')).toHaveText('開成員被擋：不是 git');
    await shot(page, 'card-git-init-chip');

    await menuBtn(page, 's-docs').click();
    await docs.getByTestId('card-git-init').click();
    const dialog = page.getByTestId('modal');
    await expect(dialog.getByTestId('git-init-page')).toBeVisible();
    await expect(page).toHaveURL(/#\/git-init\/s-docs$/);
    await expect(dialog).toContainText('Tidy docs');
    await expect(dialog.getByTestId('session-git-init-blocked')).toBeVisible();
    // 已經按了「在這裡 git init…」：一打開就是確認步驟（同一套 GitInit.tsx）。
    await expect(dialog.locator('.git-init-confirm')).toContainText('session 不會中斷');
    // 等次畫面的淡入播完再截圖。
    await page.waitForFunction(() =>
      (document.querySelector('.modal-layer')?.getAnimations({ subtree: true }) ?? []).every(
        (a) => a.playState !== 'running',
      ),
    );
    await shot(page, 'card-git-init-confirm');
    await dialog.getByTestId('git-init-confirm').click();
    await expect(dialog.getByTestId('git-init-done')).toContainText('12 個檔案');
    await expect(dialog.getByTestId('session-git-init')).toContainText('已 git init');
    await shot(page, 'card-git-init-done');
    // 背後的卡：hub 推來新的 repoRoot，標示消失，不用重整。
    await dialog.getByTestId('modal-close').click();
    await expect(docs.getByTestId('not-git-blocked')).toHaveCount(0);
    await expect(docs.getByTestId('not-git')).toHaveCount(0);
    await menuBtn(page, 's-docs').click();
    await expect(docs.getByRole('menuitem', { name: '重新命名' })).toBeVisible();
    await expect(docs.getByTestId('card-git-init')).toHaveCount(0);
  });

  test('不是 owner：看得到「不是 git」，選單、次畫面、全尺寸頁都沒有 git init 按鈕', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await asMember(page);
    await expect(card(page, 's-docs').getByTestId('not-git')).toBeVisible();
    await menuBtn(page, 's-docs').click();
    await expect(card(page, 's-docs').getByRole('menuitem', { name: '重新命名' })).toBeVisible();
    await expect(card(page, 's-docs').getByTestId('card-git-init')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // 直接開網址：只有說明，沒有按鈕。
    await page.evaluate(() => (location.hash = '#/git-init/s-docs'));
    await expect(page.getByTestId('git-init-owner-only')).toBeVisible();
    await expect(page.getByTestId('git-init-open')).toHaveCount(0);
    await expect(page.getByTestId('git-init-confirm')).toHaveCount(0);
    await page.evaluate(() => (location.hash = '#/terminal/s-docs'));
    await expect(page.getByTestId('full-s-docs')).toBeVisible();
    await expect(page.getByTestId('full-s-docs').getByTestId('not-git')).toBeVisible();
    await expect(page.getByTestId('session-git-init')).toHaveCount(0);
    await expect(page.getByTestId('git-init-open')).toHaveCount(0);
  });

  test('全尺寸頁：側欄有 git init；git 資料夾的 session 沒有；成功後側欄改成結果、標示消失', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await page.evaluate(() => (location.hash = '#/terminal/s-etl'));
    await expect(page.getByTestId('full-s-etl')).toBeVisible();
    await expect(page.getByTestId('full-handoff')).toBeVisible();
    await expect(page.getByTestId('session-git-init')).toHaveCount(0);

    await page.evaluate(() => (location.hash = '#/terminal/s-docs'));
    const full = page.getByTestId('full-s-docs');
    await expect(full.getByTestId('not-git')).toBeVisible();
    const panel = page.getByTestId('session-git-init');
    await expect(panel).toContainText('這個資料夾不是 git');
    await expect(panel).toContainText('不用重開');
    // 側欄不自動展開確認，先按「在這裡 git init」。
    await expect(panel.locator('.git-init-confirm')).toHaveCount(0);
    await panel.getByTestId('git-init-open').click();
    await expect(panel.locator('.git-init-confirm')).toBeVisible();
    await shot(page, 'full-git-init-confirm');
    await panel.getByTestId('git-init-confirm').click();
    await expect(panel.getByTestId('git-init-done')).toBeVisible();
    await expect(full.getByTestId('not-git')).toHaveCount(0);
  });

  test('團隊已勾共用資料夾：git init 照樣顯示，並說明共用只在不是 git 時生效', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    // 把 s-docs 放進一個勾了共用資料夾的團隊（假後端的 API，和網頁送的一樣）。
    await page.evaluate(
      async ({ store, teams }) => {
        const { useBoard } = await import(/* @vite-ignore */ store);
        const { refreshTeams } = await import(/* @vite-ignore */ teams);
        const backend = useBoard.getState().backend;
        const team = await backend.createTeam({
          name: 'Shared docs',
          goal: '',
          doneCriteria: '',
          color: '#4aa3ff',
          contextMd: '',
          sharedWriters: true,
        });
        await backend.putTeamMember(team.id, 's-docs', 'lead');
        await refreshTeams(backend);
      },
      { store: STORE, teams: '/src/team/store.ts' },
    );
    await page.evaluate(() => (location.hash = '#/git-init/s-docs'));
    const dialog = page.getByTestId('modal');
    await expect(dialog.getByTestId('session-git-init-shared')).toContainText(
      '共用只在不是 git 的資料夾生效',
    );
    await expect(dialog.getByTestId('git-init-confirm')).toBeVisible();
  });

  test('畫布縮很小：「不是 git」跟著標題以外的內容一起藏起來', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvasAt(page, 0.25);
    await expect(page.locator('.canvas')).toHaveAttribute('data-compact', '');
    await expect(card(page, 's-docs').getByTestId('not-git')).toBeHidden();
  });
});
