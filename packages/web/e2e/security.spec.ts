// docs/security-checklist.md 引用這份。假資料都是組出來的金鑰形狀，不是真憑證。
import { expect, test, type Page } from '@playwright/test';
import type { Approval, Session } from '@agent-board/protocol';

const HUB = 'http://127.0.0.1:5187';
const KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
const BODY = 'AAAABBBB';
const DEMO_KEY = 'sk-ant-demo03-autostaffREASON00000000';
const DEMO_BODY = 'autostaffREASON';
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';

const machine = {
  id: 'm-a',
  name: 'rig-a',
  os: 'linux',
  online: true,
  lastSeenAt: new Date().toISOString(),
  capabilities: {
    hasGpu: false,
    gpuName: null,
    cpuCores: 8,
    memoryBytes: 1024,
    claudeVersion: 't',
  },
};

const session = (over: Partial<Session>): Session => ({
  id: 's1',
  name: 'demo',
  machineId: 'm-a',
  projectId: null,
  cwd: '/work/api',
  branch: 'ab/x',
  worktreePath: null,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  status: 'waiting_input',
  statusDetail: null,
  claudeSessionId: null,
  lastLines: [],
  lastOutputAt: new Date().toISOString(),
  statusSince: new Date().toISOString(),
  contextTokens: 1000,
  contextWindow: null,
  repoRoot: null,
  repoCommonDir: null,
  createdAt: new Date().toISOString(),
  endedAt: null,
  archived: false,
  archivedAt: null,
  readOnly: false,
  autoContinue: null,
  dispatchedBy: null,
  zoneId: 'main',
  ...over,
});

const approval = (over: Partial<Approval>): Approval => ({
  id: 'a1',
  sessionId: 's1',
  kind: 'permission',
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  suggestions: [],
  matchedRule: null,
  message: null,
  createdAt: new Date().toISOString(),
  ...over,
});

async function seed(page: Page, route: string, sessions: Session[], approvals: Approval[] = []) {
  await page.goto('about:blank');
  await page.goto('/?demo=1#/canvas');
  await page.evaluate(
    async ({ sessions, approvals, machine }) => {
      const path = '/src/shared/store.ts';
      const { useBoard } = await import(/* @vite-ignore */ path);
      useBoard.setState({ machines: [machine], sessions, approvals, connected: true });
    },
    { sessions, approvals, machine },
  );
  await page.evaluate((r) => {
    location.hash = r;
  }, `#/${route}`);
}

const setMaskStored = (page: Page, on: boolean) =>
  page.addInitScript((value) => {
    localStorage.setItem('agent-board.mask-mode', value ? '1' : '0');
  }, on);

test.describe('遮蔽模式：畫面', () => {
  test('頁首晶片切換；摘要卡 lastLines 打碼；重新整理後還開著；標示限制', async ({ page }) => {
    await seed(page, 'canvas', [session({ lastLines: [`export KEY=${KEY}`, 'plain line'] })]);
    const chip = page.getByTestId('mask-chip');
    await expect(chip).toHaveText('遮蔽');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect(chip).toHaveAttribute('title', /不是安全邊界/);
    const tail = page.locator('pre.tail').first();
    await expect(tail).toContainText(BODY);

    await chip.click();
    await expect(chip).toHaveText(/遮蔽中/);
    await expect(chip).toHaveText(/僅畫面/);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(tail).not.toContainText(BODY);
    await expect(tail).toContainText('plain line');

    // 晶片要明顯：反白，和關著時底色不同。按鈕底色有 0.15s 過渡，等它停下來再量。
    const settledBg = async () => {
      await page.waitForTimeout(300);
      return chip.evaluate((el) => getComputedStyle(el).backgroundColor);
    };
    const on = await settledBg();
    await chip.click();
    const off = await settledBg();
    expect(on).not.toBe(off);
    await chip.click();

    await page.reload();
    await expect(page.getByTestId('mask-chip')).toHaveText(/遮蔽中/);
  });

  test('審核卡：指令、兩段確認的指令全文、diff、提問都打碼', async ({ page }) => {
    await setMaskStored(page, true);
    await seed(
      page,
      'inbox',
      [
        session({ id: 's1', name: 'cmd', status: 'waiting_permission' }),
        session({ id: 's2', name: 'edit', status: 'waiting_permission' }),
        session({ id: 's3', name: 'ask', status: 'waiting_permission' }),
      ],
      [
        approval({
          id: 'a1',
          sessionId: 's1',
          kind: 'danger',
          matchedRule: 'git push --force',
          toolInput: { command: `curl -H "x-api-key: ${KEY}" https://x.example` },
        }),
        approval({
          id: 'a2',
          sessionId: 's2',
          toolName: 'Edit',
          toolInput: { file_path: '/a/.env', old_string: 'A=1', new_string: `TOKEN=${KEY}` },
        }),
        approval({
          id: 'a3',
          sessionId: 's3',
          kind: 'question',
          toolName: 'AskUserQuestion',
          toolInput: { questions: [{ question: `Use ${KEY}?`, options: ['yes'] }] },
        }),
      ],
    );
    await expect(page.getByTestId('mask-chip')).toHaveText(/遮蔽中/);
    // 收件匣一次展開一列的審核卡：逐列展開，確認三張卡都真的畫出來了，「不含金鑰」才有意義。
    await page.getByTestId('inbox-toggle-s1').click();
    const card = page.getByTestId('review-a1');
    await expect(card.locator('pre.command').first()).toContainText('curl');
    // 命中危險指令：第一次按會顯示指令全文，那裡也要打碼。
    await card.getByRole('button', { name: '允許一次' }).click();
    await expect(card.locator('.armed pre.command')).toContainText('curl');
    await expect(page.locator('body')).not.toContainText(BODY);
    await page.getByTestId('inbox-toggle-s2').click();
    await expect(page.locator('.diff')).toContainText('TOKEN=');
    await expect(page.locator('body')).not.toContainText(BODY);
    await page.getByTestId('inbox-toggle-s3').click();
    await expect(page.locator('.question')).toContainText('Use ');
    await expect(page.locator('body')).not.toContainText(BODY);
  });

  test('待處理與手機收件匣也打碼；收件匣有晶片', async ({ page }) => {
    await setMaskStored(page, true);
    const sessions = [session({ status: 'waiting_permission' })];
    const approvals = [approval({ toolInput: { command: `use ${KEY}` } })];
    await seed(page, 'queue', sessions, approvals);
    await expect(page.locator('.triage-row .triage-context')).toContainText('use');
    await expect(page.locator('body')).not.toContainText(BODY);
    await seed(page, 'inbox', sessions, approvals);
    await expect(page.getByTestId('mask-chip')).toHaveText(/遮蔽中/);
    await expect(page.locator('body')).not.toContainText(BODY);
  });

  test('隊長自主擴編：團隊名單與收件匣的新增理由都打碼', async ({ page }) => {
    await setMaskStored(page, true);
    const reason = `Needs ${DEMO_KEY} to call the API.`;
    await page.goto('about:blank');
    await page.goto('/?demo=1#/canvas');
    // demo 裡隊長加的那位（s-auth）：把理由換成含金鑰的字串（模擬 Claude 寫進理由）。
    await page.evaluate(
      async ({ reason }) => {
        const storePath = '/src/shared/store.ts';
        const teamPath = '/src/team/store.ts';
        const { useBoard } = await import(/* @vite-ignore */ storePath);
        const { refreshTeams } = await import(/* @vite-ignore */ teamPath);
        const backend = useBoard.getState().backend;
        const list = backend.listTeamMembers.bind(backend);
        backend.listTeamMembers = async (teamId: string) =>
          (await list(teamId)).map((m: { added?: { reason: string } }) =>
            m.added ? { ...m, added: { ...m.added, reason } } : m,
          );
        await refreshTeams(backend);
        useBoard.setState((s: { teamActivity?: { reason: string }[] }) => ({
          teamActivity: (s.teamActivity ?? []).map((a) => ({ ...a, reason })),
        }));
      },
      { reason },
    );
    await page.evaluate(() => {
      location.hash = '#/team/team-demo-auth';
    });
    const added = page.getByTestId('roster-added-s-auth');
    await expect(added).toContainText('Needs');
    await expect(added).not.toContainText(DEMO_BODY);
    await page.evaluate(() => {
      location.hash = '#/inbox';
    });
    const row = page.getByTestId('team-activity-activity-demo-1');
    await expect(row.locator('.activity-reason')).toContainText('Needs');
    await expect(page.locator('body')).not.toContainText(DEMO_BODY);
  });

  test('關著時完全不動內容', async ({ page }) => {
    await setMaskStored(page, false);
    await seed(
      page,
      'inbox',
      [session({ status: 'waiting_permission' })],
      [approval({ toolInput: { command: `use ${KEY}` } })],
    );
    await page.getByTestId('inbox-toggle-s1').click();
    await expect(page.getByTestId('inbox-drawer').locator('pre.command').first()).toContainText(
      KEY,
    );
  });
});

test.describe('遮蔽模式：xterm', () => {
  const HARNESS = '/e2e/terminal-harness.html';
  const lines = (page: Page) => page.evaluate(() => window.__harness.lines().join('\n'));
  const emit = (page: Page, data: string) =>
    page.evaluate((text) => window.__harness.emit(text), data);
  const toggle = (page: Page) =>
    page.evaluate(async () => {
      const path = '/src/security/maskMode.ts';
      const { useMaskMode } = await import(/* @vite-ignore */ path);
      useMaskMode.getState().toggle();
    });

  const open = async (page: Page, on: boolean) => {
    await setMaskStored(page, on);
    await page.goto(HARNESS);
    await page.waitForFunction(() => window.__harness !== undefined);
    await page.waitForSelector('.xterm-screen');
  };

  test('寫進 xterm 前就打碼，含跨 chunk 切開；畫面沒有疊任何元素', async ({ page }) => {
    await open(page, true);
    await emit(page, `key ${KEY.slice(0, 16)}`);
    await emit(page, `${KEY.slice(16)} tail\r\n`);
    await expect.poll(() => lines(page)).toContain('tail');
    const text = await lines(page);
    expect(text).not.toContain(BODY);
    expect(text).toContain(`key ${'*'.repeat(KEY.length)} tail`);
    expect(await page.locator('.xterm .mask-chip').count()).toBe(0);
  });

  test('輸出停在金鑰中間也不會卡住：短暫後以打碼顯示', async ({ page }) => {
    await open(page, true);
    await emit(page, 'wait password=hunt');
    await expect.poll(() => lines(page)).toContain('wait password=****');
    expect(await lines(page)).not.toContain('hunt');
  });

  test('開啟時已經畫上去的金鑰會被換掉；關閉後新輸出恢復原樣', async ({ page }) => {
    await open(page, false);
    await emit(page, `raw ${KEY}\r\n`);
    await expect.poll(() => lines(page)).toContain(KEY);
    const subscribes = await page.evaluate(() => window.__harness.subscribes());

    await toggle(page);
    await expect.poll(() => lines(page)).not.toContain(BODY);
    expect(await page.evaluate(() => window.__harness.subscribes())).toBe(subscribes + 1);

    await emit(page, `masked ${KEY}\r\n`);
    await expect.poll(() => lines(page)).toContain('masked ***');

    await toggle(page);
    await emit(page, `again ${KEY}\r\n`);
    await expect.poll(() => lines(page)).toContain(`again ${KEY}`);
  });

  test('輸入不受影響：打的字照樣送出', async ({ page }) => {
    await open(page, true);
    await page.locator('.xterm-screen').click();
    await page.keyboard.type('abc');
    await expect
      .poll(() => page.evaluate(() => window.__harness.inputs().join('')))
      .toContain('abc');
  });
});

test.describe('XSS', () => {
  const assertClean = async (page: Page) => {
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.locator('#root script').count()).toBe(0);
  };

  test('session 名稱、lastLines、指令、diff、JSON 參數、問題都只當文字', async ({ page }) => {
    const sessions = [
      session({ id: 's1', name: XSS, status: 'waiting_permission', lastLines: [XSS], branch: XSS }),
      session({ id: 's2', name: XSS, status: 'waiting_permission', cwd: `/w/${XSS}` }),
      session({ id: 's3', name: XSS, status: 'waiting_permission' }),
      session({ id: 's4', name: XSS, status: 'waiting_permission' }),
      session({ id: 's5', name: XSS, status: 'waiting_input', lastLines: [XSS] }),
    ];
    const approvals = [
      approval({ id: 'a1', sessionId: 's1', toolInput: { command: XSS }, message: XSS }),
      approval({
        id: 'a2',
        sessionId: 's2',
        toolName: 'Edit',
        toolInput: { file_path: XSS, old_string: XSS, new_string: `${XSS}\n${XSS}` },
      }),
      approval({
        id: 'a3',
        sessionId: 's3',
        toolName: XSS,
        toolInput: { anything: { nested: XSS } },
      }),
      approval({
        id: 'a4',
        sessionId: 's4',
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: XSS, options: [XSS] }] },
      }),
    ];
    for (const route of ['canvas', 'queue', 'review', 'inbox']) {
      await seed(page, route, sessions, approvals);
      await expect(page.locator('body')).toContainText('<img src=x');
      await assertClean(page);
      // 收件匣的審核卡要展開才畫：逐列展開（原本審核中心逐張畫的內容）。
      if (route === 'inbox') {
        for (const id of ['s1', 's2', 's3', 's4', 's5']) {
          await page.getByTestId(`inbox-toggle-${id}`).click();
          await expect(page.getByTestId(`inbox-toggle-${id}`)).toHaveAttribute(
            'aria-expanded',
            'true',
          );
          await assertClean(page);
        }
      }
    }
  });

  test('終端機輸出的 HTML 不會變成元素；OSC 標題與 javascript: 連結不執行', async ({ page }) => {
    await page.goto('/e2e/terminal-harness.html');
    await page.waitForFunction(() => window.__harness !== undefined);
    await page.waitForSelector('.xterm-screen');
    await page.evaluate((text) => window.__harness.emit(text), `${XSS}\r\n`);
    await page.evaluate(() =>
      window.__harness.emit(
        '\x1b]0;<img src=x onerror="window.__xss=1">\x07' +
          '\x1b]8;;javascript:window.__xss=1\x07click\x1b]8;;\x07\r\n',
      ),
    );
    await expect
      .poll(() => page.evaluate(() => window.__harness.lines().join('\n')))
      .toContain('click');
    const point = await page.evaluate(() => window.__harness.pointOf('click'));
    await page.mouse.click(point!.x, point!.y);
    await page.waitForTimeout(100);
    await assertClean(page);
  });
});

test.describe('真 hub', () => {
  test.describe.configure({ mode: 'serial' });

  test('未登入：API 401、WebSocket 不開', async ({ page, request }) => {
    expect((await request.get(`${HUB}/api/sessions`)).status()).toBe(401);
    await page.goto(`${HUB}/`);
    const opened = await page.evaluate(
      (url) =>
        new Promise<boolean>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => resolve(true);
          ws.onerror = () => resolve(false);
        }),
      `${HUB.replace('http', 'ws')}/ws/client`,
    );
    expect(opened).toBe(false);
  });

  test('CSP：頁面正常載入無違規；注入的 inline script 不執行；標頭正確', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    const res = await page.goto(`${HUB}/`);
    const csp = res!.headers()['content-security-policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/connect-src[^;]* ws: /);
    await expect(page.locator('#root').locator('input').first()).toBeVisible();
    expect(violations).toEqual([]);

    const ran = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.__injected = 1';
      document.head.append(script);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return (window as { __injected?: number }).__injected;
    });
    expect(ran).toBeUndefined();
    expect(violations.length).toBeGreaterThan(0);
  });

  test('CSP：不能往別的主機開 WebSocket 或 fetch', async ({ page }) => {
    await page.goto(`${HUB}/`);
    const result = await page.evaluate(async () => {
      const ws = await new Promise<string>((resolve) => {
        try {
          const socket = new WebSocket('ws://127.0.0.1:5186/');
          socket.onopen = () => resolve('open');
          socket.onerror = () => resolve('blocked');
        } catch {
          resolve('blocked');
        }
      });
      const http = await fetch('http://127.0.0.1:5186/').then(
        () => 'open',
        () => 'blocked',
      );
      return { ws, http };
    });
    expect(result).toEqual({ ws: 'blocked', http: 'blocked' });
  });

  test('跨站：登入後其他來源的頁面開不了 WebSocket，也改不了資料', async ({ page, context }) => {
    const setup = await context.request.post(`${HUB}/api/auth/setup`, {
      headers: { origin: HUB },
      data: { name: 'owner', password: 'security-e2e-password', locale: 'zh-TW' },
    });
    expect(setup.status()).toBe(200);
    expect(setup.headers()['set-cookie']).toMatch(/HttpOnly/i);
    expect(setup.headers()['set-cookie']).toMatch(/SameSite=Strict/i);

    // 正面對照：同源頁面開得了，證明下面的失敗不是別的原因。
    await page.goto(`${HUB}/`);
    const wsUrl = `${HUB.replace('http', 'ws')}/ws/client`;
    const tryWs = (url: string) =>
      page.evaluate(
        (u) =>
          new Promise<boolean>((resolve) => {
            const ws = new WebSocket(u);
            ws.onopen = () => resolve(true);
            ws.onerror = () => resolve(false);
          }),
        url,
      );
    expect(await tryWs(wsUrl)).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('ab_session');

    // 不同 port 是不同 origin，但同一個 site：SameSite 擋不住，只能靠 Origin 檢查。
    await page.goto('/e2e/terminal-harness.html');
    expect(await tryWs(wsUrl)).toBe(false);

    const before = await (await context.request.get(`${HUB}/api/projects`)).json();
    await page.evaluate(
      (url) =>
        fetch(url, {
          method: 'POST',
          mode: 'no-cors',
          credentials: 'include',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ name: 'csrf', color: '#000000' }),
        }).catch(() => undefined),
      `${HUB}/api/projects`,
    );
    const direct = await context.request.post(`${HUB}/api/projects`, {
      headers: { origin: 'http://127.0.0.1:5186' },
      data: { name: 'csrf', color: '#000000' },
    });
    expect(direct.status()).toBe(403);
    const after = await (await context.request.get(`${HUB}/api/projects`)).json();
    expect(after).toEqual(before);
  });
});
