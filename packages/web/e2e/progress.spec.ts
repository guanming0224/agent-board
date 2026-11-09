// P3 項目一：畫布進度卡＋Memory（docs/p3-spec.md §1.8 驗收）。用 fakeBackend（demo），不花額度、不連外。
// hub 端（v10 升級、MCP 經 daemon、衝突規則、SafeDelivery 送字、audit）在 hub 單元測試 progress.test.ts；
// 真的 claude 會不會自己讀寫進度卡（驗收 15）要 GM 實機測，這裡不做。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const TEAM = 'team-demo-auth';
const KEY = `team:${TEAM}`;

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

async function fake<T = unknown>(page: Page, script: string): Promise<T> {
  return page.evaluate(
    async ({ url, script }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: { getState(): { backend: unknown } };
      };
      return new Function('backend', `return (async () => { ${script} })()`)(
        useBoard.getState().backend,
      );
    },
    { url: STORE, script },
  ) as Promise<T>;
}

const anchor = (page: Page) => page.getByTestId(`progress-anchor-${KEY}`);
const cardEl = (page: Page) => page.getByTestId(`progress-${KEY}`);

async function writeCard(page: Page, fields: { status?: string; next?: string; gmNotes?: string }) {
  await anchor(page).getByTestId(`progress-${KEY}-add`).click();
  const input = (f: string) => page.getByTestId(`progress-${KEY}-input-${f}`);
  if (fields.status) await input('status').fill(fields.status);
  if (fields.next) await input('next').fill(fields.next);
  if (fields.gmNotes) await input('gmNotes').fill(fields.gmNotes);
  await input('status').press('ControlOrMeta+Enter');
}

test('團隊框旁「+ 進度卡」：寫四欄存檔 → 收合顯示「下一步」第一行與「剛剛・<GM 名稱>」；底部列有 Memory', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await expect(page.getByTestId('command-memory')).toHaveText('Memory');
  await expect(anchor(page).getByTestId(`progress-${KEY}-add`)).toHaveText('+ 進度卡');
  // 卡片在團隊框右側外面（不疊在框上）。
  const frame = await page.locator('.team').first().boundingBox();
  const box = await anchor(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(frame!.x + frame!.width);
  await writeCard(page, {
    status: '回測 2015–2020 完成，**Sharpe 0.8**',
    next: '- 補 2021–2024 資料\n- 再跑',
    gmNotes: '手續費一律用 0.1425%',
  });
  // 存完是展開的；看得到粗體與 GM 備註。
  await expect(cardEl(page)).toHaveAttribute('data-state', 'expanded');
  await expect(cardEl(page).locator('.f-status b')).toHaveText('Sharpe 0.8');
  await expect(cardEl(page).getByTestId('progress-field-gmNotes')).toContainText('0.1425%');
  await cardEl(page).getByTestId(`progress-${KEY}-collapse`).click();
  await expect(cardEl(page)).toHaveAttribute('data-state', 'collapsed');
  await expect(page.getByTestId(`progress-${KEY}-next`)).toHaveText('下一步：補 2021–2024 資料');
  await expect(cardEl(page)).toContainText('剛剛・demo');
  // 不用狀態色或團隊色當底。
  const bg = await cardEl(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(20, 24, 31)');
});

test('編輯中 agent 寫入：編輯框不被覆蓋、出現「更新了…」；同欄衝突並排比對，選「用我的」後存成功', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await writeCard(page, { next: 'A' });
  await cardEl(page).getByTestId(`progress-${KEY}-edit`).click();
  const next = page.getByTestId(`progress-${KEY}-input-next`);
  await next.fill('GM 的下一步');
  expect(
    await fake(
      page,
      `return backend.agentProgress({ teamId: '${TEAM}' }, 's-tests', { baseRevision: 1, next: 'agent 的下一步' });`,
    ),
  ).toBe('ok');
  await expect(page.getByTestId(`progress-${KEY}-changed`)).toContainText('Write tests');
  await expect(page.getByTestId(`progress-${KEY}-changed`)).toContainText('更新了「下一步」');
  await expect(next).toHaveValue('GM 的下一步');
  await page.getByTestId(`progress-${KEY}-save`).click();
  const conflict = page.getByTestId(`progress-${KEY}-conflict`);
  await expect(conflict).toContainText('你的版本');
  await expect(conflict).toContainText('GM 的下一步');
  await expect(conflict).toContainText('agent 的下一步');
  await expect(page.getByTestId(`progress-${KEY}-save`)).toBeDisabled();
  await page.getByTestId(`progress-${KEY}-conflict-next-mine`).click();
  await page.getByTestId(`progress-${KEY}-save`).click();
  await expect(cardEl(page).getByTestId('progress-field-next')).toHaveText(/GM 的下一步/);
  await expect(cardEl(page)).toHaveAttribute('data-revision', '3');
});

test('鎖定後 agent 寫入被拒、解鎖後可寫；歷史：寫 3 次列出 3 版，還原第 1 版產生第 4 版', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await writeCard(page, { next: 'one' });
  await cardEl(page).getByTestId(`progress-${KEY}-lock`).click();
  await expect(cardEl(page)).toContainText('已鎖定');
  const agent = (rev: number, text: string) =>
    fake(
      page,
      `return backend.agentProgress({ teamId: '${TEAM}' }, 's-tests', { baseRevision: ${rev}, next: '${text}' });`,
    );
  expect(await agent(1, 'x')).toBe('card_locked');
  await cardEl(page).getByTestId(`progress-${KEY}-lock`).click();
  await expect(cardEl(page)).not.toContainText('已鎖定');
  expect(await agent(1, 'two')).toBe('ok');
  expect(await agent(2, 'three')).toBe('ok');
  await cardEl(page).getByTestId(`progress-${KEY}-history`).click();
  const list = page.getByTestId(`progress-${KEY}-history-list`);
  await expect(list.locator('li')).toHaveCount(3);
  await page.getByTestId(`progress-${KEY}-restore-1`).click();
  await expect(cardEl(page)).toHaveAttribute('data-revision', '4');
  await expect(cardEl(page).getByTestId('progress-field-next')).toHaveText('下一步one');
  await expect(list.locator('li')).toHaveCount(4);
});

test('遮蔽模式：卡片、編輯中「看差異」、衝突並排、歷史都看不到金鑰原文；編輯時有提示', async ({
  page,
}) => {
  const SECRET = 'sk-ant-demo0123456789abcdefXYZ';
  await page.addInitScript(() => localStorage.setItem('agent-board.mask-mode', '1'));
  await page.goto('/#/canvas');
  await writeCard(page, { status: `token ${SECRET}`, next: 'A' });
  await expect(cardEl(page).getByTestId('progress-field-status')).toContainText('token ***');
  await expect(cardEl(page)).not.toContainText(SECRET);
  // 編輯中 agent 改了同一欄：看差異與衝突並排都要遮。
  await cardEl(page).getByTestId(`progress-${KEY}-edit`).click();
  await expect(page.getByTestId(`progress-${KEY}-mask-note`)).toContainText('遮蔽模式開著');
  await page.getByTestId(`progress-${KEY}-input-next`).fill(`mine ${SECRET}`);
  expect(
    await fake(
      page,
      `return backend.agentProgress({ teamId: '${TEAM}' }, 's-tests', { baseRevision: 1, next: 'theirs ${SECRET}' });`,
    ),
  ).toBe('ok');
  const changed = page.getByTestId(`progress-${KEY}-changed`);
  await changed.getByRole('button').click();
  await expect(changed.locator('.progress-diff')).toContainText('theirs ***');
  await expect(changed).not.toContainText(SECRET);
  await page.getByTestId(`progress-${KEY}-save`).click();
  const conflict = page.getByTestId(`progress-${KEY}-conflict`);
  await expect(conflict).toContainText('mine ***');
  await expect(conflict).toContainText('theirs ***');
  await expect(conflict).not.toContainText(SECRET);
  // P3 整合：展開的卡（衝突並排很高）底部停在底部指令列上方，內容在卡裡捲動，取消鈕點得到。
  const cardBox = (await anchor(page).boundingBox())!;
  const barBox = (await page.getByTestId('command-bar').boundingBox())!;
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(barBox.y);
  await page.getByTestId(`progress-${KEY}-cancel`).click();
  // 歷史的逐欄差異。
  await cardEl(page).getByTestId(`progress-${KEY}-history`).click();
  const list = page.getByTestId(`progress-${KEY}-history-list`);
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list).toContainText('token ***');
  await expect(list).toContainText('theirs ***');
  await expect(list).not.toContainText(SECRET);
});

test('帶入進度卡給 RUN 的隊長：排隊中，等輸入後送出；請隊長更新有 ◈ 耗額度晶片、送固定字串', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await writeCard(page, { status: 'S', next: 'N' });
  await fake(
    page,
    `window.__calls = [];
     const deliver = backend.deliverProgress.bind(backend);
     backend.deliverProgress = (...a) => { window.__calls.push(['deliver', ...a]); return deliver(...a); };
     const ask = backend.askProgressUpdate.bind(backend);
     backend.askProgressUpdate = async (...a) => { const b = await ask(...a); window.__calls.push(['ask', b.text]); return b; };`,
  );
  await cardEl(page).getByTestId(`progress-${KEY}-deliver`).click();
  await page.getByTestId(`progress-${KEY}-deliver-s-tests`).click();
  const sent = cardEl(page).getByTestId(`progress-${KEY}-sent`);
  await expect(sent).toHaveAttribute('data-state', 'queued');
  await expect(sent).toContainText('排隊中');
  await fake(page, `backend.setSessionStatus('s-tests', 'waiting_input');`);
  await expect(sent).toHaveAttribute('data-state', 'sent');
  await expect(cardEl(page).getByTestId(`progress-${KEY}-ask-cost`)).toHaveText('◈ 耗額度');
  await cardEl(page).getByTestId(`progress-${KEY}-ask`).click();
  await expect(sent).toHaveAttribute('data-kind', 'ask_update');
  const calls = await page.evaluate(() => (window as never as { __calls: unknown[] }).__calls);
  expect(calls).toEqual([
    ['deliver', { teamId: TEAM }, 's-tests'],
    [
      'ask',
      '[Board] Please update the team progress card with update_progress (status, next, blockers).',
    ],
  ]);
  // 團隊名單的「最新群發結果」只看真正的群發，進度卡送字不會取代它。
  await page.goto(`/#/team/${TEAM}`);
  await expect(page.getByTestId('team-progress')).toBeVisible();
  await expect(page.getByTestId('team-panel').getByTestId('broadcast-result-s-tests')).toHaveCount(
    0,
  );
});

test('Memory 面板：列數＝目前工作區的卡數；⚠ 久未更新排最前；點列聚焦並展開卡片（別的工作區先切過去）', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await writeCard(page, { next: '登入的下一步' });
  // 單獨 session 的卡（Migrate data）＋另一個工作區的團隊卡。
  await fake(
    page,
    `await backend.saveProgress({ sessionId: 's-etl' }, { baseRevision: 0, next: 'ETL 下一步' });
     const zone = await backend.createZone('研究');
     const team = await backend.createTeam({ name: '別區', goal: '', doneCriteria: '', color: 'lime', contextMd: '', zoneId: zone.id });
     await backend.putTeamMember(team.id, 's-ml', 'lead');
     await backend.putTeamMember(team.id, 's-docs', 'worker');
     await backend.saveProgress({ teamId: team.id }, { baseRevision: 0, next: '別區下一步' });
     window.__far = team.id;
     const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
     backend.patchProgress({ sessionId: 's-etl' }, { updatedAt: old, facts: { lastStopAt: new Date().toISOString() } });`,
  );
  await page.getByTestId('command-memory').click();
  await expect(page).toHaveURL(/#\/memory$/);
  const panel = page.getByTestId('memory-panel');
  const rows = panel.locator('.memory-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-testid', 'memory-row-session:s-etl');
  await expect(rows.first()).toContainText('⚠ 3 天沒更新');
  await panel.getByTestId('memory-scope-all').click();
  await expect(rows).toHaveCount(3);
  const far = await page.evaluate(() => (window as never as { __far: string }).__far);
  await panel.getByTestId(`memory-row-team:${far}`).click();
  // 切到「研究」工作區、卡片展開，面板還開著。
  await expect(page.getByTestId(`progress-team:${far}`)).toHaveAttribute('data-state', 'expanded');
  await expect(page.locator('[data-zone-name="研究"]')).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toBeVisible();
  await panel.getByTestId('memory-scope-current').click();
});

test('手機（390×844）：團隊面板最上方有進度卡、可編輯；收件匣某列有「下一步：…」，點了展開整張卡', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/inbox');
  await fake(
    page,
    `await backend.saveProgress({ teamId: '${TEAM}' }, { baseRevision: 0, next: '先修 redirect\\n- 再補測試' });`,
  );
  const hint = page.getByTestId('inbox-progress-s-auth');
  await expect(hint).toHaveText('下一步：先修 redirect');
  await hint.click();
  await expect(page.getByTestId('inbox-progress-card-s-auth')).toHaveAttribute(
    'data-state',
    'expanded',
  );
  await page.goto(`/#/team/${TEAM}`);
  const card = page.getByTestId('team-progress');
  await expect(card).toBeVisible();
  // 進度卡在名單上方。
  const cardBox = await card.boundingBox();
  const roster = await page.locator('.roster, [data-testid="team-roster"]').first().boundingBox();
  if (roster) expect(cardBox!.y).toBeLessThan(roster.y);
  await page.getByTestId('team-progress-edit').click();
  const edit = page.getByTestId('team-progress-input-blockers');
  await edit.fill('等 GM 決定手續費');
  const save = page.getByTestId('team-progress-save');
  // 手機可點元素至少 44（GM 2026-11-09 Q1；56 只給會動到 session 的動作）。
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await save.click();
  await expect(card.getByTestId('progress-field-blockers')).toContainText('等 GM 決定手續費');
});
