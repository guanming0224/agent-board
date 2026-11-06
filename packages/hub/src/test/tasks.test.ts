// 任務自動執行：真的 hub、假 daemon。驗送進 PTY 的內容、只送一次、完成與審查標記、退回上限、開關與重啟。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '@agent-board/protocol';
import { afterMarker, findTaskMarker, rejectPrompt, reviewPrompt, taskPrompt } from '../tasks';
import {
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

interface Board {
  cookie: string;
  daemon: Peer;
  token: string;
  teamId: string;
  /** 負責人（BD）。 */
  bd: string;
  bd2: string;
  rv: string;
  rv2: string;
}

const GOAL = 'Fix the login redirect loop.';

async function board(options: { reviewers?: number; taskAuto?: boolean } = {}): Promise<Board> {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  const start = async (name: string) => {
    // 各自的資料夾：同一個 working tree 的寫入者會被 teamMembersPut 擋下。
    const cwd = `/fake/${name}`;
    const res = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec({ name, cwd }), machineId },
    });
    const create = await daemon.next('session.create');
    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(res.body.id, { status: 'waiting_input', branch: `ab/${name}`, cwd }),
    });
    await until(() => sessionStatus(res.body.id) === 'waiting_input', 'session started');
    names.set(res.body.id, name);
    return res.body.id as string;
  };
  const bd = await start('BD1');
  const bd2 = await start('BD2');
  const rv = await start('RV1');
  const rv2 = await start('RV2');
  const team = await hub.api('POST', '/api/teams', {
    cookie,
    body: { name: 'T', goal: GOAL, doneCriteria: '', color: 'teal', contextMd: '' },
  });
  const teamId = team.body.id as string;
  expect(team.body.taskAuto).toBe(false);
  const put = async (sessionId: string, role: string) => {
    const res = await hub.api('PUT', `/api/teams/${teamId}/members/${sessionId}`, {
      cookie,
      body: { role },
    });
    expect(res.status).toBe(200);
  };
  await put(bd, 'worker');
  await put(bd2, 'worker');
  const reviewers = options.reviewers ?? 1;
  if (reviewers >= 1) await put(rv, 'reviewer');
  if (reviewers >= 2) await put(rv2, 'reviewer');
  if (options.taskAuto ?? true) {
    const on = await hub.api('PATCH', `/api/teams/${teamId}`, { cookie, body: { taskAuto: true } });
    expect(on.body.taskAuto).toBe(true);
  }
  daemon.clear();
  return { cookie, daemon, token, teamId, bd, bd2, rv, rv2 };
}

function sessionStatus(id: string): string | undefined {
  const row = hub.running.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as
    { status: string } | undefined;
  return row?.status;
}

/** session id → 名稱：回報狀態時帶著同樣的資料夾與分支（runtime 會覆蓋 hub 的欄位）。 */
const names = new Map<string, string>();
const where = (id: string) => ({ cwd: `/fake/${names.get(id)}`, branch: `ab/${names.get(id)}` });

const setStatus = async (daemon: Peer, id: string, status: string) => {
  daemon.send({
    type: 'session.runtime',
    session: runtime(id, { status: status as never, ...where(id) }),
  });
  await until(() => sessionStatus(id) === status, `status ${status}`);
};

/** 收到交接或任務後做完一個回合：離開再回到等輸入（送字的確認也就清掉了）。 */
const work = async (daemon: Peer, id: string) => {
  await setStatus(daemon, id, 'running');
  await setStatus(daemon, id, 'waiting_input');
};

const sendEvent = (daemon: Peer, sessionId: string, type: string, payload: object) =>
  daemon.send({
    type: 'session.event',
    event: { id: randomUUID(), sessionId, type, payload, at: new Date().toISOString() },
  });

const stop = (daemon: Peer, sessionId: string, message: string) =>
  sendEvent(daemon, sessionId, 'hook', { event: 'Stop', last_assistant_message: message });

const inputsTo = (daemon: Peer, sessionId: string) =>
  daemon.messages
    .filter((m) => m.type === 'terminal.input' && m.sessionId === sessionId)
    .map((m) => String(m.data));

/** 文字（不含 Enter）。 */
const textsTo = (daemon: Peer, sessionId: string) =>
  inputsTo(daemon, sessionId).filter((data) => data !== '\r');

const newTask = async (t: Board, title: string, owner: string | null = t.bd): Promise<Task> => {
  const res = await hub.api('POST', `/api/teams/${t.teamId}/tasks`, {
    cookie: t.cookie,
    body: { title, ownerSessionId: owner },
  });
  expect(res.status).toBe(200);
  return res.body as Task;
};

const patchTask = async (t: Board, id: string, body: object) => {
  const res = await hub.api('PATCH', `/api/tasks/${id}`, { cookie: t.cookie, body });
  expect(res.status).toBe(200);
  return res.body as Task;
};

const getTask = async (t: Board, id: string): Promise<Task> => {
  const res = await hub.api('GET', `/api/teams/${t.teamId}/tasks`, { cookie: t.cookie });
  return (res.body as Task[]).find((task) => task.id === id)!;
};

const taskNow = (id: string) => hub.running.store.getTask(id)!;

const auditRows = (action: string) =>
  hub.running.db
    .prepare('SELECT session_id, user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
    .all(action) as { session_id: string | null; user_id: string | null; detail: string }[];

const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe('task markers and prompts', () => {
  it('matches [完成 #n] exactly, bare [完成] only when allowed, and never inside [結果完成]', () => {
    expect(findTaskMarker('All good. [完成 #3] Fixed it.', '完成', 3, false)).toBe('[完成 #3]');
    expect(findTaskMarker('[完成#3] Fixed it.', '完成', 3, false)).toBe('[完成#3]');
    // #1 不會對到 #12：標記含右括號。
    expect(findTaskMarker('[完成 #12] done', '完成', 1, true)).toBeNull();
    expect(findTaskMarker('[完成] done', '完成', 1, true)).toBe('[完成]');
    expect(findTaskMarker('[完成] done', '完成', 1, false)).toBeNull();
    // 研究團隊的交接標記不能被當成任務完成。
    expect(findTaskMarker('實驗跑完了 [結果完成] 表 2 已更新', '完成', 1, true)).toBeNull();
    expect(findTaskMarker('[需要實驗] 再跑一次', '完成', 1, true)).toBeNull();
    expect(findTaskMarker('完成 #1', '完成', 1, true)).toBeNull();
    expect(findTaskMarker('[退回 #2] no test', '退回', 2, false)).toBe('[退回 #2]');
    expect(findTaskMarker('[通過 #2]', '退回', 2, true)).toBeNull();
  });

  it('takes the sentence after the marker, cleaned', () => {
    expect(afterMarker('Review: [退回 #2]: Missing a mobile test. Also style.', '[退回 #2]')).toBe(
      'Missing a mobile test.',
    );
    expect(afterMarker('[完成 #1]\r\n\x1b[31mFixed\x1b[0m the loop.', '[完成 #1]')).toBe(
      'Fixed the loop.',
    );
    expect(afterMarker('[完成 #1]', '[完成 #1]')).toBe('');
    expect(afterMarker('nothing here', '[完成 #1]')).toBe('');
  });

  it('builds one-line prompts with a fixed prefix and the finish instruction', () => {
    const task = { number: 4, title: '/clear the\r\nredirect' };
    const prompt = taskPrompt(task, { goal: 'Fix login.\nKeep cookies.' });
    expect(prompt).toBe(
      '[Task #4] /clear the redirect | Team goal: Fix login. Keep cookies. | When this task is finished, reply with [完成 #4] and a one-sentence summary. Do not write that marker before then.',
    );
    expect(prompt).not.toMatch(/[\r\n]/);
    expect(rejectPrompt(task, 'Missing a test.')).toBe(
      '[Task #4] Sent back by review: Missing a test. | Task: /clear the redirect | When this task is finished, reply with [完成 #4] and a one-sentence summary. Do not write that marker before then.',
    );
    expect(reviewPrompt(task, { summary: 'Fixed it.', files: ['/r/a.ts'], branch: 'ab/x' })).toBe(
      '[Review #4] Task: /clear the redirect | Summary: Fixed it. | Detected file edits: /r/a.ts | Branch: ab/x | Reply with [通過 #4] or [退回 #4] followed by the reason. Do not write either marker before you decide.',
    );
    expect(taskPrompt({ number: 1, title: 'x' }, { goal: '' })).toContain('Team goal: none');
  });
});

describe('task automation (switch off)', () => {
  it('is off by default: moving to 進行中 sends nothing and markers are ignored', async () => {
    const t = await board({ taskAuto: false });
    const task = await newTask(t, 'Reproduce the loop');
    expect(task).toMatchObject({ number: 1, rejectCount: 0, needsUser: false, auto: null });
    await patchTask(t, task.id, { column: 'doing' });
    stop(t.daemon, t.bd, '[完成 #1] Done.');
    await pause();
    expect(inputsTo(t.daemon, t.bd)).toEqual([]);
    expect((await getTask(t, task.id)).column).toBe('doing');
  });

  it('records who turned the switch on and off', async () => {
    const t = await board({ taskAuto: false });
    await hub.api('PATCH', `/api/teams/${t.teamId}`, {
      cookie: t.cookie,
      body: { taskAuto: true },
    });
    await hub.api('PATCH', `/api/teams/${t.teamId}`, { cookie: t.cookie, body: { name: 'T2' } });
    await hub.api('PATCH', `/api/teams/${t.teamId}`, {
      cookie: t.cookie,
      body: { taskAuto: false },
    });
    const rows = auditRows('team.task_auto');
    expect(rows.map((r) => JSON.parse(r.detail).on)).toEqual([true, false]);
    expect(rows.every((r) => r.user_id !== null)).toBe(true);
  });
});

describe('task automation (full loop)', () => {
  it('start → done → review → reject → done → pass, each step sent once and only when idle', async () => {
    const t = await board();
    const task = await newTask(t, 'Fix the redirect');
    // 負責人在忙：先排著，不打進去。
    await setStatus(t.daemon, t.bd, 'running');
    let saved = await patchTask(t, task.id, { column: 'doing' });
    expect(saved.auto).toMatchObject({ state: 'queued', sessionId: t.bd });
    await pause();
    expect(inputsTo(t.daemon, t.bd)).toEqual([]);

    await setStatus(t.daemon, t.bd, 'waiting_input');
    await until(() => inputsTo(t.daemon, t.bd).length === 2, 'task text and enter');
    expect(inputsTo(t.daemon, t.bd)).toEqual([
      `[Task #1] Fix the redirect | Team goal: ${GOAL} | When this task is finished, reply with [完成 #1] and a one-sentence summary. Do not write that marker before then.`,
      '\r',
    ]);
    await until(() => taskNow(task.id).auto?.state === 'sent', 'sent');

    // 同一欄重存、改標題：不重送。
    await patchTask(t, task.id, { column: 'doing' });
    await patchTask(t, task.id, { title: 'Fix the redirect' });
    await work(t.daemon, t.bd);
    await pause();
    expect(textsTo(t.daemon, t.bd)).toHaveLength(1);

    // 負責人做完：改了檔案、回覆帶完成標記 → 待審查，送給審查。
    sendEvent(t.daemon, t.bd, 'file.changed', { path: '/r/login.ts' });
    stop(t.daemon, t.bd, 'Work is complete. [完成 #1] Fixed the redirect loop. More details.');
    await until(() => textsTo(t.daemon, t.rv).length === 1, 'review sent');
    expect(textsTo(t.daemon, t.rv)[0]).toBe(
      '[Review #1] Task: Fix the redirect | Summary: Fixed the redirect loop. | Detected file edits: /r/login.ts | Branch: ab/BD1 | Reply with [通過 #1] or [退回 #1] followed by the reason. Do not write either marker before you decide.',
    );
    await until(() => taskNow(task.id).auto?.state === 'review_sent', 'review sent state');
    saved = taskNow(task.id);
    expect(saved).toMatchObject({ column: 'review', reviewerSessionId: t.rv });

    // 審查退回 → 回到進行中，原因送給負責人。
    await work(t.daemon, t.rv);
    stop(
      t.daemon,
      t.rv,
      'Looked at it. [退回 #1] Missing a test for mobile Safari. Otherwise fine.',
    );
    await until(() => textsTo(t.daemon, t.bd).length === 2, 'reject sent to owner');
    expect(textsTo(t.daemon, t.bd)[1]).toBe(
      '[Task #1] Sent back by review: Missing a test for mobile Safari. | Task: Fix the redirect | When this task is finished, reply with [完成 #1] and a one-sentence summary. Do not write that marker before then.',
    );
    await until(() => taskNow(task.id).auto?.state === 'sent', 'reject delivered');
    expect(taskNow(task.id)).toMatchObject({ column: 'doing', rejectCount: 1, needsUser: false });

    // 再做一次：送審時只列這次之後改的檔案，同一位審查。
    await work(t.daemon, t.bd);
    sendEvent(t.daemon, t.bd, 'file.changed', { path: '/r/login.test.ts' });
    stop(t.daemon, t.bd, '[完成 #1] Added the mobile test.');
    await until(() => textsTo(t.daemon, t.rv).length === 2, 'second review');
    expect(textsTo(t.daemon, t.rv)[1]).toContain(
      'Summary: Added the mobile test. | Detected file edits: /r/login.test.ts |',
    );
    await work(t.daemon, t.rv);
    stop(t.daemon, t.rv, '[通過 #1] Looks good.');
    await until(() => taskNow(task.id).column === 'done', 'passed');
    expect(taskNow(task.id)).toMatchObject({
      rejectCount: 1,
      auto: { state: 'passed', sessionId: t.rv },
    });

    // 每一步都有 audit（系統做的：user 是 null）與事件。
    for (const action of [
      'task.dispatched',
      'task.delivered',
      'task.completed',
      'task.reviewed',
      'task.rejected',
    ]) {
      expect(auditRows(action).length, action).toBeGreaterThan(0);
      expect(auditRows(action).every((r) => r.user_id === null)).toBe(true);
    }
    expect(auditRows('terminal.input').every((r) => r.user_id === null)).toBe(true);
    const events = await hub.api('GET', `/api/sessions/${t.rv}/events`, { cookie: t.cookie });
    const delivered = (events.body as { type: string; payload: Record<string, unknown> }[]).filter(
      (e) => e.type === 'task.delivered',
    );
    // 畫布的交接動畫：送審是負責人 → 審查。
    expect(delivered[0]!.payload).toMatchObject({
      kind: 'review',
      fromSessionId: t.bd,
      toSessionId: t.rv,
      number: 1,
    });
  });

  it('stops at the reject limit: stays in 待審查, needs the person, and notifies', async () => {
    const t = await board();
    await hub.api('POST', '/api/push/subscriptions', {
      cookie: t.cookie,
      body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    });
    const task = await newTask(t, 'Fix the redirect');
    await patchTask(t, task.id, { column: 'doing' });
    for (let round = 1; round <= 3; round += 1) {
      await until(() => textsTo(t.daemon, t.bd).length === round, `owner prompt ${round}`);
      await work(t.daemon, t.bd);
      stop(t.daemon, t.bd, `[完成 #1] Attempt ${round}.`);
      await until(() => textsTo(t.daemon, t.rv).length === round, `review ${round}`);
      await work(t.daemon, t.rv);
      stop(t.daemon, t.rv, `[退回 #1] Still wrong (${round}).`);
      await until(() => taskNow(task.id).rejectCount === round, `reject ${round}`);
    }
    await pause();
    // 前兩次退回送回負責人，第三次停下。
    expect(textsTo(t.daemon, t.bd)).toHaveLength(3);
    expect(taskNow(task.id)).toMatchObject({
      column: 'review',
      rejectCount: 3,
      needsUser: true,
      auto: { state: 'limit', sessionId: t.rv, note: 'Still wrong (3).' },
    });
    expect(auditRows('task.limit')).toHaveLength(1);
    await hub.running.hub.pushesSettled();
    const pushed = hub.push.sent.map((p) => JSON.parse(p.payload) as Record<string, unknown>);
    expect(pushed.filter((p) => p.reason === 'task_reject_limit')).toEqual([
      expect.objectContaining({ sessionId: t.rv, name: 'RV1', maxRounds: 3, task: 1 }),
    ]);
    expect(JSON.stringify(pushed)).not.toContain('Still wrong');

    // 審查再回覆也不動它；使用者移回進行中：清掉「等你決定」，次數保留，重新送給負責人。
    stop(t.daemon, t.rv, '[通過 #1]');
    await pause();
    expect(taskNow(task.id).column).toBe('review');
    const moved = await patchTask(t, task.id, { column: 'doing' });
    expect(moved).toMatchObject({ needsUser: false, rejectCount: 3 });
    await until(() => textsTo(t.daemon, t.bd).length === 4, 'resent after the person decided');
  });

  it('bare [完成] only counts when the owner has exactly one task in 進行中', async () => {
    const t = await board();
    const one = await newTask(t, 'One');
    const two = await newTask(t, 'Two');
    await patchTask(t, one.id, { column: 'doing' });
    await until(() => textsTo(t.daemon, t.bd).length === 1, 'first prompt');
    await work(t.daemon, t.bd);
    await patchTask(t, two.id, { column: 'doing' });
    await until(() => textsTo(t.daemon, t.bd).length === 2, 'second prompt');
    expect(textsTo(t.daemon, t.bd)[1]).toMatch(/^\[Task #2\] Two/);
    await work(t.daemon, t.bd);

    stop(t.daemon, t.bd, '[完成] All done.');
    await pause();
    expect(taskNow(one.id).column).toBe('doing');
    expect(taskNow(two.id).column).toBe('doing');

    stop(t.daemon, t.bd, '[完成 #2] Two is done.');
    await until(() => taskNow(two.id).column === 'review', 'two in review');
    expect(taskNow(one.id).column).toBe('doing');

    // 研究團隊的 [結果完成] 不算完成。
    stop(t.daemon, t.bd, '實驗跑完了 [結果完成] 表 2 已更新');
    await pause();
    expect(taskNow(one.id).column).toBe('doing');
    // 現在只剩一個進行中：不帶編號也算。
    stop(t.daemon, t.bd, '[完成] One is done too.');
    await until(() => taskNow(one.id).column === 'review', 'one in review');
  });

  it('round-robins between reviewers; with no reviewer the task waits for the person', async () => {
    const t = await board({ reviewers: 2 });
    const one = await newTask(t, 'One', t.bd);
    const two = await newTask(t, 'Two', t.bd2);
    await patchTask(t, one.id, { column: 'doing' });
    await patchTask(t, two.id, { column: 'doing' });
    await until(() => textsTo(t.daemon, t.bd2).length === 1, 'bd2 prompt');
    await work(t.daemon, t.bd);
    await work(t.daemon, t.bd2);
    stop(t.daemon, t.bd, '[完成 #1] One.');
    await until(() => taskNow(one.id).reviewerSessionId !== null, 'one assigned');
    stop(t.daemon, t.bd2, '[完成 #2] Two.');
    await until(() => taskNow(two.id).reviewerSessionId !== null, 'two assigned');
    expect(new Set([taskNow(one.id).reviewerSessionId, taskNow(two.id).reviewerSessionId])).toEqual(
      new Set([t.rv, t.rv2]),
    );
  });

  it('without a reviewer member the reported task stays in 待審查 for the person', async () => {
    const t = await board({ reviewers: 0 });
    const task = await newTask(t, 'Solo');
    await patchTask(t, task.id, { column: 'doing' });
    await until(() => textsTo(t.daemon, t.bd).length === 1, 'prompt');
    await work(t.daemon, t.bd);
    stop(t.daemon, t.bd, '[完成 #1] Solo done.');
    await until(() => taskNow(task.id).column === 'review', 'in review');
    expect(taskNow(task.id).auto).toMatchObject({
      state: 'reported',
      sessionId: t.bd,
      note: 'Solo done.',
    });
    await pause();
    expect(inputsTo(t.daemon, t.rv)).toEqual([]);
  });

  it('a person moving a card into 待審查 sends it to review with the last reply', async () => {
    const t = await board();
    const task = await newTask(t, 'Manual');
    await patchTask(t, task.id, { column: 'doing' });
    await until(() => textsTo(t.daemon, t.bd).length === 1, 'prompt');
    await work(t.daemon, t.bd);
    stop(t.daemon, t.bd, 'I think it works now. Not sure about Safari.');
    await pause(30);
    await patchTask(t, task.id, { column: 'review' });
    await until(() => textsTo(t.daemon, t.rv).length === 1, 'review');
    expect(textsTo(t.daemon, t.rv)[0]).toContain('Summary: I think it works now.');
  });
});

describe('task automation (pause, drops, restart)', () => {
  it('turning the switch off (team pause) drops queued tasks; nothing is sent later', async () => {
    const t = await board();
    const task = await newTask(t, 'Queued');
    await setStatus(t.daemon, t.bd, 'running');
    await patchTask(t, task.id, { column: 'doing' });
    const off = await hub.api('PATCH', `/api/teams/${t.teamId}`, {
      cookie: t.cookie,
      body: { taskAuto: false },
    });
    expect(off.body.taskAuto).toBe(false);
    expect(taskNow(task.id).auto).toMatchObject({ state: 'dropped', note: 'automation_off' });
    await setStatus(t.daemon, t.bd, 'waiting_input');
    await pause();
    expect(inputsTo(t.daemon, t.bd)).toEqual([]);
    // 關著時完成標記也不處理。
    stop(t.daemon, t.bd, '[完成 #1] Done anyway.');
    await pause();
    expect(taskNow(task.id).column).toBe('doing');
  });

  it('moving the card away before delivery cancels it', async () => {
    const t = await board();
    const task = await newTask(t, 'Moved');
    await setStatus(t.daemon, t.bd, 'running');
    await patchTask(t, task.id, { column: 'doing' });
    const back = await patchTask(t, task.id, { column: 'todo' });
    expect(back.auto).toBeNull();
    await setStatus(t.daemon, t.bd, 'waiting_input');
    await pause();
    expect(inputsTo(t.daemon, t.bd)).toEqual([]);
  });

  it('ignores task.* events sent by a daemon', async () => {
    const t = await board();
    sendEvent(t.daemon, t.bd, 'task.dispatched', { taskId: 'x' });
    await pause();
    const events = await hub.api('GET', `/api/sessions/${t.bd}/events`, { cookie: t.cookie });
    expect((events.body as { type: string }[]).map((e) => e.type)).not.toContain('task.dispatched');
  });

  it('keeps numbers and counts across a restart, marks queued ones as not sent, and does not resend', async () => {
    const t = await board();
    const task = await newTask(t, 'Survives');
    await setStatus(t.daemon, t.bd, 'running');
    await patchTask(t, task.id, { column: 'doing' });
    hub.running.db.prepare('UPDATE tasks SET reject_count = 2 WHERE id = ?').run(task.id);
    const { dbPath } = hub;
    await hub.running.close();
    hub = await startHub({ dbPath, timing: { handoffEnterDelayMs: 20 } });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const daemon = await hub.daemon(t.token);
    daemon.send(hello({ sessions: [runtime(t.bd, { status: 'waiting_input', ...where(t.bd) })] }));
    await daemon.next('hub.welcome');
    await until(() => sessionStatus(t.bd) === 'waiting_input', 'reconnected');
    await pause();
    expect(inputsTo(daemon, t.bd)).toEqual([]);
    const res = await hub.api('GET', `/api/teams/${t.teamId}/tasks`, { cookie });
    expect(res.body[0]).toMatchObject({
      number: 1,
      rejectCount: 2,
      column: 'doing',
      auto: { state: 'dropped', note: 'hub_restarted', sessionId: t.bd },
    });
    // 新任務的編號接著發。
    const next = await hub.api('POST', `/api/teams/${t.teamId}/tasks`, {
      cookie,
      body: { title: 'Next', ownerSessionId: null },
    });
    expect(next.body.number).toBe(2);
  });
});
