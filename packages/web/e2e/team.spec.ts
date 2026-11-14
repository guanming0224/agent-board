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
  // P2 §2.3：工作台原本的區塊在團隊面板裡預設收合。這個檔案測的是那些區塊本身，先記成全部打開
  // （收合本身在 workspaces.spec.ts 測）。
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        'agent-board.team.folds',
        JSON.stringify(['members', 'add', 'phase', 'tasks', 'handoff', 'goal']),
      );
    } catch {
      // 沒有 localStorage 就照預設（收合）。
    }
  });
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

/** 手機上區塊收合（任務板不顯示），只等工作台出來。 */
async function openWorkbenchPhone(page: Page) {
  await page.goto('/#/team/team-demo-auth');
  await expect(page.getByTestId('team-workbench')).toBeVisible();
}

const task = (page: Page, title: string) => page.locator('.task', { hasText: title });

test('畫布上的團隊標籤打開右側團隊面板；#/team 是清單，新建後進工作台', async ({ page }) => {
  await page.goto('/#/canvas');
  // 分頁列拿掉了（P2 §1）：點畫布上的團隊框標籤打開那個團隊
  await page.getByTestId('team-open-team-demo-auth').click();
  await expect(page).toHaveURL(/#\/team\/team-demo-auth$/);
  await expect(page.getByTestId('team-panel').getByTestId('team-workbench')).toBeVisible();
  await page.getByRole('link', { name: /回團隊清單/ }).click();
  await expect(page).toHaveURL(/#\/team$/);
  await expect(page.getByTestId('team-panel')).toBeVisible();
  await expect(page.locator('.team-row')).toContainText('登入重構');
  await expect(page.locator('.team-row')).toContainText('2 位成員');
  await shot(page, 'team-list');

  await expect(page.getByRole('button', { name: '建立團隊' })).toBeDisabled();
  await page.getByLabel('團隊名稱').fill('資料搬遷');
  await page.getByRole('button', { name: '靛' }).click();
  await page.getByRole('button', { name: '建立團隊' }).click();
  await expect(page.getByRole('heading', { name: '資料搬遷' })).toBeVisible();
  await expect(page).toHaveURL(/#\/team\/.+/);
  // 工作台的色塊收在「團隊顏色」按鈕裡。
  await page.getByTestId('team-color-toggle').click();
  await expect(
    page.getByRole('group', { name: '團隊顏色' }).getByRole('button', { name: '靛' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('找不到的團隊不會當機：開清單並寫一行「找不到這個團隊」', async ({ page }) => {
  await page.goto('/#/team/nope');
  await expect(page.getByTestId('team-not-found')).toContainText('找不到這個團隊');
  await expect(page.getByTestId('team-list')).toBeVisible();
  await expect(page.locator('.team-row')).toContainText('登入重構');
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

/** 從畫面用的 store 讀 session（名稱 → 資料），確認真的照設定建出來。 */
async function sessionsNamed(page: Page, prefix: string) {
  return page.evaluate(
    async ({ url, prefix }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: {
          getState(): {
            sessions: {
              id: string;
              name: string;
              cwd: string;
              worktreePath: string | null;
              permissionMode: string;
              readOnly: boolean;
            }[];
          };
        };
      };
      return useBoard.getState().sessions.filter((s) => s.name.startsWith(prefix));
    },
    { url: STORE, prefix },
  );
}

async function startTeam(page: Page, name: string, preset: string) {
  await page.goto('/#/team');
  await page.getByLabel('團隊名稱').fill(name);
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: preset }).click();
}

test('建立團隊時一起開各角色的 session：標準組合 LD + 2 BD + RV', async ({ page }) => {
  await startTeam(page, 'Migrate', '標準');
  await page.getByLabel('目標（可不填）').fill('搬到新資料庫');
  const rows = page.locator('.plan-row');
  await expect(rows).toHaveCount(4);
  await expect(page.getByLabel('第 1 位的 session 名稱')).toHaveValue('Migrate-LD');
  await expect(page.getByLabel('第 3 位的 session 名稱')).toHaveValue('Migrate-BD2');
  await expect(page.getByLabel('第 4 位的 session 名稱')).toHaveValue('Migrate-RV');
  await expect(page.getByLabel('第 1 位的權限模式')).toHaveValue('default');
  await expect(page.getByLabel('第 2 位的權限模式')).toHaveValue('acceptEdits');
  await expect(page.getByLabel('第 4 位的權限模式')).toHaveValue('plan');
  await expect(rows.nth(1)).toContainText('自己的 worktree');
  await expect(rows.nth(3)).toContainText('共用主資料夾（唯讀）');
  await expect(page.getByTestId('read-only-hint')).toContainText('Bash 仍然寫得了檔案');

  // 改團隊名稱：沒改過的名稱跟著換，自己改過的不動。
  await page.getByLabel('第 2 位的 session 名稱').fill('builder-a');
  await page.getByLabel('團隊名稱').fill('Move');
  await expect(page.getByLabel('第 1 位的 session 名稱')).toHaveValue('Move-LD');
  await expect(page.getByLabel('第 2 位的 session 名稱')).toHaveValue('builder-a');

  // 團隊面板在桌面固定 420px 寬；≤ 640px 是手機全螢幕頁（另一個畫面，切過去表單會重來），這裡量桌面最窄的 641px。
  for (const width of [1024, 641]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('.team-page')!;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow, `寬度 ${width} 不能水平捲動`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 沒選資料夾不能建
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();
  await expect(page.getByTestId('new-team-error')).toContainText('工作目錄');
  await page.getByLabel('工作目錄').fill('/home/demo/project');
  await shot(page, 'team-new-with-sessions');
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();

  await expect(page.getByRole('heading', { name: 'Move' })).toBeVisible();
  await expect(page.getByLabel('目標', { exact: true })).toHaveValue('搬到新資料庫');
  await expect(page.getByLabel('Move-LD 的角色')).toHaveValue('lead');
  await expect(page.getByLabel('builder-a 的角色')).toHaveValue('worker');
  await expect(page.getByLabel('Move-BD2 的角色')).toHaveValue('worker');
  await expect(page.getByLabel('Move-RV 的角色')).toHaveValue('reviewer');

  const created = [
    ...(await sessionsNamed(page, 'Move-')),
    ...(await sessionsNamed(page, 'builder-a')),
  ];
  const by = (n: string) => created.find((s) => s.name === n)!;
  expect(created).toHaveLength(4);
  expect(by('Move-LD')).toMatchObject({ cwd: '/home/demo/project', worktreePath: null });
  expect(by('Move-LD').permissionMode).toBe('default');
  expect(by('builder-a').worktreePath).toContain('.agent-board-wt/builder-a');
  expect(by('builder-a').permissionMode).toBe('acceptEdits');
  expect(by('Move-BD2').worktreePath).toContain('.agent-board-wt/Move-BD2');
  expect(by('Move-RV')).toMatchObject({
    worktreePath: null,
    permissionMode: 'plan',
    readOnly: true,
  });
  expect(created.filter((s) => s.readOnly).map((s) => s.name)).toEqual(['Move-RV']);

  // 唯讀晶片：工作台成員列與畫布卡片
  await expect(
    page.getByTestId(`member-${by('Move-RV').id}`).locator('.chip.read-only'),
  ).toHaveText('唯讀');
  await expect(
    page.getByTestId(`member-${by('Move-LD').id}`).locator('.chip.read-only'),
  ).toHaveCount(0);
  await page.goto('/#/canvas');
  await expect(page.getByTestId(`card-${by('Move-RV').id}`).locator('.chip.read-only')).toHaveText(
    '唯讀',
  );
  await expect(page.getByTestId(`card-${by('Move-LD').id}`).locator('.chip.read-only')).toHaveCount(
    0,
  );
});

test('只建團隊不用選資料夾；組合要剛好一位隊長、名稱不重複、主資料夾只能一位會改檔案', async ({
  page,
}) => {
  await startTeam(page, 'Check', '小隊');
  await page.getByLabel('工作目錄').fill('/home/demo/project');
  const create = page.getByRole('button', { name: '建立團隊和 2 個 session' });

  await page.getByLabel('第 1 位的角色').selectOption('worker');
  await create.click();
  await expect(page.getByTestId('new-team-error')).toHaveText('要剛好一位隊長（LD）。');
  await page.getByLabel('第 1 位的角色').selectOption('lead');

  await page.getByLabel('第 2 位的 session 名稱').fill('Check-LD');
  await create.click();
  await expect(page.getByTestId('new-team-error')).toHaveText('session 名稱不能重複。');
  await page.getByLabel('第 2 位的 session 名稱').fill('Check-x');

  // 加一位審查：預設 plan；改成 default 仍是唯讀 session（唯讀靠拿掉改檔工具，不靠 plan）。
  await page.getByRole('button', { name: '＋ 加一位' }).click();
  await page.getByLabel('第 3 位的角色').selectOption('reviewer');
  await expect(page.getByLabel('第 3 位的權限模式')).toHaveValue('plan');
  await page.getByLabel('第 3 位的權限模式').selectOption('default');
  await expect(page.locator('.plan-row').nth(2)).toContainText('共用主資料夾（唯讀）');
  // dontAsk、bypassPermissions 都要提醒。
  await page.getByLabel('第 3 位的權限模式').selectOption('dontAsk');
  await expect(page.getByTestId('dontask-alert')).toContainText('自動拒絕');
  // 唯讀的審查不給 bypassPermissions；改成 BD 才有，選了要警告。
  await expect(
    page.getByLabel('第 3 位的權限模式').locator('option[value="bypassPermissions"]'),
  ).toHaveCount(0);
  await page.getByLabel('第 3 位的角色').selectOption('worker');
  await page.getByLabel('第 3 位的權限模式').selectOption('bypassPermissions');
  await expect(page.getByTestId('bypass-alert')).toBeVisible();
  await expect(page.getByTestId('dontask-alert')).toHaveCount(0);
  await page.getByRole('button', { name: '移除第 3 位' }).click();
  await expect(page.getByTestId('bypass-alert')).toHaveCount(0);

  // 沒有建出任何東西
  await expect(page.locator('.team-row')).toHaveCount(1);
  expect(await sessionsNamed(page, 'Check')).toEqual([]);

  // 改回只建團隊：不用資料夾，照原本的流程
  await page.getByRole('button', { name: '只建團隊' }).click();
  await expect(page.locator('.plan-row')).toHaveCount(0);
  await page.getByRole('button', { name: '建立團隊', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check' })).toBeVisible();
  await expect(page.getByText('還沒有成員')).toBeVisible();
});

test('資料夾不是 git：提醒 BD 會共用資料夾，探索組合拿掉 BD 才能建', async ({ page }) => {
  await page.goto('/#/team');
  await fake(
    page,
    `const browse = backend.browseDirectory;
     backend.browseDirectory = async (m, p) => ({ ...(await browse(m, p)), repo: null });`,
  );
  await page.getByLabel('團隊名稱').fill('Notes');
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: '探索' }).click();
  await page.getByLabel('工作目錄').fill('/home/demo/notes');
  await expect(page.getByTestId('team-not-git')).toContainText('不是 git');
  await expect(page.locator('.plan-row').nth(2)).toContainText('主資料夾');
  await page.getByRole('button', { name: '建立團隊和 3 個 session' }).click();
  await expect(page.getByTestId('new-team-error')).toContainText('只能有一位會改檔案');

  await page.getByRole('button', { name: '移除第 3 位' }).click();
  await page.getByRole('button', { name: '建立團隊和 2 個 session' }).click();
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  const made = await sessionsNamed(page, 'Notes-');
  expect(made.map((s) => [s.name, s.worktreePath, s.permissionMode]).sort()).toEqual([
    ['Notes-LD', null, 'default'],
    ['Notes-RS', null, 'plan'],
  ]);
});

// ── 不是 git 的資料夾：一鍵 git init 與共用資料夾（CONTRACTS §24） ──────────

/** daemon 確認不是 git（repo null）；假後端 git init 過的資料夾照常回報 repo。 */
const NOT_GIT = `const browse = backend.browseDirectory;
  backend.browseDirectory = async (m, p) => {
    const r = await browse(m, p);
    return { ...r, repo: r.repo ?? null };
  };`;

async function teamsNamed(page: Page, name: string) {
  return page.evaluate(
    async ({ url, name }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: {
          getState(): {
            backend: { listTeams(): Promise<{ name: string; sharedWriters?: boolean }[]> };
          };
        };
      };
      return (await useBoard.getState().backend.listTeams()).filter((t) => t.name === name);
    },
    { url: STORE, name },
  );
}

test('新增團隊、資料夾不是 git：按「在這裡 git init」確認後重新偵測，BD 改開 worktree', async ({
  page,
}) => {
  await page.goto('/#/team');
  await fake(page, NOT_GIT);
  await page.getByLabel('團隊名稱').fill('Init');
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: '標準' }).click();
  // 太大的位置：daemon 拒絕，寫出原因，什麼都沒改。
  await page.getByLabel('工作目錄').fill('/home/demo');
  await expect(page.getByTestId('team-not-git')).toContainText('建議在這裡 git init');
  await page.getByTestId('git-init-open').click();
  await page.getByTestId('git-init-confirm').click();
  await expect(page.getByTestId('git-init-error')).toContainText('這個位置太大');
  await expect(page.getByTestId('team-not-git')).toBeVisible();

  await page.getByLabel('工作目錄').fill('/home/demo/big-notes');
  await expect(page.locator('.plan-row').nth(1)).toContainText('主資料夾');
  await page.getByTestId('git-init-open').click();
  // 確認步驟先說清楚會做什麼。
  const confirm = page.locator('.git-init-confirm');
  await expect(confirm).toContainText('/home/demo/big-notes');
  await expect(confirm).toContainText('不設 remote、不 push');
  await expect(confirm).toContainText('不改你的 git 設定');
  await expect(confirm).toContainText('50 MB');
  const box = await page.getByTestId('git-init-confirm').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(36);
  await shot(page, 'team-git-init-confirm');
  await page.getByTestId('git-init-confirm').click();
  await expect(page.getByTestId('git-init-done')).toContainText('已 git init');
  await expect(page.getByTestId('git-init-skipped')).toContainText('data/video.mp4');
  // 重新偵測：不再是「不是 git」，BD 開自己的 worktree，共用勾選不見。
  await expect(page.getByTestId('team-not-git')).toHaveCount(0);
  await expect(page.getByTestId('team-shared-check')).toHaveCount(0);
  await expect(page.locator('.plan-row').nth(1)).toContainText('自己的 worktree');
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();
  await expect(page.getByRole('heading', { name: 'Init' })).toBeVisible();
  const made = await sessionsNamed(page, 'Init-BD');
  expect(made.map((s) => s.worktreePath !== null)).toEqual([true, true]);
  expect((await teamsNamed(page, 'Init'))[0]?.sharedWriters).toBeFalsy();
});

test('git init：daemon 太舊時說要先更新，不卡住', async ({ page }) => {
  await page.goto('/#/team');
  await fake(
    page,
    `${NOT_GIT}
     backend.gitInit = async () => {
       throw Object.assign(new Error('too old'), { code: 'daemon_too_old' });
     };`,
  );
  await page.getByLabel('團隊名稱').fill('Old');
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: '探索' }).click();
  await page.getByLabel('工作目錄').fill('/home/demo/old');
  await page.getByTestId('git-init-open').click();
  await page.getByTestId('git-init-confirm').click();
  await expect(page.getByTestId('git-init-error')).toContainText('daemon 太舊，請先更新');
  // 可以再按一次。
  await expect(page.getByTestId('git-init-open')).toBeEnabled();
});

test('新增團隊、資料夾不是 git：勾「共用資料夾」就能建，團隊面板看得到、owner 可以關掉', async ({
  page,
}) => {
  await page.goto('/#/team');
  await fake(page, NOT_GIT);
  await page.getByLabel('團隊名稱').fill('Shared');
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: '標準' }).click();
  await page.getByLabel('工作目錄').fill('/home/demo/shared');
  await expect(page.getByTestId('team-not-git')).toBeVisible();
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();
  await expect(page.getByTestId('new-team-error')).toContainText('只能有一位會改檔案');
  await page
    .getByTestId('team-shared-check')
    .getByLabel('我知道風險：讓 BD 和 LD 共用這個資料夾（可能互相覆蓋修改）')
    .check();
  await expect(page.locator('.plan-row').nth(1)).toContainText('主資料夾（共用）');
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();
  await expect(page.getByRole('heading', { name: 'Shared' })).toBeVisible();
  const made = await sessionsNamed(page, 'Shared-');
  expect(made.filter((s) => s.name.includes('-BD')).map((s) => s.worktreePath)).toEqual([
    null,
    null,
  ]);
  expect((await teamsNamed(page, 'Shared'))[0]?.sharedWriters).toBe(true);
  await expect(page.getByTestId('team-shared')).toContainText('共用資料夾');
  await shot(page, 'team-shared-folder');
  // 畫布上的團隊標籤也標出來。
  await page.goto('/#/canvas');
  await expect(page.locator('.team-shared')).toContainText('共用資料夾');
  await page.locator('.team-open', { hasText: 'Shared' }).click();
  const off = page.getByTestId('team-shared-off');
  await off.click();
  await expect(off).toContainText('已在跑的成員不受影響');
  await page.waitForTimeout(400); // 350ms 內的連點不算確認（同刪除團隊）
  await off.click();
  await expect(page.getByTestId('team-shared')).toHaveCount(0);
  expect((await teamsNamed(page, 'Shared'))[0]?.sharedWriters).toBeFalsy();
});

test('不是 owner：看不到 git init 按鈕與共用勾選，只有說明', async ({ page }) => {
  await page.goto('/#/team');
  await fake(
    page,
    `${NOT_GIT}
     const me = backend.currentUser;
     backend.currentUser = async () => ({ ...(await me()), role: 'member' });`,
  );
  await page.getByLabel('團隊名稱').fill('Member');
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: '標準' }).click();
  await page.getByLabel('工作目錄').fill('/home/demo/member');
  await expect(page.getByTestId('team-not-git')).toBeVisible();
  await expect(page.getByTestId('git-init-owner-only')).toBeVisible();
  await expect(page.getByTestId('team-shared-owner-only')).toBeVisible();
  await expect(page.getByTestId('git-init-open')).toHaveCount(0);
  await expect(page.getByTestId('team-shared-check')).toHaveCount(0);
});

test('補成員時才勾共用、結果一位都沒加進去：共用設定還原', async ({ page }) => {
  await page.goto('/#/team');
  await fake(
    page,
    `${NOT_GIT}
     backend.createSession = async () => {
       throw Object.assign(new Error('Machine demo-studio is offline'), { code: 'machine_offline' });
     };`,
  );
  await page.getByLabel('團隊名稱').fill('Revert');
  await page.getByRole('button', { name: '建立團隊', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Revert' })).toBeVisible();
  await page.getByTestId('add-members-toggle').click();
  const add = page.getByTestId('add-members');
  await add.getByLabel('工作目錄').fill('/home/demo/revert');
  await add.getByRole('button', { name: '標準' }).click();
  await expect(add.getByTestId('team-not-git')).toBeVisible();
  await add.getByTestId('team-shared-check').getByRole('checkbox').check();
  await add.getByRole('button', { name: '開 4 個 session 並加入' }).click();
  await expect(add.getByTestId('plan-step-4')).toContainText('session 沒建立');
  await expect.poll(async () => (await teamsNamed(page, 'Revert'))[0]?.sharedWriters).toBeFalsy();
  await expect(page.getByTestId('team-shared')).toHaveCount(0);
});

test('既有團隊補成員、資料夾不是 git：git init 或勾共用資料夾都能補 BD', async ({ page }) => {
  // git init 這條路。
  await page.goto('/#/team');
  await fake(page, NOT_GIT);
  await page.getByLabel('團隊名稱').fill('Later');
  await page.getByRole('button', { name: '建立團隊', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Later' })).toBeVisible();
  await page.getByTestId('add-members-toggle').click();
  let add = page.getByTestId('add-members');
  await add.getByLabel('工作目錄').fill('/home/demo/later');
  await add.getByRole('button', { name: '標準' }).click();
  await expect(add.getByTestId('team-not-git')).toBeVisible();
  await add.getByRole('button', { name: '開 4 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-error')).toContainText('只能有一位會改檔案');
  await add.getByTestId('git-init-open').click();
  await add.getByTestId('git-init-confirm').click();
  await expect(add.getByTestId('git-init-done')).toContainText('已 git init');
  await expect(add.locator('.plan-row').nth(1)).toContainText('自己的 worktree');
  await add.getByRole('button', { name: '開 4 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-msg')).toContainText('已加入 4 位');

  // 共用資料夾這條路：補成員時才勾，存到既有團隊上。
  await page.goto('/#/team');
  await page.getByLabel('團隊名稱').fill('Later2');
  await page.getByRole('button', { name: '建立團隊', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Later2' })).toBeVisible();
  await page.getByTestId('add-members-toggle').click();
  add = page.getByTestId('add-members');
  await add.getByLabel('工作目錄').fill('/home/demo/later2');
  await add.getByRole('button', { name: '標準' }).click();
  await expect(add.getByTestId('team-not-git')).toBeVisible();
  await add.getByTestId('team-shared-check').getByRole('checkbox').check();
  await add.getByRole('button', { name: '開 4 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-msg')).toContainText('已加入 4 位');
  expect((await teamsNamed(page, 'Later2'))[0]?.sharedWriters).toBe(true);
  await expect(page.getByTestId('team-shared')).toBeVisible();
  // 再補一批：沿用位置，團隊已是共用資料夾，不用再勾。
  await add.getByRole('button', { name: '再補一批' }).click();
  await add.getByRole('button', { name: '標準' }).click();
  await expect(add.getByTestId('team-shared-note')).toBeVisible();
  await expect(add.locator('.plan-row').first()).toContainText('主資料夾（共用）');
});

test('部分失敗：已建立的保留，列出哪一位在哪一步失敗與原因，可以打開團隊', async ({ page }) => {
  await page.goto('/#/team');
  await fake(
    page,
    `const create = backend.createSession;
     backend.createSession = async (input) => {
       if (input.name.endsWith('-BD1')) {
         throw Object.assign(new Error('Machine demo-studio is offline'), { code: 'machine_offline' });
       }
       return create(input);
     };
     const put = backend.putTeamMember;
     backend.putTeamMember = async (teamId, sessionId, role) => {
       if (role === 'reviewer') {
         throw Object.assign(new Error('Same folder as Part-LD.'), { code: 'worktree_required' });
       }
       return put(teamId, sessionId, role);
     };`,
  );
  await page.getByLabel('團隊名稱').fill('Part');
  await page.getByRole('group', { name: '成員' }).getByRole('button', { name: '標準' }).click();
  await page.getByLabel('工作目錄').fill('/home/demo/project');
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();

  await expect(page.getByTestId('new-team-partial')).toContainText('2 位沒完成');
  await expect(page.getByTestId('new-team-partial')).toContainText('沒有刪除任何東西');
  await expect(page.getByTestId('plan-step-1')).toHaveText('✓ 已加入');
  await expect(page.getByTestId('plan-step-2')).toContainText('session 沒建立');
  await expect(page.getByTestId('plan-step-2')).toContainText('Machine demo-studio is offline');
  await expect(page.getByTestId('plan-step-3')).toHaveText('✓ 已加入');
  await expect(page.getByTestId('plan-step-4')).toContainText('session 已建立，但沒加入團隊');
  await expect(page.getByTestId('plan-step-4')).toContainText('Same folder as Part-LD.');
  await expect(page).toHaveURL(/#\/team$/);
  await shot(page, 'team-new-partial');

  // RV 的 session 留著（沒刪），只是不在團隊裡。
  expect((await sessionsNamed(page, 'Part-')).map((s) => s.name).sort()).toEqual([
    'Part-BD2',
    'Part-LD',
    'Part-RV',
  ]);
  await page.getByRole('link', { name: '打開團隊' }).click();
  await expect(page.getByRole('heading', { name: 'Part' })).toBeVisible();
  await expect(page.getByLabel('Part-LD 的角色')).toHaveValue('lead');
  await expect(page.getByLabel('Part-BD2 的角色')).toHaveValue('worker');
  await expect(page.getByLabel('Part-RV 的角色')).toHaveCount(0);
});

test('唯讀成員改成會改檔案的角色被 hub 擋下：說明原因，角色不變', async ({ page }) => {
  await startTeam(page, 'Watch', '標準');
  await page.getByLabel('工作目錄').fill('/home/demo/project');
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();
  await expect(page.getByRole('heading', { name: 'Watch' })).toBeVisible();
  await fake(
    page,
    `const put = backend.putTeamMember;
     backend.putTeamMember = async (teamId, sessionId, role) => {
       if (role === 'worker') {
         throw Object.assign(new Error('Same folder as Watch-LD.'), { code: 'worktree_required' });
       }
       return put(teamId, sessionId, role);
     };`,
  );
  const role = page.getByLabel('Watch-RV 的角色');
  await role.selectOption('worker');
  const alert = page.getByTestId('worktree-conflict');
  await expect(alert).toContainText('Watch-RV');
  await expect(alert).toContainText('Same folder as Watch-LD.');
  await expect(alert).toContainText('角色維持不變');
  await expect(role).toHaveValue('reviewer');
  // 改成另一個唯讀角色照樣可以。
  await role.selectOption('researcher');
  await expect(alert).toHaveCount(0);
  await expect(role).toHaveValue('researcher');
});

test('建好後讀不到團隊清單：不跳轉、不能再建一次，給「打開團隊」連結', async ({ page }) => {
  await startTeam(page, 'Stale', '小隊');
  await page.getByLabel('工作目錄').fill('/home/demo/project');
  await fake(
    page,
    `const list = backend.listTeams;
     let fail = false;
     const create = backend.createTeam;
     backend.createTeam = async (input) => { const team = await create(input); fail = true; return team; };
     backend.listTeams = async () => {
       if (fail) { fail = false; throw new Error('hub went away'); }
       return list();
     };`,
  );
  await page.getByRole('button', { name: '建立團隊和 2 個 session' }).click();
  await expect(page.getByTestId('new-team-partial')).toContainText('重新讀取團隊清單失敗');
  await expect(page).toHaveURL(/#\/team$/);
  await expect(page.getByRole('button', { name: /建立團隊/ })).toHaveCount(0);
  await page.getByRole('link', { name: '打開團隊' }).click();
  await expect(page.getByRole('heading', { name: 'Stale' })).toBeVisible();
});

test('連按兩下建立只建一次', async ({ page }) => {
  await startTeam(page, 'Twice', '小隊');
  await page.getByLabel('工作目錄').fill('/home/demo/project');
  await page.getByRole('button', { name: '建立團隊和 2 個 session' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Twice' })).toBeVisible();
  await page.goto('/#/team');
  await expect(page.locator('.team-row', { hasText: 'Twice' })).toHaveCount(1);
  expect((await sessionsNamed(page, 'Twice-')).map((s) => s.name).sort()).toEqual([
    'Twice-BD1',
    'Twice-LD',
  ]);
});

test('團隊顏色有 8 種，每個色塊都有名稱；工作台可以換色', async ({ page }) => {
  await page.goto('/#/team');
  const picker = page.getByRole('group', { name: '團隊顏色' });
  const names = ['青', '萊姆', '靛', '杏', '冰', '沙', '梅', '堇'];
  await expect(picker.getByRole('button')).toHaveCount(names.length);
  for (const n of names) await expect(picker.getByRole('button', { name: n })).toBeVisible();
  await expect(picker.getByRole('button', { name: '青' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('團隊名稱').fill('Colors');
  await picker.getByRole('button', { name: '梅' }).click();
  await page.getByRole('button', { name: '建立團隊', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Colors' })).toBeVisible();
  const workbench = page.getByTestId('team-workbench');
  const resolved = () =>
    workbench.locator('h1 .swatch').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await resolved()).toBe('rgb(168, 87, 143)');
  // 工作台的色塊平常收起來（420px 面板放不下整排），按「團隊顏色」才展開，選完自己收起。
  await expect(page.getByRole('group', { name: '團隊顏色' })).toHaveCount(0);
  const toggle = page.getByTestId('team-color-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByRole('group', { name: '團隊顏色' }).getByRole('button', { name: '堇' }).click();
  await expect.poll(resolved).toBe('rgb(125, 95, 199)');
  await expect(page.getByRole('group', { name: '團隊顏色' })).toHaveCount(0);
});

test('刪除團隊收在「⋯」選單：按兩次（上膛實心紅），不和群發送出放在一起', async ({ page }) => {
  await openWorkbench(page);
  // 群發框旁邊不再有刪除鈕（報告 E5）。
  await expect(
    page.getByTestId('team-broadcast').getByRole('button', { name: /刪除/ }),
  ).toHaveCount(0);
  await page.getByTestId('team-more').click();
  const del = page.getByTestId('team-delete');
  await expect(del).toHaveText('刪除團隊');
  await expect(del).toHaveAttribute('role', 'menuitem');
  await del.click();
  await expect(del).toHaveText('再按一次刪除（session 不受影響）');
  await expect(del).toHaveAttribute('data-armed', 'true');
  await page.waitForTimeout(400); // 350ms 內的連點不算確認
  await del.click();
  await expect(page).toHaveURL(/#\/team$/);
  await expect(page.getByTestId('team-list')).toBeVisible();
  await expect(page.getByTestId('team-list')).not.toContainText('登入重構');
});

test('團隊、Memory 兩個右側面板的標題列同一個長相：h1 18px、寬版與 ✕ 都是 32、寬版有按下外觀', async ({
  page,
}) => {
  const check = async (panelId: string, wideId: string, closeId: string) => {
    const panel = page.getByTestId(panelId);
    const head = panel.locator('.panel-head').first();
    await expect(head).toBeVisible();
    // 面板滑入的動畫播完再量（量到一半位置會差幾 px；main 上就時好時壞）。
    await panel.evaluate((el) =>
      Promise.all(
        [el, ...el.querySelectorAll('*')]
          .flatMap((node) => node.getAnimations())
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished),
      ),
    );
    const h1 = head.locator('h1');
    expect(await h1.evaluate((el) => getComputedStyle(el).fontSize)).toBe('18px');
    const headBox = (await head.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    // 標題列貼齊面板左右（左內距 16）。
    expect(Math.round(headBox.x - panelBox.x)).toBeLessThanOrEqual(1);
    const h1Box = (await h1.boundingBox())!;
    expect(Math.round(h1Box.x - headBox.x)).toBe(16);
    const wide = panel.getByTestId(wideId);
    const close = panel.getByTestId(closeId);
    expect((await wide.boundingBox())!.height).toBe(32);
    expect((await close.boundingBox())!.height).toBe(32);
    expect(await close.textContent()).toBe('✕');
    const bg = () => wide.evaluate((el) => getComputedStyle(el).backgroundColor);
    const before = await bg();
    await wide.click();
    await expect(wide).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(bg).not.toBe(before);
    await expect
      .poll(() => wide.evaluate((el) => getComputedStyle(el).borderTopColor))
      .toBe('rgb(255, 255, 255)');
    await wide.click();
  };
  await page.goto('/#/team/team-demo-auth');
  await check('team-panel', 'team-wide', 'team-close');
  await page.goto('/#/memory');
  await check('memory-panel', 'memory-wide', 'memory-close');
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
    '放入待分配 3 項（已有的略過 0 項），依角色指派了 2 項。',
    { timeout: 8000 },
  );
  const todo = page.getByTestId('column-todo');
  await expect(todo.locator('.task', { hasText: 'Map the login redirect paths' })).toBeVisible();
  await expect(todo.locator('.task', { hasText: 'Fix the redirect' })).toBeVisible();
  // 依隊長標的 role 指派：BD → Fix login（worker）、LD → Write tests（隊長）；沒標的留給使用者。
  await expect(
    task(page, 'Map the login redirect paths').getByLabel(
      '「Map the login redirect paths」的負責人',
    ),
  ).toHaveValue('s-auth');
  await expect(
    task(page, 'Write regression tests').getByLabel('「Write regression tests」的負責人'),
  ).toHaveValue('s-tests');
  await expect(task(page, 'Fix the redirect').getByTestId('task-unassigned')).toBeVisible();
  await expect(todo.getByTestId('task-unassigned')).toHaveCount(2);
  // 卡片帶團隊內的短編號（demo 已有 #1、#2）。
  await expect(task(page, 'Fix the redirect').locator('.task-title')).toContainText('#5');

  // 重新讀取不花額度，也不會重複加
  await page.getByRole('button', { name: '重新讀取回覆' }).click();
  await expect(page.getByTestId('decompose-msg')).toHaveText(
    '放入待分配 0 項（已有的略過 3 項），依角色指派了 0 項。',
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
  // 只列團隊裡有的縮寫。
  expect(sent[0]![1]).toContain('"role":"BD"');
  expect(sent[0]![1]).toContain('one of: BD (builder), LD (lead).');
  expect(sent[0]![1]).not.toMatch(/[\r\n]/);
});

test('任務自動執行：開關預設關、標耗額度，卡片顯示做到哪；全隊暫停會關掉', async ({ page }) => {
  await openWorkbench(page);
  const toggle = page.getByTestId('task-auto-toggle');
  const box = page.getByTestId('task-auto');
  await expect(toggle).not.toBeChecked();
  await expect(box.locator('.chip.cost')).toHaveText('◈ 耗額度');
  await expect(box).toContainText('每一步都會花成員的額度');
  await toggle.check();
  await expect(page.getByTestId('task-auto-msg')).toContainText('已開啟');
  await expect(toggle).toBeChecked();

  // hub 送出後的狀態（假後端不送字，直接改任務模擬）：卡片寫出送給誰、退回幾次。
  await fake(
    page,
    `backend.patchTask('task-1', { rejectCount: 1, reviewerSessionId: 's-tests', auto: { state: 'sent', sessionId: 's-auth', at: new Date().toISOString() } })`,
  );
  // 任務板每 5 秒重新讀取。
  const card = task(page, 'Reproduce the redirect loop');
  await expect(card.getByTestId('task-auto-status')).toHaveText(
    '◇ 已送給 Fix login・等回覆・Write tests 退回 1/3',
    { timeout: 8000 },
  );
  await expect(card.locator('.task-title')).toContainText('#1');
  await shot(page, 'team-task-auto');

  // 到上限：顯示要你決定與原因。
  await fake(
    page,
    `backend.patchTask('task-1', { column: 'review', rejectCount: 3, needsUser: true, auto: { state: 'limit', sessionId: 's-tests', note: 'Still no mobile test.', at: new Date().toISOString() } })`,
  );
  await expect(card.getByTestId('task-auto-status')).toContainText(
    'Write tests 退回 3/3・等你決定',
    { timeout: 8000 },
  );
  await expect(card.getByTestId('task-auto-status')).toContainText('原因：Still no mobile test.');
  // 使用者自己移卡片：清掉「等你決定」，退回次數保留。
  await card.getByRole('button', { name: '移到「進行中」' }).click();
  await expect(card.getByTestId('task-auto-status')).toHaveText('◇ Write tests 退回 3/3');

  await page.getByRole('button', { name: '全隊暫停' }).click();
  await expect(page.getByTestId('team-controls-msg')).toContainText('任務自動執行也關了');
  await expect(toggle).not.toBeChecked();
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
  // 刪除按兩次（第一下之後 350ms 內再按不算，防連點）。
  await added.getByRole('button', { name: '刪除' }).click();
  await expect(added).toHaveCount(1);
  await page.waitForTimeout(400);
  await added.getByRole('button', { name: '再按一次刪除這條規則' }).click();
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
  // 上膛＝實心紅（data-armed，controls.css），不用讀字也知道再按就執行。
  await expect(armed).toHaveAttribute('data-armed', 'true');
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).not.toContainText('完成');
  await shot(page, 'team-stop-armed');
  // 和流程頁同一個 useTwoStep：350ms 內的連點不算確認。
  await page.waitForTimeout(400);
  await armed.click();
  await expect(msg).toContainText('已要求停止 2 個 session');
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).toContainText('完成');
  await expect(page.getByTestId('member-s-auth').locator('.lamp')).toContainText('完成');
});

test('標記完成：按鈕在成員列，有完成時交接規則才標耗額度，規則畫面說明觸發條件', async ({
  page,
}) => {
  await openWorkbench(page);
  const source = page.getByTestId('member-s-auth');
  const other = page.getByTestId('member-s-tests');
  await expect(source.locator('.chip.cost')).toHaveText('◈ 耗額度');
  await expect(source).toContainText('會觸發完成時交接');
  await expect(other.locator('.chip.cost')).toHaveCount(0);

  const rule = page.getByTestId('rule-rule-1');
  await expect(rule).toContainText('在你按來源 session 的「標記完成」');
  await expect(rule).toContainText('回合結束不會觸發');
  await rule.getByLabel('觸發條件').selectOption('on_fail');
  await expect(rule).toContainText('變成「錯誤」時觸發');
  await expect(source.locator('.chip.cost')).toHaveCount(0);
  await rule.getByLabel('觸發條件').selectOption('on_done');
  await expect(source.locator('.chip.cost')).toHaveText('◈ 耗額度');

  await source.getByRole('button', { name: '標記完成' }).click();
  await expect(source.locator('.lamp')).toContainText('完成');
  await expect(source.getByRole('button', { name: '標記完成' })).toHaveCount(0);
  await expect(source.locator('.chip.cost')).toHaveCount(0);
});

test('全隊停止第一次按完離開就解除，不會誤觸', async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole('button', { name: '全隊停止' }).click();
  await page.getByLabel('新任務').click();
  await expect(page.getByRole('button', { name: '全隊停止' })).toBeVisible();
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).toContainText('工作中');
});

test('全隊暫停 → 全隊繼續：只打開當初關的規則與任務自動執行，手動打開過的不重複，全部暫停中要提示', async ({
  page,
}) => {
  await openWorkbench(page);
  await page.getByTestId('task-auto-toggle').check();
  await expect(page.getByTestId('task-auto-msg')).toContainText('已開啟');
  const msg = page.getByTestId('team-controls-msg');
  const toggle = page.getByTestId('rule-rule-1').getByRole('button', { name: /自動交接/ });

  await page.getByRole('button', { name: '全隊暫停' }).click();
  await expect(msg).toContainText('關閉 1 條交接規則');
  await expect(msg).toContainText('任務自動執行也關了');
  // 暫停後：「全隊暫停」換成「全隊繼續」，「全隊停止」還在；說明會打開什麼。
  await expect(page.getByRole('button', { name: '全隊暫停' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全隊繼續' })).toBeVisible();
  await expect(page.getByRole('button', { name: '全隊停止' })).toBeVisible();
  await expect(page.getByTestId('team-hold-note')).toContainText(
    '繼續會打開當初關掉的 1 條交接規則與任務自動執行，不自動送字',
  );
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('task-auto-toggle')).not.toBeChecked();
  await shot(page, 'team-hold-pause');

  // 第一次：照當初關掉的打開。
  await page.getByRole('button', { name: '全隊繼續' }).click();
  await expect(msg).toHaveText('已繼續：打開 1 條交接規則。沒有自動送字。 任務自動執行也打開了。');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('task-auto-toggle')).toBeChecked();
  await expect(page.getByRole('button', { name: '全隊暫停' })).toBeVisible();
  await expect(page.getByTestId('team-hold-note')).toHaveCount(0);

  // 第二次：暫停後手動打開規則、全部暫停中。
  await page.getByRole('button', { name: '全隊暫停' }).click();
  await expect(page.getByRole('button', { name: '全隊繼續' })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await fake(page, `void backend.pauseBoard('finish_turn')`);
  await page.getByRole('button', { name: '全隊繼續' }).click();
  await expect(msg).toContainText('已繼續：打開 0 條交接規則');
  await expect(msg).toContainText('1 條在暫停後已被手動打開，沒有重複開');
  await expect(msg).toContainText('目前全部暫停中，自動送字仍會被擋');
  await expect(page.getByRole('button', { name: '全隊暫停' })).toBeVisible();
});

test('全隊停止 → 全隊啟動：--resume 接回當初停掉的、打開規則；失聯的列出來，機器回來再按一次', async ({
  page,
}) => {
  await openWorkbench(page);
  const msg = page.getByTestId('team-controls-msg');
  await page.getByRole('button', { name: '全隊停止' }).click();
  await page.waitForTimeout(400); // 350ms 內的連點不算確認（useTwoStep）
  await page.getByRole('button', { name: '再按一次，停止 2 個 session' }).click();
  await expect(msg).toContainText('已要求停止 2 個 session');
  // 停止後：只剩「全隊啟動」，按一次就好（接回不送字）。
  const start = page.getByRole('button', { name: '全隊啟動' });
  await expect(start).toBeVisible();
  await expect(page.getByRole('button', { name: '全隊暫停' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全隊停止' })).toHaveCount(0);
  await expect(page.getByTestId('team-hold-note')).toContainText(
    '啟動會用 --resume 接回 2 個 session 的原對話（不送字、不花額度），再打開當初關掉的 1 條交接規則',
  );
  await shot(page, 'team-hold-stop');

  // 機器失聯：接不回，記錄留著。
  await fake(page, `backend.setMachineOnline('m-studio', false)`);
  await start.click();
  await expect(msg).toContainText('已啟動：接回 0 個 session');
  await expect(msg).toContainText('打開 1 條交接規則');
  await expect(msg).toContainText('2 個機器失聯還沒接回：');
  await expect(msg).toContainText('等機器回來再按一次「全隊啟動」');
  await expect(start).toBeVisible();
  await expect(
    page.getByTestId('rule-rule-1').getByRole('button', { name: /自動交接/ }),
  ).toHaveAttribute('aria-pressed', 'true');

  // 機器回來：再按一次接回，規則不再碰。
  await fake(page, `backend.setMachineOnline('m-studio', true)`);
  await start.click();
  await expect(msg).toHaveText(
    '已啟動：接回 2 個 session（--resume，不送字），打開 0 條交接規則。',
  );
  await expect(page.getByTestId('member-s-tests').locator('.lamp')).not.toContainText('完成');
  await expect(page.getByRole('button', { name: '全隊暫停' })).toBeVisible();
  await expect(page.getByRole('button', { name: '全隊停止' })).toBeVisible();
});

test('手機寬度：全隊暫停／繼續是會動到 session 的動作（.act 56px）、不超出畫面', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbenchPhone(page);
  const pause = page.getByRole('button', { name: '全隊暫停' });
  await pause.click();
  const resume = page.getByRole('button', { name: '全隊繼續' });
  await expect(resume).toBeVisible();
  const box = (await resume.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(56);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const stop = (await page.getByRole('button', { name: '全隊停止' }).boundingBox())!;
  expect(stop.height).toBeGreaterThanOrEqual(56);
  await shot(page, 'team-hold-phone');
  await resume.click();
  await expect(page.getByTestId('team-controls-msg')).toContainText('已繼續');
});

test('雙向（來回）規則：一次建 A→B、B→A，各自的觸發條件，共用輪數上限', async ({ page }) => {
  await openWorkbench(page);
  const box = page.getByTestId('new-rule');
  await box.getByRole('button', { name: '雙向（來回）' }).click();
  await box.getByLabel('A', { exact: true }).selectOption({ label: 'Write tests' });
  await box.getByLabel('B', { exact: true }).selectOption({ label: 'Fix login' });
  await box.getByLabel('A → B 觸發條件').selectOption('on_file');
  await box.getByLabel('A → B 檔案樣式').fill('results/**');
  // B → A 預設是回覆含標記，標記預設 [需要實驗]。
  await expect(box.getByLabel('B → A 觸發條件')).toHaveValue('on_marker');
  await expect(box.getByLabel('B → A 標記')).toHaveValue('[需要實驗]');
  await expect(box.getByLabel('來回上限')).toHaveValue('3');

  // 標記不能空白。
  await box.getByLabel('B → A 標記').fill(' ');
  await box.getByRole('button', { name: '新增雙向規則' }).click();
  await expect(box.getByTestId('new-rule-msg')).toContainText('要填標記');
  await box.getByLabel('B → A 標記').fill('[需要實驗]');
  await box.getByLabel('來回上限').selectOption('2');
  await box.getByRole('button', { name: '新增雙向規則' }).click();
  await expect(box.getByTestId('new-rule-msg')).toContainText('已新增兩條規則（最多 2 輪）');

  const forward = page.locator('.rule', { hasText: 'Write tests → Fix login' });
  const back = page.locator('.rule', { hasText: 'Fix login → Write tests' }).filter({
    hasText: '雙向',
  });
  await expect(forward.locator('.rule-rounds')).toHaveText('雙向・最多 2 輪');
  await expect(forward.getByLabel('檔案樣式')).toHaveValue('results/**');
  await expect(forward.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(back.locator('.rule-rounds')).toHaveText('雙向・最多 2 輪');
  await expect(back.getByLabel('觸發條件')).toHaveValue('on_marker');
  await expect(back.getByLabel('標記')).toHaveValue('[需要實驗]');
  await expect(back).toContainText('最後一則回覆含有標記字串');
  await shot(page, 'team-two-way-rules');

  // 規則列可以改回單向。
  await forward.getByLabel('來回上限').selectOption('');
  await expect(forward.locator('.rule-rounds')).toHaveCount(0);
});

test('到輪數上限擋下的交接要看得到', async ({ page }) => {
  await openWorkbench(page);
  await fake(
    page,
    `backend.addSessionEvent('s-tests', 'handoff.blocked', { fromSessionId: 's-tests', toSessionId: 's-auth', reason: 'round_limit', round: 4, maxRounds: 3 });`,
  );
  await page.goto('/#/canvas');
  await page.goto('/#/team/team-demo-auth');
  const log = page.getByTestId('handoff-activity');
  await expect(log).toContainText('停下：已來回 3 輪');
  await expect(log).toContainText('第 3/3 輪');
});

test('學術研究團隊：依階段組隊、實驗 ⇄ 寫作雙向交接、TEAM.md 範本，之後可換階段', async ({
  page,
}) => {
  await page.goto('/#/team');
  await page.getByLabel('團隊名稱').fill('論文');
  await page
    .getByRole('group', { name: '團隊類型' })
    .getByRole('button', { name: '學術研究' })
    .click();
  const phases = page.getByRole('group', { name: '研究階段' });
  await expect(phases.getByRole('button', { name: '選題' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('第 2 位的 session 名稱')).toHaveValue('論文-LR1');
  await expect(page.getByTestId('research-pair')).toHaveCount(0);

  await phases.getByRole('button', { name: '寫作' }).click();
  await expect(page.getByTestId('preset-hint')).toContainText('開始寫論文');
  const names = await page
    .locator('.plan-row input[aria-label$="session 名稱"]')
    .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
  expect(names).toEqual(['論文-LD', '論文-WR', '論文-RV', '論文-EX1']);
  await expect(page.getByLabel('第 2 位的角色')).toHaveValue('wr');
  await expect(page.locator('.plan-row').nth(1)).toContainText('自己的 worktree');
  await expect(page.locator('.plan-row').nth(2)).toContainText('共用主資料夾（唯讀）');
  const pair = page.getByTestId('research-pair');
  await expect(pair.getByRole('checkbox')).toBeChecked();
  await expect(pair.getByLabel('來回上限')).toHaveValue('3');
  await expect(page.getByTestId('research-context-hint')).toContainText('不會自動送給任何 session');

  await page.getByLabel('工作目錄').fill('/home/demo/paper');
  await shot(page, 'team-new-research');
  await page.getByRole('button', { name: '建立團隊和 4 個 session' }).click();

  await expect(page.getByRole('heading', { name: '論文' })).toBeVisible();
  await expect(page.getByTestId('team-phase')).toHaveText('寫作');
  await expect(page.locator('.member', { hasText: '論文-WR' })).toContainText('寫作（WR）');
  await expect(page.locator('.member', { hasText: '論文-EX1' })).toContainText('實驗（EX）');
  const exToWr = page.locator('.rule', { hasText: '論文-EX1 → 論文-WR' });
  await expect(exToWr.getByLabel('標記')).toHaveValue('[結果完成]');
  await expect(exToWr.locator('.rule-rounds')).toHaveText('雙向・最多 3 輪');
  const wrToEx = page.locator('.rule', { hasText: '論文-WR → 論文-EX1' });
  await expect(wrToEx.getByLabel('標記')).toHaveValue('[需要實驗]');
  await expect(wrToEx.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByRole('textbox', { name: 'TEAM.md' })).toHaveValue(
    /論文數字只能引用 results\/ 裡的檔案/,
  );

  // 換到實驗：寫作用不到（可封存），要補一位 EX（接著編號）。
  const panel = page.getByTestId('phase-panel');
  await panel.getByRole('button', { name: '換到「實驗」' }).click();
  const diff = page.getByTestId('phase-diff');
  await expect(diff.locator('.phase-extra')).toContainText('論文-WR');
  await expect(diff.getByTestId('add-members').getByLabel('第 1 位的 session 名稱')).toHaveValue(
    '論文-EX2',
  );
  await expect(diff.getByTestId('add-members').getByLabel('第 1 位的角色')).toHaveValue('ex');
  await shot(page, 'team-phase-change');
  await diff.getByRole('button', { name: '開 1 個 session 並加入' }).click();
  await expect(diff.getByTestId('add-members-msg')).toContainText('已加入 1 位');
  await expect(page.locator('.member', { hasText: '論文-EX2' })).toBeVisible();

  const archive = diff.locator('.phase-extra li', { hasText: '論文-WR' }).getByRole('button');
  await archive.click();
  await expect(archive).toHaveText('再按一次封存 論文-WR');
  await page.waitForTimeout(400); // 350ms 內的連點不算確認（useTwoStep）
  await archive.click();
  await expect(diff.getByTestId('phase-extra-none')).toBeVisible();
  await diff.getByRole('button', { name: '切換到「實驗」' }).click();
  await expect(page.getByTestId('team-phase')).toHaveText('實驗');
  await expect(page.getByTestId('phase-msg')).toContainText('已切換到「實驗」');
  // 交接規則都還在（指向已封存的寫作，封存時已暫停）。
  await expect(page.locator('.rules .rule')).toHaveCount(2);
});

test('補成員：只建團隊之後一次補齊；再補時不重複隊長、名稱接著編號', async ({ page }) => {
  await page.goto('/#/team');
  await page.getByLabel('團隊名稱').fill('空隊');
  await page.getByRole('button', { name: '建立團隊' }).click();
  await expect(page.getByRole('heading', { name: '空隊' })).toBeVisible();

  await page.getByTestId('add-members-toggle').click();
  const add = page.getByTestId('add-members');
  // 沒有成員：要自己選資料夾。
  await expect(add.getByLabel('工作目錄')).toBeVisible();
  await add.getByRole('button', { name: '標準' }).click();
  await expect(add.getByLabel('第 1 位的 session 名稱')).toHaveValue('空隊-LD');
  await add.getByRole('button', { name: '開 4 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-error')).toContainText('工作目錄');
  await add.getByLabel('工作目錄').fill('/home/demo/project');
  await add.getByRole('button', { name: '開 4 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-msg')).toContainText('已加入 4 位');
  await expect(add.getByTestId('plan-step-1')).toContainText('已加入');
  for (const name of ['空隊-LD', '空隊-BD1', '空隊-BD2', '空隊-RV']) {
    await expect(page.locator('.member', { hasText: name })).toBeVisible();
  }
  await expect(page.getByLabel('空隊-LD 的角色')).toHaveValue('lead');

  // 再補一批：沿用隊長的位置，隊長拿掉，名稱接著編號。
  await add.getByRole('button', { name: '再補一批' }).click();
  await expect(add.getByTestId('plan-place-fixed')).toContainText('/home/demo/project');
  await add.getByRole('button', { name: '標準' }).click();
  await expect(add).toContainText('團隊已經有隊長');
  const names = await add
    .locator('.plan-row input[aria-label$="session 名稱"]')
    .evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
  expect(names).toEqual(['空隊-BD3', '空隊-BD4', '空隊-RV2']);
  // 手動加一位隊長：連同現有的隊長一起算。
  await add.getByLabel('第 1 位的角色').selectOption('lead');
  await add.getByRole('button', { name: '開 3 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-error')).toContainText('剛好一位隊長');
  await add.getByLabel('第 1 位的角色').selectOption('worker');
  await add.getByRole('button', { name: '開 3 個 session 並加入' }).click();
  await expect(add.getByTestId('add-members-msg')).toContainText('已加入 3 位');
  await expect(page.locator('.member', { hasText: '空隊-RV2' })).toBeVisible();
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
    await expect(panel).toContainText('標記完成');
    await panel.getByRole('button', { name: '自動交接：關' }).click();
    await expect(panel.getByRole('button', { name: '自動交接：開' })).toBeVisible();
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
