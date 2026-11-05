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
  await expect(auth.locator('.lamp')).toHaveText('◆等你允許');
  await expect(auth.locator('.age')).toContainText('等了 12 分');
  await expect(auth.locator('.callsign')).toHaveText('demo-studio / project @ ab/fix-auth');
  await expect(auth.locator('.chip.mode')).toHaveText('default');
  await expect(auth.locator('.tail')).toContainText('Do you want to proceed?');
  await expect(auth.locator('.ctx')).toContainText('20%');
  await expect(auth.getByRole('button', { name: '檢視並決定' })).toBeVisible();
  await expect(auth.getByRole('textbox')).toBeVisible();

  // 等你的卡 2px 琥珀框；其他 1px。外框經過 scale，看 computed 的邏輯值。
  await expect(auth.locator('.strip')).toHaveCSS('border-top-width', '2px');
  await expect(auth.locator('.strip')).toHaveCSS('border-top-color', 'rgb(242, 179, 61)');
  await expect(card(page, 's-tests').locator('.strip')).toHaveCSS('border-top-width', '1px');

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

  // 失聯：斜紋、45%、最後讀到時間、不能送指令
  const gone = card(page, 's-web').locator('.strip');
  await expect(gone).toHaveCSS('opacity', '0.45');
  await expect(gone).toHaveCSS('background-image', /repeating-linear-gradient/);
  await expect(gone.locator('.age')).toContainText(/最後讀到 \d\d:\d\d/);
  await expect(gone.getByRole('textbox')).toHaveCount(0);

  // 整個介面沒有綠色：掃所有元素算出來的顏色
  const greens = await page.evaluate(() => {
    const isGreen = (c: string) => {
      const m = c.match(/rgba?\((\d+), (\d+), (\d+)/);
      if (!m) return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return g > 90 && g > r * 1.3 && g > b * 1.3;
    };
    return [...document.querySelectorAll('.shell *')].flatMap((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor, s.borderTopColor].some(isGreen)
        ? [el.className || el.tagName]
        : [];
    });
  });
  expect(greens).toEqual([]);
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

/** 用「從全尺寸頁回來」的路徑把畫布放在指定倍率：畫布重新掛載時直接套用，不經過按鈕的級距。 */
async function openCanvasAt(page: Page, zoom: number) {
  await openCanvas(page);
  await page.evaluate(
    async ({ url, z }) => {
      const { useViewsUi } = await import(/* @vite-ignore */ url);
      useViewsUi.getState().setCanvasReturn({ x: 40, y: 40, zoom: z });
      location.hash = '#/queue';
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
  // 靜止時要安靜：沒有任何琥珀框
  await expect(page.locator('.strip.you')).toHaveCount(0);
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
  await expect(card(page, 's-auth').locator('.lamp')).toHaveText('●工作中');
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
  for (const glyph of ['◆', '◇', '▣', '✕', '⚠', '●', '◌', '⋯', '⧖', '✓', '⊘']) {
    await expect(sidebar.locator('.legend b', { hasText: glyph })).toHaveCount(1);
  }
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

test('待處理清單：順序同佇列、危險指令置頂、點一列跳到該卡', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/queue');
  const ids = () =>
    page.locator('.queue-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  await expect.poll(ids).toEqual(['queue-s-ml', 'queue-s-auth', 'queue-s-etl']);
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
  await expect.poll(ids).toEqual(['queue-s-tests', 'queue-s-ml', 'queue-s-auth', 'queue-s-etl']);
  await expect(page.getByTestId('queue-s-tests')).toContainText('命中危險指令清單');
  await expect(page.getByTestId('waiting-count')).toHaveText('4');
  await shot(page, 'queue-danger');

  await page.getByTestId('queue-s-etl').click();
  await expect(page).toHaveURL(/#\/canvas/);
  await expect(page.locator('.frame.spot')).toHaveAttribute('data-testid', 'card-s-etl');
  await expect(card(page, 's-etl')).toBeInViewport({ ratio: 0.9 });
  // 下一個從剛才點的那列接著走，危險指令的 s-tests 在循環的第一個
  await page.keyboard.press('n');
  await expect(page.locator('.frame.spot')).toHaveAttribute('data-testid', 'card-s-tests');
  await expect(card(page, 's-tests')).toContainText('⛔ 命中危險指令');
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
  await expect(card(page, 's-auth').locator('.lamp')).toContainText('Needs approval');
  await expect(card(page, 's-auth').locator('.age')).toContainText('waited 12m');
  await expect(card(page, 's-ml').locator('.chip.bypass')).toHaveText('Bypass permissions');
  await expect(page.getByTestId('rig-m-laptop')).toContainText('Offline');
  await expect(page.getByRole('link', { name: 'Queue' })).toBeVisible();
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
  for (const route of ['canvas', 'queue']) {
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
    await page.goto('/#/queue');
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
    await expect(page.locator('[data-state="empty"]')).toContainText('沒有等你的');
  });

  test('錯誤：寫發生什麼與怎麼辦，重試成功後回到畫布', async ({ page }) => {
    await page.goto('/#/queue');
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

  test('雙擊卡片不會開快速建立；點空白或 Esc 關掉；頁首按鈕在畫布上原地打開', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCanvas(page);
    await card(page, 's-auth').locator('.callsign').dblclick();
    await expect(page.getByTestId('quick-create')).toHaveCount(0);

    const spot = await blankSpot(page);
    await page.mouse.dblclick(spot.x, spot.y);
    await expect(page.getByTestId('quick-create')).toBeVisible();
    await page.mouse.click(spot.x, spot.y - 150);
    await expect(page.getByTestId('quick-create')).toHaveCount(0);

    await page.getByRole('banner').getByRole('button', { name: '新增 session' }).click();
    await expect(page.getByTestId('quick-create')).toBeVisible();
    await expect(page).toHaveURL(/#\/canvas/);
    await page.getByTestId('quick-create').getByRole('link', { name: '完整表單' }).click();
    await expect(page).toHaveURL(/#\/new/);
    // 離開畫布後頁首按鈕回到完整表單。
    await page.evaluate(() => (location.hash = '#/queue'));
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
