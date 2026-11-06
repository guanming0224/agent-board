// 額度恢復後自動接續：真的 hub、假 daemon、可調的時鐘。驗排定、只送一次、使用者打字就取消、
// 讀不出重置時間就不排、重啟後還在、送的字不算使用者輸入。
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_CONTINUE_PROMPT, type SessionStatus } from '@agent-board/protocol';
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

const LIMIT = "You've hit your limit · resets 3pm (UTC)";
/** 進入限流的時間：當天 14:00 UTC，重置 15:00，預定 15:01 送。 */
const LIMITED_AT = '2026-11-06T14:00:00.000Z';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMING = { handoffEnterDelayMs: 20, heartbeatMs: 40, notifyWindowMs: 60 };

let now = new Date(LIMITED_AT);

interface Setup {
  cookie: string;
  daemon: Peer;
  token: string;
  machineId: string;
  id: string;
}

async function setup(options: { autoContinue?: boolean } = {}): Promise<Setup> {
  now = new Date(LIMITED_AT);
  hub = await startHub({ now: () => now, timing: TIMING });
  const cookie = await hub.setupOwner();
  if (options.autoContinue !== false) await setAuto(cookie, true);
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  const res = await hub.api('POST', '/api/sessions', {
    cookie,
    body: { ...spec({ name: 'BD1' }), machineId },
  });
  const create = await daemon.next('session.create');
  daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { statusSince: '2026-11-06T13:00:00.000Z' }),
  });
  await until(() => status(res.body.id) === 'running', 'running');
  return { cookie, daemon, token, machineId, id: res.body.id };
}

const setAuto = (cookie: string, on: boolean) =>
  hub.api('PATCH', '/api/settings', { cookie, body: { autoContinue: on } });

const status = (id: string) => hub.running.store.getSession(id)?.status;
const entry = (id: string) => hub.running.store.getSession(id)?.autoContinue ?? null;

const report = (
  daemon: Peer,
  id: string,
  state: SessionStatus,
  over: Parameters<typeof runtime>[1] = {},
) => daemon.send({ type: 'session.runtime', session: runtime(id, { status: state, ...over }) });

/** 撞到額度：先是 StopFailure（沒時間），再是畫面上帶重置時間的訊息（daemon 補 detail）。 */
const hitLimit = async (daemon: Peer, id: string, detail = LIMIT, since = LIMITED_AT) => {
  report(daemon, id, 'rate_limited', { statusDetail: '429 Too Many Requests', statusSince: since });
  await until(() => status(id) === 'rate_limited', 'rate_limited');
  report(daemon, id, 'rate_limited', { statusDetail: detail, statusSince: since });
  await until(() => hub.running.store.getSession(id)?.statusDetail === detail, 'detail refined');
};

const inputs = (daemon: Peer, id: string) =>
  daemon
    .of('terminal.input')
    .filter((m) => m.sessionId === id)
    .map((m) => m.data);

describe('auto-continue after the usage limit resets', () => {
  it('schedules at reset + 60 s, waits for the input box, sends once, and is not user input', async () => {
    const t = await setup();
    await hitLimit(t.daemon, t.id);
    expect(entry(t.id)).toEqual({
      state: 'scheduled',
      at: '2026-11-06T15:01:00.000Z',
      resetAt: '2026-11-06T15:00:00.000Z',
      limitSince: LIMITED_AT,
      reason: null,
    });
    // 時間還沒到。
    now = new Date('2026-11-06T15:00:30.000Z');
    await sleep(120);
    expect(inputs(t.daemon, t.id)).toEqual([]);

    // 時間到了，但畫面上是額度選單（沒有輸入框）：不送。
    now = new Date('2026-11-06T15:02:00.000Z');
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: LIMIT,
      statusSince: LIMITED_AT,
      inputReady: false,
    });
    await sleep(120);
    expect(inputs(t.daemon, t.id)).toEqual([]);

    // 輸入框出現：送文字，再按 Enter。
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: LIMIT,
      statusSince: LIMITED_AT,
      inputReady: true,
    });
    await until(() => inputs(t.daemon, t.id).length === 2, 'text and enter');
    expect(inputs(t.daemon, t.id)).toEqual([AUTO_CONTINUE_PROMPT, '\r']);
    expect(entry(t.id)).toMatchObject({ state: 'sent' });
    report(t.daemon, t.id, 'running', { statusSince: '2026-11-06T15:02:01.000Z' });
    await until(() => status(t.id) === 'running', 'running again');

    // 送字記成系統（沒有使用者）。
    const rows = hub.running.db
      .prepare("SELECT user_id, detail FROM audit_log WHERE action = 'terminal.input'")
      .all() as { user_id: string | null; detail: string }[];
    expect(rows).toEqual([{ user_id: null, detail: AUTO_CONTINUE_PROMPT }]);
    const events = hub.running.store
      .listEvents(t.id)
      .filter((e) => e.type === 'auto_continue.sent');
    expect(events).toHaveLength(1);

    // 同一次限流的訊息再來一次：不再送。
    report(t.daemon, t.id, 'rate_limited', { statusDetail: LIMIT, statusSince: LIMITED_AT });
    await sleep(150);
    expect(inputs(t.daemon, t.id)).toHaveLength(2);
  });

  it('the coalesced push says it auto-continued', async () => {
    const t = await setup();
    await hub.api('POST', '/api/push/subscriptions', {
      cookie: t.cookie,
      body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    });
    await hitLimit(t.daemon, t.id);
    now = new Date('2026-11-06T15:05:00.000Z');
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: LIMIT,
      statusSince: LIMITED_AT,
      inputReady: true,
    });
    await until(() => entry(t.id)?.state === 'sent', 'sent');
    report(t.daemon, t.id, 'running', { statusSince: '2026-11-06T15:05:01.000Z' });
    await until(() => hub.push.sent.length === 1, 'summary', 2000);
    const payload = JSON.parse(hub.push.sent[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: 'summary',
      count: 0,
      autoContinued: [{ sessionId: t.id, name: 'BD1' }],
    });
  });

  it('a waiting_input session (e.g. resumed after a daemon restart) gets it too', async () => {
    const t = await setup();
    await hitLimit(t.daemon, t.id);
    report(t.daemon, t.id, 'waiting_input', { statusSince: '2026-11-06T14:30:00.000Z' });
    await until(() => status(t.id) === 'waiting_input', 'waiting');
    expect(entry(t.id)?.state).toBe('scheduled');
    now = new Date('2026-11-06T15:01:30.000Z');
    await until(() => inputs(t.daemon, t.id).length === 2, 'sent');
  });

  it('anything the user types in the meantime cancels it', async () => {
    const t = await setup();
    await hitLimit(t.daemon, t.id);
    const client = await hub.client(t.cookie);
    client.send({ type: 'terminal.input', sessionId: t.id, data: 'h' });
    await until(() => entry(t.id)?.state === 'cancelled', 'cancelled');
    expect(entry(t.id)?.reason).toBe('user_input');
    now = new Date('2026-11-06T16:00:00.000Z');
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: LIMIT,
      statusSince: LIMITED_AT,
      inputReady: true,
    });
    await sleep(150);
    // 只有使用者自己的那個字。
    expect(inputs(t.daemon, t.id)).toEqual(['h']);
  });

  it('the session moving on by itself (Claude Code continued, typed on the machine) cancels it', async () => {
    const t = await setup();
    await hitLimit(t.daemon, t.id);
    report(t.daemon, t.id, 'running', { statusSince: '2026-11-06T14:10:00.000Z' });
    await until(() => entry(t.id)?.state === 'cancelled', 'cancelled');
    expect(entry(t.id)?.reason).toBe('resumed');
  });

  it('unknown reset time: nothing is scheduled (no guessing)', async () => {
    const t = await setup();
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: '429 Too Many Requests',
      statusSince: LIMITED_AT,
    });
    await until(() => status(t.id) === 'rate_limited', 'rate_limited');
    await sleep(100);
    expect(entry(t.id)).toBeNull();
    now = new Date('2026-11-07T14:00:00.000Z');
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: '429 Too Many Requests',
      statusSince: LIMITED_AT,
      inputReady: true,
    });
    await sleep(150);
    expect(inputs(t.daemon, t.id)).toEqual([]);
  });

  it('Claude Code’s own automatic continue is left alone', async () => {
    const t = await setup();
    await hitLimit(
      t.daemon,
      t.id,
      'Usage limit reached · continuing automatically at 3pm · resets 3pm (UTC)',
    );
    expect(entry(t.id)).toBeNull();
  });

  it('setting off (the default): nothing is scheduled; turning it off cancels what was scheduled', async () => {
    const t = await setup({ autoContinue: false });
    await hitLimit(t.daemon, t.id);
    expect(entry(t.id)).toBeNull();
    // 打開：已經在限流、知道時間的補排。
    await setAuto(t.cookie, true);
    await until(() => entry(t.id)?.state === 'scheduled', 'scheduled');
    await setAuto(t.cookie, false);
    expect(entry(t.id)).toMatchObject({ state: 'cancelled', reason: 'setting_off' });
    now = new Date('2026-11-06T16:00:00.000Z');
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: LIMIT,
      statusSince: LIMITED_AT,
      inputReady: true,
    });
    await sleep(150);
    expect(inputs(t.daemon, t.id)).toEqual([]);
  });

  it('a hub restart keeps the schedule and still sends once the session is back', async () => {
    const t = await setup();
    await hitLimit(t.daemon, t.id);
    const { dbPath } = hub;
    await hub.running.close();
    now = new Date('2026-11-06T15:10:00.000Z');
    hub = await startHub({ dbPath, now: () => now, timing: TIMING });
    expect(entry(t.id)).toMatchObject({ state: 'scheduled', at: '2026-11-06T15:01:00.000Z' });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    const daemon = await hub.daemon(t.token);
    daemon.send(
      hello({
        sessions: [
          runtime(t.id, {
            status: 'rate_limited',
            statusDetail: LIMIT,
            statusSince: LIMITED_AT,
            inputReady: true,
          }),
        ],
      }),
    );
    await daemon.next('hub.welcome');
    await until(() => inputs(daemon, t.id).length === 2, 'sent after restart');
    expect(entry(t.id)?.state).toBe('sent');
  });

  it('a new limit with the same reset right after our continue is not retried (no loop)', async () => {
    const t = await setup();
    await hitLimit(t.daemon, t.id);
    now = new Date('2026-11-06T15:01:30.000Z');
    report(t.daemon, t.id, 'rate_limited', {
      statusDetail: LIMIT,
      statusSince: LIMITED_AT,
      inputReady: true,
    });
    await until(() => entry(t.id)?.state === 'sent', 'sent');
    report(t.daemon, t.id, 'running', { statusSince: '2026-11-06T15:01:31.000Z' });
    await until(() => status(t.id) === 'running', 'running');
    // 訊息裡的重置時間已經過了（時鐘差、額度其實還沒回來）：不排，不會一直重送。
    await hitLimit(
      t.daemon,
      t.id,
      "You've hit your limit · resets Nov 6, 3pm (UTC)",
      '2026-11-06T15:01:40.000Z',
    );
    expect(entry(t.id)?.state).toBe('sent');
    // 下一次（新的重置時間）照常排。
    await hitLimit(
      t.daemon,
      t.id,
      "You've hit your limit · resets 8pm (UTC)",
      '2026-11-06T15:30:00.000Z',
    );
    expect(entry(t.id)).toMatchObject({ state: 'scheduled', at: '2026-11-06T20:01:00.000Z' });
  });
});
