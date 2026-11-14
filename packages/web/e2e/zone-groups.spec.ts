// 分頁群組（GM 2026-11-14，CONTRACTS §25）：可收合的群組標籤取代「更多」。用 demo 假後端（和 hub 同一套純函式），
// 不花額度、不連外。hub 的存法、權限、廣播在 hub 單元測試（packages/hub/src/test/zoneGroups.test.ts）。
import { expect, test, type Locator, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const ZONE_STORE = '/src/zones/store.ts';
const TEAM = 'team-demo-auth';
// 從 packages/web 執行（e2e 指令都在這裡跑）。
const SHOTS = '../../docs/screenshots';

let problems: string[];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('dialog', (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test.afterEach(() => {
  expect(problems, 'console 不該有錯誤').toEqual([]);
});

/** 在假後端上跑一段程式（建工作區、建群組），回傳 JSON 結果。 */
async function fake<T = unknown>(page: Page, script: string): Promise<T> {
  return page.evaluate(
    async ({ url, script }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: { getState(): { backend: unknown } };
      };
      return new Function('backend', `return (async () => { ${script} })()`)(
        useBoard.getState().backend,
      ) as Promise<T>;
    },
    { url: STORE, script },
  ) as Promise<T>;
}

/** 一次建好多個工作區，回傳 名稱 → id。 */
async function zones(page: Page, names: string[]): Promise<Record<string, string>> {
  return fake<Record<string, string>>(
    page,
    `const out = {};
     for (const name of ${JSON.stringify(names)}) out[name] = (await backend.createZone(name)).id;
     return out;`,
  );
}

async function group(page: Page, name: string, color: string, zoneIds: string[]): Promise<string> {
  return fake<string>(
    page,
    `return (await backend.createZoneGroup(${JSON.stringify({ name, color, zoneIds })})).group.id;`,
  );
}

const tab = (page: Page, name: string) => page.locator(`[role="tab"][data-zone-name="${name}"]`);
const wrap = (page: Page, name: string) => page.locator(`[data-group-name="${name}"]`);
const tag = (page: Page, name: string) => wrap(page, name).locator('.zone-group-tag');
const tabNames = (scope: Page | Locator) =>
  scope
    .locator('[role="tab"][data-zone-name]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-zone-name')));

async function rightClick(locator: Locator) {
  await locator.click({ button: 'right' });
}

test('建群組、加入／移出、收合／展開、改名換色、往左移、刪群組不刪畫布', async ({ page }) => {
  await page.goto('/#/canvas');
  await zones(page, ['美股', '海龜', '工具', '研究']);
  await expect(page.locator('[role="tab"][data-zone-name]')).toHaveCount(5);

  // 分頁選單：加入群組 ▸ → 新群組… → 名稱＋顏色 → 建立。
  await rightClick(tab(page, '海龜'));
  await page.getByTestId('zone-add-to-group').click();
  await page.getByTestId('zone-new-group').click();
  await page.getByTestId('zone-group-name-input').fill('AI專案');
  await page.getByTestId('zone-group-color-indigo').click();
  await page.getByTestId('zone-group-create').click();
  await expect(page.getByTestId('zone-group-menu')).toHaveCount(0);
  await expect(wrap(page, 'AI專案')).toBeVisible();
  await expect(wrap(page, 'AI專案')).toHaveAttribute('style', /team-indigo/);
  expect(await tabNames(wrap(page, 'AI專案'))).toEqual(['海龜']);
  await expect(tag(page, 'AI專案')).toHaveAttribute('aria-expanded', 'true');

  // 加入既有群組。
  await rightClick(tab(page, '工具'));
  await page.getByTestId('zone-add-to-group').click();
  await page.locator('[data-testid^="zone-join-"]').filter({ hasText: 'AI專案' }).click();
  await expect.poll(() => tabNames(wrap(page, 'AI專案'))).toEqual(['海龜', '工具']);

  // 收合：只剩群組標籤，寫畫布數；目前畫布在裡面就標出來（白底線＋名稱）。
  await tab(page, '工具').click();
  await tag(page, 'AI專案').click();
  await expect(tag(page, 'AI專案')).toHaveAttribute('aria-expanded', 'false');
  await expect(tab(page, '海龜')).toHaveCount(0);
  await expect(tab(page, '工具')).toHaveCount(0);
  await expect(tag(page, 'AI專案').locator('.zone-group-count')).toHaveText('2');
  await expect(tag(page, 'AI專案')).toHaveAttribute('aria-current', 'true');
  await expect(tag(page, 'AI專案').locator('.zone-group-current')).toHaveText('工具');
  // 收合狀態每台裝置各自記（localStorage）。
  const collapsed = await page.evaluate(() => localStorage.getItem('agent-board.zone.collapsed'));
  expect(Object.keys(JSON.parse(collapsed!) as object)).toHaveLength(1);
  // 鍵盤也能展開（標籤是按鈕）。
  await tag(page, 'AI專案').focus();
  await page.keyboard.press('Enter');
  await expect(tag(page, 'AI專案')).toHaveAttribute('aria-expanded', 'true');
  await expect(tab(page, '工具')).toHaveAttribute('aria-selected', 'true');

  // 往左移（拖曳的替代）：群組裡的「工具」移到「海龜」前面。
  await rightClick(tab(page, '工具'));
  await page.getByTestId('zone-move-left').click();
  await expect.poll(() => tabNames(wrap(page, 'AI專案'))).toEqual(['工具', '海龜']);
  // 已經在最左邊：往左移停用。
  await rightClick(tab(page, '主要'));
  await expect(page.getByTestId('zone-move-left')).toBeDisabled();
  await page.keyboard.press('Escape');

  // 移出群組：回到頂部列、放在群組右邊。
  await rightClick(tab(page, '海龜'));
  await page.getByTestId('zone-ungroup-tab').click();
  await expect.poll(() => tabNames(wrap(page, 'AI專案'))).toEqual(['工具']);
  await expect.poll(() => tabNames(page)).toEqual(['主要', '美股', '工具', '海龜', '研究']);

  // 改名、換顏色（群組標籤的選單）。
  await rightClick(tag(page, 'AI專案'));
  await page.getByTestId('zone-group-rename').click();
  await page.getByTestId('zone-group-rename-input').fill('伺服器');
  await page.getByTestId('zone-group-rename-input').press('Enter');
  await expect(wrap(page, '伺服器')).toBeVisible();
  await rightClick(tag(page, '伺服器'));
  await page.getByTestId('zone-group-recolor').click();
  await page.getByTestId('zone-group-color-lime').click();
  await expect(wrap(page, '伺服器')).toHaveAttribute('style', /team-lime/);

  // 刪除群組：按兩次確認；只刪群組，畫布都在。
  await rightClick(tag(page, '伺服器'));
  const del = page.getByTestId('zone-group-delete');
  await expect(del).toContainText('不會被刪');
  await del.click();
  await expect(del).toContainText('再按一次');
  await expect(async () => {
    if (await del.isVisible()) await del.click();
    await expect(wrap(page, '伺服器')).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await expect.poll(() => tabNames(page)).toEqual(['主要', '美股', '工具', '海龜', '研究']);

  // 取消群組（不用確認）也一樣不刪畫布。
  const ids = await zones(page, ['其他']);
  await group(page, '雜項', 'sand', [ids['其他']!]);
  await rightClick(tag(page, '雜項'));
  await page.getByTestId('zone-group-ungroup').click();
  await expect(wrap(page, '雜項')).toHaveCount(0);
  await expect(tab(page, '其他')).toBeVisible();
});

test('超過 6 個分頁仍全部可達：頂部列左右捲動、滾輪轉橫向、目前分頁自動捲進可見範圍', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/#/canvas');
  const names = Array.from({ length: 12 }, (_, i) => `畫布第${i + 1}個`);
  const ids = await zones(page, names);
  const scroller = page.getByTestId('zone-scroll');
  await expect(page.locator('[role="tab"][data-zone-name]')).toHaveCount(13);
  await expect(page.getByTestId('zone-more')).toHaveCount(0);
  // 放不下：可以橫向捲。
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeGreaterThan(0);

  // 每一個都點得到。
  for (const name of ['主要', ...names]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
  }

  // 捲回最左，滑鼠滾輪（直向）轉成橫向。
  await scroller.evaluate((el) => (el.scrollLeft = 0));
  await scroller.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

  // 從別處換目前畫布（例如「下一個等我的」、通知）：自動捲進可見範圍。
  await tab(page, '主要').click();
  await scroller.evaluate((el) => (el.scrollLeft = 0));
  await expect(tab(page, '畫布第12個')).not.toBeInViewport();
  await page.evaluate(
    async ({ url, id }) => {
      const { useZoneUi } = (await import(url)) as {
        useZoneUi: { getState(): { setCurrent(id: string): void } };
      };
      useZoneUi.getState().setCurrent(id);
    },
    { url: ZONE_STORE, id: ids['畫布第12個']! },
  );
  await expect(tab(page, '畫布第12個')).toBeInViewport();
  // 「+」一直看得到。
  await expect(page.getByTestId('zone-add')).toBeInViewport();
});

test('拖著團隊經過收合的群組會自動展開，可以放到裡面的分頁；放下後收回去', async ({ page }) => {
  await page.goto('/#/canvas');
  const ids = await zones(page, ['X', 'Y']);
  await group(page, '伺服器', 'lime', [ids['X']!, ids['Y']!]);
  await tag(page, '伺服器').click();
  await expect(tab(page, 'X')).toHaveCount(0);
  await tab(page, '主要').click();
  await expect(page.getByTestId(`card-s-auth`)).toBeVisible();

  await page.getByTestId(`team-open-${TEAM}`).hover();
  await page.mouse.down();
  await tag(page, '伺服器').hover();
  await expect(tab(page, 'X')).toBeVisible();
  await tab(page, 'X').hover();
  await page.mouse.up();
  await expect(page.getByTestId('zone-notice')).toContainText('已移到「X」');
  await expect(page.getByTestId('card-s-auth')).toHaveCount(0);
  // 暫時展開而已：放下後收回去（收合狀態沒被改掉）。
  await expect(tab(page, 'X')).toHaveCount(0);
  await expect(tag(page, '伺服器')).toHaveAttribute('aria-expanded', 'false');
});

test('桌面拖曳：分頁拖到群組標籤＝加入群組；拖到別的分頁左半＝排在它前面（移出群組）；群組標籤也能拖', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const ids = await zones(page, ['A', 'B', 'C']);
  await group(page, 'G', 'teal', [ids['A']!]);
  await expect.poll(() => tabNames(page)).toEqual(['主要', 'A', 'B', 'C']);

  await tab(page, 'B').dragTo(tag(page, 'G'));
  await expect.poll(() => tabNames(wrap(page, 'G'))).toEqual(['A', 'B']);

  await tab(page, 'A').dragTo(tab(page, '主要'), { targetPosition: { x: 4, y: 10 } });
  await expect.poll(() => tabNames(page)).toEqual(['A', '主要', 'B', 'C']);
  await expect.poll(() => tabNames(wrap(page, 'G'))).toEqual(['B']);

  // 群組拖到「C」右半：排在 C 後面。
  const box = (await tab(page, 'C').boundingBox())!;
  await tag(page, 'G').dragTo(tab(page, 'C'), { targetPosition: { x: box.width - 4, y: 10 } });
  await expect.poll(() => tabNames(page)).toEqual(['A', '主要', 'C', 'B']);
});

test.describe('手機（觸控）', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('頂部列一樣可以橫向滑；點群組標籤展開；長按開選單；觸控 44px', async ({ page }) => {
    // beforeEach 設了桌面尺寸，這裡改回手機。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/canvas');
    const ids = await zones(page, ['美股', '海龜', '工具', '研究', '其他', '備用']);
    await group(page, 'AI專案', 'indigo', [ids['海龜']!, ids['工具']!]);
    await expect(page.getByTestId('zone-select')).toHaveCount(0);
    const scroller = page.getByTestId('zone-scroll');
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeGreaterThan(0);

    // 點群組標籤：收合／展開。
    await tag(page, 'AI專案').tap();
    await expect(tag(page, 'AI專案')).toHaveAttribute('aria-expanded', 'false');
    await tag(page, 'AI專案').tap();
    await expect(tab(page, '海龜')).toBeVisible();
    for (const el of [tab(page, '主要'), tag(page, 'AI專案')]) {
      expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    // 長按分頁：開選單（有「加入群組」）；放開不算點（不會切過去）。
    const target = tab(page, '美股');
    await target.scrollIntoViewIfNeeded();
    const b = (await target.boundingBox())!;
    const at = { clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 };
    await target.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, ...at });
    await expect(page.getByTestId('zone-menu')).toBeVisible();
    await target.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, ...at });
    await expect(page.getByTestId('zone-add-to-group')).toBeVisible();
    const item = page.getByTestId('zone-add-to-group');
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(target).toHaveAttribute('aria-selected', 'false');
  });
});

test.describe('截圖：10 個分頁、2 個群組（一個展開、一個收合）', () => {
  async function setup(page: Page) {
    await page.goto('/#/canvas');
    const ids = await zones(page, [
      '美股',
      'AI 研究',
      'AI 工具',
      'AI 部署',
      '海龜',
      '工具',
      '主機 A',
      '主機 B',
      '其他',
    ]);
    await group(page, 'AI專案', 'indigo', [ids['AI 研究']!, ids['AI 工具']!, ids['AI 部署']!]);
    await group(page, '伺服器', 'lime', [ids['主機 A']!, ids['主機 B']!]);
    await expect(page.locator('[data-zone-name]')).toHaveCount(10);
    // 目前畫布在收合的群組裡：標籤上標出來。
    await tab(page, '主機 A').click();
    await tag(page, '伺服器').click();
    await expect(tag(page, '伺服器')).toHaveAttribute('aria-current', 'true');
    await expect(tag(page, 'AI專案')).toHaveAttribute('aria-expanded', 'true');
  }

  test('桌面', async ({ page }) => {
    await setup(page);
    await page.screenshot({ path: `${SHOTS}/zone-groups-desktop.png`, animations: 'disabled' });
  });

  test('手機', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await page.screenshot({ path: `${SHOTS}/zone-groups-phone.png`, animations: 'disabled' });
  });
});
