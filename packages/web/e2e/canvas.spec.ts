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
  const input = card(page, 's-auth').getByRole('textbox');
  await input.focus();
  await page.keyboard.type('nnn');
  await expect(input).toHaveValue('nnn');
  expect(await spot()).toBe('card-s-ml');
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
  await expect(page.getByTestId('waiting-count')).toHaveText('2');
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
    await expect(page.locator('[data-state="empty"]')).toContainText('按「新增 session」開始');
    await shot(page, 'empty');
    await page.locator('[data-state="empty"]').getByRole('button').click();
    await expect(page).toHaveURL(/#\/new/);

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
    await expect(card(page, 's-auth').getByRole('textbox')).toBeDisabled();
    await expect(card(page, 's-auth').locator('.tail')).toContainText('Do you want to proceed?');
    await shot(page, 'stale');

    await patchStore(page, `useBoard.setState({ connected: true });`);
    await expect(page.locator('[data-state="stale"]')).toHaveCount(0);
    await expect(card(page, 's-auth').getByRole('textbox')).toBeEnabled();
  });
});
