// 機器面板（發版與自動更新，docs/release-update-spec.md §7）：假後端（shared/fakeRelease.ts），不連外。
// demo：canary 0.1.1（6 小時前）、stable 0.1.0；demo-gpu canary 最新、demo-studio 延後（有 session 在等你允許）、
// demo-laptop 更新失敗已回滾（離線、沒有上一版）。
import { expect, test, type Page } from './flows-fixture';

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

  test('門檻 0（預設）：升 stable 不提醒、直接升；切通道、回滾、更新延後都會改狀態', async ({
    page,
  }) => {
    await open(page, '#/machines');
    await expect(page.getByTestId('machines-soak')).toContainText('canary 已跑 6 小時');
    await expect(page.getByTestId('machines-soak')).not.toContainText('建議');
    await page.getByTestId('machines-promote-btn').click();
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.1');
    await expect(page.getByTestId('machines-promote-note')).toHaveText('已升為 stable');
    await expect(page.getByTestId('machines-promote-confirm')).toHaveCount(0);

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

  test('門檻 > 0：在設定頁改成 12 小時，面板顯示實際小時數、不到要再確認', async ({ page }) => {
    await open(page, '#/settings/machines');
    const input = page.getByTestId('release-soak-hours');
    await expect(input).toHaveValue('0');
    await expect(page.locator('#s-release')).toContainText('0＝不提醒');
    // 範圍外：標錯、不能存。
    await input.fill('169');
    await expect(page.locator('#s-release .field-error')).toHaveText('要填 0–168 的整數');
    await input.fill('12');
    await expect(page.locator('#s-release .field-error')).toHaveCount(0);
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');

    await page.getByTestId('settings-machines-versions').click();
    await expect(page.getByTestId('machines-page')).toBeVisible();
    await expect(page.getByTestId('machines-soak')).toContainText('（建議跑滿 12 小時）');
    await page.getByTestId('machines-promote-btn').click();
    const confirm = page.getByTestId('machines-promote-confirm');
    await expect(confirm).toContainText('還不到 12 小時');
    await page.getByTestId('machines-promote-no').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.0');
    await page.getByTestId('machines-promote-btn').click();
    await page.getByTestId('machines-promote-yes').click();
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.1');
    await expect(page.getByTestId('machines-promote-note')).toHaveText('已升為 stable');
    await expect(confirm).toHaveCount(0);
  });

  test('門檻比 canary 跑的時間短（設 2 小時）：不用再確認', async ({ page }) => {
    // 先在畫布改設定，再打開面板（面板掛上時才讀總覽）。
    await open(page, '#/canvas', 'void backend.updateSettings({ canarySoakHours: 2 });');
    await page.evaluate(() => (location.hash = '#/machines'));
    await expect(page.getByTestId('machines-soak')).toContainText('canary 已跑 6 小時');
    await expect(page.getByTestId('machines-soak')).not.toContainText('建議');
    await page.getByTestId('machines-promote-btn').click();
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.1');
    await expect(page.getByTestId('machines-promote-confirm')).toHaveCount(0);
  });

  test('連到舊 hub（面板沒有門檻欄位）：照舊 24 小時、要再確認；設定頁說明不支援', async ({
    page,
  }) => {
    // 模擬舊 hub：總覽與設定都沒有 canarySoakHours，升 stable 照舊 24 小時規則。
    await open(
      page,
      '#/canvas',
      `
      const strip = (o) => { const { canarySoakHours, ...rest } = o; return rest; };
      for (const name of ['releases', 'checkReleases', 'setReleaseRepo']) {
        const orig = backend[name].bind(backend);
        backend[name] = async (...args) => strip(await orig(...args));
      }
      const promote = backend.promoteRelease.bind(backend);
      backend.promoteRelease = async (version, confirm) => {
        if (!confirm) throw Object.assign(new Error('too new'), { status: 409, code: 'canary_too_new' });
        return strip(await promote(version, confirm));
      };
      const get = backend.getSettings.bind(backend);
      backend.getSettings = async () => strip(await get());
      `,
    );
    await page.evaluate(() => (location.hash = '#/machines'));
    await expect(page.getByTestId('machines-soak')).toContainText('（建議跑滿 24 小時）');
    await page.getByTestId('machines-promote-btn').click();
    const confirm = page.getByTestId('machines-promote-confirm');
    await expect(confirm).toContainText('還不到 24 小時');
    await page.getByTestId('machines-promote-yes').click();
    await expect(page.getByTestId('machines-stable')).toHaveText('0.1.1');

    // 設定頁（不重新載入，補丁還在）：沒有輸入框，說明舊 hub 固定 24 小時；儲存列沒有未存的項目。
    await page.evaluate(() => (location.hash = '#/settings/machines'));
    await expect(page.getByTestId('release-soak-unsupported')).toContainText('固定要跑滿 24 小時');
    await expect(page.getByTestId('release-soak-hours')).toHaveCount(0);
    await expect(page.getByTestId('save-bar')).toContainText('都已存檔');
  });

  test('Windows（未驗證平台）：說明預設不自動更新；打開要再確認，關掉不用', async ({ page }) => {
    await open(page, '#/machines');
    const box = page.getByTestId('machine-unverified-m-gpu');
    // demo-gpu 已允許：說明＋「停止自動更新」。Mac 那幾台沒有這一區。
    await expect(box).toContainText('已允許這台 win-x64 機器自動更新');
    await expect(page.getByTestId('machine-unverified-m-studio')).toHaveCount(0);
    await expect(page.getByTestId('machine-status-m-gpu')).toHaveText('最新');

    // 關掉不用確認：回到預設（不發目標）。
    await page.getByTestId('machine-unverified-off-m-gpu').click();
    await expect(page.getByTestId('machine-unverified-note-m-gpu')).toHaveText('已停止自動更新');
    await expect(page.getByTestId('machine-status-m-gpu')).toHaveText(
      'Windows 還沒實機驗證，暫不自動更新',
    );
    await expect(box).toContainText('預設不自動更新');
    await expect(page.getByTestId('machine-update-m-gpu')).toBeDisabled();

    // 打開要再確認：取消就什麼都不變。
    await page.getByTestId('machine-unverified-on-m-gpu').click();
    const confirm = page.getByTestId('machine-unverified-confirm-m-gpu');
    await expect(confirm).toContainText('還沒在實機驗證過自動更新');
    await page.getByTestId('machine-unverified-no-m-gpu').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('machine-status-m-gpu')).toHaveText(
      'Windows 還沒實機驗證，暫不自動更新',
    );
    await page.getByTestId('machine-unverified-on-m-gpu').click();
    await page.getByTestId('machine-unverified-yes-m-gpu').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId('machine-unverified-note-m-gpu')).toHaveText('已允許自動更新');
    await expect(page.getByTestId('machine-status-m-gpu')).toHaveText('最新');
    await expect(page.getByTestId('machine-unverified-off-m-gpu')).toBeEnabled();
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
    await expect(page.getByTestId('machine-unverified-off-m-gpu')).toBeDisabled();
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
      'machine-unverified-off-m-gpu',
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
