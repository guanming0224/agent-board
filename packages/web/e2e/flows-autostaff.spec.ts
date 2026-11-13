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

// ── 加開申請（GM 2026-11-13，CONTRACTS §23）：隊長超過上限時向 GM 申請，收件匣同意／拒絕 ──

const REQUEST_ID = 'staff-demo-1';

/** 模擬 hub 記了一件加開申請（假後端的 addStaffRequest）。 */
async function addRequest(page: Page, over: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ id, over }) => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      const now = Date.now();
      useBoard.getState().backend.addStaffRequest({
        id,
        at: new Date(now).toISOString(),
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
        teamId: 'team-demo-auth',
        teamName: '登入重構',
        leadSessionId: 's-tests',
        leadName: 'Write tests',
        limit: 'team_full',
        limits: ['team_full'],
        teamSize: 12,
        teamLimit: 12,
        role: 'tester',
        name: 'Parser-QA',
        reason: 'Nobody tests the parser yet.',
        promptPreview: 'Write regression tests for the parser.',
        promptChars: 38,
        status: 'pending',
        ...over,
      });
    },
    { id: REQUEST_ID, over },
  );
}

test.describe('加開申請（桌面收件匣抽屜）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

  test('沒有申請時不顯示；有申請時列出理由、prompt 摘要；同意後拿掉並記進團隊動態', async ({
    page,
  }) => {
    await openInbox(page);
    const drawer = page.getByTestId('inbox-drawer');
    await expect(drawer.getByTestId('team-activity')).toBeVisible();
    await expect(drawer.getByTestId('staff-requests')).toHaveCount(0);
    await addRequest(page);
    const section = drawer.getByTestId('staff-requests');
    await expect(section.locator('h2')).toContainText('加開申請');
    await expect(section.getByTestId('staff-requests-count')).toHaveText('1');
    const row = section.getByTestId(`staff-request-${REQUEST_ID}`);
    await expect(row.locator('.activity-text')).toHaveText(
      'Write tests 請求加開測試（超過人數上限）',
    );
    await expect(row.getByTestId(`staff-request-reason-${REQUEST_ID}`)).toHaveText(
      '理由：Nobody tests the parser yet.',
    );
    await expect(row.getByTestId(`staff-request-prompt-${REQUEST_ID}`)).toHaveText(
      '工作內容：Write regression tests for the parser.',
    );
    await expect(row).toContainText('名稱：Parser-QA');
    await expect(row).toContainText('目前 12／上限 12 人');
    // 桌面：標準按鈕 36px（STYLE §5.1）。
    const approve = row.getByTestId(`staff-request-approve-${REQUEST_ID}`);
    await expect(approve).toHaveText('同意並開成員');
    const box = await approve.boundingBox();
    expect(Math.round(box!.height)).toBe(36);

    await approve.click();
    await expect(section.getByTestId(`staff-request-${REQUEST_ID}`)).toHaveCount(0);
    await expect(section).toContainText('已同意，開好 Parser-QA。');
    const activity = drawer.getByTestId('team-activity');
    await expect(
      activity.locator('.activity-row[data-kind="staff_approved"] .activity-text'),
    ).toHaveText('已同意 Write tests 的加開申請，開好 Parser-QA（測試）');
  });

  test('prompt 超過摘要：標「共 N 字」，owner 可以展開全文、再收合', async ({ page }) => {
    await openInbox(page);
    const prompt = `Write regression tests. ${'Check every branch. '.repeat(20)}Done.`;
    await addRequest(page, {
      promptPreview: prompt.slice(0, 40),
      promptChars: prompt.length,
      prompt,
    });
    const row = page.getByTestId('inbox-drawer').getByTestId(`staff-request-${REQUEST_ID}`);
    await expect(row.getByTestId(`staff-request-chars-${REQUEST_ID}`)).toHaveText(
      `共 ${prompt.length} 字`,
    );
    const toggle = row.getByTestId(`staff-request-full-${REQUEST_ID}`);
    await expect(toggle).toHaveText('展開全文');
    await toggle.click();
    await expect(row.getByTestId(`staff-request-prompt-${REQUEST_ID}`)).toHaveText(
      `工作內容：${prompt.trim()}`,
    );
    await expect(toggle).toHaveText('收合');
    await toggle.click();
    await expect(row.getByTestId(`staff-request-prompt-${REQUEST_ID}`)).toHaveText(
      `工作內容：${prompt.slice(0, 40)}`,
    );
  });

  test('已經處理過（hub 回 409）：顯示「已經處理過」', async ({ page }) => {
    await openInbox(page);
    await addRequest(page);
    await page.evaluate(async () => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      useBoard.getState().backend.approveStaffRequest = async () => {
        throw Object.assign(new Error('decided'), { status: 409, code: 'request_decided' });
      };
    });
    const drawer = page.getByTestId('inbox-drawer');
    await drawer.getByTestId(`staff-request-approve-${REQUEST_ID}`).click();
    await expect(drawer.getByTestId('staff-requests')).toContainText(
      '這件申請已經處理過（或已失效）。',
    );
  });

  test('拒絕：拿掉申請，團隊動態記一筆；10 分鐘上限的文字', async ({ page }) => {
    await openInbox(page);
    await addRequest(page, { limit: 'spawn_rate', limits: ['spawn_rate'] });
    const drawer = page.getByTestId('inbox-drawer');
    const row = drawer.getByTestId(`staff-request-${REQUEST_ID}`);
    await expect(row.locator('.activity-text')).toHaveText(
      'Write tests 請求加開測試（10 分鐘內新增太多）',
    );
    await row.getByTestId(`staff-request-reject-${REQUEST_ID}`).click();
    await expect(drawer.getByTestId('staff-requests')).toContainText('已拒絕，會通知隊長。');
    await expect(
      drawer
        .getByTestId('team-activity')
        .locator('.activity-row[data-kind="staff_rejected"] .activity-text'),
    ).toHaveText('已拒絕 Write tests 的加開申請（測試）');
  });
});

test.describe('加開申請（手機收件匣）', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 375, height: 760 }, hasTouch: true });

  test('手機：同意／拒絕、展開全文至少 44px（會開 session 的動作 56），不撐出水平捲軸', async ({
    page,
  }) => {
    await openInbox(page);
    await addRequest(page, { promptPreview: 'Write regression…', promptChars: 600 });
    const row = page.getByTestId(`staff-request-${REQUEST_ID}`);
    await expect(row).toBeVisible();
    for (const id of ['approve', 'reject', 'full']) {
      const box = await row.getByTestId(`staff-request-${id}-${REQUEST_ID}`).boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Member requests (English)', () => {
  test.use({ locale: 'en-US', viewport: { width: 1280, height: 900 } });

  test('English labels', async ({ page }) => {
    await openInbox(page);
    await addRequest(page);
    const section = page.getByTestId('inbox-drawer').getByTestId('staff-requests');
    await expect(section.locator('h2')).toContainText('Member requests');
    await expect(
      section.getByTestId(`staff-request-${REQUEST_ID}`).locator('.activity-text'),
    ).toHaveText('Write tests asks to add a tester (over the team size limit)');
    await expect(section.getByTestId(`staff-request-approve-${REQUEST_ID}`)).toHaveText(
      'Approve and start',
    );
  });
});
