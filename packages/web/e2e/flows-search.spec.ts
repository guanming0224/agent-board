// 全域搜尋的畫面（P3 §3.3、§3.4、§3.8）：假後端（demo 資料），不連外、不呼叫 LLM。
// 假後端的 search 換成記錄呼叫次數的替身（停 250ms 才送、1 個字不送）。
// 真 hub 的網路回應遮蔽、指令組權限在 integration.spec.ts 與 hub 的測試。
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, route = '#/canvas') {
  await page.goto('about:blank');
  await page.goto(`/?demo=1${route}`);
  await page.evaluate(async () => {
    const path = '/src/shared/store.ts';
    const { useBoard } = await import(/* @vite-ignore */ path);
    const { backend } = useBoard.getState();
    const queries: unknown[] = [];
    const real = backend.search.bind(backend);
    backend.search = (query: unknown) => {
      queries.push(query);
      return real(query);
    };
    Object.assign(window, { __queries: queries });
  });
}

const queries = (page: Page) =>
  page.evaluate(() => (window as unknown as { __queries: { q: string }[] }).__queries);

const rows = (page: Page, group: string) =>
  page.getByTestId(`search-group-${group}`).getByTestId('search-row');

test.describe('全域搜尋（桌面）', () => {
  test.use({ viewport: { width: 1400, height: 900 }, locale: 'zh-TW' });

  test('⌘K 開視窗；1 個字不搜、停 250ms 才送；檔案改動 RUN 在前附次數；Enter 前往聚焦那張卡', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByTestId('search-input');
    await expect(input).toBeFocused();
    await expect(page).toHaveURL(/#\/search/);

    await input.pressSequentially('r');
    await page.waitForTimeout(400);
    expect(await queries(page)).toEqual([]);
    await expect(page.getByTestId('search-panel')).toContainText('輸入兩個字以上');

    await input.pressSequentially('isk.py', { delay: 30 });
    await expect(rows(page, 'file')).toHaveCount(2);
    // 打字中不送，停下來才送一次。
    expect((await queries(page)).map((q) => q.q)).toEqual(['risk.py']);
    expect(await queries(page)).toEqual([
      { q: 'risk.py', scope: 'all', since: '7d', archived: false, mask: false },
    ]);
    const first = rows(page, 'file').first();
    await expect(first).toContainText('RUN');
    await expect(first).toContainText('Write tests');
    await expect(first).toContainText('src/risk.py');
    await expect(first).toContainText('共 2 次');
    await expect(first.locator('.search-hit')).toHaveText('risk.py');
    await expect(rows(page, 'file').nth(1)).toContainText('Tidy docs');
    await expect(page.getByTestId('search-file-note')).toContainText('只偵測 Edit／Write');
    await expect(page).toHaveURL(/#\/search\?q=risk\.py$/);

    await input.press('ArrowDown');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="s-tests"] .frame.spot')).toBeVisible();
  });

  test('/ 與頁首按鈕都能開；Esc 先清字再關；沒找到時說明深層還沒有、Enter 只亮出說明', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('/');
    const input = page.getByTestId('search-input');
    await expect(input).toBeFocused();
    await input.fill('沒有這種東西');
    await expect(page.getByTestId('search-empty')).toContainText('沒找到');
    await expect(page.getByTestId('search-deep').getByRole('button')).toBeDisabled();
    await input.press('Enter');
    await expect(page.getByTestId('search-deep-note')).toHaveAttribute('role', 'status');
    await input.press('Escape');
    await expect(input).toHaveValue('');
    await input.press('Escape');
    await expect(page.getByTestId('search-panel')).toHaveCount(0);

    await page.getByTestId('search-button').click();
    await expect(page.getByTestId('search-input')).toBeFocused();
  });

  test('多詞 AND 與雙引號片語；團隊結果開團隊面板', async ({ page }) => {
    await open(page, '#/search');
    const input = page.getByTestId('search-input');
    await input.fill('手續費 0.1425');
    await expect(rows(page, 'session')).toHaveCount(2);
    // 片語要連在一起：「手續費改成 0.1425」那則不算。
    await input.fill('"手續費 0.1425"');
    await expect(rows(page, 'session')).toHaveCount(1);
    await expect(rows(page, 'session').first()).toContainText('Migrate data');
    await input.fill('"手續費 改成"');
    await expect(page.getByTestId('search-empty')).toBeVisible();

    await input.fill('redirect');
    const team = rows(page, 'team');
    await expect(team.first()).toContainText('登入重構');
    await team.first().click();
    await expect(page).toHaveURL(/#\/team\/team-demo-auth$/);
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
  });

  test('整合：進度卡內容命中在「進度卡與團隊」組，點了聚焦團隊並展開卡片（驗收 4）', async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(async () => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      await useBoard
        .getState()
        .backend.saveProgress(
          { teamId: 'team-demo-auth' },
          { baseRevision: 0, next: '補 zq-卡片 測試', status: '', blockers: '', gmNotes: '' },
        );
    });
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('search-input').fill('zq-卡片');
    const team = rows(page, 'team');
    await expect(team).toHaveCount(1);
    await expect(team.first()).toContainText('登入重構');
    await expect(team.first()).toContainText('補 zq-卡片 測試');
    await team.first().click();
    await expect(page.getByTestId('search-panel')).toHaveCount(0);
    await expect(page.getByTestId('progress-team:team-demo-auth')).toHaveAttribute(
      'data-state',
      'expanded',
    );
  });

  test('遮蔽開著：片段裡沒有金鑰；查詢字是金鑰形狀時提示', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('agent-board.mask-mode', '1'));
    await open(page, '#/search');
    const input = page.getByTestId('search-input');
    await input.fill('token');
    const row = rows(page, 'session').first();
    await expect(row).toContainText('部署設定');
    await expect(row).not.toContainText('sk-ant');
    expect((await queries(page)).at(-1)).toMatchObject({ mask: true });
    await input.fill('sk-ant-demo03-abcdefghijklmnop');
    await expect(page.getByTestId('search-mask-query')).toBeVisible();
  });

  test('範圍、時間、含封存記在本機（重新整理後還在）', async ({ page }) => {
    await open(page, '#/search');
    await page.getByTestId('search-scope-zone').click();
    await page.getByTestId('search-since-30d').click();
    await page.getByTestId('search-archived').check();
    await page.reload();
    await expect(page.getByTestId('search-scope-zone')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('search-since-30d')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('search-archived')).toBeChecked();
  });

  test('開著新 session 次畫面時 ⌘K 不換頁：填到一半的內容不會不見', async ({ page }) => {
    await open(page, '#/new');
    const field = page
      .getByTestId('modal')
      .locator('input[type="text"], input:not([type])')
      .first();
    await field.fill('還沒存的字');
    await field.press('ControlOrMeta+k');
    await expect(page).toHaveURL(/#\/new/);
    await expect(field).toHaveValue('還沒存的字');
  });
});

test.describe('全域搜尋（手機）', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-TW' });

  test('收件匣頂部搜尋鈕 → #/search 全螢幕頁；?q= 深連結；深層按鈕停用；沒有橫向捲動', async ({
    page,
  }) => {
    await open(page, '#/inbox');
    await page.getByTestId('inbox-search').click();
    await expect(page).toHaveURL(/#\/search$/);
    await expect(page.getByTestId('phone-search')).toBeVisible();
    await page.getByTestId('search-input').fill('risk.py');
    await expect(rows(page, 'file')).toHaveCount(2);
    await expect(page.getByTestId('search-deep').getByRole('button')).toBeDisabled();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await open(page, `#/search?q=${encodeURIComponent('0.1425')}`);
    await expect(page.getByTestId('search-input')).toHaveValue('0.1425');
    await expect(rows(page, 'session')).toHaveCount(2);
    // 在等你的（PLAN）→ 收件匣那一項。
    await rows(page, 'session').filter({ hasText: 'Migrate data' }).click();
    await expect(page).toHaveURL(/#\/inbox\/s-etl$/);
  });
});
