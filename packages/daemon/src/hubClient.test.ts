import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, HubClient } from './hubClient';
import { FAKE_CAPABILITIES, waitUntil } from './test-support/harness';
import { FakeHub } from './test-support/fakeHub';
import type { DaemonToHub, HubToDaemon } from '@agent-board/protocol';

const event = (id: string): DaemonToHub => ({
  type: 'session.event',
  event: { id, sessionId: 's', type: 't', payload: {}, at: new Date().toISOString() },
});

describe('backoffDelay', () => {
  it('1s 起、翻倍、上限 30s，抖動 ±20%', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffDelay(n, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ]);
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1200);
    expect(backoffDelay(30, () => 0)).toBe(24000);
    expect(backoffDelay(30, () => 1)).toBe(36000);
  });
});

describe('HubClient', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  async function setup(heartbeatMs?: number, authRetryMs?: number) {
    const hub = new FakeHub();
    await hub.start();
    const messages: HubToDaemon[] = [];
    let disconnects = 0;
    const client = new HubClient({
      url: hub.url,
      token: 'secret',
      heartbeatMs,
      authRetryMs,
      buildHello: () => ({
        type: 'daemon.hello',
        name: 'm',
        os: 'darwin',
        version: '0',
        capabilities: FAKE_CAPABILITIES,
        sessions: [],
        pendingApprovals: [],
      }),
      onMessage: (message) => messages.push(message),
      onDisconnected: () => {
        disconnects += 1;
      },
    });
    cleanups.push(
      () => client.stop(),
      () => hub.stop(),
    );
    return { hub, client, messages, disconnects: () => disconnects };
  }

  it('帶 Bearer token 連線，第一則訊息是 hello，收到 welcome 才算連上', async () => {
    const { hub, client } = await setup();
    hub.autoWelcome = false;
    client.start();
    await hub.waitFor('daemon.hello');
    expect(hub.received[0]?.type).toBe('daemon.hello');
    expect(hub.authHeaders).toEqual(['Bearer secret']);
    expect(client.connected).toBe(false);
    hub.send({ type: 'hub.welcome', machineId: 'm', dangerRules: [], stuckMinutes: 1 });
    await waitUntil(() => client.connected, 'welcome 後連上');
  });

  it('不合法的訊息丟棄、不斷線，合法訊息繼續處理', async () => {
    const { hub, client, messages, disconnects } = await setup();
    client.start();
    await waitUntil(() => client.connected, '連上');
    hub.sendRaw('not json');
    hub.sendRaw(JSON.stringify({ type: 'nope' }));
    hub.sendRaw(JSON.stringify({ type: 'terminal.input', sessionId: 's' }));
    hub.send({ type: 'resources.watch', watching: true });
    await waitUntil(() => messages.some((m) => m.type === 'resources.watch'), '合法訊息');
    expect(messages.map((m) => m.type)).toEqual(['hub.welcome', 'resources.watch']);
    expect(disconnects()).toBe(0);
  });

  it('斷線後重連並重送 hello；斷線期間的必達訊息補送，終端機輸出不補', async () => {
    const { hub, client, disconnects } = await setup();
    client.start();
    await waitUntil(() => client.connected, '連上');
    hub.dropConnection();
    await waitUntil(() => !client.connected, '斷線');
    client.send(event('during-outage'));
    client.send({ type: 'terminal.output', sessionId: 's', seq: 1, data: 'lost' });
    client.send({ type: 'session.createFailed', requestId: 'r', error: 'x' });
    await waitUntil(
      () => hub.received.filter((m) => m.type === 'daemon.hello').length === 2,
      '第二次 hello',
    );
    await hub.waitFor('session.createFailed');
    await hub.waitFor('session.event', (m) => m.event.id === 'during-outage');
    expect(disconnects()).toBe(1);
    expect(hub.received.some((m) => m.type === 'terminal.output')).toBe(false);
  });

  it('hub 整個關掉再回來也能重連', async () => {
    const { hub, client } = await setup();
    client.start();
    await waitUntil(() => client.connected, '連上');
    const { port } = hub;
    await hub.stop();
    await waitUntil(() => !client.connected, '斷線');
    await hub.start(port);
    await waitUntil(() => client.connected, '重連', 15_000);
  });

  it('hub 不回 pong 時會主動中斷（半開連線）', async () => {
    const { hub, client, disconnects } = await setup(50);
    client.start();
    await waitUntil(() => client.connected, '連上');
    // 讓 hub 那端不再回 pong：暫停底層 socket。
    const raw = hub as unknown as { socket: { pause: () => void } };
    raw.socket.pause();
    await waitUntil(() => disconnects() >= 1, '偵測到半開連線');
  });

  it('401：不走退避狂打 hub，改長間隔，log 說明原因與做法，不含 token', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => logged.mockRestore());
    const { hub, client } = await setup(undefined, 60_000);
    hub.rejectStatus = 401;
    client.start();
    await waitUntil(() => hub.upgradeAttempts === 1, '第一次嘗試');
    // 一般退避 1 秒內就會重試；這裡等 2.5 秒仍只有一次。
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(hub.upgradeAttempts).toBe(1);
    expect(client.connected).toBe(false);
    const text = logged.mock.calls.flat().join('\n');
    expect(text).toContain('撤銷');
    expect(text).toContain('agent-board-daemon pair');
    expect(text).not.toContain('secret');
  });

  it('401 恢復後能連上；其他錯誤碼（502）維持一般退避', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => logged.mockRestore());
    const revoked = await setup(undefined, 100);
    revoked.hub.rejectStatus = 401;
    revoked.client.start();
    await waitUntil(() => revoked.hub.upgradeAttempts >= 2, '長間隔到期後再試');
    revoked.hub.rejectStatus = null;
    await waitUntil(() => revoked.client.connected, '恢復');

    const outage = await setup(undefined, 60_000);
    outage.hub.rejectStatus = 502;
    outage.client.start();
    await waitUntil(() => outage.hub.upgradeAttempts >= 2, '一般退避重試', 3_000);
  });

  it('sendConfirmed：沒連上回 false；連上且寫入成功回 true', async () => {
    const { hub, client } = await setup();
    const results: boolean[] = [];
    client.sendConfirmed(event('a'), (sent) => results.push(sent));
    expect(results).toEqual([false]);
    client.start();
    await waitUntil(() => client.connected, '連上');
    client.sendConfirmed(event('b'), (sent) => results.push(sent));
    await waitUntil(() => results.length === 2, '回報');
    expect(results).toEqual([false, true]);
    await hub.waitFor('session.event', (m) => m.event.id === 'b');
    expect(hub.received.some((m) => m.type === 'session.event' && m.event.id === 'a')).toBe(false);
  });

  it('stop 之後不再重連', async () => {
    const { hub, client } = await setup();
    client.start();
    await waitUntil(() => client.connected, '連上');
    const before = hub.authHeaders.length;
    client.stop();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(hub.authHeaders.length).toBe(before);
  });
});
