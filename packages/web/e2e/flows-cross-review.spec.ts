// 交叉審查（Codex 第二輪）：從卡片選單發起 → 看檔案清單與大小 → 確認才送 → 左右並排的結果 → 收件匣有項目。
// 用 demo 假後端（Claude 先完成、Codex 稍後完成；沒裝 codex 的機器 Codex 略過）。不連外、不呼叫 LLM。
import { expect, test, type Page } from './flows-fixture';

async function openCanvas(page: Page) {
  await page.goto('about:blank');
  await page.goto('/?demo=1#/canvas');
}

test.describe('交叉審查（桌面）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

  test('卡片選單 → 檔案清單 → 確認 → 兩邊並排完成 → 收件匣有項目、打開就算讀過', async ({
    page,
  }) => {
    await openCanvas(page);
    // demo-gpu 那台有 Codex CLI：兩邊都會跑。
    await page.locator('.react-flow__node[data-id="s-etl"] .menu-btn').click();
    await page.getByTestId('card-cross-review').click();
    await expect(page).toHaveURL(/#\/cross-review\/new\?session=s-etl$/);
    const form = page.getByTestId('cross-review-new');
    await expect(form.getByTestId('cross-review-session')).toHaveValue('s-etl');
    await form.getByTestId('cross-review-prepare').click();

    // 只產生 diff，還沒跑：等確認、列出檔案與大小、截斷標記。
    const view = page.getByTestId('cross-review-view');
    await expect(view).toHaveAttribute('data-status', 'awaiting_confirm');
    await expect(page).toHaveURL(/#\/cross-review\/[0-9a-f-]{36}$/);
    const files = view.getByTestId('cross-review-file');
    await expect(files).toHaveCount(3);
    await expect(view.getByTestId('cross-review-files').locator('summary')).toContainText(
      '3 個，共 208 KB，+5330 −7',
    );
    await expect(files.nth(2)).toContainText('已截斷');
    await expect(view.getByTestId('cross-review-sides')).toHaveCount(0);

    await view.getByTestId('cross-review-confirm').click();
    await expect(view).toHaveAttribute('data-status', 'running');
    const claude = view.getByTestId('cross-review-side-claude');
    const codex = view.getByTestId('cross-review-side-codex');
    await expect(claude).toHaveAttribute('data-status', 'done');
    await expect(view.getByTestId('cross-review-output-claude')).toContainText('整體結論');
    await expect(codex).toHaveAttribute('data-status', 'done');
    await expect(view.getByTestId('cross-review-output-codex')).toContainText('嚴重問題');
    await expect(view).toHaveAttribute('data-status', 'done');
    // 左右並排。
    const a = await claude.boundingBox();
    const b = await codex.boundingBox();
    expect(a && b && b.x > a.x + a.width - 1 && Math.abs(a.y - b.y) < 2).toBe(true);

    // 開著的這份已經算讀過。到收件匣（demo 後端重新建立）另外發起一份、不打開：完成後出現在收件匣。
    await page.goto('/?demo=1#/inbox');
    await page.evaluate(async () => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      const { backend } = useBoard.getState();
      const r = await backend.prepareReview({ kind: 'session', sessionId: 's-ml' });
      await backend.startReview(r.id);
    });
    const inbox = page.getByTestId('inbox-drawer').getByTestId('cross-review-inbox');
    await expect(inbox.getByTestId('cross-review-unread')).toHaveText('1');
    await inbox.locator('a.link').first().click();
    await expect(page.getByTestId('cross-review-view')).toHaveAttribute('data-status', 'done');
    await expect(inbox).toHaveCount(0);
  });

  test('沒有 Codex 的機器：Codex 那一邊標「略過」與原因，只跑 Claude；可以取消還沒確認的', async ({
    page,
  }) => {
    await openCanvas(page);
    await page.goto('/?demo=1#/cross-review/new?session=s-auth');
    await page.getByTestId('cross-review-prepare').click();
    const view = page.getByTestId('cross-review-view');
    await expect(view).toHaveAttribute('data-status', 'awaiting_confirm');
    await view.getByTestId('cross-review-confirm').click();
    await expect(view.getByTestId('cross-review-side-codex')).toHaveAttribute(
      'data-status',
      'skipped',
    );
    await expect(view.getByTestId('cross-review-side-codex')).toContainText('沒有 Codex CLI');
    await expect(view).toHaveAttribute('data-status', 'done');

    await page.goto('/?demo=1#/cross-review/new?session=s-auth');
    await page.getByTestId('cross-review-prepare').click();
    await page.getByTestId('cross-review-cancel').click();
    await expect(page.getByTestId('cross-review-view')).toHaveAttribute('data-status', 'cancelled');
  });
});
