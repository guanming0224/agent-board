// 錯誤畫面與開機檢查（GM 2026-11-08：iPhone 白屏時看不出原因）。
import { expect, test } from './flows-fixture';

test.use({ locale: 'zh-TW' });

test('畫面渲染出錯：顯示錯誤畫面與細節，換頁後恢復', async ({ page, consoleErrors }) => {
  // 這個測試故意讓卡片 render 失敗：React 與 ErrorBoundary 的 console.error 是預期的。
  consoleErrors.allow(/Objects are not valid as a React child|ErrorBoundary|%o/);
  await page.goto('/?demo=1#/canvas');
  await expect(page.locator('html')).toHaveAttribute('data-ab-booted', '1');
  await page.evaluate(async () => {
    const path = '/src/shared/store.ts';
    const { useBoard } = await import(/* @vite-ignore */ path);
    Object.assign(window, { __board: useBoard });
    useBoard.setState((s: { sessions: Record<string, unknown>[] }) => ({
      // 名稱是物件：React 不能把它當文字畫出來（以前用 status: 'no-such-status'，2026-11-13 起不認得的狀態當 OFF 顯示）。
      sessions: [...s.sessions, { ...s.sessions[0], id: 'broken', name: { broken: true } }],
    }));
  });
  const screen = page.getByTestId('error-screen');
  await expect(screen).toBeVisible();
  await expect(screen.getByRole('heading')).toHaveText('這個畫面出錯了');
  await expect(page.getByTestId('error-details')).toContainText(/Error/);
  await expect(page.getByRole('button', { name: '重新載入' })).toBeVisible();
  // 開機檢查不會再蓋上來：錯誤畫面本身就是給人看的。
  await expect(page.getByTestId('boot-check')).toHaveCount(0);

  // 把壞資料拿掉、換頁 → 錯誤畫面收掉，頁面正常。
  await page.evaluate(() => {
    const useBoard = (window as unknown as { __board: { setState: (f: unknown) => void } }).__board;
    useBoard.setState((s: { sessions: { id: string }[] }) => ({
      sessions: s.sessions.filter((x) => x.id !== 'broken'),
    }));
  });
  await page.getByRole('button', { name: '回待處理' }).click();
  await expect(screen).toHaveCount(0);
  await expect(page).toHaveURL(/#\/inbox/);
});

test('主程式沒載入：開機檢查顯示原因與重新載入按鈕', async ({ page, consoleErrors }) => {
  // 故意擋掉 main.tsx：瀏覽器的載入失敗訊息是預期的。
  consoleErrors.allow(/Failed to load resource/);
  await page.addInitScript(() => Object.assign(window, { __abBootWaitMs: 800 }));
  await page.route('**/src/main.tsx*', (route) => route.abort());
  await page.goto('/?demo=1#/canvas');
  const box = page.getByTestId('boot-check');
  await expect(box).toBeVisible();
  await expect(box.getByRole('heading', { level: 1 })).toHaveText(
    /畫面沒有載入成功|The page did not load/,
  );
  await expect(page.getByTestId('boot-check-errors')).toContainText('main.tsx');
  await expect(box.getByRole('button', { name: /重新載入|Reload/ }).first()).toBeVisible();
});

test('正常載入：不顯示開機檢查', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __abBootWaitMs: 800 }));
  await page.goto('/?demo=1#/canvas');
  await expect(page.locator('html')).toHaveAttribute('data-ab-booted', '1');
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('boot-check')).toHaveCount(0);
});

test('只是慢：說明出現後，主程式畫好就自己收掉', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __abBootWaitMs: 300 }));
  await page.route('**/src/main.tsx*', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  // 不等 load：load 要等被拖慢的主程式，等完說明早就出現又收掉了。
  await page.goto('/?demo=1#/canvas', { waitUntil: 'commit' });
  await expect(page.getByTestId('boot-check')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-ab-booted', '1', { timeout: 15000 });
  await expect(page.getByTestId('boot-check')).toHaveCount(0);
});
