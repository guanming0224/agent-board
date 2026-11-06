// 交接規則：真的 hub、假 daemon。驗送進 PTY 的內容、順序、狀態檢查、防迴圈與 audit。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { HandoffRule, Session } from '@agent-board/protocol';
import {
  containsMarker,
  HandoffEngine,
  handoffMessage,
  markerSummary,
  matchesFilePattern,
  oneSentence,
  roundOf,
  type HandoffDeps,
} from '../handoff';
import type { Store } from '../store';
import {
  hello,
  PASSWORD,
  type Peer,
  runtime,
  spec,
  startHub,
  until,
  type TestHub,
  perEventPush,
} from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

interface Board {
  cookie: string;
  daemon: Peer;
  token: string;
  machineId: string;
  teamId: string;
  a: string;
  b: string;
  c: string;
}

const LONG_REPLY = `Fixed the login redirect and added a regression test. ${'Secret transcript detail. '.repeat(200)}`;

async function board(): Promise<Board> {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  const start = async (name: string) => {
    const res = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec({ name }), machineId },
    });
    const create = await daemon.next('session.create');
    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(res.body.id, { status: 'waiting_input', branch: `ab/${name}` }),
    });
    await until(() => sessionStatus(res.body.id) === 'waiting_input', 'session started');
    return res.body.id as string;
  };
  const a = await start('a');
  const b = await start('b');
  const c = await start('c');
  const team = await hub.api('POST', '/api/teams', {
    cookie,
    body: { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
  });
  return { cookie, daemon, token, machineId, teamId: team.body.id, a, b, c };
}

function sessionStatus(id: string): string | undefined {
  const row = hub.running.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as
    { status: string } | undefined;
  return row?.status;
}

const addRule = async (
  { cookie, teamId }: Board,
  from: string,
  to: string,
  trigger = 'on_done',
  over: { enabled?: boolean; filePattern?: string; maxRounds?: number; marker?: string } = {},
) => {
  const res = await hub.api('POST', `/api/teams/${teamId}/handoff-rules`, {
    cookie,
    body: {
      fromSessionId: from,
      trigger,
      action: {
        toSessionId: to,
        filePattern: over.filePattern,
        maxRounds: over.maxRounds,
        marker: over.marker,
      },
      enabled: over.enabled ?? true,
    },
  });
  expect(res.status).toBe(200);
  return res.body.id as string;
};

const hookEvent = (daemon: Peer, sessionId: string, payload: object) =>
  daemon.send({
    type: 'session.event',
    event: {
      id: randomUUID(),
      sessionId,
      type: 'hook',
      payload,
      at: new Date().toISOString(),
    },
  });

const stop = (daemon: Peer, sessionId: string, message = 'Finished the requested work here.') =>
  hookEvent(daemon, sessionId, { event: 'Stop', last_assistant_message: message });

const fileChanged = (daemon: Peer, sessionId: string, path: string) =>
  daemon.send({
    type: 'session.event',
    event: {
      id: randomUUID(),
      sessionId,
      type: 'file.changed',
      payload: { path },
      at: new Date().toISOString(),
    },
  });

const setStatus = async (daemon: Peer, id: string, status: string, over: object = {}) => {
  daemon.send({
    type: 'session.runtime',
    session: runtime(id, { status: status as never, branch: 'ab/x', ...over }),
  });
  await until(() => sessionStatus(id) === status, `status ${status}`);
};

const inputsTo = (daemon: Peer, sessionId: string) =>
  daemon.messages.filter((m) => m.type === 'terminal.input' && m.sessionId === sessionId);

const auditActions = () =>
  (
    hub.running.db.prepare('SELECT action FROM audit_log ORDER BY rowid').all() as {
      action: string;
    }[]
  ).map((r) => r.action);

const auditDetail = (action: string) => {
  const row = hub.running.db
    .prepare('SELECT session_id, user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
    .get(action) as { session_id: string; user_id: string | null; detail: string } | undefined;
  return row;
};

const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

const markDone = async ({ cookie }: Pick<Board, 'cookie'>, id: string) => {
  const res = await hub.api('PATCH', `/api/sessions/${id}`, { cookie, body: { markDone: true } });
  expect(res.status).toBe(200);
};

describe('handoff message', () => {
  it('keeps one sentence, strips control characters and caps the length', () => {
    expect(oneSentence('Done. Fixed the login bug. And then much more.')).toBe(
      'Done. Fixed the login bug.',
    );
    expect(oneSentence('修好登入流程了。另外還做了別的事情。')).toBe(
      '修好登入流程了。另外還做了別的事情。',
    );
    expect(oneSentence('## Result\n\nline\x1b[31m red\x1b[0m\r\nmore')).toBe(
      'Result line red more',
    );
    expect(oneSentence('edit package.json then run tests')).toBe(
      'edit package.json then run tests',
    );
    expect([...oneSentence('字'.repeat(1000))].length).toBe(241);
  });

  it('contains only the summary, files and branch and cannot start a TUI command', () => {
    const message = handoffMessage({
      summary: '/clear everything',
      files: ['/r/a.ts', '/r/b\r\n.ts'],
      branch: 'ab/x',
    });
    expect(message).toBe(
      '[Handoff] Summary: /clear everything | Detected file edits: /r/a.ts, /r/b .ts | Branch: ab/x',
    );
    expect(handoffMessage({ summary: '', files: [], branch: null })).toBe(
      '[Handoff] Summary: none reported | Detected file edits: none (edits made through shell commands are not tracked) | Branch: unknown',
    );
    const many = Array.from({ length: 25 }, (_, i) => `/f${i}`);
    expect(handoffMessage({ summary: 's', files: many, branch: 'b' })).toContain('(+5 more)');
  });

  it('matches file patterns against the end of the path', () => {
    expect(matchesFilePattern(undefined, '/r/a.ts')).toBe(true);
    expect(matchesFilePattern('*.sql', '/r/db/a.sql')).toBe(true);
    expect(matchesFilePattern('*.sql', '/r/db/a.sql.bak')).toBe(false);
    expect(matchesFilePattern('src/**', '/home/x/r/src/a/b.ts')).toBe(true);
    expect(matchesFilePattern('src/*.ts', '/r/src/a/b.ts')).toBe(false);
    expect(matchesFilePattern('**/b.ts', '/r/src/a/b.ts')).toBe(true);
    expect(matchesFilePattern('a?.ts', '/r/ab.ts')).toBe(true);
    expect(matchesFilePattern('a.ts', '/r/axts')).toBe(false);
  });
});

describe('on_done', () => {
  it('a finished turn alone does not fire; marking done does, with the last reply', async () => {
    const t = await board();
    await setStatus(t.daemon, t.a, 'running', { branch: 'ab/source' });
    await addRule(t, t.a, t.b);
    t.daemon.clear();
    fileChanged(t.daemon, t.a, '/r/login.ts');
    fileChanged(t.daemon, t.a, '/r/login.test.ts');
    fileChanged(t.daemon, t.a, '/r/login.ts');
    stop(t.daemon, t.a, 'Should I also change the signup page?');
    await setStatus(t.daemon, t.a, 'waiting_input', { branch: 'ab/source' });
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
    expect(auditActions()).not.toContain('handoff.fired');

    stop(t.daemon, t.a, LONG_REPLY);
    await pause(30);
    await markDone(t, t.a);

    await until(() => inputsTo(t.daemon, t.b).length === 2, 'text and enter');
    const [text, enter] = inputsTo(t.daemon, t.b);
    expect(text!.data).toBe(
      '[Handoff] Summary: Fixed the login redirect and added a regression test. | Detected file edits: /r/login.test.ts, /r/login.ts | Branch: ab/source',
    );
    expect(enter!.data).toBe('\r');
    expect(String(text!.data)).not.toContain('Secret transcript');
    expect(String(text!.data)).not.toMatch(/\r|\n/);

    const fired = auditDetail('handoff.fired')!;
    expect(fired.session_id).toBe(t.a);
    expect(fired.user_id).toBeNull();
    expect(JSON.parse(fired.detail)).toMatchObject({ toSessionId: t.b, trigger: 'on_done' });
    await until(() => auditActions().includes('terminal.input'), 'input audit');
    expect(auditDetail('terminal.input')!.session_id).toBe(t.b);

    // 畫布的交接動畫從事件讀摘要（一句，和送出的相同），不是完整訊息。
    const events = await hub.api('GET', `/api/sessions/${t.a}/events`, { cookie: t.cookie });
    const firedEvent = events.body.find((e: { type: string }) => e.type === 'handoff.fired');
    expect(firedEvent.payload).toMatchObject({
      fromSessionId: t.a,
      toSessionId: t.b,
      summary: 'Fixed the login redirect and added a regression test.',
    });
  });

  it('marked done stays done while idle, and clears once the same process starts working again', async () => {
    const t = await board();
    await setStatus(t.daemon, t.a, 'waiting_input');
    await markDone(t, t.a);
    await until(() => sessionStatus(t.a) === 'done', 'marked done');

    // 同一個閒置狀態再回報一次（例如重連），不能把完成洗掉。
    t.daemon.send({ type: 'session.runtime', session: runtime(t.a, { status: 'waiting_input' }) });
    await pause();
    expect(sessionStatus(t.a)).toBe('done');

    // 送了 /clear 又下指令：daemon 回報新的 running。
    const later = new Date(Date.now() + 1000).toISOString();
    await setStatus(t.daemon, t.a, 'running', { statusSince: later });
    expect(sessionStatus(t.a)).toBe('running');
  });

  it('fires on PTY exit 0, once, even if already marked done', async () => {
    const t = await board();
    await addRule(t, t.a, t.b);
    await addRule(t, t.c, t.b);
    t.daemon.clear();
    stop(t.daemon, t.a, 'Finished the part from session A.');
    await pause(30);
    await setStatus(t.daemon, t.a, 'done', { endedAt: new Date().toISOString() });
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'exit 0 fired');
    expect(inputsTo(t.daemon, t.b)[0]!.data).toContain('Finished the part from session A.');

    await setStatus(t.daemon, t.b, 'running');
    await setStatus(t.daemon, t.b, 'waiting_input');
    t.daemon.clear();
    await markDone(t, t.c);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'mark done fired');
    t.daemon.send({
      type: 'session.runtime',
      session: runtime(t.c, { status: 'done', endedAt: new Date().toISOString() }),
    });
    await pause();
    expect(auditActions().filter((a) => a === 'handoff.fired')).toHaveLength(2);
  });

  it('says so plainly when there is no reply or detected edit to report', async () => {
    const t = await board();
    await addRule(t, t.a, t.b);
    t.daemon.clear();
    await markDone(t, t.a);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'fired');
    expect(inputsTo(t.daemon, t.b)[0]!.data).toBe(
      '[Handoff] Summary: none reported | Detected file edits: none (edits made through shell commands are not tracked) | Branch: ab/a',
    );
  });

  it('does not fire when the person stops a session that then exits 0', async () => {
    const t = await board();
    await addRule(t, t.a, t.b);
    t.daemon.clear();
    await hub.api('POST', `/api/sessions/${t.a}/stop`, { cookie: t.cookie });
    await setStatus(t.daemon, t.a, 'done', { endedAt: new Date().toISOString() });
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
    expect(auditActions()).not.toContain('handoff.fired');
  });

  it('does not fire for a queued session that is cancelled or marked done', async () => {
    const t = await board();
    await hub.api('PATCH', '/api/settings', {
      cookie: t.cookie,
      body: { quotaGuards: { denyReadPaths: [], maxConcurrentSessions: 3 } },
    });
    const queue = async (name: string) =>
      (
        await hub.api('POST', '/api/sessions', {
          cookie: t.cookie,
          body: { ...spec({ name }), machineId: t.machineId },
        })
      ).body.id as string;
    const cancelled = await queue('q1');
    const marked = await queue('q2');
    expect(sessionStatus(cancelled)).toBe('queued');
    await addRule(t, cancelled, t.b);
    await addRule(t, marked, t.b);
    t.daemon.clear();
    await hub.api('POST', `/api/sessions/${cancelled}/stop`, { cookie: t.cookie });
    await markDone(t, marked);
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
  });

  it('keeps the last reply across a hub restart', async () => {
    const t = await board();
    const { dbPath } = hub;
    await addRule(t, t.a, t.b);
    fileChanged(t.daemon, t.a, '/r/kept.ts');
    stop(t.daemon, t.a, 'Reply written before the restart.');
    await until(
      () =>
        (
          hub.running.db
            .prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'file.changed'")
            .get() as { n: number }
        ).n === 1 &&
        (
          hub.running.db
            .prepare(
              "SELECT COUNT(*) AS n FROM session_events WHERE payload LIKE '%before the restart%'",
            )
            .get() as { n: number }
        ).n === 1,
      'events stored',
    );
    const machineToken = t.token;
    await hub.running.close();
    hub = await startHub({ dbPath });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const daemon = await hub.daemon(machineToken);
    daemon.send(
      hello({
        sessions: [
          runtime(t.a, { status: 'waiting_input', branch: 'ab/a' }),
          runtime(t.b, { status: 'waiting_input' }),
        ],
      }),
    );
    await daemon.next('hub.welcome');
    await until(() => sessionStatus(t.b) === 'waiting_input', 'reconnected');
    await markDone({ ...t, cookie }, t.a);
    await until(() => inputsTo(daemon, t.b).length === 2, 'fired after restart');
    expect(inputsTo(daemon, t.b)[0]!.data).toBe(
      '[Handoff] Summary: Reply written before the restart. | Detected file edits: /r/kept.ts | Branch: ab/a',
    );
  });

  it('holds Enter until the delay has passed', async () => {
    const t = await board();
    await addRule(t, t.a, t.b);
    t.daemon.clear();
    await markDone(t, t.a);
    await until(() => inputsTo(t.daemon, t.b).length === 1, 'text');
    const textAt = Date.now();
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'enter');
    expect(Date.now() - textAt).toBeGreaterThanOrEqual(10);
  });

  it('ignores disabled rules', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_done', { enabled: false });
    t.daemon.clear();
    await markDone(t, t.a);
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
    expect(auditActions()).not.toContain('handoff.fired');
  });

  it('does not press Enter if the target stopped waiting in between', async () => {
    hub = await startHub({ timing: { handoffEnterDelayMs: 200 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const start = async (name: string) => {
      const res = await hub.api('POST', '/api/sessions', {
        cookie,
        body: { ...spec({ name }), machineId },
      });
      const create = await daemon.next('session.create');
      daemon.send({
        type: 'session.created',
        requestId: create.requestId,
        session: runtime(res.body.id, { status: 'waiting_input' }),
      });
      await until(() => sessionStatus(res.body.id) === 'waiting_input');
      return res.body.id as string;
    };
    const a = await start('a');
    const b = await start('b');
    const team = await hub.api('POST', '/api/teams', {
      cookie,
      body: { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
    });
    await addRule({ cookie, teamId: team.body.id } as Board, a, b);
    daemon.clear();
    await markDone({ cookie } as Board, a);
    await until(() => inputsTo(daemon, b).length === 1, 'text');
    await setStatus(daemon, b, 'waiting_permission');
    await until(() => auditActions().includes('handoff.enter_aborted'), 'aborted');
    expect(inputsTo(daemon, b).map((m) => m.data)).not.toContain('\r');
  });

  it('delivers to a target on another machine once it comes back', async () => {
    const t = await board();
    const second = await hub.onlineDaemon(t.cookie);
    const res = await hub.api('POST', '/api/sessions', {
      cookie: t.cookie,
      body: { ...spec({ name: 'far' }), machineId: second.machineId },
    });
    const create = await second.daemon.next('session.create');
    second.daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(res.body.id, { status: 'waiting_input' }),
    });
    await until(() => sessionStatus(res.body.id) === 'waiting_input');
    await addRule(t, t.a, res.body.id);
    second.daemon.close();
    await until(() => sessionStatus(res.body.id) === 'offline', 'offline');
    await markDone(t, t.a);
    await pause();
    const again = await hub.daemon(second.token);
    again.send(hello({ sessions: [runtime(res.body.id, { status: 'waiting_input' })] }));
    await until(() => inputsTo(again, res.body.id).length === 2, 'delivered after reconnect');
    expect(inputsTo(again, res.body.id)[0]!.data).toContain('[Handoff]');
  });

  it('skips a target that has ended and writes why', async () => {
    const t = await board();
    await setStatus(t.daemon, t.b, 'done', { endedAt: new Date().toISOString() });
    await addRule(t, t.a, t.b);
    t.daemon.clear();
    await markDone(t, t.a);
    await until(() => auditActions().includes('handoff.blocked'), 'blocked');
    expect(JSON.parse(auditDetail('handoff.blocked')!.detail).reason).toBe('target_ended');
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
  });

  it('drops queued handoffs when the rule is turned off (team pause)', async () => {
    const t = await board();
    await setStatus(t.daemon, t.b, 'running');
    const ruleId = await addRule(t, t.a, t.b);
    t.daemon.clear();
    await markDone(t, t.a);
    await until(() => auditActions().includes('handoff.fired'), 'fired');
    await hub.api('PATCH', `/api/handoff-rules/${ruleId}`, {
      cookie: t.cookie,
      body: { enabled: false },
    });
    await setStatus(t.daemon, t.b, 'waiting_input');
    await until(() => auditActions().includes('handoff.dropped'), 'dropped');
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
    const events = await hub.api('GET', `/api/sessions/${t.a}/events`, { cookie: t.cookie });
    const dropped = events.body.find((e: { type: string }) => e.type === 'handoff.dropped');
    expect(dropped.payload).toMatchObject({
      fromSessionId: t.a,
      toSessionId: t.b,
      reason: 'rule_disabled',
    });
  });
});

describe('rule audit', () => {
  it('records who created, switched and deleted a rule', async () => {
    const t = await board();
    const id = await addRule(t, t.a, t.b, 'on_done', { enabled: false });
    await hub.api('PATCH', `/api/handoff-rules/${id}`, {
      cookie: t.cookie,
      body: { enabled: true },
    });
    await hub.api('DELETE', `/api/handoff-rules/${id}`, { cookie: t.cookie });
    const created = auditDetail('handoff_rule.create')!;
    const updated = auditDetail('handoff_rule.update')!;
    const deleted = auditDetail('handoff_rule.delete')!;
    expect(created.user_id).not.toBeNull();
    expect(updated.user_id).toBe(created.user_id);
    expect(deleted.user_id).toBe(created.user_id);
    expect(created.session_id).toBe(t.a);
    expect(JSON.parse(created.detail)).toMatchObject({ id, enabled: false });
    expect(JSON.parse(updated.detail)).toMatchObject({ id, enabled: true });
    expect(JSON.parse(deleted.detail)).toMatchObject({ id });
    expect((await hub.api('DELETE', `/api/handoff-rules/${id}`, { cookie: t.cookie })).status).toBe(
      404,
    );
  });
});

describe('loop protection', () => {
  const FILE_RULE = { filePattern: '*.ts' };

  /** 一個改了檔案的回合：on_file 在這時候判斷。 */
  const editTurn = (daemon: Peer, id: string, text = 'Finished this turn of the work.') => {
    fileChanged(daemon, id, '/r/turn.ts');
    stop(daemon, id, text);
  };

  /** 模擬目標收到後做完一個回合。 */
  const finishTurn = async (t: Board, id: string, text: string) => {
    await setStatus(t.daemon, id, 'running');
    await setStatus(t.daemon, id, 'waiting_input');
    editTurn(t.daemon, id, text);
  };

  it('blocks A -> B -> A and says so in audit and events', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', FILE_RULE);
    await addRule(t, t.b, t.a, 'on_file', FILE_RULE);
    t.daemon.clear();
    editTurn(t.daemon, t.a, 'Source A finished its part.');
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'A to B');

    await finishTurn(t, t.b, 'Target B finished its part.');
    await until(() => auditActions().includes('handoff.blocked'), 'loop blocked');
    expect(JSON.parse(auditDetail('handoff.blocked')!.detail)).toMatchObject({
      reason: 'loop',
      fromSessionId: t.b,
      toSessionId: t.a,
    });
    await pause();
    expect(inputsTo(t.daemon, t.a)).toEqual([]);

    const events = await hub.api('GET', `/api/sessions/${t.b}/events`, { cookie: t.cookie });
    expect(events.body.map((e: { type: string }) => e.type)).toContain('handoff.blocked');
  });

  it('blocks longer cycles and allows chains without a repeat', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', FILE_RULE);
    await addRule(t, t.b, t.c, 'on_file', FILE_RULE);
    await addRule(t, t.c, t.a, 'on_file', FILE_RULE);
    t.daemon.clear();
    editTurn(t.daemon, t.a, 'Source A finished its part.');
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'A to B');
    await finishTurn(t, t.b, 'Target B finished its part.');
    await until(() => inputsTo(t.daemon, t.c).length === 2, 'B to C');
    await finishTurn(t, t.c, 'Target C finished its part.');
    await until(() => auditActions().includes('handoff.blocked'), 'cycle blocked');
    expect(inputsTo(t.daemon, t.a)).toEqual([]);
  });

  it('a person typing in the target starts a new chain', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', FILE_RULE);
    await addRule(t, t.b, t.a, 'on_file', FILE_RULE);
    const client = await hub.client(t.cookie);
    t.daemon.clear();
    editTurn(t.daemon, t.a, 'Source A finished its part.');
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'A to B');

    client.send({ type: 'terminal.input', sessionId: t.b, data: 'please go on\r' });
    await until(() => inputsTo(t.daemon, t.b).length === 3, 'typed');
    await finishTurn(t, t.b, 'Target B finished after the person asked.');
    await until(() => inputsTo(t.daemon, t.a).length === 2, 'B to A is allowed now');
    expect(auditActions()).not.toContain('handoff.blocked');
  });

  it('a person marking the target done starts a new chain', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', FILE_RULE);
    await addRule(t, t.b, t.a, 'on_done');
    t.daemon.clear();
    editTurn(t.daemon, t.a, 'Source A finished its part.');
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'A to B');
    await markDone(t, t.b);
    await until(() => inputsTo(t.daemon, t.a).length === 2, 'B to A after mark done');
    expect(auditActions()).not.toContain('handoff.blocked');
  });

  it('rate limits a single rule as a second line of defence', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', FILE_RULE);
    t.daemon.clear();
    for (let i = 0; i < 12; i += 1) editTurn(t.daemon, t.a, `Turn number ${i} finished here.`);
    await until(() => auditActions().includes('handoff.blocked'), 'rate limited');
    expect(JSON.parse(auditDetail('handoff.blocked')!.detail).reason).toBe('rate_limit');
    expect(auditActions().filter((a) => a === 'handoff.fired')).toHaveLength(10);
  });
});

describe('two-way handoff (maxRounds)', () => {
  const MARKER = '[需要實驗]';

  /** 實驗（a）改了 results/ 底下的檔案、回合結束。 */
  const experimentTurn = (t: Board, text = 'Ran the experiment and saved the table.') => {
    fileChanged(t.daemon, t.a, '/r/results/table1.csv');
    stop(t.daemon, t.a, text);
  };
  /** 目標收到交接後做完一個回合。 */
  const work = async (t: Board, id: string) => {
    await setStatus(t.daemon, id, 'running');
    await setStatus(t.daemon, id, 'waiting_input');
  };
  const handoffEvents = async (t: Board, id: string, type: string) => {
    const res = await hub.api('GET', `/api/sessions/${id}/events`, { cookie: t.cookie });
    return (res.body as { type: string; payload: Record<string, unknown> }[])
      .filter((e) => e.type === type)
      .map((e) => e.payload);
  };

  it('goes back and forth until the round limit, then blocks and notifies the person', async () => {
    const t = await board();
    await perEventPush(hub, t.cookie);
    await hub.api('POST', '/api/push/subscriptions', {
      cookie: t.cookie,
      body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    });
    await addRule(t, t.a, t.b, 'on_file', { filePattern: 'results/**', maxRounds: 2 });
    await addRule(t, t.b, t.a, 'on_marker', { marker: MARKER, maxRounds: 2 });
    t.daemon.clear();

    experimentTurn(t);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'EX to WR, round 1');
    await work(t, t.b);
    stop(t.daemon, t.b, `Draft is done. ${MARKER} Need an ablation for section 4, table 2.`);
    await until(() => inputsTo(t.daemon, t.a).length === 2, 'WR to EX, round 2');
    // 摘要從標記開始取。
    expect(inputsTo(t.daemon, t.a)[0]!.data).toContain(
      `Summary: ${MARKER} Need an ablation for section 4, table 2.`,
    );
    await work(t, t.a);
    experimentTurn(t, 'Ablation finished and saved.');
    await until(() => inputsTo(t.daemon, t.b).length === 4, 'EX to WR, round 2');
    await work(t, t.b);
    await hub.running.hub.pushesSettled();
    expect(hub.push.sent.map((p) => p.payload).join()).not.toContain('handoff_round_limit');
    stop(t.daemon, t.b, `${MARKER} One more run with seed 2 please.`);
    await until(() => auditActions().includes('handoff.blocked'), 'round limit');
    await pause();
    expect(inputsTo(t.daemon, t.a)).toHaveLength(2);
    expect(JSON.parse(auditDetail('handoff.blocked')!.detail)).toMatchObject({
      reason: 'round_limit',
      fromSessionId: t.b,
      toSessionId: t.a,
      round: 3,
      maxRounds: 2,
    });

    expect(
      (await handoffEvents(t, t.a, 'handoff.fired')).map((p) => [p.round, p.maxRounds]),
    ).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect((await handoffEvents(t, t.a, 'handoff.delivered')).map((p) => p.round)).toEqual([2]);
    expect((await handoffEvents(t, t.b, 'handoff.delivered')).map((p) => p.round)).toEqual([1, 2]);
    expect(await handoffEvents(t, t.b, 'handoff.blocked')).toMatchObject([
      { reason: 'round_limit', round: 3, maxRounds: 2 },
    ]);

    // 走一般的推播：session 名稱＋原因代碼與輪數，沒有內容。
    await hub.running.hub.pushesSettled();
    const pushed = hub.push.sent.map((p) => JSON.parse(p.payload) as Record<string, unknown>);
    expect(pushed.filter((p) => p.reason === 'handoff_round_limit')).toEqual([
      expect.objectContaining({ sessionId: t.b, name: 'b', maxRounds: 2 }),
    ]);
    expect(JSON.stringify(pushed)).not.toContain('seed 2');
  });

  it('a person typing into either session starts fresh rounds', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', { maxRounds: 1 });
    await addRule(t, t.b, t.a, 'on_marker', { marker: MARKER, maxRounds: 1 });
    const client = await hub.client(t.cookie);
    t.daemon.clear();
    experimentTurn(t);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'EX to WR');
    await work(t, t.b);
    stop(t.daemon, t.b, `${MARKER} more please`);
    await until(() => auditActions().includes('handoff.blocked'), 'limit 1 blocks the way back');
    expect(inputsTo(t.daemon, t.a)).toEqual([]);

    client.send({ type: 'terminal.input', sessionId: t.b, data: 'ok, go ahead\r' });
    await until(() => inputsTo(t.daemon, t.b).length === 3, 'typed');
    await work(t, t.b);
    stop(t.daemon, t.b, `${MARKER} more please, after the person said so`);
    await until(() => inputsTo(t.daemon, t.a).length === 2, 'fresh round after typing');
    const fired = await handoffEvents(t, t.b, 'handoff.fired');
    expect(fired.at(-1)).toMatchObject({ round: 1, maxRounds: 1 });
  });

  it('rules without maxRounds keep blocking A -> B -> A as a loop, with no round fields', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file');
    await addRule(t, t.b, t.a, 'on_marker', { marker: MARKER });
    t.daemon.clear();
    experimentTurn(t);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'A to B');
    await work(t, t.b);
    stop(t.daemon, t.b, `${MARKER} again`);
    await until(() => auditActions().includes('handoff.blocked'), 'loop');
    expect(JSON.parse(auditDetail('handoff.blocked')!.detail).reason).toBe('loop');
    const fired = await handoffEvents(t, t.a, 'handoff.fired');
    expect(fired[0]).not.toHaveProperty('round');
    expect(fired[0]).not.toHaveProperty('maxRounds');
    await hub.running.hub.pushesSettled();
    expect(hub.push.sent.map((p) => p.payload).join()).not.toContain('handoff_round_limit');
  });

  it('the per-rule rate limit still applies to rules with maxRounds', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', { maxRounds: 10 });
    t.daemon.clear();
    for (let i = 0; i < 12; i += 1) experimentTurn(t, `Turn number ${i} finished here.`);
    await until(() => auditActions().includes('handoff.blocked'), 'rate limited');
    expect(JSON.parse(auditDetail('handoff.blocked')!.detail).reason).toBe('rate_limit');
  });
});

describe('on_marker', () => {
  it('matches a plain substring and summarises from the marker', () => {
    expect(containsMarker('a [需要實驗] b', '[需要實驗]')).toBe(true);
    expect(containsMarker('a [需要實驗 b', '[需要實驗]')).toBe(false);
    expect(containsMarker('x.y', '.*')).toBe(false);
    expect(containsMarker(undefined, '[需要實驗]')).toBe(false);
    expect(containsMarker('anything', undefined)).toBe(false);
    expect(markerSummary('寫完第三節了。[需要實驗] 補一個消融實驗。另外…', '[需要實驗]')).toBe(
      '[需要實驗] 補一個消融實驗。',
    );
  });

  it('counts rounds from how often the target is already in the chain', () => {
    const rule = (maxRounds?: number) =>
      ({ action: { toSessionId: 'ex', ...(maxRounds ? { maxRounds } : {}) } }) as HandoffRule;
    expect(roundOf(rule(), ['ex', 'wr'])).toBeNull();
    expect(roundOf(rule(3), [])).toBe(1);
    expect(roundOf(rule(3), ['ex', 'wr'])).toBe(2);
    expect(roundOf(rule(3), ['ex', 'wr', 'ex', 'wr'])).toBe(3);
  });

  it('fires only when the last reply contains the marker as a plain substring', async () => {
    const t = await board();
    await addRule(t, t.b, t.a, 'on_marker', { marker: '[需要實驗]' });
    t.daemon.clear();
    stop(t.daemon, t.b, 'The draft needs an experiment, but no marker here.');
    stop(t.daemon, t.b, '[需要 實驗] spaced out is not the marker');
    await pause();
    expect(inputsTo(t.daemon, t.a)).toEqual([]);
    // 正規式的特殊字元照字面比對。
    stop(
      t.daemon,
      t.b,
      'Section 3 is done.\n\n[需要實驗] Compare against the baseline in table 1.',
    );
    await until(() => inputsTo(t.daemon, t.a).length === 2, 'marker fired');
    expect(JSON.parse(auditDetail('handoff.fired')!.detail)).toMatchObject({
      trigger: 'on_marker',
      fromSessionId: t.b,
    });
  });

  it('rejects an on_marker rule without a marker, a blank or too long marker, and bad round limits', async () => {
    const t = await board();
    const post = (trigger: string, action: object) =>
      hub.api('POST', `/api/teams/${t.teamId}/handoff-rules`, {
        cookie: t.cookie,
        body: {
          fromSessionId: t.a,
          trigger,
          action: { toSessionId: t.b, ...action },
          enabled: true,
        },
      });
    expect((await post('on_marker', {})).body).toMatchObject({ code: 'marker_required' });
    expect((await post('on_marker', { marker: '   ' })).status).toBe(400);
    expect((await post('on_marker', { marker: 'x'.repeat(41) })).status).toBe(400);
    expect((await post('on_marker', { marker: 'x'.repeat(40) })).status).toBe(200);
    expect((await post('on_done', { maxRounds: 0 })).status).toBe(400);
    expect((await post('on_done', { maxRounds: 11 })).status).toBe(400);
    expect((await post('on_done', { maxRounds: 2.5 })).status).toBe(400);
    const ok = await post('on_done', { maxRounds: 3 });
    expect(ok.status).toBe(200);
    // 改成 on_marker 但沒給標記也擋。
    const patch = await hub.api('PATCH', `/api/handoff-rules/${ok.body.id}`, {
      cookie: t.cookie,
      body: { trigger: 'on_marker' },
    });
    expect(patch.body).toMatchObject({ code: 'marker_required' });
  });
});

describe('on_file', () => {
  it('fires at most once per detected edit, does not repeat listed files, ignores replays', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file');
    t.daemon.clear();
    stop(t.daemon, t.a, 'A turn that edited nothing at all.');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);

    fileChanged(t.daemon, t.a, '/r/first.ts');
    const event = {
      id: randomUUID(),
      sessionId: t.a,
      type: 'hook',
      payload: { event: 'Stop', last_assistant_message: 'Replayed turn sent twice here.' },
      at: new Date().toISOString(),
    };
    // daemon 重送同一筆事件（斷線補送）不能觸發兩次
    t.daemon.send({ type: 'session.event', event });
    t.daemon.send({ type: 'session.event', event });
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'first handoff');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toHaveLength(2);

    await setStatus(t.daemon, t.b, 'running');
    await setStatus(t.daemon, t.b, 'waiting_input');
    t.daemon.clear();
    fileChanged(t.daemon, t.a, '/r/next.ts');
    stop(t.daemon, t.a);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'second handoff');
    expect(inputsTo(t.daemon, t.b)[0]!.data).toContain('Detected file edits: /r/next.ts | Branch');
  });

  it('waits for the target to be idle; never types into a permission prompt', async () => {
    const t = await board();
    await setStatus(t.daemon, t.b, 'waiting_permission');
    await addRule(t, t.a, t.b, 'on_file');
    t.daemon.clear();
    fileChanged(t.daemon, t.a, '/r/one.ts');
    stop(t.daemon, t.a, 'First version of the summary is here.');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
    // 同一條規則再觸發：只留最新的。
    fileChanged(t.daemon, t.a, '/r/two.ts');
    stop(t.daemon, t.a, 'Second version of the summary is here.');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);

    await setStatus(t.daemon, t.b, 'waiting_input');
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'delivered after idle');
    expect(inputsTo(t.daemon, t.b)[0]!.data).toContain('Second version');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toHaveLength(2);
  });

  it('fires at the end of the turn only when a changed file matches', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_file', { filePattern: '*.sql' });
    t.daemon.clear();
    fileChanged(t.daemon, t.a, '/r/app.ts');
    stop(t.daemon, t.a);
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);

    fileChanged(t.daemon, t.a, '/r/db/001.sql');
    await pause(30);
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
    stop(t.daemon, t.a);
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'on_file fired');
    expect(inputsTo(t.daemon, t.b)[0]!.data).toContain('/r/db/001.sql');
  });
});

describe('on_fail', () => {
  it('fires when a working session errors, with the failure in the summary', async () => {
    const t = await board();
    await setStatus(t.daemon, t.a, 'running');
    await addRule(t, t.a, t.b, 'on_fail');
    await addRule(t, t.a, t.c, 'on_done');
    t.daemon.clear();
    await setStatus(t.daemon, t.a, 'error', {
      statusDetail: 'exit code 3',
      endedAt: new Date().toISOString(),
    });
    await until(() => inputsTo(t.daemon, t.b).length === 2, 'on_fail fired');
    expect(inputsTo(t.daemon, t.b)[0]!.data).toContain('Summary: Failed: exit code 3.');
    expect(inputsTo(t.daemon, t.c)).toEqual([]);
  });

  it('does not fire when the person stopped the session', async () => {
    const t = await board();
    await setStatus(t.daemon, t.a, 'running');
    await addRule(t, t.a, t.b, 'on_fail');
    t.daemon.clear();
    await hub.api('POST', `/api/sessions/${t.a}/stop`, { cookie: t.cookie });
    await setStatus(t.daemon, t.a, 'error', {
      statusDetail: 'exit code 143',
      endedAt: new Date().toISOString(),
    });
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
  });

  it('does not fire for a session that never started or when the outcome is unknown', async () => {
    const t = await board();
    await addRule(t, t.a, t.b, 'on_fail');
    const res = await hub.api('POST', '/api/sessions', {
      cookie: t.cookie,
      body: { ...spec({ name: 'broken' }), machineId: t.machineId },
    });
    await addRule(t, res.body.id, t.b, 'on_fail');
    const create = await t.daemon.next('session.create');
    t.daemon.clear();
    t.daemon.send({ type: 'session.createFailed', requestId: create.requestId, error: 'no hook' });
    await until(() => sessionStatus(res.body.id) === 'error', 'create failed');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);

    // 斷線重連後 session 消失：結果不明，不算失敗。
    const { token } = await hub.pair(t.cookie, 'other');
    expect(token).toBeTruthy();
    t.daemon.send({
      type: 'daemon.hello',
      name: 'fake-machine',
      os: 'linux',
      version: '0',
      capabilities: {
        hasGpu: false,
        gpuName: null,
        cpuCores: 1,
        memoryBytes: 1,
        claudeVersion: null,
      },
      sessions: [runtime(t.b, { status: 'waiting_input' }), runtime(t.c)],
      pendingApprovals: [],
    });
    await until(() => sessionStatus(t.a) === 'error', 'reconciled');
    await pause();
    expect(inputsTo(t.daemon, t.b)).toEqual([]);
  });
});

describe('handoff events (canvas animation)', () => {
  it('ignores handoff.* events sent by a daemon: only the hub writes them', async () => {
    const t = await board();
    t.daemon.send({
      type: 'session.event',
      event: {
        id: randomUUID(),
        sessionId: t.a,
        type: 'handoff.fired',
        payload: { fromSessionId: t.a, toSessionId: t.b, summary: 'forged' },
        at: new Date().toISOString(),
      },
    });
    // 之後送一筆正常事件當分界：它進來了，前一筆就確定被丟掉。
    hookEvent(t.daemon, t.a, { event: 'Notification' });
    await until(
      () =>
        (
          hub.running.db
            .prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'hook'")
            .get() as { n: number }
        ).n > 0,
      'hook stored',
    );
    const events = await hub.api('GET', `/api/sessions/${t.a}/events`, { cookie: t.cookie });
    expect(events.body.map((e: { type: string }) => e.type)).not.toContain('handoff.fired');
  });

  it('delivered is written on the target with the summary', async () => {
    const t = await board();
    await addRule(t, t.a, t.b);
    await markDone(t, t.a);
    await until(() => auditActions().includes('terminal.input'), 'delivered');
    const events = await hub.api('GET', `/api/sessions/${t.b}/events`, { cookie: t.cookie });
    const delivered = events.body.find((e: { type: string }) => e.type === 'handoff.delivered');
    expect(delivered.sessionId).toBe(t.b);
    expect(delivered.payload).toMatchObject({ fromSessionId: t.a, toSessionId: t.b });
    expect(typeof delivered.payload.summary).toBe('string');
  });
});

describe('dropped handoffs (engine)', () => {
  const session = (id: string, status: Session['status']): Session =>
    ({ id, status, endedAt: null, archived: false, branch: null, statusDetail: null }) as Session;

  function engine() {
    const sessions = new Map<string, Session>([
      ['a', session('a', 'running')],
      ['b', session('b', 'running')],
    ]);
    const rule: HandoffRule = {
      id: 'r',
      teamId: 't',
      fromSessionId: 'a',
      trigger: 'on_done',
      action: { toSessionId: 'b' },
      enabled: true,
    };
    const events: { sessionId: string; type: string; payload: Record<string, unknown> }[] = [];
    const audits: { sessionId: string; action: string }[] = [];
    const store = {
      getSession: (id: string) => sessions.get(id) ?? null,
      listTeams: () => [{ id: 't' }],
      listRules: () => [rule],
      getRule: (id: string) => (id === rule.id ? rule : null),
      listEvents: () => [],
    } as unknown as Store;
    const deps: HandoffDeps = {
      store,
      now: () => new Date(),
      enterDelayMs: 1,
      audit: (sessionId, action) => audits.push({ sessionId, action }),
      addEvent: (sessionId, type, payload) => events.push({ sessionId, type, payload }),
      isReachable: () => true,
      sendInput: () => {},
      guarded: (_label, fn) => fn(),
      notifyRoundLimit: () => {},
    };
    const handoff = new HandoffEngine(deps);
    // a 完成時 b 還在工作：交接排進佇列。
    const a = sessions.get('a')!;
    handoff.onSessionChange(a, { ...a, status: 'done' }, true);
    expect(events.map((e) => e.type)).toEqual(['handoff.fired']);
    const change = (id: string, status: Session['status'], over: Partial<Session> = {}) => {
      const prev = sessions.get(id)!;
      const next = { ...prev, status, ...over };
      sessions.set(id, next);
      handoff.onSessionChange(prev, next, false);
    };
    return { sessions, rule, events, audits, change, handoff };
  }

  it('target ended: writes handoff.dropped (target_ended) on the source', () => {
    const t = engine();
    t.change('b', 'done', { endedAt: new Date().toISOString() });
    expect(t.events.at(-1)).toEqual({
      sessionId: 'a',
      type: 'handoff.dropped',
      payload: { ruleId: 'r', fromSessionId: 'a', toSessionId: 'b', reason: 'target_ended' },
    });
    t.handoff.close();
  });

  it('source deleted: only the audit, no event (the event would break the foreign key)', () => {
    const t = engine();
    t.sessions.delete('a');
    t.rule.enabled = false;
    t.change('b', 'waiting_input');
    expect(t.audits.map((a) => a.action)).toContain('handoff.dropped');
    expect(t.events.map((e) => e.type)).toEqual(['handoff.fired']);
    t.handoff.close();
  });
});
