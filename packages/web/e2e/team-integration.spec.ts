// 交接與請隊長拆解走完整條路：假 claude 真的收到 hub 送進 PTY 的內容。不連外、不呼叫 LLM。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import type { Machine, Session } from '@agent-board/protocol';

const PORT = 5197;
const HUB = `http://127.0.0.1:${PORT}`;
const DAEMON_DIR = resolve(import.meta.dirname, '../../daemon');
const FAKE_CLAUDE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');
const TSX = resolve(DAEMON_DIR, '../../node_modules/.bin/tsx');
const PASSWORD = 'integration-password';

let shared: BrowserContext;
const test = base.extend({
  context: async ({}, use) => {
    await use(shared);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    if (!page.isClosed()) await page.close();
  },
});

test.describe.configure({ mode: 'serial' });

let daemon: ChildProcess | undefined;
let daemonDir: string;
let repo: string;
let machineId: string;
let lead: Session;
let worker: Session;
let plain: Session;
let teamId: string;

function daemonEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BOARD_HUB_URL: `ws://127.0.0.1:${PORT}`,
    AGENT_BOARD_DATA_DIR: daemonDir,
    AGENT_BOARD_CLAUDE_BIN: FAKE_CLAUDE,
    AGENT_BOARD_MACHINE_NAME: 'team-e2e-machine',
  };
}

const getSession = async (request: APIRequestContext, id: string): Promise<Session> => {
  const sessions = (await (await request.get('/api/sessions')).json()) as Session[];
  const found = sessions.find((s) => s.id === id);
  if (!found) throw new Error(`no session ${id}`);
  return found;
};

const expectStatus = (request: APIRequestContext, id: string, status: Session['status']) =>
  expect.poll(async () => (await getSession(request, id)).status, { timeout: 20_000 }).toBe(status);

async function createSession(page: Page, name: string, useWorktree: boolean): Promise<Session> {
  const response = await page.request.post('/api/sessions', {
    data: {
      machineId,
      name,
      projectId: null,
      cwd: repo,
      useWorktree,
      permissionMode: 'default',
      model: null,
      accountProfile: null,
      resumeClaudeSessionId: null,
      firstPrompt: null,
    },
  });
  expect(response.ok()).toBe(true);
  const session = (await response.json()) as Session;
  await expectStatus(page.request, session.id, 'waiting_input');
  return getSession(page.request, session.id);
}

async function readScreen(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(
    (id) =>
      new Promise<string>((done, fail) => {
        const ws = new WebSocket(`ws://${location.host}/ws/client`);
        const timer = setTimeout(() => fail(new Error('no snapshot')), 10_000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'terminal.subscribe', sessionId: id }));
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; data: string };
          if (message.type !== 'terminal.snapshot') return;
          clearTimeout(timer);
          ws.close();
          done(message.data);
        };
      }),
    sessionId,
  );
}

async function typeInto(page: Page, sessionId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, data }) =>
      new Promise<void>((done) => {
        const ws = new WebSocket(`ws://${location.host}/ws/client`);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'terminal.input', sessionId: id, data }));
          setTimeout(() => {
            ws.close();
            done();
          }, 100);
        };
      }),
    { id: sessionId, data: `${text}\r` },
  );
}

const screenOf = (page: Page, id: string) =>
  expect.poll(async () => (await readScreen(page, id)).replace(/\s+/g, ' '), { timeout: 20_000 });

const auditOf = async (page: Page, action: string) => {
  const response = await page.request.get(`/api/audit?action=${action}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as { sessionId: string; detail: string }[];
};

test.beforeAll(async ({ browser }) => {
  shared = await browser.newContext({ baseURL: HUB, locale: 'zh-TW' });
  chmodSync(FAKE_CLAUDE, 0o755);
  daemonDir = mkdtempSync(join(tmpdir(), 'ab-team-e2e-daemon-'));
  repo = mkdtempSync(join(tmpdir(), 'ab-team-e2e-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: repo },
  );
});

test.afterAll(async () => {
  await shared.close();
  const running = daemon;
  if (running && running.exitCode === null) {
    await new Promise((done) => {
      running.once('exit', done);
      running.kill('SIGTERM');
    });
  }
});

test('建立管理員、配對、開好 session', async ({ page }) => {
  const setup = await page.request.post('/api/auth/setup', {
    data: { name: 'owner', password: PASSWORD, locale: 'zh-TW' },
  });
  expect(setup.ok()).toBe(true);
  const pairing = (await (await page.request.post('/api/machines/pairing-codes')).json()) as {
    code: string;
  };
  execFileSync(TSX, ['src/index.ts', 'pair', '--hub', HUB, '--code', pairing.code], {
    cwd: DAEMON_DIR,
    env: daemonEnv(),
    stdio: 'pipe',
  });
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: DAEMON_DIR,
    env: daemonEnv(),
    stdio: 'ignore',
  });
  await expect
    .poll(
      async () => {
        const machines = (await (await page.request.get('/api/machines')).json()) as Machine[];
        machineId = machines.find((m) => m.online)?.id ?? '';
        return machineId !== '';
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  lead = await createSession(page, 'lead-session', true);
  worker = await createSession(page, 'worker-session', true);
  plain = await createSession(page, 'plain-session', false);
  expect(lead.worktreePath).not.toBeNull();
  expect(worker.worktreePath).not.toBe(lead.worktreePath);
});

test('在工作台建立團隊與成員；同資料夾沒 worktree 的被擋', async ({ page }) => {
  await page.goto('/#/team');
  await page.getByLabel('團隊名稱').fill('整合團隊');
  await page.getByRole('button', { name: '建立團隊' }).click();
  await expect(page.getByRole('heading', { name: '整合團隊' })).toBeVisible();
  teamId = decodeURIComponent(new URL(page.url()).hash.split('/')[2]!);

  await page.getByLabel('選 session').selectOption({ label: 'lead-session' });
  await page.getByLabel('角色', { exact: true }).selectOption('lead');
  await page.getByRole('button', { name: '加入團隊' }).click();
  await expect(page.getByTestId(`member-${lead.id}`)).toBeVisible();

  await page.getByLabel('選 session').selectOption({ label: 'worker-session' });
  await page.getByLabel('角色', { exact: true }).selectOption('worker');
  await page.getByRole('button', { name: '加入團隊' }).click();
  await expect(page.getByTestId(`member-${worker.id}`)).toBeVisible();

  // 沒用 worktree 的 session 和成員的 worktree 是不同資料夾，可以加；再來一個同資料夾的就不行。
  await page.getByLabel('選 session').selectOption({ label: 'plain-session' });
  await page.getByRole('button', { name: '加入團隊' }).click();
  await expect(page.getByTestId(`member-${plain.id}`)).toBeVisible();
  const second = await createSession(page, 'plain-two', false);
  await expect(
    page.getByLabel('選 session').getByRole('option', { name: 'plain-two' }),
  ).toHaveCount(1);
  await page.getByLabel('選 session').selectOption({ label: 'plain-two' });
  await page.getByRole('button', { name: '加入團隊' }).click();
  await expect(page.getByTestId('worktree-conflict')).toContainText('plain-session');
  await expect(page.getByTestId(`member-${second.id}`)).toHaveCount(0);

  // 繞過前端也一樣被 hub 擋下；已是成員改角色不受影響
  const direct = await page.request.put(`/api/teams/${teamId}/members/${second.id}`, {
    data: { role: 'worker' },
  });
  expect(direct.status()).toBe(409);
  expect(((await direct.json()) as { code: string }).code).toBe('worktree_required');
  const roleChange = await page.request.put(`/api/teams/${teamId}/members/${plain.id}`, {
    data: { role: 'reviewer' },
  });
  expect(roleChange.ok()).toBe(true);

  // 重新整理後還在（真的存到 hub）
  await page.reload();
  await expect(page.getByTestId(`member-${lead.id}`)).toBeVisible();
});

test('請隊長拆解：提示真的送進隊長，回覆解析後放入待分配', async ({ page }) => {
  await page.goto(`/#/team/${teamId}`);
  await page.getByLabel('目標', { exact: true }).fill('Ship the login fix');
  await page
    .locator('section', { hasText: '目標與完成條件' })
    .getByRole('button', { name: '儲存' })
    .click();
  await expect(
    page.locator('section', { hasText: '目標與完成條件' }).getByRole('status'),
  ).toHaveText('已儲存');

  await page.getByRole('button', { name: '請隊長拆解' }).click();
  await expect(page.getByTestId('decompose-msg')).toHaveText(
    '放入待分配 2 項（已有的略過 0 項）。',
    {
      timeout: 20_000,
    },
  );
  await expect(page.getByTestId('column-todo').locator('.task')).toHaveCount(2);
  await screenOf(page, lead.id).toContain('GOT Break this team goal into tasks.');
  await screenOf(page, lead.id).toContain('Goal: Ship the login fix');

  // 未指派推不動：hub 也擋（409）
  const tasks = (await (await page.request.get(`/api/teams/${teamId}/tasks`)).json()) as {
    id: string;
  }[];
  const refused = await page.request.patch(`/api/tasks/${tasks[0]!.id}`, {
    data: { column: 'doing' },
  });
  expect(refused.status()).toBe(409);
  const card = page.locator('.task', { hasText: 'Integration task one' });
  await expect(card.getByRole('button', { name: '移到「進行中」' })).toBeDisabled();
  await card
    .getByLabel('「Integration task one」的負責人')
    .selectOption({ label: 'worker-session' });
  await card.getByRole('button', { name: '移到「進行中」' }).click();
  await expect(card).toHaveAttribute('data-column', 'doing');
});

test('完成時交接：關著不交接；回合結束不觸發；標記完成才送，只有摘要、檔案、分支', async ({
  page,
}) => {
  await page.goto(`/#/team/${teamId}`);
  await page.getByLabel('從', { exact: true }).selectOption({ label: 'lead-session' });
  await page.getByLabel('交給', { exact: true }).selectOption({ label: 'worker-session' });
  await page.getByRole('button', { name: '新增規則' }).click();
  const rule = page.locator('.rule', { hasText: 'lead-session → worker-session' });
  await expect(rule.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await rule.getByRole('button', { name: /自動交接/ }).click();
  await expect(rule.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // 真 daemon 從 PostToolUse 送 file.changed；Stop 只是回合結束，不交接。
  await expectStatus(page.request, lead.id, 'waiting_input');
  await typeInto(page, lead.id, 'edit-file /tmp/ab-team/login.ts');
  await screenOf(page, lead.id).toContain('GOT edit-file /tmp/ab-team/login.ts');
  await expectStatus(page.request, lead.id, 'waiting_input');
  await page.waitForTimeout(500);
  expect(await readScreen(page, worker.id)).not.toContain('[Handoff]');
  expect(await auditOf(page, 'handoff.fired')).toHaveLength(0);

  // 重新載入規則還在
  await page.reload();
  const member = page.getByTestId(`member-${lead.id}`);
  await expect(member.locator('.chip.cost')).toHaveText('◈ 耗額度');
  await member.getByRole('button', { name: '標記完成' }).click();

  await screenOf(page, worker.id).toContain(
    'GOT [Handoff] Summary: done: edit-file /tmp/ab-team/login.ts',
  );
  const screen = (await readScreen(page, worker.id)).replace(/\s+/g, ' ');
  expect(screen).toContain('Detected file edits: /tmp/ab-team/login.ts');
  expect(screen).toContain(`Branch: ${lead.branch}`);
  await expect(member.locator('.lamp')).toContainText('完成');

  const fired = await auditOf(page, 'handoff.fired');
  expect(fired).toHaveLength(1);
  expect(fired[0]!.sessionId).toBe(lead.id);
  expect(JSON.parse(fired[0]!.detail)).toMatchObject({
    trigger: 'on_done',
    toSessionId: worker.id,
  });
  const typed = await auditOf(page, 'terminal.input');
  expect(typed.some((a) => a.sessionId === worker.id && a.detail.startsWith('[Handoff]'))).toBe(
    true,
  );
  expect((await auditOf(page, 'handoff_rule.update')).length).toBeGreaterThanOrEqual(1);
});

test('A → B → A：回頭的那條被擋下，畫面看得到', async ({ page }) => {
  await page.goto(`/#/team/${teamId}`);
  const addFileRule = async (from: string, to: string) => {
    await page.getByLabel('從', { exact: true }).selectOption({ label: from });
    await page.getByLabel('交給', { exact: true }).selectOption({ label: to });
    await page.locator('.new-rule').getByLabel('觸發條件').selectOption('on_file');
    await page.getByRole('button', { name: '新增規則' }).click();
    const rule = page.locator('.rule', { hasText: `${from} → ${to}` });
    await rule.getByRole('button', { name: /自動交接/ }).click();
    await expect(rule.getByRole('button', { name: /自動交接/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  };
  await addFileRule('worker-session', 'plain-session');
  await addFileRule('plain-session', 'worker-session');
  await expectStatus(page.request, worker.id, 'waiting_input');
  await expectStatus(page.request, plain.id, 'waiting_input');

  await typeInto(page, worker.id, 'edit-file /tmp/ab-team/round.ts');
  // 假 claude 收到交接後會改檔，所以 plain 的回合結束會想交接回 worker。
  await screenOf(page, plain.id).toContain('GOT [Handoff] Summary: done: edit-file');
  await expect
    .poll(async () => (await auditOf(page, 'handoff.blocked')).length, { timeout: 20_000 })
    .toBe(1);
  const blocked = await auditOf(page, 'handoff.blocked');
  expect(JSON.parse(blocked[0]!.detail)).toMatchObject({
    reason: 'loop',
    fromSessionId: plain.id,
    toSessionId: worker.id,
  });

  await page.reload();
  await expect(page.getByTestId('handoff-activity')).toContainText('會形成迴圈');

  // 畫布：團隊框與交接線來自 hub
  await page.goto('/#/canvas');
  await expect(page.locator('.team')).toContainText('團隊・整合團隊');
  await expect(page.getByTestId(`handoff-${lead.id}-${worker.id}`)).toHaveText('完成時交接');
});

test('全隊停止：規則先關，session 真的結束，不會因結束再觸發交接', async ({ page }) => {
  await page.goto(`/#/team/${teamId}`);
  await page.getByRole('button', { name: '全隊停止' }).click();
  await page.getByRole('button', { name: /再按一次，停止/ }).click();
  await expect(page.getByTestId('team-controls-msg')).toContainText('已要求停止');
  await expect
    .poll(async () => (await getSession(page.request, worker.id)).endedAt, { timeout: 20_000 })
    .not.toBeNull();
  const firedBefore = (await auditOf(page, 'handoff.fired')).length;
  await page.waitForTimeout(500);
  expect((await auditOf(page, 'handoff.fired')).length).toBe(firedBefore);
  const rules = (await (await page.request.get(`/api/teams/${teamId}/handoff-rules`)).json()) as {
    enabled: boolean;
  }[];
  expect(rules.every((r) => !r.enabled)).toBe(true);
});
