// P2 項目二：工作區＋團隊名單面板（docs/p2-spec.md §2.6 驗收）。用 fakeBackend（demo），不花額度、不連外。
// 真 hub 的部分（schema 升級、群發的送字規則、只訂閱目前工作區的終端機）在 hub 單元測試與 team-integration.spec.ts。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const TEAM = 'team-demo-auth';

let problems: string[];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  // 群發不跳確認（GM 決定）：任何原生對話框都算失敗。
  page.on('dialog', (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test.afterEach(() => {
  expect(problems, 'console 不該有錯誤').toEqual([]);
});

async function fake(page: Page, script: string) {
  await page.evaluate(
    async ({ url, script }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: { getState(): { backend: unknown } };
      };
      await new Function('backend', `return (async () => { ${script} })()`)(
        useBoard.getState().backend,
      );
    },
    { url: STORE, script },
  );
}

const card = (page: Page, id: string) => page.getByTestId(`card-${id}`);
const tab = (page: Page, name: string) => page.locator(`[data-zone-name="${name}"]`);

async function addZone(page: Page, name: string) {
  await page.getByTestId('zone-add').click();
  await page.getByTestId('zone-add-input').fill(name);
  await page.getByTestId('zone-add-input').press('Enter');
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}

async function boxOf(page: Page, id: string) {
  return (await card(page, id).boundingBox())!;
}

test('預設只有「主要」；「+」建立並切過去；新工作區畫布是空的，切回來卡片都在', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await expect(tab(page, '主要')).toHaveAttribute('aria-selected', 'true');
  await expect(card(page, 's-auth')).toBeVisible();
  await addZone(page, '交易');
  await expect(page.locator('.react-flow__node')).toHaveCount(0);
  await expect(page.locator('.team')).toHaveCount(0);
  await tab(page, '主要').click();
  await expect(card(page, 's-auth')).toBeVisible();
  await expect(card(page, 's-etl')).toBeVisible();
  // 目前工作區每台裝置自己記（localStorage），重新整理後照用。假後端重新整理會忘掉新建的工作區，
  // 這時記住的那個不存在 → 回到第一個（和工作區被別人刪掉時一樣）。真 hub 的重新整理在 team-integration.spec.ts。
  await tab(page, '交易').click();
  const id = (await tab(page, '交易').getAttribute('data-testid'))!.replace('zone-tab-', '');
  expect(await page.evaluate(() => localStorage.getItem('agent-board.zone.current'))).toBe(
    JSON.stringify(id),
  );
  await page.reload();
  await expect(tab(page, '主要')).toHaveAttribute('aria-selected', 'true');
  await expect(card(page, 's-auth')).toBeVisible();
});

test('把團隊框標籤拖到分頁上：團隊從目前畫布消失、提示「已移到」；切過去看得到成員與交接線，且不疊在原有內容上', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await addZone(page, 'B');
  await tab(page, '主要').click();
  // B 先放一張單獨的卡（卡片選單「移到工作區」），之後團隊要排在它右邊。
  await card(page, 's-etl')
    .getByRole('button', { name: /更多動作/ })
    .click();
  await page.getByTestId('card-move-zone').click();
  await page.locator('[data-testid^="card-move-zone-"]').filter({ hasText: 'B' }).click();
  await expect(card(page, 's-etl')).toHaveCount(0);
  await expect(page.getByTestId('zone-notice')).toContainText('已移到「B」');

  const label = page.getByTestId(`team-open-${TEAM}`);
  await label.dragTo(tab(page, 'B'));
  await expect(card(page, 's-auth')).toHaveCount(0);
  await expect(card(page, 's-tests')).toHaveCount(0);
  await expect(page.locator('.team')).toHaveCount(0);
  await expect(page.getByTestId('zone-notice')).toContainText('已移到「B」');
  // 畫面停在原工作區。
  await expect(tab(page, '主要')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('zone-notice-go').click();
  await expect(tab(page, 'B')).toHaveAttribute('aria-selected', 'true');
  await expect(card(page, 's-auth')).toBeVisible();
  await expect(card(page, 's-tests')).toBeVisible();
  await expect(page.locator('.team')).toHaveCount(1);
  // 團隊內的交接線（s-auth → s-tests）也跟過來。
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
  // 沒有和 B 原有的卡重疊：團隊排在右側。
  const etl = await boxOf(page, 's-etl');
  for (const id of ['s-auth', 's-tests']) {
    const b = await boxOf(page, id);
    expect(b.x, `${id} 在 s-etl 右邊`).toBeGreaterThan(etl.x + etl.width);
  }
});

test('觸控做法：團隊面板頂部的工作區下拉直接移；分頁帶各自的等你數，頁首「等你」是全域；按 N 跨工作區聚焦', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await addZone(page, 'B');
  await tab(page, '主要').click();
  const total = await page.getByTestId('waiting-count').textContent();
  await page.goto(`/#/team/${TEAM}`);
  await page.getByTestId('team-zone-select').selectOption({ label: 'B' });
  await expect(card(page, 's-auth')).toHaveCount(0);
  await expect(page.getByTestId('zone-notice')).toContainText('已移到「B」');
  // s-auth 是 PERM（等你），現在在 B：B 的分頁顯示 1，頁首照算（全域）。
  const bId = (await tab(page, 'B').getAttribute('data-testid'))!.replace('zone-tab-', '');
  await expect(page.getByTestId(`zone-waiting-${bId}`)).toHaveText('1');
  await expect(page.getByTestId('waiting-count')).toHaveText(total!);
  // 收件匣全域：每列有工作區晶片。
  await page.goto('/#/inbox');
  await expect(page.getByTestId('zone-chip-s-auth')).toContainText('B');
  await page.goto('/#/canvas');
  // 「下一個等我的」順序：ERR（s-ml，主要）→ PERM（s-auth，B）。第二下要切到 B 並聚焦它。
  await page.getByTestId('next-up').click();
  await expect(tab(page, '主要')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('next-up').click();
  await expect(tab(page, 'B')).toHaveAttribute('aria-selected', 'true');
  await expect(card(page, 's-auth')).toBeVisible();
  await expect(page.locator('.canvas')).toHaveAttribute('data-focus', 's-auth');
});

test('刪除：非空的工作區按鈕停用並寫數量；清空後可刪；最後一個不能刪', async ({ page }) => {
  await page.goto('/#/canvas');
  await addZone(page, 'B');
  await page.goto(`/#/team/${TEAM}`);
  await page.getByTestId('team-zone-select').selectOption({ label: 'B' });
  await tab(page, 'B').click({ button: 'right' });
  await expect(page.getByTestId('zone-delete')).toBeDisabled();
  await expect(page.getByTestId('zone-delete-blocked')).toContainText(
    '先把 1 個團隊、0 個 session 移到別的工作區',
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('team-zone-select').selectOption({ label: '主要' });
  await tab(page, 'B').click({ button: 'right' });
  await expect(page.getByTestId('zone-delete')).toBeEnabled();
  await page.getByTestId('zone-delete').click();
  await expect(tab(page, 'B')).toHaveCount(0);
  await tab(page, '主要').click({ button: 'right' });
  await expect(page.getByTestId('zone-delete')).toBeDisabled();
  await expect(page.getByTestId('zone-delete-blocked')).toContainText('最後一個工作區不能刪');
  // 改名
  await page.getByTestId('zone-rename').click();
  await page.getByTestId('zone-rename-input').fill('agent-board');
  await page.getByTestId('zone-rename-input').press('Enter');
  await expect(tab(page, 'agent-board')).toBeVisible();
});

test('點團隊框：右側出現面板，名單列數＝成員數，每列狀態代碼和卡片一致；點列聚焦卡片、面板不關', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const frame = (await page.locator('.team').boundingBox())!;
  // 框內空白處（上緣與第一張卡之間）點一下＝開面板。
  await page.mouse.click(frame.x + frame.width - 12, frame.y + 10);
  await expect(page).toHaveURL(new RegExp(`#/team/${TEAM}$`));
  const panel = page.getByTestId('team-panel');
  await expect(panel.getByTestId('team-roster')).toBeVisible();
  const rows = panel.locator('.roster-row');
  await expect(rows).toHaveCount(2);
  for (const id of ['s-auth', 's-tests']) {
    const code = await card(page, id).getAttribute('data-code');
    await expect(panel.getByTestId(`roster-row-${id}`).locator('.lamp')).toHaveAttribute(
      'data-code',
      code!,
    );
  }
  // 隊長在最上面。
  await expect(rows.first()).toHaveAttribute('data-testid', 'roster-row-s-tests');
  await panel.getByTestId('roster-row-s-auth').locator('.roster-age').click();
  await expect(page.locator('.canvas')).toHaveAttribute('data-focus', 's-auth');
  await expect(panel).toBeVisible();
});

test('在團隊框內拖動：畫布平移、不開面板', async ({ page }) => {
  await page.goto('/#/canvas');
  const frame = (await page.locator('.team').boundingBox())!;
  const before = await card(page, 's-auth').boundingBox();
  const x = frame.x + frame.width - 12;
  const y = frame.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 80, y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page).toHaveURL(/#\/canvas$/);
  await expect(page.getByTestId('team-panel')).toHaveCount(0);
  const after = await card(page, 's-auth').boundingBox();
  expect(Math.round(after!.x - before!.x)).toBe(-80);
});

test('角色改成「測試」：重新讀取仍是測試', async ({ page }) => {
  await page.goto(`/#/team/${TEAM}`);
  await page.getByTestId('roster-role-s-auth').selectOption('tester');
  await expect(page.getByTestId('roster-role-s-auth')).toHaveValue('tester');
  // 讀一次 hub（假後端）的資料：存的是 tester。
  await page.evaluate(async (url) => {
    const { useBoard } = (await import(url)) as {
      useBoard: {
        getState(): {
          backend: { listTeamMembers(id: string): Promise<{ sessionId: string; role: string }[]> };
        };
      };
    };
    const members = await useBoard.getState().backend.listTeamMembers('team-demo-auth');
    (window as never as { __roles: unknown }).__roles = members;
  }, STORE);
  const roles = await page.evaluate(() => (window as never as { __roles: unknown }).__roles);
  expect(roles).toContainEqual(expect.objectContaining({ sessionId: 's-auth', role: 'tester' }));
  await expect(page.getByTestId('roster-row-s-auth')).toContainText('測試');
});

test('群發給 4 個成員（ASK、RUN、PERM、NEW）：不跳確認；ASK、NEW 已送出；RUN、PERM 排隊，RUN 變回等輸入才送；排隊中可取消', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await fake(
    page,
    `await backend.putTeamMember('${TEAM}', 's-etl', 'reviewer');
     await backend.putTeamMember('${TEAM}', 's-docs', 'tester');
     backend.patchSession('s-etl', { status: 'waiting_input', statusDetail: null });
     backend.patchSession('s-docs', { status: 'waiting_input', statusDetail: 'idle:start' });
     window.__calls = [];
     const orig = backend.broadcastToTeam.bind(backend);
     backend.broadcastToTeam = (...args) => { window.__calls.push(args); return orig(...args); };`,
  );
  await page.goto(`/#/team/${TEAM}`);
  const panel = page.getByTestId('team-panel');
  await expect(panel.locator('.roster-row')).toHaveCount(4);
  await expect(panel.getByTestId('broadcast-send')).toContainText('送給 4 個 agent');
  await panel.getByTestId('broadcast-input').fill('先停下，回報目前進度');
  await panel.getByTestId('broadcast-input').press('Enter');
  const result = (id: string) => panel.getByTestId(`broadcast-result-${id}`);
  await expect(result('s-etl')).toHaveAttribute('data-state', 'sent');
  await expect(result('s-docs')).toHaveAttribute('data-state', 'sent');
  await expect(result('s-tests')).toHaveAttribute('data-state', 'queued');
  await expect(result('s-tests')).toContainText('排隊中（等 RUN 結束）');
  await expect(result('s-auth')).toHaveAttribute('data-state', 'queued');
  await expect(result('s-auth')).toContainText('PERM');
  expect(await page.evaluate(() => (window as never as { __calls: unknown[] }).__calls)).toEqual([
    [TEAM, '先停下，回報目前進度', undefined],
  ]);
  // RUN 回合結束變回等輸入：才送出。PERM 一直排隊。
  await fake(page, `backend.setSessionStatus('s-tests', 'waiting_input')`);
  await expect(result('s-tests')).toHaveAttribute('data-state', 'sent');
  await expect(result('s-auth')).toHaveAttribute('data-state', 'queued');
  await panel.getByTestId('broadcast-cancel-s-auth').click();
  await expect(result('s-auth')).toHaveAttribute('data-state', 'cancelled');
});

test('@ 點名：選單可搜名稱與角色；只送給點到的，送出的文字拿掉 @名稱；不是本團隊的名稱停用送出鈕', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await fake(
    page,
    `window.__calls = [];
     const orig = backend.broadcastToTeam.bind(backend);
     backend.broadcastToTeam = (...args) => { window.__calls.push(args); return orig(...args); };`,
  );
  await page.goto(`/#/team/${TEAM}`);
  const panel = page.getByTestId('team-panel');
  const input = panel.getByTestId('broadcast-input');
  // 用角色搜：「隊長」只剩 s-tests（Write tests）。
  await input.fill('@隊長');
  await expect(panel.getByTestId('mention-menu').locator('button')).toHaveCount(1);
  await input.press('Enter');
  await expect(input).toHaveValue('@Write tests ');
  await input.pressSequentially('再看一次');
  await expect(panel.getByTestId('broadcast-send')).toContainText('送給 Write tests');
  await input.press('Enter');
  await expect(panel.getByTestId('broadcast-result-s-tests')).toBeVisible();
  await expect(panel.getByTestId('broadcast-result-s-auth')).toHaveCount(0);
  expect(await page.evaluate(() => (window as never as { __calls: unknown[] }).__calls)).toEqual([
    [TEAM, '再看一次', ['s-tests']],
  ]);
  await input.fill('@nobody 看一下');
  await expect(panel.getByTestId('broadcast-send')).toBeDisabled();
  await expect(panel.getByTestId('broadcast-unknown')).toContainText('@nobody');
});

test('全部暫停中：群發照送，送出鈕旁提示「目前全部暫停中」', async ({ page }) => {
  await page.goto('/#/canvas');
  await page.evaluate(async (url) => {
    const { useBoard } = (await import(url)) as {
      useBoard: { setState(patch: object): void };
    };
    useBoard.setState({
      pause: {
        paused: {
          mode: 'finish_turn',
          since: new Date().toISOString(),
          by: null,
          byName: null,
          clearedOnRestart: 0,
        },
        held: { deliveries: 0, sessions: 0, sessionsWaiting: 0, autoContinues: 0 },
      },
    });
  }, STORE);
  await page.goto(`/#/team/${TEAM}`);
  const panel = page.getByTestId('team-panel');
  await expect(panel.getByTestId('broadcast-paused')).toContainText('目前全部暫停中');
  await panel.getByTestId('broadcast-input').fill('go');
  await expect(panel.getByTestId('broadcast-send')).toBeEnabled();
});

test('團隊面板的區塊預設收合，點開在面板內展開；可切寬版', async ({ page }) => {
  await page.goto(`/#/team/${TEAM}`);
  const panel = page.getByTestId('team-panel');
  await expect(panel.getByTestId('column-todo')).toHaveCount(0);
  await panel.getByTestId('fold-toggle-tasks').click();
  await expect(panel.getByTestId('column-todo')).toBeVisible();
  const narrow = (await panel.boundingBox())!.width;
  await panel.getByTestId('team-wide').click();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(narrow + 200);
});

test('團隊清單模式：只列目前工作區的團隊，可切「顯示全部工作區」', async ({ page }) => {
  await page.goto('/#/canvas');
  await addZone(page, 'B');
  await page.goto('/#/team');
  await expect(page.getByTestId(`team-row-${TEAM}`)).toHaveCount(0);
  await page.getByTestId('team-list-all').check();
  await expect(page.getByTestId(`team-row-${TEAM}`)).toContainText('主要');
});

test('手機尺寸：工作區是下拉、帶等你數；團隊面板全螢幕，可以群發，收合區塊寫「回電腦處理」', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/canvas');
  const select = page.getByTestId('zone-select');
  await expect(select).toBeVisible();
  await expect(page.getByTestId('zone-add')).toBeHidden();
  await expect(select.locator('option')).toHaveCount(1);
  // 主要裡有等你的（PERM、PLAN、ERR）：選項帶數量。
  await expect(select.locator('option').first()).toContainText(/主要（等你 \d+）/);
  await page.goto(`/#/team/${TEAM}`);
  const phone = page.getByTestId('phone-team');
  await expect(phone.getByTestId('team-roster')).toBeVisible();
  await expect(phone.getByTestId('fold-tasks')).toContainText('回電腦處理');
  await phone.getByTestId('broadcast-input').fill('手機也能下指令');
  await phone.getByTestId('broadcast-send').click();
  await expect(phone.getByTestId('broadcast-result-s-tests')).toBeVisible();
});
