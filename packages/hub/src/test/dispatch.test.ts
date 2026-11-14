// session 派工（CONTRACTS §11）：真的 hub、假 daemon。派工請求 → 開成員並加入團隊 → 送工作 → 成員回合結束 →
// 結果送回呼叫者（一份工作一次）。另外驗權限順序、上限、命名、範圍與身分、設定關掉、結果限流。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_STAFF_DEFAULT,
  DISPATCH_SPAWN_RATE_MAX,
  NOT_GIT_BLOCKED_EVENT,
  NOT_GIT_WRITER_GUIDE,
  type Session,
  type SessionSpec,
} from '@agent-board/protocol';
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
import type { Timing } from '../hub';
import { Store } from '../store';
import {
  hello,
  PASSWORD,
  perEventPush,
  type Peer,
  runtime,
  spec,
  startHub,
  until,
  type TestHub,
} from './helpers';

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
    // 測試預設每步問（Q5）。
    expect(clampPermissionMode(undefined, 'acceptEdits', 'tester')).toEqual({
      mode: 'default',
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
    zoneId: 'main',
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
    autoStaff: () => AUTO_STAFF_DEFAULT,
    accountLimited: () => false,
    archiveMember: () => undefined,
    teamActivity: () => undefined,
    teamChanged: () => undefined,
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

describe('DispatchEngine：等隊長／等成員結果（GM 2026-11-11）', () => {
  it('隊長有派出去的工作是 members；成員 Stop 後結果送回是 lead；結果送到前隊長還是 members', () => {
    const t = engineSetup();
    t.give();
    expect(t.store.getSession('caller')?.awaiting).toBe('members');
    // 成員還沒 Stop、但已經 waiting_input（daemon 的狀態比 Stop 早到）：先算等隊長，不先跳 ASK。
    expect(t.store.getSession('member')?.awaiting).toBe('lead');
    t.engine.onEvent(t.stopEvent('Done.'));
    expect(t.store.dispatchWork('member')).toBeNull();
    expect(t.store.getSession('member')?.awaiting).toBe('lead');
    expect(t.store.getSession('caller')?.awaiting).toBe('members');
    t.queued[0]!.delivered!();
    expect(t.store.getSession('caller')?.awaiting).toBeUndefined();
    // 只有 waiting_input 才有：狀態換了就不帶。
    const running = t.store.getSession('member')!;
    expect(t.store.withAwaiting({ ...running, status: 'running' }).awaiting).toBeUndefined();
    // 重啟後還在（新的 Store 讀同一個資料庫）。
    expect(new Store(t.store.db, '127.0.0.1').getSession('member')?.awaiting).toBe('lead');
  });

  it('結果沒送回（呼叫者已封存、設定關掉、限流）：不標等隊長，照常 ASK', () => {
    const t = engineSetup();
    t.off();
    t.give();
    t.engine.onEvent(t.stopEvent('Done here.'));
    expect(t.store.getSession('member')?.awaiting).toBeUndefined();

    const u = engineSetup();
    u.give();
    u.store.updateSession({ ...u.store.getSession('caller')!, archived: true });
    u.engine.onEvent(u.stopEvent('Done here.'));
    expect(u.queued).toHaveLength(0);
    expect(u.store.getSession('member')?.awaiting).toBeUndefined();
  });

  it('S3 排隊中只記在記憶體（hub 重啟就沒有），送到才寫 settings；啟動時清掉指向已不在的隊長的記錄', () => {
    const t = engineSetup();
    t.give();
    t.engine.onEvent(t.stopEvent('Done.'));
    expect(t.store.getSession('member')?.awaiting).toBe('lead');
    expect(t.store.awaitingLeadOf('member')).toBeNull();
    expect(new Store(t.store.db, '127.0.0.1').getSession('member')?.awaiting).toBeUndefined();
    t.queued[0]!.delivered!();
    expect(new Store(t.store.db, '127.0.0.1').getSession('member')?.awaiting).toBe('lead');
    t.store.updateSession({ ...t.store.getSession('caller')!, archived: true });
    const fresh = new Store(t.store.db, '127.0.0.1');
    expect(fresh.pruneAwaitingLead()).toEqual(['member']);
    expect(fresh.awaitingLeadOf('member')).toBeNull();
  });

  it('W3 隊長離線時成員不算等隊長（記錄留著），連回來又是等隊長', () => {
    const t = engineSetup();
    t.give();
    t.engine.onEvent(t.stopEvent('Done.'));
    t.queued[0]!.delivered!();
    const caller = t.store.getSession('caller')!;
    const offline = { ...caller, status: 'offline' as const };
    t.store.updateSession(offline);
    t.engine.onSessionChange(caller, offline);
    expect(t.store.getSession('member')?.awaiting).toBeUndefined();
    expect(t.store.awaitingLeadOf('member')).toBe('caller');
    t.store.updateSession(caller);
    t.engine.onSessionChange(offline, caller);
    expect(t.store.getSession('member')?.awaiting).toBe('lead');
  });

  it('成員開始下一個回合就清掉；隊長結束或封存後，在等它的成員改回照常', () => {
    const t = engineSetup();
    t.give();
    t.engine.onEvent(t.stopEvent('Done.'));
    const member = t.store.getSession('member')!;
    t.engine.onSessionChange(member, { ...member, status: 'running' });
    expect(t.store.awaitingLeadOf('member')).toBeNull();

    const u = engineSetup();
    u.give();
    u.engine.onEvent(u.stopEvent('Done.'));
    expect(u.store.getSession('member')?.awaiting).toBe('lead');
    const caller = u.store.getSession('caller')!;
    const ended = { ...caller, endedAt: new Date().toISOString() };
    u.store.updateSession(ended);
    u.engine.onSessionChange(caller, ended);
    expect(u.store.awaitingLeadOf('member')).toBeNull();
    expect(u.store.getSession('member')?.awaiting).toBeUndefined();
  });
});

// ── 整合：真的 hub、假 daemon ────────────────────────────

interface Board {
  cookie: string;
  daemon: Peer;
  machineId: string;
  caller: string;
  /** 機器 token（重啟 hub 後重新連 daemon 用）。 */
  token?: string;
}

const CWD = '/fake/project';

async function board(
  over: Partial<SessionSpec> = {},
  repoRoot: string | null = CWD,
  timing: Partial<Timing> = {},
) {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20, ...timing } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  const caller = await startSession(
    { cookie, daemon, machineId, caller: '' },
    { name: 'Lead', cwd: CWD, ...over },
    repoRoot,
  );
  daemon.clear();
  return { cookie, daemon, machineId, caller, token } satisfies Board;
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
  const reply = json(await ask(b, 'spawn_member', { reason: 'The task needs it.', ...args }));
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

/** 成員把手上的派工做完（回合結束、結果送回），之後才能封存。 */
async function finishWork(b: Board, id: string, message = 'Done.') {
  await setStatus(b, id, 'running');
  stop(b, id, message);
  await setStatus(b, id, 'waiting_input');
  await until(() => hub.running.store.dispatchWork(id) === null, 'work reported');
}

describe('派工：開成員、送工作、結果自動送回', () => {
  it('spawn → 成員建立並加入新團隊 → 回合結束 → 結果送回呼叫者一次 → send_task → 再回報一次', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    expect(json(await ask(b, 'list_members'))).toEqual({
      teams: [],
      guide: expect.stringMatching(/^You have no team yet\..*size limit 12/),
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

  it(`研究與審查唯讀、不開 worktree、預設 plan；同一團隊 10 分鐘最多新增 ${DISPATCH_SPAWN_RATE_MAX} 位`, async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const names: string[] = [];
    for (let i = 0; i < DISPATCH_SPAWN_RATE_MAX; i += 1) {
      const { spec: s } = await spawnMember(b, {
        role: i % 2 === 0 ? 'researcher' : 'reviewer',
        prompt: `Look at area ${i}.`,
      });
      expect(s).toMatchObject({ readOnly: true, useWorktree: false, permissionMode: 'plan' });
      names.push(s.name);
    }
    expect(names).toEqual(['Lead-RS', 'Lead-RV', 'Lead-RS2', 'Lead-RV2']);
    const fifth = await ask(b, 'spawn_member', {
      reason: 'One more.',
      role: 'researcher',
      prompt: 'One more.',
    });
    // 第五位：不直接拒絕，改成向使用者申請（§23），沒有開 session。
    expect(json(fifth)).toMatchObject({ status: 'pending_approval', limit: 'spawn_rate' });
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('測試（tester，Q5）：可寫、預設開自己的 worktree、預設權限 default；加入呼叫者的團隊並在同一個工作區', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const zone = await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: 'B' } });
    await hub.api('PATCH', `/api/sessions/${b.caller}`, {
      cookie: b.cookie,
      body: { zoneId: zone.body.id },
    });
    const {
      id,
      spec: s,
      reply,
    } = await spawnMember(b, {
      role: 'tester',
      prompt: 'Run the tests.',
    });
    expect(s).toMatchObject({ readOnly: false, useWorktree: true, permissionMode: 'default' });
    expect(s.name).toBe('Lead-QA');
    expect(reply).toMatchObject({ role: 'tester', readOnly: false });
    const team = hub.running.store.teamsOfSession(id)[0]!;
    expect(team.zoneId).toBe(zone.body.id);
    expect(get(id)?.zoneId).toBe(zone.body.id);
    expect(hub.running.store.listTeamMembers(team.id)).toContainEqual(
      expect.objectContaining({ teamId: team.id, sessionId: id, role: 'tester' }),
    );
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
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
      permissionMode: 'bypassPermissions',
    });
    expect(bypass.text).toMatch(/^permission_not_allowed:/);
    const nested = await ask(
      b,
      'spawn_member',
      { reason: 'Needed.', role: 'researcher', prompt: 'x' },
      bd,
    );
    expect(nested.text).toMatch(/^nested_spawn:.*Lead/);
    const bad = await ask(b, 'spawn_member', { reason: 'Needed.', role: 'lead', prompt: 'x' });
    expect(bad.text).toMatch(/^invalid_arguments:/);

    const ro = await startSession(b, { name: 'Reader', cwd: '/fake/other', readOnly: true });
    const roWorker = await ask(
      b,
      'spawn_member',
      { reason: 'Needed.', role: 'worker', prompt: 'x' },
      ro,
    );
    expect(roWorker.text).toMatch(/^read_only_caller:/);
  });

  it('同資料夾寫入者規則：不是 git 不能開 worktree；不開 worktree 的寫入者和呼叫者衝突', async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, null);
    const noGit = await ask(b, 'spawn_member', { reason: 'Needed.', role: 'worker', prompt: 'x' });
    expect(noGit.text).toMatch(/^worktree_unavailable:/);
    const clashFirst = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
      useWorktree: false,
    });
    expect(clashFirst.text).toMatch(/^worktree_required: Same folder as Lead/);
    // 被擋下的不留下空的團隊。
    expect(hub.running.store.listTeams()).toEqual([]);
    // 研究、審查照樣可以（唯讀，共用資料夾）。
    await spawnMember(b, { role: 'reviewer', prompt: 'Review it.' });
    const clash = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
      useWorktree: false,
    });
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

// ── 隊長自主擴編（GM 2026-11-10，CONTRACTS §11.1） ──────────────────────

/** GM 自己配的團隊：呼叫者當隊長，其他人用 REST 加進來。 */
async function gmTeam(b: Board, members: { id: string; role: string }[]): Promise<string> {
  const res = await hub.api('POST', '/api/teams', {
    cookie: b.cookie,
    body: { name: 'Squad', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
  });
  expect(res.status).toBe(200);
  for (const m of [{ id: b.caller, role: 'lead' }, ...members]) {
    const put = await hub.api('PUT', `/api/teams/${res.body.id}/members/${m.id}`, {
      cookie: b.cookie,
      body: { role: m.role },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  return res.body.id as string;
}

const setAutoStaff = async (b: Board, over: Record<string, unknown>) => {
  const res = await hub.api('PATCH', '/api/settings', {
    cookie: b.cookie,
    body: { autoStaff: { enabled: true, teamLimit: 12, push: true, ...over } },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

const subscribePush = (b: Board) =>
  hub.api('POST', '/api/push/subscriptions', {
    cookie: b.cookie,
    body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
  });

describe('派工：等隊長／等成員結果（GM 2026-11-11）', () => {
  // 狀態推播（attentionPayload 帶 status）；團隊動態那則（team_member_added）也帶成員 id，不算。
  const pushesFor = (id: string) =>
    hub.push.sent.filter((p) => {
      const payload = JSON.parse(p.payload) as { sessionId?: string; status?: string };
      return payload.sessionId === id && payload.status !== undefined;
    });

  it('成員結果送回後是「等隊長」、隊長有未回工作是「等成員結果」：不算等你、不推播；GM 直接下指令後照常 ASK', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    const client = await hub.client(b.cookie);
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix the parser.' });

    // 隊長派完工作、回合結束：手上還有成員沒回來的工作 → 等成員結果，不推播。
    await setStatus(b, b.caller, 'running');
    await setStatus(b, b.caller, 'waiting_input');
    expect(get(b.caller)?.awaiting).toBe('members');
    await setStatus(b, bd, 'running');
    expect(get(bd)?.awaiting).toBeUndefined();

    // 成員做完：結果送回隊長，成員停在 waiting_input → 等隊長，不推播、不算等你。
    stop(b, bd, 'Fixed the parser.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => enterTo(b, b.caller) === 1, 'result delivered');
    expect(get(bd)?.awaiting).toBe('lead');
    await client.next('session.updated', (m) => {
      const s = m.session as { id: string; awaiting?: string };
      return s.id === bd && s.awaiting === 'lead';
    });
    // 最後一個結果送到了：隊長不再是等成員結果（接著它會讀結果、自己做完再停下才是 ASK）。
    await until(() => get(b.caller)?.awaiting === undefined, 'lead cleared');
    const board1 = await hub.api('GET', '/api/sessions', { cookie: b.cookie });
    expect(
      (board1.body as { id: string; awaiting?: string }[]).find((s) => s.id === bd),
    ).toMatchObject({
      awaiting: 'lead',
    });
    await settle();
    expect(pushesFor(bd)).toHaveLength(0);
    expect(pushesFor(b.caller)).toHaveLength(0);

    // GM 直接對成員下指令：新回合清掉等隊長；下一次停下照常 ASK、照常推播。
    await setStatus(b, bd, 'running');
    expect(hub.running.store.awaitingLeadOf(bd)).toBeNull();
    stop(b, bd, 'Answered the user.');
    await setStatus(b, bd, 'waiting_input');
    expect(get(bd)?.awaiting).toBeUndefined();
    await until(() => pushesFor(bd).length === 1, 'ASK pushed');
    expect(JSON.parse(pushesFor(bd)[0]!.payload)).toMatchObject({ status: 'waiting_input' });
  });

  it('成員要權限照樣是 PERM、照樣推播（等成員結果只管 waiting_input）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix the parser.' });
    await setStatus(b, bd, 'waiting_permission');
    expect(get(bd)?.awaiting).toBeUndefined();
    await until(() => pushesFor(bd).length === 1, 'PERM pushed');
  });

  // ── 審查後補（GM 2026-11-11）：不能把真正要 GM 處理的藏成 NEW ──

  const GRACE = 600;
  const pushingBoard = async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, CWD, { awaitingGraceMs: GRACE });
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    return b;
  };
  /** 隊長派完工作、自己停下。 */
  const leadStops = async (b: Board) => {
    await setStatus(b, b.caller, 'running');
    await setStatus(b, b.caller, 'waiting_input');
  };

  it('S1 Stop 掉了：寬限期內成員等隊長、隊長等成員結果；寬限期一到兩邊都變 ASK 並各推播一次', async () => {
    const b = await pushingBoard();
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix.' });
    await setStatus(b, bd, 'running');
    await leadStops(b);
    expect(get(b.caller)?.awaiting).toBe('members');
    await setStatus(b, bd, 'waiting_input'); // Stop 沒來
    expect(get(bd)?.awaiting).toBe('lead');
    expect(get(b.caller)?.awaiting).toBe('members');
    expect(pushesFor(bd)).toHaveLength(0);
    await until(
      () => pushesFor(bd).length === 1 && pushesFor(b.caller).length === 1,
      'pushed after grace',
      GRACE * 5,
    );
    expect(get(bd)?.awaiting).toBeUndefined();
    expect(get(b.caller)?.awaiting).toBeUndefined();
    await settle();
    expect(pushesFor(bd)).toHaveLength(1);
    expect(pushesFor(b.caller)).toHaveLength(1);
  });

  it('S1 送字被吃掉（工作送達、成員沒動）：寬限期後成員與隊長都變 ASK 並推播', async () => {
    const b = await pushingBoard();
    const { id: rs } = await spawnMember(b, { role: 'researcher', prompt: 'Survey.' });
    await setStatus(b, rs, 'running');
    stop(b, rs, 'Surveyed.');
    await setStatus(b, rs, 'waiting_input');
    await until(() => enterTo(b, b.caller) === 1, 'first result');
    await setStatus(b, b.caller, 'running');
    json(await ask(b, 'send_task', { member: 'Lead-RS', text: 'Compare costs.' }));
    await until(() => hub.running.store.dispatchWork(rs) !== null, 'task delivered');
    await setStatus(b, b.caller, 'waiting_input');
    // 成員一直停在 waiting_input（字被吃掉）：寬限期內不推。
    expect(get(rs)?.awaiting).toBe('lead');
    expect(get(b.caller)?.awaiting).toBe('members');
    expect(pushesFor(rs)).toHaveLength(0);
    expect(pushesFor(b.caller)).toHaveLength(0);
    await until(
      () => pushesFor(rs).length === 1 && pushesFor(b.caller).length === 1,
      'pushed after grace',
      GRACE * 5,
    );
    expect(get(rs)?.awaiting).toBeUndefined();
    expect(get(b.caller)?.awaiting).toBeUndefined();
  });

  it('S1 開成員的第一個指令沒送進去（一直是剛開好）：寬限期後隊長變 ASK 並推播；成員維持 NEW 剛開好', async () => {
    const b = await pushingBoard();
    const reply = json(
      await ask(b, 'spawn_member', { role: 'researcher', prompt: 'Survey.', reason: 'Need it.' }),
    );
    const create = await b.daemon.next(
      'session.create',
      (m) => (m.spec as SessionSpec).name === reply.name,
    );
    const id = create.sessionId as string;
    b.daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(id, { status: 'waiting_input', statusDetail: 'idle:start', cwd: CWD }),
    });
    await until(() => get(id)?.status === 'waiting_input', 'member started');
    await leadStops(b);
    expect(get(b.caller)?.awaiting).toBe('members');
    await until(() => pushesFor(b.caller).length === 1, 'lead pushed after grace', GRACE * 5);
    expect(get(b.caller)?.awaiting).toBeUndefined();
    expect(get(id)?.statusDetail).toBe('idle:start');
    expect(pushesFor(id)).toHaveLength(0);
  });

  it('S2 結果還在排隊時隊長封存：成員變回 ASK 並推播（GM 決定）；排隊期間不寫 settings', async () => {
    const b = await pushingBoard();
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix.' });
    await setStatus(b, b.caller, 'running'); // 隊長忙：結果排隊
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Fixed.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => hub.running.store.dispatchWork(bd) === null, 'reported');
    expect(get(bd)?.awaiting).toBe('lead');
    expect(hub.running.store.awaitingLeadOf(bd)).toBeNull();
    const archived = await hub.api('PATCH', `/api/sessions/${b.caller}`, {
      cookie: b.cookie,
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    await until(() => pushesFor(bd).length === 1, 'member pushed');
    expect(get(bd)?.awaiting).toBeUndefined();
    // 佇列裡的結果在隊長狀態變了（停掉）時才丟掉，不影響成員已經變回 ASK。
  });

  it('S2 結果沒送成（排隊期間關掉派工）：成員與隊長都變回 ASK 並推播', async () => {
    const b = await pushingBoard();
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix.' });
    await setStatus(b, b.caller, 'running');
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Fixed.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => hub.running.store.dispatchWork(bd) === null, 'reported');
    const off = await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { dispatch: false },
    });
    expect(off.status).toBe(200);
    await setStatus(b, b.caller, 'waiting_input');
    await until(
      () => pushesFor(bd).length === 1 && pushesFor(b.caller).length === 1,
      'both pushed',
    );
    expect(get(bd)?.awaiting).toBeUndefined();
    expect(get(b.caller)?.awaiting).toBeUndefined();
    expect(textsTo(b, b.caller)).toEqual([]);
  });

  it('W1 全部暫停時隊長不算等成員結果（不推播，GM 自己按的），繼續後恢復', async () => {
    const b = await pushingBoard();
    const client = await hub.client(b.cookie);
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix.' });
    await setStatus(b, bd, 'running');
    await leadStops(b);
    expect(get(b.caller)?.awaiting).toBe('members');
    const paused = await hub.api('POST', '/api/board/pause', {
      cookie: b.cookie,
      body: { mode: 'finish_turn' },
    });
    expect(paused.status).toBe(200);
    expect(get(b.caller)?.awaiting).toBeUndefined();
    await client.next('session.updated', (m) => {
      const s = m.session as { id: string; awaiting?: string };
      return s.id === b.caller && s.awaiting === undefined;
    });
    expect((await hub.api('POST', '/api/board/resume', { cookie: b.cookie })).status).toBe(200);
    expect(get(b.caller)?.awaiting).toBe('members');
    await settle();
    expect(pushesFor(b.caller)).toHaveLength(0);
  });

  it('W2 成員限流（rate_limited）不算在做事：隊長變 ASK 並推播', async () => {
    const b = await pushingBoard();
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix.' });
    await setStatus(b, bd, 'running');
    await leadStops(b);
    expect(get(b.caller)?.awaiting).toBe('members');
    await setStatus(b, bd, 'rate_limited');
    expect(get(b.caller)?.awaiting).toBeUndefined();
    await until(() => pushesFor(b.caller).length === 1, 'lead pushed');
    await setStatus(b, bd, 'running');
    expect(get(b.caller)?.awaiting).toBe('members');
  });

  it('W6 等隊長時 GM 直接下指令：UserPromptSubmit 清掉（不推）；沒有工作的 Stop 也清掉並推播', async () => {
    const b = await pushingBoard();
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Fix.' });
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Fixed.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => enterTo(b, b.caller) === 1, 'result delivered');
    await until(() => hub.running.store.awaitingLeadOf(bd) === b.caller, 'awaiting lead stored');
    sendEvent(b, bd, 'hook', { event: 'UserPromptSubmit', prompt: 'x' });
    await until(() => get(bd)?.awaiting === undefined, 'cleared by prompt');
    await settle();
    expect(pushesFor(bd)).toHaveLength(0);

    // 再一輪：結果送回後，狀態沒變化只來了 Stop（沒有工作）→ 清掉並推播。
    await leadStops(b); // 隊長讀了第一則結果（送字佇列要等它動過才送下一則）
    json(await ask(b, 'send_task', { member: 'Lead-BD1', text: 'Again.' }));
    await until(() => hub.running.store.dispatchWork(bd) !== null, 'task delivered');
    await setStatus(b, bd, 'running');
    stop(b, bd, 'Again done.');
    await setStatus(b, bd, 'waiting_input');
    await until(() => hub.running.store.awaitingLeadOf(bd) === b.caller, 'awaiting lead again');
    stop(b, bd, 'Answered the user.');
    await until(() => pushesFor(bd).length === 1, 'pushed on plain Stop');
    expect(get(bd)?.awaiting).toBeUndefined();
  });
});

describe('隊長自主擴編：新增理由、上限、通知', () => {
  it('reason 必填：舊呼叫（沒帶 reason）回 reason_required 並說明怎麼補', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const old = await ask(b, 'spawn_member', { role: 'worker', prompt: 'Fix it.' });
    expect(old.ok).toBe(false);
    expect(old.text).toMatch(/^reason_required: spawn_member now requires reason/);
    const blank = await ask(b, 'spawn_member', { role: 'worker', prompt: 'x', reason: ' \n ' });
    expect(blank.text).toMatch(/^reason_required:/);
    expect(b.daemon.of('session.create')).toHaveLength(0);
    expect(hub.running.store.listTeams()).toEqual([]);
  });

  it('理由記在 audit、session 事件、成員（added）、list_members，並產生團隊動態＋推播', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    const { id: qa, reply } = await spawnMember(b, {
      role: 'tester',
      prompt: 'Write regression tests.',
      reason: 'No tester yet;\nthe change needs regression tests.',
    });
    const reason = 'No tester yet; the change needs regression tests.';
    expect(reply).toMatchObject({ reason, teamSize: '2/12' });
    const audit = hub.running.store
      .listAudit({ limit: 100 })
      .find((a) => a.action === 'dispatch.spawn')!;
    expect(JSON.parse(audit.detail)).toMatchObject({ reason, teamSize: 2, teamLimit: 12 });
    expect(eventsOf(qa)[0]!.payload).toMatchObject({ reason });
    const team = hub.running.store.teamsOfSession(qa)[0]!;
    const members = await hub.api('GET', `/api/teams/${team.id}/members`, { cookie: b.cookie });
    expect(members.body.find((m: { sessionId: string }) => m.sessionId === qa)).toMatchObject({
      role: 'tester',
      added: { bySessionId: b.caller, byName: 'Lead', reason },
    });
    const listed = json(await ask(b, 'list_members')) as {
      teams: { staffing: Record<string, unknown>; members: Record<string, unknown>[] }[];
    };
    expect(listed.teams[0]!.members.find((m) => m.name === 'Lead-QA')).toMatchObject({
      addedReason: reason,
    });
    // 團隊動態：一筆、未讀；推播只帶名稱與種類，不帶理由。
    const activity = hub.running.store.listTeamActivity();
    expect(activity).toEqual([
      expect.objectContaining({
        kind: 'member_added',
        teamName: 'Lead',
        leadName: 'Lead',
        memberName: 'Lead-QA',
        memberSessionId: qa,
        role: 'tester',
        reason,
        read: false,
      }),
    ]);
    const teamPushes = () =>
      hub.push.sent
        .map((p) => JSON.parse(p.payload) as Record<string, unknown>)
        .filter((p) => p.reason === 'team_member_added');
    await until(() => teamPushes().length === 1, 'push');
    const payload = teamPushes()[0]!;
    expect(payload).toMatchObject({
      reason: 'team_member_added',
      name: 'Lead',
      member: 'Lead-QA',
      sessionId: qa,
    });
    expect(hub.push.sent.some((p) => p.payload.includes('regression'))).toBe(false);
    // 標已讀、清除（REST）；board 快照帶最新清單。
    const read = await hub.api('POST', '/api/team-activity/read', { cookie: b.cookie, body: {} });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([expect.objectContaining({ read: true })]);
    const cleared = await hub.api('POST', '/api/team-activity/clear', {
      cookie: b.cookie,
      body: { ids: [activity[0]!.id] },
    });
    expect(cleared.body).toEqual([]);
    expect(hub.running.store.listTeamActivity()).toEqual([]);
  });

  it('推播設定關掉：團隊動態照記，不推播', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    await setAutoStaff(b, { push: false });
    await spawnMember(b, { role: 'researcher', prompt: 'Survey.', reason: 'Need a survey.' });
    await settle();
    expect(hub.push.sent.filter((p) => p.payload.includes('team_member'))).toHaveLength(0);
    expect(hub.running.store.listTeamActivity()).toHaveLength(1);
  });

  it('上限算團隊總人數（含隊長與 GM 配的、不含已封存）；滿了回 team_full 並提示 release_member', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const a = await startSession(b, { name: 'GM-A', cwd: '/fake/a' }, null);
    const c = await startSession(b, { name: 'GM-B', cwd: '/fake/b' }, null);
    const teamId = await gmTeam(b, [
      { id: a, role: 'researcher' },
      { id: c, role: 'reviewer' },
    ]);
    await setAutoStaff(b, { teamLimit: 4 });
    const listed = json(await ask(b, 'list_members')) as {
      teams: { yourRole: string; staffing: Record<string, unknown> }[];
    };
    expect(listed.teams[0]).toMatchObject({
      yourRole: 'lead',
      staffing: {
        autoStaff: true,
        size: 3,
        limit: 4,
        free: 1,
        roles: { lead: { members: 1 }, researcher: { members: 1 }, reviewer: { members: 1 } },
        addsLeftThis10Minutes: 1,
        guide: expect.stringMatching(/^You lead this team/),
      },
    });
    await spawnMember(b, { role: 'worker', prompt: 'Build.', reason: 'Nobody edits code.' });
    expect(hub.running.store.listTeamMembers(teamId)).toHaveLength(4);
    const full = await ask(b, 'spawn_member', {
      role: 'tester',
      prompt: 'Test.',
      reason: 'Need tests.',
    });
    // 滿了：改成向使用者申請（§23）。
    expect(json(full)).toMatchObject({
      status: 'pending_approval',
      limit: 'team_full',
      teamSize: '4/4',
    });
    const fullList = json(await ask(b, 'list_members')) as {
      teams: { staffing: { guide: string; free: number } }[];
    };
    expect(fullList.teams[0]!.staffing).toMatchObject({
      free: 0,
      pendingRequest: { role: 'tester', limit: 'team_full' },
    });
    expect(fullList.teams[0]!.staffing.guide).toMatch(/size limit: release_member/);
    expect(fullList.teams[0]!.staffing.guide).toMatch(/request to approve/);
    // 封存一位 GM 配的（等輸入中）：名額空出來，可以再加。
    const released = json(
      await ask(b, 'release_member', { member: 'GM-A', reason: 'Survey done.' }),
    );
    expect(released).toMatchObject({ released: 'GM-A', team: 'Squad', teamSize: '3/4' });
    expect(get(a)).toMatchObject({ archived: true });
    await spawnMember(b, { role: 'tester', prompt: 'Test.', reason: 'Need tests.' });
  });

  it('release_member：走封存流程（停 session、暫停交接規則、可還原）、記 audit／事件／團隊動態', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const { id: rv } = await spawnMember(b, {
      role: 'reviewer',
      prompt: 'Review.',
      reason: 'Review.',
    });
    const team = hub.running.store.teamsOfSession(rv)[0]!;
    const rule = await hub.api('POST', `/api/teams/${team.id}/handoff-rules`, {
      cookie: b.cookie,
      body: {
        fromSessionId: rv,
        trigger: 'on_done',
        action: { toSessionId: b.caller },
        enabled: true,
      },
    });
    await finishWork(b, rv, 'Reviewed.');
    const released = json(
      await ask(b, 'release_member', { member: 'Lead-RV', reason: 'Review finished.' }),
    );
    expect(released).toMatchObject({ released: 'Lead-RV' });
    // 停 session（還活著的先送 stop）。
    expect(b.daemon.of('session.stop').map((m) => m.sessionId)).toContain(rv);
    expect(get(rv)).toMatchObject({ archived: true });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    const rules = await hub.api('GET', `/api/teams/${team.id}/handoff-rules`, {
      cookie: b.cookie,
    });
    expect(rules.body[0]).toMatchObject({ enabled: false });
    const archive = hub.running.store
      .listAudit({ limit: 100 })
      .find((a) => a.action === 'session.archive' && a.sessionId === rv)!;
    expect(archive.userId).toBeNull();
    expect(JSON.parse(archive.detail)).toMatchObject({ byLead: b.caller, stopped: true });
    const audit = hub.running.store
      .listAudit({ limit: 100 })
      .find((a) => a.action === 'dispatch.release')!;
    expect(JSON.parse(audit.detail)).toMatchObject({
      fromSessionId: b.caller,
      toSessionId: rv,
      reason: 'Review finished.',
    });
    expect(eventsOf(rv).map((e) => e.type)).toContain('dispatch.release');
    expect(hub.running.store.listTeamActivity()[0]).toMatchObject({
      kind: 'member_released',
      memberName: 'Lead-RV',
      reason: 'Review finished.',
    });
    // 可以在設定→已封存還原（同一條 PATCH archived:false）。
    const restored = await hub.api('PATCH', `/api/sessions/${rv}`, {
      cookie: b.cookie,
      body: { archived: false },
    });
    expect(restored.status).toBe(200);
    expect(get(rv)?.archived).toBe(false);
  });

  it('release_member 的保護：回合中（RUN、starting、等允許、等審計畫）與還欠結果的不能封存、不能封存自己、理由必填', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'Build.', reason: 'Build.' });
    expect((await ask(b, 'release_member', { member: 'Lead-BD1' })).text).toMatch(
      /^reason_required:/,
    );
    // 不在任何團隊的 session（先開：後面成員限流時同帳號的新 session 會排隊）。
    const other = await startSession(b, { name: 'Other', cwd: '/fake/other' });
    const outsider = await ask(b, 'release_member', { member: 'Other', reason: 'x' });
    expect(outsider.text).toMatch(/^not_your_member: .*You can release: Lead-BD1/);
    expect(get(other)?.archived).toBe(false);
    // 第一個工作還沒交回：還欠結果。
    const owes = await ask(b, 'release_member', { member: 'Lead-BD1', reason: 'Done.' });
    expect(owes.text).toMatch(/^member_busy: Lead-BD1 still owes you a result/);
    expect(get(bd)?.archived).toBe(false);
    await finishWork(b, bd);
    const cases: [string, RegExp][] = [
      ['running', /is working \(RUN\)/],
      ['starting', /is starting/],
      ['waiting_permission', /waiting for the user to approve a tool/],
      ['plan_review', /waiting for the user to review its plan/],
    ];
    for (const [status, text] of cases) {
      await setStatus(b, bd, status);
      const busy = await ask(b, 'release_member', { member: 'Lead-BD1', reason: 'Done.' });
      expect(busy.text, status).toMatch(/^member_busy: Lead-BD1 /);
      expect(busy.text, status).toMatch(text);
      expect(get(bd)?.archived).toBe(false);
    }
    // 送出去、還在排隊的工作（成員忙著時送字排隊）：也算還欠結果。
    await setStatus(b, bd, 'running');
    json(await ask(b, 'send_task', { member: 'Lead-BD1', text: 'One more thing.' }));
    await setStatus(b, bd, 'rate_limited');
    const queued = await ask(b, 'release_member', { member: 'Lead-BD1', reason: 'Done.' });
    expect(queued.text).toMatch(/^member_busy: Lead-BD1 still owes you a result/);
    expect(get(bd)?.archived).toBe(false);
    const self = await ask(b, 'release_member', { member: 'Lead', reason: 'x' });
    expect(self.text).toMatch(/^cannot_release_self:/);
    // 成員（不是隊長）：不能封存、不能新增，提醒向隊長回報。
    await setStatus(b, bd, 'waiting_input');
    const up = await ask(b, 'release_member', { member: 'Lead', reason: 'x' }, bd);
    expect(up.text).toMatch(/^not_lead: You are a team member, not the lead/);
    const memberList = json(await ask(b, 'list_members', {}, bd)) as {
      teams: { yourRole: string; staffing: Record<string, unknown> }[];
    };
    expect(memberList.teams[0]).toMatchObject({
      yourRole: 'worker',
      staffing: { guide: expect.stringMatching(/^You are a team member, not the lead/) },
    });
    expect(memberList.teams[0]!.staffing).not.toHaveProperty('limit');
  });

  it('release_member：呼叫者在 A 隊當隊長、在 B 隊只是成員，封不了 B 隊的人（not_your_member）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    // A 隊：呼叫者（Lead）當隊長。
    const a1 = await startSession(b, { name: 'A-1', cwd: '/fake/a1' }, null);
    await gmTeam(b, [{ id: a1, role: 'worker' }]);
    // B 隊：X 當隊長，呼叫者只是 worker，還有一位 B-1。
    const x = await startSession(b, { name: 'X', cwd: '/fake/x' }, null);
    const b1 = await startSession(b, { name: 'B-1', cwd: '/fake/b1' }, null);
    const res = await hub.api('POST', '/api/teams', {
      cookie: b.cookie,
      body: { name: 'Bravo', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
    });
    for (const m of [
      { id: x, role: 'lead' },
      { id: b.caller, role: 'worker' },
      { id: b1, role: 'researcher' },
    ]) {
      const put = await hub.api('PUT', `/api/teams/${res.body.id}/members/${m.id}`, {
        cookie: b.cookie,
        body: { role: m.role },
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }
    for (const name of ['B-1', 'X']) {
      const r = await ask(b, 'release_member', { member: name, reason: 'x' });
      expect(r.text, name).toMatch(/^not_your_member: .*You can release: A-1\.$/);
    }
    expect(get(b1)?.archived).toBe(false);
    expect(get(x)?.archived).toBe(false);
  });

  it('全隊暫停時不新增也不封存；全部暫停時不新增但可以封存；封存沒有頻率上限（GM 2026-11-10）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await startSession(b, { name: `GM-${i}`, cwd: `/fake/g${i}` }, null));
    }
    const teamId = await gmTeam(
      b,
      ids.map((id) => ({ id, role: 'researcher' })),
    );
    // 全隊暫停（CONTRACTS §17）。
    const hold = await hub.api('POST', `/api/teams/${teamId}/hold`, {
      cookie: b.cookie,
      body: { mode: 'pause' },
    });
    expect(hold.status, JSON.stringify(hold.body)).toBe(200);
    const spawnHeld = await ask(b, 'spawn_member', {
      role: 'researcher',
      prompt: 'x',
      reason: 'x',
    });
    expect(spawnHeld.text).toMatch(/^team_held: The user paused this team/);
    const releaseHeld = await ask(b, 'release_member', { member: 'GM-0', reason: 'x' });
    expect(releaseHeld.text).toMatch(/^team_held:/);
    expect(b.daemon.of('session.create')).toHaveLength(0);
    const resume = await hub.api('POST', `/api/teams/${teamId}/resume`, { cookie: b.cookie });
    expect(resume.status, JSON.stringify(resume.body)).toBe(200);
    // 全部暫停。
    const pause = await hub.api('POST', '/api/board/pause', {
      cookie: b.cookie,
      body: { mode: 'finish_turn' },
    });
    expect(pause.status, JSON.stringify(pause.body)).toBe(200);
    // GM 2026-11-10：全部暫停時照樣可以封存。
    for (const id of ids) await setStatus(b, id, 'waiting_input');
    json(await ask(b, 'release_member', { member: 'GM-0', reason: 'Done.' }));
    expect(get(ids[0]!)?.archived).toBe(true);
    await hub.api('POST', '/api/board/resume', { cookie: b.cookie });
    // GM 2026-11-10：封存沒有頻率上限，10 分鐘內連封 4 位照樣成功。
    for (let i = 1; i < 5; i++) {
      json(await ask(b, 'release_member', { member: `GM-${i}`, reason: 'Done.' }));
    }
    for (let i = 1; i < 5; i++) expect(get(ids[i]!)?.archived).toBe(true);
  });

  it('上限邊界：GM 配的成員加隊長剛好等於上限時，第一次 spawn 就改成申請（team_full），daemon 沒收到 session.create', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await startSession(b, { name: `GM-${i}`, cwd: `/fake/g${i}` }, null));
    }
    await gmTeam(
      b,
      ids.map((id) => ({ id, role: 'worker' })),
    );
    await setAutoStaff(b, { teamLimit: 4 });
    b.daemon.clear();
    const full = await ask(b, 'spawn_member', { role: 'researcher', prompt: 'x', reason: 'x' });
    expect(json(full)).toMatchObject({ status: 'pending_approval', limit: 'team_full' });
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('GM 配的成員（不是隊長、不是派工開的）不能自己開人：not_lead', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const a = await startSession(b, { name: 'GM-A', cwd: '/fake/a' }, null);
    await gmTeam(b, [{ id: a, role: 'worker' }]);
    const r = await ask(b, 'spawn_member', { role: 'worker', prompt: 'x', reason: 'x' }, a);
    expect(r.text).toMatch(/^not_lead: You are a team member, not the lead/);
  });

  it('帳號限流時不擴編（同機器、同帳號有 rate_limited）：account_rate_limited；別的帳號限流不影響', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    // 別的帳號（accountProfile＝CLAUDE_CONFIG_DIR 不同）限流：照常可以開。
    const elsewhere = await startSession(b, {
      name: 'Other account',
      cwd: '/fake/other',
      accountProfile: '/acct/other',
    });
    await setStatus(b, elsewhere, 'rate_limited');
    await spawnMember(b, { role: 'researcher', prompt: 'x', reason: 'x' });
    // 同機器、同帳號（預設帳號）限流：擋。
    const same = await startSession(b, { name: 'Busy', cwd: '/fake/busy' });
    await setStatus(b, same, 'rate_limited');
    b.daemon.clear();
    const r = await ask(b, 'spawn_member', { role: 'researcher', prompt: 'x', reason: 'x' });
    expect(r.text).toMatch(/^account_rate_limited:/);
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('設定關掉＝不能新增也不能封存，只能用現有成員；list_members 的提醒跟著改', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    await spawnMember(b, { role: 'researcher', prompt: 'x', reason: 'x' });
    const saved = await setAutoStaff(b, { enabled: false });
    expect(saved.autoStaff).toEqual({ enabled: false, teamLimit: 12, push: true });
    const spawn = await ask(b, 'spawn_member', { role: 'researcher', prompt: 'x', reason: 'x' });
    expect(spawn.text).toMatch(/^autostaff_disabled: The user turned off lead auto-staffing/);
    const release = await ask(b, 'release_member', { member: 'Lead-RS', reason: 'x' });
    expect(release.text).toMatch(/^autostaff_disabled:/);
    // send_task 照常可用。
    expect(json(await ask(b, 'send_task', { member: 'Lead-RS', text: 'More.' }))).toMatchObject({
      member: 'Lead-RS',
    });
    const listed = json(await ask(b, 'list_members')) as {
      teams: { staffing: Record<string, unknown> }[];
    };
    expect(listed.teams[0]!.staffing).toMatchObject({
      autoStaff: false,
      addsLeftThis10Minutes: 0,
      guide: expect.stringMatching(/turned off lead auto-staffing/),
    });
    // 範圍外的上限存不進去；存別的設定不會把 autoStaff 改回預設。
    const bad = await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { autoStaff: { enabled: true, teamLimit: 30, push: true } },
    });
    expect(bad.status).toBe(400);
    const other = await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { stuckMinutes: 9 },
    });
    expect(other.body.autoStaff).toMatchObject({ enabled: false });
  });

  it('get_progress 的團隊卡附上人手資訊（隊長看到上限、成員看到向隊長回報）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    const { id: bd } = await spawnMember(b, { role: 'worker', prompt: 'x', reason: 'x' });
    const lead = json(await ask(b, 'get_progress')) as { staffing: Record<string, unknown> };
    expect(lead.staffing).toMatchObject({
      size: 2,
      limit: 12,
      guide: expect.stringMatching(/^You lead this team/),
    });
    const member = json(await ask(b, 'get_progress', {}, bd)) as {
      staffing: Record<string, unknown>;
    };
    expect(member.staffing).toEqual({ guide: expect.stringMatching(/not the lead/) });
  });
});

// ── 加開申請（GM 2026-11-13，CONTRACTS §23）────────────────────

describe('加開申請：超過上限改成向使用者申請', () => {
  const PROMPT = 'Write regression tests for the parser.';
  const REASON = 'Nobody tests the parser yet.';

  /** 隊長＋GM 配的 3 位、上限 4：再開就是 team_full。 */
  async function fullTeam(timing: Partial<Timing> = {}) {
    const b = await board({ permissionMode: 'acceptEdits' }, CWD, timing);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await startSession(b, { name: `GM-${i}`, cwd: `/fake/g${i}` }, null));
    }
    const teamId = await gmTeam(
      b,
      ids.map((id) => ({ id, role: 'worker' })),
    );
    await setAutoStaff(b, { teamLimit: 4 });
    b.daemon.clear();
    return { b, teamId, ids };
  }

  const askSpawn = (b: Board, over: Record<string, unknown> = {}) =>
    ask(b, 'spawn_member', {
      role: 'tester',
      prompt: PROMPT,
      reason: REASON,
      name: 'Parser-QA',
      ...over,
    });

  const audits = (action: string) =>
    hub.running.store.listAudit({ limit: 500 }).filter((a) => a.action === action);
  const staffPushes = () =>
    hub.push.sent
      .map((p) => JSON.parse(p.payload) as Record<string, unknown>)
      .filter((p) => p.kind === 'staff_request');
  const pending = () => hub.running.hub.staffRequests.list();
  const noticesTo = (b: Board) =>
    textsTo(b, b.caller).filter((text) => text.startsWith('[Agent Board]'));

  /** 假 daemon 確認開好成員。 */
  async function confirmCreate(b: Board, name: string) {
    const create = await b.daemon.next(
      'session.create',
      (m) => (m.spec as SessionSpec).name === name,
    );
    b.daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(create.sessionId as string, {
        status: 'waiting_input',
        cwd: `/fake/wt/${name}`,
        worktreePath: `/fake/wt/${name}`,
        branch: `ab/${name}`,
        repoRoot: `/fake/wt/${name}`,
      }),
    });
    return create;
  }

  it('team_full：回 pending_approval（叫隊長結束回合）、記 audit 與團隊動態、推播只有固定文字、收件匣看得到', async () => {
    const { b, teamId } = await fullTeam();
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    const client = await hub.client(b.cookie);
    const reply = json(await askSpawn(b));
    expect(reply).toMatchObject({
      status: 'pending_approval',
      limit: 'team_full',
      team: 'Squad',
      role: 'tester',
      teamSize: '4/4',
    });
    expect(reply.result).toMatch(/end your turn now: do not sleep, poll/);
    expect(reply.result).toMatch(/\[Agent Board\]/);
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);

    // 收件匣：GET 清單、ws 推 staff.requests；只有 prompt 摘要，沒有完整參數。
    const list = await hub.api('GET', '/api/staff-requests', { cookie: b.cookie });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: reply.requestId,
        teamId,
        leadName: 'Lead',
        limit: 'team_full',
        limits: ['team_full'],
        role: 'tester',
        name: 'Parser-QA',
        reason: REASON,
        promptPreview: PROMPT,
        status: 'pending',
        teamSize: 4,
        teamLimit: 4,
      }),
    ]);
    expect(list.body[0]).not.toHaveProperty('args');
    await client.next('staff.requests', (m) => (m.items as unknown[]).length === 1);

    const created = audits('staff_request.created');
    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0]!.detail)).toMatchObject({ limit: 'team_full', reason: REASON });
    expect(hub.running.store.listStaffActivity()[0]).toMatchObject({
      kind: 'staff_requested',
      leadName: 'Lead',
      memberName: 'Parser-QA',
      role: 'tester',
      reason: REASON,
      staffRequestId: reply.requestId,
      limit: 'team_full',
    });
    expect(hub.running.store.listStaffActivity()[0]!.memberSessionId).toBeUndefined();

    // 推播：只有隊長名稱與上限種類，不帶理由、prompt。
    await until(() => staffPushes().length === 1, 'staff push');
    expect(staffPushes()[0]).toEqual({
      kind: 'staff_request',
      requestId: reply.requestId,
      lead: 'Lead',
      limit: 'team_full',
      at: expect.any(String),
    });
    expect(hub.push.sent.some((p) => p.payload.includes('regression'))).toBe(false);
    expect(hub.push.sent.some((p) => p.payload.includes('Nobody tests'))).toBe(false);
  });

  it('同一隊同時只有一件：已有待處理時再超限回 request_pending，不再推播、不再記申請', async () => {
    const { b } = await fullTeam();
    await perEventPush(hub, b.cookie);
    await subscribePush(b);
    json(await askSpawn(b));
    await until(() => staffPushes().length === 1, 'first push');
    const again = await askSpawn(b, { role: 'researcher', name: undefined });
    expect(again.ok).toBe(false);
    expect(again.text).toMatch(/^request_pending: A request to add a member \(tester\)/);
    expect(again.text).toMatch(/end your turn/);
    await settle();
    expect(staffPushes()).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(audits('staff_request.created')).toHaveLength(1);
    expect(
      audits('dispatch.blocked').some((a) => JSON.parse(a.detail).reason === 'request_pending'),
    ).toBe(true);
  });

  it('同意 → 照申請開成員（略過人數上限）、告訴隊長已開好；記 audit 與團隊動態；再按一次不會再開', async () => {
    const { b, teamId } = await fullTeam();
    const reply = json(await askSpawn(b));
    const id = reply.requestId as string;
    const approve = hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    const create = await confirmCreate(b, 'Parser-QA');
    const res = await approve;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id,
      status: 'approved',
      decidedBy: 'owner',
      memberName: 'Parser-QA',
      memberSessionId: create.sessionId,
    });
    // 照申請時的參數：角色、名稱、prompt、預設 worktree 與權限。
    expect(create.spec).toMatchObject({
      name: 'Parser-QA',
      useWorktree: true,
      permissionMode: 'default',
      firstPrompt: `[From Lead] ${PROMPT}`,
    });
    expect(hub.running.store.listTeamMembers(teamId)).toHaveLength(5);
    expect(pending()).toEqual([]);
    // 隊長在等輸入：通知經送字佇列送進去，開頭固定 [Agent Board]。
    await until(() => noticesTo(b).length === 1, 'approved notice');
    expect(noticesTo(b)[0]).toMatch(
      /^\[Agent Board\] The user approved your request to add a member \(over the team size limit\)\. Parser-QA \(tester\) has been started/,
    );
    expect(audits('staff_request.approved')).toHaveLength(1);
    expect(audits('staff_request.approved')[0]!.userId).not.toBeNull();
    await until(() => audits('staff_request.notice_delivered').length === 1, 'delivered');
    const activity = hub.running.store.listStaffActivity();
    expect(activity.find((a) => a.kind === 'staff_approved')).toMatchObject({
      memberSessionId: create.sessionId,
      memberName: 'Parser-QA',
    });
    // 成員的結果照常送回隊長（派工工作記在隊長名下）。
    expect(hub.running.store.dispatchWork(create.sessionId as string)?.from).toBe(b.caller);
    // 通知送到後就不留在 settings 表。
    expect(hub.running.store.listRawJson('staffRequest:')).toEqual([]);
    const twice = await hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    expect(twice.status).toBe(409);
    // 第一次的 session.create 已被 confirmCreate 取走：沒有第二次。
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('spawn_rate：10 分鐘第五位改成申請，同意後開出來（略過頻率上限）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    for (let i = 0; i < DISPATCH_SPAWN_RATE_MAX; i += 1) {
      await spawnMember(b, { role: 'researcher', prompt: `Look ${i}.` });
    }
    const reply = json(await askSpawn(b, { role: 'researcher', name: 'Extra-RS' }));
    expect(reply).toMatchObject({ status: 'pending_approval', limit: 'spawn_rate' });
    expect(reply.result).toMatch(/More than 4 members were added/);
    const approve = hub.api('POST', `/api/staff-requests/${reply.requestId as string}/approve`, {
      cookie: b.cookie,
    });
    await confirmCreate(b, 'Extra-RS');
    expect((await approve).body).toMatchObject({ status: 'approved', memberName: 'Extra-RS' });
    await until(() => noticesTo(b).length === 1, 'approved notice');
    expect(noticesTo(b)[0]).toMatch(/too many members added in 10 minutes/);
  });

  it('拒絕 → 不開成員、告訴隊長被拒絕；一般使用者（member）看得到但不能處理', async () => {
    const { b } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const user = await hub.createMember(b.cookie, 'viewer');
    const forbidden = await hub.api('POST', `/api/staff-requests/${id}/reject`, {
      cookie: user.cookie,
    });
    expect(forbidden.status).toBe(403);
    const seen = await hub.api('GET', '/api/staff-requests', { cookie: user.cookie });
    expect(seen.body).toHaveLength(1);
    const res = await hub.api('POST', `/api/staff-requests/${id}/reject`, { cookie: b.cookie });
    expect(res.body).toMatchObject({ status: 'rejected', decidedBy: 'owner' });
    await until(() => noticesTo(b).length === 1, 'rejected notice');
    expect(noticesTo(b)[0]).toMatch(
      /^\[Agent Board\] The user rejected your request to add a tester member\. Nothing was started\./,
    );
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
    expect(audits('staff_request.rejected')).toHaveLength(1);
    expect(hub.running.store.listStaffActivity()[0]).toMatchObject({ kind: 'staff_rejected' });
    expect(pending()).toEqual([]);
  });

  it('30 分鐘（測試縮短）沒處理 → 失效、告訴隊長；之後按同意不會開成員', async () => {
    const { b } = await fullTeam({ staffRequestTtlMs: 400 });
    const id = json(await askSpawn(b)).requestId as string;
    await until(() => noticesTo(b).length === 1, 'expired notice');
    expect(noticesTo(b)[0]).toMatch(
      /^\[Agent Board\] Your request to add a tester member expired: the user did not answer within/,
    );
    expect(audits('staff_request.expired')).toHaveLength(1);
    expect(audits('staff_request.expired')[0]!.userId).toBeNull();
    expect(hub.running.store.listStaffActivity()[0]).toMatchObject({ kind: 'staff_expired' });
    expect(pending()).toEqual([]);
    const late = await hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    expect(late.status).toBe(409);
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('同意時這一隊已全隊暫停：開不起來（team_held），申請標 failed、告訴隊長原因', async () => {
    const { b, teamId } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const hold = await hub.api('POST', `/api/teams/${teamId}/hold`, {
      cookie: b.cookie,
      body: { mode: 'pause' },
    });
    expect(hold.status).toBe(200);
    const res = await hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    expect(res.body).toMatchObject({ status: 'failed', error: 'team_held' });
    await until(() => noticesTo(b).length === 1, 'failed notice');
    expect(noticesTo(b)[0]).toMatch(
      /^\[Agent Board\] The user approved your request to add a tester member, but it could not be started: team_held: /,
    );
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
    expect(audits('staff_request.failed')).toHaveLength(1);
    expect(hub.running.store.listStaffActivity()[0]).toMatchObject({
      kind: 'staff_failed',
      error: 'team_held',
    });
  });

  it('隊長擴編設定關掉：照舊 autostaff_disabled，不產生申請', async () => {
    const { b } = await fullTeam();
    await setAutoStaff(b, { enabled: false, teamLimit: 4 });
    const off = await askSpawn(b);
    expect(off.text).toMatch(/^autostaff_disabled:/);
    expect(pending()).toEqual([]);
    expect(audits('staff_request.created')).toHaveLength(0);
  });

  /** 關掉 hub、用同一個資料庫重開，daemon 帶著原本的 session 重新連上。 */
  async function restart(b: Board, timing: Partial<Timing> = {}) {
    const runtimes = hub.running.store
      .listSessions(false)
      .map((s) => runtime(s.id, { status: 'waiting_input', cwd: s.cwd, repoRoot: s.repoRoot }));
    const { dbPath } = hub;
    await hub.running.close();
    hub = await startHub({ dbPath, timing: { handoffEnterDelayMs: 20, ...timing } });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    b.cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    b.daemon = await hub.daemon(b.token!);
    b.daemon.send(hello({ sessions: runtimes }));
    await b.daemon.next('hub.welcome');
    await until(() => get(b.caller)?.status === 'waiting_input', 'lead back');
  }

  it('hub 重啟：待處理的申請接回（清單還在），同意後照樣開成員', async () => {
    const { b } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    await restart(b);
    expect(pending().map((r) => r.id)).toEqual([id]);
    const approve = hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    await confirmCreate(b, 'Parser-QA');
    expect((await approve).body).toMatchObject({ status: 'approved' });
    await until(() => noticesTo(b).length === 1, 'approved notice after restart');
  });

  it('hub 重啟：30 分鐘計時也接回，到時失效並告訴隊長', async () => {
    const { b } = await fullTeam({ staffRequestTtlMs: 1_500 });
    json(await askSpawn(b));
    await restart(b, { staffRequestTtlMs: 1_500 });
    expect(pending()).toHaveLength(1);
    await until(() => noticesTo(b).length === 1, 'expired notice after restart');
    expect(noticesTo(b)[0]).toMatch(/expired/);
    expect(pending()).toEqual([]);
  });

  // ── 審查後的修正（S1、W1–W3、N1–N6）────────────────────

  const failedCodes = () => audits('staff_request.failed').map((a) => JSON.parse(a.detail).code);

  it('S1 團隊被刪：待處理的申請直接失敗（team_deleted）、告訴隊長；之後按同意是 409、不開新團隊', async () => {
    const { b, teamId } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const del = await hub.api('DELETE', `/api/teams/${teamId}`, { cookie: b.cookie });
    expect(del.status).toBe(200);
    expect(failedCodes()).toEqual(['team_deleted']);
    expect(pending()).toEqual([]);
    await until(() => noticesTo(b).length === 1, 'withdrawn notice');
    expect(noticesTo(b)[0]).toMatch(
      /^\[Agent Board\] Your request to add a tester member was withdrawn because the team was deleted\./,
    );
    const late = await hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    expect(late.status).toBe(409);
    expect(hub.running.store.listTeams()).toEqual([]);
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('S1 隊長被封存：待處理的申請直接失敗（lead_inactive）', async () => {
    const { b } = await fullTeam();
    json(await askSpawn(b));
    const archived = await hub.api('PATCH', `/api/sessions/${b.caller}`, {
      cookie: b.cookie,
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    await until(() => failedCodes().length === 1, 'failed on archive');
    expect(failedCodes()).toEqual(['lead_inactive']);
    expect(pending()).toEqual([]);
    expect(hub.running.store.listStaffActivity()[0]).toMatchObject({
      kind: 'staff_failed',
      error: 'lead_inactive',
    });
  });

  it('S1 隊長不再是隊長（GM 改了角色）：待處理的申請直接失敗（not_lead）', async () => {
    const { b, teamId } = await fullTeam();
    json(await askSpawn(b));
    const put = await hub.api('PUT', `/api/teams/${teamId}/members/${b.caller}`, {
      cookie: b.cookie,
      body: { role: 'worker' },
    });
    expect(put.status).toBe(200);
    expect(failedCodes()).toEqual(['not_lead']);
    await until(() => noticesTo(b).length === 1, 'withdrawn notice');
    expect(noticesTo(b)[0]).toMatch(/no longer the lead of that team/);
  });

  it('S1 同意時才發現團隊變了（沒經過 revalidate 的改法）：failed／team_changed，不另開團隊', async () => {
    const { b, teamId } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    hub.running.store.deleteTeamMember(teamId, b.caller);
    const res = await hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    expect(res.body).toMatchObject({ status: 'failed', error: 'team_changed' });
    await until(() => noticesTo(b).length === 1, 'failed notice');
    expect(noticesTo(b)[0]).toMatch(
      /could not be started: team_changed: You are no longer the lead/,
    );
    expect(hub.running.store.listTeams()).toHaveLength(1);
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('S1 隊長帶兩隊：同意後開進申請時的那一隊，不是另一隊', async () => {
    const { b, teamId } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    // 之後隊長又當了另一隊（名稱排在前面，teamOf 會先挑到它）的隊長。
    const other = await hub.api('POST', '/api/teams', {
      cookie: b.cookie,
      body: { name: 'Alpha', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
    });
    await hub.api('PUT', `/api/teams/${other.body.id}/members/${b.caller}`, {
      cookie: b.cookie,
      body: { role: 'lead' },
    });
    expect(pending().map((r) => r.id)).toEqual([id]);
    const approve = hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    const create = await confirmCreate(b, 'Parser-QA');
    expect((await approve).body).toMatchObject({ status: 'approved' });
    const memberId = create.sessionId as string;
    expect(hub.running.store.listTeamMembers(teamId).map((m) => m.sessionId)).toContain(memberId);
    expect(
      hub.running.store.listTeamMembers(other.body.id as string).map((m) => m.sessionId),
    ).not.toContain(memberId);
  });

  it('W2 同意途中 hub 掛掉（紀錄停在 approving）：重啟後標 failed／interrupted、告訴隊長，不自動重開', async () => {
    const { b } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const key = `staffRequest:${id}`;
    const raw = hub.running.store.getRawJson(key) as Record<string, unknown>;
    hub.running.store.setRawJson(key, { ...raw, status: 'approving', decidedBy: 'owner' });
    expect(pending()).toEqual([]);
    await restart(b);
    await until(() => noticesTo(b).length === 1, 'interrupted notice');
    expect(noticesTo(b)[0]).toMatch(/Agent Board restarted while starting it/);
    expect(failedCodes()).toEqual(['interrupted']);
    await settle();
    expect(b.daemon.of('session.create')).toHaveLength(0);
  });

  it('W2 待處理（或同意中）時同一隊不能再申請', async () => {
    const { b } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const key = `staffRequest:${id}`;
    const raw = hub.running.store.getRawJson(key) as Record<string, unknown>;
    hub.running.store.setRawJson(key, { ...raw, status: 'approving' });
    const again = await askSpawn(b);
    expect(again.text).toMatch(/^request_pending:/);
  });

  it('W3 owner 讀得到 prompt 全文與字數，一般使用者 403；prompt 超過 20,000 字回 invalid_arguments', async () => {
    const { b } = await fullTeam();
    const long = `Start. ${'x'.repeat(600)} End.`;
    const id = json(await askSpawn(b, { prompt: long })).requestId as string;
    const [summary] = pending();
    expect(summary!.promptChars).toBe([...long].length);
    expect(summary!.promptPreview.length).toBeLessThan(long.length);
    const full = await hub.api('GET', `/api/staff-requests/${id}`, { cookie: b.cookie });
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({ id, prompt: long, promptChars: [...long].length });
    expect(full.body).not.toHaveProperty('args');
    const user = await hub.createMember(b.cookie, 'viewer');
    const denied = await hub.api('GET', `/api/staff-requests/${id}`, { cookie: user.cookie });
    expect(denied.status).toBe(403);
    // 太長的 prompt：直接拒絕，不產生申請（上限和送進成員時的截斷同一個數字 4000，N8）。
    const huge = await ask(b, 'spawn_member', {
      role: 'researcher',
      prompt: 'y'.repeat(4_001),
      reason: 'x',
    });
    expect(huge.text).toMatch(/^invalid_arguments: .*at most 4000 characters/);
    expect(pending()).toHaveLength(1);
    // settings API 不受申請紀錄影響（getSettings 不讀 staffRequest:）。
    const settings = await hub.api('GET', '/api/settings', { cookie: b.cookie });
    expect(JSON.stringify(settings.body)).not.toContain('staffRequest');
  });

  it('W1 加開申請的動態和團隊動態分開存；團隊動態格式維持舊版（成員欄位必填），讀不懂的那一筆略過', async () => {
    const { b } = await fullTeam();
    json(await askSpawn(b));
    expect(hub.running.store.listStaffActivity()).toHaveLength(1);
    expect(hub.running.store.listTeamActivity()).toEqual([]);
    // 逐筆讀：一筆壞掉的不會讓整份變空。
    const good = {
      id: 'a-1',
      at: '2026-11-13T01:00:00.000Z',
      kind: 'member_added',
      teamId: 't',
      teamName: 'T',
      leadSessionId: 'l',
      leadName: 'L',
      memberSessionId: 'm',
      memberName: 'M',
      role: 'worker',
      reason: 'r',
      read: false,
    };
    hub.running.store.setRawJson('teamActivity', [{ ...good, kind: 'future_kind' }, good]);
    expect(hub.running.store.listTeamActivity().map((a) => a.id)).toEqual(['a-1']);
    // REST：標已讀、清除。
    const read = await hub.api('POST', '/api/staff-activity/read', { cookie: b.cookie, body: {} });
    expect(read.body).toEqual([expect.objectContaining({ read: true })]);
    const cleared = await hub.api('POST', '/api/staff-activity/clear', {
      cookie: b.cookie,
      body: {},
    });
    expect(cleared.body).toEqual([]);
  });

  it('N1 通知打進去、Enter 前隊長不再等輸入：不重送（結案），隊長從 list_members 的 lastDecision 查得到結果', async () => {
    const { b } = await fullTeam({ handoffEnterDelayMs: 400 });
    const id = json(await askSpawn(b)).requestId as string;
    await hub.api('POST', `/api/staff-requests/${id}/reject`, { cookie: b.cookie });
    await until(() => noticesTo(b).length === 1, 'first try typed');
    await setStatus(b, b.caller, 'running');
    await until(
      () =>
        audits('staff_request.notice_dropped').some(
          (a) => JSON.parse(a.detail).reason === 'target_busy',
        ),
      'dropped as target_busy',
    );
    expect(hub.running.store.getRawJson(`staffRequest:${id}`)).toBeNull();
    // 隊長回到等輸入：不會再打一次。
    await setStatus(b, b.caller, 'waiting_input');
    await settle();
    expect(noticesTo(b)).toHaveLength(1);
    expect(enterTo(b, b.caller)).toBe(0);
    const listed = json(await ask(b, 'list_members')) as {
      teams: { staffing: { lastDecision?: Record<string, unknown> } }[];
    };
    expect(listed.teams[0]!.staffing.lastDecision).toEqual({
      requestId: id,
      at: expect.any(String),
      role: 'tester',
      result: 'rejected',
    });
    // 不含 prompt、理由。
    expect(JSON.stringify(listed.teams[0]!.staffing.lastDecision)).not.toMatch(/parser/i);
  });

  it('N1 lastDecision：同意後帶成員名稱、失敗帶代碼', async () => {
    const { b, teamId } = await fullTeam();
    const first = json(await askSpawn(b)).requestId as string;
    const approve = hub.api('POST', `/api/staff-requests/${first}/approve`, { cookie: b.cookie });
    await confirmCreate(b, 'Parser-QA');
    await approve;
    let listed = json(await ask(b, 'list_members')) as {
      teams: { staffing: { lastDecision?: Record<string, unknown> } }[];
    };
    expect(listed.teams[0]!.staffing.lastDecision).toMatchObject({
      requestId: first,
      result: 'approved',
      memberName: 'Parser-QA',
    });
    const second = json(await askSpawn(b, { name: 'Other-QA' })).requestId as string;
    await hub.api('POST', `/api/teams/${teamId}/hold`, {
      cookie: b.cookie,
      body: { mode: 'pause' },
    });
    await hub.api('POST', `/api/staff-requests/${second}/approve`, { cookie: b.cookie });
    listed = json(await ask(b, 'list_members')) as typeof listed;
    expect(listed.teams[0]!.staffing.lastDecision).toMatchObject({
      requestId: second,
      result: 'failed',
      code: 'team_held',
    });
  });

  it('N7 同意後收尾丟例外：紀錄不會卡在 approving（標 failed／finalize_failed、寫 audit）', async () => {
    const { b } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const store = hub.running.store;
    const original = store.saveStaffActivity.bind(store);
    let broken = true;
    store.saveStaffActivity = (items) => {
      if (broken && items.some((a) => a.kind === 'staff_approved')) {
        broken = false;
        throw new Error('simulated write failure');
      }
      original(items);
    };
    const approve = hub.api('POST', `/api/staff-requests/${id}/approve`, { cookie: b.cookie });
    const create = await confirmCreate(b, 'Parser-QA');
    expect((await approve).status).toBe(500);
    expect(store.getRawJson(`staffRequest:${id}`)).toMatchObject({
      status: 'failed',
      error: 'finalize_failed',
      memberSessionId: create.sessionId,
    });
    expect(failedCodes()).toEqual(['finalize_failed']);
    expect(pending()).toEqual([]);
  });

  it('N9 hub 關著時團隊沒了（沒經過 REST）：重啟時 restore 撤回待處理的申請', async () => {
    const { b, teamId } = await fullTeam();
    json(await askSpawn(b));
    hub.running.store.deleteTeam(teamId);
    await restart(b);
    expect(failedCodes()).toEqual(['team_deleted']);
    expect(pending()).toEqual([]);
    await until(() => noticesTo(b).length === 1, 'withdrawn notice after restart');
    expect(noticesTo(b)[0]).toMatch(/withdrawn because the team was deleted/);
  });

  it('N8 prompt 上限用 code point 計（和 promptChars 同一種算法）：4000 個 emoji 剛好可以', async () => {
    const { b } = await fullTeam();
    const emoji = '🧪'.repeat(4_000);
    const reply = json(await askSpawn(b, { prompt: emoji }));
    expect(pending()[0]).toMatchObject({ id: reply.requestId, promptChars: 4_000 });
  });

  it('N5 hub 重啟時超過 24 小時的紀錄直接刪，不通知', async () => {
    const { b } = await fullTeam();
    const id = json(await askSpawn(b)).requestId as string;
    const key = `staffRequest:${id}`;
    const raw = hub.running.store.getRawJson(key) as Record<string, unknown>;
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    hub.running.store.setRawJson(key, { ...raw, at: old });
    await restart(b);
    expect(hub.running.store.getRawJson(key)).toBeNull();
    await settle();
    expect(noticesTo(b)).toEqual([]);
  });
});

// ── 不是 git 的資料夾：共用資料夾的團隊與 git init 之後（CONTRACTS §24） ──────────

describe('不是 git 的資料夾（§24）', () => {
  it('沒勾共用的團隊：開 BD 回固定的指引（請使用者按 git init 或允許共用）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, null);
    await setAutoStaff(b, {});
    await gmTeam(b, []);
    const refused = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
    });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/^worktree_unavailable:/);
    expect(refused.text).toContain(NOT_GIT_WRITER_GUIDE);
    // 明說不開 worktree：和隊長同資料夾衝突，也帶同一段指引。
    const clash = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
      useWorktree: false,
    });
    expect(clash.text).toMatch(/^worktree_required: Same folder as Lead/);
    expect(clash.text).toContain(NOT_GIT_WRITER_GUIDE);
    // 兩次被擋都在隊長身上記固定的事件（網頁卡片提示 git init，§24.5）與 audit；不帶模型寫的字。
    const notGit = eventsOf(b.caller).filter((e) => e.type === NOT_GIT_BLOCKED_EVENT);
    expect(notGit.map((e) => e.payload)).toEqual([
      { tool: 'spawn_member' },
      { tool: 'spawn_member' },
    ]);
    expect(
      hub.running.store
        .listAudit({ limit: 500 })
        .filter(
          (a) => a.action === 'dispatch.blocked' && JSON.parse(a.detail).reason === 'not_git',
        ),
    ).toHaveLength(2);
  });

  it('還沒有團隊、要自己組隊的 session：開 BD 被擋也記事件（§24.5）', async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, null);
    await setAutoStaff(b, {});
    const refused = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
    });
    expect(refused.text).toMatch(/^worktree_unavailable:/);
    expect(eventsOf(b.caller).map((e) => e.type)).toEqual([NOT_GIT_BLOCKED_EVENT]);
    // 唯讀角色在不是 git 的資料夾不開 worktree 就能開，不記被擋。
    const ro = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'researcher',
      prompt: 'x',
      useWorktree: true,
    });
    expect(ro.text).toMatch(/^worktree_unavailable:.*Set useWorktree: false/);
    expect(eventsOf(b.caller).map((e) => e.type)).toEqual([NOT_GIT_BLOCKED_EVENT]);
  });

  it('共用資料夾的團隊：BD 不開 worktree、直接在主資料夾，兩位都可以', async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, null);
    await setAutoStaff(b, {});
    const teamId = await gmTeam(b, []);
    const patch = await hub.api('PATCH', `/api/teams/${teamId}`, {
      cookie: b.cookie,
      body: { sharedWriters: true },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.sharedWriters).toBe(true);
    const first = await spawnMember(b, { role: 'worker', prompt: 'Part one.' });
    expect(first.spec.useWorktree).toBe(false);
    expect(first.reply.useWorktree).toBe(false);
    const second = await spawnMember(b, { role: 'tester', prompt: 'Tests.' });
    expect(second.spec.useWorktree).toBe(false);
    expect(hub.running.store.listTeamMembers(teamId)).toHaveLength(3);
  });

  it('共用資料夾只在不是 git 的資料夾生效：git 資料夾的團隊照常開 worktree，明說不開仍算衝突', async () => {
    const b = await board({ permissionMode: 'acceptEdits' });
    await setAutoStaff(b, {});
    const teamId = await gmTeam(b, []);
    await hub.api('PATCH', `/api/teams/${teamId}`, {
      cookie: b.cookie,
      body: { sharedWriters: true },
    });
    const member = await spawnMember(b, { role: 'worker', prompt: 'Own worktree.' });
    expect(member.spec.useWorktree).toBe(true);
    const clash = await ask(b, 'spawn_member', {
      reason: 'Needed.',
      role: 'worker',
      prompt: 'x',
      useWorktree: false,
    });
    expect(clash.text).toMatch(/^worktree_required: Same folder as Lead/);
  });

  it('git init 之後（daemon 回報 repoRoot）：不用重開隊長，BD 就開 worktree', async () => {
    const b = await board({ permissionMode: 'acceptEdits' }, null);
    await setAutoStaff(b, {});
    await gmTeam(b, []);
    const before = await ask(b, 'spawn_member', { reason: 'Needed.', role: 'worker', prompt: 'x' });
    expect(before.text).toMatch(/^worktree_unavailable:/);
    // daemon 在 git init 後送的 session.runtime（隊長沒有中斷，只有 repo 與分支變了）。
    b.daemon.send({
      type: 'session.runtime',
      session: runtime(b.caller, {
        status: 'waiting_input',
        cwd: CWD,
        branch: 'main',
        repoRoot: CWD,
        repoCommonDir: `${CWD}/.git`,
      }),
    });
    await until(() => get(b.caller)?.repoRoot === CWD, 'repoRoot 更新');
    const member = await spawnMember(b, { role: 'worker', prompt: 'Now with a worktree.' });
    expect(member.spec.useWorktree).toBe(true);
  });
});
