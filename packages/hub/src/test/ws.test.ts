import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonToHub, HubToClient, HubToDaemon } from '@agent-board/protocol';
import {
  approval,
  connect,
  hello,
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

const newSession = async (cookie: string, machineId: string, over = {}) => {
  const res = await hub.api('POST', '/api/sessions', {
    cookie,
    body: { ...spec(over), machineId },
  });
  expect(res.status).toBe(200);
  return res.body as { id: string; status: string; name: string };
};

/** 一個連線中的 daemon + 已啟動的 session。 */
const startedSession = async (over: object = {}) => {
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  const session = await newSession(cookie, machineId, over);
  const create = await daemon.next('session.create');
  daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(session.id),
  });
  return { cookie, daemon, machineId, token, session };
};

const auditRows = () =>
  hub.running.db.prepare('SELECT * FROM audit_log ORDER BY rowid').all() as {
    user_id: string | null;
    session_id: string | null;
    action: string;
    detail: string;
  }[];

describe('websocket upgrade', () => {
  const rejected = async (path: string, headers: Record<string, string>) => {
    await expect(connect(`ws://127.0.0.1:${hub.port}${path}`, headers)).rejects.toThrow();
    return connect(`ws://127.0.0.1:${hub.port}${path}`, headers).catch((e: Error) => e.message);
  };

  it('answers 401 to unauthenticated upgrades on both channels', async () => {
    hub = await startHub();
    await hub.setupOwner();
    expect(await rejected('/ws/client', { origin: hub.origin })).toBe('HTTP 401');
    expect(await rejected('/ws/client', { origin: hub.origin, cookie: 'ab_session=forged' })).toBe(
      'HTTP 401',
    );
    expect(await rejected('/ws/daemon', {})).toBe('HTTP 401');
    expect(await rejected('/ws/daemon', { authorization: 'Bearer nope' })).toBe('HTTP 401');
    // 就算 Origin 也是錯的，未登入仍回 401。
    expect(await rejected('/ws/client', { origin: 'https://evil.example' })).toBe('HTTP 401');
  });

  it('a login cookie does not open the daemon channel, and a machine token does not open the client channel', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { token } = await hub.pair(cookie);
    expect(await rejected('/ws/daemon', { cookie })).toBe('HTTP 401');
    expect(await rejected('/ws/daemon', { authorization: `Bearer ${cookie.split('=')[1]}` })).toBe(
      'HTTP 401',
    );
    expect(
      await rejected('/ws/client', { origin: hub.origin, authorization: `Bearer ${token}` }),
    ).toBe('HTTP 401');
  });

  it('rejects a wrong or missing Origin with 403 even when logged in', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    expect(await rejected('/ws/client', { cookie, origin: 'https://evil.example' })).toBe(
      'HTTP 403',
    );
    expect(await rejected('/ws/client', { cookie, origin: 'null' })).toBe('HTTP 403');
    expect(await rejected('/ws/client', { cookie })).toBe('HTTP 403');
    // 同一台機器的其他 port 也是別的網站。
    expect(await rejected('/ws/client', { cookie, origin: 'http://127.0.0.1:1' })).toBe('HTTP 403');
  });

  it('checks Origin against publicOrigin when set', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'https://board.example.ts.net' },
    });
    const url = `ws://127.0.0.1:${hub.port}/ws/client`;
    const good = await connect(url, { cookie, origin: 'https://board.example.ts.net' });
    good.close();
    expect(await rejected('/ws/client', { cookie, origin: 'https://other.example.ts.net' })).toBe(
      'HTTP 403',
    );
    // loopback 同源保留，publicOrigin 設錯時 owner 才不會被鎖在外面。
    const local = await connect(url, { cookie, origin: hub.origin });
    local.close();
  });

  it('answers 404 to unknown WebSocket paths', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    expect(await rejected('/ws/other', { cookie, origin: hub.origin })).toBe('HTTP 404');
  });

  it('logging out closes the open WebSocket', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    await hub.api('POST', '/api/auth/logout', { cookie });
    expect(await client.closed()).toBe(4401);
    expect(await rejected('/ws/client', { cookie, origin: hub.origin })).toBe('HTTP 401');
  });
});

describe('message validation', () => {
  it('answers invalid client messages with error and keeps the connection', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    for (const bad of [
      'not json',
      '[]',
      '{"type":"nope"}',
      '{"type":"terminal.input","sessionId":""}',
    ]) {
      client.sendRaw(bad);
      const error = await client.next('error');
      expect(error.code).toBe('invalid_message');
    }
    client.send({ type: 'ping', at: new Date().toISOString() });
    await client.next('pong');
    expect(client.closeCode).toBeNull();
  });

  it('drops invalid daemon messages without disconnecting', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    daemon.sendRaw('not json');
    daemon.sendRaw('{"type":"session.runtime","session":{"id":"x"}}');
    daemon.send({ type: 'resources', sample: { nope: true } });
    const session = await newSession(cookie, machineId);
    await daemon.next('session.create');
    expect(session.status).toBe('starting');
    expect(daemon.closeCode).toBeNull();
  });

  it('ignores messages sent before daemon.hello, and treats the machine as offline until then', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { machineId, token } = await hub.pair(cookie);
    const daemon = await hub.daemon(token);
    const res = await hub.api('POST', '/api/sessions', { cookie, body: { ...spec(), machineId } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('machine_offline');
    daemon.send({
      type: 'usage',
      summary: {
        from: new Date().toISOString(),
        to: new Date().toISOString(),
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await hub.api('GET', `/api/machines/${machineId}/usage`, { cookie })).body).toBeNull();
  });

  it('closes a daemon that never says hello', async () => {
    hub = await startHub({ timing: { helloTimeoutMs: 30 } });
    const cookie = await hub.setupOwner();
    const { token } = await hub.pair(cookie);
    const daemon = await hub.daemon(token);
    expect(await daemon.closed()).toBe(4408);
  });

  it('every frame the hub sends conforms to the protocol', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: '',
    });
    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: 1, data: 'x' });
    daemon.send({ type: 'approval.requested', approval: approval(session.id) });
    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'waiting_input' }),
    });
    await client.next('terminal.output');
    await client.next(
      'session.updated',
      (m) => (m.session as { status: string }).status === 'waiting_input',
    );
    await client.next('approval.requested');
    client.sendRaw('bad');
    await client.next('error');
    daemon.send({ type: 'session.runtime', session: runtime(session.id, { status: 'running' }) });
    await client.next(
      'session.updated',
      (m) => (m.session as { status: string }).status === 'running',
    );
    for (const m of [...client.messages])
      expect(HubToClient.safeParse(m).success, m.type).toBe(true);
    for (const m of [...daemon.messages])
      expect(HubToDaemon.safeParse(m).success, m.type).toBe(true);
  });
});

describe('pairing', () => {
  const pairBody = (code: string, name = 'box') => ({
    code,
    name,
    os: 'linux',
    capabilities: {
      hasGpu: false,
      gpuName: null,
      cpuCores: 1,
      memoryBytes: 1,
      claudeVersion: null,
    },
  });

  it('a pairing code works only once, also under concurrency', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { code } = (await hub.api('POST', '/api/machines/pairing-codes', { cookie })).body;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        hub.api('POST', '/api/machines/pair', { body: pairBody(code) }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(4);
    const again = await hub.api('POST', '/api/machines/pair', { body: pairBody(code) });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('invalid_pairing_code');
    expect((await hub.api('GET', '/api/machines', { cookie })).body).toHaveLength(1);
  });

  it('a pairing code expires', async () => {
    let now = Date.now();
    hub = await startHub({ now: () => new Date(now) });
    const cookie = await hub.setupOwner();
    const { code, expiresAt } = (await hub.api('POST', '/api/machines/pairing-codes', { cookie }))
      .body;
    expect(Date.parse(expiresAt)).toBeGreaterThan(now);
    now = Date.parse(expiresAt) + 1;
    const res = await hub.api('POST', '/api/machines/pair', { body: pairBody(code) });
    expect(res.status).toBe(401);
  });

  it('stores only hashes of codes and tokens', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { code } = (await hub.api('POST', '/api/machines/pairing-codes', { cookie })).body;
    const { token } = (await hub.api('POST', '/api/machines/pair', { body: pairBody(code) })).body;
    const machine = hub.running.db.prepare('SELECT token_hash FROM machines').get() as {
      token_hash: string;
    };
    const pairing = hub.running.db.prepare('SELECT code_hash FROM pairing_codes').get() as {
      code_hash: string;
    };
    expect(machine.token_hash).not.toContain(token);
    expect(machine.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pairing.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = readFileSync(hub.dbPath).toString('latin1') + walOf(hub);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code);
  });

  it('rate limits wrong codes, and a valid code cannot get through while limited', async () => {
    hub = await startHub({ pairingLimit: { perIp: 3, global: 100 } });
    const cookie = await hub.setupOwner();
    const { code } = (await hub.api('POST', '/api/machines/pairing-codes', { cookie })).body;
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(
        (await hub.api('POST', '/api/machines/pair', { body: pairBody('WRONG') })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const limited = await hub.api('POST', '/api/machines/pair', { body: pairBody(code) });
    expect(limited.status).toBe(429);
  });

  it('builds the install command from the hub origin only', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { installCommand, code } = (
      await hub.api('POST', '/api/machines/pairing-codes', { cookie })
    ).body;
    expect(installCommand).toBe(`agent-board-daemon pair --hub '${hub.origin}' --code ${code}`);
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'https://b.example.ts.net' },
    });
    const again = (await hub.api('POST', '/api/machines/pairing-codes', { cookie })).body;
    expect(again.installCommand).toContain(`--hub 'https://b.example.ts.net'`);
    expect(again.installCommand).not.toContain('127.0.0.1');
  });

  it('removing a machine cuts the socket immediately and the token stops working', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
    const session = await newSession(cookie, machineId);
    await daemon.next('session.create');
    const client = await hub.client(cookie);
    client.clear();

    const res = await hub.api('DELETE', `/api/machines/${machineId}`, { cookie });
    expect(res.body).toEqual({ ok: true });
    expect(await daemon.closed()).toBe(4401);
    await expect(
      connect(`ws://127.0.0.1:${hub.port}/ws/daemon`, { authorization: `Bearer ${token}` }),
    ).rejects.toThrow('HTTP 401');

    const removed = await client.next('session.removed');
    expect(removed.sessionId).toBe(session.id);
    const state = await client.next('board.state');
    expect(state.machines).toEqual([]);
    expect(state.sessions).toEqual([]);
    // 稽核紀錄不跟著機器消失。
    expect(auditRows().map((r) => r.action)).toContain('machine.delete');
    expect(auditRows().some((r) => r.session_id === session.id)).toBe(true);
  });

  it('a newer connection replaces the old one without marking the machine offline', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon: old, machineId, token } = await hub.onlineDaemon(cookie);
    const next = await hub.daemon(token);
    next.send(hello());
    await next.next('hub.welcome');
    expect(await old.closed()).toBe(4409);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const machines = (await hub.api('GET', '/api/machines', { cookie })).body;
    expect(machines).toMatchObject([{ id: machineId, online: true }]);
  });
});

function walOf(h: TestHub): string {
  return readdirSync(h.dir)
    .filter((f) => f.startsWith('hub.db'))
    .map((f) => readFileSync(join(h.dir, f)).toString('latin1'))
    .join('');
}

describe('terminal relay', () => {
  it('fake daemon ↔ hub ↔ fake browser: creates a session and relays the stream both ways', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const client = await hub.client(cookie);
    client.clear();

    const session = await newSession(cookie, machineId, { name: 'demo', firstPrompt: 'hello' });
    expect(session.status).toBe('starting');
    const create = await daemon.next('session.create');
    expect(create.sessionId).toBe(session.id);
    expect(create.spec).toMatchObject({ name: 'demo', firstPrompt: 'hello' });

    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(session.id, { branch: 'ab/demo', worktreePath: '/fake/wt' }),
    });
    const updated = await client.next(
      'session.updated',
      (m) => (m.session as { status: string }).status === 'running',
    );
    expect(updated.session).toMatchObject({ id: session.id, branch: 'ab/demo', name: 'demo' });

    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 3,
      cols: 80,
      rows: 24,
      data: 'SNAP',
    });
    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: 4, data: 'out-4' });
    expect(await client.next('terminal.snapshot')).toMatchObject({
      seq: 3,
      data: 'SNAP',
      cols: 80,
    });
    expect(await client.next('terminal.output')).toMatchObject({ seq: 4, data: 'out-4' });

    client.send({ type: 'terminal.input', sessionId: session.id, data: 'ls\r' });
    expect(await daemon.next('terminal.input')).toMatchObject({
      sessionId: session.id,
      data: 'ls\r',
    });
    client.send({ type: 'terminal.resize', sessionId: session.id, cols: 100, rows: 30 });
    expect(await daemon.next('terminal.resize')).toMatchObject({ cols: 100, rows: 30 });
    client.send({ type: 'terminal.signal', sessionId: session.id, signal: 'ctrl_c' });
    expect(await daemon.next('terminal.signal')).toMatchObject({ signal: 'ctrl_c' });

    client.send({ type: 'terminal.subscribe', sessionId: 'unknown' });
    expect((await client.next('error')).code).toBe('session_not_found');
  });

  it('subscribes upstream for snapshots and unsubscribes only after the last viewer leaves', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const a = await hub.client(cookie);
    const b = await hub.client(cookie);

    a.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 1,
      cols: 80,
      rows: 24,
      data: 'A',
    });
    await a.next('terminal.snapshot');

    // 第二個人要快照：再問 daemon 一次，已在看的人不會收到多餘快照。
    b.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.output',
      sessionId: session.id,
      seq: 2,
      data: 'before-b-snapshot',
    });
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 2,
      cols: 80,
      rows: 24,
      data: 'B',
    });
    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: 3, data: 'both' });
    expect(await b.next('terminal.snapshot')).toMatchObject({ seq: 2, data: 'B' });
    expect(await b.next('terminal.output')).toMatchObject({ seq: 3 });
    expect(b.of('terminal.output')).toHaveLength(0);
    expect((await a.next('terminal.output')).seq).toBe(2);
    expect((await a.next('terminal.output')).seq).toBe(3);
    expect(a.of('terminal.snapshot')).toHaveLength(0);

    a.send({ type: 'terminal.unsubscribe', sessionId: session.id });
    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: 4, data: 'only-b' });
    expect((await b.next('terminal.output')).seq).toBe(4);
    expect(daemon.of('terminal.unsubscribe')).toHaveLength(0);
    expect(a.of('terminal.output')).toHaveLength(0);

    // 最後一個人斷線（不是退訂）也算。
    b.ws.terminate();
    await daemon.next('terminal.unsubscribe');
    expect(daemon.of('terminal.subscribe')).toHaveLength(0);
  });

  it('a daemon cannot write into a session on another machine', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: '',
    });
    await client.next('terminal.snapshot');

    const { daemon: other } = await hub.onlineDaemon(cookie);
    other.send({ type: 'terminal.output', sessionId: session.id, seq: 1, data: 'INJECTED' });
    other.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'error', cwd: '/evil' }),
    });
    other.send({ type: 'approval.requested', approval: approval(session.id) });
    other.send({
      type: 'session.event',
      event: {
        id: 'e1',
        sessionId: session.id,
        type: 'status',
        payload: {},
        at: new Date().toISOString(),
      },
    });
    // hello 夾帶別台的 session 也一樣。
    other.send(
      hello({
        sessions: [runtime(session.id, { status: 'error' })],
        pendingApprovals: [approval(session.id)],
      }),
    );
    await other.next('hub.welcome');

    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: 1, data: 'legit' });
    expect((await client.next('terminal.output')).data).toBe('legit');
    expect(JSON.stringify(client.messages)).not.toContain('INJECTED');
    const after = hub.running.store.getSession(session.id)!;
    expect(after.status).toBe('running');
    expect(after.cwd).toBe('/fake/project');
    expect(client.of('approval.requested')).toHaveLength(0);
    expect(hub.running.store.listEvents(session.id).some((e) => e.id === 'e1')).toBe(false);
  });

  it('keeps feeding a healthy client while a slow one overflows, then resyncs the slow one', async () => {
    hub = await startHub({ timing: { drainPollMs: 10 } });
    const { cookie, daemon, session } = await startedSession();
    const fast = await hub.client(cookie);
    const slow = await hub.client(cookie);
    for (const c of [fast, slow]) c.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: '',
    });
    await fast.next('terminal.snapshot');
    await slow.next('terminal.snapshot');
    daemon.clear();

    // 慢 client：不讀 socket，資料全部卡在 hub 這邊。
    const rawSocket = (slow.ws as unknown as { _socket: { pause(): void; resume(): void } })
      ._socket;
    rawSocket.pause();

    const chunk = 'x'.repeat(256 * 1024);
    let fastLast = 0;
    let fastGaps = 0;
    fast.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; seq?: number };
      if (m.type !== 'terminal.output') return;
      if (m.seq !== fastLast + 1) fastGaps += 1;
      fastLast = m.seq!;
    });
    const hubClients = [
      ...(hub.running.hub as unknown as { clients: Set<{ ws: { bufferedAmount: number } }> })
        .clients,
    ];
    const maxBuffered = () => Math.max(...hubClients.map((c) => c.ws.bufferedAmount));
    let seq = 0;
    // 健康的 client：每一筆都等它收到才送下一筆，它不會落後。
    const pump = async () => {
      seq += 1;
      daemon.send({ type: 'terminal.output', sessionId: session.id, seq, data: chunk });
      const target = seq;
      await until(() => fastLast === target, `fast client at seq ${target}`, 10_000);
    };

    // 灌到慢 client 超過 1 MiB（kernel socket buffer 滿了之後才會累積在 hub）。
    const MiB = 1024 * 1024;
    for (let i = 0; i < 400 && maxBuffered() <= MiB; i += 1) await pump();
    expect(maxBuffered()).toBeGreaterThan(MiB);

    // 超量後對慢 client 的輸出全部丟棄：再送 20 MiB，hub 的緩衝不會再長。
    await pump();
    const capped = maxBuffered();
    for (let i = 0; i < 80; i += 1) await pump();
    expect(maxBuffered()).toBe(capped);
    expect(capped).toBeLessThan(2 * MiB);

    // 健康的 client 全程一筆不少。
    expect(fastGaps).toBe(0);
    expect(fastLast).toBe(seq);
    expect(fast.closeCode).toBeNull();
    fast.clear();

    // 緩衝還沒消化前不要新快照：現在要了也送不過去。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(daemon.of('terminal.subscribe')).toHaveLength(0);

    // 慢 client 恢復讀取：緩衝消化後，hub 向 daemon 要新快照，只給它。
    slow.clear();
    rawSocket.resume();
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq,
      cols: 80,
      rows: 24,
      data: 'RESYNC',
    });
    expect(await slow.next('terminal.snapshot')).toMatchObject({ seq, data: 'RESYNC' });
    expect(fast.of('terminal.snapshot')).toHaveLength(0);
    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: seq + 1, data: 'after' });
    expect(await slow.next('terminal.output', (m) => m.data === 'after')).toMatchObject({
      seq: seq + 1,
    });
    expect(await fast.next('terminal.output', (m) => m.data === 'after')).toMatchObject({
      seq: seq + 1,
    });
  }, 60_000);

  it('terminates a client that never drains', async () => {
    let now = Date.now();
    hub = await startHub({
      now: () => new Date(now),
      timing: { drainPollMs: 10, maxClientBufferBytes: 1024, drainTimeoutMs: 1000 },
    });
    const { cookie, daemon, session } = await startedSession();
    const stuck = await hub.client(cookie);
    stuck.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: '',
    });
    await stuck.next('terminal.snapshot');
    (stuck.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const hubClients = (
      hub.running.hub as unknown as {
        clients: Set<{ ws: { bufferedAmount: number; readyState: number } }>;
      }
    ).clients;
    const chunk = 'y'.repeat(256 * 1024);
    let seq = 1;
    await until(
      () => {
        daemon.send({ type: 'terminal.output', sessionId: session.id, seq: seq++, data: chunk });
        return [...hubClients].some((c) => c.ws.bufferedAmount > 1024);
      },
      'hub-side buffer to fill',
      10_000,
    );
    // 再多一筆讓 relay 看到超量。
    daemon.send({ type: 'terminal.output', sessionId: session.id, seq: seq++, data: 'z' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    now += 2000;
    await until(() => hubClients.size === 0, 'hub to drop the stuck client', 3000);
  }, 30_000);

  it('never writes terminal content to the database', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 1,
      cols: 80,
      rows: 24,
      data: 'SNAPSHOT_MARKER_7f3a',
    });
    daemon.send({
      type: 'terminal.output',
      sessionId: session.id,
      seq: 2,
      data: 'OUTPUT_MARKER_9b1c',
    });
    expect((await client.next('terminal.snapshot')).data).toBe('SNAPSHOT_MARKER_7f3a');
    expect((await client.next('terminal.output')).data).toBe('OUTPUT_MARKER_9b1c');

    // 同時驗證檢查方法本身有效：audit 的輸入確實讀得到。
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'INPUT_MARKER_44aa\r' });
    await daemon.next('terminal.input');

    const db = hub.running.db;
    db.pragma('wal_checkpoint(FULL)');
    const dump = walOf(hub);
    expect(dump).toContain('INPUT_MARKER_44aa');
    expect(dump).not.toContain('SNAPSHOT_MARKER_7f3a');
    expect(dump).not.toContain('OUTPUT_MARKER_9b1c');
  });
});

describe('reconciliation', () => {
  it('daemon disconnect marks machine and sessions offline and tells clients; hello restores real state', async () => {
    hub = await startHub();
    const { cookie, daemon, machineId, token, session } = await startedSession();
    daemon.send({ type: 'session.runtime', session: runtime(session.id, { status: 'running' }) });
    await until(() => hub.running.store.getSession(session.id)?.status === 'running', 'running');
    await hub.api('PATCH', `/api/sessions/${session.id}`, {
      cookie,
      body: { name: 'renamed', archived: true },
    });
    const client = await hub.client(cookie);
    client.clear();

    daemon.ws.terminate();
    const offline = await client.next(
      'session.updated',
      (m) => (m.session as { status: string }).status === 'offline',
    );
    expect(offline.session).toMatchObject({ id: session.id });
    const machine = await client.next('machine.updated');
    expect(machine.machine).toMatchObject({ id: machineId, online: false });

    const back = await hub.daemon(token);
    back.send(
      hello({
        sessions: [
          runtime(session.id, { status: 'waiting_input', claudeSessionId: 'c2', cwd: '/fake/wt' }),
        ],
      }),
    );
    await back.next('hub.welcome');
    const restored = await client.next(
      'session.updated',
      (m) => (m.session as { status: string }).status === 'waiting_input',
    );
    // daemon 的欄位覆蓋；hub 擁有的 name、archived 不動。
    expect(restored.session).toMatchObject({
      claudeSessionId: 'c2',
      cwd: '/fake/wt',
      name: 'renamed',
      archived: true,
    });
    expect((await client.next('machine.updated')).machine).toMatchObject({ online: true });
  });

  it('a session missing from hello ends as error, a queued one stays queued', async () => {
    hub = await startHub();
    const { cookie, daemon, token, session, machineId } = await startedSession();
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 1 } },
    });
    const queued = await newSession(cookie, machineId);
    expect(queued.status).toBe('queued');
    daemon.ws.terminate();
    await until(() => hub.running.store.getSession(session.id)?.status === 'offline', 'offline');
    expect(hub.running.store.getSession(queued.id)?.status).toBe('queued');

    const back = await hub.daemon(token);
    back.send(hello());
    await back.next('hub.welcome');
    await until(() => hub.running.store.getSession(session.id)?.status === 'error', 'error');
    expect(hub.running.store.getSession(session.id)?.endedAt).not.toBeNull();
    // 名額因此空出來，排隊的開始。
    const started = await back.next('session.create');
    expect(started.sessionId).toBe(queued.id);
  });

  it('a late session.created brings a session back after reconciliation marked it lost', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
    const session = await newSession(cookie, machineId);
    await daemon.next('session.create');
    daemon.ws.terminate();
    await until(() => hub.running.store.getSession(session.id)?.status === 'offline', 'offline');
    const back = await hub.daemon(token);
    back.send(hello());
    await back.next('hub.welcome');
    await until(() => hub.running.store.getSession(session.id)?.status === 'error', 'error');
    expect(back.of('session.create')).toHaveLength(0); // 不重送，避免重複開 PTY
    back.send({ type: 'session.runtime', session: runtime(session.id, { status: 'running' }) });
    await until(() => hub.running.store.getSession(session.id)?.status === 'running', 'running');
    expect(hub.running.store.getSession(session.id)?.endedAt).toBeNull();
  });

  it('done set by the user is not overwritten by the daemon', async () => {
    hub = await startHub();
    const { cookie, daemon, token, session } = await startedSession();
    daemon.send({ type: 'session.runtime', session: runtime(session.id, { status: 'running' }) });
    await until(() => hub.running.store.getSession(session.id)?.status === 'running', 'running');
    const marked = await hub.api('PATCH', `/api/sessions/${session.id}`, {
      cookie,
      body: { markDone: true },
    });
    expect(marked.body.status).toBe('done');

    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'running', lastLines: ['new line'] }),
    });
    await until(
      () => hub.running.store.getSession(session.id)?.lastLines[0] === 'new line',
      'runtime applied',
    );
    expect(hub.running.store.getSession(session.id)?.status).toBe('done');

    // 斷線、hello 都不會蓋掉 done。
    daemon.ws.terminate();
    await until(
      () =>
        hub.running.store.getMachine(hub.running.store.getSession(session.id)!.machineId)
          ?.online === false,
      'machine offline',
    );
    expect(hub.running.store.getSession(session.id)?.status).toBe('done');
    const back = await hub.daemon(token);
    back.send(hello({ sessions: [runtime(session.id, { status: 'waiting_input' })] }));
    await back.next('hub.welcome');
    expect(hub.running.store.getSession(session.id)?.status).toBe('done');
  });

  it('a daemon cannot set hub-only statuses', async () => {
    hub = await startHub();
    const { daemon, session } = await startedSession();
    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'done', lastLines: ['a'] }),
    });
    await until(() => hub.running.store.getSession(session.id)?.lastLines[0] === 'a', 'applied');
    expect(hub.running.store.getSession(session.id)?.status).toBe('running');
  });

  it('re-subscribes viewers and resources after the daemon reconnects', async () => {
    hub = await startHub();
    const { cookie, daemon, token, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    client.send({ type: 'resources.watch', watching: true });
    await daemon.next('terminal.subscribe');
    expect(await daemon.next('resources.watch')).toMatchObject({ watching: true });
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 5,
      cols: 80,
      rows: 24,
      data: 'old',
    });
    await client.next('terminal.snapshot');
    daemon.ws.terminate();
    await until(() => hub.running.store.getSession(session.id)?.status === 'offline', 'offline');

    const back = await hub.daemon(token);
    back.send(hello({ sessions: [runtime(session.id)] }));
    await back.next('hub.welcome');
    await back.next('terminal.subscribe');
    expect(await back.next('resources.watch')).toMatchObject({ watching: true });
    back.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 9,
      cols: 80,
      rows: 24,
      data: 'new',
    });
    expect(await client.next('terminal.snapshot')).toMatchObject({ seq: 9, data: 'new' });
  });

  it('resets everything to offline when the hub itself restarts', async () => {
    hub = await startHub();
    const { session, machineId } = await startedSession();
    await until(() => hub.running.store.getSession(session.id)?.status === 'running', 'running');
    const { createHub } = await import('../server');
    await hub.running.close();
    const again = createHub({ dbPath: hub.dbPath, host: '127.0.0.1', port: 0, webDir: null });
    expect(again.store.getSession(session.id)?.status).toBe('offline');
    expect(again.store.getMachine(machineId)?.online).toBe(false);
    await again.close();
  });
});

describe('session lifecycle', () => {
  const setLimit = (cookie: string, max: number | null) =>
    hub.api('PATCH', '/api/settings', {
      cookie,
      body: { quotaGuards: { denyReadPaths: [], maxConcurrentSessions: max } },
    });

  it('queues beyond maxConcurrentSessions and starts automatically, FIFO, when a slot frees', async () => {
    hub = await startHub();
    const { cookie, daemon, machineId, session } = await startedSession();
    await setLimit(cookie, 1);
    const q1 = await newSession(cookie, machineId, { firstPrompt: 'first' });
    const q2 = await newSession(cookie, machineId);
    expect([q1.status, q2.status]).toEqual(['queued', 'queued']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(daemon.of('session.create')).toHaveLength(0);

    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'error', endedAt: new Date().toISOString() }),
    });
    const c1 = await daemon.next('session.create');
    expect(c1.sessionId).toBe(q1.id);
    expect((c1.spec as { firstPrompt: string }).firstPrompt).toBe('first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(daemon.of('session.create')).toHaveLength(0);
    expect(hub.running.store.getSession(q2.id)?.status).toBe('queued');

    daemon.send({
      type: 'session.createFailed',
      requestId: c1.requestId,
      error: 'no such directory',
    });
    const c2 = await daemon.next('session.create');
    expect(c2.sessionId).toBe(q2.id);
    const failed = hub.running.store.getSession(q1.id)!;
    expect(failed).toMatchObject({ status: 'error', statusDetail: 'no such directory' });
    expect(failed.endedAt).not.toBeNull();
  });

  it('raising the limit starts queued sessions; a queued session on an offline machine does not block others', async () => {
    hub = await startHub();
    const { cookie, daemon, machineId, session } = await startedSession();
    await setLimit(cookie, 1);
    const blocked = await newSession(cookie, machineId);
    const other = await hub.onlineDaemon(cookie);
    const q = await newSession(cookie, other.machineId);
    expect(q.status).toBe('queued');
    other.daemon.ws.terminate();
    await until(() => hub.running.store.getMachine(other.machineId)?.online === false, 'offline');
    await setLimit(cookie, 3);
    expect((await daemon.next('session.create')).sessionId).toBe(blocked.id);
    expect(hub.running.store.getSession(q.id)?.status).toBe('queued');
    expect(session.id).toBeTruthy();
  });

  it('refuses to create on offline or unknown machines', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { machineId } = await hub.pair(cookie);
    const offline = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec(), machineId },
    });
    expect(offline.status).toBe(409);
    const unknown = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec(), machineId: 'nope' },
    });
    expect(unknown.status).toBe(404);
    expect(hub.running.store.listSessions()).toEqual([]);
  });

  it('marks a session as error when the daemon never confirms the start', async () => {
    hub = await startHub({ timing: { createTimeoutMs: 30 } });
    const cookie = await hub.setupOwner();
    const { machineId } = await hub.onlineDaemon(cookie);
    const session = await newSession(cookie, machineId);
    await until(
      () => hub.running.store.getSession(session.id)?.status === 'error',
      'timeout error',
    );
    expect(hub.running.store.getSession(session.id)?.endedAt).not.toBeNull();
  });

  it('does not fail a session that started without session.created', async () => {
    hub = await startHub({ timing: { createTimeoutMs: 40 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const session = await newSession(cookie, machineId);
    await daemon.next('session.create');
    daemon.send({ type: 'session.runtime', session: runtime(session.id, { status: 'running' }) });
    await until(() => hub.running.store.getSession(session.id)?.status === 'running', 'running');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hub.running.store.getSession(session.id)?.status).toBe('running');
  });

  it('a queued session survives a daemon claiming it is alive, and still starts later', async () => {
    hub = await startHub();
    const { cookie, daemon, token, session, machineId } = await startedSession();
    await setLimit(cookie, 1);
    const queued = await newSession(cookie, machineId, { firstPrompt: 'later' });
    daemon.ws.terminate();
    await until(() => hub.running.store.getSession(session.id)?.status === 'offline', 'offline');
    const back = await hub.daemon(token);
    back.send(hello({ sessions: [runtime(session.id), runtime(queued.id)] }));
    await back.next('hub.welcome');
    expect(hub.running.store.getSession(queued.id)?.status).toBe('queued');
    back.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'error', endedAt: new Date().toISOString() }),
    });
    const create = await back.next('session.create');
    expect(create.sessionId).toBe(queued.id);
    expect((create.spec as { firstPrompt: string }).firstPrompt).toBe('later');
  });

  it('stop goes to the daemon; a queued session is cancelled locally', async () => {
    hub = await startHub();
    const { cookie, daemon, machineId, session } = await startedSession();
    const res = await hub.api('POST', `/api/sessions/${session.id}/stop`, { cookie });
    expect(res.status).toBe(200);
    expect(await daemon.next('session.stop')).toMatchObject({ sessionId: session.id });

    await setLimit(cookie, 1);
    const queued = await newSession(cookie, machineId);
    const cancelled = await hub.api('POST', `/api/sessions/${queued.id}/stop`, { cookie });
    expect(cancelled.body).toMatchObject({
      status: 'done',
      statusDetail: 'cancelled while queued',
    });
    expect(daemon.of('session.stop')).toHaveLength(0);
    expect(cancelled.body.endedAt).not.toBeNull();
  });

  it('resume re-sends session.create with the Claude id and original directory', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const activeResume = await hub.api('POST', `/api/sessions/${session.id}/resume`, { cookie });
    expect(activeResume.status).toBe(409);
    expect(activeResume.body.code).toBe('session_active');

    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, {
        status: 'error',
        endedAt: new Date().toISOString(),
        claudeSessionId: 'claude-xyz',
        worktreePath: '/fake/wt',
      }),
    });
    await until(() => hub.running.store.getSession(session.id)?.endedAt !== null, 'ended');
    const stop = await hub.api('POST', `/api/sessions/${session.id}/stop`, { cookie });
    expect(stop.body.code).toBe('session_ended');

    const res = await hub.api('POST', `/api/sessions/${session.id}/resume`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'starting', endedAt: null });
    const create = await daemon.next('session.create');
    expect(create.sessionId).toBe(session.id);
    expect(create.spec).toMatchObject({
      resumeClaudeSessionId: 'claude-xyz',
      cwd: '/fake/wt',
      useWorktree: false,
      firstPrompt: null,
    });
  });

  it('list filters archived correctly, including the string "false"', async () => {
    hub = await startHub();
    const { cookie, session, machineId, daemon } = await startedSession();
    const other = await newSession(cookie, machineId);
    await daemon.next('session.create');
    await hub.api('PATCH', `/api/sessions/${session.id}`, { cookie, body: { archived: true } });
    const ids = async (query: string) =>
      ((await hub.api('GET', `/api/sessions${query}`, { cookie })).body as { id: string }[]).map(
        (s) => s.id,
      );
    expect(await ids('?archived=false')).toEqual([other.id]);
    expect(await ids('?archived=true')).toEqual([session.id]);
    expect((await ids('')).sort()).toEqual([session.id, other.id].sort());
    expect((await hub.api('GET', '/api/sessions?archived=maybe', { cookie })).status).toBe(400);
  });

  it('events: hub status changes and daemon events are stored, relayed and de-duplicated', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    const event = {
      id: 'ev-1',
      sessionId: session.id,
      type: 'status',
      payload: { from: 'a', to: 'b', reason: 'c' },
      at: new Date().toISOString(),
    };
    daemon.send({ type: 'session.event', event });
    daemon.send({ type: 'session.event', event });
    expect((await client.next('session.event')).event).toEqual(event);
    await hub.api('PATCH', `/api/sessions/${session.id}`, { cookie, body: { markDone: true } });
    await client.next('session.event', (m) => (m.event as { type: string }).type === 'status');
    expect(client.of('session.event')).toHaveLength(0);
    const events = (await hub.api('GET', `/api/sessions/${session.id}/events`, { cookie }))
      .body as { id: string; payload: { reason?: string } }[];
    expect(events.filter((e) => e.id === 'ev-1')).toHaveLength(1);
    expect(events.some((e) => e.payload.reason === 'user_marked_done')).toBe(true);
    expect((await hub.api('GET', '/api/sessions/nope/events', { cookie })).status).toBe(404);
  });

  it('resources only flow while someone watches, and reach only watchers', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const a = await hub.client(cookie);
    const b = await hub.client(cookie);
    a.send({ type: 'resources.watch', watching: true });
    expect(await daemon.next('resources.watch')).toMatchObject({ watching: true });
    b.send({ type: 'resources.watch', watching: true });
    const sample = {
      at: new Date().toISOString(),
      cpuPercent: 1,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
      gpu: null,
    };
    daemon.send({ type: 'resources', sample });
    expect((await a.next('resources')).sample).toEqual({ ...sample, machineId });
    expect((await b.next('resources')).sample).toEqual({ ...sample, machineId });
    b.send({ type: 'resources.watch', watching: false });
    a.send({ type: 'ping', at: new Date().toISOString() });
    await a.next('pong');
    expect(daemon.of('resources.watch')).toHaveLength(0);
    a.ws.terminate();
    expect(await daemon.next('resources.watch')).toMatchObject({ watching: false });
  });

  it('caches usage from the daemon and overwrites machineId', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const summary = {
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 7,
      cacheCreationTokens: 8,
    };
    daemon.send({ type: 'usage', summary });
    await until(() => hub.running.hub.latestUsage(machineId) !== null, 'usage');
    const res = await hub.api('GET', `/api/machines/${machineId}/usage`, { cookie });
    expect(res.body).toEqual({ ...summary, machineId });
    expect((await hub.api('GET', '/api/machines/nope/usage', { cookie })).status).toBe(404);
  });

  it('re-sends welcome when danger rules change, so the rule applies without a reconnect', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon } = await hub.onlineDaemon(cookie);
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { dangerRules: ['mkfs'], stuckMinutes: 3 },
    });
    expect(await daemon.next('hub.welcome')).toMatchObject({
      dangerRules: ['mkfs'],
      stuckMinutes: 3,
    });
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: false, quietHours: null } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(daemon.of('hub.welcome')).toHaveLength(0);
  });
});

describe('directory browsing', () => {
  it('forwards fs.list and returns the result', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const pending = hub.api(
      'GET',
      `/api/machines/${machineId}/fs?path=${encodeURIComponent('/fake')}`,
      { cookie },
    );
    const req = await daemon.next('fs.list');
    expect(req.path).toBe('/fake');
    const entries = [{ name: 'a', isDir: true, isGitRepo: false }];
    daemon.send({
      type: 'fs.listResult',
      requestId: req.requestId,
      path: '/fake',
      entries,
      error: null,
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: '/fake', entries });
  });

  it('surfaces daemon errors, timeouts, disconnects, and offline machines', async () => {
    hub = await startHub({ timing: { browseTimeoutMs: 40 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const url = `/api/machines/${machineId}/fs?path=/x`;

    const failing = hub.api('GET', url, { cookie });
    const req = await daemon.next('fs.list');
    daemon.send({
      type: 'fs.listResult',
      requestId: req.requestId,
      path: '/x',
      entries: [],
      error: 'EACCES',
    });
    expect(await failing).toMatchObject({
      status: 400,
      body: { code: 'fs_error', message: 'EACCES' },
    });

    const timeout = await hub.api('GET', url, { cookie });
    expect(timeout).toMatchObject({ status: 504, body: { code: 'daemon_timeout' } });
    await daemon.next('fs.list');

    const cut = hub.api('GET', url, { cookie });
    await daemon.next('fs.list');
    daemon.ws.terminate();
    expect(await cut).toMatchObject({ status: 502, body: { code: 'daemon_disconnected' } });

    await until(() => hub.running.store.getMachine(machineId)?.online === false, 'offline');
    expect(await hub.api('GET', url, { cookie })).toMatchObject({
      status: 409,
      body: { code: 'machine_offline' },
    });
    expect((await hub.api('GET', '/api/machines/nope/fs?path=/x', { cookie })).status).toBe(404);
  });

  it('ignores a browse result from another machine', async () => {
    hub = await startHub({ timing: { browseTimeoutMs: 80 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const { daemon: other } = await hub.onlineDaemon(cookie);
    const pending = hub.api('GET', `/api/machines/${machineId}/fs?path=/x`, { cookie });
    const req = await daemon.next('fs.list');
    other.send({
      type: 'fs.listResult',
      requestId: req.requestId,
      path: '/x',
      entries: [{ name: 'forged', isDir: false, isGitRepo: false }],
      error: null,
    });
    expect((await pending).status).toBe(504);
  });
});

describe('approvals', () => {
  it('relays to all clients, forwards the decision to the daemon, audits it', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const a = await hub.client(cookie);
    const b = await hub.client(cookie);
    const pending = approval(session.id, { kind: 'danger', matchedRule: 'rm -rf /' });
    daemon.send({ type: 'approval.requested', approval: pending });
    expect((await a.next('approval.requested')).approval).toEqual(pending);
    expect((await b.next('approval.requested')).approval).toEqual(pending);

    // 新連上的 client 從 board.state 看得到。
    const late = await connect(`ws://127.0.0.1:${hub.port}/ws/client`, {
      cookie,
      origin: hub.origin,
    });
    expect((await late.next('board.state')).approvals).toEqual([pending]);
    late.close();

    a.send({
      type: 'approval.decide',
      approvalId: pending.id,
      sessionId: session.id,
      decision: { behavior: 'deny', reason: 'too risky' },
    });
    const forwarded = await daemon.next('approval.decide');
    expect(forwarded).toMatchObject({
      approvalId: pending.id,
      decision: { behavior: 'deny', reason: 'too risky' },
    });
    expect((await b.next('approval.resolved')).by).toBe('web');

    // 第二個人晚一步：不會有第二個決定送到 daemon。
    b.send({
      type: 'approval.decide',
      approvalId: pending.id,
      sessionId: session.id,
      decision: { behavior: 'allow', remember: false },
    });
    expect((await b.next('error')).code).toBe('approval_not_found');
    expect(daemon.of('approval.decide')).toHaveLength(0);

    const row = auditRows().find((r) => r.action === 'approval.decide')!;
    expect(row.session_id).toBe(session.id);
    expect(row.user_id).not.toBeNull();
    expect(JSON.parse(row.detail)).toMatchObject({
      approvalId: pending.id,
      matchedRule: 'rm -rf /',
      decision: { behavior: 'deny', reason: 'too risky' },
    });
    const events = hub.running.store.listEvents(session.id).map((e) => e.type);
    expect(events).toContain('approval.requested');
    expect(events).toContain('approval.decided');

    // daemon 的回音不會再廣播一次。
    a.clear();
    daemon.send({
      type: 'approval.resolved',
      approvalId: pending.id,
      sessionId: session.id,
      by: 'web',
    });
    a.send({ type: 'ping', at: new Date().toISOString() });
    await a.next('pong');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.of('approval.resolved')).toHaveLength(0);
  });

  it('records a decision made in the terminal', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    const pending = approval(session.id);
    daemon.send({ type: 'approval.requested', approval: pending });
    await client.next('approval.requested');
    daemon.send({
      type: 'approval.resolved',
      approvalId: pending.id,
      sessionId: session.id,
      by: 'terminal',
    });
    expect((await client.next('approval.resolved')).by).toBe('terminal');
    const row = auditRows().find((r) => r.action === 'approval.resolved')!;
    expect(row.user_id).toBeNull();
    expect(JSON.parse(row.detail)).toMatchObject({ by: 'terminal' });
  });

  it('hello reconciles the cache: new ones appear, vanished ones resolve', async () => {
    hub = await startHub();
    const { cookie, daemon, token, session } = await startedSession();
    const client = await hub.client(cookie);
    const gone = approval(session.id);
    const kept = approval(session.id);
    daemon.send({ type: 'approval.requested', approval: gone });
    daemon.send({ type: 'approval.requested', approval: kept });
    await client.next('approval.requested');
    await client.next('approval.requested');
    daemon.ws.terminate();
    await until(() => hub.running.store.getSession(session.id)?.status === 'offline', 'offline');

    // 離線時決定不了，也不會把 approval 弄丟。
    client.send({
      type: 'approval.decide',
      approvalId: kept.id,
      sessionId: session.id,
      decision: { behavior: 'allow', remember: false },
    });
    expect((await client.next('error')).code).toBe('machine_offline');

    const fresh = approval(session.id);
    const back = await hub.daemon(token);
    back.send(hello({ sessions: [runtime(session.id)], pendingApprovals: [kept, fresh] }));
    await back.next('hub.welcome');
    expect((await client.next('approval.requested')).approval).toEqual(fresh);
    const resolved = await client.next('approval.resolved');
    expect(resolved).toMatchObject({ approvalId: gone.id, by: 'timeout' });
    client.send({
      type: 'approval.decide',
      approvalId: kept.id,
      sessionId: session.id,
      decision: { behavior: 'allow', remember: true },
    });
    expect((await back.next('approval.decide')).approvalId).toBe(kept.id);
  });

  it('rejects a decision whose sessionId does not match the approval', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    const pending = approval(session.id);
    daemon.send({ type: 'approval.requested', approval: pending });
    await client.next('approval.requested');
    client.send({
      type: 'approval.decide',
      approvalId: pending.id,
      sessionId: 'other',
      decision: { behavior: 'allow', remember: false },
    });
    expect((await client.next('error')).code).toBe('approval_not_found');
    expect(daemon.of('approval.decide')).toHaveLength(0);
  });

  it('rejects a deny without a reason as invalid', async () => {
    hub = await startHub();
    const { cookie, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({
      type: 'approval.decide',
      approvalId: 'a',
      sessionId: session.id,
      decision: { behavior: 'deny', reason: '   ' },
    });
    expect((await client.next('error')).code).toBe('invalid_message');
  });
});

describe('audit of terminal input', () => {
  it('records one row per Enter, not per key, attributed to the user', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    const before = auditRows().length;
    for (const ch of 'git status') {
      client.send({ type: 'terminal.input', sessionId: session.id, data: ch });
      await daemon.next('terminal.input');
    }
    expect(auditRows().length).toBe(before);
    client.send({ type: 'terminal.input', sessionId: session.id, data: '\r' });
    await daemon.next('terminal.input');
    const rows = auditRows().filter((r) => r.action === 'terminal.input');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ detail: 'git status', session_id: session.id });
    expect(rows[0]!.user_id).not.toBeNull();

    client.send({ type: 'terminal.signal', sessionId: session.id, signal: 'escape' });
    await daemon.next('terminal.signal');
    expect(auditRows().find((r) => r.action === 'terminal.signal')).toMatchObject({
      detail: 'escape',
    });
  });

  it('keeps an unfinished line when the client disconnects', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'half typed' });
    await daemon.next('terminal.input');
    client.ws.terminate();
    await until(
      () => auditRows().some((r) => r.action === 'terminal.input.partial'),
      'partial row',
    );
    expect(auditRows().find((r) => r.action === 'terminal.input.partial')?.detail).toBe(
      'half typed',
    );
  });

  it('audits firstPrompt as terminal input', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { machineId } = await hub.onlineDaemon(cookie);
    const session = await newSession(cookie, machineId, { firstPrompt: 'fix the bug' });
    const row = auditRows().find((r) => r.action === 'terminal.input');
    expect(row).toMatchObject({ detail: 'fix the bug', session_id: session.id });
  });

  it('refuses input to ended sessions and offline machines without forwarding', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'error', endedAt: new Date().toISOString() }),
    });
    await until(() => hub.running.store.getSession(session.id)?.endedAt !== null, 'ended');
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'x\r' });
    expect((await client.next('error')).code).toBe('session_ended');
    expect(daemon.of('terminal.input')).toHaveLength(0);
    expect(auditRows().filter((r) => r.action === 'terminal.input')).toHaveLength(0);
  });

  it('does not forward input when the audit write fails', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    hub.running.db.exec('DROP TABLE audit_log');
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'rm -rf x\r' });
    expect((await client.next('error')).code).toBe('internal');
    expect(daemon.of('terminal.input')).toHaveLength(0);
  });

  it('exports CSV with injection protection', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({
      type: 'terminal.input',
      sessionId: session.id,
      data: '=HYPERLINK("http://evil")\r',
    });
    await daemon.next('terminal.input');
    const res = await hub.api('GET', '/api/audit/export', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.body as unknown as string).toContain(`"'=HYPERLINK(""http://evil"")"`);

    const list = await hub.api(
      'GET',
      `/api/audit?action=terminal.input&sessionId=${session.id}&limit=1`,
      { cookie },
    );
    expect(list.body).toHaveLength(1);
    expect(list.body[0].detail).toBe('=HYPERLINK("http://evil")');
    const empty = await hub.api('GET', '/api/audit?from=2999-01-01T00:00:00.000Z', { cookie });
    expect(empty.body).toEqual([]);
  });
});

describe('push notifications', () => {
  const subscribe = (cookie: string, endpoint = 'https://push.example/abc') =>
    hub.api('POST', '/api/push/subscriptions', {
      cookie,
      body: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
    });
  const to = (daemon: Peer, sessionId: string, status: string) =>
    daemon.send({
      type: 'session.runtime',
      session: runtime(sessionId, { status: status as 'running' }),
    });
  const settled = async (sessionId: string, status: string) => {
    await until(() => hub.running.store.getSession(sessionId)?.status === status, status);
    await hub.running.hub.pushesSettled();
  };

  it('fires on entering an attention status only, without terminal content', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    await subscribe(cookie);
    await settled(session.id, 'running');
    expect(hub.push.sent).toHaveLength(0);

    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'waiting_input', lastLines: ['SECRET_LINE'] }),
    });
    await settled(session.id, 'waiting_input');
    expect(hub.push.sent).toHaveLength(1);
    expect(JSON.parse(hub.push.sent[0]!.payload)).toMatchObject({
      sessionId: session.id,
      status: 'waiting_input',
    });
    expect(hub.push.sent[0]!.payload).not.toContain('SECRET_LINE');

    // 留在同一個狀態不重發；離開再進入才發。
    to(daemon, session.id, 'waiting_input');
    await hub.running.hub.pushesSettled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.push.sent).toHaveLength(1);
    to(daemon, session.id, 'rate_limited');
    await settled(session.id, 'rate_limited');
    expect(hub.push.sent).toHaveLength(1);
    to(daemon, session.id, 'plan_review');
    await settled(session.id, 'plan_review');
    expect(hub.push.sent).toHaveLength(2);
  });

  it('respects notifications.enabled and quiet hours', async () => {
    let now = new Date(2026, 10, 2, 23, 30);
    hub = await startHub({ now: () => now });
    const { cookie, daemon, session } = await startedSession();
    await subscribe(cookie);
    await settled(session.id, 'running');

    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: false, quietHours: null } },
    });
    to(daemon, session.id, 'waiting_input');
    await settled(session.id, 'waiting_input');
    expect(hub.push.sent).toHaveLength(0);

    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: true, quietHours: { start: '22:00', end: '07:00' } } },
    });
    to(daemon, session.id, 'running');
    await settled(session.id, 'running');
    to(daemon, session.id, 'stuck');
    await settled(session.id, 'stuck');
    expect(hub.push.sent).toHaveLength(0);

    now = new Date(2026, 10, 3, 8, 0);
    to(daemon, session.id, 'running');
    await settled(session.id, 'running');
    to(daemon, session.id, 'error');
    await settled(session.id, 'error');
    expect(hub.push.sent).toHaveLength(1);
  });

  it('does not re-notify when a waiting session comes back from offline', async () => {
    hub = await startHub();
    const { cookie, daemon, token, session } = await startedSession();
    await subscribe(cookie);
    to(daemon, session.id, 'waiting_input');
    await settled(session.id, 'waiting_input');
    expect(hub.push.sent).toHaveLength(1);
    daemon.ws.terminate();
    await settled(session.id, 'offline');
    const back = await hub.daemon(token);
    back.send(hello({ sessions: [runtime(session.id, { status: 'waiting_input' })] }));
    await back.next('hub.welcome');
    await settled(session.id, 'waiting_input');
    expect(hub.push.sent).toHaveLength(1);
    // 但斷線期間進入別的需要處理狀態，要通知。
    back.ws.terminate();
    await settled(session.id, 'offline');
    const again = await hub.daemon(token);
    again.send(hello({ sessions: [runtime(session.id, { status: 'plan_review' })] }));
    await again.next('hub.welcome');
    await settled(session.id, 'plan_review');
    expect(hub.push.sent).toHaveLength(2);
  });

  it('removes subscriptions the push service says are gone, and survives failures', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    await subscribe(cookie);
    hub.push.setResult('gone');
    to(daemon, session.id, 'waiting_input');
    await settled(session.id, 'waiting_input');
    expect(hub.running.store.listPushSubscriptions()).toEqual([]);

    await subscribe(cookie);
    hub.push.setResult('failed');
    to(daemon, session.id, 'running');
    await settled(session.id, 'running');
    to(daemon, session.id, 'error');
    await settled(session.id, 'error');
    expect(hub.running.store.listPushSubscriptions()).toHaveLength(1);
  });

  it('retries once on transient failure', async () => {
    hub = await startHub({ timing: { pushRetryMs: 1 } });
    const { cookie, daemon, session } = await startedSession();
    await subscribe(cookie);
    hub.push.setResult('retry');
    to(daemon, session.id, 'waiting_input');
    await settled(session.id, 'waiting_input');
    expect(hub.push.sent).toHaveLength(2);
    expect(hub.running.store.listPushSubscriptions()).toHaveLength(1);
  });

  it('a push transport that throws does not break the hub', async () => {
    const dir = await startHub();
    await dir.stop();
    hub = await startHub({
      pushTransport: {
        send: async () => {
          throw new Error('boom');
        },
      },
    });
    const { cookie, daemon, session } = await startedSession();
    await subscribe(cookie);
    to(daemon, session.id, 'waiting_input');
    await settled(session.id, 'waiting_input');
    expect((await hub.api('GET', '/api/auth/status', { cookie })).status).toBe(200);
  });
});

describe('robustness', () => {
  it('a database failure in a heartbeat does not take down the process', async () => {
    hub = await startHub({ timing: { heartbeatMs: 10 } });
    const cookie = await hub.setupOwner();
    await hub.client(cookie);
    hub.running.db.exec('DROP TABLE pairing_codes');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await hub.api('GET', '/api/auth/status', { cookie })).status).toBe(200);
  });

  it('heartbeat drops a client that stops answering pings', async () => {
    hub = await startHub({ timing: { heartbeatMs: 15 } });
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    (client.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const clients = (hub.running.hub as unknown as { clients: Set<unknown> }).clients;
    await until(() => clients.size === 0, 'client dropped');
  });

  it('heartbeat marks a silent daemon offline', async () => {
    hub = await startHub({ timing: { heartbeatMs: 15 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    (daemon.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await until(() => hub.running.store.getMachine(machineId)?.online === false, 'offline');
  });

  it('expired login sessions lose the WebSocket and REST access', async () => {
    let now = Date.now();
    hub = await startHub({ now: () => new Date(now), timing: { heartbeatMs: 15 } });
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await client.closed()).toBe(4401);
    expect((await hub.api('GET', '/api/projects', { cookie })).status).toBe(401);
  });

  it('deleting a user closes their sockets', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    const client = await hub.client(member.cookie);
    await hub.api('DELETE', `/api/users/${member.id}`, { cookie: owner });
    expect(await client.closed()).toBe(4401);
    expect((await hub.api('GET', '/api/projects', { cookie: member.cookie })).status).toBe(401);
  });
});

describe('protocol sanity', () => {
  it('test daemon messages are valid DaemonToHub', () => {
    expect(DaemonToHub.safeParse(hello()).success).toBe(true);
    expect(DaemonToHub.safeParse({ type: 'session.runtime', session: runtime('x') }).success).toBe(
      true,
    );
    expect(
      DaemonToHub.safeParse({ type: 'approval.requested', approval: approval('x') }).success,
    ).toBe(true);
  });
});
