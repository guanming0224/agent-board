// 全部暫停的 REST 回應與 WebSocket 廣播的先後：較晚到的 REST 回應不能蓋掉較新的廣播。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOT_PAUSED,
  type BoardPauseState,
  type Broadcast,
  type StaffRequest,
} from '@agent-board/protocol';
import type { BoardSnapshot } from './backend';
import {
  createHubBackend,
  DEEP_START_TIMEOUT_MS,
  DEEP_TOTAL_TIMEOUT_MS,
  mergeAfterReconnect,
} from './hubBackend';

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
  send(_data: string) {}
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
  return { backend, ws, pause: () => latest?.pause, snapshot: () => latest };
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

describe('hubBackend 加開申請（CONTRACTS §23）', () => {
  const request = (id: string): StaffRequest => ({
    id,
    at: '2026-11-13T01:00:00.000Z',
    expiresAt: '2026-11-13T01:30:00.000Z',
    teamId: 't',
    teamName: 'Squad',
    leadSessionId: 's-lead',
    leadName: 'Lead',
    limit: 'team_full',
    limits: ['team_full'],
    teamSize: 12,
    teamLimit: 12,
    role: 'tester',
    reason: 'Need tests.',
    promptPreview: 'Write tests.',
    status: 'pending',
  });

  it('board.state 與 staff.requests 更新待處理清單；同意後先從畫面拿掉，回傳 hub 的結果', async () => {
    const { backend, ws, snapshot } = await connect();
    expect(snapshot()?.staffRequests).toEqual([]);
    ws.push({ type: 'staff.requests', items: [request('a'), request('b')] });
    expect(snapshot()?.staffRequests?.map((r) => r.id)).toEqual(['a', 'b']);
    const done = backend.approveStaffRequest('a');
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    expect(String(pending[0]!.body)).toContain('/api/staff-requests/a/approve');
    pending[0]!.resolve(json({ ...request('a'), status: 'approved', memberName: 'Squad-QA' }));
    expect(await done).toMatchObject({ status: 'approved', memberName: 'Squad-QA' });
    expect(snapshot()?.staffRequests?.map((r) => r.id)).toEqual(['b']);
    const rejected = backend.rejectStaffRequest('b');
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(1));
    expect(String(pending[1]!.body)).toContain('/api/staff-requests/b/reject');
    pending[1]!.resolve(json({ ...request('b'), status: 'rejected' }));
    expect(await rejected).toMatchObject({ status: 'rejected' });
    expect(snapshot()?.staffRequests).toEqual([]);
  });
});

const broadcast = (id: string, states: Broadcast['targets'][number]['state'][]): Broadcast => ({
  id,
  teamId: 't',
  kind: 'team',
  cardKey: null,
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

describe('hubBackend 深層搜尋的看門狗', () => {
  afterEach(() => vi.useRealTimers());

  const request = {
    q: 'risk.py',
    scope: 'all',
    since: '7d',
    archived: false,
    mask: false,
  } as const;

  it('hub 沒回 deepStarted（例如舊版 hub 回 invalid_message）：5 秒後當失敗、送 search.cancel', async () => {
    const { backend, ws } = await connect();
    const sent: string[] = [];
    ws.send = (data: string) => sent.push(data);
    vi.useFakeTimers();
    const events: { type: string; error?: string }[] = [];
    const handle = backend.deepSearch(request, (e) => events.push(e));
    ws.push({ type: 'error', code: 'invalid_message', message: 'bad' });
    vi.advanceTimersByTime(DEEP_START_TIMEOUT_MS - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([
      { type: 'search.deepFailed', searchId: handle.searchId, error: 'no_reply' },
    ]);
    expect(sent.map((m) => JSON.parse(m) as { type: string })).toEqual([
      expect.objectContaining({ type: 'search.deep', searchId: handle.searchId }),
      { type: 'search.cancel', searchId: handle.searchId },
    ]);
    // 之後晚到的事件不再交給畫面。
    ws.push({ type: 'search.deepStarted', searchId: handle.searchId, machines: [] });
    expect(events).toHaveLength(1);
  });

  it('有 deepStarted 但某台一直沒 deepDone：過了總時間上限才失敗；全部結束就不再計時', async () => {
    const { backend, ws } = await connect();
    vi.useFakeTimers();
    const events: { type: string; error?: string }[] = [];
    const slow = backend.deepSearch(request, (e) => events.push(e));
    ws.push({
      type: 'search.deepStarted',
      searchId: slow.searchId,
      machines: [{ machineId: 'm1', totalSessions: 1 }],
    });
    vi.advanceTimersByTime(DEEP_START_TIMEOUT_MS * 2);
    expect(events.map((e) => e.type)).toEqual(['search.deepStarted']);
    vi.advanceTimersByTime(DEEP_TOTAL_TIMEOUT_MS);
    expect(events.at(-1)).toEqual({
      type: 'search.deepFailed',
      searchId: slow.searchId,
      error: 'no_reply',
    });

    const done: { type: string }[] = [];
    const fast = backend.deepSearch(request, (e) => done.push(e));
    ws.push({
      type: 'search.deepStarted',
      searchId: fast.searchId,
      machines: [{ machineId: 'm1', totalSessions: 1 }],
    });
    ws.push({
      type: 'search.deepDone',
      searchId: fast.searchId,
      machineId: 'm1',
      state: 'done',
      scannedSessions: 1,
      totalSessions: 1,
    });
    vi.advanceTimersByTime(DEEP_TOTAL_TIMEOUT_MS * 2);
    expect(done.map((e) => e.type)).toEqual(['search.deepStarted', 'search.deepDone']);
  });
});
