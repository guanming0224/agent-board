// 用量、改密碼、操作紀錄（假後端）。和 flows.spec.ts 同一份設定（flows*.spec.ts），分開檔案免得和別的分支搶同一處。
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Machine } from '@agent-board/protocol';

/** 先到畫布注入替身，再切到要測的畫面（同 flows.spec.ts 的 open）。 */
async function open(page: Page, route: string, patch?: string) {
  await page.goto('about:blank');
  await page.goto('/?demo=1#/canvas');
  await page.evaluate(async (code) => {
    const path = '/src/shared/store.ts';
    const { useBoard } = await import(/* @vite-ignore */ path);
    const { backend } = useBoard.getState();
    const calls: unknown[] = [];
    Object.assign(window, { __calls: calls, __board: useBoard });
    const usage = backend.machineUsage;
    backend.machineUsage = async (id: string) => {
      calls.push({ type: 'usage', id });
      return usage(id);
    };
    if (code) new Function('backend', code)(backend);
  }, patch);
  await page.evaluate((r) => {
    location.hash = r;
  }, `#/${route}`);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: { type: string; id?: string }[] }).__calls);

const setMachines = (page: Page, machines: Machine[]) =>
  page.evaluate((m) => {
    (window as unknown as { __board: { setState(v: unknown): void } }).__board.setState({
      machines: m,
    });
  }, machines);

const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => {
    if (d.type() === 'beforeunload') return void d.accept();
    list.push(`dialog: ${d.type()} ${d.message()}`);
    void d.dismiss();
  });
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

test.describe('用量', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

  test('頁首寫合計與天數，側欄逐台列出；沒回報的寫「還沒回報」，並說明不是官方額度', async ({
    page,
  }) => {
    await open(page, 'canvas');
    // demo：studio 輸入＋輸出 1,204,000、gpu 481,600，laptop 沒回報。
    const total = page.getByTestId('usage-total');
    await expect(total).toHaveText('近 30 天 168.6萬 token');
    await expect(total).toHaveAttribute('title', /不是官方方案額度，也不知道上限/);
    await expect(total).toHaveAttribute('title', /1,685,600/);

    const side = page.getByTestId('usage-section');
    await expect(side.locator('h3')).toHaveText('用量');
    await expect(page.getByTestId('usage-m-studio')).toContainText('120.4萬');
    await expect(page.getByTestId('usage-m-studio')).toContainText('快取另計');
    await expect(page.getByTestId('usage-m-laptop')).toContainText('還沒回報');
    await expect(side).toContainText('近 30 天輸入＋輸出的 token');
    await expect(side).toContainText('不是官方方案額度');
    // 沒有上限可比，不畫用量條。
    await expect(side.locator('[role=meter]')).toHaveCount(0);
  });

  test('機器清單變了就重問；全部沒回報時頁首寫「—」', async ({ page }) => {
    await open(page, 'canvas');
    await expect(page.getByTestId('usage-total')).toContainText('token');
    // 畫布一載入就問過了；換成記錄呼叫、一律回 null 的替身，看換機器清單時有沒有立刻重問。
    await page.evaluate(() => {
      const w = window as unknown as {
        __calls: unknown[];
        __board: { getState(): { backend: { machineUsage: unknown } } };
      };
      w.__board.getState().backend.machineUsage = async (id: string) => {
        w.__calls.push({ type: 'usage-null', id });
        return null;
      };
    });
    const machines = await page.evaluate(
      () =>
        (
          window as unknown as { __board: { getState(): { machines: Machine[] } } }
        ).__board.getState().machines,
    );
    await setMachines(page, machines.slice(0, 1));
    await expect(page.getByTestId('usage-total')).toHaveText('用量 —');
    await expect(page.getByTestId('usage-total')).toHaveAttribute('title', /還沒有機器回報用量/);
    await expect(page.getByTestId('usage-section')).toContainText('還沒有機器回報用量');
    expect((await calls(page)).filter((c) => c.type === 'usage-null').map((c) => c.id)).toEqual([
      machines[0]!.id,
    ]);
  });

  test('英文介面', async ({ page }) => {
    await open(page, 'canvas');
    await page.locator('.seg button', { hasText: 'EN' }).click();
    await expect(page.getByTestId('usage-total')).toHaveText('1.7M tokens, 30d');
    await expect(page.getByTestId('usage-section')).toContainText('not your plan quota');
  });

  test('側欄收合時不會掛著用量（頁首照樣有）', async ({ page }) => {
    await open(page, 'canvas');
    await page.getByTestId('side-toggle').click();
    await expect(page.getByTestId('usage-section')).toHaveCount(0);
    await expect(page.getByTestId('usage-total')).toContainText('token');
  });
});

test.describe('改密碼', () => {
  test.use({ locale: 'zh-TW' });

  test('檢查欄位、目前密碼錯誤、成功後清空欄位', async ({ page }) => {
    await open(page, 'settings');
    const box = page.locator('#s-password');
    const submit = box.getByRole('button', { name: '改密碼' });
    const err = box.locator('.msg.err');

    await submit.click();
    await expect(err).toHaveText('要填目前的密碼');
    await box.getByLabel('目前的密碼').fill('wrong-password');
    await box.getByLabel('新密碼', { exact: true }).fill('short');
    await submit.click();
    await expect(err).toHaveText('新密碼至少要 8 個字元');
    await box.getByLabel('新密碼', { exact: true }).fill('new-password-1');
    await box.getByLabel('再輸入一次新密碼').fill('new-password-2');
    await submit.click();
    await expect(err).toHaveText('兩次輸入的新密碼不一樣');
    await box.getByLabel('再輸入一次新密碼').fill('new-password-1');
    await submit.click();
    await expect(err).toHaveText('目前的密碼不對，密碼沒有改。');

    await box.getByLabel('目前的密碼').fill('demo-password');
    await box.getByLabel('目前的密碼').press('Enter');
    await expect(box.locator('.msg')).toHaveText('已改好。其他裝置要用新密碼重新登入。');
    await expect(box.locator('.msg.err')).toHaveCount(0);
    await expect(box.getByLabel('目前的密碼')).toHaveValue('');
    await expect(box.getByLabel('再輸入一次新密碼')).toHaveValue('');

    // 舊密碼已經不能用
    await box.getByLabel('目前的密碼').fill('demo-password');
    await box.getByLabel('新密碼', { exact: true }).fill('another-password');
    await box.getByLabel('再輸入一次新密碼').fill('another-password');
    await submit.click();
    await expect(err).toHaveText('目前的密碼不對，密碼沒有改。');
  });

  test('限速時告訴使用者要等多久', async ({ page }) => {
    await open(
      page,
      'settings',
      `backend.changePassword = async () => {
        throw Object.assign(new Error('Too many'), { status: 429, code: 'rate_limited', retryAfterSeconds: 120 });
      };`,
    );
    const box = page.locator('#s-password');
    await box.getByLabel('目前的密碼').fill('whatever-1');
    await box.getByLabel('新密碼', { exact: true }).fill('whatever-2');
    await box.getByLabel('再輸入一次新密碼').fill('whatever-2');
    await box.getByRole('button', { name: '改密碼' }).click();
    await expect(box.locator('.msg.err')).toHaveText('試太多次，暫時不能改密碼。2 分鐘後再試。');
  });
});

test.describe('操作紀錄', () => {
  test.use({ locale: 'zh-TW' });

  test('列出、依動作／使用者／session／時間篩選、清除', async ({ page }) => {
    await open(page, 'settings');
    const box = page.locator('#s-audit');
    await expect(box.getByRole('heading', { name: '操作紀錄' })).toBeVisible();
    const rows = box.getByTestId('audit-row');
    await expect(rows).toHaveCount(7);
    // 新的在上面；動作有中文名稱，也留原始代碼。
    await expect(rows.first()).toContainText('送入終端機的指令');
    await expect(rows.first()).toContainText('terminal.input');
    await expect(rows.first()).toContainText('npm test -- auth');
    await expect(rows.first()).toContainText('demo · Fix login');

    await box.getByLabel('動作', { exact: true }).selectOption({ label: '登入' });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('auth.login');

    await box.getByLabel('動作', { exact: true }).selectOption('');
    await box.getByLabel('使用者', { exact: true }).selectOption({ label: '系統' });
    await expect(rows).toHaveCount(2);
    // 使用者也交給後端篩，不再有「只套用在已載入的筆數」的但書。
    await expect(box).not.toContainText('已載入');

    await box.getByLabel('使用者', { exact: true }).selectOption('');
    await box.getByLabel('Session', { exact: true }).selectOption('s-tests');
    await expect(rows).toHaveCount(2);

    await box.getByRole('button', { name: '清除篩選' }).click();
    await expect(rows).toHaveCount(7);

    // 時間：從一小時後開始 → 沒有符合的紀錄
    const later = await page.evaluate(() => {
      const d = new Date(Date.now() + 3600_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    });
    await box.getByLabel('從', { exact: true }).fill(later);
    await expect(box.locator('[data-state=empty]')).toContainText('沒有符合的紀錄');
    const earlier = await page.evaluate(() => {
      const d = new Date(Date.now() - 3 * 3600_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    });
    await box.getByLabel('到', { exact: true }).fill(earlier);
    await expect(box.locator('.field-error')).toHaveText('開始時間晚於結束時間，不會有任何紀錄。');
    await box.getByLabel('從', { exact: true }).fill('');
    await expect(rows).toHaveCount(0);
    await box.getByLabel('到', { exact: true }).fill('');
    await expect(rows).toHaveCount(7);
  });

  test('匯出 CSV：沒有篩選時下載整份、帶 BOM；有篩選時只匯出符合的', async ({ page }) => {
    await open(
      page,
      'settings',
      `const exportAudit = backend.exportAudit;
       backend.exportAudit = async (filter) => {
         window.__calls.push({ type: 'export', filter });
         return exportAudit(filter);
       };`,
    );
    const box = page.locator('#s-audit');
    await expect(box).toContainText('匯出符合上面篩選的全部紀錄');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      box.getByRole('button', { name: '匯出 CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^agent-board-audit-\d{8}-\d{4}\.csv$/);
    const content = readFileSync(await download.path(), 'utf8');
    expect(content.startsWith('﻿"id"') || content.startsWith('﻿id')).toBe(true);
    expect(content.split('\r\n').filter(Boolean)).toHaveLength(8);
    await expect(box.locator('.audit-export .msg')).toContainText('已下載 agent-board-audit-');

    // 篩「系統」再匯出：只有那 2 筆，條件和列表一樣（不帶畫面的筆數上限）。
    await box.getByLabel('使用者', { exact: true }).selectOption({ label: '系統' });
    await expect(box.getByTestId('audit-row')).toHaveCount(2);
    const [filtered] = await Promise.all([
      page.waitForEvent('download'),
      box.getByRole('button', { name: '匯出 CSV' }).click(),
    ]);
    const lines = readFileSync(await filtered.path(), 'utf8')
      .split('\r\n')
      .filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(
      lines
        .slice(1)
        .every(
          (line) => line.includes('"approval.resolved"') || line.includes('"auth.login_failed"'),
        ),
    ).toBe(true);
    const exports = (await calls(page)).filter((c) => c.type === 'export') as unknown as {
      filter: Record<string, unknown>;
    }[];
    expect(exports.map((c) => c.filter)).toEqual([
      { limit: 100 },
      { limit: 100, userId: 'system' },
    ]);
  });

  test('讀不到時說明怎麼辦；匯出失敗訊息貼著按鈕', async ({ page }) => {
    await open(
      page,
      'settings',
      `backend.listAudit = async () => { throw new Error('403'); };
       backend.exportAudit = async () => { throw new Error('boom'); };`,
    );
    const box = page.locator('#s-audit');
    await expect(box.locator('[data-state=error]')).toContainText('讀不到操作紀錄：403');
    await box.getByRole('button', { name: '匯出 CSV' }).click();
    await expect(box.locator('.audit-export .msg.err')).toContainText('匯出失敗：boom');
  });

  test('成員看不到操作紀錄', async ({ page }) => {
    await open(
      page,
      'settings',
      `backend.currentUser = async () => ({ id: 'u-m', name: 'pat', role: 'member', locale: 'zh-TW' });`,
    );
    await expect(page.locator('#s-users')).toContainText('pat');
    await expect(page.locator('#s-password')).toBeVisible();
    await expect(page.locator('#s-audit')).toHaveCount(0);
  });

  test('遮蔽模式下細節裡像金鑰的字串會打碼', async ({ page }) => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    await open(
      page,
      'settings',
      `const list = backend.listAudit;
       backend.listAudit = async (f) => [{ id: 'x', userId: null, sessionId: null,
         action: 'terminal.input', detail: 'export KEY=${secret}', at: new Date().toISOString() },
         ...(await list(f))];`,
    );
    const box = page.locator('#s-audit');
    await expect(box.getByTestId('audit-row').first()).toContainText(secret);
    await page.getByRole('button', { name: /遮蔽/ }).first().click();
    await expect(box.getByTestId('audit-row').first()).not.toContainText(secret);
  });
});

test.describe('管理員重設別人的密碼', () => {
  test.use({ locale: 'zh-TW' });

  const users = `
    window.__resets = [];
    backend.listUsers = async () => [
      { id: 'u-demo', name: 'demo', role: 'owner', locale: 'zh-TW' },
      { id: 'u-pat', name: 'pat', role: 'member', locale: 'zh-TW' },
    ];
    backend.resetUserPassword = async (id, password) => {
      window.__resets.push({ id, password });
    };`;
  const resets = (page: Page) =>
    page.evaluate(() => (window as unknown as { __resets: unknown[] }).__resets);

  test('別人那一列有「重設密碼」，自己沒有；檢查欄位後送出，說明對方會被登出', async ({ page }) => {
    await open(page, 'settings', users);
    const section = page.locator('#s-users');
    const rows = section.locator('li.rig-row');
    await expect(rows).toHaveCount(2);
    await expect(
      rows.filter({ hasText: 'demo' }).getByRole('button', { name: '重設密碼' }),
    ).toHaveCount(0);
    await rows.filter({ hasText: 'pat' }).getByRole('button', { name: '重設密碼' }).click();

    const form = page.getByTestId('reset-u-pat');
    await expect(form).toContainText('幫 pat 設一個新密碼');
    await expect(form).toContainText('不需要對方的舊密碼');
    const submit = form.getByRole('button', { name: '設定新密碼' });
    await form.getByLabel('新密碼').fill('short');
    await submit.click();
    await expect(form.locator('.msg.err')).toHaveText('密碼至少要 8 個字元');
    await form.getByLabel('新密碼').fill('pat-new-password');
    await form.getByLabel('再輸入一次').fill('pat-new-passwordX');
    await submit.click();
    await expect(form.locator('.msg.err')).toHaveText('兩次輸入的新密碼不一樣');
    await form.getByLabel('再輸入一次').fill('pat-new-password');
    await form.getByLabel('再輸入一次').press('Enter');

    await expect(form).toHaveCount(0);
    await expect(rows.filter({ hasText: 'pat' }).locator('.msg')).toHaveText(
      '已設定新密碼，pat 的所有裝置都已登出。',
    );
    expect(await resets(page)).toEqual([{ id: 'u-pat', password: 'pat-new-password' }]);
  });

  test('失敗時說原因；取消不送', async ({ page }) => {
    await open(
      page,
      'settings',
      `${users}
       backend.resetUserPassword = async () => { throw new Error('403'); };`,
    );
    const row = page.locator('#s-users li.rig-row', { hasText: 'pat' });
    await row.getByRole('button', { name: '重設密碼' }).click();
    await row.getByRole('button', { name: '取消' }).click();
    await expect(page.getByTestId('reset-u-pat')).toHaveCount(0);
    await row.getByRole('button', { name: '重設密碼' }).click();
    const form = page.getByTestId('reset-u-pat');
    await form.getByLabel('新密碼').fill('pat-new-password');
    await form.getByLabel('再輸入一次').fill('pat-new-password');
    await form.getByRole('button', { name: '設定新密碼' }).click();
    await expect(form.locator('.msg.err')).toHaveText('重設失敗：403');
  });

  test('成員看不到重設按鈕', async ({ page }) => {
    await open(
      page,
      'settings',
      `${users}
       backend.currentUser = async () => ({ id: 'u-pat', name: 'pat', role: 'member', locale: 'zh-TW' });`,
    );
    await expect(page.locator('#s-users li.rig-row')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '重設密碼' })).toHaveCount(0);
  });
});

test.describe('語言存到帳號', () => {
  test.use({ locale: 'zh-TW' });

  const recordSave = `
    window.__saved = [];
    backend.saveLocale = async (locale) => { window.__saved.push(locale); };`;
  const saved = (page: Page) =>
    page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved);

  test('頁首切換：畫面、這個瀏覽器、帳號一起改', async ({ page }) => {
    await open(page, 'canvas', recordSave);
    await page.locator('.seg button', { hasText: 'EN' }).click();
    await expect(page.locator('.seg button', { hasText: 'EN' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('next-up')).toContainText('Next up');
    expect(await saved(page)).toEqual(['en']);
    expect(await page.evaluate(() => localStorage.getItem('agent-board.locale'))).toBe('en');
    await page.locator('.seg button', { hasText: '中' }).click();
    expect(await saved(page)).toEqual(['en', 'zh-TW']);
  });

  test('設定頁切換也存到帳號；存失敗時畫面照換並說明', async ({ page }) => {
    await open(page, 'settings', recordSave);
    const section = page.locator('#s-language');
    await section.locator('label', { hasText: 'English' }).click();
    await expect(section.getByRole('heading', { name: 'Language' })).toBeVisible();
    expect(await saved(page)).toEqual(['en']);
    await section.locator('label', { hasText: 'Follow browser' }).click();
    // 瀏覽器是 zh-TW：帳號記成 zh-TW。
    await expect(section.getByRole('heading', { name: '語言' })).toBeVisible();
    expect(await saved(page)).toEqual(['en', 'zh-TW']);

    await page.evaluate(() => {
      const w = window as unknown as {
        __board: { getState(): { backend: { saveLocale: unknown } } };
      };
      w.__board.getState().backend.saveLocale = async () => {
        throw new Error('offline');
      };
    });
    await section.locator('label', { hasText: 'English' }).click();
    await expect(section.locator('.msg.err')).toContainText(
      "couldn't save it to your account: offline",
    );
  });
});
