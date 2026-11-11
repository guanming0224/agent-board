// 工作區＋團隊群發（P2 項目二，docs/p2-spec.md §2）：真的 hub、假 daemon。
// 工作區 CRUD 與刪除條件、團隊與 session 換工作區（WS 即時推）、群發只在等輸入時送（RUN 排隊、PERM 不送任何字）、
// @ 點名、取消排隊、全部暫停不擋群發、audit 每個對象一筆、測試角色。
import { afterEach, describe, expect, it } from 'vitest';
import type { Broadcast, Session, SessionStatus } from '@agent-board/protocol';
import { runtime, spec, startHub, until, type Peer, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const TIMING = { handoffEnterDelayMs: 20 };

interface Board {
  cookie: string;
  daemon: Peer;
  machineId: string;
}

async function board(): Promise<Board> {
  hub = await startHub({ timing: TIMING });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie);
  return { cookie, daemon, machineId };
}

const get = (id: string): Session | null => hub.running.store.getSession(id);

async function start(
  b: Board,
  name: string,
  status: SessionStatus = 'waiting_input',
  zoneId?: string,
): Promise<string> {
  const cwd = `/fake/${name}`;
  const res = await hub.api('POST', '/api/sessions', {
    cookie: b.cookie,
    body: { ...spec({ name, cwd }), machineId: b.machineId, ...(zoneId ? { zoneId } : {}) },
  });
  expect(res.status).toBe(200);
  const create = await b.daemon.next('session.create', (m) => m.sessionId === res.body.id);
  b.daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { status, cwd, branch: `ab/${name}` }),
  });
  await until(() => get(res.body.id)?.status === status, `${name} started`);
  return res.body.id as string;
}

const setStatus = async (b: Board, id: string, status: SessionStatus, detail?: string) => {
  const s = get(id)!;
  b.daemon.send({
    type: 'session.runtime',
    session: runtime(id, {
      status,
      cwd: s.cwd,
      branch: s.branch,
      ...(detail ? { statusDetail: detail } : {}),
    }),
  });
  await until(() => get(id)?.status === status, `status ${status}`);
};

const inputsTo = (daemon: Peer, sessionId: string) =>
  daemon.messages
    .filter((m) => m.type === 'terminal.input' && m.sessionId === sessionId)
    .map((m) => String(m.data));

const auditRows = (action: string) =>
  hub.running.db
    .prepare('SELECT session_id, user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
    .all(action) as { session_id: string | null; user_id: string | null; detail: string }[];

async function team(b: Board, members: [string, string][], zoneId?: string): Promise<string> {
  const res = await hub.api('POST', '/api/teams', {
    cookie: b.cookie,
    body: {
      name: 'T',
      goal: '',
      doneCriteria: '',
      color: 'teal',
      contextMd: '',
      ...(zoneId ? { zoneId } : {}),
    },
  });
  expect(res.status).toBe(200);
  for (const [sessionId, role] of members) {
    const put = await hub.api('PUT', `/api/teams/${res.body.id}/members/${sessionId}`, {
      cookie: b.cookie,
      body: { role },
    });
    expect(put.status).toBe(200);
  }
  return res.body.id as string;
}

describe('工作區', () => {
  it('預設只有「主要」；建立、改名、排序；WS 推 zone.list；最後一個不能刪', async () => {
    const b = await board();
    const client = await hub.client(b.cookie);
    const list = await hub.api('GET', '/api/zones', { cookie: b.cookie });
    expect(list.body).toEqual([expect.objectContaining({ id: 'main', name: '主要', position: 0 })]);

    const created = await hub.api('POST', '/api/zones', {
      cookie: b.cookie,
      body: { name: ' 交易 ' },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: '交易', position: 1 });
    const pushed = await client.next('zone.list');
    expect((pushed.zones as { name: string }[]).map((z) => z.name)).toEqual(['主要', '交易']);

    const renamed = await hub.api('PATCH', `/api/zones/${created.body.id}`, {
      cookie: b.cookie,
      body: { name: 'agent-board' },
    });
    expect(renamed.body.name).toBe('agent-board');
    expect(
      (await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: '' } })).status,
    ).toBe(400);

    expect(
      (await hub.api('DELETE', `/api/zones/${created.body.id}`, { cookie: b.cookie })).status,
    ).toBe(200);
    const last = await hub.api('DELETE', '/api/zones/main', { cookie: b.cookie });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('last_zone');
    expect(auditRows('zone.create')).toHaveLength(1);
    expect(auditRows('zone.delete')).toHaveLength(1);
  });

  it('非空不能刪（409 附團隊數與 session 數）；清空後可刪', async () => {
    const b = await board();
    const zone = (await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: 'B' } }))
      .body.id as string;
    const solo = await start(b, 'solo', 'waiting_input', zone);
    const a1 = await start(b, 'a1');
    const a2 = await start(b, 'a2');
    const t = await team(b, [
      [a1, 'lead'],
      [a2, 'worker'],
    ]);
    const moved = await hub.api('PATCH', `/api/teams/${t}`, {
      cookie: b.cookie,
      body: { zoneId: zone },
    });
    expect(moved.body.zoneId).toBe(zone);

    const blocked = await hub.api('DELETE', `/api/zones/${zone}`, { cookie: b.cookie });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('zone_not_empty');
    expect(blocked.body.message).toContain('teams=1, sessions=1');
    expect(blocked.body.detail).toEqual({ teams: 1, sessions: 1 });

    await hub.api('PATCH', `/api/teams/${t}`, { cookie: b.cookie, body: { zoneId: 'main' } });
    await hub.api('PATCH', `/api/sessions/${solo}`, { cookie: b.cookie, body: { zoneId: 'main' } });
    expect((await hub.api('DELETE', `/api/zones/${zone}`, { cookie: b.cookie })).status).toBe(200);
  });

  it('新 session 放在指定工作區；團隊、session 換工作區即時推給 client 並寫 audit；不存在的工作區 400', async () => {
    const b = await board();
    const client = await hub.client(b.cookie);
    const zone = (await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: 'B' } }))
      .body.id as string;
    const s = await start(b, 's', 'waiting_input', zone);
    expect(get(s)?.zoneId).toBe(zone);

    const a1 = await start(b, 'a1');
    const a2 = await start(b, 'a2');
    const t = await team(b, [
      [a1, 'lead'],
      [a2, 'worker'],
    ]);
    client.clear();
    await hub.api('PATCH', `/api/teams/${t}`, { cookie: b.cookie, body: { zoneId: zone } });
    const update = await client.next('team.updated', (m) => (m.team as { id: string }).id === t);
    expect((update.team as { zoneId: string }).zoneId).toBe(zone);
    expect(auditRows('team.zone')).toHaveLength(1);

    await hub.api('PATCH', `/api/sessions/${s}`, { cookie: b.cookie, body: { zoneId: 'main' } });
    const sessionUpdate = await client.next(
      'session.updated',
      (m) => (m.session as Session).id === s && (m.session as Session).zoneId === 'main',
    );
    expect(sessionUpdate).toBeTruthy();
    expect(auditRows('session.zone')).toHaveLength(1);

    const bad = await hub.api('PATCH', `/api/teams/${t}`, {
      cookie: b.cookie,
      body: { zoneId: 'nope' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('unknown_zone');

    // 成員離開團隊：留在團隊所在的工作區（自己的欄位改成團隊的）。
    expect(get(a2)?.zoneId).toBe('main');
    await hub.api('DELETE', `/api/teams/${t}/members/${a2}`, { cookie: b.cookie });
    expect(get(a2)?.zoneId).toBe(zone);
  });

  it('移入工作區排到目標工作區右側空白：hub 直接改存好的版面（沒開畫布、手機移動也排）', async () => {
    const b = await board();
    const zone = (await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: 'B' } }))
      .body.id as string;
    // B 原有：單獨 session 一張，和團隊 X 的位置重疊（座標共用）。
    const there = await start(b, 'there', 'waiting_input', zone);
    const x1 = await start(b, 'x1');
    const x2 = await start(b, 'x2');
    const solo = await start(b, 'solo');
    const t = await team(b, [
      [x1, 'lead'],
      [x2, 'worker'],
    ]);
    const rect = (sessionId: string, x: number, y: number) => ({
      workspace: 'default',
      sessionId,
      x,
      y,
      w: 600,
      h: 400,
    });
    const put = await hub.api('PUT', '/api/layouts', {
      cookie: b.cookie,
      body: [
        rect(there, 0, 100),
        rect(x1, 50, 0),
        rect(x2, 700, 0),
        rect(solo, 0, 2000),
        { ...rect(x1, 9, 9), workspace: 'default.previous' },
      ],
    });
    expect(put.status).toBe(200);
    const layouts = async (workspace = 'default') =>
      Object.fromEntries(
        (
          (await hub.api('GET', `/api/layouts?workspace=${workspace}`, { cookie: b.cookie }))
            .body as { sessionId: string; x: number; y: number }[]
        ).map((l) => [l.sessionId, { x: l.x, y: l.y }]),
      );

    await hub.api('PATCH', `/api/teams/${t}`, { cookie: b.cookie, body: { zoneId: zone } });
    // B 最右邊 600，＋ 304 間距；上緣對齊 B 的 100。整個團隊一起平移（相對位置不變）。
    let after = await layouts();
    expect(after[x1]).toEqual({ x: 904, y: 100 });
    expect(after[x2]).toEqual({ x: 1554, y: 100 });
    expect(after[there]).toEqual({ x: 0, y: 100 });
    expect(after[solo]).toEqual({ x: 0, y: 2000 });
    // 「上一次擺設」不動。
    expect((await layouts('default.previous'))[x1]).toEqual({ x: 9, y: 9 });

    // 單獨 session 移過去：排在 B（現在含團隊 X）最右邊再往右。
    await hub.api('PATCH', `/api/sessions/${solo}`, { cookie: b.cookie, body: { zoneId: zone } });
    after = await layouts();
    expect(after[solo]).toEqual({ x: 1554 + 600 + 304, y: 100 });

    // 移回空的「主要」：沒有別的卡，不動。
    await hub.api('PATCH', `/api/sessions/${solo}`, { cookie: b.cookie, body: { zoneId: 'main' } });
    expect((await layouts())[solo]).toEqual({ x: 1554 + 600 + 304, y: 100 });
  });

  it('「主要」刪掉後，沒帶工作區的建立放到排第一個的工作區；刪除時便利貼搬家寫進 audit', async () => {
    const b = await board();
    const zone = (await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: 'B' } }))
      .body.id as string;
    const note = await hub.api('POST', '/api/notes', {
      cookie: b.cookie,
      body: { zoneId: 'main', x: 0, y: 0, text: 'n', color: 'yellow' },
    });
    expect(note.status).toBe(200);
    expect((await hub.api('DELETE', '/api/zones/main', { cookie: b.cookie })).status).toBe(200);
    expect(JSON.parse(auditRows('zone.delete')[0]!.detail)).toMatchObject({
      id: 'main',
      movedNotes: 1,
      movedTo: zone,
    });
    const s = await start(b, 'later');
    expect(get(s)?.zoneId).toBe(zone);
    const created = await hub.api('POST', '/api/teams', {
      cookie: b.cookie,
      body: { name: 'T2', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
    });
    expect(created.status).toBe(200);
    expect(created.body.zoneId).toBe(zone);
  });

  it('board.state 帶工作區清單', async () => {
    const b = await board();
    await hub.api('POST', '/api/zones', { cookie: b.cookie, body: { name: 'B' } });
    const client = await hub.client(b.cookie);
    client.send({ type: 'ping', at: new Date().toISOString() });
    await client.next('pong');
    // hub.client 吃掉了第一則 board.state；用 REST 確認同一份來源。
    const zones = await hub.api('GET', '/api/zones', { cookie: b.cookie });
    expect(zones.body).toHaveLength(2);
  });
});

describe('群發', () => {
  async function four(b: Board) {
    const ask = await start(b, 'ask');
    const run = await start(b, 'run', 'running');
    const perm = await start(b, 'perm', 'waiting_permission');
    const fresh = await start(b, 'fresh');
    await setStatus(b, fresh, 'waiting_input', 'idle:start');
    const t = await team(b, [
      [ask, 'lead'],
      [run, 'worker'],
      [perm, 'reviewer'],
      [fresh, 'tester'],
    ]);
    return { ask, run, perm, fresh, t };
  }

  it('ASK、NEW 立刻送；RUN 排隊，變回等輸入才送；PERM 在權限處理前不送任何字；沒有確認；audit 每人一筆', async () => {
    const b = await board();
    const { ask, run, perm, fresh, t } = await four(b);
    const client = await hub.client(b.cookie);
    b.daemon.clear();
    const res = await hub.api('POST', `/api/teams/${t}/broadcast`, {
      cookie: b.cookie,
      body: { text: '先停下，回報目前進度' },
    });
    expect(res.status).toBe(200);
    const result = res.body as Broadcast;
    const state = (id: string) => result.targets.find((x) => x.sessionId === id)?.state;
    expect(state(ask)).toBe('sent');
    expect(state(fresh)).toBe('sent');
    expect(state(run)).toBe('queued');
    expect(state(perm)).toBe('queued');
    expect(result.mentioned).toBe(false);

    await until(() => inputsTo(b.daemon, ask).includes('\r'), 'ask enter');
    // 每個 session 的 Enter 各自隔一小段才送：兩個都等到再比（慢的機器上第二個還沒到）。
    await until(() => inputsTo(b.daemon, fresh).includes('\r'), 'fresh enter');
    expect(inputsTo(b.daemon, ask)).toEqual(['先停下，回報目前進度', '\r']);
    expect(inputsTo(b.daemon, fresh)).toEqual(['先停下，回報目前進度', '\r']);
    expect(inputsTo(b.daemon, run)).toEqual([]);
    expect(inputsTo(b.daemon, perm)).toEqual([]);
    expect(auditRows('team.broadcast')).toHaveLength(4);
    const detail = JSON.parse(auditRows('team.broadcast')[0]!.detail) as Record<string, unknown>;
    expect(detail).toMatchObject({ teamId: t, text: '先停下，回報目前進度', mentioned: false });

    await setStatus(b, run, 'waiting_input');
    await until(() => inputsTo(b.daemon, run).includes('\r'), 'run enter');
    const pushed = await client.next(
      'broadcast.updated',
      (m) => (m.broadcast as Broadcast).targets.find((x) => x.sessionId === run)?.state === 'sent',
    );
    expect(pushed).toBeTruthy();
    // PERM 一直在權限對話框：一個字都沒有。
    await new Promise((r) => setTimeout(r, 100));
    expect(inputsTo(b.daemon, perm)).toEqual([]);
    await setStatus(b, perm, 'waiting_input');
    await until(() => inputsTo(b.daemon, perm).includes('\r'), 'perm enter');
    expect(auditRows('team.broadcast.delivered')).toHaveLength(4);
  });

  it('@ 點名只送給點到的；不是本團隊成員 400', async () => {
    const b = await board();
    const { ask, run, perm, fresh, t } = await four(b);
    const outsider = await start(b, 'outsider');
    b.daemon.clear();
    const res = await hub.api('POST', `/api/teams/${t}/broadcast`, {
      cookie: b.cookie,
      body: { text: '再看一次', targets: [fresh] },
    });
    expect(res.body.mentioned).toBe(true);
    expect(res.body.targets.map((x: { sessionId: string }) => x.sessionId)).toEqual([fresh]);
    await until(() => inputsTo(b.daemon, fresh).includes('\r'), 'enter');
    expect(inputsTo(b.daemon, fresh)).toEqual(['再看一次', '\r']);
    for (const other of [ask, run, perm]) expect(inputsTo(b.daemon, other)).toEqual([]);

    const bad = await hub.api('POST', `/api/teams/${t}/broadcast`, {
      cookie: b.cookie,
      body: { text: 'x', targets: [outsider] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('not_member');
  });

  it('排隊中的可以取消；已結束的成員略過', async () => {
    const b = await board();
    const lead = await start(b, 'lead', 'running');
    const gone = await start(b, 'gone');
    const t = await team(b, [
      [lead, 'lead'],
      [gone, 'worker'],
    ]);
    await hub.api('PATCH', `/api/sessions/${gone}`, { cookie: b.cookie, body: { markDone: true } });
    const res = await hub.api('POST', `/api/teams/${t}/broadcast`, {
      cookie: b.cookie,
      body: { text: 'hello' },
    });
    const result = res.body as Broadcast;
    expect(result.targets.find((x) => x.sessionId === gone)).toMatchObject({
      state: 'skipped',
      reason: 'ended',
    });
    const cancel = await hub.api('POST', `/api/broadcasts/${result.id}/cancel`, {
      cookie: b.cookie,
      body: { sessionId: lead },
    });
    expect(cancel.body.targets.find((x: { sessionId: string }) => x.sessionId === lead).state).toBe(
      'cancelled',
    );
    b.daemon.clear();
    await setStatus(b, lead, 'waiting_input');
    await new Promise((r) => setTimeout(r, 100));
    expect(inputsTo(b.daemon, lead)).toEqual([]);
    expect(auditRows('team.broadcast.cancelled')).toHaveLength(1);
  });

  it('全部暫停中照送（GM 親手下的），不算被暫停擋下的排隊', async () => {
    const b = await board();
    const ask = await start(b, 'ask');
    const run = await start(b, 'run', 'running');
    const t = await team(b, [
      [ask, 'lead'],
      [run, 'worker'],
    ]);
    await hub.api('POST', '/api/board/pause', { cookie: b.cookie, body: { mode: 'finish_turn' } });
    b.daemon.clear();
    const res = await hub.api('POST', `/api/teams/${t}/broadcast`, {
      cookie: b.cookie,
      body: { text: 'go' },
    });
    expect(res.body.boardPaused).toBe(true);
    await until(() => inputsTo(b.daemon, ask).includes('\r'), 'ask enter');
    const state = await hub.api('GET', '/api/board/pause', { cookie: b.cookie });
    expect(state.body.held.deliveries).toBe(0);
    expect(auditRows('board.held')).toHaveLength(0);
    await setStatus(b, run, 'waiting_input');
    await until(() => inputsTo(b.daemon, run).includes('\r'), 'run enter while paused');
  });
});

describe('測試角色', () => {
  it('可以設成成員角色，重新讀取仍是 tester', async () => {
    const b = await board();
    const a = await start(b, 'a');
    const c = await start(b, 'c');
    const t = await team(b, [
      [a, 'lead'],
      [c, 'tester'],
    ]);
    const members = await hub.api('GET', `/api/teams/${t}/members`, { cookie: b.cookie });
    expect(members.body).toContainEqual({ teamId: t, sessionId: c, role: 'tester' });
  });
});
