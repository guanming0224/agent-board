// 浮動對話框（GM 2026-11-14，STYLE §5.2）：新增 session、新增團隊、補成員、套用 Preset。
// 標題列可拖、位置記住並夾在視窗內、可回到中間；開著時背後畫布照常能點卡、捲動，對話框不關；
// 在對話框裡打字不觸發畫布快捷鍵。手機（≤ 640px）維持全螢幕頁。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from './flows-fixture';
import type { Locator } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
/** 拖動前後的截圖（回報用）；test-results 不進版控。 */
const SHOTS = join(here, '../test-results/float-shots');
mkdirSync(SHOTS, { recursive: true });

const KEY = 'agent-board.float.modal-new';
const DESKTOP = { width: 1440, height: 900 };

async function openCanvas(page: Page) {
  await page.goto('/#/canvas');
  await expect(page.getByTestId('card-s-auth')).toBeVisible();
  await expect(page.getByTestId('zoom-level')).not.toHaveText('100%');
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('看不到元素');
  return b;
}

/** 按住標題列拖 dx、dy（滑鼠；pointer events 一樣適用觸控筆與觸控）。 */
async function drag(page: Page, handle: Locator, dx: number, dy: number) {
  const b = await box(handle);
  const x = b.x + 60;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

/** 畫面上一張沒被對話框蓋住、也不在頁首底下的卡（點得到的那一塊的中心點）。 */
async function uncoveredCard(page: Page, dialogTestId: string) {
  return page.evaluate((testId) => {
    const dialog = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
    const head = document.querySelector('.shell-head')?.getBoundingClientRect().bottom ?? 0;
    for (const node of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
      const r = node.getBoundingClientRect();
      // 點卡片標題列左側（狀態徽章旁）：不是按鈕，點了就是選取。
      const x = r.left + 8;
      const y = r.top + 8;
      const inside = x >= dialog.left && x <= dialog.right && y >= dialog.top && y <= dialog.bottom;
      if (!inside && y > head + 4 && x > 0 && y < innerHeight - 80 && x < innerWidth) {
        return { id: node.dataset.id!, x, y };
      }
    }
    return null;
  }, dialogTestId);
}

test.describe('浮動對話框：新增 session（桌面）', () => {
  test.use({ viewport: DESKTOP, locale: 'zh-TW' });

  test('拖動標題列 → 關掉再開同一個位置 → 背後畫布可點卡、可捲動且對話框不關 → 打字不觸發畫布快捷鍵 → 回到中間', async ({
    page,
  }) => {
    await openCanvas(page);
    await page.evaluate(() => (location.hash = '#/new'));
    const modal = page.getByTestId('modal');
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute('data-floating', 'true');
    await expect(modal).toHaveAttribute('aria-modal', 'false');
    // 沒有暗化遮罩、背後不 inert。
    await expect(page.getByTestId('modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.board-layer')).not.toHaveAttribute('inert', /.*/);
    // 焦點先進對話框。
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector('[data-testid="modal"]')?.contains(document.activeElement) ??
            false,
        ),
      )
      .toBe(true);
    const handle = page.getByTestId('modal-handle');
    await expect(handle).toHaveCSS('cursor', 'move');
    await expect(modal).toHaveAttribute('aria-describedby', /.+/);

    // 一開是置中（頁首以下的區域）。
    const start = await box(modal);
    expect(Math.abs(start.x + start.width / 2 - DESKTOP.width / 2)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: join(SHOTS, 'new-session-before-drag.png') });

    // 拖到右邊（夾在視窗內）。
    await drag(page, handle, 220, 0);
    await expect.poll(async () => Math.round((await box(modal)).x)).toBe(Math.round(start.x + 220));
    const moved = await box(modal);
    expect(moved.x + moved.width).toBeLessThanOrEqual(DESKTOP.width);
    // 拖的時候沒選到文字。
    expect(await page.evaluate(() => String(getSelection() ?? ''))).toBe('');
    await page.screenshot({ path: join(SHOTS, 'new-session-after-drag.png') });
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), KEY))
      .toBe(JSON.stringify({ x: Math.round(moved.x), y: Math.round(moved.y) }));

    // 關掉再開：同一個位置。
    await page.getByTestId('modal-close').click();
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(/#\/canvas$/);
    await page.evaluate(() => (location.hash = '#/new'));
    await expect(modal).toBeVisible();
    await expect.poll(async () => Math.round((await box(modal)).x)).toBe(Math.round(moved.x));
    expect(Math.round((await box(modal)).y)).toBe(Math.round(moved.y));

    // 對話框開著：點畫布上的卡＝選取，對話框不關、網址不變。
    const target = await uncoveredCard(page, 'modal');
    expect(target, '要有一張沒被蓋住的卡').not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
    await expect(page.locator(`.react-flow__node[data-id="${target!.id}"]`)).toHaveClass(
      /selected/,
    );
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/#\/new$/);

    // 點畫布空白處也不關。
    await page.mouse.click(40, DESKTOP.height - 140);
    await expect(modal).toBeVisible();

    // 捲動（縮放）畫布有效。
    const zoomBefore = await page.getByTestId('zoom-level').textContent();
    await page.mouse.move(target!.x, target!.y + 40);
    await page.mouse.wheel(0, -400);
    await expect.poll(() => page.getByTestId('zoom-level').textContent()).not.toBe(zoomBefore);
    await expect(modal).toBeVisible();

    // 再選那張卡；焦點在名稱欄打字、按 Backspace：不觸發畫布的「封存選取的卡」。
    await page.mouse.click(target!.x, target!.y);
    await expect(page.locator(`.react-flow__node[data-id="${target!.id}"]`)).toHaveClass(
      /selected/,
    );
    const name = modal.getByLabel('名稱', { exact: true });
    await name.click();
    await page.keyboard.type('abn');
    await page.keyboard.press('Backspace');
    await expect(name).toHaveValue('ab');
    await expect(page.getByTestId('archive-confirm')).toHaveCount(0);
    await expect(modal).toBeVisible();
    // 對照組：焦點回到卡上時同一個鍵就是封存確認（證明上面真的有快捷鍵可以被誤觸）。
    await page.locator(`.react-flow__node[data-id="${target!.id}"]`).focus();
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('archive-confirm')).toBeVisible();
    await page.getByTestId('archive-confirm-close').click();
    await expect(page.getByTestId('archive-confirm')).toHaveCount(0);
    // 填到一半的內容還在。
    await expect(name).toHaveValue('ab');

    // 回到中間：雙擊標題列。
    await page.getByTestId('modal-handle').dblclick({ position: { x: 60, y: 10 } });
    await expect
      .poll(async () => {
        const b = await box(modal);
        return Math.round(b.x + b.width / 2);
      })
      .toBe(DESKTOP.width / 2);
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull();

    // 鍵盤：Alt＋→ 移動，「回到中間」鈕回來。
    await modal.focus();
    const centered = await box(modal);
    await page.keyboard.press('Alt+ArrowRight');
    await expect
      .poll(async () => Math.round((await box(modal)).x))
      .toBe(Math.round(centered.x + 16));
    await page.getByTestId('modal-center').click();
    await expect.poll(async () => Math.round((await box(modal)).x)).toBe(Math.round(centered.x));

    // Esc（焦點在對話框上、不是輸入框）照舊關閉。
    await modal.focus();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });

  test('記住的位置在視窗縮小時夾回看得到的地方；壞掉的記錄當沒有、置中', async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        if (!sessionStorage.getItem('seeded')) {
          localStorage.setItem(key, '{');
          sessionStorage.setItem('seeded', '1');
        }
      } catch {
        // 不能用 storage 就不種。
      }
    }, KEY);
    await openCanvas(page);
    await page.evaluate(() => (location.hash = '#/new'));
    const modal = page.getByTestId('modal');
    await expect(modal).toBeVisible();
    const start = await box(modal);
    expect(Math.abs(start.x + start.width / 2 - DESKTOP.width / 2)).toBeLessThanOrEqual(2);

    await drag(page, page.getByTestId('modal-handle'), 400, 0);
    await expect.poll(async () => Math.round((await box(modal)).x)).toBeGreaterThan(start.x);
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect
      .poll(async () => {
        const b = await box(modal);
        return b.x >= 0 && b.x + b.width <= 1000 && b.y >= 0;
      })
      .toBe(true);
  });
});

test.describe('浮動對話框：手機維持全螢幕頁', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW' });

  test('390 寬開 #/new：全螢幕頁，不是浮動框', async ({ page }) => {
    await page.goto('/#/new');
    await expect(page.getByTestId('phone-new')).toBeVisible();
    await expect(page.locator('[data-floating]')).toHaveCount(0);
    await expect(page.getByTestId('modal')).toHaveCount(0);
  });
});

test.describe('浮動對話框：新增團隊、補成員、Preset（桌面）', () => {
  test.use({ viewport: DESKTOP, locale: 'zh-TW' });

  test('新增團隊：打開、拖動、關掉再開位置與已填內容都在；點畫布不關', async ({ page }) => {
    await page.goto('/#/team');
    await expect(page.getByTestId('team-list')).toBeVisible();
    await page.getByTestId('new-team-open').click();
    const dialog = page.getByTestId('new-team-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-floating', 'true');
    // 打開時避開右側團隊面板。
    const panel = await box(page.getByTestId('team-panel'));
    const start = await box(dialog);
    expect(start.x + start.width).toBeLessThanOrEqual(panel.x);
    await dialog.getByLabel('團隊名稱').fill('浮動');

    await drag(page, page.getByTestId('new-team-dialog-handle'), -150, 60);
    await expect
      .poll(async () => Math.round((await box(dialog)).x))
      .toBe(Math.round(start.x - 150));
    const moved = await box(dialog);
    expect(Math.round(moved.y)).toBe(Math.round(start.y + 60));

    // 點畫布空白處：對話框、團隊面板都還在。
    await page.mouse.click(moved.x + moved.width + 20, DESKTOP.height - 140);
    await expect(dialog).toBeVisible();

    await page.getByTestId('new-team-dialog-close').click();
    await expect(dialog).toBeHidden();
    await page.getByTestId('new-team-open').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('團隊名稱')).toHaveValue('浮動');
    expect(Math.round((await box(dialog)).x)).toBe(Math.round(moved.x));
  });

  test('補成員：打開、拖動', async ({ page }) => {
    await page.goto('/#/team/team-demo-auth');
    await expect(page.getByTestId('team-workbench')).toBeVisible();
    const fold = page.getByTestId('fold-toggle-add');
    if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
    await page.getByTestId('add-members-toggle').click();
    const dialog = page.getByTestId('add-members-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('add-members')).toBeVisible();
    const start = await box(dialog);
    await drag(page, page.getByTestId('add-members-dialog-handle'), -120, 40);
    await expect
      .poll(async () => Math.round((await box(dialog)).x))
      .toBe(Math.round(start.x - 120));
    // 表單自己的「取消」也關。
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('套用 Preset（底部 Presets）：打開、拖動、點畫布不關、Esc 關', async ({ page }) => {
    await openCanvas(page);
    await page.getByTestId('command-presets').click();
    const dialog = page.getByTestId('presets-pop');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('data-floating', 'true');
    await expect(dialog.getByTestId('preset-picker')).toBeVisible();
    const start = await box(dialog);
    await drag(page, page.getByTestId('presets-pop-handle'), 200, -40);
    await expect
      .poll(async () => Math.round((await box(dialog)).x))
      .toBe(Math.round(start.x + 200));
    await page.mouse.click(40, DESKTOP.height - 140);
    await expect(dialog).toBeVisible();
    await dialog.focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
