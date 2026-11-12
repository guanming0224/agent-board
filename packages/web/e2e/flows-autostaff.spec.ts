// 隊長自主擴編（GM 2026-11-10）：收件匣的「團隊動態」——隊長新增或封存了成員，只是告知、不算「等你」。
// 用 demo 假後端（一筆「Write tests 新增了 Fix login」）。不連外、不呼叫 LLM。
import { expect, test, type Page } from './flows-fixture';

const ROW = 'team-activity-activity-demo-1';

async function openInbox(page: Page) {
  await page.goto('about:blank');
  await page.goto('/?demo=1#/inbox');
}

const waitingCount = (page: Page) =>
  page.evaluate(async () => {
    const path = '/src/shared/store.ts';
    const { useBoard } = await import(/* @vite-ignore */ path);
    return (useBoard.getState().teamActivity ?? []).length as number;
  });

test.describe('團隊動態（桌面收件匣抽屜）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

  test('列出隊長新增的成員與理由；在畫布上看、標已讀、清除', async ({ page }) => {
    await openInbox(page);
    const drawer = page.getByTestId('inbox-drawer');
    const section = drawer.getByTestId('team-activity');
    await expect(section).toBeVisible();
    await expect(section.locator('h2')).toContainText('團隊動態');
    await expect(section.getByTestId('team-activity-unread')).toHaveText('1');
    const row = section.getByTestId(ROW);
    await expect(row).toHaveAttribute('data-read', '0');
    await expect(row.locator('.activity-text')).toHaveText('Write tests 新增了 Fix login（成員）');
    await expect(row.locator('.activity-reason')).toHaveText(
      '理由：Nobody on the team edits the login code yet.',
    );
    await expect(row.locator('.activity-team')).toHaveText('登入重構');

    await row.getByTestId('team-activity-show-activity-demo-1').click();
    await expect(page.locator('.canvas')).toHaveAttribute('data-focus', 's-auth');

    await row.getByTestId('team-activity-read-activity-demo-1').click();
    await expect(row).toHaveAttribute('data-read', '1');
    await expect(section.getByTestId('team-activity-unread')).toHaveCount(0);
    await expect(section.getByTestId('team-activity-read-all')).toHaveCount(0);
    await expect(row.locator('.activity-dot')).toHaveCount(0);

    await row.getByTestId('team-activity-clear-activity-demo-1').click();
    await expect(section).toHaveCount(0);
    expect(await waitingCount(page)).toBe(0);
  });

  test('全部標已讀、全部清除；超過 5 筆收合', async ({ page }) => {
    await openInbox(page);
    // 多塞幾筆（模擬 hub 推 team.activity）。
    await page.evaluate(async () => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      const base = useBoard.getState().teamActivity[0];
      const more = Array.from({ length: 6 }, (_, i) => ({
        ...base,
        id: `extra-${i}`,
        kind: i % 2 === 0 ? 'member_released' : 'member_added',
        memberName: `LD-BD${i}`,
        reason: `Reason ${i}`,
      }));
      useBoard.setState({ teamActivity: [...more, base] });
    });
    const section = page.getByTestId('inbox-drawer').getByTestId('team-activity');
    await expect(section.locator('.activity-row')).toHaveCount(5);
    await expect(section.getByTestId('team-activity-extra-0').locator('.activity-text')).toHaveText(
      'Write tests 封存了 LD-BD0（成員）',
    );
    await section.getByTestId('team-activity-more').click();
    await expect(section.locator('.activity-row')).toHaveCount(7);
    await expect(section.getByTestId('team-activity-unread')).toHaveText('7');
    await section.getByTestId('team-activity-read-all').click();
    await expect(section.locator('.activity-row.unread')).toHaveCount(0);
    await section.getByTestId('team-activity-clear-all').click();
    await expect(section).toHaveCount(0);
  });
});

test.describe('團隊動態（手機收件匣）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 375, height: 760 }, hasTouch: true });

  test('手機也看得到、可以標已讀與清除；沒有「在畫布上看」；不撐出水平捲軸', async ({ page }) => {
    await openInbox(page);
    const section = page.getByTestId('team-activity');
    await expect(section).toBeVisible();
    await expect(section.getByTestId(ROW).locator('.activity-text')).toHaveText(
      'Write tests 新增了 Fix login（成員）',
    );
    await expect(section.getByTestId('team-activity-show-activity-demo-1')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await section.getByTestId('team-activity-read-all').click();
    await expect(section.getByTestId(ROW)).toHaveAttribute('data-read', '1');
    await section.getByTestId('team-activity-clear-all').click();
    await expect(section).toHaveCount(0);
  });
});

test.describe('Team activity (English)', () => {
  test.use({ locale: 'en-US', viewport: { width: 1280, height: 900 } });

  test('English labels', async ({ page }) => {
    await openInbox(page);
    const section = page.getByTestId('inbox-drawer').getByTestId('team-activity');
    await expect(section.locator('h2')).toContainText('Team activity');
    await expect(section.getByTestId(ROW).locator('.activity-text')).toHaveText(
      'Write tests added Fix login (worker)',
    );
    await expect(section.getByTestId(ROW).locator('.activity-reason')).toHaveText(
      'Reason: Nobody on the team edits the login code yet.',
    );
  });
});
