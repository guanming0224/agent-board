// 發版與自動更新的 hub 端（CONTRACTS §21）：gh 查／下載／驗證、通道與目標、面板 API、協定相容、下載端點。
// gh 一律是假的（GhRunner 或 PATH 上的假腳本），不打 GitHub。
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  releaseAssetName,
  type ReleaseOverview,
  type UpdateState,
} from '@agent-board/protocol';
import { CLOSE_INCOMPATIBLE } from '../hub';
import { execGh, type GhResult, type GhRunner } from '../release';
import { hello, startHub, until, type TestHub } from './helpers';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

interface FakeRelease {
  version: string;
  files: Record<string, string>;
  sums?: string;
}

/** 假 gh：記錄參數，依登入狀態與假 Release 回應；download 把檔案寫到 --dir。 */
function fakeGh(state: { missing?: boolean; loggedIn?: boolean; releases: FakeRelease[] }) {
  const calls: string[][] = [];
  const ok = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '', missing: false });
  const runner: GhRunner = async (args) => {
    calls.push(args);
    if (state.missing) return { code: null, stdout: '', stderr: '', missing: true };
    if (args[0] === 'auth') {
      return state.loggedIn === false
        ? {
            code: 1,
            stdout: '',
            stderr: 'You are not logged into any GitHub hosts.',
            missing: false,
          }
        : ok();
    }
    if (args[0] === 'release' && args[1] === 'list') {
      return ok(
        JSON.stringify(state.releases.map((r) => ({ tagName: `v${r.version}`, isDraft: false }))),
      );
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const release = state.releases.find((r) => `v${r.version}` === args[2]);
      if (!release) return { code: 1, stdout: '', stderr: 'release not found', missing: false };
      const dir = args[args.indexOf('--dir') + 1]!;
      for (const [name, content] of Object.entries(release.files))
        writeFileSync(join(dir, name), content);
      const sums =
        release.sums ??
        Object.entries(release.files)
          .map(([name, content]) => `${sha(content)}  ${name}`)
          .join('\n');
      writeFileSync(join(dir, 'SHA256SUMS'), `${sums}\n`);
      return ok();
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}`, missing: false };
  };
  return { runner, calls, state };
}

const release = (version: string): FakeRelease => ({
  version,
  files: {
    [releaseAssetName(version, 'darwin-arm64')]: `mac ${version}`,
    [releaseAssetName(version, 'win-x64')]: `win ${version}`,
  },
});

let hub: TestHub | null = null;
afterEach(async () => {
  await hub?.stop();
  hub = null;
});

async function setup(gh: ReturnType<typeof fakeGh>, now?: () => Date) {
  hub = await startHub({
    gh: gh.runner,
    releaseCheckIntervalMs: null,
    ...(now ? { now } : {}),
  });
  const cookie = await hub.setupOwner();
  return { hub, cookie };
}

const macHello = (over: object = {}) =>
  hello({
    os: 'darwin',
    version: '0.1.0',
    platform: 'darwin-arm64',
    protocolVersion: PROTOCOL_VERSION,
    buildId: 'b1',
    ...over,
  });

describe('檢查新版', () => {
  it('沒設 repo 不叫 gh，面板顯示 no_repo', async () => {
    const gh = fakeGh({ releases: [release('0.2.0')] });
    const { hub, cookie } = await setup(gh);
    const res = await hub.api<ReleaseOverview>('POST', '/api/releases/check', { cookie });
    expect(res.status).toBe(200);
    expect(res.body.gh.state).toBe('no_repo');
    expect(gh.calls).toEqual([]);
  });

  it('gh 不存在、沒登入：清楚回報，hub 其他功能照常', async () => {
    const gh = fakeGh({ missing: true, releases: [] });
    const { hub, cookie } = await setup(gh);
    await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
    let res = await hub.api<ReleaseOverview>('POST', '/api/releases/check', { cookie });
    expect(res.body.gh.state).toBe('missing');
    expect(res.body.lastCheckError).toBe('gh_missing');
    gh.state.missing = false;
    gh.state.loggedIn = false;
    res = await hub.api<ReleaseOverview>('POST', '/api/releases/check', { cookie });
    expect(res.body.gh.state).toBe('not_logged_in');
    expect(res.body.gh.message).toContain('not logged');
    expect((await hub.api('GET', '/api/machines', { cookie })).status).toBe(200);
  });

  it('新 tag：下載、驗 SHA-256、設為 canary、audit；再查一次不重下載', async () => {
    const gh = fakeGh({ releases: [release('0.1.0'), release('0.2.0')] });
    const { hub, cookie } = await setup(gh);
    await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
    const res = await hub.api<ReleaseOverview>('POST', '/api/releases/check', { cookie });
    expect(res.body.gh.state).toBe('ok');
    expect(res.body.canary).toBe('0.2.0');
    expect(res.body.stable).toBeNull();
    expect(res.body.cached).toEqual([{ version: '0.2.0', platforms: ['darwin-arm64', 'win-x64'] }]);
    expect(res.body.canaryStats.since).not.toBeNull();
    const cached = join(
      hub.dir,
      'release-cache',
      '0.2.0',
      releaseAssetName('0.2.0', 'darwin-arm64'),
    );
    expect(readFileSync(cached, 'utf8')).toBe('mac 0.2.0');
    const download = gh.calls.find((c) => c[1] === 'download')!;
    expect(download).toContain('--repo');
    expect(download).toContain('acme/agent-board');
    const audit = await hub.api('GET', '/api/audit?action=release.canary', { cookie });
    expect(JSON.stringify(audit.body)).toContain('0.2.0');
    const downloads = gh.calls.filter((c) => c[1] === 'download').length;
    await hub.api('POST', '/api/releases/check', { cookie });
    expect(gh.calls.filter((c) => c[1] === 'download').length).toBe(downloads);
  });

  it('SHA-256 不符：不進 cache、不改 canary、記錯誤', async () => {
    const bad = release('0.3.0');
    bad.sums = Object.keys(bad.files)
      .map((name) => `${'0'.repeat(64)}  ${name}`)
      .join('\n');
    const gh = fakeGh({ releases: [bad] });
    const { hub, cookie } = await setup(gh);
    await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
    const res = await hub.api<ReleaseOverview>('POST', '/api/releases/check', { cookie });
    expect(res.body.canary).toBeNull();
    expect(res.body.cached).toEqual([]);
    expect(res.body.lastCheckError).toContain('SHA-256 mismatch');
  });

  it('只有 owner 能檢查、改 repo', async () => {
    const gh = fakeGh({ releases: [] });
    const { hub, cookie } = await setup(gh);
    const member = await hub.createMember(cookie);
    expect((await hub.api('POST', '/api/releases/check', { cookie: member.cookie })).status).toBe(
      403,
    );
    expect((await hub.api('GET', '/api/releases', { cookie: member.cookie })).status).toBe(200);
    expect(
      (await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'not a repo' } }))
        .status,
    ).toBe(400);
  });

  it('execGh 拿掉環境裡的 GH_TOKEN 等權杖，只用 gh 自己登入的憑證', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-fake-gh-'));
    const fake = join(dir, 'gh');
    writeFileSync(fake, '#!/bin/sh\nenv | grep -E "^(GH_|GITHUB_)" | sort\n');
    chmodSync(fake, 0o755);
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    process.env.GH_TOKEN = 'leak-1';
    process.env.GITHUB_TOKEN = 'leak-2';
    try {
      const result = await execGh(fake)(['auth', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain('leak');
      expect(result.stdout).toContain('GH_PROMPT_DISABLED=1');
      expect((await execGh(join(dir, 'missing'))(['auth'])).missing).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('通道、目標與 daemon', () => {
  async function withCanary() {
    const gh = fakeGh({ releases: [release('0.2.0')] });
    const ctx = await setup(gh);
    await ctx.hub.api('PATCH', '/api/releases/config', {
      cookie: ctx.cookie,
      body: { repo: 'acme/agent-board' },
    });
    return ctx;
  }

  it('canary 機器在 welcome 拿到目標；stable 機器沒有；切通道立刻送 release.target', async () => {
    const { hub, cookie } = await withCanary();
    const { machineId, token } = await hub.pair(cookie);
    const daemon = await hub.daemon(token);
    daemon.send(macHello());
    const welcome = await daemon.next('hub.welcome');
    expect(welcome.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(welcome.release).toBeNull();
    await hub.api('POST', '/api/releases/check', { cookie });
    // 新 canary 送給連著的 daemon，但這台是 stable：目標仍是 null。
    expect((await daemon.next('release.target')).target).toBeNull();
    const res = await hub.api<ReleaseOverview>('PUT', `/api/machines/${machineId}/channel`, {
      cookie,
      body: { channel: 'canary' },
    });
    expect(res.body.machines[0]!.channel).toBe('canary');
    const target = await daemon.next('release.target');
    expect(target.force).toBe(false);
    expect(target.target).toMatchObject({
      version: '0.2.0',
      platform: 'darwin-arm64',
      asset: releaseAssetName('0.2.0', 'darwin-arm64'),
      sha256: sha('mac 0.2.0'),
    });
    // 立即更新：force。
    await hub.api('POST', `/api/machines/${machineId}/update`, { cookie });
    expect((await daemon.next('release.target')).force).toBe(true);
  });

  it('下載端點：機器 token 驗證，只給 cache 裡驗過的檔', async () => {
    const { hub, cookie } = await withCanary();
    await hub.api('POST', '/api/releases/check', { cookie });
    const { token } = await hub.pair(cookie);
    const get = (path: string, auth?: string) =>
      fetch(`${hub.url}${path}`, auth ? { headers: { authorization: `Bearer ${auth}` } } : {});
    expect((await get('/api/releases/0.2.0/darwin-arm64')).status).toBe(401);
    expect((await get('/api/releases/0.2.0/darwin-arm64', 'wrong')).status).toBe(401);
    // 登入的瀏覽器 cookie 也不行（只給 daemon）。
    const asUser = await fetch(`${hub.url}/api/releases/0.2.0/darwin-arm64`, {
      headers: { cookie },
    });
    expect(asUser.status).toBe(401);
    const ok = await get('/api/releases/0.2.0/darwin-arm64', token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-agent-board-sha256')).toBe(sha('mac 0.2.0'));
    expect(await ok.text()).toBe('mac 0.2.0');
    expect((await get('/api/releases/0.9.9/darwin-arm64', token)).status).toBe(404);
    expect((await get('/api/releases/0.2.0/linux-x64', token)).status).toBe(404);
    expect((await get('/api/releases/..%2F..%2Fhub.db/darwin-arm64', token)).status).toBe(404);
  });

  it('升為 stable：不到 24 小時要 confirm；stable 機器拿到目標', async () => {
    let now = new Date('2026-11-11T00:00:00Z');
    const gh = fakeGh({ releases: [release('0.2.0')] });
    const { hub, cookie } = await setup(gh, () => now);
    await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
    await hub.api('POST', '/api/releases/check', { cookie });
    const early = await hub.api('POST', '/api/releases/promote', {
      cookie,
      body: { version: '0.2.0' },
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('canary_too_new');
    expect(
      (await hub.api('POST', '/api/releases/promote', { cookie, body: { version: '0.9.0' } })).body
        .code,
    ).toBe('not_cached');
    now = new Date('2026-11-12T00:00:01Z');
    const { daemon } = await hub.onlineDaemon(cookie, macHello() as never);
    const res = await hub.api<ReleaseOverview>('POST', '/api/releases/promote', {
      cookie,
      body: { version: '0.2.0' },
    });
    expect(res.status).toBe(200);
    expect(res.body.stable).toBe('0.2.0');
    expect(((await daemon.next('release.target')).target as { version: string }).version).toBe(
      '0.2.0',
    );
  });

  it('協定版本差太多：daemon.rejected 帶可更新的版本並斷線，面板顯示需要更新', async () => {
    const { hub, cookie } = await withCanary();
    await hub.api('POST', '/api/releases/check', { cookie });
    const { machineId, token } = await hub.pair(cookie);
    await hub.api('PUT', `/api/machines/${machineId}/channel`, {
      cookie,
      body: { channel: 'canary' },
    });
    const daemon = await hub.daemon(token);
    daemon.send(macHello({ protocolVersion: PROTOCOL_VERSION + 5 }));
    const rejected = await daemon.next('daemon.rejected');
    expect(rejected.reason).toBe('hub_too_old');
    expect(await daemon.closed()).toBe(CLOSE_INCOMPATIBLE);
    // 沒有 welcome、機器沒上線。
    expect(daemon.of('hub.welcome')).toEqual([]);
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines[0]).toMatchObject({ compat: 'hub_too_old', online: false });
  });

  it('舊 daemon（沒有 protocolVersion）照樣接受', async () => {
    const { hub, cookie } = await withCanary();
    const { daemon } = await hub.onlineDaemon(cookie);
    expect(daemon.closeCode).toBeNull();
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines[0]).toMatchObject({ compat: 'ok', platform: null });
  });

  it('更新失敗：面板標失敗、推播只帶機器名稱與代碼、同一次失敗只推一次', async () => {
    const { hub, cookie } = await withCanary();
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: true, coalesce: false, quietHours: null } },
    });
    await hub.api('POST', '/api/push/subscriptions', {
      cookie,
      body: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    const { daemon, machineId, token } = await hub.onlineDaemon(cookie, macHello() as never);
    const failed: UpdateState = {
      phase: 'rolled_back',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      reason: 'health_timeout',
      detail: 'secret detail should not be pushed',
      at: new Date().toISOString(),
    };
    daemon.send({ type: 'update.status', state: failed });
    await until(() => hub.push.sent.length === 1, 'push');
    const payload = JSON.parse(hub.push.sent[0]!.payload);
    expect(payload).toMatchObject({
      kind: 'update_failed',
      machineId,
      machine: 'fake-machine',
      version: '0.2.0',
      phase: 'rolled_back',
      reason: 'health_timeout',
    });
    expect(hub.push.sent[0]!.payload).not.toContain('secret detail');
    daemon.send({ type: 'update.status', state: failed });
    // 重連的 hello 帶同一個結果：不重推。
    daemon.close();
    const again = await hub.daemon(token);
    again.send(macHello({ update: failed }));
    await again.next('hub.welcome');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hub.push.sent.length).toBe(1);
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines[0]!.update).toMatchObject({ phase: 'rolled_back' });
  });

  it('回滾：不知道上一版回 409；有的話送 release.rollback；離線回 machine_offline', async () => {
    const { hub, cookie } = await withCanary();
    const { daemon, machineId } = await hub.onlineDaemon(cookie, macHello() as never);
    const none = await hub.api('POST', `/api/machines/${machineId}/rollback`, { cookie });
    expect(none.body.code).toBe('no_previous');
    daemon.close();
    await until(() => !hub.running.store.getMachine(machineId)!.online, 'offline');
    const offline = await hub.api('POST', `/api/machines/${machineId}/rollback`, { cookie });
    expect(offline.body.code).toBe('machine_offline');
  });
});

describe('健康檢查', () => {
  it('/api/health 不用登入，回版本與協定', async () => {
    const gh = fakeGh({ releases: [] });
    hub = await startHub({
      gh: gh.runner,
      releaseCheckIntervalMs: null,
      version: { version: '9.8.7', buildId: 'abc' },
    });
    const res = await hub.api('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      version: '9.8.7',
      buildId: 'abc',
      protocolVersion: PROTOCOL_VERSION,
    });
  });
});

describe('release-cache 重啟後還在', () => {
  it('hub 重開後讀回驗過的版本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-release-restart-'));
    const dbPath = join(dir, 'hub.db');
    try {
      const gh = fakeGh({ releases: [release('0.2.0')] });
      let h = await startHub({ dbPath, gh: gh.runner, releaseCheckIntervalMs: null });
      const cookie = await h.setupOwner();
      await h.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
      await h.api('POST', '/api/releases/check', { cookie });
      await h.running.close();
      h = await startHub({ dbPath, gh: gh.runner, releaseCheckIntervalMs: null });
      const login = await h.api('POST', '/api/auth/login', {
        body: { name: 'owner', password: 'correct horse battery' },
      });
      const cookie2 = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      const res = await h.api<ReleaseOverview>('GET', '/api/releases', { cookie: cookie2 });
      expect(res.body.canary).toBe('0.2.0');
      expect(res.body.cached.map((c) => c.version)).toEqual(['0.2.0']);
      await h.running.close();
    } finally {
      mkdirSync(dir, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
