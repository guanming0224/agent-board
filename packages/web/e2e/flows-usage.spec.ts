// 用量詳情（GM 2026-11-09）：假後端（demo 資料，shared/fakeUsage.ts），不連外、不呼叫 LLM。
// demo-studio、demo-gpu 有細項；demo-laptop 失聯、沒回報。「daemon 太舊」用替身把 demo-gpu 的細項拿掉。
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, route = '#/canvas', patch?: string) {
  await page.goto('about:blank');
  await page.goto(`/?demo=1${route}`);
  if (patch) {
    await page.evaluate(async (code) => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      new Function('backend', code)(useBoard.getState().backend);
    }, patch);
  }
}

const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || !url.protocol.startsWith('http')) return route.continue();
    list.push(`external request: ${url.href}`);
    return route.abort();
  });
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

test.describe('用量詳情（桌面）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1400, height: 900 } });

  test('點頁首的「近 30 天 N token」打開；寫清楚不是官方額度、各台狀態；Esc 關掉', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('usage-total').click();
    await expect(page).toHaveURL(/#\/usage$/);
    const panel = page.getByTestId('usage-page');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('usage-note')).toContainText('不是官方方案額度');
    await expect(page.getByTestId('usage-machine-m-studio')).toContainText('最後統計');
    await expect(page.getByTestId('usage-machine-m-laptop')).toContainText('還沒回報用量');
    await expect(page.getByTestId('usage-machine-m-laptop')).toContainText('失聯');
    // 總覽：今天、近 7 天、近 30 天，四種 token 拆開＋合計，和前一期比。
    for (const days of [1, 7, 30]) {
      const tile = page.getByTestId(`usage-tile-${days}`);
      await expect(tile).toContainText('輸入＋輸出');
      for (const word of ['輸入', '輸出', '快取讀', '快取寫', '四項合計']) {
        await expect(tile).toContainText(word);
      }
    }
    await expect(page.getByTestId('usage-change-1')).toContainText('比昨天');
    await expect(page.getByTestId('usage-change-30')).toContainText('比前 30 天');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page).toHaveURL(/#\/canvas$/);
  });

  test('側欄的入口與直接開網址（深連結）都能開', async ({ page }) => {
    await open(page);
    await page.getByTestId('usage-side-open').click();
    await expect(page.getByTestId('usage-page')).toBeVisible();
    await open(page, '#/usage');
    await expect(page.getByTestId('usage-page')).toBeVisible();
    await expect(page.getByTestId('usage-overview')).toBeVisible();
  });

  test('趨勢：切 7／90 天、依機器堆疊、表格檢視、滑鼠與鍵盤看單日數字', async ({ page }) => {
    await open(page, '#/usage');
    const trend = page.getByTestId('usage-trend');
    await expect(trend.locator('.usage-hit')).toHaveCount(30);
    await expect(page.getByTestId('usage-legend')).toContainText('輸入');
    await expect(page.getByTestId('usage-legend')).toContainText('輸出');

    await page.getByTestId('usage-period').getByRole('button', { name: '7 天' }).click();
    await expect(trend.locator('.usage-hit')).toHaveCount(7);
    await page.getByTestId('usage-period').getByRole('button', { name: '90 天' }).click();
    await expect(trend.locator('.usage-hit')).toHaveCount(90);

    // 四項合計：圖例多兩層。
    await page.getByTestId('usage-measure').getByRole('button', { name: '四項合計' }).click();
    await expect(page.getByTestId('usage-legend').locator('li')).toHaveCount(4);

    await page.getByTestId('usage-stack').getByRole('button', { name: '依機器' }).click();
    await expect(page.getByTestId('usage-legend')).toContainText('demo-studio');
    await expect(page.getByTestId('usage-legend')).toContainText('demo-gpu');
    // 沒細項的機器不畫。
    await expect(page.getByTestId('usage-legend')).not.toContainText('demo-laptop');

    await page.getByTestId('usage-trend-day-89').hover();
    const tooltip = page.getByTestId('usage-trend-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('合計');
    await expect(tooltip).toContainText('demo-studio');

    // 鍵盤：焦點在圖上，左右鍵逐日，Esc 先收提示框、面板還在。
    await page.getByTestId('usage-trend-plot').focus();
    await page.keyboard.press('End');
    const last = await tooltip.locator('.usage-tooltip-day').textContent();
    await page.keyboard.press('ArrowLeft');
    await expect(tooltip.locator('.usage-tooltip-day')).not.toHaveText(last ?? '');
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await expect(page.getByTestId('usage-page')).toBeVisible();

    await page.getByTestId('usage-trend-table-toggle').click();
    await expect(page.getByTestId('usage-trend-table').locator('tbody tr')).toHaveCount(90);
  });

  test('排行：團隊、session、專案三個分頁，可排序；點 session 聚焦畫布上的卡', async ({ page }) => {
    await open(page, '#/usage');
    const team = page.getByTestId('usage-rank-team');
    await expect(team).toContainText('登入重構');
    await expect(team).toContainText('不在團隊的 session');
    await expect(team).toContainText('中控台外的 session');

    await page.getByTestId('usage-rank-tab-project').click();
    const project = page.getByTestId('usage-rank-project');
    await expect(project).toContainText('…/demo/scripts');

    await page.getByTestId('usage-rank-tab-session').click();
    const sessions = page.getByTestId('usage-rank-session');
    const firstName = () => sessions.locator('tbody tr').first().locator('th');
    // 排序：點兩次同一欄反過來。
    await page.getByTestId('usage-sort-input').click();
    const top = await firstName().textContent();
    await page.getByTestId('usage-sort-input').click();
    await expect(page.getByTestId('usage-sort-input').locator('..')).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await expect(firstName()).not.toHaveText(top ?? '');

    await sessions.getByRole('button', { name: 'Fix login' }).click();
    await expect(page.getByTestId('usage-page')).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="s-auth"] .frame.spot')).toBeVisible();
  });

  test('排行：點團隊開團隊面板', async ({ page }) => {
    await open(page, '#/usage');
    await page.getByTestId('usage-rank-team').getByRole('button', { name: '登入重構' }).click();
    await expect(page).toHaveURL(/#\/team\/team-demo-auth$/);
    await expect(page.getByTestId('usage-page')).toHaveCount(0);
  });

  test('舊 daemon 沒細項：寫清楚，總覽照常顯示有細項的機器；全部沒細項時說明', async ({ page }) => {
    await open(
      page,
      '#/canvas',
      `const real = backend.usageReport.bind(backend);
       backend.usageReport = async () => {
         const r = await real();
         const gpu = r.machines.findIndex((m) => m.machineId === 'm-gpu');
         r.machines[gpu] = { ...r.machines[gpu], state: 'old_daemon', countedAt: null };
         r.rows = r.rows.filter((row) => row[0] !== gpu);
         return r;
       };`,
    );
    await page.evaluate(() => (location.hash = '#/usage'));
    await expect(page.getByTestId('usage-machine-m-gpu')).toContainText(
      'daemon 版本太舊，沒有細項',
    );
    await expect(page.getByTestId('usage-overview')).toBeVisible();
    await page.getByTestId('usage-stack').getByRole('button', { name: '依機器' }).click();
    // 只剩一台：單一系列不畫圖例。
    await expect(page.getByTestId('usage-legend')).toHaveCount(0);

    await open(
      page,
      '#/canvas',
      `const real = backend.usageReport.bind(backend);
       backend.usageReport = async () => {
         const r = await real();
         r.machines = r.machines.map((m) => ({ ...m, state: 'old_daemon', countedAt: null }));
         r.rows = [];
         return r;
       };`,
    );
    await page.evaluate(() => (location.hash = '#/usage'));
    await expect(page.getByTestId('usage-no-detail')).toBeVisible();
    await expect(page.getByTestId('usage-overview')).toHaveCount(0);
  });

  test('讀不到時寫錯誤與重試，恢復後再讀', async ({ page }) => {
    await open(
      page,
      '#/canvas',
      `const real = backend.usageReport.bind(backend);
       let fail = true;
       window.__heal = () => { fail = false; };
       backend.usageReport = async () => {
         if (fail) throw new Error('hub 連不上');
         return real();
       };`,
    );
    await page.evaluate(() => (location.hash = '#/usage'));
    await expect(page.getByTestId('usage-error')).toContainText('hub 連不上');
    await page.evaluate(() => (window as unknown as { __heal(): void }).__heal());
    await page.getByTestId('usage-error').getByRole('button', { name: '重新讀取' }).click();
    await expect(page.getByTestId('usage-error')).toHaveCount(0);
    await expect(page.getByTestId('usage-overview')).toBeVisible();
  });

  test('英文介面', async ({ page }) => {
    await open(page);
    await page.evaluate(async () => {
      const path = '/src/shared/i18n.ts';
      const { useLocale } = await import(/* @vite-ignore */ path);
      useLocale.getState().setLocale('en');
      location.hash = '#/usage';
    });
    await expect(page.getByTestId('usage-note')).toContainText('not your plan quota');
    await expect(page.getByTestId('usage-rank-team')).toContainText('Sessions outside the board');
  });
});

test.describe('用量詳情（手機）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 390, height: 844 } });

  test('全螢幕頁；表格改成清單、圖可以橫向捲，整頁不橫向捲', async ({ page }) => {
    await open(page, '#/usage');
    await expect(page.getByTestId('phone-usage')).toBeVisible();
    await expect(page.getByTestId('usage-overview')).toBeVisible();
    await page.getByTestId('usage-period').getByRole('button', { name: '90 天' }).click();
    const plot = page.getByTestId('usage-trend-plot');
    const { scroll, client } = await plot.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
    }));
    expect(scroll).toBeGreaterThan(client);
    // 表頭藏起來，每列的數字自己帶欄名。
    const table = page.getByTestId('usage-rank-team');
    await expect(table.locator('thead')).toHaveCSS('position', 'absolute');
    await expect(table.locator('tbody tr').first().locator('td').first()).toHaveCSS(
      'display',
      'block',
    );
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
    // 點團隊：手機開團隊頁。
    await table.getByRole('button', { name: '登入重構' }).click();
    await expect(page.getByTestId('phone-team')).toBeVisible();
  });
});
