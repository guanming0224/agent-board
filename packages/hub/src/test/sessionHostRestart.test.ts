// 事故 9（CONTRACTS §20.8）：session host 輸入可能失效的推播、機器面板的 session host 狀態與「重啟 session host」。
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_FEATURES, type ReleaseOverview } from '@agent-board/protocol';
import { startHub, until, type TestHub } from './helpers';

let hub: TestHub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

/** 條件是非同步的（要打 API）時用這個；helpers 的 until 只收同步條件。 */
const untilAsync = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const restartFeatures = [DAEMON_FEATURES.signalGuard, DAEMON_FEATURES.sessionHostRestart];
const healthy = { mode: 'host', inputSuspect: false, canRestart: true } as const;

describe('session host 狀態與重啟', () => {
  it('輸入可能失效：推播只帶固定欄位（不帶 daemon 的說明），一小時一次；面板看得到狀態', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: true, coalesce: false, quietHours: null } },
    });
    await hub.api('POST', '/api/push/subscriptions', {
      cookie,
      body: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    const { daemon, machineId } = await hub.onlineDaemon(cookie, {
      features: restartFeatures,
      sessionHost: healthy,
    } as never);
    const overview = async () =>
      (await hub!.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body.machines.find(
        (m) => m.machineId === machineId,
      )!;
    expect((await overview()).sessionHost).toEqual(healthy);
    expect((await overview()).sessionHostRestartSupported).toBe(true);

    daemon.send({ type: 'sessionHost.status', state: { ...healthy, inputSuspect: true } });
    daemon.send({
      type: 'daemon.alert',
      code: 'session_host_input_stuck',
      message: '使用者打的字 secret-input 不該出現',
    });
    daemon.send({
      type: 'daemon.alert',
      code: 'session_host_input_stuck',
      message: '使用者打的字 secret-input 不該出現',
    });
    await until(() => hub!.push.sent.length === 1, 'push');
    const payload = JSON.parse(hub.push.sent[0]!.payload) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['at', 'kind', 'machine', 'machineId']);
    expect(payload).toMatchObject({ kind: 'host_input_stuck', machineId, machine: 'fake-machine' });
    expect(hub.push.sent[0]!.payload).not.toContain('secret-input');
    await untilAsync(async () => (await overview()).sessionHost?.inputSuspect === true, '面板狀態');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(hub.push.sent.length).toBe(1);
  });

  it('重啟：owner＋confirm 才送 sessionHost.restart、寫 audit；舊 daemon、不能重啟、離線、成員各自被擋', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const member = await hub.createMember(cookie);
    const restart = (id: string, body: object, as = cookie) =>
      hub!.api('POST', `/api/machines/${id}/session-host/restart`, { cookie: as, body });

    // 舊 daemon：沒有 sessionHost.restart 功能。
    const old = await hub.onlineDaemon(cookie);
    expect((await restart(old.machineId, { confirm: true })).body.code).toBe('daemon_too_old');

    const { daemon, machineId } = await hub.onlineDaemon(cookie, {
      features: restartFeatures,
      sessionHost: healthy,
    } as never);
    expect((await restart(machineId, {})).body.code).toBe('confirm_required');
    expect((await restart(machineId, { confirm: true }, member.cookie)).status).toBe(403);
    const ok = await restart(machineId, { confirm: true });
    expect(ok.status).toBe(200);
    await daemon.next('sessionHost.restart');
    const audit = (await hub.api('GET', '/api/audit?action=machine.sessionHostRestart', { cookie }))
      .body as { detail: string }[];
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ machineId, mode: 'host' });

    // 這台不能自己重啟（Windows、沒有服務名稱）。
    daemon.send({ type: 'sessionHost.status', state: { ...healthy, canRestart: false } });
    await untilAsync(
      async () =>
        (await hub!.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body.machines.find(
          (m) => m.machineId === machineId,
        )?.sessionHost?.canRestart === false,
      '狀態更新',
    );
    expect((await restart(machineId, { confirm: true })).body.code).toBe('restart_unsupported');
    daemon.send({
      type: 'sessionHost.status',
      state: { ...healthy, mode: 'off', canRestart: false },
    });
    await untilAsync(
      async () =>
        (await hub!.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body.machines.find(
          (m) => m.machineId === machineId,
        )?.sessionHost?.mode === 'off',
      '狀態 off',
    );
    expect((await restart(machineId, { confirm: true })).body.code).toBe('session_host_off');

    daemon.close();
    await until(() => !hub!.running.store.getMachine(machineId)!.online, 'offline');
    expect((await restart(machineId, { confirm: true })).body.code).toBe('machine_offline');
    const offline = (
      await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie })
    ).body.machines.find((m) => m.machineId === machineId)!;
    expect(offline.sessionHost).toBeNull();
  });
});
