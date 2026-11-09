// Codex 節點（CONTRACTS §19）：只送給宣告 agent.codex 的 daemon、agent 存 settings 表、接續帶回 agent、
// Claude 的限流不擋 Codex。
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_FEATURES, type Session } from '@agent-board/protocol';
import { runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const THREAD = '0199a3c2-1111-7000-8000-000000000abc';
const codexFeatures = [DAEMON_FEATURES.signalGuard, DAEMON_FEATURES.codex];

async function setup(features: string[] = codexFeatures) {
  hub = await startHub();
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie, { features });
  const create = (over: object = {}) =>
    hub.api<Session & { code?: string }>('POST', '/api/sessions', {
      cookie,
      body: { ...spec(over), machineId },
    });
  return { cookie, daemon, machineId, create };
}

describe('Codex session', () => {
  it('daemon 沒宣告 agent.codex（舊版或沒裝 codex）：409 codex_unavailable，不送 session.create', async () => {
    const { daemon, create } = await setup([DAEMON_FEATURES.signalGuard]);
    const res = await create({ agent: 'codex' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('codex_unavailable');
    expect(daemon.of('session.create')).toHaveLength(0);
  });

  it('Codex 不支援帳號資料夾：400', async () => {
    const { create } = await setup();
    const res = await create({ agent: 'codex', accountProfile: '/Users/someone/.claude-2' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('codex_account_profile');
  });

  it('建立：spec 帶 agent codex；Session.agent 存起來，hub 重讀、清單都看得到；刪除時一起清掉', async () => {
    const { cookie, daemon, create } = await setup();
    const res = await create({ agent: 'codex', firstPrompt: '回答 ok' });
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe('codex');
    const sent = await daemon.next('session.create');
    expect(sent.spec).toMatchObject({ agent: 'codex', firstPrompt: '回答 ok' });

    const listed = (await hub.api<Session[]>('GET', '/api/sessions', { cookie })).body;
    expect(listed.find((s) => s.id === res.body.id)?.agent).toBe('codex');
    expect(hub.running.store.getSession(res.body.id)?.agent).toBe('codex');
    // settings API 看不到這個內部鍵。
    const settings = (await hub.api<Record<string, unknown>>('GET', '/api/settings', { cookie }))
      .body;
    expect(JSON.stringify(settings)).not.toContain('sessionAgent');

    // Claude session 沒有 agent 欄位（舊資料同樣）。
    const claude = await create();
    expect(claude.body.agent).toBeUndefined();

    hub.running.store.deleteSession(res.body.id);
    const left = hub.running.store.db
      .prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'sessionAgent:%'")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('接續：送 agent codex＋thread id', async () => {
    const { cookie, daemon, create } = await setup();
    const created = (await create({ agent: 'codex' })).body;
    await daemon.next('session.create');
    daemon.send({
      type: 'session.runtime',
      session: runtime(created.id, {
        status: 'done',
        endedAt: new Date().toISOString(),
        claudeSessionId: THREAD,
      }),
    });
    await until(() => hub.running.store.getSession(created.id)?.endedAt !== null, 'ended');
    const res = await hub.api('POST', `/api/sessions/${created.id}/resume`, { cookie });
    expect(res.status).toBe(200);
    const again = await daemon.next('session.create');
    expect(again.spec).toMatchObject({ agent: 'codex', resumeClaudeSessionId: THREAD });
  });

  it('Claude 限流不擋 Codex（額度是不同的方案）', async () => {
    const { daemon, create } = await setup();
    const claude = (await create()).body;
    await daemon.next('session.create');
    daemon.send({
      type: 'session.runtime',
      session: runtime(claude.id, { status: 'rate_limited', statusDetail: 'usage limit' }),
    });
    await until(
      () => hub.running.store.getSession(claude.id)?.status === 'rate_limited',
      'rate limited',
    );
    // 同帳號的 Claude 會排隊，Codex 照開。
    expect((await create()).body.status).toBe('queued');
    expect((await create({ agent: 'codex' })).body.status).toBe('starting');
  });
});
