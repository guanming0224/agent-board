// @vitest-environment node
// sw.js 不經打包，這裡用 vm 把它跑在假的 ServiceWorkerGlobalScope 裡。
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://board.example.ts.net';

type Handler = (event: Record<string, unknown>) => void;

interface FakeClient {
  url: string;
  focused: boolean;
  messages: unknown[];
  focus(): Promise<void>;
  postMessage(message: unknown): void;
}

function loadWorker(language: string, clients: FakeClient[] = []) {
  const handlers = new Map<string, Handler>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    navigator: { language },
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => clients,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  runInNewContext(SOURCE, { self, URL });

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { handlers, shown, opened, dispatch };
}

const pushEvent = (payload: unknown) => ({
  data:
    payload === undefined
      ? null
      : {
          json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
        },
});

const client = (url: string): FakeClient => ({
  url,
  focused: false,
  messages: [],
  async focus() {
    this.focused = true;
  },
  postMessage(message) {
    this.messages.push(message);
  },
});

describe('sw.js push', () => {
  it('shows the hub payload: session name as title, status in the reader’s language', async () => {
    const zh = loadWorker('zh-TW');
    await zh.dispatch(
      'push',
      pushEvent({
        sessionId: 's/1',
        name: 'api 重構',
        status: 'waiting_permission',
        at: '2026-11-03T01:02:03.000Z',
      }),
    );
    expect(zh.shown).toHaveLength(1);
    expect(zh.shown[0]!.title).toBe('api 重構');
    expect(zh.shown[0]!.options).toMatchObject({
      body: '等你允許',
      tag: 'session-s/1',
      renotify: true,
      icon: '/icon-192.png',
      timestamp: Date.parse('2026-11-03T01:02:03.000Z'),
      data: { url: `${ORIGIN}/#/inbox/s%2F1` },
    });

    const en = loadWorker('en-US');
    await en.dispatch('push', pushEvent({ sessionId: 's1', name: 'docs', status: 'stuck' }));
    expect(en.shown[0]!.options.body).toBe('Stuck');
  });

  it('says why when a two-way handoff hit its round limit, in its own notification', async () => {
    const zh = loadWorker('zh-TW');
    const payload = {
      sessionId: 's1',
      name: '論文-WR',
      status: 'running',
      reason: 'handoff_round_limit',
      maxRounds: 3,
    };
    await zh.dispatch('push', pushEvent(payload));
    expect(zh.shown[0]!.options).toMatchObject({
      body: '雙向交接已來回 3 輪，自動交接停下，等你決定',
      tag: 'handoff-s1',
    });
    const en = loadWorker('en');
    await en.dispatch('push', pushEvent({ ...payload, reason: 'something_new' }));
    // 認不得的原因照狀態顯示。
    expect(en.shown[0]!.options).toMatchObject({ body: 'A session is waiting on you' });
  });

  it('says why when a task hit its reject limit, with the task number', async () => {
    const payload = {
      sessionId: 's2',
      name: 'T-RV',
      status: 'waiting_input',
      reason: 'task_reject_limit',
      maxRounds: 3,
      task: 7,
    };
    const zh = loadWorker('zh-TW');
    await zh.dispatch('push', pushEvent(payload));
    expect(zh.shown[0]!.options).toMatchObject({
      body: '任務 #7 被退回 3 次，自動執行停下，等你決定',
      tag: 'task-s2',
    });
    const en = loadWorker('en');
    await en.dispatch('push', pushEvent(payload));
    expect(en.shown[0]!.options.body).toBe(
      'Task #7 was sent back 3 times and stopped. Waiting for you.',
    );
  });

  describe('coalesced summary (hub attention.ts)', () => {
    const summary = {
      kind: 'summary',
      count: 3,
      items: [
        { sessionId: 'a', name: 'BD1', status: 'waiting_permission' },
        {
          sessionId: 'b',
          name: 'RV',
          status: 'waiting_input',
          reason: 'task_reject_limit',
          maxRounds: 3,
          task: 3,
        },
        {
          sessionId: 'c',
          name: 'EX',
          status: 'waiting_input',
          reason: 'handoff_round_limit',
          maxRounds: 3,
        },
      ],
      more: 0,
      autoContinued: [],
      at: '2026-11-06T10:00:00.000Z',
    };

    it('one notification listing everything, with one tag so a newer summary replaces the older', async () => {
      const zh = loadWorker('zh-TW');
      await zh.dispatch('push', pushEvent(summary));
      expect(zh.shown).toEqual([
        {
          title: '3 個 session 在等你',
          options: expect.objectContaining({
            body: 'BD1 問權限、RV 退回 #3、EX 來回到上限',
            tag: 'agent-board-summary',
            renotify: true,
            data: { url: `${ORIGIN}/#/inbox` },
          }),
        },
      ]);
      const en = loadWorker('en');
      await en.dispatch('push', pushEvent({ ...summary, more: 2 }));
      expect(en.shown[0]).toMatchObject({
        title: '3 sessions waiting on you',
        options: {
          body: 'BD1 needs approval, RV sent back #3, EX hit the round limit, 2 more',
          tag: 'agent-board-summary',
        },
      });
    });

    it('truncates with 還有 N 個, says when over the limit, and lists auto-continued sessions', async () => {
      const zh = loadWorker('zh-TW');
      await zh.dispatch(
        'push',
        pushEvent({
          ...summary,
          count: 8,
          more: 5,
          overLimit: 3,
          autoContinued: [{ sessionId: 'd', name: 'BD2' }],
        }),
      );
      expect(zh.shown[0]).toMatchObject({
        title: '8 個 session 在等你（超過上限 3）',
        options: { body: 'BD1 問權限、RV 退回 #3、EX 來回到上限、還有 5 個、BD2 已自動接續' },
      });
    });

    it('only one waiting: tapping opens that inbox item; only auto-continued: a plain notice', async () => {
      const zh = loadWorker('zh-TW');
      await zh.dispatch(
        'push',
        pushEvent({ ...summary, count: 1, items: [summary.items[0]], more: 0 }),
      );
      expect(zh.shown[0]!.options.data).toEqual({ url: `${ORIGIN}/#/inbox/a` });
      await zh.dispatch(
        'push',
        pushEvent({
          ...summary,
          count: 0,
          items: [],
          autoContinued: [{ sessionId: 'd', name: 'BD2' }],
        }),
      );
      expect(zh.shown[1]).toMatchObject({
        title: 'Agent Board',
        options: { body: 'BD2 已自動接續', data: { url: `${ORIGIN}/#/inbox` } },
      });
    });

    it('overload push (coalescing off) and the single auto-continued push', async () => {
      const zh = loadWorker('zh-TW');
      await zh.dispatch('push', pushEvent({ kind: 'overload', count: 5, limit: 3 }));
      expect(zh.shown[0]).toMatchObject({
        title: '等你的 session 超過上限',
        options: { body: '現在有 5 個在等你（上限 3）', tag: 'agent-board-overload' },
      });
      await zh.dispatch(
        'push',
        pushEvent({ sessionId: 's9', name: 'BD1', status: 'running', reason: 'auto_continued' }),
      );
      expect(zh.shown[1]).toMatchObject({
        title: 'BD1',
        options: { body: '額度恢復，已自動接續', tag: 'auto-s9' },
      });
    });
  });

  it('still notifies when the payload is missing or malformed', async () => {
    const worker = loadWorker('en');
    await worker.dispatch('push', pushEvent(undefined));
    await worker.dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('bad');
        },
      },
    });
    expect(worker.shown.map((n) => [n.title, n.options.body, n.options.data])).toEqual([
      ['Agent Board', 'A session is waiting on you', { url: `${ORIGIN}/#/inbox` }],
      ['Agent Board', 'A session is waiting on you', { url: `${ORIGIN}/#/inbox` }],
    ]);
  });
});

describe('sw.js notificationclick', () => {
  const clickEvent = (url: string) => {
    const notification = { closed: false, data: { url }, close: () => undefined };
    notification.close = () => {
      notification.closed = true;
    };
    return { notification };
  };

  it('focuses an open board tab and tells it to go to the inbox item', async () => {
    const other = client('https://elsewhere.example/');
    const board = client(`${ORIGIN}/#/canvas`);
    const worker = loadWorker('en', [other, board]);
    const event = clickEvent(`${ORIGIN}/#/inbox/s1`);
    await worker.dispatch('notificationclick', event);
    expect(event.notification.closed).toBe(true);
    expect(board.focused).toBe(true);
    expect(board.messages).toEqual([{ type: 'agent-board.open', url: `${ORIGIN}/#/inbox/s1` }]);
    expect(other.focused).toBe(false);
    expect(worker.opened).toEqual([]);
  });

  it('opens a new window when the board is not open', async () => {
    const worker = loadWorker('en');
    await worker.dispatch('notificationclick', clickEvent(`${ORIGIN}/#/inbox/s1`));
    expect(worker.opened).toEqual([`${ORIGIN}/#/inbox/s1`]);
  });
});

describe('sw.js team activity (lead auto-staffing)', () => {
  it('single push: title is the lead, body names the member and points to the inbox; no reason text', async () => {
    const worker = loadWorker('zh-TW');
    await worker.dispatch(
      'push',
      pushEvent({
        reason: 'team_member_added',
        name: 'LD',
        member: 'LD-QA',
        sessionId: 's7',
        at: '2026-11-10T01:00:00.000Z',
      }),
    );
    expect(worker.shown[0]!.title).toBe('LD');
    expect(worker.shown[0]!.options.body).toBe('新增了成員 LD-QA（理由在收件匣的團隊動態）');
    expect(worker.shown[0]!.options.tag).toBe('team-s7');
    const en = loadWorker('en');
    await en.dispatch(
      'push',
      pushEvent({ reason: 'team_member_released', name: 'LD', member: 'LD-RV', sessionId: 's8' }),
    );
    expect(en.shown[0]!.options.body).toBe(
      'Released member LD-RV (reason under Team activity in the inbox)',
    );
  });

  it('summary with only team activity: titled "Team activity", lists who added or released whom', async () => {
    const worker = loadWorker('zh-TW');
    await worker.dispatch(
      'push',
      pushEvent({
        kind: 'summary',
        count: 0,
        items: [],
        more: 0,
        autoContinued: [],
        team: [
          { reason: 'team_member_added', lead: 'LD', member: 'LD-BD2', sessionId: 'a' },
          { reason: 'team_member_released', lead: 'LD', member: 'LD-RS', sessionId: 'b' },
        ],
        at: '2026-11-10T01:00:00.000Z',
      }),
    );
    expect(worker.shown[0]!.title).toBe('團隊動態');
    expect(worker.shown[0]!.options.body).toBe('LD 新增了 LD-BD2、LD 封存了 LD-RS');
  });

  it('summary with waiting sessions and team activity keeps the waiting title', async () => {
    const worker = loadWorker('en');
    await worker.dispatch(
      'push',
      pushEvent({
        kind: 'summary',
        count: 1,
        items: [{ sessionId: 's1', name: 'BD1', status: 'waiting_permission' }],
        more: 0,
        autoContinued: [],
        team: [{ reason: 'team_member_added', lead: 'LD', member: 'LD-QA', sessionId: 'q' }],
      }),
    );
    expect(worker.shown[0]!.title).toBe('1 sessions waiting on you');
    expect(worker.shown[0]!.options.body).toBe('BD1 needs approval, LD added LD-QA');
  });
});

describe('sw.js update failed (release auto-update)', () => {
  const failed = (over: Record<string, unknown> = {}) => ({
    kind: 'update_failed',
    machineId: 'm-laptop',
    machine: 'MacBook',
    version: '0.1.1',
    phase: 'rolled_back',
    reason: 'health_timeout',
    at: '2026-11-11T01:00:00.000Z',
    ...over,
  });

  it('rolled back: machine, version and the translated reason; opens the machines panel', async () => {
    const zh = loadWorker('zh-TW');
    await zh.dispatch('push', pushEvent(failed()));
    expect(zh.shown[0]).toMatchObject({
      title: 'Agent Board 更新失敗',
      options: {
        body: 'MacBook：0.1.1 已回滾（60 秒內健康檢查沒過）',
        tag: 'agent-board-update',
        renotify: true,
        timestamp: Date.parse('2026-11-11T01:00:00.000Z'),
        data: { url: `${ORIGIN}/#/machines` },
      },
    });
    const en = loadWorker('en');
    await en.dispatch('push', pushEvent(failed()));
    expect(en.shown[0]).toMatchObject({
      title: 'Agent Board update failed',
      options: { body: 'MacBook: 0.1.1 was rolled back (health check didn’t pass within 60s)' },
    });
  });

  it('failed and rollback_failed phases; no reason, unknown reason, missing names', async () => {
    const zh = loadWorker('zh-TW');
    await zh.dispatch('push', pushEvent(failed({ phase: 'failed', reason: 'download_failed' })));
    await zh.dispatch('push', pushEvent(failed({ phase: 'rollback_failed', reason: null })));
    await zh.dispatch('push', pushEvent(failed({ reason: 'something_new' })));
    await zh.dispatch('push', pushEvent(failed({ machine: '', version: null, phase: 'odd' })));
    expect(zh.shown.map((n) => n.options.body)).toEqual([
      'MacBook：更新到 0.1.1 失敗（下載失敗）',
      'MacBook：0.1.1 回滾也失敗，需要處理',
      'MacBook：0.1.1 已回滾（原因不明）',
      '?：更新到 ? 失敗（60 秒內健康檢查沒過）',
    ]);
    expect(new Set(zh.shown.map((n) => n.options.tag))).toEqual(new Set(['agent-board-update']));
  });

  it('clicking it goes to the machines panel', async () => {
    const board = client(`${ORIGIN}/#/canvas`);
    const worker = loadWorker('en', [board]);
    await worker.dispatch('push', pushEvent(failed()));
    const url = (worker.shown[0]!.options.data as { url: string }).url;
    await worker.dispatch('notificationclick', {
      notification: { data: { url }, close: () => undefined },
    });
    expect(board.messages).toEqual([{ type: 'agent-board.open', url: `${ORIGIN}/#/machines` }]);
  });
});

describe('sw.js cross review (Codex round 2)', () => {
  const review = (over: Record<string, unknown> = {}) => ({
    kind: 'review',
    event: 'done',
    reviewId: 'rv-1',
    at: '2026-11-12T01:00:00.000Z',
    ...over,
  });

  it('done: only says the review finished (no review text); opens the review; own tag per review', async () => {
    const zh = loadWorker('zh-TW');
    await zh.dispatch('push', pushEvent(review()));
    expect(zh.shown[0]).toMatchObject({
      title: '交叉審查',
      options: {
        body: '審查完成',
        tag: 'agent-board-review-rv-1',
        data: { url: `${ORIGIN}/#/cross-review/rv-1` },
      },
    });
    const en = loadWorker('en');
    await en.dispatch('push', pushEvent(review()));
    expect(en.shown[0]).toMatchObject({
      title: 'Cross review',
      options: { body: 'Review finished' },
    });
  });

  it('requested by a lead: names the lead, never the reason', async () => {
    const zh = loadWorker('zh-TW');
    await zh.dispatch(
      'push',
      pushEvent(review({ event: 'requested', lead: 'LD', reason: 'should not show' })),
    );
    expect(zh.shown[0]!.options.body).toBe('LD 要求交叉審查');
    const en = loadWorker('en');
    await en.dispatch('push', pushEvent(review({ event: 'requested' })));
    expect(en.shown[0]!.options.body).toBe('? asked for a cross review');
  });
});
