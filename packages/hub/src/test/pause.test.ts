// 全部暫停（P2 項目三，docs/p2-spec.md §3）：真的 hub、假 daemon。驗所有自動送字（交接、任務自動執行、
// MCP 派工、額度恢復自動接續）被擋下並記錄、自動開新 session 被擋、GM 手動送字不擋、「立刻中斷」只對 RUN 送 Esc、
// 繼續後放出、重啟後仍是暫停、所有 client 即時同步。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_CONTINUE_PROMPT,
  type BoardPauseState,
  type Session,
  type SessionStatus,
} from '@agent-board/protocol';
import { SafeDelivery, type DeliveryItem } from '../delivery';
import {
  connect,
  hello,
  PASSWORD,
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

const sleep = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMING = { handoffEnterDelayMs: 20 };
const MARKER = '[交給下一位]';

interface Board {
  cookie: string;
  daemon: Peer;
  token: string;
  machineId: string;
}

async function board(options: { now?: () => Date; timing?: object } = {}): Promise<Board> {
  hub = await startHub({
    ...(options.now ? { now: options.now } : {}),
    timing: { ...TIMING, ...options.timing },
  });
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  return { cookie, daemon, token, machineId };
}

/** 開一個 session，daemon 回報 status（預設等輸入）。各自的資料夾，免得團隊成員撞同一個 working tree。 */
async function start(
  b: Board,
  name: string,
  status: SessionStatus = 'waiting_input',
  daemon: Peer = b.daemon,
  machineId: string = b.machineId,
): Promise<string> {
  const cwd = `/fake/${name}`;
  const res = await hub.api('POST', '/api/sessions', {
    cookie: b.cookie,
    body: { ...spec({ name, cwd }), machineId },
  });
  expect(res.status).toBe(200);
  const create = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
  daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { status, cwd, branch: `ab/${name}` }),
  });
  await until(() => get(res.body.id)?.status === status, `${name} started`);
  return res.body.id as string;
}

const get = (id: string): Session | null => hub.running.store.getSession(id);

const setStatus = async (daemon: Peer, id: string, status: SessionStatus) => {
  const s = get(id)!;
  daemon.send({
    type: 'session.runtime',
    session: runtime(id, { status, cwd: s.cwd, branch: s.branch }),
  });
  await until(() => get(id)?.status === status, `status ${status}`);
};

const sendEvent = (daemon: Peer, sessionId: string, type: string, payload: object) =>
  daemon.send({
    type: 'session.event',
    event: { id: randomUUID(), sessionId, type, payload, at: new Date().toISOString() },
  });

const stopHook = (daemon: Peer, sessionId: string, message: string) =>
  sendEvent(daemon, sessionId, 'hook', { event: 'Stop', last_assistant_message: message });

const inputsTo = (daemon: Peer, sessionId: string) =>
  daemon.messages
    .filter((m) => m.type === 'terminal.input' && m.sessionId === sessionId)
    .map((m) => String(m.data));

const auditRows = (action: string) =>
  hub.running.db
    .prepare('SELECT session_id, user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
    .all(action) as { session_id: string | null; user_id: string | null; detail: string }[];

/** board.state／board.pause 訊息裡的暫停狀態。 */
const pauseOf = (msg: object): BoardPauseState => (msg as { pause: BoardPauseState }).pause;

const pauseBoard = async (cookie: string, mode: 'finish_turn' | 'interrupt') => {
  const res = await hub.api('POST', '/api/board/pause', { cookie, body: { mode } });
  expect(res.status).toBe(200);
  return res.body as {
    state: BoardPauseState;
    interrupted: { sessionId: string; name: string; result: string }[];
  };
};

const resumeBoard = async (cookie: string) => {
  const res = await hub.api('POST', '/api/board/resume', { cookie });
  expect(res.status).toBe(200);
  return res.body as { state: BoardPauseState; released: BoardPauseState['held'] };
};

const pauseState = async (cookie: string) => {
  const res = await hub.api('GET', '/api/board/pause', { cookie });
  expect(res.status).toBe(200);
  return res.body as BoardPauseState;
};

async function handoffRule(b: Board, from: string, to: string): Promise<void> {
  const team = await hub.api('POST', '/api/teams', {
    cookie: b.cookie,
    body: { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
  });
  const res = await hub.api('POST', `/api/teams/${team.body.id}/handoff-rules`, {
    cookie: b.cookie,
    body: {
      fromSessionId: from,
      trigger: 'on_marker',
      action: { toSessionId: to, marker: MARKER },
      enabled: true,
    },
  });
  expect(res.status).toBe(200);
}

/** 來源做完一個回合，回覆帶交接標記。 */
async function finishTurn(b: Board, id: string): Promise<void> {
  await setStatus(b.daemon, id, 'running');
  stopHook(b.daemon, id, `${MARKER} Fixed the parser.`);
  await setStatus(b.daemon, id, 'waiting_input');
}

describe('SafeDelivery 暫停閘門（單元）', () => {
  const target: Session = {
    id: 't',
    machineId: 'm',
    projectId: null,
    name: 't',
    cwd: '/r',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
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
  };

  function setup() {
    const state = { paused: false };
    const sent: string[] = [];
    const held: string[] = [];
    const outcome: string[] = [];
    const delivery = new SafeDelivery({
      store: { getSession: () => target },
      now: () => new Date(),
      enterDelayMs: 20,
      audit: () => {},
      isReachable: () => true,
      sendInput: (_id, data) => sent.push(data),
      guarded: (_label, fn) => fn(),
      paused: () => state.paused,
      held: (item) => held.push(item.key),
    });
    const item = (key: string): DeliveryItem => ({
      key,
      targetId: 't',
      message: `msg ${key}`,
      check: () => null,
      dropped: () => outcome.push(`dropped ${key}`),
      aborted: () => outcome.push(`aborted ${key}`),
      delivered: () => outcome.push(`delivered ${key}`),
    });
    return { state, sent, held, outcome, delivery, item };
  }

  it('暫停時只收不送並交給 held；解除後 flush 才送', async () => {
    const t = setup();
    t.state.paused = true;
    t.delivery.enqueue(t.item('rule:1'));
    await sleep(50);
    expect(t.sent).toEqual([]);
    expect(t.held).toEqual(['rule:1']);
    expect(t.delivery.pendingKeys()).toEqual(['rule:1']);
    t.state.paused = false;
    t.delivery.flush();
    await until(() => t.outcome.includes('delivered rule:1'), 'delivered');
    expect(t.sent).toEqual(['msg rule:1', '\r']);
  });

  it('按暫停時已在佇列的由 noteHeld 記下', () => {
    const t = setup();
    t.delivery.enqueue(t.item('task:1')); // 送出中（等確認）
    t.delivery.enqueue(t.item('task:2')); // 排在後面
    t.state.paused = true;
    t.delivery.noteHeld();
    expect(t.held).toEqual(['task:2']);
  });

  it('字打進去後、Enter 前按了暫停：照樣按 Enter 把這一則送完（不留殘字），下一則才擋', async () => {
    const t = setup();
    t.delivery.enqueue(t.item('rule:1'));
    t.delivery.enqueue(t.item('rule:2'));
    expect(t.sent).toEqual(['msg rule:1']);
    t.state.paused = true;
    await until(() => t.outcome.length > 0, 'enter timer');
    expect(t.outcome).toEqual(['delivered rule:1']);
    expect(t.sent).toEqual(['msg rule:1', '\r']);
    t.delivery.flush();
    await sleep(50);
    expect(t.sent).toEqual(['msg rule:1', '\r']);
    expect(t.delivery.pendingKeys()).toEqual(['rule:2']);
  });

  it('暫停中同一個 key 被蓋掉重排：board.held 只記一次', () => {
    const t = setup();
    t.state.paused = true;
    t.delivery.enqueue(t.item('send:W'));
    t.delivery.enqueue(t.item('send:W'));
    t.delivery.enqueue(t.item('rule:1'));
    expect(t.held).toEqual(['send:W', 'rule:1']);
    expect(t.delivery.pendingKeys()).toEqual(['send:W', 'rule:1']);
  });
});

describe('全部暫停：擋自動送字', () => {
  it('交接：目標沒收到字、排隊 +1、記錄 board.held；RUN 沒收到 Esc；繼續後才送出', async () => {
    const b = await board();
    const a = await start(b, 'a');
    const target = await start(b, 'b');
    await handoffRule(b, a, target);
    await setStatus(b.daemon, a, 'running');
    b.daemon.clear();

    const paused = await pauseBoard(b.cookie, 'finish_turn');
    expect(paused.interrupted).toEqual([]);
    expect(paused.state.paused).toMatchObject({ mode: 'finish_turn', byName: 'owner' });

    // 做完這輪就停：正在跑的 a 沒收到任何東西。
    await sleep();
    expect(b.daemon.of('terminal.signal')).toEqual([]);
    expect(inputsTo(b.daemon, a)).toEqual([]);

    stopHook(b.daemon, a, `${MARKER} Fixed the parser.`);
    await setStatus(b.daemon, a, 'waiting_input');
    await until(() => auditRows('handoff.fired').length === 1, 'handoff fired');
    await sleep();
    expect(inputsTo(b.daemon, target)).toEqual([]);
    expect((await pauseState(b.cookie)).held).toEqual({
      deliveries: 1,
      sessions: 0,
      sessionsWaiting: 0,
      autoContinues: 0,
    });
    const held = auditRows('board.held');
    expect(held).toHaveLength(1);
    expect(held[0]!.session_id).toBe(target);
    expect(JSON.parse(held[0]!.detail)).toMatchObject({ kind: 'handoff' });

    const resumed = await resumeBoard(b.cookie);
    expect(resumed.released).toEqual({
      deliveries: 1,
      sessions: 0,
      sessionsWaiting: 0,
      autoContinues: 0,
    });
    expect(resumed.state.paused).toBeNull();
    await until(() => inputsTo(b.daemon, target).length === 2, 'handoff delivered');
    expect(inputsTo(b.daemon, target)[0]).toContain('Fixed the parser.');
    // 繼續不送「繼續」給任何人（Q8）：a 沒收到字。
    expect(inputsTo(b.daemon, a)).toEqual([]);
    const resumeAudit = auditRows('board.resume');
    expect(resumeAudit).toHaveLength(1);
    expect(JSON.parse(resumeAudit[0]!.detail)).toMatchObject({
      mode: 'finish_turn',
      released: { deliveries: 1 },
    });
  });

  it('暫停前就在排隊的送字，按暫停後也停住並記錄', async () => {
    const b = await board();
    const a = await start(b, 'a');
    const target = await start(b, 'b');
    await handoffRule(b, a, target);
    await setStatus(b.daemon, target, 'running'); // 目標在忙：交接排著
    await finishTurn(b, a);
    await until(() => auditRows('handoff.fired').length === 1, 'handoff fired');
    b.daemon.clear();
    await pauseBoard(b.cookie, 'finish_turn');
    expect(auditRows('board.held')).toHaveLength(1);
    await setStatus(b.daemon, target, 'waiting_input');
    await sleep();
    expect(inputsTo(b.daemon, target)).toEqual([]);
    await resumeBoard(b.cookie);
    await until(() => inputsTo(b.daemon, target).length === 2, 'delivered after resume');
  });

  it('任務自動執行：負責人變等輸入後不送任務，繼續後送', async () => {
    const b = await board();
    const bd = await start(b, 'BD1');
    const team = await hub.api('POST', '/api/teams', {
      cookie: b.cookie,
      body: { name: 'T', goal: 'Goal.', doneCriteria: '', color: 'teal', contextMd: '' },
    });
    const teamId = team.body.id as string;
    await hub.api('PUT', `/api/teams/${teamId}/members/${bd}`, {
      cookie: b.cookie,
      body: { role: 'worker' },
    });
    await hub.api('PATCH', `/api/teams/${teamId}`, { cookie: b.cookie, body: { taskAuto: true } });
    const task = await hub.api('POST', `/api/teams/${teamId}/tasks`, {
      cookie: b.cookie,
      body: { title: 'Fix it', ownerSessionId: bd },
    });
    await setStatus(b.daemon, bd, 'running');
    await hub.api('PATCH', `/api/tasks/${task.body.id}`, {
      cookie: b.cookie,
      body: { column: 'doing' },
    });
    b.daemon.clear();
    await pauseBoard(b.cookie, 'finish_turn');
    await setStatus(b.daemon, bd, 'waiting_input');
    await sleep();
    expect(inputsTo(b.daemon, bd)).toEqual([]);
    expect(hub.running.store.getTask(task.body.id)!.auto).toMatchObject({ state: 'queued' });
    expect(JSON.parse(auditRows('board.held')[0]!.detail)).toMatchObject({ kind: 'task' });

    await resumeBoard(b.cookie);
    await until(() => inputsTo(b.daemon, bd).length === 2, 'task delivered');
    expect(inputsTo(b.daemon, bd)[0]).toContain('[Task #1] Fix it');
  });

  it('MCP 派工：spawn_member 回錯誤不開 session；send_task 排著，繼續後才送', async () => {
    const b = await board();
    const lead = await start(b, 'Lead');
    const worker = await start(b, 'W');
    const team = await hub.api('POST', '/api/teams', {
      cookie: b.cookie,
      body: { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
    });
    for (const [id, role] of [
      [lead, 'lead'],
      [worker, 'worker'],
    ] as const) {
      await hub.api('PUT', `/api/teams/${team.body.id}/members/${id}`, {
        cookie: b.cookie,
        body: { role },
      });
    }
    b.daemon.clear();
    await pauseBoard(b.cookie, 'finish_turn');
    const ask = async (tool: string, args: Record<string, unknown>) => {
      const requestId = randomUUID();
      b.daemon.send({ type: 'dispatch.request', requestId, sessionId: lead, tool, args });
      const reply = await b.daemon.next('dispatch.reply', (m) => m.requestId === requestId);
      return { ok: reply.ok as boolean, text: reply.text as string };
    };

    const spawned = await ask('spawn_member', {
      role: 'worker',
      prompt: 'Write the tests.',
      reason: 'Need tests.',
    });
    expect(spawned.ok).toBe(false);
    expect(spawned.text).toMatch(/^board_paused:/);
    await sleep();
    expect(b.daemon.of('session.create')).toEqual([]);
    expect(hub.running.store.listDispatchedBy(lead)).toEqual([]);
    expect(JSON.parse(auditRows('dispatch.blocked').at(-1)!.detail)).toMatchObject({
      reason: 'board_paused',
    });

    const sent = await ask('send_task', { member: 'W', text: 'Run the suite.' });
    expect(sent.ok).toBe(true);
    expect(JSON.parse(sent.text)).toMatchObject({ state: 'queued' });
    await sleep();
    expect(inputsTo(b.daemon, worker)).toEqual([]);
    expect(JSON.parse(auditRows('board.held')[0]!.detail)).toMatchObject({ kind: 'dispatch' });

    await resumeBoard(b.cookie);
    await until(() => inputsTo(b.daemon, worker).length === 2, 'work delivered');
    expect(inputsTo(b.daemon, worker)[0]).toBe('[From Lead] Run the suite.');
  });

  it('額度恢復自動接續：到期也不送，算在 autoContinues；繼續後送', async () => {
    const LIMIT = "You've hit your limit · resets 3pm (UTC)";
    const LIMITED_AT = '2026-11-06T14:00:00.000Z';
    let now = new Date(LIMITED_AT);
    const b = await board({ now: () => now, timing: { heartbeatMs: 40 } });
    await hub.api('PATCH', '/api/settings', { cookie: b.cookie, body: { autoContinue: true } });
    const id = await start(b, 'BD1', 'running');
    const limited = (inputReady?: boolean) =>
      b.daemon.send({
        type: 'session.runtime',
        session: runtime(id, {
          status: 'rate_limited',
          statusDetail: LIMIT,
          statusSince: LIMITED_AT,
          cwd: '/fake/BD1',
          branch: 'ab/BD1',
          ...(inputReady === undefined ? {} : { inputReady }),
        }),
      });
    limited();
    await until(() => get(id)?.autoContinue?.state === 'scheduled', 'scheduled');
    b.daemon.clear();
    await pauseBoard(b.cookie, 'finish_turn');
    now = new Date('2026-11-06T15:02:00.000Z');
    limited(true);
    await until(() => auditRows('board.held').length === 1, 'held recorded');
    expect(JSON.parse(auditRows('board.held')[0]!.detail)).toMatchObject({
      kind: 'auto_continue',
    });
    await sleep(150);
    expect(inputsTo(b.daemon, id)).toEqual([]);
    expect((await pauseState(b.cookie)).held).toEqual({
      deliveries: 0,
      sessions: 0,
      sessionsWaiting: 0,
      autoContinues: 1,
    });

    const resumed = await resumeBoard(b.cookie);
    expect(resumed.released.autoContinues).toBe(1);
    await until(() => inputsTo(b.daemon, id).length === 2, 'auto continue sent');
    expect(inputsTo(b.daemon, id)).toEqual([AUTO_CONTINUE_PROMPT, '\r']);
  });
});

describe('全部暫停：擋自動開新 session', () => {
  it('QUE 有空位也不啟動；GM 自己開（有名額）照開；繼續後 QUE 才開', async () => {
    const b = await board();
    await start(b, 'a');
    await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 1 } },
    });
    const queued = await hub.api('POST', '/api/sessions', {
      cookie: b.cookie,
      body: { ...spec({ name: 'q', cwd: '/fake/q' }), machineId: b.machineId },
    });
    expect(queued.body.status).toBe('queued');
    b.daemon.clear();
    const paused = await pauseBoard(b.cookie, 'finish_turn');
    // 等名額的 QUE 繼續後也不會開：不算「會放出」。
    expect(paused.state.held).toMatchObject({ sessions: 0, sessionsWaiting: 1 });

    // 放寬名額：沒暫停的話 q 會馬上開。
    await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 5 } },
    });
    await sleep();
    expect(b.daemon.of('session.create')).toEqual([]);
    expect(get(queued.body.id)?.status).toBe('queued');
    expect((await pauseState(b.cookie)).held).toMatchObject({ sessions: 1, sessionsWaiting: 0 });

    // GM 親手開的不擋（Q6）。
    const manual = await hub.api('POST', '/api/sessions', {
      cookie: b.cookie,
      body: { ...spec({ name: 'manual', cwd: '/fake/manual' }), machineId: b.machineId },
    });
    expect(manual.body.status).toBe('starting');
    await b.daemon.next('session.create', (m) => m.sessionId === manual.body.id);

    const resumed = await resumeBoard(b.cookie);
    expect(resumed.released.sessions).toBe(1);
    await b.daemon.next('session.create', (m) => m.sessionId === queued.body.id);
  });
});

/** 假 daemon 回報「立刻中斷」的 Esc 有沒有送（真的 daemon 會先確認狀態）。 */
const signalResult = (daemon: Peer, sessionId: string, sent: boolean, status: SessionStatus) =>
  daemon.send({ type: 'terminal.signalResult', sessionId, signal: 'escape', sent, status });

describe('全部暫停：立刻中斷', () => {
  it('只對 RUN 送 Esc（daemon 端再確認 running）；PERM／ASK 不動；失聯列為 offline；audit 齊全', async () => {
    const b = await board();
    const r1 = await start(b, 'r1', 'running');
    const r2 = await start(b, 'r2', 'running');
    const perm = await start(b, 'perm', 'waiting_permission');
    const ask = await start(b, 'ask', 'waiting_input');
    const plan = await start(b, 'plan', 'plan_review');
    // 第二台機器上的 RUN，之後失聯（變 OFF）。
    const { machineId: m2, daemon: d2 } = await hub.onlineDaemon(b.cookie);
    const far = await start(b, 'far', 'running', d2, m2);
    d2.ws.terminate();
    await until(() => get(far)?.status === 'offline', 'far offline');
    b.daemon.clear();

    const res = await pauseBoard(b.cookie, 'interrupt');
    expect(res.state.paused?.mode).toBe('interrupt');
    const byId = Object.fromEntries(res.interrupted.map((r) => [r.sessionId, r.result]));
    expect(byId).toEqual({ [r1]: 'requested', [r2]: 'requested', [far]: 'offline' });

    await until(() => b.daemon.of('terminal.signal').length === 2, 'two escapes');
    const signals = b.daemon.of('terminal.signal');
    expect(signals.map((m) => m.sessionId).sort()).toEqual([r1, r2].sort());
    for (const m of signals) {
      expect(m).toMatchObject({ signal: 'escape', onlyIfStatus: 'running' });
    }
    await sleep();
    for (const id of [perm, ask, plan]) {
      expect(b.daemon.messages.filter((m) => m.sessionId === id)).toEqual([]);
    }

    const pauseAudit = auditRows('board.pause');
    expect(pauseAudit).toHaveLength(1);
    expect(pauseAudit[0]!.user_id).not.toBeNull();
    expect(JSON.parse(pauseAudit[0]!.detail)).toMatchObject({ mode: 'interrupt', previous: null });
    // terminal.signal 等 daemon 確認真的送了才記；r2 在 daemon 那邊已經轉成 PERM，沒送。
    expect(auditRows('terminal.signal')).toEqual([]);
    signalResult(b.daemon, r1, true, 'running');
    signalResult(b.daemon, r2, false, 'waiting_permission');
    await until(() => auditRows('board.interrupt_skipped').length === 1, 'skipped');
    const signalAudit = auditRows('terminal.signal');
    expect(signalAudit.map((r) => r.session_id)).toEqual([r1]);
    expect(signalAudit[0]).toMatchObject({ detail: 'escape', user_id: pauseAudit[0]!.user_id });
    const skipped = auditRows('board.interrupt_skipped')[0]!;
    expect(skipped.session_id).toBe(r2);
    expect(JSON.parse(skipped.detail)).toEqual({ status: 'waiting_permission' });
    // 不是這次暫停要的（重送、別的 session）不理。
    signalResult(b.daemon, r1, true, 'running');
    signalResult(b.daemon, perm, true, 'running');
    await sleep();
    expect(auditRows('terminal.signal')).toHaveLength(1);
  });

  it('舊版 daemon（不會再確認狀態）不送 Esc，列為 unsupported', async () => {
    const b = await board();
    const { machineId: m2, daemon: old } = await hub.onlineDaemon(b.cookie, { features: [] });
    const r = await start(b, 'r', 'running', old, m2);
    old.clear();
    const res = await pauseBoard(b.cookie, 'interrupt');
    expect(res.interrupted).toEqual([{ sessionId: r, name: 'r', result: 'unsupported' }]);
    await sleep();
    expect(old.of('terminal.signal')).toEqual([]);
    expect(res.state.paused?.mode).toBe('interrupt');
  });

  it('派工成員：daemon 沒送 Esc 就不清它手上的工作（Stop 的結果照樣送回）；送了才清', async () => {
    const b = await board();
    const lead = await start(b, 'Lead');
    const w1 = await start(b, 'W1', 'running');
    const w2 = await start(b, 'W2', 'running');
    const [work1, work2] = [randomUUID(), randomUUID()];
    const work = (workId: string) => ({
      from: lead,
      workId,
      kind: 'send' as const,
      at: new Date().toISOString(),
    });
    hub.running.store.setDispatchWork(w1, work(work1));
    hub.running.store.setDispatchWork(w2, work(work2));
    b.daemon.clear();
    await pauseBoard(b.cookie, 'interrupt');
    await until(() => b.daemon.of('terminal.signal').length === 2, 'escapes');
    // daemon 回報之前什麼都不清。
    expect(hub.running.store.dispatchWork(w1)).not.toBeNull();
    expect(hub.running.store.dispatchWork(w2)).not.toBeNull();
    signalResult(b.daemon, w1, false, 'waiting_permission');
    signalResult(b.daemon, w2, true, 'running');
    await until(() => hub.running.store.dispatchWork(w2) === null, 'w2 cleared');
    await until(() => auditRows('board.interrupt_skipped').length === 1, 'w1 skipped');
    expect(hub.running.store.dispatchWork(w1)).toMatchObject({ workId: work1 });
    expect(JSON.parse(auditRows('dispatch.blocked').at(-1)!.detail)).toMatchObject({
      reason: 'interrupted',
      workId: work2,
    });
  });

  it('Esc 後回到等輸入的 session 不會被交接再餵（立刻中斷一定包含閘門）', async () => {
    const b = await board();
    const a = await start(b, 'a', 'running');
    const target = await start(b, 'b');
    await handoffRule(b, a, target);
    b.daemon.clear();
    await pauseBoard(b.cookie, 'interrupt');
    await until(() => b.daemon.of('terminal.signal').length === 1, 'escape');
    signalResult(b.daemon, a, true, 'running');
    stopHook(b.daemon, a, `${MARKER} Interrupted halfway.`);
    await setStatus(b.daemon, a, 'waiting_input');
    await until(() => auditRows('board.held').length === 1, 'held');
    await sleep();
    expect(inputsTo(b.daemon, target)).toEqual([]);
  });

  it('暫停中改成立刻中斷：送 Esc、開始時間不變', async () => {
    const b = await board();
    const r = await start(b, 'r', 'running');
    const first = await pauseBoard(b.cookie, 'finish_turn');
    b.daemon.clear();
    const second = await pauseBoard(b.cookie, 'interrupt');
    expect(second.state.paused?.since).toBe(first.state.paused?.since);
    expect(second.interrupted).toEqual([{ sessionId: r, name: 'r', result: 'requested' }]);
    expect(JSON.parse(auditRows('board.pause')[1]!.detail)).toMatchObject({
      mode: 'interrupt',
      previous: 'finish_turn',
    });
  });

  it('暫停前剛開、還在啟動的派工成員記在 board.pause（firstPrompt 由 daemon 自己送，閘門擋不到）', async () => {
    const b = await board();
    const lead = await start(b, 'Lead');
    const requestId = randomUUID();
    b.daemon.send({
      type: 'dispatch.request',
      requestId,
      sessionId: lead,
      tool: 'spawn_member',
      args: { role: 'researcher', prompt: 'Read the docs.', reason: 'Need the docs read.' },
    });
    const reply = await b.daemon.next('dispatch.reply', (m) => m.requestId === requestId);
    expect(reply.ok, String(reply.text)).toBe(true);
    const [member] = hub.running.store.listDispatchedBy(lead);
    expect(member?.status).toBe('starting');
    await pauseBoard(b.cookie, 'finish_turn');
    expect(JSON.parse(auditRows('board.pause')[0]!.detail)).toMatchObject({
      startingDispatched: [member!.id],
    });
  });
});

describe('全部暫停：GM 手動、權限、同步、重啟', () => {
  it('暫停中 GM 從網頁送的字照常送達', async () => {
    const b = await board();
    const id = await start(b, 'a');
    await pauseBoard(b.cookie, 'interrupt');
    const client = await hub.client(b.cookie);
    b.daemon.clear();
    client.send({ type: 'terminal.input', sessionId: id, data: 'hello' });
    client.send({ type: 'terminal.input', sessionId: id, data: '\r' });
    await until(() => inputsTo(b.daemon, id).length === 2, 'manual input');
    expect(inputsTo(b.daemon, id)).toEqual(['hello', '\r']);
  });

  it('一般使用者（非 owner）也能暫停與繼續；沒登入不行；/api/settings 改不到暫停狀態', async () => {
    const b = await board();
    const member = await hub.createMember(b.cookie);
    expect(
      (await hub.api('POST', '/api/board/pause', { body: { mode: 'finish_turn' } })).status,
    ).toBe(401);
    expect(
      (
        await hub.api('POST', '/api/board/pause', {
          cookie: member.cookie,
          body: { mode: 'stop_everything' },
        })
      ).status,
    ).toBe(400);
    const res = await pauseBoard(member.cookie, 'finish_turn');
    expect(res.state.paused).toMatchObject({ by: member.id, byName: 'member' });
    await hub.api('PATCH', '/api/settings', { cookie: b.cookie, body: { boardPause: null } });
    expect((await pauseState(member.cookie)).paused).not.toBeNull();
    const settings = await hub.api('GET', '/api/settings', { cookie: b.cookie });
    expect(settings.body).not.toHaveProperty('boardPause');
    expect((await resumeBoard(member.cookie)).state.paused).toBeNull();
    // 沒暫停時繼續：什麼都不做，不寫 audit。
    expect((await resumeBoard(member.cookie)).released).toEqual({
      deliveries: 0,
      sessions: 0,
      sessionsWaiting: 0,
      autoContinues: 0,
    });
    expect(auditRows('board.resume')).toHaveLength(1);
  });

  it('所有 client 即時收到暫停狀態；新連上的 board.state 帶著暫停', async () => {
    const b = await board();
    const one = await hub.client(b.cookie);
    const two = await hub.client(b.cookie);
    await pauseBoard(b.cookie, 'finish_turn');
    for (const peer of [one, two]) {
      const msg = pauseOf(await peer.next('board.pause'));
      expect(msg.paused?.mode).toBe('finish_turn');
    }
    // hub.client 會吃掉第一則 board.state，這裡自己連。
    const three = await connect(`ws://127.0.0.1:${hub.port}/ws/client`, {
      cookie: b.cookie,
      origin: hub.url,
    });
    const state = pauseOf(await three.next('board.state'));
    expect(state.paused?.mode).toBe('finish_turn');
    three.ws.terminate();
    await resumeBoard(b.cookie);
    expect(pauseOf(await two.next('board.pause')).paused).toBeNull();
  });

  it('繼續後推出去的是放出之後的排隊數（不是放出前的）', async () => {
    const b = await board();
    const a = await start(b, 'a');
    const target = await start(b, 'b');
    await handoffRule(b, a, target);
    await pauseBoard(b.cookie, 'finish_turn');
    await finishTurn(b, a);
    await until(() => auditRows('board.held').length === 1, 'held');
    const client = await hub.client(b.cookie);
    await resumeBoard(b.cookie);
    const msg = pauseOf(await client.next('board.pause'));
    expect(msg.paused).toBeNull();
    expect(msg.held.deliveries).toBe(0);
    await until(() => inputsTo(b.daemon, target).length === 2, 'delivered');
  });

  it('暫停中排隊數變了也推給 client', async () => {
    const b = await board();
    const a = await start(b, 'a');
    const target = await start(b, 'b');
    await handoffRule(b, a, target);
    const client = await hub.client(b.cookie);
    await pauseBoard(b.cookie, 'finish_turn');
    await client.next('board.pause');
    await finishTurn(b, a);
    const msg = pauseOf(await client.next('board.pause', (m) => pauseOf(m).held.deliveries === 1));
    expect(msg.paused?.mode).toBe('finish_turn');
  });

  it('hub 重啟後仍是暫停；記憶體裡被擋的送字清掉並記下則數；QUE 不會在重連時被開', async () => {
    const b = await board();
    const a = await start(b, 'a');
    const target = await start(b, 'b');
    await handoffRule(b, a, target);
    await hub.api('PATCH', '/api/settings', {
      cookie: b.cookie,
      body: { quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 2 } },
    });
    const queued = await hub.api('POST', '/api/sessions', {
      cookie: b.cookie,
      body: { ...spec({ name: 'q', cwd: '/fake/q' }), machineId: b.machineId },
    });
    expect(queued.body.status).toBe('queued');
    await pauseBoard(b.cookie, 'finish_turn');
    await finishTurn(b, a);
    await until(() => auditRows('board.held').length === 1, 'held');

    const { dbPath } = hub;
    await hub.running.close();
    hub = await startHub({ dbPath, timing: TIMING });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    // 名額放寬後 daemon 重連：沒暫停的話 q 會開。
    hub.running.store.updateSettings({
      quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 5, queueWhenRateLimited: false },
    });
    const daemon = await hub.daemon(b.token);
    daemon.send(
      hello({
        sessions: [
          runtime(a, { status: 'waiting_input', cwd: '/fake/a', branch: 'ab/a' }),
          runtime(target, { status: 'waiting_input', cwd: '/fake/b', branch: 'ab/b' }),
        ],
      }),
    );
    await daemon.next('hub.welcome');
    await until(() => get(target)?.status === 'waiting_input', 'reconnected');
    await sleep();
    expect(daemon.of('session.create')).toEqual([]);
    expect(inputsTo(daemon, target)).toEqual([]);

    const state = await pauseState(cookie);
    expect(state.paused).toMatchObject({ mode: 'finish_turn', clearedOnRestart: 1 });
    expect(state.held).toEqual({
      deliveries: 0,
      sessions: 1,
      sessionsWaiting: 0,
      autoContinues: 0,
    });
    expect(JSON.parse(auditRows('board.held_cleared')[0]!.detail)).toEqual({
      reason: 'hub_restarted',
      count: 1,
    });

    const resumed = await resumeBoard(cookie);
    expect(resumed.state.paused).toBeNull();
    await daemon.next('session.create', (m) => m.sessionId === queued.body.id);
    // 重啟後清掉的交接不會自己回來。
    await sleep();
    expect(inputsTo(daemon, target)).toEqual([]);
  });
});
