// 全域搜尋的畫面（P3 §3.3、§3.4、§3.8）：假後端（demo 資料），不連外、不呼叫 LLM。
// 假後端的 search 換成記錄呼叫次數的替身（停 250ms 才送、1 個字不送）；deepSearch 換成記錄送出與取消的替身。
// 深層（③b）的假後端：demo-studio 300ms 回結果、demo-gpu 慢（1.5 秒）、demo-laptop 失聯。
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
    const deep: { searchId: string; q: string; cancelled: boolean }[] = [];
    const realDeep = backend.deepSearch.bind(backend);
    backend.deepSearch = (request: { q: string }, listener: unknown) => {
      const handle = realDeep(request, listener);
      const record = { searchId: handle.searchId, q: request.q, cancelled: false };
      deep.push(record);
      return {
        searchId: handle.searchId,
        cancel: () => {
          record.cancelled = true;
          handle.cancel();
        },
      };
    };
    Object.assign(window, { __queries: queries, __deep: deep });
  });
}

const deepCalls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __deep: { searchId: string; q: string; cancelled: boolean }[] })
        .__deep,
  );

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

  test('/ 與頁首按鈕都能開；Esc 先清字再關；沒找到時 Enter 搜各台機器，都沒有就說沒找到', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('/');
    const input = page.getByTestId('search-input');
    await expect(input).toBeFocused();
    await input.fill('沒有這種東西');
    await expect(page.getByTestId('search-empty')).toContainText('按 Enter 也搜對話與終端機');
    await expect(page.getByTestId('search-deep-button')).toBeEnabled();
    await input.press('Enter');
    await expect(page.getByTestId('search-deep-empty')).toContainText('各台機器都沒找到', {
      timeout: 5_000,
    });
    await expect(page.getByTestId('search-deep-machine-m-laptop')).toContainText('失聯沒搜到');
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

  test('深層：Enter 才搜各台機器；一台 300ms 回 2 筆、一台失聯；結果帶機器晶片；⌘Enter 開對話紀錄並捲到那則（驗收 5）', async ({
    page,
  }) => {
    await open(page);
    await page.locator('.react-flow__pane').click();
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByTestId('search-input');
    await input.fill('手續費 0.1425');
    await expect(rows(page, 'session')).toHaveCount(2);
    // 打字只跑快速層。
    expect(await deepCalls(page)).toEqual([]);
    await input.press('Enter');
    expect((await deepCalls(page)).map((c) => c.q)).toEqual(['手續費 0.1425']);
    const studio = page.getByTestId('search-deep-machine-m-studio');
    await expect(studio).toContainText('demo-studio：搜尋中');
    await expect(studio).toContainText('demo-studio：完成 2 筆');
    await expect(page.getByTestId('search-deep-machine-m-laptop')).toContainText(
      'demo-laptop：失聯沒搜到',
    );
    // demo-gpu 慢：studio 完成時它還在搜，不擋 studio 的結果。
    await expect(page.getByTestId('search-deep-machine-m-gpu')).toContainText('搜尋中');
    const deepRows = page.getByTestId('search-group-transcript').getByTestId('search-row');
    const auth = deepRows.filter({ hasText: 'Fix login' });
    await expect(auth).toHaveCount(2);
    await expect(auth.first()).toContainText('demo-studio');
    await expect(auth.first().locator('.search-hit').first()).toHaveText('手續費');
    // demo-gpu 慢：1.5 秒後才補上（畫面 1 筆＋對話 2 筆）。
    await expect(page.getByTestId('search-deep-machine-m-gpu')).toContainText(
      'demo-gpu：完成 3 筆',
    );
    await expect(deepRows).toHaveCount(5);
    await expect(page.getByTestId('search-group-transcript')).toContainText('終端機畫面');
    await expect(page.getByTestId('search-group-transcript')).toContainText('demo-gpu');

    // ↑↓ 選到 Fix login 的 #32 那一列，⌘Enter 開對話紀錄、捲到那則（序號 31）。
    const target = auth.filter({ hasText: '對話 #32' });
    for (let i = 0; i < 20; i += 1) {
      if ((await target.getAttribute('aria-selected')) === 'true') break;
      await input.press('ArrowDown');
    }
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await input.press('ControlOrMeta+Enter');
    await expect(page).toHaveURL(/#\/transcript\/s-auth\?at=31$/);
    const focused = page.locator('[data-testid="transcript-entry"][aria-current="true"]');
    await expect(focused).toHaveAttribute('data-index', '31');
    await expect(focused).toContainText('手續費 0.1425');
    await expect(focused).toBeInViewport();
    await expect(page.getByTestId('transcript-from')).toContainText('從第 27 則開始顯示');
    await page.getByTestId('transcript-from').getByRole('button').click();
    await expect(page.locator('[data-testid="transcript-entry"]').first()).toHaveAttribute(
      'data-index',
      '0',
    );

    // 關掉對話紀錄（Esc）回到搜尋視窗，不是畫布：查詢字、深層結果、選到的那一列都還在，焦點回搜尋框。
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/search\?q=/);
    await expect(page.getByTestId('search-panel')).toBeVisible();
    await expect(input).toHaveValue('手續費 0.1425');
    await expect(input).toBeFocused();
    await expect(deepRows).toHaveCount(5);
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('search-deep-machine-m-gpu')).toContainText(
      'demo-gpu：完成 3 筆',
    );
    // 沒有重搜：深層只叫過一次。
    expect((await deepCalls(page)).map((c) => c.q)).toEqual(['手續費 0.1425']);

    // ⌘點擊另一列開對話紀錄，按 ✕ 關掉：一樣回到搜尋視窗、結果還在。
    await auth.filter({ hasNotText: '對話 #32' }).click({ modifiers: ['ControlOrMeta'] });
    await expect(page).toHaveURL(/#\/transcript\/s-auth/);
    await expect(page.getByTestId('search-panel')).toBeHidden();
    await page.getByTestId('modal-close').click();
    await expect(page).toHaveURL(/#\/search\?q=/);
    await expect(input).toHaveValue('手續費 0.1425');
    await expect(input).toBeFocused();
    await expect(deepRows).toHaveCount(5);
    expect((await deepCalls(page)).map((c) => c.q)).toEqual(['手續費 0.1425']);
  });

  test('深層搜尋中改字：舊的 searchId 送出取消、舊結果不再出現；再按一次 Enter 也取消上一次（驗收 6）', async ({
    page,
  }) => {
    await open(page, '#/search');
    const input = page.getByTestId('search-input');
    await input.fill('手續費 0.1425');
    await expect(rows(page, 'session')).toHaveCount(2);
    await input.press('Enter');
    await expect(page.getByTestId('search-deep-machine-m-studio')).toContainText('完成 2 筆');
    // demo-gpu 還在搜（1.5 秒）：改字。
    await input.press('Backspace');
    const calls = await deepCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cancelled).toBe(true);
    await expect(page.getByTestId('search-deep')).toHaveAttribute('data-state', 'idle');
    await page.waitForTimeout(1_800);
    await expect(page.getByTestId('search-group-transcript')).toHaveCount(0);
    await expect(page.getByTestId('search-deep-machines')).toHaveCount(0);

    await input.press('Enter');
    await input.press('Enter');
    const again = await deepCalls(page);
    expect(again).toHaveLength(3);
    expect(again[1]!.cancelled).toBe(true);
    expect(again[2]!.cancelled).toBe(false);
    await expect(page.getByTestId('search-deep-machine-m-gpu')).toContainText('完成', {
      timeout: 5_000,
    });
  });

  test('深層：遮蔽開著時片段裡沒有金鑰；查詢字像金鑰就不送出', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('agent-board.mask-mode', '1'));
    await open(page, '#/search');
    const input = page.getByTestId('search-input');
    await input.fill('FEE_TOKEN');
    await input.press('Enter');
    const deepRows = page.getByTestId('search-group-transcript').getByTestId('search-row');
    await expect(deepRows.first()).toContainText('FEE_TOKEN', { timeout: 5_000 });
    await expect(page.getByTestId('search-group-transcript')).not.toContainText('sk-ant');
    await input.fill('sk-ant-demo03-abcdefghijklmnop');
    await input.press('Enter');
    await expect(page.getByTestId('search-deep-blocked')).toBeVisible();
    expect((await deepCalls(page)).map((c) => c.q)).toEqual(['FEE_TOKEN']);
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

  test('收件匣頂部搜尋鈕 → #/search 全螢幕頁；?q= 深連結；深層要按按鈕才跑（驗收 13）；沒有橫向捲動', async ({
    page,
  }) => {
    await open(page, '#/inbox');
    await page.getByTestId('inbox-search').click();
    await expect(page).toHaveURL(/#\/search$/);
    await expect(page.getByTestId('phone-search')).toBeVisible();
    await page.getByTestId('search-input').fill('risk.py');
    await expect(rows(page, 'file')).toHaveCount(2);
    // 手機上 Enter 不跑深層（省流量與電）；按鈕才跑。
    await page.getByTestId('search-input').press('Enter');
    await page.waitForTimeout(400);
    expect(await deepCalls(page)).toEqual([]);
    await page.getByTestId('search-deep-button').click();
    await expect(page.getByTestId('search-deep-machine-m-laptop')).toContainText('失聯沒搜到');
    expect((await deepCalls(page)).map((c) => c.q)).toEqual(['risk.py']);
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
