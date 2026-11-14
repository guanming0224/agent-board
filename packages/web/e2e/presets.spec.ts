// P3 項目二：團隊 Presets（docs/p3-spec.md §2.6 驗收）。用 fakeBackend（demo），不花額度、不連外、不跑 claude。
// hub 端（schema v10、REST、名稱唯一、WS preset.list、audit）在 hub 的 presets.test.ts；
// 「另一個瀏覽器 1 秒內」靠 hub 推 preset.list（hub 測試驗推送），這裡驗同一個瀏覽器的設定頁 → 底部列即時反映。
import { expect, test, type Page } from '@playwright/test';

const STORE = '/src/shared/store.ts';
const CWD = '/home/demo/project';

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

/** 在頁面裡拿 fake backend 跑一段程式（async，可回傳值）。 */
async function run<R>(page: Page, script: string, arg?: unknown): Promise<R> {
  return page.evaluate(
    async ({ url, script, arg }) => {
      const { useBoard } = (await import(url)) as {
        useBoard: { getState(): { backend: unknown } };
      };
      return (await new Function('backend', 'arg', `return (async () => { ${script} })()`)(
        useBoard.getState().backend,
        arg,
      )) as unknown;
    },
    { url: STORE, script, arg },
  ) as Promise<R>;
}

/** 隊長＋2 成員＋審查、1 條交接規則（關）的團隊（§2.6-1）。 */
async function seedTeam(page: Page, name = '策略驗證'): Promise<{ teamId: string }> {
  return run(
    page,
    `
    const team = await backend.createTeam({ name: arg.name, goal: 'Validate', doneCriteria: '', color: 'lime', contextMd: '# rules', taskAuto: false });
    const mk = async (suffix, mode, wt, ro) => (await backend.createSession({
      name: arg.name + '-' + suffix, machineId: 'm-studio', projectId: null, cwd: arg.cwd, useWorktree: wt,
      permissionMode: mode, model: null, accountProfile: null, resumeClaudeSessionId: null, firstPrompt: null,
      readOnly: ro, zoneId: team.zoneId,
    })).id;
    const ld = await mk('LD', 'default', false, false);
    const bd1 = await mk('BD1', 'acceptEdits', true, false);
    const bd2 = await mk('BD2', 'acceptEdits', true, false);
    const rv = await mk('RV', 'plan', false, true);
    await backend.putTeamMember(team.id, ld, 'lead');
    await backend.putTeamMember(team.id, bd1, 'worker');
    await backend.putTeamMember(team.id, bd2, 'worker');
    await backend.putTeamMember(team.id, rv, 'reviewer');
    await backend.createHandoffRule(team.id, { fromSessionId: bd1, trigger: 'on_done', action: { toSessionId: rv }, enabled: false });
    return { teamId: team.id };
  `,
    { name, cwd: CWD },
  );
}

const baseConfig = (over: Record<string, unknown> = {}) => ({
  teamType: 'dev',
  color: 'teal',
  goal: 'g',
  placement: { machineId: 'm-studio', cwd: CWD, projectId: null },
  rows: [
    { kind: 'lead', permissionMode: 'default' },
    { kind: 'worker', permissionMode: 'acceptEdits' },
    { kind: 'reviewer', permissionMode: 'plan' },
  ],
  handoffRules: [],
  ...over,
});

async function createPreset(page: Page, name: string, over: Record<string, unknown> = {}) {
  return run<{ id: string }>(page, `return backend.createTeamPreset(arg);`, {
    name,
    config: baseConfig(over),
  });
}

/** 攔下 createSession，記下每次的 spec（第一個指令、worktree、唯讀）；failName 那一列回 409。 */
async function recordCreates(page: Page, failName?: string) {
  await run(
    page,
    `
    const original = backend.createSession.bind(backend);
    window.__specs = [];
    backend.createSession = async (spec) => {
      if (arg && spec.name === arg) throw Object.assign(new Error('Session conflict (409)'), { code: 'session_conflict', status: 409 });
      window.__specs.push(spec);
      return original(spec);
    };
  `,
    failName ?? null,
  );
}

type Spec = {
  name: string;
  firstPrompt: string | null;
  useWorktree: boolean;
  readOnly: boolean;
  permissionMode: string;
};
const specs = (page: Page) => page.evaluate(() => (window as never as { __specs: Spec[] }).__specs);

const openPresets = async (page: Page) => {
  await page.getByTestId('command-presets').click();
  await expect(page.getByTestId('presets-pop')).toBeVisible();
};
const presetRow = (page: Page, name: string) => page.locator(`.preset-row[data-name="${name}"]`);

/**
 * 新增團隊在桌面是浮動對話框（GM 2026-11-14，STYLE §5.2）：沒開就按「新增團隊」打開，回傳名稱欄。
 * 關掉只是藏起來（已填的內容留著），所以用「看不看得到」判斷要不要開。
 */
async function newTeamName(page: Page) {
  const dialog = page.getByTestId('new-team-dialog');
  if (!(await dialog.isVisible())) {
    await page.getByTestId('new-team-open').click();
    await expect(dialog).toBeVisible();
  }
  return dialog.getByLabel('團隊名稱');
}

test('從團隊存成 Preset：4 列、角色與模式一致、交接規則 1 條且關、初始進度卡空；底部列套用建出同樣的團隊', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const { teamId } = await seedTeam(page);
  await page.evaluate((id) => (location.hash = `#/team/${id}`), teamId);
  await expect(page.getByTestId('team-workbench')).toBeVisible();
  await page.getByTestId('team-more').click();
  await page.getByTestId('team-save-preset').click();
  const dialog = page.getByTestId('preset-save');
  await expect(dialog.getByTestId('preset-save-name')).toHaveValue('策略驗證');
  await expect(dialog.getByTestId('preset-save-rows').locator('li')).toHaveCount(4);
  await expect(dialog.getByTestId('preset-save-rules')).toContainText('交接規則 1 條（開啟 0 條）');
  await dialog.getByTestId('preset-save-submit').click();
  await expect(dialog.getByTestId('preset-saved')).toContainText('策略驗證');
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();

  const [preset] = await run<
    {
      config: {
        rows: { kind: string; permissionMode: string; useWorktree: boolean | null }[];
        handoffRules: { enabled: boolean; fromRow: number; toRow: number }[];
        initialProgress: Record<string, string>;
      };
    }[]
  >(page, 'return backend.listTeamPresets();');
  expect(preset!.config.rows.map((r) => [r.kind, r.permissionMode, r.useWorktree])).toEqual([
    ['lead', 'default', false],
    ['worker', 'acceptEdits', true],
    ['worker', 'acceptEdits', true],
    ['reviewer', 'plan', false],
  ]);
  expect(preset!.config.handoffRules).toEqual([
    { fromRow: 1, toRow: 3, trigger: 'on_done', enabled: false },
  ]);
  expect(preset!.config.initialProgress).toEqual({
    status: '',
    next: '',
    blockers: '',
    gmNotes: '',
  });

  // 套用（§2.6-2）：名稱自動加「 2」；Enter 建立。
  await page.evaluate(() => (location.hash = '#/canvas'));
  await recordCreates(page);
  await openPresets(page);
  const row = presetRow(page, '策略驗證');
  await expect(row).toContainText('LD · BD · BD · RV');
  await expect(row).toContainText('project · demo-studio');
  await expect(row.locator('.chip.cost')).toHaveCount(0);
  await row.click();
  await expect(page.getByTestId('preset-team-name')).toHaveValue('策略驗證 2');
  // 彈出區的輸入框套共用樣式（controls.css；以前是瀏覽器預設外觀）：--surface-2 底、--border-2 框、高 36。
  const nameInput = page.getByTestId('preset-team-name');
  await expect(nameInput).toHaveCSS('background-color', 'rgb(27, 33, 43)');
  await expect(nameInput).toHaveCSS('border-top-color', 'rgb(51, 60, 73)');
  expect((await nameInput.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await expect(page.getByTestId('preset-zone')).toContainText('主要');
  await expect(page.getByTestId('preset-rows').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('preset-row-4')).toContainText('主資料夾（唯讀）');
  await expect(page.getByTestId('preset-create')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/team\/.+/);
  await expect(page.getByTestId('team-panel')).toBeVisible();
  await expect(page.getByRole('heading', { name: '策略驗證 2' })).toBeVisible();
  await expect(page.getByTestId('presets-pop')).toHaveCount(0);

  const created = await specs(page);
  expect(created.map((s) => [s.name, s.useWorktree, s.readOnly, s.permissionMode])).toEqual([
    ['策略驗證 2-LD', false, false, 'default'],
    ['策略驗證 2-BD1', true, false, 'acceptEdits'],
    ['策略驗證 2-BD2', true, false, 'acceptEdits'],
    ['策略驗證 2-RV', false, true, 'plan'],
  ]);
  expect(created.every((s) => s.firstPrompt === null)).toBe(true);
  const newId = decodeURIComponent(page.url().split('#/team/')[1]!);
  const rules = await run<
    { enabled: boolean; fromSessionId: string; action: { toSessionId: string } }[]
  >(page, 'return backend.listHandoffRules(arg);', newId);
  expect(rules).toHaveLength(1);
  expect(rules[0]!.enabled).toBe(false);
  // 原團隊還在。
  expect(
    (await run<{ name: string }[]>(page, 'return backend.listTeams();')).map((t) => t.name),
  ).toEqual(expect.arrayContaining(['策略驗證', '策略驗證 2']));
  // audit：preset.apply 的成功與失敗列數（§2.6-10）。
  const audit = await run<{ detail: string }[]>(
    page,
    "return backend.listAudit({ action: 'preset.apply' });",
  );
  expect(JSON.parse(audit[0]!.detail)).toMatchObject({
    teamId: newId,
    created: 4,
    failed: 0,
    rulesCreated: 1,
    firstPromptHeld: false,
  });
});

test('整合（P3 項目一）：團隊寫過進度卡時「存成 Preset」出現「把目前進度卡當初始內容」，勾了就存進 initialProgress', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  const { teamId } = await seedTeam(page, '有卡的團隊');
  await run(
    page,
    `await backend.saveProgress({ teamId: arg }, { baseRevision: 0, status: 'S1', next: 'N1', blockers: '', gmNotes: 'G1' });`,
    teamId,
  );
  await page.evaluate((id) => (location.hash = `#/team/${id}`), teamId);
  await expect(page.getByTestId('team-workbench')).toBeVisible();
  await page.getByTestId('team-more').click();
  await page.getByTestId('team-save-preset').click();
  const dialog = page.getByTestId('preset-save');
  await expect(dialog.getByTestId('preset-save-progress')).toBeVisible();
  await expect(dialog.getByTestId('preset-save-progress')).not.toBeChecked();
  await dialog.getByTestId('preset-save-progress').check();
  await dialog.getByTestId('preset-save-submit').click();
  await expect(dialog.getByTestId('preset-saved')).toContainText('有卡的團隊');
  const [preset] = await run<{ config: { initialProgress: Record<string, string> } }[]>(
    page,
    'return backend.listTeamPresets();',
  );
  expect(preset!.config.initialProgress).toEqual({
    status: 'S1',
    next: 'N1',
    blockers: '',
    gmNotes: 'G1',
  });
});

test('第一個指令以進度卡那一行開頭、接著是 Preset 的指令（一行）；開啟的交接規則與任務自動執行標 ◈ 且建好後是開的', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await createPreset(page, '研究', {
    leadFirstPrompt: 'Start with the 2021 data.',
    initialProgress: { next: 'A', blockers: 'fee\nassumption' },
    handoffRules: [{ fromRow: 1, toRow: 2, trigger: 'on_done', enabled: true }],
    taskAuto: true,
  });
  await recordCreates(page);
  await openPresets(page);
  await expect(presetRow(page, '研究').locator('.chip.cost')).toHaveText('◈ 耗額度');
  await presetRow(page, '研究').click();
  const preview = page.getByTestId('preset-preview');
  await expect(preview.getByTestId('preset-autos')).toContainText(
    '交接：研究-BD1 → 研究-RV（做完時）',
  );
  await expect(preview.getByTestId('preset-autos')).toContainText('任務自動執行');
  await expect(preview.getByTestId('preset-autos').locator('.chip.cost')).toHaveCount(2);
  await expect(preview.getByTestId('preset-first-prompt')).toContainText(
    '[Progress card: 研究] Next: A | Blockers: fee assumption Start with the 2021 data.',
  );
  await page.getByTestId('preset-create').click();
  // 整合後（P3 項目一）初始進度卡寫得進去：全部順利 → 聚焦新團隊、開團隊面板。
  await expect(page.getByTestId('team-panel')).toBeVisible();
  await expect(page.getByTestId('preset-partial')).toHaveCount(0);
  const created = await specs(page);
  expect(created[0]!.firstPrompt).toBe(
    '[Progress card: 研究] Next: A | Blockers: fee assumption Start with the 2021 data.',
  );
  expect(created.slice(1).every((s) => s.firstPrompt === null)).toBe(true);
  const team = (
    await run<{ id: string; name: string; taskAuto: boolean }[]>(
      page,
      'return backend.listTeams();',
    )
  ).find((t) => t.name === '研究')!;
  expect(team.taskAuto).toBe(true);
  const rules = await run<{ enabled: boolean }[]>(
    page,
    'return backend.listHandoffRules(arg);',
    team.id,
  );
  expect(rules.map((r) => r.enabled)).toEqual([true]);
  // 驗收 3：初始進度卡 next=A、revision 1。
  const card = await run<{ next: string; blockers: string; revision: number }>(
    page,
    'return backend.getProgress({ teamId: arg });',
    team.id,
  );
  expect(card).toMatchObject({ next: 'A', blockers: 'fee\nassumption', revision: 1 });
});

test('機器失聯、資料夾不存在：「建立」停用並說明；換到在線機器並選資料夾後可以建立', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await createPreset(page, '筆電', {
    placement: { machineId: 'm-laptop', cwd: CWD, projectId: null },
  });
  await openPresets(page);
  await presetRow(page, '筆電').click();
  await expect(page.getByTestId('preset-problem')).toContainText('demo-laptop 失聯，恢復後再建立');
  await expect(page.getByTestId('preset-create')).toBeDisabled();
  await page.getByTestId('preset-change-machine').click();
  await page.locator('.preset-place-edit select').first().selectOption('m-studio');
  // 換機器要重選資料夾。
  await expect(page.locator('.preset-place-edit input.mono')).toHaveValue('');
  await expect(page.getByTestId('preset-create')).toBeDisabled();
  await page.locator('.preset-place-edit input.mono').fill('/home/demo/does-not-exist');
  await expect(page.getByTestId('preset-problem')).toContainText('不存在');
  await expect(page.getByTestId('preset-create')).toBeDisabled();
  await page.locator('.preset-place-edit input.mono').fill(CWD);
  await expect(page.getByTestId('preset-create')).toBeEnabled();
  // Esc 回清單，再 Esc 關掉。
  await page.getByTestId('preset-team-name').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preset-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('presets-pop')).toHaveCount(0);
});

test('某列建立失敗（409）：其他列照建、失敗列寫原因、不重複建立；audit 記成功 3 失敗 1', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await createPreset(page, 'P', {
    rows: [
      { kind: 'lead', permissionMode: 'default' },
      { kind: 'worker', permissionMode: 'acceptEdits' },
      { kind: 'worker', permissionMode: 'acceptEdits' },
      { kind: 'reviewer', permissionMode: 'plan' },
    ],
  });
  await recordCreates(page, 'P-BD1');
  await openPresets(page);
  await presetRow(page, 'P').click();
  await page.getByTestId('preset-create').click();
  await expect(page.getByTestId('preset-step-2')).toContainText('Session conflict (409)');
  await expect(page.getByTestId('preset-step-1')).toContainText('已加入');
  await expect(page.getByTestId('preset-step-3')).toContainText('已加入');
  await expect(page.getByTestId('preset-partial')).toContainText('1');
  expect((await specs(page)).map((s) => s.name)).toEqual(['P-LD', 'P-BD2', 'P-RV']);
  // 不能再按一次（避免重複建立）。
  await expect(page.getByTestId('preset-create')).toHaveCount(0);
  const audit = await run<{ detail: string }[]>(
    page,
    "return backend.listAudit({ action: 'preset.apply' });",
  );
  expect(JSON.parse(audit[0]!.detail)).toMatchObject({ created: 3, failed: 1 });
});

test('設定 Presets：改名、上下移、刪除＋復原即時反映到底部列；名稱重複回錯誤；編輯成略過權限後清單與預覽標紅', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await createPreset(page, 'Alpha');
  await createPreset(page, 'Beta');
  await page.evaluate(() => (location.hash = '#/settings/presets'));
  const admin = page.getByTestId('preset-admin');
  await expect(admin.locator('.preset-admin-row')).toHaveCount(2);
  await expect(page.getByText('範本＝一個 session；Preset＝整個團隊')).toBeVisible();

  const rowOf = (name: string) => admin.locator(`.preset-admin-row[data-name="${name}"]`);
  // 名稱重複（不分大小寫）。
  await rowOf('Beta').getByTestId('preset-rename').click();
  await page.getByTestId('preset-rename-input').fill('alpha');
  await page.getByTestId('preset-rename-save').click();
  await expect(rowOf('Beta').getByTestId('preset-admin-error')).toContainText('已經有叫「alpha」');
  await page.getByTestId('preset-rename-input').fill('Gamma');
  await page.getByTestId('preset-rename-save').click();
  await expect(rowOf('Gamma')).toBeVisible();
  // 上移。
  await rowOf('Gamma').getByTestId('preset-up').click();
  await expect(admin.locator('.preset-admin-row').first()).toHaveAttribute('data-name', 'Gamma');

  // 編輯：第 2 列改成 bypassPermissions。
  await rowOf('Alpha').getByTestId('preset-edit').click();
  const editor = page.getByTestId('preset-editor');
  await editor.getByLabel('第 2 位的權限模式').selectOption('bypassPermissions');
  await editor.getByTestId('preset-edit-save').click();
  await expect(editor.getByTestId('preset-edit-msg')).toHaveText('已儲存');
  await expect(rowOf('Alpha').locator('.chip.mode.bypass')).toBeVisible();

  // 刪除＋復原。
  await rowOf('Gamma').getByTestId('preset-delete').click();
  await expect(page.getByTestId('preset-undo')).toContainText('已刪除「Gamma」');
  await expect(admin.locator('.preset-admin-row')).toHaveCount(1);
  await page.getByTestId('preset-undo-button').click();
  await expect(admin.locator('.preset-admin-row')).toHaveCount(2);
  await expect(admin.locator('.preset-admin-row').first()).toHaveAttribute('data-name', 'Gamma');

  // 底部列清單跟著變。
  await page.evaluate(() => (location.hash = '#/canvas'));
  await openPresets(page);
  await expect(page.locator('.preset-row')).toHaveCount(2);
  await expect(page.locator('.preset-row').first()).toHaveAttribute('data-name', 'Gamma');
  await expect(presetRow(page, 'Alpha').getByTestId('preset-bypass')).toHaveText('略過權限');
  await presetRow(page, 'Alpha').click();
  await expect(page.getByTestId('preset-row-2')).toHaveClass(/bypass/);
  await expect(page.getByTestId('preset-row-2').locator('.chip.mode.bypass')).toBeVisible();
});

test('全部暫停中套用含第一個指令的 Preset：隊長建好時沒收到字；隊長卡片「送出第一個指令」按下後（等輸入時）收到', async ({
  page,
}) => {
  await page.goto('/#/canvas');
  await createPreset(page, '暫停', { leadFirstPrompt: 'Go now.' });
  await run(
    page,
    `backend.setPauseState({ paused: { mode: 'finish_turn', since: new Date().toISOString(), by: 'u-demo', byName: 'demo', clearedOnRestart: 0 }, held: { deliveries: 0, sessions: 0, sessionsWaiting: 0, autoContinues: 0 } });`,
  );
  await recordCreates(page);
  await openPresets(page);
  await presetRow(page, '暫停').click();
  await expect(page.getByTestId('preset-paused')).toContainText('隊長第一個指令不會自動送');
  await page.getByTestId('preset-create').click();
  await expect(page).toHaveURL(/#\/team\/.+/);
  const created = await specs(page);
  expect(created.map((s) => s.firstPrompt)).toEqual([null, null, null]);
  const leadId = await page.evaluate(async (url) => {
    const { useBoard } = (await import(url)) as {
      useBoard: { getState(): { sessions: { id: string; name: string }[] } };
    };
    return useBoard.getState().sessions.find((s) => s.name === '暫停-LD')!.id;
  }, STORE);
  // 團隊面板與畫布上的隊長卡片都有按鈕。
  await expect(page.getByTestId('team-held-first')).toBeVisible();
  const cardButton = page.getByTestId(`card-${leadId}`).getByTestId('held-first-send');
  await expect(cardButton).toBeVisible();
  // 隊長等輸入時按下：群發（點名隊長）送出。
  await run(page, `backend.setSessionStatus(arg, 'waiting_input');`, leadId);
  // 畫布縮到 30% 以下時卡片上的按鈕會藏起來（GM 2026-11-09 Q4）。團隊面板開著時畫布會把整個團隊框進左邊，
  // 可能剛好低於 30%，所以先關面板回畫布，在隊長卡上用滾輪放大到看得清楚再按（面板裡另有同一顆按鈕）。
  await page.evaluate(() => (location.hash = '#/canvas'));
  await expect(page.getByTestId('team-held-first')).toHaveCount(0);
  const zoom = async () =>
    parseInt((await page.getByTestId('zoom-level').textContent()) ?? '0', 10);
  // 等「框出團隊」的鏡頭動畫停下（縮放連續 0.5 秒沒變），不然放大到一半又被拉回去。
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await zoom();
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [500] },
    )
    .toBe(true);
  for (let i = 0; i < 8 && (await zoom()) < 40; i += 1) {
    const lead = (await page.getByTestId(`card-${leadId}`).boundingBox())!;
    await page.mouse.move(lead.x + lead.width / 2, lead.y + 12);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(100);
  }
  expect(await zoom()).toBeGreaterThanOrEqual(30);
  await cardButton.click();
  await expect(
    page.getByTestId(`card-${leadId}`).getByTestId(`held-first-${leadId}`),
  ).toContainText('已送出');
  const sent = await page.evaluate(async (url) => {
    const { useBoard } = (await import(url)) as {
      useBoard: {
        getState(): {
          broadcasts?: { text: string; targets: { sessionId: string; state: string }[] }[];
        };
      };
    };
    return useBoard.getState().broadcasts ?? [];
  }, STORE);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toBe('Go now.');
  expect(sent[0]!.targets).toEqual([expect.objectContaining({ sessionId: leadId, state: 'sent' })]);
  await expect(page.getByTestId('team-held-first')).toHaveCount(0);
  const audit = await run<{ detail: string }[]>(
    page,
    "return backend.listAudit({ action: 'preset.apply' });",
  );
  expect(JSON.parse(audit[0]!.detail)).toMatchObject({ firstPromptHeld: true });
});

test('新增團隊表單「存成 Preset」：不建立團隊，只存表單', async ({ page }) => {
  await page.goto('/#/team');
  await (await newTeamName(page)).fill('表單');
  await page.getByRole('button', { name: '標準' }).click();
  await page.getByLabel('工作目錄').fill(CWD);
  await page.getByTestId('new-team-save-preset').click();
  await page.getByTestId('preset-save-prompt').fill('Plan the work.');
  await page.getByTestId('preset-save-submit').click();
  await expect(page.getByTestId('preset-saved')).toBeVisible();
  const presets = await run<
    { name: string; config: { rows: unknown[]; leadFirstPrompt: string } }[]
  >(page, 'return backend.listTeamPresets();');
  expect(presets.map((p) => [p.name, p.config.rows.length, p.config.leadFirstPrompt])).toEqual([
    ['表單', 4, 'Plan the work.'],
  ]);
  expect(
    (await run<{ name: string }[]>(page, 'return backend.listTeams();')).map((t) => t.name),
  ).not.toContain('表單');
});

test('手機（390×844）：團隊清單「從 Preset 建立」完成套用；設定裡編輯顯示「回電腦處理」', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/team');
  await createPreset(page, '手機');
  await page.getByTestId('preset-entry').click();
  // 手機可點元素至少 44（GM 2026-11-09 Q1；56 只給允許、拒絕、暫停、繼續、送出回答這類會動到 session 的動作）。
  expect((await page.getByTestId('preset-entry').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await presetRow(page, '手機').click();
  const create = page.getByTestId('preset-create');
  await expect(create).toBeEnabled();
  expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await create.click();
  await expect(page).toHaveURL(/#\/team\/.+/);
  await expect(page.getByRole('heading', { name: '手機' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
  await page.evaluate(() => (location.hash = '#/settings/presets'));
  await expect(page.getByTestId('preset-edit-desktop').first()).toHaveText('編輯：回電腦處理');
  await expect(page.getByTestId('preset-edit')).toHaveCount(0);
});

test('英文介面：Presets 彈出區與預覽不撐爆', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/canvas');
  await createPreset(page, 'Strategy validation with a long name', {
    leadFirstPrompt: 'go',
    taskAuto: true,
  });
  await page.getByRole('group', { name: '介面語言' }).getByRole('button', { name: 'EN' }).click();
  await openPresets(page);
  await presetRow(page, 'Strategy validation with a long name').click();
  await expect(page.getByTestId('preset-create')).toHaveText('Create (3 sessions)');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(1024);
  const box = (await page.getByTestId('presets-pop').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1024);
});
