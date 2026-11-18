// 新增 session 的推理強度、備援模型與模型清單（GM 2026-11-17，CONTRACTS §26）：
// 驗證、存法（settings `sessionModelOpts:<id>`，不升 schema）、接續沿用、舊 daemon 不送、模型清單的權限、spawn_member 的沿用。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_FEATURES,
  MODEL_LISTS_DEFAULT,
  type Session,
  type SessionSpec,
} from '@agent-board/protocol';
import { capabilities, type Peer, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const CWD = '/fake/project';
const CLAUDE_ID = '00000000-0000-4000-8000-0000000000aa';
const NEW_FEATURES = [
  DAEMON_FEATURES.signalGuard,
  DAEMON_FEATURES.codex,
  DAEMON_FEATURES.modelOptions,
];
const get = (id: string) => hub.running.store.getSession(id);

async function setup(features: string[] = NEW_FEATURES, claudeFlags?: unknown) {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie, {
    features,
    ...(claudeFlags === undefined ? {} : { capabilities: { ...capabilities, claudeFlags } }),
  });
  const create = (over: Partial<SessionSpec> = {}) =>
    hub.api<Session & { code?: string }>('POST', '/api/sessions', {
      cookie,
      body: { ...spec({ cwd: CWD, ...over }), machineId },
    });
  return { cookie, daemon, machineId, create };
}

const optsRows = () =>
  (
    hub.running.store.db
      .prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'sessionModelOpts:%'")
      .get() as { n: number }
  ).n;

describe('建立 session 的推理強度與備援模型', () => {
  it('送給 daemon、記在 settings 表、session 帶出來；接續照舊帶；刪除時一起清', async () => {
    const { cookie, daemon, create } = await setup();
    const res = await create({ model: 'opus', effort: 'xhigh', fallbackModel: 'sonnet' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'opus', effort: 'xhigh', fallbackModel: 'sonnet' });
    const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(sent.spec).toMatchObject({ model: 'opus', effort: 'xhigh', fallbackModel: 'sonnet' });
    expect(get(res.body.id)).toMatchObject({ effort: 'xhigh', fallbackModel: 'sonnet' });
    expect(optsRows()).toBe(1);
    // settings API 看不到這個內部鍵。
    const settings = await hub.api('GET', '/api/settings', { cookie });
    expect(JSON.stringify(settings.body)).not.toContain('sessionModelOpts');

    // 沒指定的 session 沒有這兩個欄位、不寫列。
    const plain = await create({ name: 'plain' });
    expect(plain.body.effort).toBeUndefined();
    expect(plain.body.fallbackModel).toBeUndefined();
    expect(optsRows()).toBe(1);

    daemon.send({
      type: 'session.runtime',
      session: runtime(res.body.id, {
        status: 'done',
        endedAt: new Date().toISOString(),
        claudeSessionId: CLAUDE_ID,
      }),
    });
    await until(() => get(res.body.id)?.endedAt !== null, 'ended');
    const resumed = await hub.api('POST', `/api/sessions/${res.body.id}/resume`, { cookie });
    expect(resumed.status).toBe(200);
    const again = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(again.spec).toMatchObject({
      resumeClaudeSessionId: CLAUDE_ID,
      model: 'opus',
      effort: 'xhigh',
      fallbackModel: 'sonnet',
    });

    hub.running.store.deleteSession(res.body.id);
    expect(optsRows()).toBe(0);
  });

  it('Codex：強度用 Codex 的白名單，帶出去；備援不支援', async () => {
    const { daemon, create } = await setup();
    const res = await create({ agent: 'codex', model: 'gpt-6-luna', effort: 'minimal' });
    expect(res.status).toBe(200);
    const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(sent.spec).toMatchObject({ agent: 'codex', effort: 'minimal' });

    const fallback = await create({ agent: 'codex', fallbackModel: 'gpt-6-luna' });
    expect(fallback.status).toBe(400);
    expect(fallback.body.code).toBe('fallback_unsupported');
  });

  it('不合的值 400：強度不屬於那個 agent、聯集外的字、不安全的模型名稱、備援和主模型相同', async () => {
    const { daemon, create } = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ effort: 'minimal' }, 'invalid_effort'],
      [{ effort: 'ultra' }, 'invalid_effort'],
      [{ effort: 'turbo' }, 'invalid_request'],
      [{ model: 'opus; rm -rf /' }, 'invalid_model'],
      [{ model: '--dangerously-skip-permissions' }, 'invalid_model'],
      [{ fallbackModel: 'a b' }, 'invalid_request'],
      [{ model: 'opus', fallbackModel: 'opus' }, 'fallback_same_as_model'],
    ];
    for (const [over, code] of cases) {
      const res = await create(over as Partial<SessionSpec>);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.code, JSON.stringify(over)).toBe(code);
    }
    expect(daemon.of('session.create')).toHaveLength(0);
    expect(hub.running.store.listSessions()).toHaveLength(0);
  });

  it('舊 daemon（hello 沒有 session.modelOptions）：不送、不記，session 照開', async () => {
    const { daemon, create } = await setup([DAEMON_FEATURES.signalGuard]);
    const res = await create({ model: 'opus', effort: 'high', fallbackModel: 'sonnet' });
    expect(res.status).toBe(200);
    expect(res.body.effort).toBeUndefined();
    expect(res.body.fallbackModel).toBeUndefined();
    const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(sent.spec).toMatchObject({ model: 'opus' });
    expect(sent.spec).not.toHaveProperty('effort');
    expect(sent.spec).not.toHaveProperty('fallbackModel');
    expect(optsRows()).toBe(0);
  });
});

describe('這台 claude 認不認得（§26.10）與補救', () => {
  const end = async (daemon: Peer, id: string) => {
    daemon.send({
      type: 'session.runtime',
      session: runtime(id, {
        status: 'error',
        endedAt: new Date().toISOString(),
        claudeSessionId: CLAUDE_ID,
      }),
    });
    await until(() => get(id)?.endedAt !== null, 'ended');
  };

  it('偵測不到 claude 參數（claudeFlags null）：強度與備援都不送、不記，Codex 的強度照送', async () => {
    const { daemon, create } = await setup(NEW_FEATURES, null);
    const res = await create({ model: 'opus', effort: 'high', fallbackModel: 'sonnet' });
    expect(res.status).toBe(200);
    expect(res.body.effort).toBeUndefined();
    const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(sent.spec).not.toHaveProperty('effort');
    expect(sent.spec).not.toHaveProperty('fallbackModel');
    expect(optsRows()).toBe(0);
    const codex = await create({ agent: 'codex', effort: 'minimal' });
    const sentCodex = await daemon.next('session.create', (m) => m.sessionId === codex.body.id);
    expect(sentCodex.spec).toMatchObject({ effort: 'minimal' });
  });

  it('說明只列到 high、備援只能配 --print：max 與備援拿掉，high 照送', async () => {
    const { daemon, create } = await setup(NEW_FEATURES, {
      effort: true,
      efforts: ['low', 'medium', 'high'],
      fallbackModel: false,
    });
    const max = await create({ effort: 'max', fallbackModel: 'sonnet' });
    const sentMax = await daemon.next('session.create', (m) => m.sessionId === max.body.id);
    expect(sentMax.spec).not.toHaveProperty('effort');
    expect(sentMax.spec).not.toHaveProperty('fallbackModel');
    const high = await create({ name: 'high', effort: 'high' });
    const sentHigh = await daemon.next('session.create', (m) => m.sessionId === high.body.id);
    expect(sentHigh.spec).toMatchObject({ effort: 'high' });
    expect(get(high.body.id)?.effort).toBe('high');
  });

  it('接續時那台 claude 已經不認得：不送、清掉記錄並推給畫面', async () => {
    const { cookie, daemon, machineId, create } = await setup();
    const res = await create({ effort: 'xhigh', fallbackModel: 'sonnet' });
    await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    await end(daemon, res.body.id);
    // daemon 重新連上：claude 換成舊版（偵測不到 --effort 與 --fallback-model）。
    hub.running.store.machineHello(
      machineId,
      'linux',
      { ...capabilities, claudeFlags: { effort: false, efforts: null, fallbackModel: false } },
      new Date().toISOString(),
    );
    const client = await hub.client(cookie);
    const resumed = await hub.api('POST', `/api/sessions/${res.body.id}/resume`, { cookie });
    expect(resumed.status).toBe(200);
    const again = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(again.spec).not.toHaveProperty('effort');
    expect(again.spec).not.toHaveProperty('fallbackModel');
    expect(get(res.body.id)?.effort).toBeUndefined();
    await client.next(
      'session.updated',
      (m) =>
        (m.session as Session).id === res.body.id &&
        (m.session as Session).effort === undefined &&
        (m.session as Session).fallbackModel === undefined,
    );
  });

  it('備援比對不分大小寫；Vertex 的 @ 名稱可以用', async () => {
    const { create } = await setup();
    const same = await create({ model: 'opus', fallbackModel: 'OPUS' });
    expect(same.status).toBe(400);
    expect(same.body.code).toBe('fallback_same_as_model');
    const vertex = await create({ model: 'claude-opus-4-1@20250805' });
    expect(vertex.status).toBe(200);
  });

  it('補救：舊資料的模型名稱不合，接續回 409 invalid_model；owner 清掉模型或強度與備援後可以接續', async () => {
    const { cookie, daemon, create } = await setup();
    const res = await create({ model: 'opus', effort: 'high', fallbackModel: 'sonnet' });
    await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    const id = res.body.id;
    // 執行中不能改。
    const active = await hub.api('POST', `/api/sessions/${id}/model-reset`, {
      cookie,
      body: { options: true },
    });
    expect(active.status).toBe(409);
    await end(daemon, id);
    hub.running.store.setSessionModel(id, 'old model with spaces');
    const blocked = await hub.api('POST', `/api/sessions/${id}/resume`, { cookie });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('invalid_model');

    const member = await hub.createMember(cookie);
    const denied = await hub.api('POST', `/api/sessions/${id}/model-reset`, {
      cookie: member.cookie,
      body: { model: true },
    });
    expect(denied.status).toBe(403);
    expect(
      (await hub.api('POST', `/api/sessions/${id}/model-reset`, { cookie, body: {} })).status,
    ).toBe(400);

    const reset = await hub.api<Session>('POST', `/api/sessions/${id}/model-reset`, {
      cookie,
      body: { model: true, options: true },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.model).toBeNull();
    expect(reset.body.effort).toBeUndefined();
    expect(optsRows()).toBe(0);
    const resumed = await hub.api('POST', `/api/sessions/${id}/resume`, { cookie });
    expect(resumed.status).toBe(200);
    const again = await daemon.next('session.create', (m) => m.sessionId === id);
    expect(again.spec).toMatchObject({ model: null });
    expect(again.spec).not.toHaveProperty('effort');
  });
});

describe('模型清單（settings modelLists）', () => {
  it('預設是內建清單；一般使用者讀得到 /api/model-lists、改不了；owner 改的會去空白去重', async () => {
    const { cookie } = await setup();
    const member = await hub.createMember(cookie);
    const read = await hub.api('GET', '/api/model-lists', { cookie: member.cookie });
    expect(read.status).toBe(200);
    expect(read.body).toEqual(MODEL_LISTS_DEFAULT);
    expect((await hub.api('GET', '/api/model-lists')).status).toBe(401);

    const denied = await hub.api('PATCH', '/api/settings', {
      cookie: member.cookie,
      body: { modelLists: { claude: ['opus'], codex: [] } },
    });
    expect(denied.status).toBe(403);

    const saved = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { modelLists: { claude: ['opus', 'claude-opus-5-5', 'opus'], codex: [] } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.modelLists).toEqual({ claude: ['opus', 'claude-opus-5-5'], codex: [] });
    expect((await hub.api('GET', '/api/model-lists', { cookie: member.cookie })).body).toEqual({
      claude: ['opus', 'claude-opus-5-5'],
      codex: [],
    });

    // 存別的設定不會把清單改回預設（SettingsPatch 沒有預設值）。
    await hub.api('PATCH', '/api/settings', { cookie, body: { dispatch: false } });
    expect(hub.running.store.getSettings().modelLists.claude).toEqual(['opus', 'claude-opus-5-5']);

    const bad = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { modelLists: { claude: ['bad name'], codex: [] } },
    });
    expect(bad.status).toBe(400);
  });

  it('隱藏／釘選（§26.11）：存得進去、一般使用者讀得到、整理去重、又釘又藏以釘選為準；舊格式照讀', async () => {
    const { cookie } = await setup();
    const member = await hub.createMember(cookie);
    const saved = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: {
        modelLists: {
          claude: [],
          codex: ['my-model'],
          pinned: {
            claude: ['claude-opus-5-5', 'Claude-Opus-5-5', 'sonnet'],
            codex: ['gpt-6-luna'],
          },
          hidden: { claude: ['haiku', 'sonnet'], codex: ['codex-auto-review'] },
        },
      },
    });
    expect(saved.status).toBe(200);
    const expected = {
      claude: [],
      codex: ['my-model'],
      pinned: { claude: ['claude-opus-5-5', 'sonnet'], codex: ['gpt-6-luna'] },
      hidden: { claude: ['haiku'], codex: ['codex-auto-review'] },
    };
    expect(saved.body.modelLists).toEqual(expected);
    expect((await hub.api('GET', '/api/model-lists', { cookie: member.cookie })).body).toEqual(
      expected,
    );
    // 存別的設定不動它；hub 重新讀（settings 表）也一樣。
    await hub.api('PATCH', '/api/settings', { cookie, body: { dispatch: false } });
    expect(hub.running.store.getSettings().modelLists).toEqual(expected);
    // 舊網頁分頁只送 claude／codex：釘選與隱藏沿用存著的，不會被清掉（審查 10）。
    const old = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { modelLists: { claude: ['opus'], codex: [] } },
    });
    expect(old.body.modelLists).toEqual({
      claude: ['opus'],
      codex: [],
      pinned: expected.pinned,
      hidden: expected.hidden,
    });
    const bad = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { modelLists: { claude: [], codex: [], hidden: { claude: ['a b'], codex: [] } } },
    });
    expect(bad.status).toBe(400);
  });
});

async function ask(daemon: Peer, sessionId: string, tool: string, args: Record<string, unknown>) {
  const requestId = randomUUID();
  daemon.send({ type: 'dispatch.request', requestId, sessionId, tool, args });
  const reply = await daemon.next('dispatch.reply', (m) => m.requestId === requestId);
  return { ok: reply.ok as boolean, text: reply.text as string };
}

type Create = Awaited<ReturnType<typeof setup>>['create'];

async function startLead(daemon: Peer, create: Create, over: Partial<SessionSpec>) {
  const res = await create({ name: 'Lead', permissionMode: 'acceptEdits', ...over });
  expect(res.status).toBe(200);
  const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
  daemon.send({
    type: 'session.created',
    requestId: sent.requestId,
    session: runtime(res.body.id, { status: 'waiting_input', cwd: CWD, repoRoot: CWD }),
  });
  await until(() => get(res.body.id)?.status === 'waiting_input', 'lead started');
  return res.body.id;
}

async function spawn(daemon: Peer, caller: string, args: Record<string, unknown>) {
  const reply = await ask(daemon, caller, 'spawn_member', { reason: 'Need it.', ...args });
  if (!reply.ok) return { reply, spec: null };
  const body = JSON.parse(reply.text) as Record<string, unknown>;
  const create = await daemon.next(
    'session.create',
    (m) => (m.spec as SessionSpec).name === body.name,
  );
  return { reply, spec: create.spec as SessionSpec };
}

describe('spawn_member 的 effort', () => {
  it('沒指定沿用隊長的強度與備援；指定就照用；換 agent 不沿用；白名單外回 invalid_effort', async () => {
    const { daemon, create } = await setup();
    const lead = await startLead(daemon, create, {
      model: 'opus',
      effort: 'high',
      fallbackModel: 'sonnet',
    });

    const same = await spawn(daemon, lead, { role: 'researcher', prompt: 'Look.' });
    expect(same.spec).toMatchObject({ model: 'opus', effort: 'high', fallbackModel: 'sonnet' });

    const named = await spawn(daemon, lead, {
      role: 'researcher',
      prompt: 'Think.',
      effort: 'max',
    });
    expect(named.spec).toMatchObject({ effort: 'max' });

    // 成員的主模型就是隊長的備援：備援不帶（claude 不接受相同的）。
    const asFallback = await spawn(daemon, lead, {
      role: 'researcher',
      prompt: 'Cheap.',
      model: 'sonnet',
    });
    expect(asFallback.spec?.model).toBe('sonnet');
    expect(asFallback.spec).not.toHaveProperty('fallbackModel');

    // 每隊 10 分鐘最多加 4 位：Codex 的部分換另一位隊長（另一隊）。
    const lead2 = await startLead(daemon, create, {
      name: 'Lead 2',
      model: 'opus',
      effort: 'high',
      fallbackModel: 'sonnet',
    });
    const codex = await spawn(daemon, lead2, {
      role: 'reviewer',
      prompt: 'Review.',
      agent: 'codex',
    });
    expect(codex.spec).toMatchObject({ agent: 'codex', model: null });
    expect(codex.spec).not.toHaveProperty('effort');
    expect(codex.spec).not.toHaveProperty('fallbackModel');

    const codexNamed = await spawn(daemon, lead2, {
      role: 'reviewer',
      prompt: 'Review 2.',
      agent: 'codex',
      effort: 'minimal',
    });
    expect(codexNamed.spec).toMatchObject({ agent: 'codex', effort: 'minimal' });

    const bad = await spawn(daemon, lead2, {
      role: 'reviewer',
      prompt: 'Nope.',
      effort: 'ultra',
    });
    expect(bad.reply.ok).toBe(false);
    expect(bad.reply.text).toMatch(/^invalid_effort:.*Claude.*low, medium, high, xhigh, max\./);
  });
});

describe('Codex 強度依模型目錄（§26.11）', () => {
  const CATALOG = {
    codexVersion: '0.167.0',
    models: [
      {
        slug: 'gpt-6.2-sol',
        displayName: 'GPT-6.2-Sol',
        defaultEffort: 'low',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        visibility: 'list',
      },
      {
        slug: 'gpt-6-luna',
        displayName: 'GPT-6-Luna',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        visibility: 'list',
      },
    ],
  };
  const BY_MODEL = [...NEW_FEATURES, DAEMON_FEATURES.codexEffortsByModel];

  async function setupCatalog(features: string[] = BY_MODEL) {
    hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie, {
      features,
      capabilities: { ...capabilities, codexVersion: '0.167.0', codexModels: CATALOG },
    });
    const create = (over: Partial<SessionSpec> = {}) =>
      hub.api<Session & { code?: string; message?: string }>('POST', '/api/sessions', {
        cookie,
        body: { ...spec({ cwd: CWD, ...over }), machineId },
      });
    return { cookie, daemon, machineId, create };
  }

  it('目錄有列：只收它支援的（ultra 給 gpt-6.2-sol 可以、給 gpt-6-luna 400）；不指定模型＝list 模型交集；不在目錄＝舊安全集合', async () => {
    const { daemon, machineId, create } = await setupCatalog();
    // capabilities 原樣存著（網頁讀得到）。
    expect(hub.running.store.getMachine(machineId)?.capabilities.codexModels).toEqual(CATALOG);
    const ok = await create({ agent: 'codex', model: 'gpt-6.2-sol', effort: 'ultra' });
    expect(ok.status).toBe(200);
    expect(
      (await daemon.next('session.create', (m) => m.sessionId === ok.body.id)).spec,
    ).toMatchObject({
      effort: 'ultra',
    });
    const bad = await create({ agent: 'codex', model: 'GPT-6-LUNA', effort: 'ultra' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_effort');
    expect(bad.body.message).toMatch(/supported: low, medium, high, xhigh, max/);
    const minimal = await create({ agent: 'codex', model: 'gpt-6-luna', effort: 'minimal' });
    expect(minimal.status).toBe(400);
    // 不 fail-open（審查 3）：Codex 預設模型只收兩個 list 模型都支援的；不在目錄的只收舊安全集合。
    for (const over of [
      { agent: 'codex' as const, model: null, effort: 'ultra' as const },
      { agent: 'codex' as const, model: 'gpt-unknown', effort: 'xhigh' as const },
    ]) {
      const res = await create(over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.code).toBe('invalid_effort');
    }
    for (const over of [
      { agent: 'codex' as const, model: 'gpt-unknown', effort: 'high' as const },
      { agent: 'codex' as const, model: null, effort: 'xhigh' as const },
    ]) {
      const res = await create(over);
      expect(res.status, JSON.stringify(over)).toBe(200);
      const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
      expect(sent.spec).toMatchObject({ effort: over.effort });
    }
  });

  it('daemon.capabilities（審查 2）：背景抓完的目錄換上、之後依新目錄擋；session.modelOptionsDropped：清掉記錄', async () => {
    const { daemon, machineId, create } = await setupCatalog();
    const before = await create({ agent: 'codex', model: 'gpt-6-luna', effort: 'max' });
    expect(before.status).toBe(200);
    await daemon.next('session.create', (m) => m.sessionId === before.body.id);
    // 目錄更新：gpt-6-luna 只剩 low～high。
    daemon.send({
      type: 'daemon.capabilities',
      capabilities: {
        ...capabilities,
        codexVersion: '0.168.0',
        codexModels: {
          codexVersion: '0.168.0',
          models: [{ ...CATALOG.models[1], efforts: ['low', 'medium', 'high'] }],
        },
      },
    });
    await until(
      () => hub.running.store.getMachine(machineId)?.capabilities.codexVersion === '0.168.0',
      'capabilities updated',
    );
    const after = await create({ agent: 'codex', model: 'gpt-6-luna', effort: 'max' });
    expect(after.status).toBe(400);
    // daemon 開的時候沒帶（目錄在 hub 知道前就變了）：清掉 session 記著的強度。
    expect(get(before.body.id)?.effort).toBe('max');
    daemon.send({
      type: 'session.modelOptionsDropped',
      sessionId: before.body.id,
      effort: true,
      fallbackModel: false,
    });
    await until(() => get(before.body.id)?.effort === undefined, 'effort cleared');
    expect(optsRows()).toBe(0);
  });

  it('舊 daemon（沒宣告 session.codexEffortsByModel）：xhigh／ultra 不送、不記，minimal～high 照送', async () => {
    const { daemon, create } = await setupCatalog(NEW_FEATURES);
    const res = await create({ agent: 'codex', model: 'gpt-6.2-sol', effort: 'ultra' });
    expect(res.status).toBe(200);
    expect(res.body.effort).toBeUndefined();
    const sent = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
    expect(sent.spec).not.toHaveProperty('effort');
    expect(optsRows()).toBe(0);
    const high = await create({ agent: 'codex', model: 'gpt-6.2-sol', effort: 'high' });
    const sentHigh = await daemon.next('session.create', (m) => m.sessionId === high.body.id);
    expect(sentHigh.spec).toMatchObject({ effort: 'high' });
  });

  it('spawn_member：指定成員模型不支援的強度回 invalid_effort；沿用隊長的不支援就不帶', async () => {
    const { daemon, create } = await setupCatalog();
    const lead = await startLead(daemon, create, {
      agent: 'codex',
      model: 'gpt-6.2-sol',
      effort: 'ultra',
    });
    const same = await spawn(daemon, lead, { role: 'researcher', prompt: 'Look.' });
    expect(same.spec).toMatchObject({ agent: 'codex', model: 'gpt-6.2-sol', effort: 'ultra' });
    const luna = await spawn(daemon, lead, {
      role: 'researcher',
      prompt: 'Cheap.',
      model: 'gpt-6-luna',
    });
    expect(luna.spec).toMatchObject({ model: 'gpt-6-luna' });
    expect(luna.spec).not.toHaveProperty('effort');
    const bad = await spawn(daemon, lead, {
      role: 'researcher',
      prompt: 'Nope.',
      model: 'gpt-6-luna',
      effort: 'ultra',
    });
    expect(bad.reply.ok).toBe(false);
    expect(bad.reply.text).toMatch(/^invalid_effort:.*gpt-6-luna/);
    // 參數錯誤不留下空團隊（仍是隊長原本那一隊）。
    expect(hub.running.store.listTeams()).toHaveLength(1);
  });
});
