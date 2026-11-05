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
