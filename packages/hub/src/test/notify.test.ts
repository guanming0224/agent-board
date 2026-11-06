// 合併通知與「等你」上限：真的 hub、假 daemon。等待時間縮短，驗送出的次數與內容。
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_START_DETAIL, type SessionStatus } from '@agent-board/protocol';
import {
  approval,
  connect,
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

/** 一般 400 ms、權限 40 ms、最多 1.5 秒（測試機忙的時候，事件之間也不會超過一般的等待）。 */
const WINDOWS = { notifyWindowMs: 400, notifyPermissionWindowMs: 40, notifyMaxWindowMs: 1500 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Setup {
  cookie: string;
  daemon: Peer;
  machineId: string;
  sessions: string[];
}

async function setup(count: number, timing = WINDOWS): Promise<Setup> {
  hub = await startHub({ timing });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie);
  const sessions: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec({ name: `S${i + 1}` }), machineId },
    });
    const create = await daemon.next('session.create');
    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(res.body.id),
    });
    await until(() => hub.running.store.getSession(res.body.id)?.status === 'running', 'running');
    sessions.push(res.body.id);
  }
  await hub.api('POST', '/api/push/subscriptions', {
    cookie,
    body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
  });
  return { cookie, daemon, machineId, sessions };
}

const to = (
  daemon: Peer,
  sessionId: string,
  status: SessionStatus,
  over: Parameters<typeof runtime>[1] = {},
) => daemon.send({ type: 'session.runtime', session: runtime(sessionId, { status, ...over }) });

const settled = async (sessionId: string, status: SessionStatus) =>
  until(() => hub.running.store.getSession(sessionId)?.status === status, status);

const payloads = () =>
  hub.push.sent.map((p) => JSON.parse(p.payload) as Record<string, unknown> & { kind?: string });

describe('coalesced notifications (default on)', () => {
  it('several sessions within the window: one push listing all of them, after the window', async () => {
    const t = await setup(3);
    to(t.daemon, t.sessions[0]!, 'waiting_input', { lastLines: ['SECRET_LINE'] });
    await settled(t.sessions[0]!, 'waiting_input');
    to(t.daemon, t.sessions[1]!, 'error');
    await settled(t.sessions[1]!, 'error');
    await sleep(60);
    expect(hub.push.sent).toHaveLength(0);
    to(t.daemon, t.sessions[2]!, 'plan_review');
    await until(() => hub.push.sent.length === 1, 'summary', 2000);
    await sleep(250);
    expect(hub.push.sent).toHaveLength(1);
    const [summary] = payloads();
    expect(summary).toMatchObject({ kind: 'summary', count: 3, more: 0, autoContinued: [] });
    const items = summary!.items as { name: string; status: string }[];
    // 這一批觸發的，新的在前。
    expect(items.map((i) => [i.name, i.status])).toEqual([
      ['S3', 'plan_review'],
      ['S2', 'error'],
      ['S1', 'waiting_input'],
    ]);
    // 沒有終端機內容。
    expect(hub.push.sent[0]!.payload).not.toContain('SECRET_LINE');
  });

  it('things resolved before the window closes are left out; nothing left means no push', async () => {
    const t = await setup(2);
    to(t.daemon, t.sessions[0]!, 'waiting_input');
    to(t.daemon, t.sessions[1]!, 'waiting_input');
    await settled(t.sessions[1]!, 'waiting_input');
    to(t.daemon, t.sessions[0]!, 'running');
    await settled(t.sessions[0]!, 'running');
    await until(() => hub.push.sent.length === 1, 'summary', 2000);
    expect(payloads()[0]).toMatchObject({ count: 1, items: [{ name: 'S2' }] });

    to(t.daemon, t.sessions[0]!, 'waiting_input');
    await settled(t.sessions[0]!, 'waiting_input');
    to(t.daemon, t.sessions[0]!, 'running');
    to(t.daemon, t.sessions[1]!, 'running');
    await settled(t.sessions[1]!, 'running');
    await sleep(700);
    expect(hub.push.sent).toHaveLength(1);
  });

  it('a permission prompt goes out on the short window', async () => {
    const t = await setup(1, { ...WINDOWS, notifyWindowMs: 5000, notifyMaxWindowMs: 10_000 });
    const started = Date.now();
    to(t.daemon, t.sessions[0]!, 'waiting_permission');
    await until(() => hub.push.sent.length === 1, 'summary', 2000);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(payloads()[0]).toMatchObject({
      kind: 'summary',
      items: [{ name: 'S1', status: 'waiting_permission' }],
    });
  });

  it('a dangerous command on a running session is listed as waiting for permission', async () => {
    const t = await setup(2);
    t.daemon.send({
      type: 'approval.requested',
      approval: approval(t.sessions[0]!, { kind: 'danger' }),
    });
    to(t.daemon, t.sessions[1]!, 'waiting_input');
    await until(() => hub.push.sent.length === 1, 'summary', 2000);
    expect(payloads()[0]).toMatchObject({
      count: 2,
      items: [{ name: 'S1', status: 'waiting_permission' }, { name: 'S2' }],
    });
  });

  it('sessions that just started or resumed with nothing new are not counted or pushed', async () => {
    const t = await setup(2);
    to(t.daemon, t.sessions[0]!, 'waiting_input', { statusDetail: IDLE_START_DETAIL });
    await settled(t.sessions[0]!, 'waiting_input');
    await sleep(600);
    expect(hub.push.sent).toHaveLength(0);
    to(t.daemon, t.sessions[1]!, 'stuck');
    await until(() => hub.push.sent.length === 1, 'summary', 2000);
    expect(payloads()[0]).toMatchObject({ count: 1, items: [{ name: 'S2', status: 'stuck' }] });
  });

  it('respects notifications.enabled and quiet hours at send time', async () => {
    const t = await setup(1);
    to(t.daemon, t.sessions[0]!, 'waiting_input');
    await settled(t.sessions[0]!, 'waiting_input');
    await hub.api('PATCH', '/api/settings', {
      cookie: t.cookie,
      body: { notifications: { enabled: false, quietHours: null, coalesce: true } },
    });
    await sleep(600);
    expect(hub.push.sent).toHaveLength(0);
  });

  it('turning coalescing off sends what is waiting now, then goes back to one push per event', async () => {
    const t = await setup(2);
    to(t.daemon, t.sessions[0]!, 'waiting_input');
    await settled(t.sessions[0]!, 'waiting_input');
    await perEventPush(hub, t.cookie);
    await until(() => hub.push.sent.length === 1, 'flushed');
    expect(payloads()[0]).toMatchObject({ kind: 'summary', count: 1 });
    to(t.daemon, t.sessions[1]!, 'error');
    await settled(t.sessions[1]!, 'error');
    await hub.running.hub.pushesSettled();
    expect(hub.push.sent).toHaveLength(2);
    // 舊格式：一個 session 一則。
    expect(payloads()[1]).toEqual({
      sessionId: t.sessions[1],
      name: 'S2',
      status: 'error',
      at: expect.any(String),
    });
  });
});

describe('waiting limit', () => {
  const setLimit = (cookie: string, waitingLimit: number, coalesce = true) =>
    hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: true, quietHours: null, coalesce, waitingLimit } },
    });

  it('board.state carries the limit; changing it is broadcast to everyone', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const member = await hub.createMember(cookie);
    const first = await connect(`ws://127.0.0.1:${hub.port}/ws/client`, {
      cookie: member.cookie,
      origin: hub.url,
    });
    expect(await first.next('board.state')).toMatchObject({ waitingLimit: 3 });
    await setLimit(cookie, 7);
    expect(await first.next('board.waitingLimit')).toMatchObject({ waitingLimit: 7 });
    const second = await connect(`ws://127.0.0.1:${hub.port}/ws/client`, {
      cookie: member.cookie,
      origin: hub.url,
    });
    expect(await second.next('board.state')).toMatchObject({ waitingLimit: 7 });
    first.close();
    second.close();
  });

  it('crossing the limit marks one summary as over the limit, once per crossing', async () => {
    const t = await setup(4);
    await setLimit(t.cookie, 1);
    to(t.daemon, t.sessions[0]!, 'waiting_input');
    await until(() => hub.push.sent.length === 1, 'first');
    expect(payloads()[0]!.overLimit).toBeUndefined();
    to(t.daemon, t.sessions[1]!, 'waiting_input');
    await until(() => hub.push.sent.length === 2, 'crossed');
    expect(payloads()[1]).toMatchObject({ count: 2, overLimit: 1 });
    // 還在上限以上：再多一個不再標一次。
    to(t.daemon, t.sessions[2]!, 'waiting_input');
    await until(() => hub.push.sent.length === 3, 'third');
    expect(payloads()[2]!.overLimit).toBeUndefined();
    // 回到上限以內再超過：重新算一次。
    to(t.daemon, t.sessions[1]!, 'running');
    to(t.daemon, t.sessions[2]!, 'running');
    await settled(t.sessions[2]!, 'running');
    to(t.daemon, t.sessions[3]!, 'error');
    await until(() => hub.push.sent.length === 4, 'crossed again');
    expect(payloads()[3]).toMatchObject({ count: 2, overLimit: 1 });
  });

  it('with coalescing off: one separate overload push per crossing', async () => {
    const t = await setup(3);
    await setLimit(t.cookie, 1, false);
    to(t.daemon, t.sessions[0]!, 'waiting_input');
    to(t.daemon, t.sessions[1]!, 'waiting_input');
    await settled(t.sessions[1]!, 'waiting_input');
    to(t.daemon, t.sessions[2]!, 'waiting_input');
    await settled(t.sessions[2]!, 'waiting_input');
    await hub.running.hub.pushesSettled();
    const overload = payloads().filter((p) => p.kind === 'overload');
    expect(overload).toEqual([{ kind: 'overload', count: 2, limit: 1, at: expect.any(String) }]);
    expect(payloads().filter((p) => p.kind === undefined)).toHaveLength(3);
  });

  it('lowering the limit below the current count counts as a crossing', async () => {
    const t = await setup(2);
    await setLimit(t.cookie, 5, false);
    to(t.daemon, t.sessions[0]!, 'waiting_input');
    to(t.daemon, t.sessions[1]!, 'error');
    await settled(t.sessions[1]!, 'error');
    await setLimit(t.cookie, 1, false);
    await hub.running.hub.pushesSettled();
    expect(payloads().filter((p) => p.kind === 'overload')).toHaveLength(1);
  });
});
