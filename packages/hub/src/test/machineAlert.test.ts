// 審查 W3：daemon 報的機器警示（session host 證明不了自己、hook pipe 被占）寫進 audit，同一台同一種一小時一次。
import { afterEach, describe, expect, it } from 'vitest';
import { startHub, type TestHub } from './helpers';

let hub: TestHub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

const until = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('daemon.alert', () => {
  it('寫 audit machine.alert（機器名稱、代碼、說明），同一種一小時內只記一次', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const entries = async () =>
      (await hub!.api('GET', '/api/audit?action=machine.alert', { cookie })).body as {
        detail: string;
      }[];
    daemon.send({
      type: 'daemon.alert',
      code: 'session_host_unauthorized',
      message: 'session host 證明不了自己',
    });
    daemon.send({
      type: 'daemon.alert',
      code: 'session_host_unauthorized',
      message: 'session host 證明不了自己',
    });
    daemon.send({ type: 'daemon.alert', code: 'hook_pipe_squatted', message: 'hook pipe 被占' });
    await until(async () => (await entries()).length === 2, '兩則警示');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const details = (await entries()).map((e) => JSON.parse(e.detail) as Record<string, string>);
    expect(details.map((d) => d.code).sort()).toEqual([
      'hook_pipe_squatted',
      'session_host_unauthorized',
    ]);
    expect(details.every((d) => d.machineId === machineId)).toBe(true);
  });
});
