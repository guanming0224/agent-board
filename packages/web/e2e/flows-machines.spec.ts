// 機器面板（發版與自動更新，docs/release-update-spec.md §7）：假後端（shared/fakeRelease.ts），不連外。
// demo：canary 0.1.1（6 小時前）、stable 0.1.0；demo-gpu canary 最新、demo-studio 延後（有 session 在等你允許）、
// demo-laptop 更新失敗已回滾（離線、沒有上一版）。
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

test.describe('機器面板（桌面）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1400, height: 900 } });

  test('從設定的機器區打開；版本、gh、各機狀態；Esc 關掉', async ({ page }) => {
    await open(page, '#/settings/machines');
    await page.getByTestId('settings-machines-versions').click();
    await expect(page).toHaveURL(/#\/machines$/);
    await expect(page.getByTestId('machines-page')).toBeVisible();
    await expect(page.getByTestId('machines-canary')).toHaveText('0.1.1');
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.0');
    await expect(page.getByTestId('machines-gh')).toHaveText('gh 已登入');
    await expect(page.getByTestId('machine-status-m-gpu')).toHaveText('最新');
    await expect(page.getByTestId('machine-status-m-studio')).toHaveText(
      '延後：有 session 在等你允許',
    );
    await expect(page.getByTestId('machine-status-m-laptop')).toHaveText(
      '失敗已回滾：60 秒內健康檢查沒過',
    );
    // buildId 只顯示前 8 碼
    await expect(page.getByTestId('machine-release-m-gpu')).toContainText('7c1e9a40');
    await expect(page.getByTestId('machine-release-m-gpu')).not.toContainText('7c1e9a40d');
    // 離線、沒有上一版：按鈕停用並說明
    await expect(page.getByTestId('machine-update-m-laptop')).toBeDisabled();
    await expect(page.getByTestId('machine-rollback-m-laptop')).toBeDisabled();
    await expect(page.getByTestId('machine-release-m-laptop')).toContainText('機器離線');
    await expect(page.getByTestId('machine-release-m-laptop')).toContainText(
      '不知道上一版，不能回滾',
    );
    // canary 跑多久、期間出了幾次事
    await expect(page.getByTestId('machines-soak')).toContainText('canary 已跑 6 小時');
    await expect(page.getByTestId('machines-stats')).toContainText('ERR 1');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('machines-page')).toHaveCount(0);
  });

  test('升 stable 不到 24 小時要再確認；切通道、回滾、更新延後都會改狀態', async ({ page }) => {
    await open(page, '#/machines');
    await page.getByTestId('machines-promote-btn').click();
    const confirm = page.getByTestId('machines-promote-confirm');
    await expect(confirm).toContainText('還不到 24 小時');
    await page.getByTestId('machines-promote-no').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.0');
    await page.getByTestId('machines-promote-btn').click();
    await page.getByTestId('machines-promote-yes').click();
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.1');
    await expect(page.getByTestId('machines-promote-note')).toHaveText('已升為 stable');

    // 切通道
    const canary = page.getByTestId('machine-channel-m-studio-canary');
    await canary.click();
    await expect(canary).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('machine-channel-m-studio-stable')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // 有 session 在等你允許：立即更新還是延後
    await page.getByTestId('machine-update-m-studio').click();
    await expect(page.getByTestId('machine-status-m-studio')).toHaveText(
      '延後：有 session 在等你允許',
    );

    // 回滾 demo-gpu：每 5 秒重讀，看得到版本換回 0.1.0
    await page.getByTestId('machine-rollback-m-gpu').click();
    await expect(page.getByTestId('machine-note-m-gpu')).toHaveText('已送出回滾');
    await expect(page.getByTestId('machine-version-m-gpu')).toHaveText('0.1.0', {
      timeout: 12_000,
    });
    await expect(page.getByTestId('machine-status-m-gpu')).toHaveText('已手動回滾到 0.1.0');
    await expect(page.getByTestId('machine-rollback-m-gpu')).toBeDisabled();
  });

  test('gh 沒登入時說明怎麼處理；成員只能看', async ({ page }) => {
    await open(
      page,
      '#/canvas',
      `const real = backend.releases;
       backend.releases = async () => ({ ...(await real()), gh: { state: 'not_logged_in', message: null } });
       const me = backend.currentUser;
       backend.currentUser = async () => ({ ...(await me()), role: 'member' });`,
    );
    await page.evaluate(() => (location.hash = '#/machines'));
    await expect(page.getByTestId('machines-gh')).toContainText('gh auth login');
    await expect(page.getByTestId('machines-member-note')).toBeVisible();
    await expect(page.getByTestId('machines-check')).toBeDisabled();
    await expect(page.getByTestId('machines-promote-btn')).toBeDisabled();
    await expect(page.getByTestId('machine-update-m-studio')).toBeDisabled();
    await expect(page.getByTestId('machine-channel-m-gpu-stable')).toBeDisabled();
    await expect(page.getByTestId('machines-repo-input')).toHaveCount(0);
  });
});

test.describe('機器面板（手機）', () => {
  test.use({ locale: 'en', viewport: { width: 390, height: 844 }, hasTouch: true });

  test('全螢幕頁、英文、可點元素至少 44px、沒有橫向捲動', async ({ page }) => {
    await open(page, '#/machines');
    await expect(page.getByTestId('phone-machines')).toBeVisible();
    await expect(page.getByTestId('machine-status-m-studio')).toHaveText(
      'Deferred: a session is waiting for your approval',
    );
    for (const id of [
      'machines-check',
      'machines-promote-btn',
      'machine-update-m-gpu',
      'machine-rollback-m-gpu',
      'machine-channel-m-gpu-canary',
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByTestId('phone-back').click();
    await expect(page.getByTestId('phone-machines')).toHaveCount(0);
  });
});
