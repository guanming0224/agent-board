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
const rigGpu = machine({
  id: 'm-g',
  name: 'rig-gpu',
  capabilities: { ...rigA.capabilities, hasGpu: true, gpuName: 'Test GPU' },
});
const rigOff = machine({ id: 'm-off', name: 'rig-off', online: false, lastSeenAt: minutesAgo(40) });

/** Claude 對話 id 必須是 UUID（protocol 的 ClaudeSessionId）。 */
const OLD_CONV = '5a1f0c2e-7b3d-4e8f-9a6b-1c2d3e4f5a6b';

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
  // 登入頁的路由由 Lead 接在 App.tsx，這裡用 harness 直接掛 flows 匯出的 LoginPage。
  await page.goto(route === 'login' ? '/e2e/flows-harness.html?demo=1' : '/?demo=1#/canvas');
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
  if (route === 'login') {
    await page.evaluate(() => (window as unknown as { __mount(): void }).__mount());
    return;
  }
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
      decision: { behavior: 'answer', text: 'en' },
    });
    expect(recorded[1]).toEqual({ type: 'prompt', sessionId: 's2', text: '沒有了' });
  });

  test('危險指令只有 owner 能決定：member 看得到卡片但允許與拒絕都停用', async ({ page }) => {
    const member = `backend.currentUser = async () => ({ id: 'u2', name: 'pat', role: 'member', locale: 'zh-TW' });`;
    await open(page, 'review', { ...dangerSeed(), patch: member });
    const card = page.getByTestId('review-d1');
    await expect(card.locator('.command')).toHaveText(DANGER_CMD);
    await expect(card).toContainText('只有管理員能決定這個');
    await expect(card.getByRole('button', { name: '允許一次' })).toBeDisabled();
    await expect(card.getByRole('button', { name: '拒絕' })).toBeDisabled();
    await expect(card.getByLabel('拒絕原因（必填）')).toHaveCount(0);
    // 一般權限請求 member 照常能決定。
    const normal = page.getByTestId('review-old');
    await normal.getByRole('button', { name: '允許一次' }).click();
    await expect(normal).toHaveCount(0);
    expect(await calls(page)).toHaveLength(1);

    await open(page, 'review', {
      ...dangerSeed(),
      patch: `backend.currentUser = async () => { throw new Error('down'); };`,
    });
    const unknown = page.getByTestId('review-d1');
    await expect(unknown).toContainText('讀不到你的登入身分');
    await expect(unknown.getByRole('button', { name: '允許一次' })).toBeDisabled();

    await open(page, 'review', {
      ...dangerSeed(),
      patch: patchBackend('currentUser', `() => new Promise(() => {})`),
    });
    await expect(
      page.getByTestId('review-d1').getByRole('button', { name: '允許一次' }),
    ).toBeDisabled();
  });

  test('#/review/<sessionId>：捲到並聚焦那張卡；資料更新不搶焦點；沒有項目時說明', async ({
    page,
  }) => {
    const many: Seed = {
      machines: [rigA],
      sessions: Array.from({ length: 8 }, (_, i) =>
        session({ id: `s${i}`, name: `S${i}`, machineId: 'm-a' }),
      ),
      approvals: Array.from({ length: 8 }, (_, i) =>
        approval({ id: `a${i}`, sessionId: `s${i}`, createdAt: minutesAgo(20 - i) }),
      ),
    };
    await page.setViewportSize({ width: 800, height: 500 });
    await open(page, 'review/s7', many);
    const card = page.getByTestId('review-a7');
    await expect(card).toBeFocused();
    await expect(card).toBeInViewport();
    await expect(card).toHaveClass(/targeted/);

    const other = page.getByTestId('review-a6').getByLabel('拒絕原因（必填）');
    await other.focus();
    await setBoard(page, { machines: [{ ...rigA }] });
    await expect(other).toBeFocused();

    await page.evaluate(() => {
      location.hash = '#/review/s0';
    });
    const first = page.getByTestId('review-a0');
    await expect(first).toBeFocused();
    await expect(first).toBeInViewport();
    await expect(card).not.toHaveClass(/targeted/);

    await page.evaluate(() => {
      location.hash = '#/review/nope';
    });
    await expect(page.getByTestId('review-target-missing')).toHaveText(
      '這個 session 目前沒有要審核的項目。',
    );
    await page.evaluate(() => {
      location.hash = '#/review';
    });
    await expect(page.getByTestId('review-target-missing')).toHaveCount(0);
  });

  test('審核中心沒有自己的「等你 N」', async ({ page }) => {
    await open(page, 'review');
    await expect(page.getByTestId('review-a-1')).toBeVisible();
    // App 頁首那一份不算，要驗的是審核中心頁面自己沒有。
    await expect(page.locator('.flows .waiting')).toHaveCount(0);
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

  test('#/inbox/<sessionId>（點推播通知進來）：捲到並標出那一項', async ({ page }) => {
    await open(page, 'inbox/reply', inboxSeed());
    const item = page.getByTestId('inbox-reply');
    await expect(item).toBeFocused();
    await expect(item).toBeInViewport();
    await expect(item).toHaveClass(/targeted/);
    await expect(page.locator('.inbox-item.targeted')).toHaveCount(1);

    // approval 也只帶 session id 就對得到。
    await page.evaluate(() => {
      location.hash = '#/inbox/plan';
    });
    await expect(page.getByTestId('inbox-a-plan')).toHaveClass(/targeted/);
    await expect(item).not.toHaveClass(/targeted/);
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

  test('member 的危險指令按鈕停用並說明', async ({ page }) => {
    await open(page, 'inbox', {
      ...inboxSeed(),
      patch: `backend.currentUser = async () => ({ id: 'u2', name: 'pat', role: 'member', locale: 'zh-TW' });`,
    });
    const item = page.getByTestId('inbox-a-dng');
    await expect(item).toContainText('只有管理員能決定這個');
    await expect(item.getByRole('button', { name: '允許一次' })).toBeDisabled();
    await expect(item.getByRole('button', { name: '拒絕' })).toBeDisabled();
    await expect(
      page.getByTestId('inbox-a-perm').getByRole('button', { name: '允許一次' }),
    ).toBeEnabled();
  });

  test('回答提問送 answer，不是拒絕', async ({ page }) => {
    await open(page, 'inbox', {
      machines: [rigA],
      sessions: [session({ id: 's1', name: 'Docs', machineId: 'm-a', status: 'waiting_input' })],
      approvals: [
        approval({
          id: 'q1',
          sessionId: 's1',
          kind: 'question',
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: 'Lang?', options: [{ label: 'zh' }] }] },
        }),
      ],
    });
    await page.getByTestId('inbox-q1').getByRole('button', { name: 'zh', exact: true }).click();
    await expect(page.getByTestId('inbox-q1')).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { type: 'decide', id: 'q1', decision: { behavior: 'answer', text: 'zh' } },
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
        claudeSessionId: OLD_CONV,
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
      "cd /work/web\nclaude --session-id <uuid> --permission-mode manual --name 'Fix login'",
    );
    await page.getByLabel('模型').fill('opus');
    await page.getByLabel('帳號').fill('/home/me/.claude-b');
    await page.getByRole('radio', { name: /acceptEdits/ }).check();
    await page.getByLabel('接續舊對話').fill(OLD_CONV);
    await page.getByLabel('第一個指令').fill('run tests');
    await expect(preview(page)).toHaveText(
      `cd /work/web\nCLAUDE_CONFIG_DIR=/home/me/.claude-b claude --resume ${OLD_CONV} --permission-mode acceptEdits --model opus --name 'Fix login'`,
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

  test('資料夾選擇器：從上一層開始、單擊選取、雙擊進入、麵包屑、列尾進入', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.locator('#ns-machine').selectOption('m-a');
    await page.getByLabel('工作目錄').fill('/home/me/project');
    await page.getByRole('button', { name: '瀏覽', exact: true }).click();
    const browser = page.getByTestId('folder-browser');
    const crumbs = browser.getByRole('navigation');
    const here = crumbs.locator('[aria-current]');
    const folder = (name: string) => browser.getByRole('button', { name, exact: true });
    // 工作目錄有值：從上一層開始，反白它
    await expect(here).toHaveText('me');
    await expect(folder('project')).toHaveAttribute('aria-pressed', 'true');
    await expect(browser.getByText('git')).toBeVisible();

    // 單擊 = 選取：立刻填入、名稱空的就帶資料夾名、不會進去
    await folder('notes').click();
    await expect(page.getByLabel('工作目錄')).toHaveValue('/home/me/notes');
    await expect(page.getByLabel('名稱')).toHaveValue('notes');
    await expect(browser.getByTestId('browser-selected')).toContainText('/home/me/notes');
    await expect(here).toHaveText('me');
    // 換選：自動帶入的名稱跟著換
    await folder('project').click();
    await expect(page.getByLabel('名稱')).toHaveValue('project');

    // 雙擊 = 進入
    await folder('project').dblclick();
    await expect(here).toHaveText('project');
    // 麵包屑每一段都能點
    await expect(crumbs).toContainText('rig-a:');
    await crumbs.getByRole('button', { name: 'home', exact: true }).click();
    await expect(here).toHaveText('home');
    await crumbs.getByRole('button', { name: '/', exact: true }).click();
    await expect(here).toHaveText('/');
    await expect(browser.getByRole('button', { name: '上一層' })).toBeDisabled();
    // 列尾 › 進入
    await browser.getByRole('button', { name: '進入 notes' }).click();
    await expect(here).toHaveText('notes');

    // 使用者自己打的名稱不會被換掉
    await page.getByLabel('名稱').fill('我的名稱');
    await folder('project').click();
    await expect(page.getByLabel('名稱')).toHaveValue('我的名稱');
    await expect(page.getByLabel('工作目錄')).toHaveValue('/notes/project');

    // 「選這個資料夾」選目前所在的資料夾並關閉
    await browser.getByRole('button', { name: '選這個資料夾' }).click();
    await expect(page.getByLabel('工作目錄')).toHaveValue('/notes');
    await expect(browser).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  });

  test('資料夾選擇器：鍵盤、篩選、最近用過、家目錄、從桌面開始、自訂起始位置', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.locator('#ns-machine').selectOption('m-a');
    await page.getByRole('button', { name: '瀏覽', exact: true }).click();
    const browser = page.getByTestId('folder-browser');
    const here = browser.getByRole('navigation').locator('[aria-current]');
    const folder = (name: string) => browser.getByRole('button', { name, exact: true });
    // 沒填工作目錄、沒設起始位置：從桌面開始，什麼都沒選
    await expect(here).toHaveText('Desktop');
    await expect(browser.getByTestId('browser-start')).toContainText('桌面（預設）');
    await expect(browser.getByTestId('browser-selected')).toContainText('還沒選');

    // 鍵盤：↓ 移動、空白鍵選取、Enter 進入、← 回上一層
    await folder('project').focus();
    await page.keyboard.press('ArrowDown');
    await expect(folder('notes')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByLabel('工作目錄')).toHaveValue('~/Desktop/notes');
    await page.keyboard.press('Enter');
    await expect(here).toHaveText('notes');
    await expect(folder('project')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(here).toHaveText('Desktop');

    // 篩選：只留符合的；Enter 進入第一個符合的，不送出表單
    const filter = browser.getByRole('searchbox', { name: '篩選這一層的資料夾' });
    await filter.fill('NO');
    await expect(folder('notes')).toBeVisible();
    await expect(folder('project')).toHaveCount(0);
    await filter.fill('zzz');
    await expect(browser).toContainText('這一層沒有名稱含「zzz」的資料夾');
    await filter.fill('no');
    await filter.press('Enter');
    await expect(here).toHaveText('notes');
    await expect(filter).toHaveValue('');
    expect(await calls(page)).toEqual([]);

    // 最近用過：同一台機器的 session 資料夾；點了直接選取並移到那裡
    const recent = browser.getByTestId('recent-folder');
    await expect(recent).toHaveText(['api']);
    await recent.click();
    await expect(here).toHaveText('api');
    await expect(page.getByLabel('工作目錄')).toHaveValue('/work/api');
    await browser.getByRole('button', { name: '家目錄 ~' }).click();
    await expect(here).toHaveText('~');
    await expect(page.getByLabel('工作目錄')).toHaveValue('~');
    await browser.getByRole('button', { name: '桌面 ~/Desktop' }).click();
    await expect(here).toHaveText('Desktop');
    await expect(page.getByLabel('工作目錄')).toHaveValue('~/Desktop');

    // 把目前位置設為起始：下次打開從這裡開始；上次位置變成捷徑
    await recent.click();
    await expect(here).toHaveText('api');
    await browser.getByRole('button', { name: '把目前位置設為起始' }).click();
    await expect(browser.getByTestId('browser-start')).toContainText('/work/api');
    await browser.getByRole('button', { name: '關閉', exact: true }).click();
    await expect(browser).toHaveCount(0);
    await page.getByLabel('工作目錄').fill('');
    await page.getByRole('button', { name: '瀏覽', exact: true }).click();
    await expect(here).toHaveText('api');

    // 改回桌面：再打開從桌面開始，上次位置留在捷徑
    await browser.getByRole('button', { name: '家目錄 ~' }).click();
    await browser.getByRole('button', { name: '改回桌面' }).click();
    await expect(browser.getByTestId('browser-start')).toContainText('桌面（預設）');
    await browser.getByRole('button', { name: '關閉', exact: true }).click();
    await page.getByLabel('工作目錄').fill('');
    await page.getByRole('button', { name: '瀏覽', exact: true }).click();
    await expect(here).toHaveText('Desktop');
    await browser.getByRole('button', { name: '上次：~' }).click();
    await expect(here).toHaveText('~');
  });

  test('資料夾選擇器：Windows 機器用 \\；讀不到時寫原因', async ({ page }) => {
    const rigWin = machine({ id: 'm-w', name: 'rig-win', os: 'win32' });
    await open(page, 'new', { ...newSeed(), machines: [rigWin] });
    await page.getByLabel('工作目錄').fill('C:\\Users\\me\\proj');
    await page.getByRole('button', { name: '瀏覽', exact: true }).click();
    const browser = page.getByTestId('folder-browser');
    const crumbs = browser.getByRole('navigation');
    await expect(crumbs.getByRole('button')).toHaveText(['C:\\', 'Users', 'me']);
    await browser.getByRole('button', { name: 'project', exact: true }).click();
    await expect(page.getByLabel('工作目錄')).toHaveValue('C:\\Users\\me\\project');
    await crumbs.getByRole('button', { name: 'C:\\' }).click();
    await expect(crumbs.getByRole('button')).toHaveText(['C:\\']);

    await open(page, 'new', {
      ...newSeed(),
      patch: patchBackend('browseDirectory', `async () => { throw new Error('no access'); }`),
    });
    await page.getByLabel('工作目錄').fill('/secret/x');
    await page.getByRole('button', { name: '瀏覽', exact: true }).click();
    await expect(page.getByTestId('folder-browser').locator('[data-state=error]')).toContainText(
      '讀不到 /secret：no access',
    );
  });

  test('接續舊對話要是 UUID；同資料夾的 session 刪除中時說明', async ({ page }) => {
    await open(page, 'new', {
      ...newSeed(),
      patch: patchBackend(
        'createSession',
        `async () => { throw Object.assign(new Error('x'), { code: 'session_deleting' }); }`,
      ),
    });
    await page.getByLabel('名稱').fill('Fix');
    await page.getByLabel('工作目錄').fill('/work/api');
    const resume = page.getByLabel('接續舊對話');
    await resume.fill('old-conv');
    await expect(resume).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.field-error', { hasText: '格式是 UUID' })).toBeVisible();
    await page.getByRole('button', { name: '建立 session' }).click();
    await expect(page.locator('form .acts .msg.err')).toContainText('格式是 UUID');
    expect(await calls(page)).toEqual([]);

    await resume.fill(OLD_CONV.toUpperCase());
    await expect(resume).toHaveAttribute('aria-invalid', 'false');
    await page.getByRole('button', { name: '建立 session' }).click();
    await expect(page.locator('form .acts .msg.err')).toHaveText(
      '同一個資料夾（或 worktree）的 session 正在刪除，現在不能在這裡建立。稍後再試，內容都還在。',
    );
    await expect(page.getByLabel('名稱')).toHaveValue('Fix');
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
          readOnly: false,
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
    // 限流看的是同一台機器上的同帳號。
    await page.getByLabel('機器', { exact: true }).selectOption('m-a');
    await expect(warnings).toContainText('已有 1 個 session 在跑，上限 1');
    await expect(warnings).toContainText('同帳號已有 1 個 session 額度用完');
    await expect(warnings).toContainText('沒有設定禁讀路徑');
    const color = await warnings
      .locator('li')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(229, 139, 224)');
  });

  test('同 repo 不同子資料夾也建議 worktree；各自 worktree 的只告知，不預設打開', async ({
    page,
  }) => {
    const repo = { repoRoot: '/work/repo', repoCommonDir: '/work/repo/.git' };
    await open(page, 'new', {
      machines: [rigA],
      sessions: [
        session({ id: 's1', name: '後端', machineId: 'm-a', cwd: '/work/repo/api', ...repo }),
        session({
          id: 's3',
          name: '另一條分支',
          machineId: 'm-a',
          cwd: '/work/.agent-board-wt/x',
          worktreePath: '/work/.agent-board-wt/x',
          repoRoot: '/work/.agent-board-wt/x',
          repoCommonDir: '/work/repo/.git',
        }),
      ],
      approvals: [],
      // daemon 的資料夾瀏覽回報 repo；/work/repo 底下都是同一個 working tree。
      patch: `backend.browseDirectory = async (_m, path) => ({ path, entries: [],
        repo: path.startsWith('/work/repo') ? { root: '/work/repo', commonDir: '/work/repo/.git' } : null });`,
    });
    const toggle = page.getByLabel('使用 worktree');
    await page.getByLabel('工作目錄').fill('/work/repo/web');
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('worktree-hint')).toContainText(
      '同一個 repo 已有 1 個 session 在改檔案（後端）',
    );
    await expect(page.getByTestId('worktree-siblings')).toContainText(
      '另有 1 個 session 在各自的 worktree（另一條分支）',
    );
    await page.getByLabel('工作目錄').fill('/work/elsewhere');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('worktree-hint')).toHaveCount(0);
    await expect(page.getByTestId('worktree-siblings')).toHaveCount(0);
  });

  test('不是 git 的資料夾：同資料夾有人也不預設 worktree，勾選框停用並說明', async ({ page }) => {
    await open(page, 'new', {
      machines: [rigA],
      sessions: [session({ id: 's1', name: '筆記', machineId: 'm-a', cwd: '/plain' })],
      approvals: [],
      // daemon 確認不是 git 時 repo 回 null。
      patch: `backend.browseDirectory = async (_m, path) => ({ path, entries: [], repo: null });`,
    });
    const toggle = page.getByLabel('使用 worktree');
    await page.getByLabel('工作目錄').fill('/plain');
    await expect(page.getByTestId('worktree-not-git')).toContainText(
      '已有 1 個 session（筆記），但它不是 git repo',
    );
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(page.getByTestId('worktree-hint')).toHaveCount(0);
    await expect(preview(page)).not.toContainText('git worktree');
  });

  test('同帳號限流且設定會排隊：預覽說明會排隊；別台機器不算同帳號', async ({ page }) => {
    await open(page, 'new', {
      machines: [rigA, rigGpu],
      sessions: [
        session({ id: 's2', name: 'b', machineId: 'm-a', cwd: '/b', status: 'rate_limited' }),
      ],
      approvals: [],
      patch: `backend.getSettings = async () => ({ listenAddress: '127.0.0.1', publicOrigin: null,
        stuckMinutes: 10, dangerRules: [], notifications: { enabled: true, quietHours: null },
        quotaGuards: { denyReadPaths: ['data/'], maxConcurrentSessions: null, queueWhenRateLimited: true } });`,
    });
    const warnings = page.getByTestId('quota-warnings');
    await page.getByLabel('機器', { exact: true }).selectOption('m-a');
    await expect(warnings).toContainText('同帳號有 1 個 session 額度用完：這個會先排隊');
    await page.getByLabel('帳號').fill('/home/me/.claude-b');
    await expect(warnings).not.toContainText('額度用完');
    await page.getByLabel('帳號').fill('');
    await page.getByLabel('機器', { exact: true }).selectOption('m-g');
    await expect(warnings).not.toContainText('額度用完');
  });

  test('預覽靠上對齊表單，捲動時 sticky 跟著', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByLabel('名稱').fill('x');
    const top = (selector: string) =>
      page.locator(selector).evaluate((el) => el.getBoundingClientRect().top);
    await page.evaluate(() => scrollTo(0, 0));
    expect(await top('aside.preview')).toBe(await top('form.form-card'));
    await page.evaluate(() => scrollTo(0, 300));
    // 要停在 App 頁首下方，頁首本身不可以被捲走。
    const header = await page
      .locator('header')
      .first()
      .evaluate((el) => el.getBoundingClientRect());
    expect(header.top).toBe(0);
    await expect.poll(() => top('aside.preview')).toBeCloseTo(header.height + 12, 0);
  });

  test('使用者輸入照 shell 規則引號，不會看起來像重導向', async ({ page }) => {
    await open(page, 'new', newSeed());
    await page.getByLabel('名稱').fill('a>b');
    await page.getByLabel('工作目錄').fill('/work/my repo');
    await expect(preview(page)).toHaveText(
      "cd '/work/my repo'\nclaude --session-id <uuid> --permission-mode manual --name 'a>b'",
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
      '#/settings/machines',
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
    await open(page, 'settings/security');
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
    await open(page, 'settings/sessions');
    const bar = page.getByTestId('save-bar');
    await expect(bar).toContainText('都已存檔');
    await expect(page.getByRole('button', { name: '儲存設定' })).toBeDisabled();

    await page.getByLabel('同時執行的 session 上限').fill('3');
    await expect(page.locator('#s-quota .chip.unsaved')).toHaveText('未存檔');
    await expect(bar).toContainText('1 項未存檔');
    await bar.getByRole('button', { name: '還原' }).click();
    await expect(page.locator('#s-quota .chip.unsaved')).toHaveCount(0);
    await expect(page.getByLabel('同時執行的 session 上限')).toHaveValue('');

    await page.getByLabel('同時執行的 session 上限').fill('3');
    await page.getByRole('link', { name: '通知', exact: true }).click();
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

  test('帳號限流時排隊：預設打開，可以關掉並存檔', async ({ page }) => {
    await open(page, 'settings/sessions');
    const toggle = page.getByLabel('帳號額度用完時，新任務先排隊');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.locator('#s-quota .chip.unsaved')).toHaveText('未存檔');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    const patch = ((await calls(page))[0] as { patch: { quotaGuards: unknown } }).patch;
    expect(patch.quotaGuards).toMatchObject({ queueWhenRateLimited: false });
  });

  test('通知：合併通知預設開、寫出等多久；同時等你的上限 1–20', async ({ page }) => {
    await open(page, 'settings/notify');
    const coalesce = page.getByLabel('合併通知');
    await expect(coalesce).toBeChecked();
    await expect(page.getByTestId('notify-coalesce-hint')).toContainText(
      '先等 15 秒（權限請求 5 秒）',
    );
    await expect(page.getByTestId('notify-coalesce-hint')).toContainText('最多 60 秒');
    await coalesce.uncheck();
    await expect(page.getByTestId('notify-coalesce-hint')).toContainText('各自推播');

    const limit = page.getByLabel('同時等你的上限');
    await expect(limit).toHaveValue('3');
    for (const bad of ['0', '21', 'x']) {
      await limit.fill(bad);
      await expect(page.locator('#s-notify')).toContainText('請填 1–20 的整數');
    }
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg.err')).toContainText('先修正');
    expect(await calls(page)).toEqual([]);
    await limit.fill('5');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    const patch = ((await calls(page))[0] as { patch: { notifications: unknown } }).patch;
    expect(patch).toEqual({
      notifications: { enabled: true, quietHours: null, coalesce: false, waitingLimit: 5 },
    });
  });

  test('額度恢復後自動接續：預設關、標耗額度，打開後存檔', async ({ page }) => {
    await open(page, 'settings/sessions');
    const section = page.locator('#s-autocontinue');
    await expect(section.locator('.chip.cost')).toHaveText('◈ 耗額度');
    const toggle = section.getByTestId('auto-continue-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(section.locator('.chip.unsaved')).toHaveText('未存檔');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    expect(((await calls(page))[0] as { patch: unknown }).patch).toEqual({ autoContinue: true });
    // 舊連結 #/settings/autocontinue 也落到這一區。
    await open(page, 'settings/autocontinue');
    await expect(page.locator('#s-autocontinue')).toBeInViewport();
  });

  test('允許 session 派工：預設開、標耗額度，關掉後存檔只送這個鍵', async ({ page }) => {
    await open(page, 'settings/sessions');
    const section = page.locator('#s-dispatch');
    await expect(section).toContainText('允許 session 派工（MCP 工具）');
    await expect(section.locator('.chip.cost')).toHaveText('◈ 耗額度');
    await expect(section).toContainText('最多同時 4 個成員');
    const toggle = section.getByTestId('dispatch-toggle');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(section.locator('.chip.unsaved')).toHaveText('未存檔');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    expect(((await calls(page))[0] as { patch: unknown }).patch).toEqual({ dispatch: false });
    await open(page, 'settings/dispatch');
    await expect(page.locator('#s-dispatch')).toBeInViewport();
  });

  for (const width of [320, 375]) {
    test(`${width}px 通知與自動接續設定不撐出水平捲軸`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      for (const route of ['settings/notify', 'settings/autocontinue']) {
        await open(page, route);
        await expect(
          page.locator(route.endsWith('notify') ? '#s-notify' : '#s-autocontinue'),
        ).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, route).toBeLessThanOrEqual(0);
      }
    });
  }

  test('危險指令清單：新增、去重、移除、清空警告', async ({ page }) => {
    await open(page, 'settings/security');
    const rules = page.getByTestId('danger-rules');
    await expect(rules.locator('li')).toHaveCount(4);
    const input = page.getByLabel('新增規則，例如 git push --force');
    await input.fill('git   push  --force');
    await page.getByRole('button', { name: '新增規則' }).click();
    await expect(page.locator('#s-security .msg.err')).toHaveText('這條規則已經在清單裡');
    await input.fill('drop database');
    await page.getByRole('button', { name: '新增規則' }).click();
    await expect(rules.locator('li')).toHaveCount(5);
    for (const rule of [
      'rm -rf /',
      'rm -r /',
      'git push --force',
      'git reset --hard',
      'drop database',
    ]) {
      await page.getByRole('button', { name: `移除規則 ${rule}` }).click();
    }
    await expect(page.locator('#s-security')).toContainText('不會攔下任何指令');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    expect(await calls(page)).toEqual([{ type: 'settings', patch: { dangerRules: [] } }]);
  });

  test('機器：配對碼，移除要按兩次', async ({ page }) => {
    await open(page, 'settings/machines', {
      machines: [rigA, rigOff],
      sessions: [],
      approvals: [],
    });
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
    await expect(page.locator('#s-account')).toContainText('demo');
    await page.getByRole('link', { name: '機器與使用者' }).click();
    await expect(page.getByTestId('users-unavailable')).toBeVisible();
    await page.getByRole('link', { name: 'Session 與額度' }).click();
    await expect(page.locator('#s-templates [data-state=empty]')).toContainText('還沒有範本');

    await open(page, 'settings/users', {
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

  test('登出成功導向登入頁', async ({ page }) => {
    await open(page, 'settings');
    await page.getByRole('button', { name: '登出' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/login');
  });

  test('語言切換即時生效，重新整理還記得，跟隨瀏覽器可復原', async ({ page }) => {
    await open(page, 'settings');
    await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible();
    await page.locator('.segmented label', { hasText: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'My account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.getByRole('link', { name: 'Security' }).click();
    await expect(page.getByRole('button', { name: 'Save settings' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await page.getByRole('link', { name: 'My account' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await page.locator('.segmented label', { hasText: 'Follow browser' }).click();
    await expect(page.getByRole('heading', { name: '設定', level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-Hant');
  });

  test('載入、錯誤、存檔失敗、資料過期', async ({ page }) => {
    await open(page, 'settings/security', {
      patch: patchBackend('getSettings', `() => new Promise(() => {})`),
    });
    await expect(page.locator('.settings-panel [data-state=loading]')).toBeVisible();

    await open(page, 'settings/notify', {
      patch: `let n = 0; const ok = backend.getSettings;
        backend.getSettings = async () => { if (n++ < 1) throw new Error('403'); return ok(); };`,
    });
    const box = page.locator('.settings-panel [data-state=error]');
    await expect(box).toContainText('讀不到設定：403');
    await box.getByRole('button', { name: '重試' }).click();
    await expect(page.getByLabel('勿擾時段')).not.toBeChecked();

    await open(page, 'settings/security', {
      patch: patchBackend('updateSettings', `async () => { throw new Error('boom'); }`),
    });
    await page.getByLabel('監聽位址').fill('10.0.0.1');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg.err')).toContainText('存不了：boom');
    await expect(page.getByTestId('save-bar')).toContainText('1 項未存檔');

    await open(page, 'settings/machines', { connected: false });
    await expect(page.locator('.stale-line')).toBeVisible();
    await expect(page.getByRole('button', { name: '產生配對碼' })).toBeDisabled();
  });

  test('分類：左側選單切換，右邊只顯示選中的分類，鍵盤也能用', async ({ page }) => {
    await open(page, 'settings');
    const nav = page.getByRole('navigation', { name: '設定分類' });
    await expect(nav.getByRole('link')).toHaveText([
      '我的帳號',
      '通知',
      'Session 與額度',
      '安全',
      '機器與使用者',
      '資料與紀錄',
    ]);
    const account = nav.getByRole('link', { name: '我的帳號' });
    await expect(account).toHaveAttribute('aria-current', 'page');
    for (const id of ['account', 'language', 'password', 'push']) {
      await expect(page.locator(`#s-${id}`)).toBeVisible();
    }
    for (const id of ['machines', 'archived', 'templates']) {
      await expect(page.locator(`#s-${id}`)).toBeHidden();
    }
    // 不在有伺服器設定欄位的分類、也沒有未存的修改時，不放儲存列。
    await expect(page.getByTestId('save-bar')).toHaveCount(0);

    await nav.getByRole('link', { name: '安全' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/settings/security');
    await expect(nav.getByRole('link', { name: '安全' })).toHaveAttribute('aria-current', 'page');
    await expect(account).not.toHaveAttribute('aria-current', /.*/);
    await expect(page.locator('#s-security')).toBeVisible();
    await expect(page.locator('#s-language')).toBeHidden();
    await expect(page.getByTestId('save-bar')).toBeVisible();

    // 卡住判定搬到「Session 與額度」，和範本、省額度放在一起。
    await nav.getByRole('link', { name: 'Session 與額度' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#s-templates')).toBeVisible();
    await expect(page.locator('#s-quota')).toBeVisible();
    await expect(page.locator('#s-stuck')).toContainText('幾分鐘沒輸出算卡住');
    await expect(page.locator('#s-security')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(nav.getByRole('link', { name: '安全' })).toHaveAttribute('aria-current', 'page');
  });

  test('深連結：網址帶分類或舊的區塊 id，都落到對的分類與位置', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: '設定分類' });
    const current = (name: string) =>
      expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await open(page, 'settings/data');
    await current('資料與紀錄');
    await expect(page.locator('#s-archived')).toBeVisible();
    await expect(page.locator('#s-audit')).toBeVisible();

    await open(page, 'settings/audit');
    await current('資料與紀錄');
    await expect(page.locator('#s-audit')).toBeInViewport();

    await open(page, 'settings/push');
    await current('我的帳號');
    await expect(page.locator('#s-push')).toBeVisible();

    await open(page, 'settings/stuck');
    await current('Session 與額度');
    await expect(page.getByLabel('幾分鐘沒輸出算卡住')).toHaveValue('10');

    await open(page, 'settings/nope');
    await current('我的帳號');

    // 舊資料頁的「回已封存清單」帶回設定頁的已封存區。
    await open(page, 'archive/s-old-api');
    await page.getByRole('link', { name: '← 回已封存清單' }).first().click();
    await expect(page.locator('#s-archived')).toBeVisible();
    await current('資料與紀錄');
  });

  test('未存的修改：切換分類還在，選單標出哪個分類沒存，在別的分類也能存', async ({ page }) => {
    await open(page, 'settings/security');
    const nav = page.getByRole('navigation', { name: '設定分類' });
    const security = nav.getByRole('link', { name: /^安全/ });
    const sessions = nav.getByRole('link', { name: /^Session 與額度/ });
    await page.getByLabel('監聽位址').fill('100.64.0.1');
    await expect(security.locator('.chip.unsaved')).toHaveText('未存檔');
    await expect(nav.locator('.chip.unsaved')).toHaveCount(1);

    await sessions.click();
    await page.getByLabel('同時執行的 session 上限').fill('4');
    await expect(nav.locator('.chip.unsaved')).toHaveCount(2);

    // 到沒有表單的分類：儲存列跟著，草稿不丟。
    await nav.getByRole('link', { name: '我的帳號' }).click();
    const bar = page.getByTestId('save-bar');
    await expect(bar).toContainText('2 項未存檔');
    await security.click();
    await expect(page.getByLabel('監聽位址')).toHaveValue('100.64.0.1');

    // 不合法的欄位在別的分類：按儲存先切過去讓人看到標紅。
    await page.getByLabel('監聽位址').fill('0.0.0.0');
    await sessions.click();
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/settings/security');
    await expect(page.getByTestId('listen-error')).toBeVisible();
    await expect(bar.locator('.msg.err')).toContainText('先修正');
    expect(await calls(page)).toEqual([]);

    await page.getByLabel('監聽位址').fill('100.64.0.1');
    await nav.getByRole('link', { name: '我的帳號' }).click();
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(bar.locator('.msg')).toHaveText('已儲存');
    await expect(nav.locator('.chip.unsaved')).toHaveCount(0);
    const patch = ((await calls(page))[0] as { patch: Record<string, unknown> }).patch;
    expect(patch).toMatchObject({ listenAddress: '100.64.0.1' });
    expect(Object.keys(patch).sort()).toEqual(['listenAddress', 'quotaGuards']);
  });

  test('成員：看不到只有管理員能用的分類與區塊，網址硬給也回到我的帳號', async ({ page }) => {
    const settingsCalls: string[] = [];
    page.on('console', (m) => {
      if (m.text() === 'getSettings') settingsCalls.push(m.text());
    });
    await open(page, 'settings/security', {
      machines: [rigA, rigOff],
      patch: `backend.currentUser = async () =>
        ({ id: 'u-m', name: 'pat', role: 'member', locale: 'zh-TW' });
        const get = backend.getSettings;
        backend.getSettings = async () => { console.log('getSettings'); return get(); };`,
    });
    const nav = page.getByRole('navigation', { name: '設定分類' });
    await expect(nav.getByRole('link')).toHaveText([
      '我的帳號',
      'Session 與額度',
      '機器與使用者',
      '資料與紀錄',
    ]);
    await expect(nav.getByRole('link', { name: '我的帳號' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('#s-security')).toHaveCount(0);
    // 成員不讀 hub 設定（只會拿到 403），也不會看到讀不到的錯誤框。
    await expect(page.locator('[data-state=error]')).toHaveCount(0);
    expect(settingsCalls).toEqual([]);

    // 機器清單唯讀：看得到上線狀態，沒有配對、移除，也沒有使用者區。
    await nav.getByRole('link', { name: '機器與使用者' }).click();
    await expect(page.getByTestId('machine-m-a')).toContainText('rig-a');
    await expect(page.getByTestId('machine-m-off')).toContainText('最後讀到');
    await expect(page.locator('#s-machines').getByRole('button')).toHaveCount(0);
    await expect(page.locator('#s-users')).toHaveCount(0);
    await nav.getByRole('link', { name: 'Session 與額度' }).click();
    await expect(page.locator('#s-templates')).toBeVisible();
    await expect(page.locator('#s-quota')).toHaveCount(0);
    await expect(page.locator('#s-stuck')).toHaveCount(0);
    await expect(page.getByTestId('save-bar')).toHaveCount(0);
    await nav.getByRole('link', { name: '資料與紀錄' }).click();
    await expect(page.locator('#s-archived')).toBeVisible();
    await expect(page.locator('#s-audit')).toHaveCount(0);
  });

  test('成員還沒有機器：請管理員配對，不連到用不了的頁面', async ({ page }) => {
    const member = `backend.currentUser = async () =>
      ({ id: 'u-m', name: 'pat', role: 'member', locale: 'zh-TW' });`;
    await open(page, 'new', { machines: [], sessions: [], approvals: [], patch: member });
    const empty = page.locator('[data-state=empty]');
    await expect(empty).toContainText('請管理員到設定配對一台機器。');
    await expect(empty.getByRole('link')).toHaveCount(0);
  });

  test('網址編碼壞掉不讓整頁掛掉，回到我的帳號', async ({ page }) => {
    await open(page, 'settings/%E0');
    await expect(
      page.getByRole('navigation', { name: '設定分類' }).getByRole('link', { name: '我的帳號' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#s-language')).toBeVisible();
  });

  test('上一頁／下一頁在分類之間切換', async ({ page }) => {
    await open(page, 'settings');
    const nav = page.getByRole('navigation', { name: '設定分類' });
    const current = (name: string) =>
      expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await current('我的帳號');
    await nav.getByRole('link', { name: '安全' }).click();
    await current('安全');
    await page.getByLabel('監聽位址').fill('10.1.2.3');
    await nav.getByRole('link', { name: /^資料與紀錄/ }).click();
    await current('資料與紀錄');
    await page.goBack();
    await current('安全');
    // 草稿還在
    await expect(page.getByLabel('監聽位址')).toHaveValue('10.1.2.3');
    await expect(page.locator('#s-archived')).toBeHidden();
    await page.goBack();
    await current('我的帳號');
    await expect(page.locator('#s-language')).toBeVisible();
    await page.goForward();
    await current('安全');
    await page.goForward();
    await current('資料與紀錄');
    await expect(page.locator('#s-archived')).toBeVisible();
  });

  test('存檔後輸入框換成 hub 存下的值', async ({ page }) => {
    await open(page, 'settings/sessions');
    const deny = page.getByLabel('禁止讀取的路徑');
    await deny.fill('a/\n\n   b/  \n');
    await page.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByTestId('save-bar').locator('.msg')).toHaveText('已儲存');
    await expect(deny).toHaveValue('a/\nb/');
  });

  for (const section of ['audit', 'stuck', 'archived']) {
    test(`矮視窗深連結 #/settings/${section}：等區塊出現、版面穩定後才捲到`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 400 });
      await open(page, `settings/${section}`, {
        // 讓上方內容和目標晚一點才出現，模擬慢的 hub。
        patch: `const slow = (name) => { const f = backend[name];
          backend[name] = async (...a) => { await new Promise((r) => setTimeout(r, 250)); return f(...a); }; };
          slow('listArchivedSessions'); slow('getSettings'); slow('listTemplates'); slow('listAudit');`,
      });
      const target = page.locator(`#s-${section}`);
      await expect(target).toBeVisible();
      await expect(target).toBeInViewport();
      await page.waitForTimeout(1200);
      const top = await target.evaluate((el) => el.getBoundingClientRect().top);
      expect(top).toBeGreaterThanOrEqual(0);
      await expect(target).toBeInViewport();
      if (section !== 'archived') expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    });
  }

  for (const width of [320, 375]) {
    test(`${width}px：分類變成上方分頁，全部看得到，不出現整頁水平捲軸`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'settings/security');
      const nav = page.getByRole('navigation', { name: '設定分類' });
      const links = nav.getByRole('link');
      await expect(links).toHaveCount(6);
      for (const link of await links.all()) {
        const box = (await link.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(15);
        expect(box.x + box.width).toBeLessThanOrEqual(width - 15);
      }
      const navBox = (await nav.boundingBox())!;
      const panelBox = (await page.locator('.settings-panel').boundingBox())!;
      expect(navBox.y + navBox.height).toBeLessThanOrEqual(panelBox.y);
      expect(panelBox.x).toBeGreaterThanOrEqual(15);
      await expectNoPageOverflow(page);
      await page.getByLabel('監聽位址').fill('10.0.0.9');
      await nav.getByRole('link', { name: /^資料與紀錄/ }).click();
      await expect(page.locator('#s-archived')).toBeVisible();
      await expect(nav.getByRole('link', { name: /^安全/ }).locator('.chip.unsaved')).toBeVisible();
      await expectNoPageOverflow(page);
    });
  }
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

  test('建立管理員前 WebSocket 連不上不算資料過期，仍可建立', async ({ page }) => {
    await open(page, 'onboarding', { ...blank(), connected: false });
    await expect(page.locator('.stale-line')).toHaveCount(0);
    await page.getByLabel('名稱').fill('admin');
    await page.getByLabel('密碼', { exact: true }).fill('long-enough');
    await page.getByLabel('再輸入一次密碼').fill('long-enough');
    await expect(page.getByRole('button', { name: '建立管理員' })).toBeEnabled();
    await page.getByRole('button', { name: '建立管理員' }).click();
    await expect(page.locator('.stepper li.on')).toContainText('加入第一台機器');
    await expect(page.locator('.stale-line')).toBeVisible();
  });

  test('已有管理員時從機器開始；跳過機器會說明下一步', async ({ page }) => {
    await open(page, 'onboarding', { machines: [], sessions: [], approvals: [] });
    await expect(page.locator('.stepper li.on')).toContainText('加入第一台機器');
    await page.getByRole('button', { name: '稍後再加' }).click();
    await expect(page.getByRole('link', { name: '到設定配對機器' })).toHaveAttribute(
      'href',
      '#/settings/machines',
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

test.describe('登入', () => {
  test.use({ locale: 'zh-TW', viewport: { width: 375, height: 700 } });

  const recordLogin = (rejectWith?: string) => `
    window.__logins = [];
    backend.login = async (input) => {
      window.__logins.push(input);
      ${rejectWith ? `throw ${rejectWith};` : `return { id: 'u', name: input.name, role: 'owner', locale: 'zh-TW' };`}
    };`;
  const logins = (page: Page) =>
    page.evaluate(() => (window as unknown as { __logins: unknown[] }).__logins);
  const httpError = (status: number, code: string, message: string, extra = '') =>
    `Object.assign(new Error(${JSON.stringify(message)}), { status: ${status}, code: '${code}' ${extra} })`;

  test('成功：鍵盤 Enter 送出，帳號去空白、密碼原樣，導向畫布', async ({ page }) => {
    await open(page, 'login', { patch: recordLogin() });
    await expect(page.getByLabel('帳號')).toBeFocused();
    await page.getByLabel('帳號').fill(' admin ');
    await page.getByLabel('密碼').fill(' secret ');
    await page.getByLabel('密碼').press('Enter');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/canvas');
    expect(await logins(page)).toEqual([{ name: 'admin', password: ' secret ' }]);
  });

  test('沒填不送；帳號不存在與密碼錯誤同一句話，不轉述伺服器文字', async ({ page }) => {
    await open(page, 'login', {
      patch: recordLogin(httpError(401, 'invalid_credentials', 'user pat not found')),
    });
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.locator('.msg.err')).toHaveText('要填帳號和密碼');
    expect(await logins(page)).toEqual([]);

    await page.getByLabel('帳號').fill('pat');
    await page.getByLabel('密碼').fill('wrong-password');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.locator('.msg.err')).toHaveText(
      '帳號或密碼不對。確認後再試一次；忘記密碼見下方說明。',
    );
    // 下方說明：請管理員重設，或唯一的管理員在 hub 機器上跑救援指令。
    const forgot = page.getByTestId('login-forgot');
    await expect(forgot).toContainText('設定 → 機器與使用者');
    await expect(forgot.locator('code')).toHaveText('agent-board-hub reset-password <帳號>');
    await expect(page.locator('.flows')).not.toContainText('not found');
    await expect(page.getByLabel('帳號')).toHaveValue('pat');
    await expect(page.getByLabel('密碼')).toHaveValue('');
    await expect(page.getByLabel('密碼')).toBeFocused();
    expect(await page.evaluate(() => location.hash)).toBe('');
  });

  test('限速：說明要等多久，等待期間不能送，時間到恢復', async ({ page }) => {
    await open(page, 'login', {
      patch: recordLogin(
        httpError(429, 'rate_limited', 'Too many attempts', ', retryAfterSeconds: 2'),
      ),
    });
    await page.getByLabel('帳號').fill('pat');
    await page.getByLabel('密碼').fill('wrong-password');
    await page.getByLabel('密碼').press('Enter');
    await expect(page.locator('.msg.err')).toHaveText(
      '嘗試太多次，暫時不能登入。請等 2 秒後再試。',
    );
    const button = page.getByRole('button', { name: '登入' });
    await expect(button).toBeDisabled();
    await page.getByLabel('密碼').press('Enter');
    expect(await logins(page)).toHaveLength(1);
    await expect(button).toBeEnabled({ timeout: 4000 });
    await expect(page.locator('.msg.err')).toHaveCount(0);

    await open(page, 'login', {
      patch: recordLogin(
        httpError(429, 'rate_limited', 'Too many attempts', ', retryAfterSeconds: 300'),
      ),
    });
    await page.getByLabel('帳號').fill('pat');
    await page.getByLabel('密碼').fill('wrong-password');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.locator('.msg.err')).toContainText('請等 5 分鐘後再試');

    await open(page, 'login', { patch: recordLogin(httpError(429, 'rate_limited', 'x')) });
    await page.getByLabel('帳號').fill('pat');
    await page.getByLabel('密碼').fill('wrong-password');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.locator('.msg.err')).toHaveText('嘗試太多次，暫時不能登入。請稍後再試。');
    await expect(page.getByRole('button', { name: '登入' })).toBeEnabled();
  });

  test('連不上：寫發生什麼與怎麼辦，輸入都留著', async ({ page }) => {
    await open(page, 'login', { patch: recordLogin(`new Error('Failed to fetch')`) });
    await page.getByLabel('帳號').fill('pat');
    await page.getByLabel('密碼').fill('long-enough');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page.locator('.msg.err')).toHaveText(
      '連不到 hub：Failed to fetch。確認 hub 還在執行後再試一次。',
    );
    await expect(page.getByLabel('密碼')).toHaveValue('long-enough');
  });

  test('還沒登入時 WebSocket 連不上不算資料過期，仍可登入', async ({ page }) => {
    await open(page, 'login', { connected: false, patch: recordLogin() });
    await expect(page.locator('.stale-line')).toHaveCount(0);
    await expect(page.locator('.page.is-stale')).toHaveCount(0);
    await page.getByLabel('帳號').fill('a');
    await page.getByLabel('密碼').fill('b');
    await page.getByRole('button', { name: '登入' }).click();
    await expect.poll(() => logins(page)).toHaveLength(1);
  });

  test('語言切換即時生效，錯誤訊息用新語言', async ({ page }) => {
    await open(page, 'login', {
      patch: recordLogin(httpError(401, 'invalid_credentials', 'x')),
    });
    await page.locator('.segmented label', { hasText: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Log in to Agent Board' })).toBeVisible();
    await expect(page.getByTestId('login-forgot').locator('code')).toHaveText(
      'agent-board-hub reset-password <name>',
    );
    await page.getByLabel('Username').fill('pat');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('.msg.err')).toContainText("The username or password isn't right");
    await page.locator('.segmented label', { hasText: '繁體中文' }).click();
    await expect(page.getByRole('heading', { name: '登入 Agent Board' })).toBeVisible();
  });

  test('登入前選的語言只管登入頁；登入後改用帳號的語言', async ({ page }) => {
    await open(page, 'login', {
      patch: `backend.login = async (input) => ({ id: 'u', name: input.name, role: 'owner', locale: 'en' });`,
    });
    await page.locator('.segmented label', { hasText: '繁體中文' }).click();
    await page.getByLabel('帳號').fill('pat');
    await page.getByLabel('密碼').fill('long-enough');
    await page.getByRole('button', { name: '登入' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/canvas');
    // harness 只掛登入頁：它跟著換成帳號的語言（英文）。
    await expect(page.getByRole('heading', { name: 'Log in to Agent Board' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('agent-board.locale'))).toBe('en');
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
          const routes = [
            'review',
            'inbox',
            'new',
            'settings',
            'settings/machines',
            'settings/security',
            'settings/data',
            'onboarding',
            'login',
          ];
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
            if (route === 'settings/machines') {
              await page.getByRole('button', { name: /產生配對碼|Create pairing code/ }).click();
              await page.getByTestId('pair-command').waitFor();
            }
            if (route === 'settings/security') {
              await page.getByLabel(/監聽位址|Listen address/).fill('0.0.0.0');
            }
            await expectNoPageOverflow(page);
            const text = (await page.locator('.flows').innerText()) ?? '';
            expect(text).not.toMatch(/flows\.[a-z]/);
            expect(await findGreenOutsideDiff(page)).toEqual([]);
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({
              path: shot(info, `${route.replace('/', '-')}-${locale}-${width}`),
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
