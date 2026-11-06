// session 派工（CONTRACTS §11）：真的 hub、假 daemon。派工請求 → 開成員並加入團隊 → 送工作 → 成員回合結束 →
// 結果送回呼叫者（一份工作一次）。另外驗權限順序、上限、命名、範圍與身分、設定關掉、結果限流。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DISPATCH_SPAWN_LIMIT, type Session, type SessionSpec } from '@agent-board/protocol';
import { openDatabase } from '../db';
import type { DeliveryItem } from '../delivery';
import {
  clampPermissionMode,
  DISPATCH_RESULT_MAX,
  DispatchEngine,
  memberName,
  resultMessage,
  workMessage,
} from '../dispatch';
import { Store } from '../store';
import { type Peer, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

// ── 純函式 ──────────────────────────────────────────────

describe('clampPermissionMode', () => {
  it('順序 plan < default < acceptEdits < auto／dontAsk < bypassPermissions；不比呼叫者寬', () => {
    expect(clampPermissionMode(undefined, 'acceptEdits', 'worker')).toEqual({
      mode: 'acceptEdits',
      clamped: false,
    });
    expect(clampPermissionMode(undefined, 'acceptEdits', 'reviewer')).toEqual({
      mode: 'plan',
      clamped: false,
    });
    // 呼叫者比角色預設嚴：照呼叫者，不算「被改」。
    expect(clampPermissionMode(undefined, 'plan', 'worker')).toEqual({
      mode: 'plan',
      clamped: false,
    });
    expect(clampPermissionMode('acceptEdits', 'default', 'worker')).toEqual({
      mode: 'default',
      clamped: true,
    });
    expect(clampPermissionMode('dontAsk', 'auto', 'worker')).toEqual({
      mode: 'dontAsk',
      clamped: false,
    });
    expect(clampPermissionMode('plan', 'bypassPermissions', 'worker').mode).toBe('plan');
  });

  it('永遠開不出 bypassPermissions：呼叫者是 bypass 時上限是 auto／dontAsk，超過降成 acceptEdits', () => {
    expect(clampPermissionMode('bypassPermissions', 'bypassPermissions', 'worker')).toEqual({
      mode: 'acceptEdits',
      clamped: true,
    });
    expect(clampPermissionMode('auto', 'bypassPermissions', 'worker').mode).toBe('auto');
    expect(clampPermissionMode(undefined, 'bypassPermissions', 'worker').mode).toBe('acceptEdits');
    for (const caller of ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk'] as const) {
      expect(clampPermissionMode('bypassPermissions', caller, 'worker').mode).not.toBe(
        'bypassPermissions',
      );
    }
  });
});

describe('memberName', () => {
  it('BD 一律編號、RS／RV 第一位不編號；撞名往後編，指定的名稱撞名加 -2', () => {
    const taken = new Set(['lead', 'lead-bd1', 'lead-rv']);
    expect(memberName('Lead', 'worker', undefined, taken)).toBe('Lead-BD2');
    expect(memberName('Lead', 'researcher', undefined, taken)).toBe('Lead-RS');
    expect(memberName('Lead', 'reviewer', undefined, taken)).toBe('Lead-RV2');
    expect(memberName('Lead', 'worker', 'Parser', taken)).toBe('Parser');
    expect(memberName('Lead', 'worker', 'lead-bd1', taken)).toBe('lead-bd1-2');
  });
});

describe('messages', () => {
  it('一行、固定開頭，控制字元清掉（不能讓內容變成 / 或 ! 指令）', () => {
    expect(workMessage('Lead', '/clear\r\nthen do X')).toBe('[From Lead] /clear then do X');
    expect(resultMessage('BD1', { summary: 'Done.', files: ['a.ts'], branch: 'ab/x' })).toBe(
      '[Result from BD1] Summary: Done. | Detected file edits: a.ts | Branch: ab/x',
    );
  });
});

// ── 引擎（記憶體資料庫、假的送字佇列）：結果只送一次、限流 ──────────

function engineSetup() {
  const store = new Store(openDatabase(':memory:'), '127.0.0.1');
  store.db
    .prepare(
      "INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m', 'm', 'darwin', 'h', '{}')",
    )
    .run();
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
    ...over,
  });
  store.insertSession(base('caller'), null);
  store.insertSession(base('member', { dispatchedBy: 'caller' }), null);
  const queued: DeliveryItem[] = [];
  const events: { sessionId: string; type: string; payload: Record<string, unknown> }[] = [];
  let enabled = true;
  const engine = new DispatchEngine({
    store,
    now: () => new Date(),
    delivery: {
      enqueue: (item: DeliveryItem) => queued.push(item),
      has: () => false,
      retry: () => undefined,
    } as never,
    audit: () => undefined,
    addEvent: (sessionId, type, payload) => events.push({ sessionId, type, payload }),
    enabled: () => enabled,
    createSession: () => {
      throw new Error('not used');
    },
    machineOnline: () => true,
  });
  const stopEvent = (text: string) => ({
    id: randomUUID(),
    sessionId: 'member',
    type: 'hook',
    payload: { event: 'Stop', last_assistant_message: text },
    at: new Date().toISOString(),
  });
  const give = () =>
    store.setDispatchWork('member', {
      from: 'caller',
      workId: randomUUID(),
      kind: 'send',
      at: new Date().toISOString(),
    });
  return { store, engine, queued, events, stopEvent, give, off: () => (enabled = false) };
}

describe('DispatchEngine：結果', () => {
  it('一份工作只回報一次；沒有派工的回合不送；結果送進呼叫者不算新工作', () => {
    const t = engineSetup();
    t.engine.onEvent(t.stopEvent('Nothing was assigned.'));
    expect(t.queued).toHaveLength(0);
    t.give();
    t.engine.onEvent(t.stopEvent('Fixed the parser. It now handles tabs.'));
    t.engine.onEvent(t.stopEvent('Another turn.'));
    expect(t.queued.map((q) => [q.targetId, q.message])).toEqual([
      [
        'caller',
        '[Result from member] Summary: Fixed the parser. | Detected file edits: none (edits made through shell commands are not tracked) | Branch: unknown',
      ],
    ]);
    expect(t.store.dispatchWork('member')).toBeNull();
    // 呼叫者自己的回合結束：它手上沒有派工的工作，什麼都不送。
    t.engine.onEvent({ ...t.stopEvent('ok'), sessionId: 'caller' });
    expect(t.queued).toHaveLength(1);
  });

  it(`每個呼叫者 10 分鐘最多 ${DISPATCH_RESULT_MAX} 則結果，超過擋下（rate_limit）`, () => {
    const t = engineSetup();
    for (let i = 0; i < DISPATCH_RESULT_MAX + 2; i += 1) {
      t.give();
      t.engine.onEvent(t.stopEvent(`Turn ${i} finished well.`));
    }
    expect(t.queued).toHaveLength(DISPATCH_RESULT_MAX);
    expect(
      t.events.filter((e) => e.type === 'dispatch.blocked' && e.payload.reason === 'rate_limit'),
    ).toHaveLength(2);
  });

  it('呼叫者已封存或設定關掉：不送，記成擋下', () => {
    const t = engineSetup();
    t.off();
    t.give();
    t.engine.onEvent(t.stopEvent('Done here.'));
    expect(t.queued).toHaveLength(0);
    expect(t.events.at(-1)).toMatchObject({
      type: 'dispatch.blocked',
      payload: { reason: 'dispatch_disabled' },
    });
    expect(t.engine.handle('caller', 'list_members', {}).text).toMatch(/^dispatch_disabled:/);
  });
});

// ── 整合：真的 hub、假 daemon ────────────────────────────

interface Board {
  cookie: string;
  daemon: Peer;
  machineId: string;
  caller: string;
}

const CWD = '/fake/project';

async function board(over: Partial<SessionSpec> = {}, repoRoot: string | null = CWD) {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie);
  const caller = await startSession(
    { cookie, daemon, machineId, caller: '' },
    { name: 'Lead', cwd: CWD, ...over },
    repoRoot,
  );
  daemon.clear();
  return { cookie, daemon, machineId, caller } satisfies Board;
}

async function startSession(
  b: Board,
  over: Partial<SessionSpec>,
  repoRoot: string | null = CWD,
): Promise<string> {
  const res = await hub.api('POST', '/api/sessions', {
    cookie: b.cookie,
    body: { ...spec(over), machineId: b.machineId },
  });
  expect(res.status).toBe(200);
  const create = await b.daemon.next('session.create', (m) => m.sessionId === res.body.id);
  b.daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { status: 'waiting_input', cwd: over.cwd ?? CWD, repoRoot }),
  });
  await until(() => get(res.body.id)?.status === 'waiting_input', 'session started');
  return res.body.id as string;
}

const get = (id: string) => hub.running.store.getSession(id);

async function ask(
  b: Board,
  tool: string,
  args: Record<string, unknown> = {},
  sessionId = b.caller,
  daemon = b.daemon,
): Promise<{ ok: boolean; text: string }> {
  const requestId = randomUUID();
  daemon.send({ type: 'dispatch.request', requestId, sessionId, tool, args });
  const reply = await daemon.next('dispatch.reply', (m) => m.requestId === requestId);
  return { ok: reply.ok as boolean, text: reply.text as string };
}

const json = (reply: { ok: boolean; text: string }) => {
  expect(reply.ok, reply.text).toBe(true);
  return JSON.parse(reply.text) as Record<string, unknown>;
};

/** 派工開成員，假 daemon 確認開好（等輸入）。回傳成員 id 與收到的 spec。 */
async function spawnMember(b: Board, args: Record<string, unknown>) {
  const reply = json(await ask(b, 'spawn_member', args));
  const create = await b.daemon.next(
    'session.create',
    (m) => (m.spec as SessionSpec).name === reply.name,
  );
  const id = create.sessionId as string;
  const s = create.spec as SessionSpec;
  b.daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(id, {
      status: 'waiting_input',
      cwd: s.useWorktree ? `/fake/wt/${s.name}` : CWD,
      worktreePath: s.useWorktree ? `/fake/wt/${s.name}` : null,
      branch: s.useWorktree ? `ab/${s.name}` : null,
      repoRoot: s.useWorktree ? `/fake/wt/${s.name}` : CWD,
    }),
  });
  await until(() => get(id)?.status === 'waiting_input', 'member started');
  return { id, spec: s, reply };
}

const sendEvent = (b: Board, sessionId: string, type: string, payload: object) =>
  b.daemon.send({
    type: 'session.event',
    event: { id: randomUUID(), sessionId, type, payload, at: new Date().toISOString() },
  });

const stop = (b: Board, sessionId: string, message: string) =>
  sendEvent(b, sessionId, 'hook', { event: 'Stop', last_assistant_message: message });

const setStatus = async (b: Board, id: string, status: string) => {
  const s = get(id)!;
  b.daemon.send({
    type: 'session.runtime',
    session: runtime(id, {
      status: status as never,
      cwd: s.cwd,
      worktreePath: s.worktreePath,
      branch: s.branch,
      repoRoot: s.repoRoot,
    }),
  });
  await until(() => get(id)?.status === status, `status ${status}`);
};

const textsTo = (b: Board, sessionId: string) =>
  b.daemon.messages
    .filter((m) => m.type === 'terminal.input' && m.sessionId === sessionId && m.data !== '\r')
    .map((m) => String(m.data));

const enterTo = (b: Board, sessionId: string) =>
  b.daemon.messages.filter(
    (m) => m.type === 'terminal.input' && m.sessionId === sessionId && m.data === '\r',
  ).length;

const eventsOf = (id: string, prefix = 'dispatch.') =>
  hub.running.store.listEvents(id).filter((e) => e.type.startsWith(prefix));

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('派工：開成員、送工作、結果自動送回', () => {
  it('spawn → 成員建立並加入新團隊 → 回合結束 → 結果送回呼叫者一次 → send_task → 再回報一次', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    expect(json(await ask(b, 'list_members'))).toEqual({
      teams: [],
      spawned: { live: 0, limit: DISPATCH_SPAWN_LIMIT },
    });

    const {
      id: bd,
      spec: bdSpec,
      reply,
    } = await spawnMember(b, {
      role: 'worker',
      prompt: 'Fix the login redirect.\nAdd a test.',
    });
    expect(reply).toMatchObject({
      name: 'Lead-BD1',
      team: 'Lead',
      teamCreated: true,
      role: 'worker',
      permissionMode: 'acceptEdits',
      readOnly: false,
      useWorktree: true,
    });
    expect(bdSpec).toMatchObject({
      name: 'Lead-BD1',
      cwd: CWD,
      useWorktree: true,
      permissionMode: 'acceptEdits',
      readOnly: false,
      firstPrompt: '[From Lead] Fix the login redirect. Add a test.',
    });
    expect(get(bd)?.dispatchedBy).toBe(b.caller);
    // 團隊：以呼叫者命名、它是隊長、成員是 worker。
    const teams = hub.running.store.listTeams();
    expect(teams.map((t) => t.name)).toEqual(['Lead']);
    expect(
      hub.running.store
        .listTeamMembers(teams[0]!.id)
        .map((m) => [m.sessionId, m.role])
        .sort(),
    ).toEqual(
      [
        [b.caller, 'lead'],
        [bd, 'worker'],
      ].sort(),
    );
    expect(
      eventsOf(bd).map((e) => [e.type, e.payload.fromSessionId, e.payload.toSessionId]),
    ).toEqual([['dispatch.spawn', b.caller, bd]]);

    const listed = json(await ask(b, 'list_members')) as {
      teams: { members: { name: string; dispatchedBy: string | null; working: boolean }[] }[];
    };
    expect(listed.teams[0]!.members.find((m) => m.name === 'Lead-BD1')).toMatchObject({
      dispatchedBy: 'Lead',
      working: true,
    });

    // 成員做完第一個回合：結果送回呼叫者。
    sendEvent(b, bd, 'file.changed', { path: '/fake/wt/Lead-BD1/src/login.ts' });
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Fixed the redirect loop in login.ts. Also added a regression test.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => enterTo(b, b.caller) === 1, 'result delivered');
    expect(textsTo(b, b.caller)).toEqual([
      '[Result from Lead-BD1] Summary: Fixed the redirect loop in login.ts. | Detected file edits: /fake/wt/Lead-BD1/src/login.ts | Branch: ab/Lead-BD1',
    ]);
    expect(eventsOf(bd).map((e) => e.type)).toEqual(['dispatch.spawn', 'dispatch.result']);
    expect(eventsOf(b.caller).map((e) => e.type)).toEqual(['dispatch.result_delivered']);

    // 同一份工作不會再回報：成員再結束一個回合（例如使用者自己問它問題）不送。
    await setStatus(b, b.caller, 'running');
    await setStatus(b, b.caller, 'waiting_input');
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Answered a question from the user.');
    await setStatus(b, bd, 'waiting_input');
    await settle();
    expect(textsTo(b, b.caller)).toHaveLength(1);

    // send_task：送進成員（固定開頭、一行），送達後成員手上有工作，回合結束再回報一次。
    const sent = json(
      await ask(b, 'send_task', { member: 'lead-bd1', text: 'Now update the docs.' }),
    );
    expect(sent).toMatchObject({ member: 'Lead-BD1', state: 'sent' });
    await until(() => enterTo(b, bd) === 1, 'task delivered');
    expect(textsTo(b, bd)).toEqual(['[From Lead] Now update the docs.']);
    expect(eventsOf(b.caller).map((e) => e.type)).toContain('dispatch.send');
    await until(() => eventsOf(bd).some((e) => e.type === 'dispatch.delivered'), 'delivered event');
    expect(hub.running.store.dispatchWork(bd)?.from).toBe(b.caller);
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Updated README with the new flow.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => enterTo(b, b.caller) === 2, 'second result');
    expect(textsTo(b, b.caller)[1]).toMatch(
      /^\[Result from Lead-BD1\] Summary: Updated README with the new flow\. \| Detected file edits: none/,
    );

    const result = json(await ask(b, 'get_result', { member: 'Lead-BD1' }));
    expect(result).toMatchObject({
      member: 'Lead-BD1',
      working: false,
      summary: 'Updated README with the new flow.',
      branch: 'ab/Lead-BD1',
    });

    // audit：每個動作都有，user 是系統（null），沒有密鑰之類的東西。
    const actions = hub.running.store
      .listAudit({ limit: 1000 })
      .filter((a) => a.action.startsWith('dispatch.'));
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set([
        'dispatch.spawn',
        'dispatch.result',
        'dispatch.result_delivered',
        'dispatch.send',
        'dispatch.delivered',
      ]),
    );
    expect(actions.every((a) => a.userId === null)).toBe(true);
  });

  it('成員還沒回報上一份工作時，新的工作等它回合結束才送（不和結果混在一起）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const { id: rs } = await spawnMember(b, { role: 'researcher', prompt: 'Survey the options.' });
    await setStatus(b, rs, 'running');
    const queued = json(
      await ask(b, 'send_task', { member: 'Lead-RS', text: 'Then compare costs.' }),
    );
    expect(queued.state).toBe('queued');
    // 狀態先回到等輸入（daemon 的 runtime 常比 Stop 事件早到）：還不能送。
    await setStatus(b, rs, 'waiting_input');
    await settle();
    expect(textsTo(b, rs)).toEqual([]);
    stop(b, rs, 'Three options found, see notes.');
    await until(() => textsTo(b, rs).length === 1, 'queued task delivered after Stop');
    expect(textsTo(b, rs)).toEqual(['[From Lead] Then compare costs.']);
    await until(() => enterTo(b, b.caller) === 1, 'first result');
    expect(textsTo(b, b.caller)[0]).toMatch(
      /^\[Result from Lead-RS\] Summary: Three options found/,
    );
  });

  it('研究與審查唯讀、不開 worktree、預設 plan；最多 4 個，第 5 個回 limit_reached', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const names: string[] = [];
    for (let i = 0; i < DISPATCH_SPAWN_LIMIT; i += 1) {
      const { spec: s } = await spawnMember(b, {
        role: i % 2 === 0 ? 'researcher' : 'reviewer',
        prompt: `Look at area ${i}.`,
      });
      expect(s).toMatchObject({ readOnly: true, useWorktree: false, permissionMode: 'plan' });
      names.push(s.name);
    }
    expect(names).toEqual(['Lead-RS', 'Lead-RV', 'Lead-RS2', 'Lead-RV2']);
    const fifth = await ask(b, 'spawn_member', { role: 'researcher', prompt: 'One more.' });
    expect(fifth.ok).toBe(false);
    expect(fifth.text).toMatch(/^limit_reached: You already have 4 live members/);
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('權限：不比呼叫者寬、不給 bypassPermissions；唯讀呼叫者不能開寫入者；派工開的成員不能再開', async () => {
    const b = await board({ permissionMode: 'default' });
    const {
      spec: s,
      reply,
      id: bd,
    } = await spawnMember(b, {
      role: 'worker',
      prompt: 'Refactor.',
      permissionMode: 'acceptEdits',
    });
    expect(s.permissionMode).toBe('default');
    expect(reply.note).toMatch(/lowered to default/);
    const bypass = await ask(b, 'spawn_member', {
      role: 'worker',
      prompt: 'x',
      permissionMode: 'bypassPermissions',
    });
    expect(bypass.text).toMatch(/^permission_not_allowed:/);
    const nested = await ask(b, 'spawn_member', { role: 'researcher', prompt: 'x' }, bd);
    expect(nested.text).toMatch(/^nested_spawn:.*Lead/);
    const bad = await ask(b, 'spawn_member', { role: 'lead', prompt: 'x' });
    expect(bad.text).toMatch(/^invalid_arguments:/);

    const ro = await startSession(b, { name: 'Reader', cwd: '/fake/other', readOnly: true });
    const roWorker = await ask(b, 'spawn_member', { role: 'worker', prompt: 'x' }, ro);
    expect(roWorker.text).toMatch(/^read_only_caller:/);
  });

  it('同資料夾寫入者規則：不是 git 不能開 worktree；不開 worktree 的寫入者和呼叫者衝突', async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, null);
    const noGit = await ask(b, 'spawn_member', { role: 'worker', prompt: 'x' });
    expect(noGit.text).toMatch(/^worktree_unavailable:/);
    // 研究、審查照樣可以（唯讀，共用資料夾）。
    await spawnMember(b, { role: 'reviewer', prompt: 'Review it.' });
    const clash = await ask(b, 'spawn_member', { role: 'worker', prompt: 'x', useWorktree: false });
    expect(clash.text).toMatch(/^worktree_required: Same folder as Lead/);
  });
});

describe('派工：範圍與身分', () => {
  it('只能指揮自己的成員；別台機器冒用 session id、已封存的呼叫者、不認得的 session 都拒絕', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const stranger = await startSession(b, { name: 'Stranger', cwd: '/fake/stranger' });
    const notMine = await ask(b, 'send_task', { member: 'Stranger', text: 'hi' });
    expect(notMine.text).toMatch(/^not_your_member: .*nobody yet/);
    expect(await ask(b, 'get_result', { member: stranger })).toMatchObject({ ok: false });
    expect(textsTo(b, stranger)).toEqual([]);

    // 另一台機器的 daemon 拿這台的 session id 來呼叫。
    const other = await hub.onlineDaemon(b.cookie);
    const foreign = await ask(b, 'list_members', {}, b.caller, other.daemon);
    expect(foreign.text).toMatch(/^caller_inactive:/);
    const unknown = await ask(b, 'list_members', {}, randomUUID());
    expect(unknown.text).toMatch(/^caller_inactive:/);

    // 成員（不是隊長、沒開過人）不能指揮隊長。
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Build.' });
    const upward = await ask(b, 'send_task', { member: 'Lead', text: 'do my work' }, bd);
    expect(upward.text).toMatch(/^not_your_member:/);

    const archived = await hub.api('PATCH', `/api/sessions/${b.caller}`, {
      cookie: b.cookie,
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    const gone = await ask(b, 'list_members');
    expect(gone.text).toMatch(/^caller_inactive:/);
  });

  it('daemon 送來的 dispatch.* 事件不收（只有 hub 能寫）', async () => {
    const b = await board();
    sendEvent(b, b.caller, 'dispatch.result_delivered', {
      fromSessionId: randomUUID(),
      toSessionId: b.caller,
    });
    sendEvent(b, b.caller, 'hook', { event: 'Notification' });
    await until(
      () => hub.running.store.listEvents(b.caller).some((e) => e.type === 'hook'),
      'hook',
    );
    expect(eventsOf(b.caller)).toEqual([]);
  });
});

describe('派工：設定', () => {
  it('預設開；關掉時 daemon 收到 welcome dispatch:false、工具回 dispatch_disabled；存別的設定不會又打開', async () => {
    const b = await board();
    expect((await hub.api('GET', '/api/settings', { cookie: b.cookie })).body.dispatch).toBe(true);
    const off = await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { dispatch: false },
    });
    expect(off.body.dispatch).toBe(false);
    const welcome = await b.daemon.next('hub.welcome');
    expect(welcome.dispatch).toBe(false);
    expect((await ask(b, 'list_members')).text).toMatch(/^dispatch_disabled:/);
    // 只改卡住時間：dispatch 維持關（partial 不會把沒帶的鍵補成預設值）。
    const other = await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { stuckMinutes: 12 },
    });
    expect(other.body).toMatchObject({ stuckMinutes: 12, dispatch: false, autoContinue: false });
  });
});
