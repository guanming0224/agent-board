// 進度卡（P3 項目一，docs/p3-spec.md §1.8）：引擎（三方比對四種組合、鎖定、還原、歷史 50 版）與整合
// （真的 hub、假 daemon 經 dispatch.request 呼叫 MCP 工具；REST；WS 推送；帶入進度卡與請隊長更新走 SafeDelivery）。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROGRESS_ASK_UPDATE_PROMPT,
  PROGRESS_HISTORY_KEEP,
  PROGRESS_RATE_MAX,
  type Broadcast,
  type ProgressCard,
  type ProgressConflict,
  type Session,
  type SessionSpec,
  type User,
} from '@agent-board/protocol';
import { openDatabase } from '../db';
import { HttpError } from '../errors';
import { PROGRESS_ATTEMPT_MAX, ProgressEngine } from '../progress';
import { Store } from '../store';
import { type Peer, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

// ── 引擎（記憶體資料庫） ──────────────────────────────────

function engineSetup() {
  const store = new Store(openDatabase(':memory:'), '127.0.0.1');
  store.db
    .prepare(
      "INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m', 'm', 'darwin', 'h', '{}')",
    )
    .run();
  const gm: User = { id: 'u1', name: 'GM', role: 'owner', locale: 'zh-TW' };
  store.createUser(gm, 'hash');
  const base = (id: string, over: Partial<Session> = {}): Session => ({
    id,
    machineId: 'm',
    projectId: null,
    name: id,
    cwd: '/r',
    branch: null,
    worktreePath: null,
    permissionMode: 'acceptEdits',
    model: null,
    accountProfile: null,
    status: 'waiting_input',
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: null,
    statusSince: new Date().toISOString(),
    contextTokens: null,
    contextWindow: null,
    repoRoot: '/r',
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
  store.insertSession(base('lead'), null);
  store.insertSession(base('worker'), null);
  store.insertSession(base('solo'), null);
  store.upsertTeam({
    id: 't1',
    name: '台股',
    goal: 'Backtest',
    doneCriteria: 'Sharpe > 1',
    color: 'teal',
    contextMd: 'ctx',
    taskAuto: false,
    zoneId: 'main',
  });
  store.upsertTeamMember({ teamId: 't1', sessionId: 'lead', role: 'lead' });
  store.upsertTeamMember({ teamId: 't1', sessionId: 'worker', role: 'worker' });
  let now = new Date('2026-11-08T10:00:00.000Z');
  const pushed: ProgressCard[] = [];
  const audits: {
    userId: string | null;
    sessionId: string | null;
    action: string;
    detail: string;
  }[] = [];
  let enabled = true;
  const engine = new ProgressEngine({
    store,
    now: () => now,
    audit: (userId, sessionId, action, detail) =>
      audits.push({ userId, sessionId, action, detail }),
    changed: (card) => pushed.push(card),
    enabled: () => enabled,
    broadcasts: { direct: () => ({}) as Broadcast },
  });
  const team = { teamId: 't1' } as const;
  const agent = (args: Record<string, unknown>, caller = 'lead') =>
    engine.handleTool(caller, 'update_progress', args);
  const read = (caller = 'lead', args: Record<string, unknown> = {}) => {
    const reply = engine.handleTool(caller, 'get_progress', args);
    expect(reply.ok, reply.text).toBe(true);
    return JSON.parse(reply.text) as Record<string, unknown>;
  };
  return {
    store,
    engine,
    gm,
    team,
    agent,
    read,
    pushed,
    audits,
    tick: (ms: number) => (now = new Date(now.getTime() + ms)),
    off: () => (enabled = false),
  };
}

const conflictOf = (fn: () => unknown): ProgressConflict => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('progress_conflict');
    expect((error as HttpError).status).toBe(409);
    return (error as HttpError).detail as unknown as ProgressConflict;
  }
  throw new Error('expected a conflict');
};

describe('進度卡引擎：三方比對（同欄／不同欄 × GM 先／agent 先）', () => {
  it('GM 先改「下一步」，agent 以舊版寫「下一步」→ 衝突，卡片仍是 GM 的；只寫「狀態」→ 合併', () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, next: 'A', status: 'S0' }, t.gm); // rev 1
    t.engine.write(t.team, { baseRevision: 1, next: 'GM' }, t.gm); // rev 2
    const refused = t.agent({ baseRevision: 1, next: 'X' });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(
      /^progress_conflict: The user or another member just changed next/,
    );
    expect(refused.text).toContain('baseRevision 2');
    expect(t.engine.card(t.team).next).toBe('GM');
    const merged = t.agent({ baseRevision: 1, status: 'S1' });
    expect(merged.ok, merged.text).toBe(true);
    expect(JSON.parse(merged.text)).toMatchObject({ revision: 3, merged: true });
    expect(t.engine.card(t.team)).toMatchObject({ status: 'S1', next: 'GM', revision: 3 });
    expect(t.audits.map((a) => a.action)).toContain('progress.conflict');
  });

  it('agent 先改「下一步」，GM 以舊版改同欄 → 409（附你讀到的／現在的／改的人）；改別欄 → 合併', () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, next: 'A' }, t.gm); // rev 1
    expect(t.agent({ baseRevision: 1, next: 'agent' }).ok).toBe(true); // rev 2
    const conflict = conflictOf(() =>
      t.engine.write(t.team, { baseRevision: 1, next: 'GM' }, t.gm),
    );
    expect(conflict.fields).toEqual([
      {
        field: 'next',
        base: 'A',
        current: 'agent',
        by: { kind: 'session', id: 'lead', name: 'lead' },
      },
    ]);
    expect(conflict.card.next).toBe('agent');
    const card = t.engine.write(t.team, { baseRevision: 1, blockers: 'fees?' }, t.gm);
    expect(card).toMatchObject({ merged: true, next: 'agent', blockers: 'fees?', revision: 3 });
    // 選「用我的」：以目前版本再存一次。
    const mine = t.engine.write(t.team, { baseRevision: 3, next: 'GM' }, t.gm);
    expect(mine).toMatchObject({ next: 'GM', revision: 4 });
    expect(mine.merged).toBeUndefined();
  });

  it('帶了但內容沒變的欄位不算改也不算衝突；沒有任何改動不加版本', () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, next: 'A' }, t.gm);
    t.engine.write(t.team, { baseRevision: 1, next: 'B' }, t.gm);
    const same = t.agent({ baseRevision: 1, next: 'B' });
    expect(JSON.parse(same.text)).toMatchObject({ revision: 2, updated: [] });
    expect(t.engine.card(t.team).revision).toBe(2);
  });

  it('baseRevision 比目前新、欄位超過上限：拒絕，不默默截斷', () => {
    const t = engineSetup();
    expect(t.agent({ baseRevision: 5, next: 'x' }).text).toMatch(
      /^invalid_arguments: baseRevision 5/,
    );
    expect(t.agent({ baseRevision: 0, next: 'x'.repeat(2001) }).text).toMatch(
      /^invalid_arguments: next is 2001 characters; the limit is 2000/,
    );
    expect(() =>
      t.engine.write(t.team, { baseRevision: 0, gmNotes: 'x'.repeat(4001) }, t.gm),
    ).toThrow(/gmNotes/);
    expect(t.engine.card(t.team).revision).toBe(0);
  });

  it('欄位清控制字元（保留換行）：ESC、\\r 不會進資料庫', () => {
    const t = engineSetup();
    t.agent({ baseRevision: 0, status: '\u001b[31mred\u001b[0m\r\n- item\u0007  ' });
    expect(t.engine.card(t.team).status).toBe('red\n- item');
  });
});

describe('進度卡引擎：鎖定、歷史、還原、權限、頻率', () => {
  it('鎖定後 agent 寫入回 card_locked、讀取正常並註明；GM 照樣可改；解鎖後 agent 可寫', () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, next: 'A' }, t.gm);
    const locked = t.engine.write(t.team, { baseRevision: 1, locked: true }, t.gm);
    expect(locked).toMatchObject({ locked: true, revision: 1 });
    expect(t.agent({ baseRevision: 1, next: 'X' }).text).toMatch(/^card_locked:/);
    expect(t.read()).toMatchObject({
      locked: true,
      next: 'A',
      note: expect.stringContaining('locked'),
    });
    expect(t.engine.write(t.team, { baseRevision: 1, next: 'GM' }, t.gm).revision).toBe(2);
    t.engine.write(t.team, { baseRevision: 2, locked: false }, t.gm);
    expect(t.agent({ baseRevision: 2, next: 'X' }).ok).toBe(true);
    expect(t.audits.filter((a) => a.action === 'progress.lock')).toHaveLength(2);
  });

  it('寫 3 次列出 3 版；還原第 1 版產生第 4 版、內容等於第 1 版；還原後 agent 以舊版寫同欄會衝突', () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, status: 'one', next: 'n1' }, t.gm);
    t.engine.write(t.team, { baseRevision: 1, status: 'two' }, t.gm);
    expect(t.agent({ baseRevision: 2, status: 'three' }).ok).toBe(true);
    const history = t.engine.revisions(t.team);
    expect(history.map((r) => [r.revision, r.fields.status, r.source, r.by.name])).toEqual([
      [3, 'three', 'mcp', 'lead'],
      [2, 'two', 'web', 'GM'],
      [1, 'one', 'web', 'GM'],
    ]);
    const restored = t.engine.restore(t.team, 1, t.gm);
    expect(restored).toMatchObject({ revision: 4, status: 'one', next: 'n1' });
    expect(t.engine.revisions(t.team)[0]).toMatchObject({ revision: 4, source: 'restore' });
    expect(t.audits.map((a) => a.action)).toContain('progress.restore');
    expect(t.agent({ baseRevision: 3, status: 'agent' }).text).toMatch(/^progress_conflict:/);
  });

  it(`歷史只留最新 ${PROGRESS_HISTORY_KEEP} 版（第 51 次寫入後剩 50 筆）`, () => {
    const t = engineSetup();
    for (let i = 0; i < PROGRESS_HISTORY_KEEP + 1; i += 1) {
      t.engine.write(t.team, { baseRevision: i, next: `n${i}` }, t.gm);
    }
    const history = t.engine.revisions(t.team);
    expect(history).toHaveLength(PROGRESS_HISTORY_KEEP);
    expect(history[0]!.revision).toBe(PROGRESS_HISTORY_KEEP + 1);
    expect(history.at(-1)!.revision).toBe(2);
    // 讀到的那版已經被修剪：衝突欄位的 base 是 null（不知道），仍然拒絕。
    const conflict = conflictOf(() =>
      t.engine.write(t.team, { baseRevision: 1, next: 'old' }, t.gm),
    );
    expect(conflict.fields[0]).toMatchObject({ field: 'next', base: null });
  });

  it('非隊長成員 not_lead、gmNotes invalid_arguments；沒有隊長的團隊任一成員可寫；單獨 session 寫自己的卡', () => {
    const t = engineSetup();
    expect(t.agent({ baseRevision: 0, next: 'x' }, 'worker').text).toMatch(
      /^not_lead: Only the team lead \(lead\)/,
    );
    expect(t.agent({ baseRevision: 0, gmNotes: 'x' }).text).toMatch(/^invalid_arguments: gmNotes/);
    expect(t.agent({ baseRevision: 0 }).text).toMatch(/^invalid_arguments: Send at least one/);
    expect(t.agent({ next: 'x' }).text).toMatch(/^invalid_arguments: baseRevision/);
    t.store.upsertTeamMember({ teamId: 't1', sessionId: 'lead', role: 'worker' });
    expect(t.agent({ baseRevision: 0, next: 'x' }, 'worker').ok).toBe(true);
    const solo = t.engine.handleTool('solo', 'update_progress', { baseRevision: 0, next: 'mine' });
    expect(solo.ok, solo.text).toBe(true);
    expect(t.engine.card({ sessionId: 'solo' })).toMatchObject({ next: 'mine', sessionId: 'solo' });
    expect(t.read('solo')).toMatchObject({ session: 'solo', next: 'mine' });
  });

  it(`同一 session 10 分鐘第 ${PROGRESS_RATE_MAX + 1} 次寫入 → rate_limit；過了 10 分鐘又可寫`, () => {
    const t = engineSetup();
    for (let i = 0; i < PROGRESS_RATE_MAX; i += 1) {
      expect(t.agent({ baseRevision: i, next: `n${i}` }).ok).toBe(true);
    }
    expect(t.agent({ baseRevision: PROGRESS_RATE_MAX, next: 'x' }).text).toMatch(/^rate_limit:/);
    t.tick(10 * 60 * 1000 + 1);
    expect(t.agent({ baseRevision: PROGRESS_RATE_MAX, next: 'x' }).ok).toBe(true);
  });

  it(`被拒的嘗試也算：衝突重試第 ${PROGRESS_ATTEMPT_MAX + 1} 次 → rate_limit，不再寫 audit、不回整張卡`, () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, next: 'GM' }, t.gm);
    for (let i = 0; i < PROGRESS_ATTEMPT_MAX; i += 1) {
      expect(t.agent({ baseRevision: 0, next: `agent ${i}` }).text).toMatch(/^progress_conflict:/);
    }
    const conflicts = () => t.audits.filter((a) => a.action === 'progress.conflict').length;
    expect(conflicts()).toBe(PROGRESS_ATTEMPT_MAX);
    const blocked = t.agent({ baseRevision: 1, next: 'again' });
    expect(blocked.text).toMatch(/^rate_limit:/);
    expect(blocked.text).not.toContain('Current card');
    expect(conflicts()).toBe(PROGRESS_ATTEMPT_MAX);
    // 鎖定被拒也算次數。
    t.tick(10 * 60 * 1000 + 1);
    t.engine.write(t.team, { baseRevision: 1, locked: true }, t.gm);
    for (let i = 0; i < PROGRESS_ATTEMPT_MAX; i += 1) {
      expect(t.agent({ baseRevision: 1, next: 'x' }).text).toMatch(/^card_locked:/);
    }
    expect(t.agent({ baseRevision: 1, next: 'x' }).text).toMatch(/^rate_limit:/);
  });

  it('body 帶了和目前相同的 locked、欄位沒變：不推 progress.updated；真的切換才推', () => {
    const t = engineSetup();
    t.engine.write(t.team, { baseRevision: 0, next: 'A' }, t.gm);
    expect(t.pushed).toHaveLength(1);
    t.engine.write(t.team, { baseRevision: 1, locked: false, next: 'A' }, t.gm);
    expect(t.pushed).toHaveLength(1);
    t.engine.write(t.team, { baseRevision: 1, locked: true }, t.gm);
    expect(t.pushed).toHaveLength(2);
    t.engine.write(t.team, { baseRevision: 1, locked: true }, t.gm);
    expect(t.pushed).toHaveLength(2);
  });

  it('lastStopAt：只算卡片最後更新之後的 Stop（取各成員最新一筆）；沒寫過的卡是 null', () => {
    const t = engineSetup();
    const stop = (sessionId: string, at: string, event = 'Stop') =>
      t.store.insertEvent({
        id: randomUUID(),
        sessionId,
        type: 'hook',
        payload: { event },
        at,
      });
    stop('lead', '2026-11-08T09:00:00.000Z');
    expect(t.engine.card(t.team).facts.lastStopAt).toBeNull();
    t.engine.write(t.team, { baseRevision: 0, next: 'A' }, t.gm); // updatedAt 10:00
    expect(t.engine.card(t.team).facts.lastStopAt).toBeNull();
    stop('lead', '2026-11-08T11:00:00.000Z');
    stop('worker', '2026-11-08T12:00:00.000Z');
    stop('worker', '2026-11-08T13:00:00.000Z', 'PreToolUse');
    expect(t.engine.card(t.team).facts.lastStopAt).toBe('2026-11-08T12:00:00.000Z');
    expect(t.engine.card({ sessionId: 'solo' }).facts.lastStopAt).toBeNull();
  });

  it('get_progress：四欄位、goal、contextMd、自動事實、revision；設定關掉回 memory_disabled', () => {
    const t = engineSetup();
    t.store.upsertTask({
      id: 'k1',
      teamId: 't1',
      title: 'Load 2015',
      ownerSessionId: 'worker',
      column: 'done',
      number: 1,
      rejectCount: 0,
      needsUser: false,
      reviewerSessionId: null,
      auto: null,
    });
    t.store.upsertTask({
      id: 'k2',
      teamId: 't1',
      title: 'Load 2021',
      ownerSessionId: 'worker',
      column: 'doing',
      number: 2,
      rejectCount: 0,
      needsUser: false,
      reviewerSessionId: null,
      auto: null,
    });
    t.store.insertEvent({
      id: randomUUID(),
      sessionId: 'worker',
      type: 'file.changed',
      payload: { path: '/r/src/risk.py' },
      at: '2026-11-08T09:00:00.000Z',
    });
    t.engine.write(t.team, { baseRevision: 0, next: 'Fill 2021', gmNotes: 'fee 0.1425%' }, t.gm);
    expect(t.read()).toMatchObject({
      team: '台股',
      revision: 1,
      next: 'Fill 2021',
      gmNotes: 'fee 0.1425%',
      gmNotesRule: expect.stringContaining('fixed rules'),
      goal: 'Backtest',
      doneCriteria: 'Sharpe > 1',
      contextMd: 'ctx',
      updatedBy: 'GM (user)',
      facts: {
        tasks: { done: 1, total: 2, doing: ['#2 Load 2021'] },
        recentFiles: ['src/risk.py'],
        members: [
          { name: 'lead', role: 'lead', status: 'waiting_input' },
          { name: 'worker', role: 'worker', status: 'waiting_input' },
        ],
      },
    });
    t.off();
    expect(t.engine.handleTool('lead', 'get_progress', {}).text).toMatch(/^memory_disabled:/);
    expect(t.agent({ baseRevision: 1, next: 'x' }).text).toMatch(/^memory_disabled:/);
  });
});

// ── 整合：真的 hub、假 daemon ────────────────────────────

interface Board {
  cookie: string;
  daemon: Peer;
  machineId: string;
}

async function board(): Promise<Board> {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie);
  return { cookie, daemon, machineId };
}

async function startSession(b: Board, over: Partial<SessionSpec>): Promise<string> {
  const res = await hub.api('POST', '/api/sessions', {
    cookie: b.cookie,
    body: { ...spec(over), machineId: b.machineId },
  });
  expect(res.status).toBe(200);
  const create = await b.daemon.next('session.create', (m) => m.sessionId === res.body.id);
  b.daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { status: 'waiting_input', cwd: '/fake/project' }),
  });
  await until(() => get(res.body.id)?.status === 'waiting_input', 'session started');
  return res.body.id as string;
}

const get = (id: string) => hub.running.store.getSession(id);

async function ask(
  b: Board,
  tool: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<{ ok: boolean; text: string }> {
  const requestId = randomUUID();
  b.daemon.send({ type: 'dispatch.request', requestId, sessionId, tool, args });
  const reply = await b.daemon.next('dispatch.reply', (m) => m.requestId === requestId);
  return { ok: reply.ok as boolean, text: reply.text as string };
}

async function team(b: Board) {
  const lead = await startSession(b, { name: 'tw-lead' });
  const worker = await startSession(b, { name: 'tw-impl' });
  const created = await hub.api('POST', '/api/teams', {
    cookie: b.cookie,
    body: { name: '台股', goal: 'G', doneCriteria: 'D', color: 'teal', contextMd: 'TEAM' },
  });
  const teamId = created.body.id as string;
  for (const [id, role] of [
    [lead, 'lead'],
    [worker, 'worker'],
  ] as const) {
    await hub.api('PUT', `/api/teams/${teamId}/members/${id}`, {
      cookie: b.cookie,
      body: { role },
    });
  }
  return { lead, worker, teamId };
}

const setStatus = async (b: Board, id: string, status: string) => {
  b.daemon.send({
    type: 'session.runtime',
    session: runtime(id, { status: status as never, cwd: '/fake/project' }),
  });
  await until(() => get(id)?.status === status, `status ${status}`);
};

const textsTo = (b: Board, sessionId: string) =>
  b.daemon.messages
    .filter((m) => m.type === 'terminal.input' && m.sessionId === sessionId && m.data !== '\r')
    .map((m) => String(m.data));

describe('進度卡整合（MCP 經 daemon、REST、WS）', () => {
  it('hub.welcome 帶 memory（預設開），改設定重送；daemon features 宣告 mcp.memory 不影響', async () => {
    const b = await board();
    const welcome = b.daemon.of('hub.welcome');
    expect(welcome.length === 0 || welcome.at(-1)!.memory === true).toBe(true);
    b.daemon.clear();
    const res = await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { memory: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.memory).toBe(false);
    expect(res.body.dispatch).toBe(true);
    const next = await b.daemon.next('hub.welcome');
    expect(next).toMatchObject({ memory: false, dispatch: true });
  });

  it('隊長 get_progress → update_progress：畫布（WS）1 秒內收到，audit 有 progress.update（source mcp）', async () => {
    const b = await board();
    const { lead, teamId } = await team(b);
    const client = await hub.client(b.cookie);
    const empty = JSON.parse((await ask(b, 'get_progress', {}, lead)).text);
    expect(empty).toMatchObject({
      team: '台股',
      revision: 0,
      next: '',
      goal: 'G',
      contextMd: 'TEAM',
    });

    // GM 先在網頁寫 rev 1。
    const put = await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 0, status: 'S', next: 'N', blockers: '', gmNotes: 'fee' },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      revision: 1,
      next: 'N',
      updatedBy: { kind: 'user', name: 'owner' },
    });
    await client.next('progress.updated', (m) => (m.card as ProgressCard).revision === 1);

    const started = Date.now();
    const reply = await ask(b, 'update_progress', { baseRevision: 1, next: 'X' }, lead);
    expect(reply.ok, reply.text).toBe(true);
    const pushed = await client.next(
      'progress.updated',
      (m) => (m.card as ProgressCard).next === 'X',
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pushed.card).toMatchObject({
      teamId,
      revision: 2,
      updatedBy: { kind: 'session', id: lead, name: 'tw-lead' },
    });
    const audit = await hub.api('GET', '/api/audit?action=progress.update', { cookie: b.cookie });
    const entries = audit.body as { sessionId: string | null; detail: string }[];
    expect(entries.map((e) => JSON.parse(e.detail).source)).toEqual(['mcp', 'web']);
    expect(entries[0]!.sessionId).toBe(lead);
    // audit 不存欄位全文。
    expect(entries[0]!.detail).not.toContain('"X"');
    expect(JSON.parse(entries[0]!.detail)).toMatchObject({
      fields: ['next'],
      lengths: { next: 1 },
    });

    // 重新整理（新的連線）：board.state 帶著卡片。
    const again = await hub.client(b.cookie);
    expect(again).toBeDefined();
    const state = await hub.api('GET', `/api/teams/${teamId}/progress`, { cookie: b.cookie });
    expect(state.body).toMatchObject({ revision: 2, next: 'X', gmNotes: 'fee' });
    const list = await hub.api('GET', '/api/progress?zoneId=main', { cookie: b.cookie });
    expect((list.body as ProgressCard[]).map((c) => c.teamId)).toEqual([teamId]);
    const elsewhere = await hub.api('GET', '/api/progress?zoneId=nope', { cookie: b.cookie });
    expect(elsewhere.body).toEqual([]);
  });

  it('REST 衝突 409 progress_conflict（detail 是 ProgressConflict）；欄位太長 400；不存在的團隊 404', async () => {
    const b = await board();
    const { lead, teamId } = await team(b);
    await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 0, next: 'A' },
    });
    expect((await ask(b, 'update_progress', { baseRevision: 1, next: 'agent' }, lead)).ok).toBe(
      true,
    );
    const res = await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 1, next: 'GM' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('progress_conflict');
    expect(res.body.detail.fields).toEqual([
      {
        field: 'next',
        base: 'A',
        current: 'agent',
        by: { kind: 'session', id: lead, name: 'tw-lead' },
      },
    ]);
    expect(res.body.detail.card.revision).toBe(2);
    const long = await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 2, status: 'x'.repeat(2001) },
    });
    expect(long.status).toBe(400);
    expect(long.body.code).toBe('field_too_long');
    const missing = await hub.api('GET', `/api/teams/${randomUUID()}/progress`, {
      cookie: b.cookie,
    });
    expect(missing.status).toBe(404);
    const revisions = await hub.api('GET', `/api/teams/${teamId}/progress/revisions`, {
      cookie: b.cookie,
    });
    expect((revisions.body as { revision: number }[]).map((r) => r.revision)).toEqual([2, 1]);
  });

  it('設定關掉：已掛著的呼叫回 memory_disabled；不認得的 session 回 no_card_owner', async () => {
    const b = await board();
    const { lead } = await team(b);
    await hub.api('PATCH', '/api/settings', { cookie: b.cookie, body: { memory: false } });
    expect((await ask(b, 'get_progress', {}, lead)).text).toMatch(/^memory_disabled:/);
    expect((await ask(b, 'get_progress', {}, randomUUID())).text).toMatch(/^no_card_owner:/);
    // 派工照常。
    expect((await ask(b, 'list_members', {}, lead)).ok).toBe(true);
  });

  it('帶入進度卡給 RUN 的成員：排隊中；變 ASK 後收到一行，內容與卡片一致、無換行；audit 有 terminal.input', async () => {
    const b = await board();
    const { worker, teamId } = await team(b);
    await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: {
        baseRevision: 0,
        status: '回測 2015–2020 完成\n- Sharpe 0.8',
        next: '補 2021–2024',
        blockers: '',
        gmNotes: 'sk-ant-demo03-abcdefghijklmnopqrstuvwxyz0123456789 只是範例',
      },
    });
    await setStatus(b, worker, 'running');
    const res = await hub.api('POST', `/api/teams/${teamId}/progress/deliver`, {
      cookie: b.cookie,
      body: { sessionId: worker },
    });
    expect(res.status).toBe(200);
    const sent = res.body as Broadcast;
    expect(sent).toMatchObject({ kind: 'progress', teamId, cardKey: `team:${teamId}` });
    expect(sent.targets).toEqual([expect.objectContaining({ sessionId: worker, state: 'queued' })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(textsTo(b, worker)).toEqual([]);
    await setStatus(b, worker, 'waiting_input');
    const line =
      '[Progress card: 台股] Status: 回測 2015–2020 完成 - Sharpe 0.8 | Next: 補 2021–2024 | GM notes: sk-ant-demo03-abcdefghijklmnopqrstuvwxyz0123456789 只是範例';
    await until(() => textsTo(b, worker).length === 1, 'delivered');
    expect(textsTo(b, worker)).toEqual([line]);
    const audit = await hub.api('GET', `/api/audit?sessionId=${worker}`, { cookie: b.cookie });
    const actions = (audit.body as { action: string; detail: string }[]).map((e) => e.action);
    expect(actions).toContain('progress.deliver');
    await until(
      () => hub.running.store.listAudit({ action: 'terminal.input', sessionId: worker }).length > 0,
    );
    expect(
      hub.running.store.listAudit({ action: 'terminal.input', sessionId: worker })[0]!.detail,
    ).toContain('[Progress card: 台股]');
  });

  it('PERM 的對象在權限處理前不收到任何字元；請隊長更新送固定字串；卡片空白不能帶入', async () => {
    const b = await board();
    const { lead, worker, teamId } = await team(b);
    const empty = await hub.api('POST', `/api/teams/${teamId}/progress/deliver`, {
      cookie: b.cookie,
      body: { sessionId: worker },
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('progress_empty');
    await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 0, next: 'N' },
    });
    await setStatus(b, worker, 'waiting_permission');
    await hub.api('POST', `/api/teams/${teamId}/progress/deliver`, {
      cookie: b.cookie,
      body: { sessionId: worker },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      b.daemon.messages.filter((m) => m.type === 'terminal.input' && m.sessionId === worker),
    ).toEqual([]);

    const askRes = await hub.api('POST', `/api/teams/${teamId}/progress/ask-update`, {
      cookie: b.cookie,
    });
    expect(askRes.status).toBe(200);
    expect(askRes.body).toMatchObject({ kind: 'ask_update', text: PROGRESS_ASK_UPDATE_PROMPT });
    await until(() => textsTo(b, lead).length === 1, 'ask delivered');
    expect(textsTo(b, lead)).toEqual([PROGRESS_ASK_UPDATE_PROMPT]);
    await hub.api('DELETE', `/api/teams/${teamId}/members/${lead}`, { cookie: b.cookie });
    const noLead = await hub.api('POST', `/api/teams/${teamId}/progress/ask-update`, {
      cookie: b.cookie,
    });
    expect(noLead.status).toBe(400);
    expect(noLead.body.code).toBe('no_lead');
  });

  it('單獨 session 的卡：REST 讀寫、帶入給別的 session；團隊刪掉時卡片一起刪', async () => {
    const b = await board();
    const solo = await startSession(b, { name: 'solo' });
    const other = await startSession(b, { name: 'other' });
    const put = await hub.api('PUT', `/api/sessions/${solo}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 0, next: 'resume parser work' },
    });
    expect(put.body).toMatchObject({ sessionId: solo, teamId: null, revision: 1 });
    const res = await hub.api('POST', `/api/sessions/${solo}/progress/deliver`, {
      cookie: b.cookie,
      body: { sessionId: other },
    });
    expect(res.body).toMatchObject({ teamId: null, kind: 'progress', cardKey: `session:${solo}` });
    await until(() => textsTo(b, other).length === 1, 'delivered');
    expect(textsTo(b, other)).toEqual(['[Progress card: solo] Next: resume parser work']);

    const { teamId } = await team(b);
    await hub.api('PUT', `/api/teams/${teamId}/progress`, {
      cookie: b.cookie,
      body: { baseRevision: 0, next: 'x' },
    });
    expect(hub.running.store.listProgress()).toHaveLength(2);
    await hub.api('DELETE', `/api/teams/${teamId}`, { cookie: b.cookie });
    expect(hub.running.store.listProgress().map((c) => c.sessionId)).toEqual([solo]);
  });
});
