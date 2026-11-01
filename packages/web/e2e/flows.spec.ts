// 流程畫面 E2E。不連外、不呼叫 LLM：資料從 dev server 同一個 store 模組注入，後端方法換成記錄用的替身。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Approval, Machine, Session } from '@agent-board/protocol';
import { en, zhTW } from '../src/flows/messages';

const here = dirname(fileURLToPath(import.meta.url));
const flowsDir = join(here, '../src/flows');

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

const session = (over: Partial<Session> & Pick<Session, 'id' | 'name' | 'machineId'>): Session => ({
  projectId: null,
  cwd: '/work/api',
  branch: 'ab/fix-auth',
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
  createdAt: minutesAgo(30),
  endedAt: null,
  archived: false,
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
const rigGpu = machine({
  id: 'm-g',
  name: 'rig-gpu',
  capabilities: { ...rigA.capabilities, hasGpu: true, gpuName: 'Test GPU' },
});
const rigOff = machine({ id: 'm-off', name: 'rig-off', online: false, lastSeenAt: minutesAgo(40) });

const DANGER_CMD = 'git push --force origin main && echo finished';

interface Seed {
  machines?: Machine[];
  sessions?: Session[];
  approvals?: Approval[];
  connected?: boolean;
  /** 在 page context 內對 backend 加工的程式碼字串，例如換成會失敗的方法。 */
  patch?: string;
}

const patchBackend = (name: string, body: string) => `backend.${name} = ${body};`;

/** 先到畫布（占位）注入資料與替身，再切到要測的畫面，畫面第一次 mount 就用到替身。 */
async function open(page: Page, route: string, seed: Seed = {}) {
  // 只換 hash 不會重新載入，上一次注入的替身會留著；先離開才是乾淨的 store。
  await page.goto('about:blank');
  await page.goto('/?demo=1#/canvas');
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
    const createSession = backend.createSession;
    backend.createSession = async (input: unknown) => {
      calls.push({ type: 'create', input });
      return createSession(input);
    };
    const update = backend.updateSettings;
    backend.updateSettings = async (patch: unknown) => {
      calls.push({ type: 'settings', patch });
      return update(patch);
    };
    const remove = backend.removeMachine;
    backend.removeMachine = async (id: string) => {
      calls.push({ type: 'removeMachine', id });
      return remove(id);
    };
    const next: Record<string, unknown> = {};
    if (s.machines) next.machines = s.machines;
    if (s.sessions) next.sessions = s.sessions;
    if (s.approvals) next.approvals = s.approvals;
    if (s.connected !== undefined) next.connected = s.connected;
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

/** 整頁沒有水平捲軸。 */
async function expectNoPageOverflow(page: Page) {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    size.scroll,
    `scrollWidth ${size.scroll} > clientWidth ${size.client}`,
  ).toBeLessThanOrEqual(size.client);
}

/** 綠色只能出現在 diff 區塊（STYLE.md 規則一）。回傳違規元素。 */
const findGreenOutsideDiff = (page: Page) =>
  page.evaluate(() => {
    const isGreen = (color: string) => {
      const m = color.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
      if (!m || m[4] === '0') return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return g > r + 20 && g > b + 20;
    };
    return [...document.querySelectorAll('.flows *')]
      .filter((el) => !el.closest('.diff'))
      .filter((el) => {
        const style = getComputedStyle(el);
        return [style.color, style.backgroundColor, style.borderLeftColor].some(isGreen);
      })
      .map((el) => el.tagName + '.' + el.className);
  });

const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('console', (m) => {
    if (m.type() === 'error') list.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  // 不可用瀏覽器原生 alert／confirm。beforeunload 是設定頁未存檔的離開提醒，測試換頁時放行。
  page.on('dialog', (d) => {
    if (d.type() === 'beforeunload') return void d.accept();
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

test.describe('審核中心', () => {
  test.use({ locale: 'zh-TW' });

  test('demo 資料：呼號在最上方，允許一次真的走後端', async ({ page }) => {
    await open(page, 'review');
    const card = page.getByTestId('review-a-1');
    await expect(card.locator('.sign .callsign')).toHaveText('demo-studio / project @ ab/fix-auth');
    await expect(card.locator('.sign .chip')).toHaveText('default');
    await expect(card.locator('.command')).toHaveText('npm test -- auth');
    const order = await card.evaluate((el) => {
      const sign = el.querySelector('.sign')!;
      const tool = el.querySelector('.tool')!;
      return sign.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    await card.getByRole('button', { name: '允許一次' }).click();
    await expect(card).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'a-1', decision: { behavior: 'allow', remember: false } },
    ]);
  });

  test('拒絕沒填原因不可送出，只有空白也不行', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigA],
      sessions: [session({ id: 's1', name: 'Fix', machineId: 'm-a' })],
      approvals: [approval({ id: 'a1', sessionId: 's1' })],
    });
    const card = page.getByTestId('review-a1');
    const reason = card.getByLabel('拒絕原因（必填）');
    await card.getByRole('button', { name: '拒絕' }).click();
    await expect(card.locator('.msg')).toHaveText('要填拒絕原因才能送出');
    await expect(reason).toHaveAttribute('aria-invalid', 'true');
    await expect(reason).toBeFocused();
    await reason.fill('   ');
    await card.getByRole('button', { name: '拒絕' }).click();
    expect(await calls(page)).toEqual([]);
    await reason.fill('  會刪到正式資料 ');
    await card.getByRole('button', { name: '拒絕' }).click();
    await expect(card).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'a1', decision: { behavior: 'deny', reason: '會刪到正式資料' } },
    ]);
  });

  const dangerSeed = (): Seed => ({
    machines: [rigA],
    sessions: [
      session({
        id: 's1',
        name: 'Deploy',
        machineId: 'm-a',
        status: 'running',
        permissionMode: 'bypassPermissions',
      }),
      session({ id: 's2', name: 'Old', machineId: 'm-a', statusSince: minutesAgo(50) }),
    ],
    approvals: [
      approval({ id: 'old', sessionId: 's2', createdAt: minutesAgo(50) }),
      approval({
        id: 'd1',
        sessionId: 's1',
        kind: 'danger',
        toolInput: { command: DANGER_CMD },
        matchedRule: 'git push --force',
      }),
    ],
  });

  test('危險指令：置頂、紅線、按一次不送，第一次顯示全文，按兩次才送一次', async ({ page }) => {
    await open(page, 'review', dangerSeed());
    await expect(page.locator('.review').first()).toHaveAttribute('data-testid', 'review-d1');
    const card = page.getByTestId('review-d1');
    await expect(card.getByRole('alert')).toContainText('⛔');
    await expect(card.getByRole('alert')).toContainText('git push --force');
    await expect(card.locator('.chip.bypass')).toHaveText('略過權限');
    const line = await card.evaluate((el) => {
      const before = getComputedStyle(el, '::before');
      return {
        width: before.borderLeftWidth,
        style: before.borderLeftStyle,
        color: before.borderLeftColor,
      };
    });
    expect(line).toEqual({ width: '5px', style: 'solid', color: 'rgb(240, 102, 95)' });
    await expect(card.getByRole('button', { name: '允許並記住' })).toHaveCount(0);

    const allow = card.getByRole('button', { name: '允許一次' });
    await allow.click();
    await expect(card.locator('.armed .command')).toHaveText(DANGER_CMD);
    const confirm = card.getByRole('button', { name: '再按一次確認' });
    await expect(confirm).toBeVisible();
    await page.waitForTimeout(400);
    expect(await calls(page)).toEqual([]);

    await confirm.click();
    await expect(card).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'd1', decision: { behavior: 'allow', remember: false } },
    ]);
  });

  test('危險指令：超過 4 秒要重來，手滑連點不算兩次', async ({ page }) => {
    await open(page, 'review', dangerSeed());
    const card = page.getByTestId('review-d1');
    await card.getByRole('button', { name: '允許一次' }).click();
    await expect(card.getByRole('button', { name: '再按一次確認' })).toBeVisible();
    await page.waitForTimeout(4200);
    await expect(card.getByRole('button', { name: '允許一次' })).toBeVisible();
    await expect(card.locator('.armed')).toHaveCount(0);
    expect(await calls(page)).toEqual([]);

    await card.getByRole('button', { name: '允許一次' }).dblclick();
    await page.waitForTimeout(100);
    expect(await calls(page)).toEqual([]);
    await expect(card.getByRole('button', { name: '再按一次確認' })).toBeVisible();
  });

  test('diff 配 + −，顏色只有 diff 是綠的', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigA],
      sessions: [session({ id: 's1', name: 'Edit', machineId: 'm-a' })],
      approvals: [
        approval({
          id: 'e1',
          sessionId: 's1',
          toolName: 'Edit',
          toolInput: {
            file_path: 'src/auth.ts',
            old_string: 'const a = 1;\nif (!cookie) return null;\nend();',
            new_string: 'const a = 1;\nif (!cookie) throw new AuthError();\nverify();\nend();',
          },
        }),
      ],
    });
    const diff = page.locator('.diff');
    await expect(diff).toHaveAttribute('aria-label', '程式碼差異：刪除 1 行、新增 2 行');
    await expect(diff.locator('.d')).toHaveText('−if (!cookie) return null;');
    await expect(diff.locator('.a')).toHaveCount(2);
    await expect(diff.locator('.a').first()).toContainText('+');
    await expect(diff.locator('.c').first()).toContainText('const a = 1;');
    await expect(page.getByTestId('review-e1').locator('.tool')).toContainText('src/auth.ts');
    const color = await diff
      .locator('.a')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(70, 194, 106)');
    expect(await findGreenOutsideDiff(page)).toEqual([]);
  });

  test('允許並記住：沒有建議時停用，有建議時送 remember', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigA],
      sessions: [
        session({ id: 's1', name: 'A', machineId: 'm-a' }),
        session({ id: 's2', name: 'B', machineId: 'm-a' }),
      ],
      approvals: [
        approval({ id: 'none', sessionId: 's1' }),
        approval({ id: 'some', sessionId: 's2', suggestions: [{ type: 'addRules' }] }),
      ],
    });
    await expect(
      page.getByTestId('review-none').getByRole('button', { name: '允許並記住' }),
    ).toBeDisabled();
    await page.getByTestId('review-some').getByRole('button', { name: '允許並記住' }).click();
    await expect(page.getByTestId('review-some')).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'some', decision: { behavior: 'allow', remember: true } },
    ]);
  });

  test('審核計畫：要求修改意見必填，批准送 allow', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigGpu],
      sessions: [
        session({
          id: 's1',
          name: 'Migrate',
          machineId: 'm-g',
          status: 'plan_review',
          permissionMode: 'plan',
        }),
        session({
          id: 's2',
          name: 'Migrate 2',
          machineId: 'm-g',
          status: 'plan_review',
          permissionMode: 'plan',
        }),
      ],
      approvals: [
        approval({
          id: 'p1',
          sessionId: 's1',
          kind: 'plan',
          toolName: null,
          toolInput: { plan: '1. Add column\n2. Backfill' },
        }),
        approval({
          id: 'p2',
          sessionId: 's2',
          kind: 'plan',
          toolName: null,
          toolInput: null,
          message: 'Plan from message',
        }),
      ],
    });
    const card = page.getByTestId('review-p1');
    await expect(card.locator('.command')).toContainText('2. Backfill');
    await expect(card.locator('.lamp')).toContainText('▣');
    await expect(page.getByTestId('review-p2').locator('.command')).toHaveText('Plan from message');
    await card.getByRole('button', { name: '要求修改' }).click();
    await expect(card.locator('.msg')).toHaveText('要填修改意見才能送出');
    expect(await calls(page)).toEqual([]);
    await card.getByLabel('修改意見（必填）').fill('先備份');
    await card.getByRole('button', { name: '要求修改' }).click();
    await expect(card).toHaveCount(0);
    await page.getByTestId('review-p2').getByRole('button', { name: '批准計畫' }).click();
    await expect(page.getByTestId('review-p2')).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'p1', decision: { behavior: 'deny', reason: '先備份' } },
      { type: 'decide', id: 'p2', decision: { behavior: 'allow', remember: false } },
    ]);
  });

  test('回答提問：選項填入、空白不可送；等你回覆直接送進 session', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigA],
      sessions: [
        session({ id: 's1', name: 'Docs', machineId: 'm-a', status: 'waiting_input' }),
        session({
          id: 's2',
          name: 'Idle',
          machineId: 'm-a',
          status: 'waiting_input',
          lastLines: ['Anything else?'],
        }),
      ],
      approvals: [
        approval({
          id: 'q1',
          sessionId: 's1',
          kind: 'question',
          toolName: 'AskUserQuestion',
          toolInput: {
            questions: [
              { question: 'Which language?', options: [{ label: 'zh' }, { label: 'en' }] },
            ],
          },
        }),
      ],
    });
    const card = page.getByTestId('review-q1');
    await expect(card).toContainText('Which language?');
    await card.getByRole('button', { name: '送出回答' }).click();
    await expect(card.locator('.msg')).toHaveText('要填內容才能送出');
    expect(await calls(page)).toEqual([]);
    await card.getByRole('button', { name: 'en', exact: true }).click();
    await expect(card.getByLabel('你的回答')).toHaveValue('en');
    await card.getByRole('button', { name: '送出回答' }).click();
    await expect(card).toHaveCount(0);

    const idle = page.getByTestId('review-s2');
    await expect(idle.locator('.command')).toHaveText('Anything else?');
    await idle.getByLabel('你的回答').fill('沒有了');
    await idle.getByRole('button', { name: '送出回答' }).click();
    const recorded = await calls(page);
    expect(recorded[0]).toEqual({
      type: 'decide',
      id: 'q1',
      decision: { behavior: 'deny', reason: 'en' },
    });
    expect(recorded[1]).toEqual({ type: 'prompt', sessionId: 's2', text: '沒有了' });
  });

  test('看不出 session、機器失聯、hub 斷線：不能允許', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigOff],
      sessions: [session({ id: 's1', name: 'Off', machineId: 'm-off' })],
      approvals: [
        approval({ id: 'lost', sessionId: 'nope' }),
        approval({ id: 'off', sessionId: 's1' }),
      ],
    });
    const lost = page.getByTestId('review-lost');
    await expect(lost.getByRole('button', { name: '允許一次' })).toBeDisabled();
    await expect(lost).toContainText('看不出這是哪個 session');
    const off = page.getByTestId('review-off');
    await expect(off.getByRole('button', { name: '允許一次' })).toBeDisabled();
    await expect(off).toContainText('連不到 rig-off，恢復後會自動接回');
    await expect(off).toContainText(/⊘ 失聯・最後讀到 .*\d\d:\d\d/);
    await expect(off).toHaveCSS('opacity', '0.45');
    await expect(off).toHaveCSS('background-image', /repeating-linear-gradient/);

    await open(page, 'review', {
      machines: [rigA],
      sessions: [session({ id: 's1', name: 'A', machineId: 'm-a' })],
      approvals: [approval({ id: 'a1', sessionId: 's1' })],
      connected: false,
    });
    await expect(page.locator('.stale-line')).toContainText('連不到 hub');
    await expect(page.locator('.page.is-stale')).toBeVisible();
    await expect(
      page.getByTestId('review-a1').getByRole('button', { name: '允許一次' }),
    ).toBeDisabled();
  });

  test('送出失敗留在畫面、寫發生什麼與怎麼辦，可以再按', async ({ page }) => {
    await open(page, 'review', {
      machines: [rigA],
      sessions: [session({ id: 's1', name: 'A', machineId: 'm-a' })],
      approvals: [approval({ id: 'a1', sessionId: 's1' })],
      patch: patchBackend('decideApproval', `async () => { throw new Error('boom'); }`),
    });
    const card = page.getByTestId('review-a1');
    await card.getByRole('button', { name: '允許一次' }).click();
    await expect(card.locator('.msg.err')).toHaveText('送不出去：boom。請求還在，稍後再按一次。');
    await expect(card.getByRole('button', { name: '允許一次' })).toBeEnabled();
  });

  test('載入、空的、錯誤', async ({ page }) => {
    await open(page, 'review', {
      patch: patchBackend('listProjects', `() => new Promise(() => {})`),
    });
    await expect(page.locator('[data-state=loading]')).toBeVisible();

    await open(page, 'review', { sessions: [], approvals: [] });
    await expect(page.locator('[data-state=empty]')).toContainText('沒有等你的');
    await expect(page.locator('[data-state=empty]').getByRole('link')).toHaveAttribute(
      'href',
      '#/new',
    );

    await open(page, 'review', {
      patch: `let n = 0; const ok = backend.listProjects;
        backend.listProjects = async () => { if (n++ < 2) throw new Error('down'); return ok(); };`,
    });
    const box = page.locator('[data-state=error]');
    await expect(box).toContainText('讀不到專案清單：down');
    await expect(page.getByTestId('review-a-1')).toBeVisible();
    await box.getByRole('button', { name: '重試' }).click();
    await expect(box).toHaveCount(0);
  });
});

test.describe('手機收件匣', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 375, height: 760 }, hasTouch: true });

  const inboxSeed = (): Seed => ({
    machines: [rigA, rigGpu],
    sessions: [
      session({
        id: 'perm',
        name: 'Fix',
        machineId: 'm-a',
        branch: 'ab/a-really-long-branch-name-that-must-not-be-cut-off',
      }),
      session({ id: 'perm2', name: 'Fix 2', machineId: 'm-a' }),
      session({
        id: 'plan',
        name: 'Plan',
        machineId: 'm-g',
        status: 'plan_review',
        permissionMode: 'plan',
      }),
      session({ id: 'reply', name: 'Reply', machineId: 'm-a', status: 'waiting_input' }),
      session({ id: 'stuck', name: 'Stuck', machineId: 'm-g', status: 'stuck' }),
      session({ id: 'run', name: 'Busy', machineId: 'm-a', status: 'running' }),
      session({
        id: 'dng',
        name: 'Danger',
        machineId: 'm-a',
        status: 'running',
        permissionMode: 'bypassPermissions',
      }),
    ],
    approvals: [
      approval({ id: 'a-perm', sessionId: 'perm', createdAt: minutesAgo(20) }),
      approval({ id: 'a-perm2', sessionId: 'perm2', createdAt: minutesAgo(10) }),
      approval({
        id: 'a-plan',
        sessionId: 'plan',
        kind: 'plan',
        toolName: null,
        toolInput: null,
        createdAt: minutesAgo(5),
      }),
      approval({
        id: 'a-dng',
        sessionId: 'dng',
        kind: 'danger',
        toolInput: { command: DANGER_CMD },
        matchedRule: 'git push --force',
        createdAt: minutesAgo(1),
      }),
    ],
  });

  test('只列待處理、順序對、按鈕 56px、呼號完整', async ({ page }) => {
    await open(page, 'inbox', inboxSeed());
    const ids = await page
      .locator('.inbox-item')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(ids).toEqual([
      'inbox-a-dng',
      'inbox-stuck',
      'inbox-a-perm',
      'inbox-a-perm2',
      'inbox-a-plan',
      'inbox-reply',
    ]);
    await expect(page.locator('.waiting b')).toHaveText('6');
    await expect(page.getByText('Busy')).toHaveCount(0);

    const heights = await page
      .locator('.inbox-item button')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(56);

    const sign = page.getByTestId('inbox-a-perm').locator('.callsign');
    await expect(sign).toHaveText(
      'rig-a / api @ ab/a-really-long-branch-name-that-must-not-be-cut-off',
    );
    const clipped = await sign.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
    await expectNoPageOverflow(page);
  });

  test('一鍵允許；處理完下一張滑上來時連點不會按到別人', async ({ page }) => {
    await open(page, 'inbox', inboxSeed());
    const first = page.getByTestId('inbox-a-perm');
    const second = page.getByTestId('inbox-a-perm2');
    await first.getByRole('button', { name: '允許一次' }).click();
    await expect(first).toHaveCount(0);
    await expect(second.getByRole('button', { name: '允許一次' })).toBeDisabled();
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'a-perm', decision: { behavior: 'allow', remember: false } },
    ]);
    await expect(second.getByRole('button', { name: '允許一次' })).toBeEnabled();
  });

  test('拒絕要原因；計畫與故障寫回電腦處理；回覆送進 session', async ({ page }) => {
    await open(page, 'inbox', inboxSeed());
    const item = page.getByTestId('inbox-a-perm');
    await item.getByRole('button', { name: '拒絕' }).click();
    await item.getByRole('button', { name: '送出拒絕' }).click();
    await expect(item.locator('.msg')).toHaveText('要填拒絕原因才能送出');
    expect(await calls(page)).toEqual([]);
    await item.getByLabel('拒絕原因（必填）').fill('不要');
    await item.getByRole('button', { name: '送出拒絕' }).click();
    await expect(item).toHaveCount(0);

    await expect(page.getByTestId('inbox-a-plan')).toContainText('回電腦處理');
    await expect(page.getByTestId('inbox-a-plan').getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId('inbox-stuck')).toContainText('回電腦處理');

    const reply = page.getByTestId('inbox-reply');
    await reply.getByLabel('你的回答').fill('繼續');
    await reply.getByRole('button', { name: '送出回答' }).click();
    expect((await calls(page))[1]).toEqual({ type: 'prompt', sessionId: 'reply', text: '繼續' });
  });

  test('危險指令同樣要按兩次', async ({ page }) => {
    await open(page, 'inbox', inboxSeed());
    const item = page.getByTestId('inbox-a-dng');
    await expect(item.getByRole('alert')).toContainText('⛔');
    await item.getByRole('button', { name: '允許一次' }).click();
    await expect(item.locator('.armed .command')).toHaveText(DANGER_CMD);
    await page.waitForTimeout(400);
    expect(await calls(page)).toEqual([]);
    await item.getByRole('button', { name: '再按一次確認' }).click();
    await expect(item).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'a-dng', decision: { behavior: 'allow', remember: false } },
    ]);
  });

  test('載入、空的、錯誤、資料過期', async ({ page }) => {
    await open(page, 'inbox', {
      patch: patchBackend('listProjects', `() => new Promise(() => {})`),
    });
    await expect(page.locator('[data-state=loading]')).toBeVisible();

    await open(page, 'inbox', { sessions: [], approvals: [] });
    await expect(page.locator('.waiting.none')).toHaveText('沒有等你的');
    await expect(page.locator('[data-state=empty]')).toContainText('回電腦處理');

    await open(page, 'inbox', {
      patch: patchBackend('listProjects', `async () => { throw new Error('down'); }`),
    });
    await expect(page.locator('[data-state=error]')).toContainText('讀不到專案清單：down');

    await open(page, 'inbox', { ...inboxSeed(), connected: false });
    await expect(page.locator('.stale-line')).toBeVisible();
    await expect(
      page.getByTestId('inbox-a-perm').getByRole('button', { name: '允許一次' }),
    ).toBeDisabled();
  });

  test('PWA manifest 與圖示內容齊全', async () => {
    const dir = join(flowsDir, 'pwa');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };
    expect(manifest.start_url).toBe('/#/inbox');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i) => i.purpose)).toContain('maskable');
    for (const icon of manifest.icons) {
      const png = readFileSync(join(dir, icon.src));
      const size = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(size).toBe(icon.sizes);
    }
    expect(existsSync(join(dir, 'apple-touch-icon.png'))).toBe(true);
  });
});

test.describe('新增 session', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

  const newSeed = (): Seed => ({
    machines: [rigA, rigGpu, rigOff],
    sessions: [
      session({ id: 's1', name: '已有的', machineId: 'm-a', cwd: '/work/api', status: 'running' }),
      session({
        id: 's2',
        name: '舊對話',
        machineId: 'm-g',
        cwd: '/x',
        status: 'done',
        claudeSessionId: 'old-conv',
        contextTokens: 150_000,
      }),
    ],
    approvals: [],
  });

  const preview = (page: Page) => page.getByTestId('command-preview');

  test('右側即時預覽實際指令', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByLabel('名稱').fill('Fix login');
    await page.getByLabel('工作目錄').fill('/work/web');
    await expect(preview(page)).toHaveText(
      "cd /work/web\nclaude --session-id <uuid> --name 'Fix login'",
    );
    await page.getByLabel('模型').fill('opus');
    await page.getByLabel('帳號').fill('/home/me/.claude-b');
    await page.getByRole('radio', { name: /acceptEdits/ }).check();
    await page.getByLabel('接續舊對話').fill('old-conv');
    await page.getByLabel('第一個指令').fill('run tests');
    await expect(preview(page)).toHaveText(
      "cd /work/web\nCLAUDE_CONFIG_DIR=/home/me/.claude-b claude --resume old-conv --permission-mode acceptEdits --model opus --name 'Fix login'",
    );
    await expect(page.locator('aside').getByText('run tests')).toBeVisible();
    await expect(page.getByTestId('quota-warnings')).toContainText('150k tokens');
  });

  test('任務類型建議機器：GPU 任務選有 GPU 的；沒有就照實說', async ({ page }) => {
    await open(page, 'new', newSeed());
    const pick = page.getByLabel('機器', { exact: true });
    await page.locator('.segmented label', { hasText: 'GPU 任務' }).click();
    await expect(page.getByTestId('machine-suggestion')).toContainText(
      '建議 rig-gpu：有 GPU（Test GPU）',
    );
    await expect(pick).toHaveValue('m-g');
    await page.getByLabel('機器', { exact: true }).selectOption('m-a');
    await expect(page.getByRole('button', { name: '改用 rig-gpu' })).toBeVisible();
    await page.getByRole('button', { name: '改用 rig-gpu' }).click();
    await expect(pick).toHaveValue('m-g');
    await expect(page.locator('option[value=m-off]')).toBeDisabled();

    await open(page, 'new', { ...newSeed(), machines: [rigA] });
    await page.locator('.segmented label', { hasText: 'GPU 任務' }).click();
    await expect(page.getByTestId('machine-suggestion')).toContainText('沒有上線且有 GPU 的機器');
  });

  test('同資料夾已有 session：worktree 預設打開並提示，使用者可關', async ({ page }) => {
    await open(page, 'new', newSeed());
    const toggle = page.getByLabel('使用 worktree');
    await page.getByLabel('機器', { exact: true }).selectOption('m-a');
    await page.getByLabel('工作目錄').fill('/work/other');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('worktree-hint')).toHaveCount(0);
    await page.getByLabel('工作目錄').fill('/work/api');
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('worktree-hint')).toContainText('已有 1 個 session（已有的）');
    await expect(preview(page)).toContainText(
      'git worktree add /work/api/../.agent-board-wt/<slug> -b ab/<slug>',
    );
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect(preview(page)).not.toContainText('git worktree');
  });

  test('bypassPermissions 紅框警示，預覽也看得到', async ({ page }) => {
    await open(page, 'new', newSeed());
    await expect(page.getByTestId('bypass-alert')).toHaveCount(0);
    await page.getByRole('radio', { name: /略過權限/ }).check();
    await expect(page.getByTestId('bypass-alert')).toContainText('略過權限');
    await expect(page.locator('aside .chip.bypass')).toHaveText('略過權限');
    await expect(preview(page)).toContainText('--permission-mode bypassPermissions');
    const border = await page
      .locator('.modes-bypass')
      .evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border).toBe('rgb(240, 102, 95)');
    const asideBorder = await page
      .locator('aside')
      .evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(asideBorder).toBe('rgb(240, 102, 95)');
    expect(await findGreenOutsideDiff(page)).toEqual([]);
  });

  test('瀏覽遠端資料夾', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByLabel('工作目錄').fill('/home/me');
    await page.getByRole('button', { name: '瀏覽' }).click();
    const browser = page.getByTestId('folder-browser');
    await expect(browser.getByText('git')).toBeVisible();
    await browser.getByRole('button', { name: 'project' }).click();
    await expect(browser.locator('.callsign')).toContainText('/home/me/project');
    await browser.getByRole('button', { name: '上一層' }).click();
    await expect(browser.locator('.callsign')).toContainText('/home/me');
    await browser.getByRole('button', { name: 'notes' }).click();
    await browser.getByRole('button', { name: '選這個資料夾' }).click();
    await expect(page.getByLabel('工作目錄')).toHaveValue('/home/me/notes');
    await expect(browser).toHaveCount(0);

    await open(page, 'new', {
      ...newSeed(),
      patch: patchBackend('browseDirectory', `async () => { throw new Error('no access'); }`),
    });
    await page.getByLabel('工作目錄').fill('/secret');
    await page.getByRole('button', { name: '瀏覽' }).click();
    await expect(page.getByTestId('folder-browser').locator('[data-state=error]')).toContainText(
      '讀不到 /secret：no access',
    );
  });

  test('缺欄位不可建立；建立送出完整內容，清掉名稱防重複', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByRole('button', { name: '建立 session' }).click();
    await expect(page.locator('form .acts .msg.err')).toHaveText('要填名稱');
    expect(await calls(page)).toEqual([]);
    await page.getByLabel('名稱').fill('Fix');
    await page.getByLabel('機器', { exact: true }).selectOption('m-g');
    await page.getByLabel('工作目錄').fill('/work/web');
    await page.getByLabel('帳號').fill('relative/path');
    await page.getByRole('button', { name: '建立 session' }).click();
    await expect(page.locator('form .acts .msg.err')).toHaveText('帳號要填絕對路徑');
    await page.getByLabel('帳號').fill('');
    await page.getByLabel('第一個指令').fill('hello');
    await page.getByRole('button', { name: '建立 session' }).click();
    await expect(page.locator('form .acts .msg')).toContainText('已建立 Fix');
    await expect(page.getByLabel('名稱')).toHaveValue('');
    expect(await calls(page)).toEqual([
      {
        type: 'create',
        input: {
          name: 'Fix',
          machineId: 'm-g',
          projectId: null,
          cwd: '/work/web',
          useWorktree: false,
          permissionMode: 'default',
          model: null,
          accountProfile: null,
          resumeClaudeSessionId: null,
          firstPrompt: 'hello',
        },
      },
    ]);
  });

  test('存成範本後可以套用', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByLabel('機器', { exact: true }).selectOption('m-g');
    await page.getByLabel('工作目錄').fill('/work/tpl');
    await page.getByLabel('模型').fill('sonnet');
    await page.getByRole('radio', { name: /^plan/ }).check();
    await page.getByRole('button', { name: '存成範本' }).click();
    await expect(page.locator('.template-save .msg')).toHaveText('要填範本名稱才能存');
    await page.getByLabel('存成範本').fill('我的範本');
    await page.getByRole('button', { name: '存成範本' }).click();
    await expect(page.locator('.template-save .msg')).toHaveText('已存成範本 我的範本');

    await page.getByLabel('工作目錄').fill('/other');
    await page.getByLabel('模型').fill('');
    await page.getByRole('radio', { name: /^default/ }).check();
    await page.getByLabel('機器', { exact: true }).selectOption('m-a');
    await page.getByLabel('範本', { exact: true }).selectOption({ label: '我的範本' });
    await expect(page.getByLabel('工作目錄')).toHaveValue('/work/tpl');
    await expect(page.getByLabel('模型')).toHaveValue('sonnet');
    await expect(page.getByLabel('機器', { exact: true })).toHaveValue('m-g');
    await expect(page.getByRole('radio', { name: /^plan/ })).toBeChecked();
  });

  test('額度警告：超過上限會排隊、同帳號額度用完、沒設禁讀路徑', async ({ page }) => {
    await open(page, 'new', {
      ...newSeed(),
      sessions: [
        session({ id: 's1', name: 'a', machineId: 'm-a', cwd: '/a', status: 'running' }),
        session({ id: 's2', name: 'b', machineId: 'm-a', cwd: '/b', status: 'rate_limited' }),
      ],
      patch: `backend.getSettings = async () => ({ listenAddress: '127.0.0.1', publicOrigin: null,
        stuckMinutes: 10, dangerRules: [], notifications: { enabled: true, quietHours: null },
        quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 1 } });`,
    });
    const warnings = page.getByTestId('quota-warnings');
    await expect(warnings).toContainText('已有 1 個 session 在跑，上限 1');
    await expect(warnings).toContainText('同帳號已有 1 個 session 額度用完');
    await expect(warnings).toContainText('沒有設定禁讀路徑');
    const color = await warnings
      .locator('li')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(229, 139, 224)');
  });

  test('使用者輸入照 shell 規則引號，不會看起來像重導向', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByLabel('名稱').fill('a>b');
    await page.getByLabel('工作目錄').fill('/work/my repo');
    await expect(preview(page)).toHaveText(
      "cd '/work/my repo'\nclaude --session-id <uuid> --name 'a>b'",
    );
  });

  test('載入、空的、錯誤、資料過期', async ({ page }) => {
    await open(page, 'new', {
      ...newSeed(),
      patch: patchBackend('getSettings', `() => new Promise(() => {})`),
    });
    await expect(page.getByTestId('quota-warnings').locator('[data-state=loading]')).toBeVisible();

    await open(page, 'new', { machines: [], sessions: [], approvals: [] });
    await expect(page.locator('[data-state=empty]')).toContainText('還沒有機器');
    await expect(page.locator('[data-state=empty]').getByRole('link')).toHaveAttribute(
      'href',
      '#/settings',
    );

    await open(page, 'new', {
      ...newSeed(),
      patch: `backend.listTemplates = async () => { throw new Error('down'); };
              backend.getSettings = async () => { throw new Error('403'); };`,
    });
    await expect(page.locator('[data-state=error]')).toContainText('讀不到範本：down');
    await expect(page.getByTestId('quota-warnings')).toContainText('讀不到省額度設定');

    await open(page, 'new', { ...newSeed(), connected: false });
    await expect(page.locator('.stale-line')).toBeVisible();
    await expect(page.getByRole('button', { name: '建立 session' })).toBeDisabled();
  });
});

test.describe('設定', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });

  test('監聽位址不可輸入 0.0.0.0／::，也不能存', async ({ page }) => {
    await open(page, 'settings');
    const input = page.getByLabel('監聽位址');
    await expect(input).toHaveValue('127.0.0.1');
    const save = page.getByRole('button', { name: '儲存設定' });
    for (const bad of ['0.0.0.0', '::', '[::]', '::0', '0:0:0:0:0:0:0:0', '000.000.000.000']) {
      await input.fill(bad);
      await expect(page.getByTestId('listen-error')).toContainText('不可以綁定所有網卡');
      await save.click();
      await expect(page.getByTestId('save-bar').locator('.msg.err')).toContainText('先修正');
    }
    await input.fill('0.0.0.0:8787');
    await expect(page.getByTestId('listen-error')).toContainText('不是 IP 位址');
    await input.fill('[::1]');
    await expect(page.getByTestId('listen-error')).toContainText('不是 IP 位址');
    await input.fill('999.1.1.1');
    await expect(page.getByTestId('listen-error')).toContainText('不是 IP 位址');
    expect(await calls(page)).toEqual([]);
    await input.fill('100.64.0.1');
    await expect(page.getByTestId('listen-error')).toHaveCount(0);
    await save.click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    expect(await calls(page)).toEqual([
      { type: 'settings', patch: { listenAddress: '100.64.0.1' } },
    ]);
  });

  test('未存檔亮提示，還原或儲存後消失', async ({ page }) => {
    await open(page, 'settings');
    const bar = page.getByTestId('save-bar');
    await expect(bar).toContainText('都已存檔');
    await expect(page.getByRole('button', { name: '儲存設定' })).toBeDisabled();

    await page.getByLabel('同時執行的 session 上限').fill('3');
    await expect(page.locator('#s-quota .chip.unsaved')).toHaveText('未存檔');
    await expect(bar).toContainText('1 項未存檔');
    await page.getByRole('button', { name: '還原' }).click();
    await expect(page.locator('#s-quota .chip.unsaved')).toHaveCount(0);
    await expect(page.getByLabel('同時執行的 session 上限')).toHaveValue('');

    await page.getByLabel('同時執行的 session 上限').fill('3');
    await page.getByLabel('勿擾時段').check();
    await expect(bar).toContainText('2 項未存檔');
    await page.getByLabel('開始').fill('');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(bar.locator('.msg.err')).toContainText('先修正');
    await expect(page.locator('#s-notify')).toContainText('勿擾時段要填開始與結束時間');
    expect(await calls(page)).toEqual([]);
    await page.getByLabel('開始').fill('23:00');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(bar).toContainText('都已存檔');
    await expect(bar.locator('.msg')).toHaveText('已儲存');
    const patch = ((await calls(page))[0] as { patch: Record<string, unknown> }).patch;
    expect(Object.keys(patch).sort()).toEqual(['notifications', 'quotaGuards']);
  });

  test('危險指令清單：新增、去重、移除、清空警告', async ({ page }) => {
    await open(page, 'settings');
    const rules = page.getByTestId('danger-rules');
    await expect(rules.locator('li')).toHaveCount(3);
    const input = page.getByLabel('新增規則，例如 git push --force');
    await input.fill('git   push  --force');
    await page.getByRole('button', { name: '新增規則' }).click();
    await expect(page.locator('#s-security .msg.err')).toHaveText('這條規則已經在清單裡');
    await input.fill('drop database');
    await page.getByRole('button', { name: '新增規則' }).click();
    await expect(rules.locator('li')).toHaveCount(4);
    for (const rule of ['rm -rf /', 'git push --force', 'git reset --hard', 'drop database']) {
      await page.getByRole('button', { name: `移除規則 ${rule}` }).click();
    }
    await expect(page.locator('#s-security')).toContainText('不會攔下任何指令');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    expect(await calls(page)).toEqual([{ type: 'settings', patch: { dangerRules: [] } }]);
  });

  test('機器：配對碼，移除要按兩次', async ({ page }) => {
    await open(page, 'settings', { machines: [rigA, rigOff], sessions: [], approvals: [] });
    await page.getByRole('button', { name: '產生配對碼' }).click();
    await expect(page.getByTestId('pair-command')).toHaveText('agent-board-daemon pair DEMO-0000');
    await expect(page.locator('#s-machines')).toContainText('配對碼 DEMO-0000');
    // 產生後按鈕從主按鈕退回次要樣式，字與底要對比得起來。
    await page.mouse.move(0, 0);
    await expect(page.getByRole('button', { name: '重新產生' })).toHaveCSS(
      'background-color',
      'rgb(27, 33, 43)',
    );

    const row = page.getByTestId('machine-m-off');
    await expect(row).toContainText('最後讀到');
    await row.getByRole('button', { name: '移除' }).click();
    await expect(row.getByRole('button', { name: '再按一次移除' })).toBeVisible();
    await expect(row.locator('.msg')).toContainText('撤銷這台的 token');
    await page.waitForTimeout(400);
    expect(await calls(page)).toEqual([]);
    await row.getByRole('button', { name: '再按一次移除' }).click();
    await expect.poll(() => calls(page)).toEqual([{ type: 'removeMachine', id: 'm-off' }]);
  });

  test('使用者與範本：後端沒開放時照實說；開放後可用', async ({ page }) => {
    await open(page, 'settings');
    await expect(page.locator('#s-users')).toContainText('demo');
    await expect(page.getByTestId('users-unavailable')).toBeVisible();
    await expect(page.locator('#s-templates [data-state=empty]')).toContainText('還沒有範本');

    await open(page, 'settings', {
      patch: `const users = [{ id: 'u-demo', name: 'demo', role: 'owner', locale: 'zh-TW' },
                             { id: 'u2', name: 'pat', role: 'member', locale: 'en' }];
        backend.listUsers = async () => users.slice();
        backend.createUser = async (u) => { const x = { ...u, id: 'u3' }; users.push(x); return x; };
        backend.deleteUser = async (id) => { users.splice(users.findIndex((x) => x.id === id), 1); };`,
    });
    const box = page.locator('#s-users');
    await expect(box).toContainText('pat');
    await box.getByLabel('名稱').fill('sam');
    await box.getByLabel('密碼').fill('short');
    await box.getByRole('button', { name: '新增使用者' }).click();
    await expect(box.locator('.add-user .msg.err')).toHaveText('密碼至少要 8 個字元');
    await box.getByLabel('密碼').fill('long-enough');
    await box.getByRole('button', { name: '新增使用者' }).click();
    await expect(box.locator('.rows')).toContainText('sam');
    const pat = box.locator('.rows .rig-row', { hasText: 'pat' });
    await pat.getByRole('button', { name: '移除' }).click();
    await expect(box.locator('.rows')).toContainText('pat');
    await page.waitForTimeout(400);
    await pat.getByRole('button', { name: '再按一次移除' }).click();
    await expect(box.locator('.rows')).not.toContainText('pat');
  });

  test('語言切換即時生效，重新整理還記得，跟隨瀏覽器可復原', async ({ page }) => {
    await open(page, 'settings');
    await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible();
    await page.locator('.segmented label', { hasText: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await page.locator('.segmented label', { hasText: 'Follow browser' }).click();
    await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-Hant');
  });

  test('載入、錯誤、存檔失敗、資料過期', async ({ page }) => {
    await open(page, 'settings', {
      patch: patchBackend('getSettings', `() => new Promise(() => {})`),
    });
    await expect(page.locator('.settings-col [data-state=loading]').first()).toBeVisible();

    await open(page, 'settings', {
      patch: `let n = 0; const ok = backend.getSettings;
        backend.getSettings = async () => { if (n++ < 2) throw new Error('403'); return ok(); };`,
    });
    const box = page.locator('.settings-col [data-state=error]');
    await expect(box).toContainText('讀不到設定：403');
    await box.getByRole('button', { name: '重試' }).click();
    await expect(page.getByLabel('監聽位址')).toHaveValue('127.0.0.1');

    await open(page, 'settings', {
      patch: patchBackend('updateSettings', `async () => { throw new Error('boom'); }`),
    });
    await page.getByLabel('監聽位址').fill('10.0.0.1');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg.err')).toContainText('存不了：boom');
    await expect(page.getByTestId('save-bar')).toContainText('1 項未存檔');

    await open(page, 'settings', { connected: false });
    await expect(page.locator('.stale-line')).toBeVisible();
    await expect(page.getByRole('button', { name: '產生配對碼' })).toBeDisabled();
  });
});

test.describe('首次引導', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 390, height: 800 } });

  const blank = (patch = ''): Seed => ({
    machines: [],
    sessions: [],
    approvals: [],
    patch: `backend.needsSetup = async () => true; ${patch}`,
  });

  test('建立管理員 → 配對 → 機器連上 → 開第一個 session，全程沒有範例資料', async ({ page }) => {
    await open(page, 'onboarding', {
      ...blank(`const setup = backend.setup;
        backend.setup = async (input) => { window.__setup = input; return setup(input); };
        backend.createPairingCode = async () => ({ code: 'ZZ-1',
          expiresAt: new Date(Date.now() + 60000).toISOString(), installCommand: 'run-pair ZZ-1' });`),
    });
    await expect(page.locator('body')).not.toContainText('demo');
    await expect(page.locator('.stepper li.on')).toContainText('建立管理員');

    await page.getByLabel('名稱').fill('admin');
    await page.getByLabel('密碼', { exact: true }).fill('short');
    await page.getByRole('button', { name: '建立管理員' }).click();
    await expect(page.locator('.msg.err')).toHaveText('密碼至少要 8 個字元');
    await page.getByLabel('密碼', { exact: true }).fill('long-enough');
    await page.getByLabel('再輸入一次密碼').fill('different');
    await page.getByRole('button', { name: '建立管理員' }).click();
    await expect(page.locator('.msg.err')).toHaveText('兩次密碼不一樣');
    await page.getByLabel('再輸入一次密碼').fill('long-enough');
    await page.getByRole('button', { name: '建立管理員' }).click();

    await expect(page.locator('.stepper li.on')).toContainText('加入第一台機器');
    expect(await page.evaluate(() => (window as unknown as { __setup: unknown }).__setup)).toEqual({
      name: 'admin',
      password: 'long-enough',
      locale: 'zh-TW',
    });
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
    await expect(page.getByTestId('machine-waiting')).toBeVisible();
    await page.getByRole('button', { name: '產生配對碼' }).click();
    await expect(page.getByTestId('pair-command')).toHaveText('run-pair ZZ-1');
    await expect(page.locator('body')).not.toContainText('demo');

    await setBoard(page, { machines: [rigA] });
    await expect(page.getByTestId('machine-connected')).toContainText('rig-a 已上線');
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.locator('.stepper li.on')).toContainText('開第一個 session');
    await expect(page.getByRole('link', { name: '新增 session' })).toHaveAttribute('href', '#/new');
  });

  test('已有管理員時從機器開始；跳過機器會說明下一步', async ({ page }) => {
    await open(page, 'onboarding', { machines: [], sessions: [], approvals: [] });
    await expect(page.locator('.stepper li.on')).toContainText('加入第一台機器');
    await page.getByRole('button', { name: '稍後再加' }).click();
    await expect(page.getByRole('link', { name: '到設定配對機器' })).toHaveAttribute(
      'href',
      '#/settings',
    );
  });

  test('載入、錯誤、建立失敗、語言切換', async ({ page }) => {
    await open(page, 'onboarding', {
      patch: patchBackend('needsSetup', `() => new Promise(() => {})`),
    });
    await expect(page.locator('[data-state=loading]')).toBeVisible();

    await open(page, 'onboarding', {
      patch: `let n = 0; backend.needsSetup = async () => { if (n++ < 2) throw new Error('refused'); return true; };`,
    });
    const box = page.locator('[data-state=error]');
    await expect(box).toContainText('連不到 hub：refused');
    await box.getByRole('button', { name: '重試' }).click();
    await expect(page.getByRole('button', { name: '建立管理員' })).toBeVisible();

    await open(
      page,
      'onboarding',
      blank(`backend.setup = async () => { throw new Error('taken'); };`),
    );
    await page.getByLabel('名稱').fill('admin');
    await page.getByLabel('密碼', { exact: true }).fill('long-enough');
    await page.getByLabel('再輸入一次密碼').fill('long-enough');
    await page.getByRole('button', { name: '建立管理員' }).click();
    await expect(page.locator('.msg.err')).toContainText('建立失敗：taken');
    await expect(page.getByLabel('名稱')).toHaveValue('admin');

    await page.locator('.segmented label', { hasText: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Get started with Agent Board' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create admin' })).toBeVisible();
  });
});

test.describe('語系與版面', () => {
  test('中英文 key 一致，程式用到的 key 都有定義', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const sources = walk(flowsDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
    const used = sources.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/'(flows\.[\w.]+)'/g)].map((m) => m[1] as string),
    );
    expect(used.length).toBeGreaterThan(100);
    const missing = used.filter((key) => !(key in en) && !key.endsWith('.'));
    expect(missing).toEqual([]);
    for (const [key, value] of Object.entries(zhTW)) {
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(en[key] ?? ''), key).toEqual(vars(value));
    }
  });

  const rich = (): Seed => ({
    machines: [
      rigA,
      rigGpu,
      machine({ id: 'm-off', name: 'rig-off-with-a-rather-long-machine-name', online: false }),
    ],
    sessions: [
      session({
        id: 's1',
        name: 'A session with quite a long descriptive name for wrapping',
        machineId: 'm-a',
        cwd: '/home/someone/projects/a-really-long-repository-name-goes-here',
        branch: 'ab/feature/an-extremely-long-branch-name-that-cannot-wrap-at-spaces',
      }),
      session({
        id: 's2',
        name: 'Danger',
        machineId: 'm-g',
        status: 'running',
        permissionMode: 'bypassPermissions',
      }),
      session({
        id: 's3',
        name: 'Plan',
        machineId: 'm-g',
        status: 'plan_review',
        permissionMode: 'plan',
      }),
      session({ id: 's4', name: 'Ask', machineId: 'm-a', status: 'waiting_input' }),
      session({ id: 's5', name: 'Err', machineId: 'm-a', status: 'error' }),
      session({
        id: 's6',
        name: 'Off',
        machineId: 'm-off',
        status: 'offline',
        permissionMode: 'acceptEdits',
      }),
    ],
    approvals: [
      approval({
        id: 'a1',
        sessionId: 's1',
        toolName: 'Edit',
        toolInput: {
          file_path: '/home/someone/projects/a-really-long-repository-name-goes-here/src/x.ts',
          old_string: `const aVeryLongLineOfCode = ${'"x".repeat(100); '.repeat(5)}`,
          new_string: `const aVeryLongLineOfCode = ${'"y".repeat(200); '.repeat(5)}\nnext();`,
        },
        suggestions: [{ type: 'addRules' }],
      }),
      approval({
        id: 'a2',
        sessionId: 's2',
        kind: 'danger',
        toolInput: { command: `git push --force ${'origin/some-very-long-ref-name-'.repeat(6)}` },
        matchedRule: 'git push --force',
      }),
      approval({
        id: 'a3',
        sessionId: 's3',
        kind: 'plan',
        toolName: null,
        toolInput: { plan: '1. Step one\n2. Step two' },
      }),
      approval({
        id: 'a4',
        sessionId: 's4',
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              question: 'Which of these options do you prefer for the README language?',
              options: [
                { label: 'Traditional Chinese with English summary' },
                { label: 'English' },
              ],
            },
          ],
        },
      }),
    ],
  });

  const shot = (info: TestInfo, name: string) =>
    join(info.project.outputDir, 'shots', `${name}.png`);

  for (const locale of ['zh-TW', 'en-US']) {
    test.describe(locale, () => {
      test.use({ locale });
      for (const width of [320, 375, 1280]) {
        test(`${width}px 五個畫面都沒有整頁水平捲軸、沒有裸 key、沒有綠色`, async ({
          page,
        }, info) => {
          await page.setViewportSize({ width, height: 800 });
          const routes = ['review', 'inbox', 'new', 'settings', 'onboarding'];
          for (const route of routes) {
            await open(page, route, {
              ...rich(),
              patch: route === 'onboarding' ? `backend.needsSetup = async () => true;` : undefined,
            });
            await page.waitForSelector('.flows main h1');
            if (route === 'new') {
              await page
                .getByLabel(/名稱|Name/)
                .first()
                .fill('A long name for the command');
              await page
                .getByLabel(/工作目錄|Working directory/)
                .fill('/home/someone/projects/a-really-long-repository-name-goes-here/sub');
              await page.getByRole('radio', { name: /略過權限|Bypass permissions/ }).check();
              await page.getByRole('button', { name: /^(瀏覽|Browse)$/ }).click();
              await page.getByTestId('folder-browser').getByRole('button').first().waitFor();
            }
            if (route === 'settings') {
              await page.getByRole('button', { name: /產生配對碼|Create pairing code/ }).click();
              await page.getByTestId('pair-command').waitFor();
              await page.getByLabel(/監聽位址|Listen address/).fill('0.0.0.0');
            }
            await expectNoPageOverflow(page);
            const text = (await page.locator('.flows').innerText()) ?? '';
            expect(text).not.toMatch(/flows\.[a-z]/);
            expect(await findGreenOutsideDiff(page)).toEqual([]);
            await page.screenshot({
              path: shot(info, `${route}-${locale}-${width}`),
              fullPage: true,
            });
          }
        });
      }
    });
  }

  test.describe('英文固定用詞', () => {
    test.use({ locale: 'en-US' });
    test('審核卡用 STYLE.md §6 的詞', async ({ page }) => {
      await open(page, 'review', rich());
      const card = page.getByTestId('review-a1');
      await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Always allow' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible();
      const plan = page.getByTestId('review-a3');
      await expect(plan.getByRole('button', { name: 'Approve plan' })).toBeVisible();
      await expect(plan.getByRole('button', { name: 'Request changes' })).toBeVisible();
      await expect(page.getByTestId('review-a2').locator('.chip.bypass')).toHaveText(
        'Bypass permissions',
      );
    });
  });
});
