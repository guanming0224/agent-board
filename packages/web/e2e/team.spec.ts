// 用 fakeBackend 完整操作團隊工作台與畫布上的團隊資料。不花額度、不連外。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const SHOTS = process.env.TEAM_SHOTS;

let problems: string[];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test.afterEach(() => {
  expect(problems, 'console 不該有錯誤').toEqual([]);
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function fake(page: Page, script: string) {
  await page.evaluate(
    async ({ url, script }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: { getState(): { backend: unknown } };
      };
      new Function('backend', script)(useBoard.getState().backend);
    },
    { url: STORE, script },
  );
}

const setStatus = (page: Page, id: string, status: string) =>
  fake(page, `backend.setSessionStatus(${JSON.stringify(id)}, ${JSON.stringify(status)})`);

async function openWorkbench(page: Page) {
  await page.goto('/#/team/team-demo-auth');
  await expect(page.getByTestId('team-workbench')).toBeVisible();
  await expect(page.getByTestId('column-todo')).toBeVisible();
}

const task = (page: Page, title: string) => page.locator('.task', { hasText: title });

test('分頁列的團隊可以點，清單列出團隊，新建後進工作台', async ({ page }) => {
  await page.goto('/#/canvas');
  await page.getByRole('link', { name: '團隊' }).click();
  await expect(page).toHaveURL(/#\/team$/);
  await expect(page.getByRole('link', { name: '團隊' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.team-row')).toContainText('登入重構');
  await expect(page.locator('.team-row')).toContainText('2 位成員');
  await shot(page, 'team-list');

  await expect(page.getByRole('button', { name: '建立團隊' })).toBeDisabled();
  await page.getByLabel('團隊名稱').fill('資料搬遷');
  await page.getByRole('button', { name: '靛' }).click();
  await page.getByRole('button', { name: '建立團隊' }).click();
  await expect(page.getByRole('heading', { name: '資料搬遷' })).toBeVisible();
  await expect(page).toHaveURL(/#\/team\/.+/);
  await expect(
    page.getByRole('group', { name: '團隊顏色' }).getByRole('button', { name: '靛' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('找不到的團隊不會當機，可以回清單', async ({ page }) => {
  await page.goto('/#/team/nope');
  await expect(page.getByText('找不到這個團隊')).toBeVisible();
  await page.getByRole('button', { name: '回團隊清單' }).click();
  await expect(page).toHaveURL(/#\/team$/);
});

test('目標與完成條件可編輯，重新輪詢不蓋掉草稿', async ({ page }) => {
  await openWorkbench(page);
  const goal = page.getByLabel('目標', { exact: true });
  await expect(goal).toHaveValue(/Fix the login/);
  await goal.fill('新的目標');
  const panel = page.locator('section', { hasText: '目標與完成條件' });
  // 等過一次工作台的輪詢
  await page.waitForTimeout(5500);
  await expect(goal).toHaveValue('新的目標');
  await panel.getByRole('button', { name: '儲存' }).click();
  await expect(panel.getByRole('status')).toHaveText('已儲存');
  await page.goto('/#/team');
  await expect(page.locator('.team-row')).toContainText('新的目標');
});

test('成員有放手線、模式晶片、狀態；角色可改；可移出，連帶移除交接規則', async ({ page }) => {
  await openWorkbench(page);
  const member = page.getByTestId('member-s-auth');
  await expect(member.locator('.lamp')).toContainText('等你允許');
  await expect(member.locator('.callsign')).toContainText('demo-studio');
  await expect(member.locator('.chip.mode')).toHaveText('default');
  await expect(member).toHaveClass(/h-/);
  await expect(page.getByTestId('rule-rule-1')).toBeVisible();

  const role = page.getByLabel('Fix login 的角色');
  await expect(role).toHaveValue('worker');
  await role.selectOption('reviewer');
  await page.goto('/#/team');
  await page.goto('/#/team/team-demo-auth');
  await expect(page.getByLabel('Fix login 的角色')).toHaveValue('reviewer');

  await member.getByRole('button', { name: '移出團隊' }).click();
  await expect(member).toHaveCount(0);
  await expect(page.getByTestId('rule-rule-1')).toHaveCount(0);
});

test('同一資料夾沒有 worktree 不能加入團隊，要提示怎麼做', async ({ page }) => {
  await page.goto('/#/team');
  await page.getByLabel('團隊名稱').fill('撞資料夾');
  await page.getByRole('button', { name: '建立團隊' }).click();
  await expect(page.getByRole('heading', { name: '撞資料夾' })).toBeVisible();

  await page.getByLabel('選 session').selectOption({ label: 'Migrate data' });
  await page.getByRole('button', { name: '加入團隊' }).click();
  await expect(page.getByTestId('member-s-etl')).toBeVisible();

  // 另一台機器、同路徑：可以
  await page.getByLabel('選 session').selectOption({ label: 'Tidy docs' });
  await page.getByRole('button', { name: '加入團隊' }).click();
  await expect(page.getByTestId('member-s-docs')).toBeVisible();

  // 同一台機器、同資料夾：擋下
  await page.getByLabel('選 session').selectOption({ label: 'Train model' });
  await page.getByRole('button', { name: '加入團隊' }).click();
  const alert = page.getByTestId('worktree-conflict');
  await expect(alert).toContainText('Train model');
  await expect(alert).toContainText('Migrate data');
  await expect(alert).toContainText('worktree');
  await expect(page.getByTestId('member-s-ml')).toHaveCount(0);
  await shot(page, 'team-worktree-conflict');

  await alert.getByRole('button', { name: '新增 session' }).click();
  await expect(page).toHaveURL(/#\/new/);
});

test('hub 回 409 worktree_required 時顯示原因和下一步，不當成一般錯誤', async ({ page }) => {
  await openWorkbench(page);
  await fake(
    page,
    `backend.putTeamMember = async () => {
       throw Object.assign(new Error('Same folder as Write tests.'), { code: 'worktree_required' });
     }`,
  );
  await page.getByLabel('選 session').selectOption({ label: 'Tidy docs' });
  await page.getByRole('button', { name: '加入團隊' }).click();
  const alert = page.getByTestId('worktree-conflict');
  await expect(alert).toContainText('hub 拒絕加入');
  await expect(alert).toContainText('Same folder as Write tests.');
  await expect(alert.getByRole('button', { name: '新增 session' })).toBeVisible();
  await expect(page.getByTestId('member-s-docs')).toHaveCount(0);
});

test('任務板：未指派不可推進，指派後走完四欄', async ({ page }) => {
  await openWorkbench(page);
  await page.getByLabel('新任務').fill('補文件');
  await page.getByRole('button', { name: '新增', exact: true }).click();
  const card = task(page, '補文件');
  await expect(card).toHaveAttribute('data-column', 'todo');
  await expect(card.getByTestId('task-unassigned')).toBeVisible();
  await expect(card.getByRole('button', { name: '移到「進行中」' })).toBeDisabled();

  await card.getByLabel('「補文件」的負責人').selectOption({ label: 'Write tests' });
  await expect(card.getByTestId('task-unassigned')).toHaveCount(0);
  for (const [button, column] of [
    ['移到「進行中」', 'doing'],
    ['移到「待審查」', 'review'],
    ['移到「完成」', 'done'],
  ] as const) {
    await card.getByRole('button', { name: button }).click();
    await expect(card).toHaveAttribute('data-column', column);
  }
  await expect(card.getByRole('button', { name: /移到/ })).toHaveCount(1);
  // 已推進的任務不能變回未指派
  await expect(card.getByRole('option', { name: '未指派' })).toBeDisabled();

  await card.getByRole('button', { name: '移到「待審查」' }).click();
  await expect(card).toHaveAttribute('data-column', 'review');
  await card.getByRole('button', { name: '刪除' }).click();
  await expect(card).toHaveCount(0);
});

test('請隊長拆解：要有 ◈ 耗額度；隊長忙時不能按；回覆解析後放入待分配', async ({ page }) => {
  await openWorkbench(page);
  const action = page.getByRole('button', { name: '請隊長拆解' });
  const box = page.locator('.decompose');
  await expect(box.locator('.chip.cost')).toHaveText('◈ 耗額度');
  await expect(action).toBeDisabled();
  await expect(page.getByTestId('decompose-blocker')).toContainText('Write tests');
  await expect(page.getByTestId('decompose-blocker')).toContainText('工作中');

  await setStatus(page, 's-tests', 'waiting_input');
  await expect(action).toBeEnabled();
  await shot(page, 'team-workbench');
  await action.click();
  await expect(page.getByTestId('decompose-waiting')).toBeVisible();
  await expect(page.getByTestId('decompose-msg')).toHaveText(
    '放入待分配 3 項（已有的略過 0 項）。',
    { timeout: 8000 },
  );
  const todo = page.getByTestId('column-todo');
  await expect(todo.locator('.task', { hasText: 'Map the login redirect paths' })).toBeVisible();
  await expect(todo.locator('.task', { hasText: 'Fix the redirect' })).toBeVisible();
  await expect(todo.getByTestId('task-unassigned')).toHaveCount(4);

  // 重新讀取不花額度，也不會重複加
  await page.getByRole('button', { name: '重新讀取回覆' }).click();
  await expect(page.getByTestId('decompose-msg')).toHaveText(
    '放入待分配 0 項（已有的略過 3 項）。',
  );
  await expect(todo.locator('.task')).toHaveCount(4);
});

test('等隊長回覆時可以不等；晚到的回覆按重新讀取放進來，不再送提示', async ({ page }) => {
  await openWorkbench(page);
  await setStatus(page, 's-tests', 'waiting_input');
  await page.getByRole('button', { name: '請隊長拆解' }).click();
  await expect(page.getByTestId('decompose-waiting')).toBeVisible();
  await page.getByRole('button', { name: '不等了' }).click();
  await expect(page.getByTestId('decompose-msg')).toContainText('不等了');
  await expect(page.getByTestId('column-todo').locator('.task')).toHaveCount(1);
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).toContainText('等你回覆');
  await page.getByRole('button', { name: '重新讀取回覆' }).click();
  await expect(page.getByTestId('decompose-msg')).toContainText('放入待分配 3 項');
});

test('送進隊長的提示是一行且包含目標，不在畫面上花到別的 session', async ({ page }) => {
  await openWorkbench(page);
  await setStatus(page, 's-tests', 'waiting_input');
  await page.evaluate(async (url) => {
    const { useBoard } = (await import(url)) as {
      useBoard: {
        getState(): {
          backend: { sendPrompt(id: string, text: string): void };
        };
      };
    };
    const backend = useBoard.getState().backend;
    const original = backend.sendPrompt.bind(backend);
    (window as never as { __sent: unknown[] }).__sent = [];
    backend.sendPrompt = (id, text) => {
      (window as never as { __sent: unknown[] }).__sent.push([id, text]);
      original(id, text);
    };
  }, STORE);
  await page.getByRole('button', { name: '請隊長拆解' }).click();
  await expect(page.getByTestId('decompose-msg')).toContainText('放入待分配', { timeout: 8000 });
  const sent = await page.evaluate(() => (window as never as { __sent: string[][] }).__sent);
  expect(sent).toHaveLength(1);
  expect(sent[0]![0]).toBe('s-tests');
  expect(sent[0]![1]).toContain('Goal: Fix the login redirect loop');
  expect(sent[0]![1]).toContain('JSON array');
  expect(sent[0]![1]).not.toMatch(/[\r\n]/);
});

test('解析不到要說明原因，頁面不當機，之後可以重讀', async ({ page }) => {
  await openWorkbench(page);
  await setStatus(page, 's-tests', 'waiting_input');
  await fake(page, `backend.demoReply = 'Sorry, I need more information first.'`);
  await page.getByRole('button', { name: '請隊長拆解' }).click();
  const msg = page.getByTestId('decompose-msg');
  await expect(msg).toContainText('找不到任務清單', { timeout: 8000 });
  await expect(msg).toContainText('Sorry, I need more information');
  await expect(msg).toHaveAttribute('role', 'alert');
  await shot(page, 'team-parse-failed');
  await expect(page.getByTestId('column-todo').locator('.task')).toHaveCount(1);

  await setStatus(page, 's-tests', 'waiting_input');
  await fake(page, `backend.demoReply = '[{"title":"cut off'`);
  await page.getByRole('button', { name: '請隊長拆解' }).click();
  await expect(msg).toContainText('不是完整的 JSON', { timeout: 8000 });

  await fake(
    page,
    `backend.addSessionEvent('s-tests', 'hook', { event: 'Stop', last_assistant_message: '["Retry worked"]' })`,
  );
  await page.getByRole('button', { name: '重新讀取回覆' }).click();
  await expect(msg).toContainText('放入待分配 1 項');
  await expect(task(page, 'Retry worked')).toBeVisible();
  await expect(page.getByRole('button', { name: '請隊長拆解' })).toBeEnabled();
});

test('隊長失敗、沒有隊長、沒有目標，都講得出下一步', async ({ page }) => {
  await openWorkbench(page);
  await setStatus(page, 's-tests', 'waiting_input');
  await page.getByLabel('Write tests 的角色').selectOption('worker');
  await expect(page.getByTestId('decompose-blocker')).toContainText('要先指定一位隊長');
  await page.getByLabel('Write tests 的角色').selectOption('lead');
  await expect(page.getByTestId('decompose-blocker')).toHaveCount(0);

  await page.getByLabel('目標', { exact: true }).fill('');
  await page
    .locator('section', { hasText: '目標與完成條件' })
    .getByRole('button', { name: '儲存' })
    .click();
  await expect(page.getByTestId('decompose-blocker')).toContainText('要先寫好目標');

  await page.getByLabel('目標', { exact: true }).fill('再試一次');
  await page
    .locator('section', { hasText: '目標與完成條件' })
    .getByRole('button', { name: '儲存' })
    .click();
  await fake(page, 'backend.demoReply = null');
  await page.getByRole('button', { name: '請隊長拆解' }).click();
  await expect(page.getByTestId('decompose-msg')).toContainText('這次沒有回完（server_error）', {
    timeout: 8000,
  });
});

test('TEAM.md 可編輯，超過 1 頁提醒精簡', async ({ page }) => {
  await openWorkbench(page);
  const editor = page.getByRole('textbox', { name: 'TEAM.md' });
  await expect(editor).toHaveValue(/Team notes/);
  await expect(page.getByTestId('team-md-long')).toHaveCount(0);
  await editor.fill('字'.repeat(3000));
  await expect(page.getByTestId('team-md-count')).toHaveText('3000／3000 字');
  await expect(page.getByTestId('team-md-long')).toHaveCount(0);
  await editor.fill('字'.repeat(3001));
  await expect(page.getByTestId('team-md-long')).toContainText('超過 1 頁');
  await shot(page, 'team-md-long');
  await page
    .locator('section', { hasText: 'TEAM.md' })
    .getByRole('button', { name: '儲存' })
    .click();
  await expect(
    page.locator('section', { hasText: 'TEAM.md' }).getByRole('status').first(),
  ).toHaveText('已儲存');
  await page.goto('/#/canvas');
  await page.goto('/#/team/team-demo-auth');
  await expect(page.getByRole('textbox', { name: 'TEAM.md' })).toHaveValue('字'.repeat(3001));
});

test('自動交接規則：開關、觸發條件、耗額度晶片；新規則預設關閉', async ({ page }) => {
  await openWorkbench(page);
  const rule = page.getByTestId('rule-rule-1');
  await expect(rule.locator('.chip.cost')).toHaveText('◈ 耗額度');
  const toggle = rule.getByRole('button', { name: /自動交接/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('自動交接：關');

  await rule.getByLabel('觸發條件').selectOption('on_file');
  await expect(rule).toContainText('只偵測 Write、Edit、MultiEdit、NotebookEdit');
  const pattern = rule.getByLabel('檔案樣式');
  await pattern.fill('*.sql');
  await pattern.blur();

  await expect(page.locator('section', { hasText: '自動交接規則' }).first()).toContainText(
    '透過 Bash 改的檔案偵測不到',
  );
  await page.locator('.new-rule').getByLabel('觸發條件').selectOption('on_file');
  await expect(page.locator('.new-rule')).toContainText('透過 Bash 改的');
  await page.locator('.new-rule').getByLabel('觸發條件').selectOption('on_done');
  await page.getByLabel('從', { exact: true }).selectOption({ label: 'Write tests' });
  await page.getByLabel('交給', { exact: true }).selectOption({ label: 'Write tests' });
  await expect(page.getByRole('button', { name: '新增規則' })).toBeDisabled(); // 不能交接給自己
  await page.getByLabel('交給', { exact: true }).selectOption({ label: 'Fix login' });
  await page.getByRole('button', { name: '新增規則' }).click();
  const added = page.locator('.rule', { hasText: 'Write tests → Fix login' });
  await expect(added.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await added.getByRole('button', { name: '刪除' }).click();
  await expect(added).toHaveCount(0);

  await page.goto('/#/canvas');
  await page.goto('/#/team/team-demo-auth');
  await expect(page.getByTestId('rule-rule-1').getByLabel('檔案樣式')).toHaveValue('*.sql');
});

test('被防迴圈擋下的交接要看得到', async ({ page }) => {
  await openWorkbench(page);
  await fake(
    page,
    `backend.addSessionEvent('s-tests', 'handoff.blocked', { fromSessionId: 's-tests', toSessionId: 's-auth', reason: 'loop' });
     backend.addSessionEvent('s-auth', 'handoff.fired', { fromSessionId: 's-auth', toSessionId: 's-tests' });`,
  );
  await page.goto('/#/canvas');
  await page.goto('/#/team/team-demo-auth');
  // 假後端在 reload 前都還在（hash 導覽不重新載入）
  const log = page.getByTestId('handoff-activity');
  await expect(log).toContainText('Write tests → Fix login');
  await expect(log).toContainText('會形成迴圈');
  await expect(log).toContainText('Fix login → Write tests：已交接');
});

test('全隊暫停送 Esc 給工作中的、關規則；全隊停止要按兩次', async ({ page }) => {
  await openWorkbench(page);
  await page.evaluate(async (url) => {
    const { useBoard } = (await import(url)) as {
      useBoard: {
        getState(): {
          backend: { terminal: { send(m: unknown): void } };
        };
      };
    };
    const { terminal } = useBoard.getState().backend;
    const original = terminal.send.bind(terminal);
    (window as never as { __signals: unknown[] }).__signals = [];
    terminal.send = (m) => {
      (window as never as { __signals: unknown[] }).__signals.push(m);
      original(m);
    };
  }, STORE);

  await page.getByRole('button', { name: '全隊暫停' }).click();
  const msg = page.getByTestId('team-controls-msg');
  await expect(msg).toContainText('已送 Esc 給 1 個工作中的 session，關閉 1 條交接規則');
  // 等你允許的 s-auth 不能收到 Esc：那等於拒絕
  expect(
    await page.evaluate(() => (window as never as { __signals: unknown[] }).__signals),
  ).toEqual([{ type: 'terminal.signal', sessionId: 's-tests', signal: 'escape' }]);
  await expect(
    page.getByTestId('rule-rule-1').getByRole('button', { name: /自動交接/ }),
  ).toHaveAttribute('aria-pressed', 'false');

  const stop = page.getByRole('button', { name: '全隊停止' });
  await stop.click();
  const armed = page.getByRole('button', { name: '再按一次，停止 2 個 session' });
  await expect(armed).toBeVisible();
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).not.toContainText('完成');
  await shot(page, 'team-stop-armed');
  await armed.click();
  await expect(msg).toContainText('已要求停止 2 個 session');
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).toContainText('完成');
  await expect(page.getByTestId('member-s-auth').locator('.lamp')).toContainText('完成');
});

test('全隊停止第一次按完離開就解除，不會誤觸', async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole('button', { name: '全隊停止' }).click();
  await page.getByLabel('新任務').click();
  await expect(page.getByRole('button', { name: '全隊停止' })).toBeVisible();
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).toContainText('工作中');
});

test('沒有綠色，英文版面不撐爆', async ({ page }) => {
  await openWorkbench(page);
  const greens = await page.evaluate(() => {
    const isGreen = (value: string) => {
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(value);
      return m ? Number(m[2]) > Number(m[1]) + 40 && Number(m[2]) > Number(m[3]) + 40 : false;
    };
    return [...document.querySelectorAll('.team-page *')]
      .filter((el) => {
        const style = getComputedStyle(el);
        return isGreen(style.color) || isGreen(style.backgroundColor);
      })
      .map((el) => el.className);
  });
  expect(greens).toEqual([]);

  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task board' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask lead to break down' })).toBeVisible();
  await expect(page.locator('.decompose .chip.cost')).toHaveText('◈ Uses quota');
  for (const width of [1440, 1024, 640]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.team-page')!;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow, `寬度 ${width} 不能水平捲動`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1440, height: 1700 });
  await shot(page, 'team-workbench-en');
});

test.describe('畫布接真資料', () => {
  const card = (page: Page, id: string) => page.getByTestId(`card-${id}`);

  async function openCanvas(page: Page) {
    await page.goto('/#/canvas');
    await expect(card(page, 's-auth')).toBeVisible();
    await expect(page.getByTestId('zoom-level')).not.toHaveText('100%');
  }

  async function drag(page: Page, from: string, to: string) {
    const a = (await card(page, from).locator('.source').boundingBox())!;
    const b = (await card(page, to).locator('.target').boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x - 20, b.y, { steps: 6 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
    await page.mouse.up();
  }

  test('團隊框跟著工作台的成員與名稱', async ({ page }) => {
    await openCanvas(page);
    await expect(page.locator('.team')).toContainText('團隊・登入重構');
    await page.goto('/#/team/team-demo-auth');
    await page.getByTestId('member-s-auth').getByRole('button', { name: '移出團隊' }).click();
    await expect(page.getByTestId('member-s-auth')).toHaveCount(0);
    await page.goto('/#/canvas');
    await expect(card(page, 's-auth')).toBeVisible();
    // 剩一位成員不畫框
    await expect(page.locator('.team')).toHaveCount(0);
  });

  test('拖線存到後端，預設關閉；開啟時標 ◈ 耗額度；刪除也存', async ({ page }) => {
    await openCanvas(page);
    await drag(page, 's-tests', 's-etl');
    await expect(page.getByTestId('handoff-s-tests-s-etl')).toHaveText('完成時交接');
    await expect(
      page.locator('.edge-label', { hasText: '完成時交接' }).filter({ hasText: '未開啟' }),
    ).toHaveCount(1);

    // 離開再回來（hash 導覽，資料從後端重讀）
    await page.goto('/#/team/team-demo-auth');
    const rule = page.locator('.rule', { hasText: 'Write tests →' });
    await expect(rule).toContainText('Migrate data');
    await expect(rule.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await page.goto('/#/canvas');
    await expect(page.getByTestId('handoff-s-tests-s-etl')).toBeVisible();
    await page.locator('.react-flow__edge[data-id="s-tests->s-etl"]').click({ force: true });
    const panel = page.getByTestId('handoff-panel');
    await expect(panel.locator('.chip.cost')).toHaveText('◈ 耗額度');
    await panel.getByRole('button', { name: '開啟自動交接' }).click();
    await expect(panel.getByRole('button', { name: '關閉自動交接' })).toBeVisible();
    await shot(page, 'canvas-handoff-panel');
    await expect(
      page.locator('.edge-label', { hasText: '完成時交接' }).filter({ hasText: '未開啟' }),
    ).toHaveCount(0);

    await page.locator('.react-flow__edge[data-id="s-tests->s-etl"]').click({ force: true });
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('handoff-s-tests-s-etl')).toHaveCount(0);
    await page.goto('/#/team/team-demo-auth');
    await expect(page.locator('.rule', { hasText: 'Write tests →' })).toHaveCount(0);
  });

  test('兩張卡都不在團隊裡，拖線要說明', async ({ page }) => {
    await openCanvas(page);
    await drag(page, 's-etl', 's-docs');
    await expect(page.getByRole('alert')).toContainText('先在「團隊」把其中一張卡加入團隊');
    await expect(page.getByTestId('handoff-s-etl-s-docs')).toHaveCount(0);
  });

  test('同一對 session 的多條規則畫成一條線', async ({ page }) => {
    await page.goto('/#/team/team-demo-auth');
    await page.getByLabel('從', { exact: true }).selectOption({ label: 'Fix login' });
    await page.getByLabel('交給', { exact: true }).selectOption({ label: 'Write tests' });
    await page.locator('.new-rule').getByLabel('觸發條件').selectOption('on_fail');
    await page.getByRole('button', { name: '新增規則' }).click();
    await expect(page.locator('.rule')).toHaveCount(2);
    await page.goto('/#/canvas');
    await expect(page.getByTestId('handoff-s-auth-s-tests')).toHaveText('完成時交接、失敗時交接');
  });
});
