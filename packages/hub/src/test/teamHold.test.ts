// 全隊暫停／停止與全隊繼續／啟動（CONTRACTS §17）：真的 hub、假 daemon。驗記錄存在 settings 表、重啟後還在、
// 恢復只打開當初關掉的、手動改過的不覆蓋、停止後啟動只接回當初停掉的、失聯的列出來等機器回來、audit、WS 推送。
import { afterEach, describe, expect, it } from 'vitest';
import type {
  HandoffRule,
  Session,
  SessionStatus,
  Team,
  TeamHoldResult,
  TeamResumeResult,
} from '@agent-board/protocol';
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

const sleep = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

interface Board {
  cookie: string;
  daemon: Peer;
  token: string;
  machineId: string;
}

async function board(): Promise<Board> {
  hub = await startHub();
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  return { cookie, daemon, token, machineId };
}

const get = (id: string): Session | null => hub.running.store.getSession(id);
/** hub 看得到這台機器的 daemon 連線（private，測試直接看）。 */
const online = (machineId: string) =>
  (hub.running.hub as unknown as { daemonFor(id: string): unknown }).daemonFor(machineId) !== null;

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

/** daemon 回報 session 結束（收到 session.stop 之後真的 daemon 會這樣回）。 */
async function ended(daemon: Peer, id: string): Promise<void> {
  const s = get(id)!;
  daemon.send({
    type: 'session.runtime',
    session: runtime(id, {
      status: 'done',
      cwd: s.cwd,
      branch: s.branch,
      endedAt: new Date().toISOString(),
    }),
  });
  await until(() => get(id)?.endedAt !== null, `${id} ended`);
}

async function team(b: Board, members: string[], taskAuto = false): Promise<string> {
  const res = await hub.api('POST', '/api/teams', {
    cookie: b.cookie,
    body: { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '', taskAuto },
  });
  expect(res.status).toBe(200);
  for (const id of members) {
    const put = await hub.api('PUT', `/api/teams/${res.body.id}/members/${id}`, {
      cookie: b.cookie,
      body: { role: 'worker' },
    });
    expect(put.status).toBe(200);
  }
  return res.body.id as string;
}

async function rule(b: Board, teamId: string, from: string, to: string, enabled = true) {
  const res = await hub.api('POST', `/api/teams/${teamId}/handoff-rules`, {
    cookie: b.cookie,
    body: { fromSessionId: from, trigger: 'on_done', action: { toSessionId: to }, enabled },
  });
  expect(res.status).toBe(200);
  return res.body as HandoffRule;
}

const rulesOf = async (b: Board, teamId: string) =>
  (await hub.api('GET', `/api/teams/${teamId}/handoff-rules`, { cookie: b.cookie }))
    .body as HandoffRule[];

const teamOf = async (b: Board, teamId: string) =>
  ((await hub.api('GET', '/api/teams', { cookie: b.cookie })).body as Team[]).find(
    (t) => t.id === teamId,
  )!;

const hold = async (b: Board, teamId: string, mode: 'pause' | 'stop') => {
  const res = await hub.api('POST', `/api/teams/${teamId}/hold`, {
    cookie: b.cookie,
    body: { mode },
  });
  expect(res.status).toBe(200);
  return res.body as TeamHoldResult;
};

const resume = async (b: Board, teamId: string) => {
  const res = await hub.api('POST', `/api/teams/${teamId}/resume`, { cookie: b.cookie });
  expect(res.status).toBe(200);
  return res.body as TeamResumeResult;
};

const auditRows = (action: string) =>
  hub.running.db
    .prepare('SELECT session_id, user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
    .all(action) as { session_id: string | null; user_id: string | null; detail: string }[];

describe('全隊暫停 → 全隊繼續', () => {
  it('記下關掉的規則與任務自動執行、只對工作中的送 Esc；重啟後還在；繼續只打開當初關的、不送字', async () => {
    const b = await board();
    const run = await start(b, 'run', 'running');
    const perm = await start(b, 'perm', 'waiting_permission');
    const ask = await start(b, 'ask', 'waiting_input');
    const teamId = await team(b, [run, perm, ask], true);
    const r1 = await rule(b, teamId, run, ask);
    const r2 = await rule(b, teamId, perm, ask);
    const r3 = await rule(b, teamId, ask, run);
    // 本來就關著的規則：不是這次關的，繼續時不能被打開。
    const off = await rule(b, teamId, ask, perm, false);
    const client = await hub.client(b.cookie);
    b.daemon.clear();

    const res = await hold(b, teamId, 'pause');
    expect(res.rules).toBe(3);
    expect(res.taskAuto).toBe(true);
    expect(res.interrupted).toEqual([{ sessionId: run, name: 'run' }]);
    expect(res.offline).toEqual([]);
    expect(res.team.taskAuto).toBe(false);
    expect(res.team.hold).toMatchObject({
      mode: 'pause',
      taskAuto: true,
      stoppedSessionIds: [],
      byName: 'owner',
    });
    expect(res.team.hold!.ruleIds.sort()).toEqual([r1.id, r2.id, r3.id].sort());
    expect((await rulesOf(b, teamId)).every((r) => !r.enabled)).toBe(true);
    // Esc 只送給工作中的；等你允許的不能收到（對權限對話框按 Esc 等於拒絕）。
    await until(() => b.daemon.of('terminal.signal').length === 1, 'escape');
    expect(b.daemon.of('terminal.signal')[0]).toMatchObject({ sessionId: run, signal: 'escape' });
    await sleep();
    expect(b.daemon.of('terminal.signal')).toHaveLength(1);
    // 其他裝置：team.updated 帶 hold。
    await client.next('team.updated', (m) => (m.team as Team).hold?.mode === 'pause');
    const audit = auditRows('team.hold');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({
      teamId,
      mode: 'pause',
      taskAuto: true,
      interrupted: [run],
    });

    // hub 重啟後記錄還在。
    const { dbPath } = hub;
    await hub.running.close();
    hub = await startHub({ dbPath });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    b.cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const daemon = await hub.daemon(b.token);
    daemon.send(
      hello({
        sessions: [run, perm, ask].map((id) =>
          runtime(id, { status: 'waiting_input', cwd: get(id)!.cwd, branch: get(id)!.branch }),
        ),
      }),
    );
    await daemon.next('hub.welcome');
    expect((await teamOf(b, teamId)).hold?.mode).toBe('pause');

    // 暫停後手動改：r2 刪掉、r3 手動打開。
    expect(
      (await hub.api('DELETE', `/api/handoff-rules/${r2.id}`, { cookie: b.cookie })).status,
    ).toBe(200);
    expect(
      (
        await hub.api('PATCH', `/api/handoff-rules/${r3.id}`, {
          cookie: b.cookie,
          body: { enabled: true },
        })
      ).status,
    ).toBe(200);
    daemon.clear();

    const back = await resume(b, teamId);
    expect(back.mode).toBe('pause');
    expect(back.rules).toEqual({ enabled: 1, alreadyOn: 1, deleted: 1 });
    expect(back.taskAuto).toBe('enabled');
    expect(back.boardPaused).toBe(false);
    expect(back.team.hold).toBeUndefined();
    expect(back.team.taskAuto).toBe(true);
    const after = Object.fromEntries((await rulesOf(b, teamId)).map((r) => [r.id, r.enabled]));
    expect(after).toEqual({ [r1.id]: true, [r3.id]: true, [off.id]: false });
    // 不自動送字、不開 session。
    await sleep();
    expect(daemon.of('terminal.input')).toEqual([]);
    expect(daemon.of('session.create')).toEqual([]);
    expect((await teamOf(b, teamId)).hold).toBeUndefined();
    expect(JSON.parse(auditRows('team.resume')[0]!.detail)).toMatchObject({
      teamId,
      mode: 'pause',
      rules: { enabled: [r1.id], alreadyOn: 1, deleted: 1 },
      taskAuto: 'enabled',
    });

    // 沒有記錄時再按：什麼都不做（別的裝置已經恢復過）。
    const again = await resume(b, teamId);
    expect(again.mode).toBeNull();
    expect(again.rules).toEqual({ enabled: 0, alreadyOn: 0, deleted: 0 });
  });

  it('任務自動執行在暫停後被手動打開：繼續時不重複開，結果寫 already_on', async () => {
    const b = await board();
    const a = await start(b, 'a', 'running');
    const teamId = await team(b, [a], true);
    await hold(b, teamId, 'pause');
    await hub.api('PATCH', `/api/teams/${teamId}`, { cookie: b.cookie, body: { taskAuto: true } });
    const back = await resume(b, teamId);
    expect(back.taskAuto).toBe('already_on');
    expect(auditRows('team.task_auto').map((r) => JSON.parse(r.detail).on)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('全部暫停中：照做，結果標 boardPaused', async () => {
    const b = await board();
    const a = await start(b, 'a', 'running');
    const teamId = await team(b, [a]);
    await hold(b, teamId, 'pause');
    await hub.api('POST', '/api/board/pause', { cookie: b.cookie, body: { mode: 'finish_turn' } });
    const back = await resume(b, teamId);
    expect(back.boardPaused).toBe(true);
    expect(back.team.hold).toBeUndefined();
  });

  it('PATCH 團隊不能改 hold', async () => {
    const b = await board();
    const a = await start(b, 'a', 'running');
    const teamId = await team(b, [a]);
    await hub.api('PATCH', `/api/teams/${teamId}`, {
      cookie: b.cookie,
      body: { hold: { mode: 'stop', ruleIds: [], taskAuto: false, stoppedSessionIds: [a] } },
    });
    expect((await teamOf(b, teamId)).hold).toBeUndefined();
  });
});

describe('全隊停止 → 全隊啟動', () => {
  it('只接回當初停掉的；失聯的列出來、記錄留著，機器回來再按一次接回；規則只開一次', async () => {
    const b = await board();
    const a = await start(b, 'a', 'running');
    const c = await start(b, 'c', 'waiting_input');
    // 停止前就已結束的成員：不是這次停的，不能被接回。
    const old = await start(b, 'old', 'waiting_input');
    await ended(b.daemon, old);
    const second = await hub.onlineDaemon(b.cookie);
    const far = await start(b, 'far', 'waiting_input', second.daemon, second.machineId);
    const teamId = await team(b, [a, c, old, far]);
    const r1 = await rule(b, teamId, a, c);
    const client = await hub.client(b.cookie);
    b.daemon.clear();

    // 先暫停再停止：合併成 stop，規則記錄不會因為第二次（已經關了）而變空。
    await hold(b, teamId, 'pause');
    const res = await hold(b, teamId, 'stop');
    expect(res.rules).toBe(0);
    expect(res.stopped.map((x) => x.sessionId).sort()).toEqual([a, c, far].sort());
    expect(res.failed).toEqual([]);
    expect(res.team.hold).toMatchObject({ mode: 'stop', ruleIds: [r1.id] });
    expect(res.team.hold!.stoppedSessionIds.sort()).toEqual([a, c, far].sort());
    await client.next('team.updated', (m) => (m.team as Team).hold?.mode === 'stop');
    for (const id of [a, c]) await b.daemon.next('session.stop', (m) => m.sessionId === id);
    await second.daemon.next('session.stop', (m) => m.sessionId === far);
    await ended(b.daemon, a);
    await ended(b.daemon, c);
    await ended(second.daemon, far);
    // far 的機器失聯。
    second.daemon.ws.terminate();
    await until(() => !online(second.machineId), 'offline');
    // c 在停止後被手動接回：啟動時略過。
    expect((await hub.api('POST', `/api/sessions/${c}/resume`, { cookie: b.cookie })).status).toBe(
      200,
    );
    await b.daemon.next('session.create', (m) => m.sessionId === c);
    b.daemon.clear();

    const back = await resume(b, teamId);
    expect(back.mode).toBe('stop');
    expect(back.resumed).toEqual([{ sessionId: a, name: 'a' }]);
    expect(back.alreadyRunning).toEqual([{ sessionId: c, name: 'c' }]);
    expect(back.offline).toEqual([{ sessionId: far, name: 'far' }]);
    expect(back.failed).toEqual([]);
    expect(back.rules).toEqual({ enabled: 1, alreadyOn: 0, deleted: 0 });
    // --resume 接回原對話，不帶第一句話（不送字）。
    const create = await b.daemon.next('session.create', (m) => m.sessionId === a);
    expect(create.spec).toMatchObject({
      resumeClaudeSessionId: '00000000-0000-4000-8000-000000000001',
      firstPrompt: null,
    });
    await sleep();
    expect(b.daemon.of('session.create')).toEqual([]);
    expect(get(old)?.endedAt).not.toBeNull();
    // 記錄只剩失聯的成員；規則已恢復，不再碰。
    expect(back.team.hold).toMatchObject({
      mode: 'stop',
      ruleIds: [],
      taskAuto: false,
      stoppedSessionIds: [far],
    });
    expect((await rulesOf(b, teamId))[0]!.enabled).toBe(true);
    const audit = JSON.parse(auditRows('team.resume')[0]!.detail);
    expect(audit).toMatchObject({
      mode: 'stop',
      resumed: [a],
      offline: [far],
      alreadyRunning: [c],
    });

    // 等機器回來前手動關掉規則：第二次按不能把它打開。
    await hub.api('PATCH', `/api/handoff-rules/${r1.id}`, {
      cookie: b.cookie,
      body: { enabled: false },
    });
    const back2 = await hub.daemon(second.token);
    back2.send(hello());
    await back2.next('hub.welcome');
    const done = await resume(b, teamId);
    expect(done.resumed).toEqual([{ sessionId: far, name: 'far' }]);
    expect(done.offline).toEqual([]);
    expect(done.rules).toEqual({ enabled: 0, alreadyOn: 0, deleted: 0 });
    expect(done.team.hold).toBeUndefined();
    await back2.next('session.create', (m) => m.sessionId === far);
    expect((await rulesOf(b, teamId))[0]!.enabled).toBe(false);
  });

  it('停不了的（機器失聯）列在 failed，不記進記錄；刪掉團隊時記錄一起清', async () => {
    const b = await board();
    const second = await hub.onlineDaemon(b.cookie);
    const far = await start(b, 'far', 'running', second.daemon, second.machineId);
    const teamId = await team(b, [far]);
    second.daemon.ws.terminate();
    await until(() => get(far)?.status === 'offline', 'far offline');
    const res = await hold(b, teamId, 'stop');
    expect(res.failed).toEqual([{ sessionId: far, name: 'far', code: 'machine_offline' }]);
    expect(res.team.hold?.stoppedSessionIds).toEqual([]);
    expect(hub.running.store.getTeamHold(teamId)).not.toBeNull();
    await hub.api('DELETE', `/api/teams/${teamId}`, { cookie: b.cookie });
    expect(hub.running.store.getTeamHold(teamId)).toBeNull();
  });

  it('一般成員帳號（user 權限）也能用', async () => {
    const b = await board();
    const a = await start(b, 'a', 'running');
    const teamId = await team(b, [a]);
    const member = await hub.createMember(b.cookie);
    const res = await hub.api('POST', `/api/teams/${teamId}/hold`, {
      cookie: member.cookie,
      body: { mode: 'stop' },
    });
    expect(res.status).toBe(200);
    expect(auditRows('team.hold')[0]!.user_id).toBe(member.id);
    expect(
      (await hub.api('POST', `/api/teams/nope/hold`, { cookie: b.cookie, body: { mode: 'pause' } }))
        .status,
    ).toBe(404);
  });
});
