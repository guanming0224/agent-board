// 全部暫停的 REST 回應與 WebSocket 廣播的先後：較晚到的 REST 回應不能蓋掉較新的廣播。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_PAUSED, type BoardPauseState, type Broadcast } from '@agent-board/protocol';
import type { BoardSnapshot } from './backend';
import { createHubBackend, mergeAfterReconnect } from './hubBackend';

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send() {}
  close() {}
  push(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const PAUSED: BoardPauseState = {
  paused: {
    mode: 'finish_turn',
    since: '2026-11-08T06:00:00.000Z',
    by: 'u2',
    byName: 'B',
    clearedOnRestart: 0,
  },
  held: { deliveries: 0, sessions: 0, sessionsWaiting: 0, autoContinues: 0 },
};

/** 每次 fetch 都等測試手動放行，模擬 REST 回應晚到。 */
let pending: { body: unknown; resolve: (res: Response) => void }[] = [];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  pending = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'hub.test', hash: '' });
  vi.stubGlobal(
    'fetch',
    (path: string) =>
      new Promise<Response>((resolve) => {
        if (path.includes('/auth/status')) {
          resolve(
            json({
              needsSetup: false,
              user: {
                id: 'u1',
                name: 'A',
                role: 'owner',
                locale: 'zh-TW',
                createdAt: '2026-11-08T06:00:00.000Z',
              },
            }),
          );
          return;
        }
        pending.push({ body: path, resolve });
      }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect() {
  const backend = createHubBackend();
  let latest: BoardSnapshot | null = null;
  backend.watchBoard((s) => (latest = s));
  await backend.currentUser();
  const ws = FakeSocket.last!;
  ws.readyState = FakeSocket.OPEN;
  ws.onopen?.();
  ws.push({ type: 'board.state', machines: [], sessions: [], approvals: [], pause: NOT_PAUSED });
  return { backend, ws, pause: () => latest?.pause };
}

async function settle(index: number, value: unknown) {
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
  pending[index]!.resolve(json(value));
}

describe('hubBackend 全部暫停', () => {
  it('WebSocket 還沒到時，用 REST 回應更新畫面', async () => {
    const { backend, pause } = await connect();
    const done = backend.pauseBoard('finish_turn');
    await settle(0, { state: PAUSED, interrupted: [] });
    await done;
    expect(pause()).toEqual(PAUSED);
  });

  it('REST 回應比較新的 board.pause 晚到：不蓋掉廣播（A 按繼續、B 同時按暫停）', async () => {
    const { backend, ws, pause } = await connect();
    ws.push({ type: 'board.pause', pause: PAUSED });
    const done = backend.resumeBoard();
    // B 的暫停廣播先到，A 自己 resume 的 REST 回應（沒暫停）後到。
    ws.push({ type: 'board.pause', pause: { ...PAUSED, held: { ...PAUSED.held } } });
    await settle(0, { state: NOT_PAUSED, released: NOT_PAUSED.held });
    await done;
    expect(pause()?.paused).not.toBeNull();
  });

  it('暫停的 REST 回應晚於排隊數增加的廣播：排隊數不倒退', async () => {
    const { backend, ws, pause } = await connect();
    const done = backend.pauseBoard('finish_turn');
    const later = { ...PAUSED, held: { ...PAUSED.held, deliveries: 2 } };
    ws.push({ type: 'board.pause', pause: later });
    await settle(0, { state: PAUSED, interrupted: [] });
    await done;
    expect(pause()?.held.deliveries).toBe(2);
  });
});

const broadcast = (id: string, states: Broadcast['targets'][number]['state'][]): Broadcast => ({
  id,
  teamId: 't',
  text: 'hi',
  mentioned: false,
  by: null,
  byName: null,
  at: '2026-11-08T00:00:00.000Z',
  boardPaused: false,
  targets: states.map((state, i) => ({
    sessionId: `s${i}`,
    name: `s${i}`,
    state,
    reason: null,
    at: '2026-11-08T00:00:00.000Z',
  })),
});

describe('群發：hub 重啟後重連', () => {
  it('hub 清單裡沒有的、原本還在排隊的對象標成「沒送出（hub 重啟）」，不默默消失', () => {
    const before = [broadcast('old', ['sent', 'queued']), broadcast('done', ['sent'])];
    const merged = mergeAfterReconnect(before, [broadcast('new', ['queued'])]);
    expect(merged.map((b) => b.id)).toEqual(['old', 'new']);
    expect(merged[0]!.targets.map((t) => [t.state, t.reason])).toEqual([
      ['sent', null],
      ['failed', 'hub_restarted'],
    ]);
  });

  it('只是斷線重連（hub 還記得）：照 hub 的', () => {
    const before = [broadcast('a', ['queued'])];
    expect(mergeAfterReconnect(before, [broadcast('a', ['sent'])])[0]!.targets[0]!.state).toBe(
      'sent',
    );
  });
});
