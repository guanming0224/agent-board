// 待處理（#/queue）與審核中心（#/review）重新整理後的版面（GM 2026-11-06）：
// 分組、數量、鍵盤、列上的直接動作、審核中心的清單＋詳細、手機寬度。
// 不連外、不呼叫 LLM：資料從 dev server 同一個 store 模組注入，後端方法換成記錄用的替身。
import { expect, test, type Page } from '@playwright/test';
import type { Approval, Machine, Session } from '@agent-board/protocol';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const machine = (over: Partial<Machine> & Pick<Machine, 'id' | 'name'>): Machine => ({
  os: 'linux',
  online: true,
  lastSeenAt: minutesAgo(0),
  capabilities: {
    hasGpu: false,
    gpuName: null,
    cpuCores: 8,
    memoryBytes: 16 * 1024 ** 3,
    claudeVersion: '0.0.0-test',
  },
  ...over,
});

const session = (over: Partial<Session> & Pick<Session, 'id' | 'name'>): Session => ({
  machineId: 'm-a',
  projectId: null,
  cwd: '/work/api',
  branch: 'ab/fix',
  worktreePath: null,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  status: 'waiting_permission',
  statusDetail: null,
  claudeSessionId: null,
  lastLines: [],
  lastOutputAt: minutesAgo(0),
  statusSince: minutesAgo(1),
  contextTokens: 1000,
  contextWindow: null,
  repoRoot: null,
  repoCommonDir: null,
  createdAt: minutesAgo(30),
  endedAt: null,
  archived: false,
  archivedAt: null,
  readOnly: false,
  autoContinue: null,
  dispatchedBy: null,
  ...over,
});

const approval = (over: Partial<Approval> & Pick<Approval, 'id' | 'sessionId'>): Approval => ({
  kind: 'permission',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  suggestions: [],
  matchedRule: null,
  message: null,
  createdAt: minutesAgo(1),
  ...over,
});

const rigA = machine({ id: 'm-a', name: 'rig-a' });
const rigB = machine({ id: 'm-b', name: 'rig-b' });
const DANGER_CMD = 'git push --force origin main && rm -rf build/ && echo done-with-a-long-tail';

interface Seed {
  machines?: Machine[];
  sessions?: Session[];
  approvals?: Approval[];
  patch?: string;
}

/** 八種情況各一個 session：危險、權限、計畫、回覆、提問、錯誤、額度、剛開好；外加一個工作中的。 */
const board = (): Seed => ({
  machines: [rigA, rigB],
  sessions: [
    session({
      id: 'danger',
      name: 'Deploy',
      status: 'running',
      permissionMode: 'bypassPermissions',
    }),
    session({ id: 'perm', name: 'Fix login', statusSince: minutesAgo(12) }),
    session({ id: 'perm2', name: 'Lint', statusSince: minutesAgo(3), machineId: 'm-b' }),
    session({ id: 'plan', name: 'Migrate', status: 'plan_review', permissionMode: 'plan' }),
    session({
      id: 'reply',
      name: 'API paging',
      status: 'waiting_input',
      statusSince: minutesAgo(27),
      lastLines: ['Done with step 1.', 'Keep the old ?page= parameter for one release?'],
    }),
    session({ id: 'ask', name: 'Release notes', status: 'waiting_input', machineId: 'm-b' }),
    session({ id: 'err', name: 'Preview', status: 'error', lastLines: ['Error: ENOENT .env'] }),
    session({ id: 'quota', name: 'Docs', status: 'rate_limited' }),
    session({ id: 'idle', name: 'Scratch', status: 'waiting_input', statusDetail: 'idle:start' }),
    session({ id: 'busy', name: 'Busy', status: 'running' }),
  ],
  approvals: [
    approval({
      id: 'a-danger',
      sessionId: 'danger',
      kind: 'danger',
      toolInput: { command: DANGER_CMD },
      matchedRule: 'git push --force',
    }),
    approval({ id: 'a-perm', sessionId: 'perm', createdAt: minutesAgo(12) }),
    approval({ id: 'a-perm2', sessionId: 'perm2', createdAt: minutesAgo(3) }),
    approval({
      id: 'a-plan',
      sessionId: 'plan',
      kind: 'plan',
      toolName: null,
      toolInput: {
        plan: Array.from({ length: 30 }, (_, i) => `${i + 1}. step ${i + 1}`).join('\n'),
      },
    }),
    approval({
      id: 'a-ask',
      sessionId: 'ask',
      kind: 'question',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{ question: 'Which version?', options: [{ label: 'v1' }, { label: 'v2' }] }],
      },
    }),
  ],
});

async function open(page: Page, route: string, seed: Seed = {}) {
  await page.goto('about:blank');
  await page.goto('/?demo=1#/settings');
  await page.evaluate(async (s) => {
    const path = '/src/shared/store.ts';
    const { useBoard } = await import(/* @vite-ignore */ path);
    const { backend } = useBoard.getState();
    const calls: unknown[] = [];
    Object.assign(window, { __calls: calls, __board: useBoard });
    backend.decideApproval = async (a: { id: string }, decision: unknown) => {
      calls.push({ type: 'decide', id: a.id, decision });
      useBoard.setState((state: { approvals: { id: string }[] }) => ({
        approvals: state.approvals.filter((x) => x.id !== a.id),
      }));
    };
    backend.sendPrompt = (sessionId: string, text: string) => {
      calls.push({ type: 'prompt', sessionId, text });
    };
    backend.updateSession = async (id: string, patch: unknown) => {
      calls.push({ type: 'update', id, patch });
      useBoard.setState((state: { sessions: { id: string }[] }) => ({
        sessions: state.sessions.filter((x) => x.id !== id),
      }));
      return {};
    };
    backend.listTeams = async () => [{ id: 't1', name: 'Alpha', color: 'teal' }];
    backend.listTeamMembers = async () => [
      { teamId: 't1', sessionId: 'perm', role: 'worker' },
      { teamId: 't1', sessionId: 'err', role: 'lead' },
    ];
    backend.listHandoffRules = async () => [];
    const next: Record<string, unknown> = {};
    if (s.machines) next.machines = s.machines;
    if (s.sessions) next.sessions = s.sessions;
    if (s.approvals) next.approvals = s.approvals;
    useBoard.setState(next);
    if (s.patch) new Function('backend', s.patch)(backend);
  }, seed);
  await page.evaluate((r) => {
    location.hash = r;
  }, `#/${route}`);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: Record<string, unknown>[] }).__calls);

const setBoard = (page: Page, patch: Partial<Seed>) =>
  page.evaluate((p) => {
    (window as unknown as { __board: { setState(v: unknown): void } }).__board.setState(p);
  }, patch);

const rowIds = (page: Page, group: string) =>
  page
    .getByTestId(`triage-group-${group}`)
    .locator('.triage-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));

const noOverflow = (page: Page) =>
  page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth <= el.clientWidth && document.body.scrollWidth <= el.clientWidth;
  });

const problems = new WeakMap<Page, string[]>();

test.use({ locale: 'zh-TW' });

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => {
    list.push(`dialog: ${d.type()} ${d.message()}`);
    void d.dismiss();
  });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || !url.protocol.startsWith('http')) return route.continue();
    list.push(`external request: ${url.href}`);
    return route.abort();
  });
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

test.describe('待處理', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('分四組、各組數量、組內危險指令置頂與等最久的在前；「等你」和頁首一致', async ({ page }) => {
    await open(page, 'queue', board());
    await expect
      .poll(() => rowIds(page, 'decide'))
      .toEqual(['queue-danger', 'queue-perm', 'queue-perm2', 'queue-plan']);
    expect(await rowIds(page, 'reply')).toEqual(['queue-reply', 'queue-ask']);
    expect(await rowIds(page, 'trouble')).toEqual(['queue-err', 'queue-quota']);
    expect(await rowIds(page, 'other')).toEqual(['queue-idle']);
    await expect(page.getByTestId('queue-busy')).toHaveCount(0);
    await expect(page.getByTestId('triage-count-decide')).toHaveText('4');
    await expect(page.getByTestId('triage-count-reply')).toHaveText('2');

    // 頁首的「等你」（attention.ts）：額度用完與剛開好的不算，頁面說明差在哪。
    await expect(page.getByTestId('waiting-count')).toHaveText('7');
    await expect(page.getByTestId('triage-waiting').locator('b')).toHaveText('7');
    await expect(page.getByTestId('triage-note')).toContainText('1 個額度用完');
    await expect(page.getByTestId('triage-note')).toContainText('1 個剛開好還沒做事');

    // 每列：徽章、名稱、呼號、一行摘要、等多久
    const danger = page.getByTestId('queue-danger');
    await expect(danger.locator('.badge')).toHaveText('⛔危險指令');
    await expect(danger.locator('.row-rule')).toContainText('git push --force');
    await expect(danger.locator('.triage-context')).toContainText(DANGER_CMD);
    await expect(danger.locator('.callsign').first()).toHaveText('rig-a / api @ ab/fix');
    await expect(danger.locator('.chip.bypass')).toHaveText('略過權限');
    await expect(page.getByTestId('queue-reply').locator('.triage-context')).toHaveText(
      'Keep the old ?page= parameter for one release?',
    );
    await expect(page.getByTestId('queue-perm').locator('.age')).toHaveText('等了 12 分');

    // 某一組空了：寫一句說明，不是整頁空白
    await setBoard(page, { sessions: board().sessions!.filter((s) => s.id === 'err') });
    await expect(page.getByTestId('triage-group-decide')).toContainText('沒有要你允許或審核的。');
    await expect(page.getByTestId('triage-group-reply')).toContainText('沒有在等你回覆的。');
    await expect(page.getByTestId('triage-note')).not.toContainText('不算');
  });

  test('鍵盤：j／k、↑↓ 移動，Enter 在畫布上打開；N 照常跳到下一個', async ({ page }) => {
    await open(page, 'queue', board());
    await expect(page.getByTestId('queue-danger')).toBeVisible();
    await page.keyboard.press('j');
    await expect(page.getByTestId('queue-danger')).toBeFocused();
    await page.keyboard.press('j');
    await expect(page.getByTestId('queue-perm')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('queue-perm2')).toBeFocused();
    await page.keyboard.press('k');
    await expect(page.getByTestId('queue-perm')).toBeFocused();
    // 只有一列可以 Tab 進來（roving tabindex）
    await expect(page.locator('.triage-row[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/canvas/);

    await page.evaluate(() => (location.hash = '#/queue'));
    await expect(page.getByTestId('queue-danger')).toBeVisible();
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/#\/canvas/);
    // 「下一個」從剛才打開的那列接著走（順序照 pendingQueue：⛔ → 故障 → 等你）。
    const focused = () =>
      page.evaluate(async () => {
        const path = '/src/views/uiStore.ts';
        const { useViewsUi } = await import(/* @vite-ignore */ path);
        return useViewsUi.getState().focusId as string | null;
      });
    await expect.poll(focused).not.toBe('perm');
    expect(await focused()).toBeTruthy();
  });

  test('列上的動作：允許一次、拒絕要原因、危險指令按兩次並先顯示全文', async ({ page }) => {
    await open(page, 'queue', board());
    const perm = page.getByTestId('queue-perm');
    await perm.getByRole('button', { name: '允許一次' }).click();
    await expect
      .poll(() => calls(page))
      .toEqual([
        { type: 'decide', id: 'a-perm', decision: { behavior: 'allow', remember: false } },
      ]);

    const perm2 = page.getByTestId('queue-perm2');
    await perm2.getByRole('button', { name: '拒絕' }).click();
    const reason = perm2.getByLabel('拒絕原因（必填）');
    await expect(reason).toBeFocused();
    await perm2.getByRole('button', { name: '送出拒絕' }).click();
    await expect(perm2.locator('.msg')).toHaveText('要填拒絕原因才能送出');
    await reason.fill('   ');
    await perm2.getByRole('button', { name: '送出拒絕' }).click();
    expect(await calls(page)).toHaveLength(1);
    await reason.fill(' 先跑 lint --fix ');
    await perm2.getByRole('button', { name: '送出拒絕' }).click();
    await expect
      .poll(async () => (await calls(page))[1])
      .toEqual({
        type: 'decide',
        id: 'a-perm2',
        decision: { behavior: 'deny', reason: '先跑 lint --fix' },
      });

    const danger = page.getByTestId('queue-danger');
    await danger.getByRole('button', { name: '允許一次' }).click();
    await expect(danger.locator('.armed .command')).toHaveText(DANGER_CMD);
    const confirm = danger.getByRole('button', { name: '再按一次確認' });
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(400);
    expect(await calls(page)).toHaveLength(2);
    await confirm.click();
    await expect
      .poll(async () => (await calls(page))[2])
      .toEqual({
        type: 'decide',
        id: 'a-danger',
        decision: { behavior: 'allow', remember: false },
      });
  });

  test('列上的動作：回覆送進 session、回答提問、計畫去審核中心、標記完成、開終端機', async ({
    page,
  }) => {
    await open(page, 'queue', board());
    const reply = page.getByTestId('queue-reply');
    await reply.getByRole('button', { name: '回覆' }).click();
    await reply.getByRole('button', { name: '送出回答' }).click();
    await expect(reply.locator('.msg')).toHaveText('要填內容才能送出');
    await reply.getByLabel('你的回答').fill('keep it');
    await reply.getByRole('button', { name: '送出回答' }).click();

    const ask = page.getByTestId('queue-ask');
    await ask.getByRole('button', { name: '回覆' }).click();
    await ask.getByRole('button', { name: 'v2', exact: true }).click();
    await expect(ask.getByLabel('你的回答')).toHaveValue('v2');
    await ask.getByRole('button', { name: '送出回答' }).click();

    await page.getByTestId('queue-err').getByRole('button', { name: '標記完成' }).click();
    await expect(page.getByTestId('queue-err')).toHaveCount(0);
    await expect
      .poll(() => calls(page))
      .toEqual([
        { type: 'prompt', sessionId: 'reply', text: 'keep it' },
        { type: 'decide', id: 'a-ask', decision: { behavior: 'answer', text: 'v2' } },
        { type: 'update', id: 'err', patch: { markDone: true } },
      ]);
    // 額度用完沒有「標記完成」（只能等）
    await expect(page.getByTestId('queue-quota').getByRole('button')).toHaveCount(0);
    await expect(
      page.getByTestId('queue-quota').getByRole('link', { name: '開啟終端機' }),
    ).toHaveAttribute('href', '#/terminal/quota');
    await page.getByTestId('queue-plan').getByRole('link', { name: '審核計畫' }).click();
    await expect(page).toHaveURL(/#\/review\/plan$/);
    await expect(page.getByTestId('review-a-plan')).toBeFocused();
  });

  test('成員：危險指令的按鈕停用並說明', async ({ page }) => {
    await open(page, 'queue', {
      ...board(),
      patch: `backend.currentUser = async () => ({ id: 'u2', name: 'pat', role: 'member', locale: 'zh-TW' });`,
    });
    const danger = page.getByTestId('queue-danger');
    await expect(danger).toContainText('只有管理員能決定這個');
    await expect(danger.getByRole('button', { name: '允許一次' })).toBeDisabled();
    await expect(danger.getByRole('button', { name: '拒絕' })).toBeDisabled();
    await expect(
      page.getByTestId('queue-perm').getByRole('button', { name: '允許一次' }),
    ).toBeEnabled();
  });

  test('篩選：團隊與機器', async ({ page }) => {
    await open(page, 'queue', board());
    await expect(page.getByTestId('queue-perm').locator('.team-chip')).toHaveText('Alpha');
    await page.getByTestId('triage-filter-team').selectOption({ label: 'Alpha' });
    await expect(page.locator('.triage-row')).toHaveCount(2);
    await expect(page.getByTestId('queue-perm')).toBeVisible();
    await expect(page.getByTestId('queue-err')).toBeVisible();
    // 篩選不改「等你」的數量（和頁首一致）
    await expect(page.getByTestId('triage-waiting').locator('b')).toHaveText('7');
    await page.getByTestId('triage-filter-team').selectOption({ label: '全部' });
    await page.getByTestId('triage-filter-machine').selectOption({ label: 'rig-b' });
    await expect(page.locator('.triage-row')).toHaveCount(2);
    await expect(page.getByTestId('queue-perm2')).toBeVisible();
    await expect(page.getByTestId('queue-ask')).toBeVisible();
  });
});

test.describe('審核中心', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('左邊依種類分組、選一項看詳細；處理完選下一項；j／k 換項', async ({ page }) => {
    await open(page, 'review', board());
    const groups = page.locator('.review-queue section');
    await expect(groups).toHaveCount(5);
    await expect(page.getByTestId('review-group-danger')).toContainText('危險指令1');
    await expect(page.getByTestId('review-group-permission').locator('.review-row')).toHaveCount(2);
    // 故障與剛開好的沒有東西可審
    await expect(page.getByTestId('review-row-err')).toHaveCount(0);
    await expect(page.getByTestId('review-row-idle')).toHaveCount(0);
    await expect(page.getByTestId('review-total')).toHaveText('6 項待決定');

    // 危險指令置頂並預設選中；詳細寫出原因
    await expect(page.getByTestId('review-row-a-danger')).toHaveAttribute('aria-current', 'true');
    const card = page.getByTestId('review-a-danger');
    await expect(card.locator('.why')).toHaveText(
      '這個指令命中危險指令清單，要你親自確認才會執行。',
    );
    await expect(card.locator('.command')).toHaveText(DANGER_CMD);

    // 鍵盤換項
    await page.keyboard.press('j');
    await expect(page.getByTestId('review-a-perm')).toBeVisible();
    await expect(page.getByTestId('review-row-a-perm')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('review-a-perm2')).toBeVisible();
    await page.keyboard.press('k');
    await expect(page.getByTestId('review-a-perm')).toBeVisible();

    // 處理完選原本位置的下一個，不跳回最上面的危險指令
    await page.getByTestId('review-a-perm').getByRole('button', { name: '允許一次' }).click();
    await expect(page.getByTestId('review-a-perm2')).toBeVisible();
    await expect(page.getByTestId('review-row-a-perm2')).toHaveAttribute('aria-current', 'true');
    // 剛換上來的項目短暫停用，連點不會按到別人
    await expect(
      page.getByTestId('review-a-perm2').getByRole('button', { name: '允許一次' }),
    ).toBeDisabled();
    expect(await calls(page)).toHaveLength(1);
  });

  test('決定列：拒絕和必填原因在同一排；長計畫先收合，可以展開', async ({ page }) => {
    await open(page, 'review', board());
    await page.getByTestId('review-row-a-perm').click();
    const card = page.getByTestId('review-a-perm');
    const row = card.locator('.decision-bar .deny-row');
    await expect(row.getByLabel('拒絕原因（必填）')).toBeVisible();
    await expect(row.getByRole('button', { name: '拒絕' })).toBeVisible();

    await page.getByTestId('review-row-a-plan').click();
    const plan = page.getByTestId('review-a-plan');
    const toggle = plan.getByRole('button', { name: '展開全文' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const clamped = await plan.locator('.command').evaluate((el) => el.clientHeight);
    await toggle.click();
    await expect(plan.getByRole('button', { name: '收合' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await plan.locator('.command').evaluate((el) => el.clientHeight)).toBeGreaterThan(
      clamped,
    );
    // 收合時文字也都在（只是限制高度），螢幕閱讀器與搜尋都找得到
    await expect(plan.locator('.command')).toContainText('30. step 30');
  });

  test('最近的決定：打開才讀，顯示結果與原因；成員看到說明', async ({ page }) => {
    await open(page, 'review', {
      ...board(),
      patch: `window.__audit = 0; backend.listAudit = async (f) => { window.__audit += 1; window.__auditFilter = f; return [
        { id: 'h1', userId: 'u-demo', sessionId: 'perm', action: 'approval.decide', at: new Date().toISOString(),
          detail: JSON.stringify({ approvalId: 'x', kind: 'danger', toolName: 'Bash', matchedRule: 'rm -rf', decision: { behavior: 'deny', reason: '會刪到資料' } }) },
        { id: 'h2', userId: 'u-demo', sessionId: 'reply', action: 'approval.decide', at: new Date().toISOString(),
          detail: JSON.stringify({ approvalId: 'y', kind: 'permission', decision: { behavior: 'allow', remember: true } }) },
      ]; };`,
    });
    const history = page.getByTestId('review-history');
    await expect(history).toBeVisible();
    expect(await page.evaluate(() => (window as never as { __audit: number }).__audit)).toBe(0);
    await history.locator('summary').click();
    const rows = history.getByTestId('history-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Fix login');
    await expect(rows.first()).toContainText('拒絕');
    await expect(rows.first()).toContainText('會刪到資料');
    await expect(rows.nth(1)).toContainText('允許並記住');
    expect(
      await page.evaluate(() => (window as never as { __auditFilter: unknown }).__auditFilter),
    ).toEqual({
      action: 'approval.decide',
      limit: 20,
    });

    await open(page, 'review', {
      ...board(),
      patch: `backend.currentUser = async () => ({ id: 'u2', name: 'pat', role: 'member', locale: 'zh-TW' });`,
    });
    await page.getByTestId('review-history').locator('summary').click();
    await expect(page.getByTestId('review-history')).toContainText('操作紀錄只有管理員看得到。');
  });
});

for (const width of [320, 375]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 760 }, hasTouch: true });

    test('待處理：沒有水平捲軸，動作按鈕夠大，展開拒絕原因也不撐版面', async ({ page }) => {
      const seed = board();
      seed.sessions = seed.sessions!.map((s) =>
        s.id === 'perm'
          ? {
              ...s,
              name: 'A session with quite a long descriptive name for wrapping',
              branch: 'ab/feature/an-extremely-long-branch-name-that-cannot-wrap-at-spaces',
            }
          : s,
      );
      await open(page, 'queue', seed);
      await expect(page.getByTestId('queue-perm')).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      const allow = page.getByTestId('queue-perm').getByRole('button', { name: '允許一次' });
      expect((await allow.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await page.getByTestId('queue-perm').getByRole('button', { name: '拒絕' }).click();
      await page.getByTestId('queue-danger').getByRole('button', { name: '允許一次' }).click();
      await expect(page.getByTestId('queue-danger').locator('.armed .command')).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
    });

    test('審核中心：清單在上、詳細在下，選了捲到詳細；沒有水平捲軸', async ({ page }) => {
      await open(page, 'review', board());
      const list = (await page.locator('.review-queue').boundingBox())!;
      const detail = (await page.locator('.review-detail').boundingBox())!;
      expect(detail.y).toBeGreaterThan(list.y + list.height - 1);
      expect(await noOverflow(page)).toBe(true);
      await page.getByTestId('review-row-a-ask').click();
      await expect(page.getByTestId('review-a-ask')).toBeInViewport();
      await page.getByTestId('review-row-a-danger').click();
      await page.getByTestId('review-a-danger').getByRole('button', { name: '允許一次' }).click();
      await expect(page.getByTestId('review-a-danger').locator('.armed .command')).toHaveText(
        DANGER_CMD,
      );
      expect(await noOverflow(page)).toBe(true);
    });
  });
}
