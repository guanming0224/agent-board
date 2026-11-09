// 已封存清單、舊資料頁、刪除確認框（CONTRACTS §9.5）。用 fakeBackend 的範例資料：
// s-old-api（有 worktree、git 警告、230 則對話）、s-old-shared（hook 共用、對話已刪）
// s-old-resumed（worktree 與對話都和畫布上的 Write tests 共用）、s-old-laptop（機器失聯、沒有封存時間）。
import { expect, test, type Page } from '@playwright/test';

const problems = new WeakMap<Page, string[]>();

test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  // 不可用瀏覽器原生 alert／confirm。
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

/** 先到畫布注入替身，再切到要測的畫面。patch 是對 backend 加工的程式碼字串。 */
async function open(page: Page, route: string, patch?: string) {
  await page.goto('about:blank');
  await page.goto('/?demo=1#/canvas');
  await page.evaluate(async (p) => {
    const path = '/src/shared/store.ts';
    const { useBoard } = await import(/* @vite-ignore */ path);
    const { backend } = useBoard.getState();
    const calls: unknown[] = [];
    Object.assign(window, { __calls: calls });
    const remove = backend.deleteSession;
    backend.deleteSession = async (id: string, options: unknown) => {
      calls.push({ type: 'delete', id, options });
      return remove(id, options);
    };
    if (p) new Function('backend', p)(backend);
  }, patch);
  await page.evaluate((r) => {
    location.hash = r;
  }, `#/${route}`);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: Record<string, unknown>[] }).__calls);

const MEMBER = `backend.currentUser = async () => ({ id: 'u2', name: 'pat', role: 'member', locale: 'zh-TW' });`;

/** 整頁沒有水平捲軸。 */
async function expectNoPageOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(size.scroll, `scrollWidth ${size.scroll}`).toBeLessThanOrEqual(size.client);
}

/** 綠色只能出現在 diff 區塊與 DONE 狀態代碼（STYLE.md 規則一）。 */
const findGreen = (page: Page) =>
  page.evaluate(() => {
    const isGreen = (color: string) => {
      const m = color.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
      if (!m || m[4] === '0') return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return g > r + 20 && g > b + 20;
    };
    return (
      [...document.querySelectorAll('.flows *')]
        .filter((el) => !el.closest('.diff'))
        // DONE 的狀態徽章／狀態燈可以是綠色（GM 2026-11-08）。
        .filter((el) => !el.closest('.lamp.c-done'))
        .filter((el) => {
          const style = getComputedStyle(el);
          return [style.color, style.backgroundColor, style.borderLeftColor].some(isGreen);
        })
        .map((el) => el.tagName + '.' + el.className)
    );
  });

test.describe('已封存清單', () => {
  test('新到舊、總計、對話大小（失聯或讀不到寫「—」）、搜尋', async ({ page }) => {
    await open(page, 'settings/archived');
    const section = page.locator('#s-archived');
    const rows = section.locator('.archived-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.locator('strong')).toHaveText([
      'Old API refactor',
      'Readme pass',
      'Auth tests draft',
      'Nav spike',
    ]);
    const api = page.getByTestId('archived-s-old-api');
    await expect(api.getByTestId('archived-size')).toHaveText('對話 1.8 MB');
    await expect(api).toContainText('demo-studio / api @ ab/old-api');
    // 狀態代碼＋說明（GM 2026-11-08）。
    await expect(api.locator('.lamp')).toHaveText('✓DONE完成');
    await expect(api.locator('.lamp')).toHaveCSS('color', 'rgb(70, 194, 106)');
    await expect(page.getByTestId('archived-s-old-shared').getByTestId('archived-size')).toHaveText(
      '對話 —',
    );
    const laptop = page.getByTestId('archived-s-old-laptop');
    await expect(laptop.getByTestId('archived-size')).toHaveText('對話 —');
    await expect(laptop).toContainText('封存於 —');
    await expect(section.getByTestId('archived-total')).toHaveText(
      '共 4 個，對話紀錄合計 1.8 MB（1 個讀得到大小）',
    );

    const search = section.getByRole('searchbox', { name: '搜尋名稱、呼號、資料夾、專案' });
    await search.fill('demo-gpu');
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('strong')).toHaveText('Readme pass');
    await search.fill('/home/demo/web');
    await expect(rows.locator('strong')).toHaveText('Nav spike');
    await search.fill('AB/OLD');
    await expect(rows.locator('strong')).toHaveText('Old API refactor');
    await search.fill('zzz');
    await expect(section).toContainText('沒有符合「zzz」的已封存 session');
  });

  test('還原：從清單移掉、回到畫布', async ({ page }) => {
    await open(page, 'settings/archived');
    const api = page.getByTestId('archived-s-old-api');
    await api.getByRole('button', { name: '還原', exact: true }).click();
    await expect(api).toHaveCount(0);
    await expect(page.locator('#s-archived')).toContainText('已還原「Old API refactor」');
    await page.evaluate(() => (location.hash = '#/canvas'));
    await expect(page.getByTestId('card-s-old-api')).toBeVisible();
  });

  test('刪除中不能還原：清單與舊資料頁都寫原因', async ({ page }) => {
    const deleting = `const update = backend.updateSession;
      backend.updateSession = async (id, patch) => {
        if (patch.archived === false) throw Object.assign(new Error('x'), { code: 'session_deleting' });
        return update(id, patch);
      };`;
    await open(page, 'settings/archived', deleting);
    const api = page.getByTestId('archived-s-old-api');
    await api.getByRole('button', { name: '還原', exact: true }).click();
    await expect(api.locator('.msg.err')).toHaveText(
      '這個 session 正在刪除，不能還原。稍後再試；刪完之後它就不在清單裡了。',
    );
    await open(page, 'archive/s-old-api', deleting);
    await page.getByRole('button', { name: '還原', exact: true }).click();
    await expect(page.locator('.msg.err')).toContainText('這個 session 正在刪除，不能還原');
  });

  test('member 看不到刪除（清單與舊資料頁都是）', async ({ page }) => {
    await open(page, 'settings/archived', MEMBER);
    const api = page.getByTestId('archived-s-old-api');
    await expect(api.getByRole('button', { name: '還原', exact: true })).toBeVisible();
    await expect(page.locator('#s-archived').getByRole('button', { name: '刪除' })).toHaveCount(0);
    await api.getByRole('link', { name: '開啟' }).click();
    await expect(page).toHaveURL(/#\/archive\/s-old-api$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Old API refactor');
    await expect(page.getByRole('button', { name: '還原', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '刪除' })).toHaveCount(0);
  });
});

test.describe('刪除確認框', () => {
  test('預設勾選、git 警告、按兩次才刪、顯示每一項結果', async ({ page }) => {
    await open(page, 'settings/archived');
    await page.getByTestId('archived-s-old-api').getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(
      '永久刪除「Old API refactor」？',
    );
    const worktree = dialog.getByRole('checkbox', { name: /移除 worktree/ });
    const hooks = dialog.getByRole('checkbox', { name: /hook 設定/ });
    const transcript = dialog.getByRole('checkbox', { name: /刪掉 Claude 對話紀錄/ });
    await expect(worktree).toBeChecked();
    await expect(hooks).toBeChecked();
    await expect(hooks).toBeEnabled();
    await expect(transcript).not.toBeChecked();
    await expect(dialog).toContainText('（1.8 MB）');
    const warnings = dialog.getByTestId('purge-warnings').locator('li');
    await expect(warnings).toHaveText([
      '有 2 個檔案沒 commit，worktree 會保留',
      '有 1 個 commit 沒 push',
      '分支 ab/old-api 有 3 個 commit 沒合併到主分支，分支會保留',
    ]);
    // 一定刪／可選／一定留三組
    await expect(dialog.locator('h3')).toHaveText(['一定刪', '可選（機器上的檔案）', '一定留']);
    await expect(dialog).toContainText('你的專案檔案（/home/demo/api）');
    await expect(dialog).toContainText('操作紀錄（audit）');

    // 勾了對話紀錄會說明後果
    await transcript.check();
    await expect(dialog).toContainText('刪掉之後就不能「接續」這段對話');
    await transcript.uncheck();

    // 第一次只是武裝
    const button = dialog.getByRole('button', { name: '刪除', exact: true });
    await button.click();
    await expect(dialog.getByRole('button', { name: '確認刪除' })).toBeVisible();
    await expect(dialog).toContainText('再按一次「確認刪除」才會刪');
    expect(await calls(page)).toEqual([]);
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: '確認刪除' }).click();

    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(
      '已刪除「Old API refactor」',
    );
    const outcomes = dialog.getByTestId('purge-outcome');
    await expect(outcomes).toHaveText([
      'worktree保留：2 uncommitted files',
      'hook 設定已刪除',
      '對話紀錄沒處理（沒勾或做不到）',
    ]);
    await expect(outcomes.nth(0)).toHaveAttribute('data-status', 'kept');
    expect(await calls(page)).toEqual([
      {
        type: 'delete',
        id: 's-old-api',
        options: { removeWorktree: true, removeTranscript: false, removeHooks: true },
      },
    ]);
    // 對話框右上有 ✕（觸控沒有 Esc），和面板、次畫面同一顆。
    const x = dialog.getByTestId('purge-dialog-close');
    await expect(x).toHaveText('✕');
    await expect(x).toHaveAttribute('aria-label', '關閉對話框');
    await x.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('archived-s-old-api')).toHaveCount(0);
  });

  test('hook 共用：停用並說明；沒有 worktree 就不列', async ({ page }) => {
    await open(page, 'settings/archived');
    await page.getByTestId('archived-s-old-shared').getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    const hooks = dialog.getByRole('checkbox', { name: /hook 設定/ });
    await expect(hooks).toBeDisabled();
    await expect(hooks).not.toBeChecked();
    await expect(dialog).toContainText('同一個資料夾還有其他 session 在用這份 hook 設定');
    await expect(dialog.getByRole('checkbox', { name: /移除 worktree/ })).toHaveCount(0);
    // Esc 關閉，什麼都沒刪
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  });

  test('worktree 與對話紀錄被別的 session 共用：停用並寫原因', async ({ page }) => {
    await open(page, 'settings/archived');
    await page.getByTestId('archived-s-old-resumed').getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    const worktree = dialog.getByRole('checkbox', { name: /移除 worktree/ });
    const transcript = dialog.getByRole('checkbox', { name: /刪掉 Claude 對話紀錄/ });
    await expect(dialog).toContainText('另一個 session 也在用這個 worktree，不能移除。');
    await expect(worktree).toBeDisabled();
    await expect(worktree).not.toBeChecked();
    await expect(dialog).toContainText('另一個 session 接續了同一段對話，對話紀錄不能刪。');
    await expect(transcript).toBeDisabled();
    await expect(transcript).not.toBeChecked();
    await expect(dialog).toContainText('worktree 資料夾與分支（沒勾移除）');
  });

  test('刪除中、共用：hub 的錯誤碼換成白話', async ({ page }) => {
    for (const [code, text] of [
      ['session_deleting', '這個 session 正在刪除，稍後再試。'],
      ['worktree_shared', '另一個 session 也在用這個 worktree。取消勾選 worktree 再刪。'],
      ['transcript_shared', '另一個 session 接續了同一段對話。取消勾選對話紀錄再刪。'],
    ]) {
      await open(
        page,
        'settings/archived',
        `backend.deleteSession = async () => { throw Object.assign(new Error('x'), { code: '${code}' }); };`,
      );
      await page.getByTestId('archived-s-old-api').getByRole('button', { name: '刪除' }).click();
      const dialog = page.getByTestId('purge-dialog');
      await dialog.getByRole('button', { name: '刪除', exact: true }).click();
      await page.waitForTimeout(400);
      await dialog.getByRole('button', { name: '確認刪除' }).click();
      await expect(dialog.locator('.msg.err')).toHaveText(text!);
    }
  });

  /** 計算 inspect 次數；deleted 之後的 inspect 回 worktreeShared（模擬另一個 session 剛開在這個 worktree）。 */
  const countingInspect = (code: string) => `
    const inspect = backend.inspectSession;
    window.__inspects = 0;
    let failed = false;
    backend.inspectSession = async (id) => {
      window.__inspects += 1;
      const data = await inspect(id);
      return failed ? { ...data, worktreeShared: true } : data;
    };
    backend.deleteSession = async () => {
      failed = true;
      throw Object.assign(new Error('x'), { code: '${code}' });
    };`;
  const inspects = (page: Page) =>
    page.evaluate(() => (window as unknown as { __inspects: number }).__inspects);

  async function deleteTwice(page: Page) {
    const dialog = page.getByTestId('purge-dialog');
    await dialog.getByRole('button', { name: '刪除', exact: true }).click();
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: '確認刪除' }).click();
    return dialog;
  }

  for (const code of ['daemon_timeout', 'daemon_disconnected', 'daemon_error']) {
    test(`${code}：不說「什麼都還沒刪」，改說可能已刪一部分，並重新檢查`, async ({ page }) => {
      await open(page, 'settings/archived', countingInspect(code));
      await page.getByTestId('archived-s-old-api').getByRole('button', { name: '刪除' }).click();
      const dialog = page.getByTestId('purge-dialog');
      await expect(dialog.getByTestId('purge-warnings')).toBeVisible();
      const before = await inspects(page);
      await deleteTwice(page);
      const msg = dialog.locator('.msg.err');
      await expect(msg).toContainText('機器可能還在清理，部分檔案可能已刪除');
      await expect(msg).toContainText('稍後重新開這個視窗查看');
      await expect(msg).not.toContainText('什麼都還沒刪');
      await expect.poll(() => inspects(page)).toBe(before + 1);
      // 重新檢查的結果有反映到畫面上
      await expect(dialog.getByRole('checkbox', { name: /移除 worktree/ })).toBeDisabled();
    });
  }

  test('共用的 409 之後重新檢查：勾選框停用、說明出現', async ({ page }) => {
    await open(page, 'settings/archived', countingInspect('worktree_shared'));
    await page.getByTestId('archived-s-old-api').getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    const worktree = dialog.getByRole('checkbox', { name: /移除 worktree/ });
    await expect(worktree).toBeChecked();
    await expect(worktree).toBeEnabled();
    const before = await inspects(page);
    await deleteTwice(page);
    await expect(dialog.locator('.msg.err')).toHaveText(
      '另一個 session 也在用這個 worktree。取消勾選 worktree 再刪。',
    );
    await expect(worktree).toBeDisabled();
    await expect(worktree).not.toBeChecked();
    await expect(dialog).toContainText('另一個 session 也在用這個 worktree，不能移除。');
    expect(await inspects(page)).toBe(before + 1);
  });

  test('機器失聯：清理項全部停用，只刪 hub 紀錄', async ({ page }) => {
    await open(page, 'settings/archived');
    await page.getByTestId('archived-s-old-laptop').getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    await expect(dialog.getByTestId('purge-offline')).toContainText(
      'demo-laptop 失聯：只能刪 Agent Board 裡的紀錄',
    );
    for (const box of await dialog.getByRole('checkbox').all()) {
      await expect(box).toBeDisabled();
      await expect(box).not.toBeChecked();
    }
    await dialog.getByRole('button', { name: '刪除', exact: true }).click();
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: '確認刪除' }).click();
    await expect(dialog.getByTestId('purge-outcome')).toHaveText([
      'worktree沒處理（沒勾或做不到）',
      'hook 設定沒處理（沒勾或做不到）',
      '對話紀錄沒處理（沒勾或做不到）',
    ]);
    expect(await calls(page)).toEqual([
      {
        type: 'delete',
        id: 's-old-laptop',
        options: { removeWorktree: false, removeTranscript: false, removeHooks: false },
      },
    ]);
  });

  test('hub 拒絕時寫原因，什麼都沒刪，可以再按', async ({ page }) => {
    await open(
      page,
      'settings/archived',
      `backend.deleteSession = async () => { throw Object.assign(new Error('x'), { code: 'session_active' }); };`,
    );
    await page.getByTestId('archived-s-old-api').getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    await dialog.getByRole('button', { name: '刪除', exact: true }).click();
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: '確認刪除' }).click();
    await expect(dialog.locator('.msg.err')).toHaveText(
      '這個 session 還在執行，先等它結束（或在畫布停止）再刪。',
    );
    await expect(dialog.getByRole('button', { name: '刪除', exact: true })).toBeEnabled();
  });
});

test.describe('舊資料頁', () => {
  test('基本資料、狀態歷史、對話紀錄分三種樣式、載入更多', async ({ page }) => {
    await open(
      page,
      'archive/s-old-api',
      `backend.addSessionEvent('s-old-api', 'status', { from: 'starting', to: 'waiting_input', detail: 'idle:start', reason: 'hook:SessionStart:startup' });
       backend.addSessionEvent('s-old-api', 'status', { from: 'waiting_input', fromDetail: 'idle:start', to: 'running', detail: null, reason: 'hook:UserPromptSubmit' });
       backend.addSessionEvent('s-old-api', 'status', { from: 'running', to: 'waiting_input', reason: 'stop_hook' });
       backend.addSessionEvent('s-old-api', 'status', { from: 'waiting_input', to: 'done', reason: 'user_marked_done' });`,
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Old API refactor');
    const info = page.locator('.archive-info');
    await expect(info).toContainText('/home/demo/.agent-board-wt/old-api');
    await expect(info).toContainText('ab/old-api');
    await expect(info).toContainText('acceptEdits');
    await expect(info).toContainText('opus');
    await expect(info).toContainText('0b7c6a52-3f1e-4c2a-9a51-6f2d8e1c4b90');
    await expect(info.getByRole('button', { name: '複製' })).toBeVisible();

    const history = page.locator('.archive-history li');
    await expect(history).toHaveCount(4);
    // 剛開好那一筆存了 detail：顯示 NEW，不是 ASK（GM 2026-11-08）。
    await expect(history.nth(0).locator('.lamp').last()).toHaveAttribute(
      'data-status',
      'waiting_input',
    );
    await expect(history.nth(0).locator('.lamp .code').last()).toHaveText('NEW');
    await expect(history.nth(1).locator('.lamp .code').first()).toHaveText('NEW');
    await expect(history.nth(1).locator('.lamp .code').last()).toHaveText('RUN');
    await expect(history.nth(3)).toContainText('◇ASK等你回覆');
    await expect(history.nth(3)).toContainText('✓DONE完成');

    await expect(page.getByTestId('transcript-count')).toHaveText('共 230 則');
    const entries = page.getByTestId('transcript-entry');
    await expect(entries).toHaveCount(100);
    await expect(entries.nth(0).locator('.tr-role')).toHaveText('你');
    await expect(entries.nth(1).locator('.tr-role')).toHaveText('Claude');
    await expect(entries.nth(2).locator('.tr-role')).toHaveText('工具');
    await expect(entries.nth(2)).toContainText('→ Edit');
    // 角色用標籤與版面分，不用狀態色
    const colors = await entries.evaluateAll((els) =>
      els.slice(0, 3).map((el) => getComputedStyle(el.querySelector('.tr-role')!).color),
    );
    expect(new Set(colors).size).toBe(1);

    await page.getByRole('button', { name: '載入更多（還有 130 則）' }).click();
    await expect(entries).toHaveCount(200);
    await page.getByRole('button', { name: '載入更多（還有 30 則）' }).click();
    await expect(entries).toHaveCount(230);
    await expect(page.getByRole('button', { name: /載入更多/ })).toHaveCount(0);
    expect(await findGreen(page)).toEqual([]);
  });

  test('對話搜尋：送 q、標出符合數、保留原序號；清除後回到全部', async ({ page }) => {
    await open(page, 'archive/s-old-api');
    const entries = page.getByTestId('transcript-entry');
    await expect(entries).toHaveCount(100);
    const search = page.getByRole('searchbox', { name: '搜尋對話內容' });
    await search.fill('BILLING');
    await search.press('Enter');
    await expect(page.getByTestId('transcript-count')).toHaveText('符合 57 則（共 230 則）');
    await expect(entries).toHaveCount(57);
    // 第一則符合的是第 4 則（index 3）
    await expect(entries.nth(0).locator('.tr-meta')).toContainText('#4');
    await expect(page.getByRole('button', { name: /載入更多/ })).toHaveCount(0);
    await search.fill('the');
    await page.getByRole('button', { name: '搜尋', exact: true }).click();
    await expect(page.getByTestId('transcript-count')).toHaveText('符合 154 則（共 230 則）');
    await expect(entries).toHaveCount(100);
    await page.getByRole('button', { name: '載入更多（還有 54 則）' }).click();
    await expect(entries).toHaveCount(154);
    await page.getByRole('button', { name: '清除搜尋' }).click();
    await expect(page.getByTestId('transcript-count')).toHaveText('共 230 則');
  });

  test('遮蔽模式套用到對話文字', async ({ page }) => {
    await open(page, 'archive/s-old-api');
    const second = page.getByTestId('transcript-entry').nth(1);
    await expect(second).toContainText('sk-ant-demo0123456789abcdefXYZ');
    await page.evaluate(async () => {
      const path = '/src/security/maskMode.ts';
      const { useMaskMode } = await import(/* @vite-ignore */ path);
      useMaskMode.getState().toggle();
    });
    await expect(second).not.toContainText('sk-ant-demo0123456789abcdefXYZ');
  });

  test('對話紀錄不在、機器失聯、找不到 session、沒有狀態紀錄', async ({ page }) => {
    await open(page, 'archive/s-old-shared');
    await expect(page.getByTestId('transcript-missing')).toContainText(
      '對話紀錄已刪除，或不在 demo-gpu 這台機器上',
    );
    await expect(page.getByTestId('history-empty')).toHaveText('沒有狀態紀錄。');
    await expect(page.locator('#archive-history').locator('..')).toContainText('只保留最近 30 天');

    await open(page, 'archive/s-old-laptop');
    const offline = page.getByTestId('transcript-offline');
    await expect(offline).toContainText('demo-laptop 失聯：對話紀錄存在那台機器上，現在讀不到');
    await expect(offline).toContainText('機器重新上線後按重試');
    await expect(page.locator('.archive-info')).toContainText('封存—');

    await open(page, 'archive/nope');
    await expect(page.locator('[data-state=empty]')).toContainText('找不到這個已封存的 session');
  });

  test('舊資料頁可以還原與刪除（owner）', async ({ page }) => {
    await open(page, 'archive/s-old-api');
    // 主按鈕在第一個、危險在最後（和已封存列同一個順序規則，報告 C4）。
    const acts = page.locator('.acts', {
      has: page.getByRole('button', { name: '還原並接續' }),
    });
    await expect(acts.getByRole('button')).toHaveText(['還原並接續', '還原', '刪除']);
    await expect(acts.getByRole('button').first()).toHaveClass(/primary/);
    await page.getByRole('button', { name: '刪除' }).click();
    const dialog = page.getByTestId('purge-dialog');
    await dialog.getByRole('button', { name: '刪除', exact: true }).click();
    await page.waitForTimeout(400);
    await dialog.getByRole('button', { name: '確認刪除' }).click();
    await expect(dialog.getByTestId('purge-result')).toBeVisible();
    await dialog.getByRole('button', { name: '關閉', exact: true }).click();
    await expect(page.locator('[data-state=empty]')).toContainText('已刪除');

    await open(page, 'archive/s-old-shared');
    await page.getByRole('button', { name: '還原', exact: true }).click();
    await expect(page.locator('[data-state=empty]')).toContainText('已還原');
  });
});

test.describe('接續', () => {
  test('舊資料頁「還原並接續」：回到畫布、卡片回來而且開始啟動', async ({ page }) => {
    await open(page, 'archive/s-old-api');
    const button = page.getByRole('button', { name: '還原並接續' });
    await expect(button).toHaveAttribute('title', /claude --resume/);
    await button.click();
    await expect(page).toHaveURL(/#\/canvas$/);
    await expect(page.getByTestId('card-s-old-api')).toBeVisible();
    // 啟動中是 NEW（GM 2026-11-08），說明在提示框。
    await expect(page.getByTestId('card-s-old-api').locator('.lamp')).toHaveText('◌NEW');
    await expect(page.getByTestId('card-s-old-api').locator('.lamp')).toHaveAttribute(
      'title',
      'NEW：啟動中',
    );
  });

  test('沒有 Claude 對話 id 就不給接續', async ({ page }) => {
    await open(page, 'archive/s-old-laptop');
    await expect(page.getByRole('heading', { name: 'Nav spike' })).toBeVisible();
    await expect(page.getByRole('button', { name: '還原並接續' })).toHaveCount(0);
  });

  test('hub 拒絕時寫白話原因，留在原頁', async ({ page }) => {
    for (const [code, text] of [
      ['machine_offline', 'demo-studio 離線，上線後才能接續。'],
      ['session_deleting', '這個 session 正在刪除，不能接續。'],
      ['no_claude_session', '沒有可以接續的 Claude 對話'],
    ] as const) {
      await open(
        page,
        'archive/s-old-api',
        `backend.resumeSession = async () => {
           throw Object.assign(new Error('nope'), { status: 409, code: '${code}' });
         };`,
      );
      await page.getByRole('button', { name: '還原並接續' }).click();
      await expect(page.locator('.msg.err')).toContainText(text);
      await expect(page).toHaveURL(/#\/archive\/s-old-api$/);
    }
  });
});

test.describe('版面', () => {
  for (const width of [375, 1280]) {
    test(`${width}px：設定頁已封存、舊資料頁、刪除框不超出畫面`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'settings/archived');
      await expect(page.getByTestId('archived-s-old-api')).toBeVisible();
      await expectNoPageOverflow(page);
      await page.getByTestId('archived-s-old-api').getByRole('button', { name: '刪除' }).click();
      const box = await page.getByTestId('purge-dialog').boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
      expect(await findGreen(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await open(page, 'archive/s-old-api');
      await expect(page.getByTestId('transcript-entry').first()).toBeVisible();
      await expectNoPageOverflow(page);
      expect(await findGreen(page)).toEqual([]);
    });
  }

  test('英文', async ({ page }) => {
    await open(page, 'archive/s-old-api');
    await page.evaluate(async () => {
      const path = '/src/shared/i18n.ts';
      const { useLocale } = await import(/* @vite-ignore */ path);
      useLocale.getState().setLocale('en');
    });
    await expect(page.getByTestId('transcript-count')).toHaveText('230 entries');
    await expect(page.getByTestId('transcript-entry').nth(0).locator('.tr-role')).toHaveText('You');
    const text = await page.locator('.flows').innerText();
    expect(text).not.toMatch(/flows\.[a-z]/);
  });
});
