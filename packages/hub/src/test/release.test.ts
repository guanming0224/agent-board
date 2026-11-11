// 發版與自動更新的 hub 端（CONTRACTS §21）：gh 查／下載／驗證、通道與目標、面板 API、協定相容、下載端點。
// gh 一律是假的（GhRunner 或 PATH 上的假腳本），不打 GitHub。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { hello, startHub, until, type Peer, type TestHub } from './helpers';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

interface FakeRelease {
  version: string;
  files: Record<string, string | Buffer>;
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

describe('目標的限制（S3a、W8、B5）與退避（W9）', () => {
  /** 真的 tar.gz，帶 .node-modules-platform（hub 讀出成品的 ABI 與最低 Node 版本）。 */
  function archiveWithAbi(abi: string, minNode: string | null = null): Buffer {
    const dir = mkdtempSync(join(tmpdir(), 'ab-abi-'));
    mkdirSync(join(dir, 'agent-board'));
    writeFileSync(
      join(dir, 'agent-board', '.node-modules-platform'),
      JSON.stringify({
        platform: 'darwin-arm64',
        node: '24.0.0',
        modules: abi,
        napi: true,
        ...(minNode ? { minNode } : {}),
      }),
    );
    const out = join(dir, 'a.tar.gz');
    execFileSync('tar', ['-czf', out, '-C', dir, 'agent-board']);
    const bytes = readFileSync(out);
    rmSync(dir, { recursive: true, force: true });
    return bytes;
  }

  async function ready(releases: FakeRelease[]) {
    const gh = fakeGh({ releases });
    const ctx = await setup(gh);
    await ctx.hub.api('PATCH', '/api/releases/config', {
      cookie: ctx.cookie,
      body: { repo: 'acme/agent-board' },
    });
    return { ...ctx, gh };
  }

  it('win-x64 還沒實機驗證：hub 照樣下載，但不發目標，面板說明原因', async () => {
    const { hub, cookie } = await ready([release('0.2.0')]);
    await hub.api('POST', '/api/releases/check', { cookie });
    const { daemon, machineId } = await hub.onlineDaemon(
      cookie,
      macHello({ os: 'win32', platform: 'win-x64' }) as never,
    );
    await hub.api('PUT', `/api/machines/${machineId}/channel`, {
      cookie,
      body: { channel: 'canary' },
    });
    expect((await daemon.next('release.target')).target).toBeNull();
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.cached[0]!.platforms).toContain('win-x64');
    expect(overview.body.machines[0]).toMatchObject({
      targetVersion: null,
      targetNote: 'platform_unverified',
    });
  });

  it('N-API：daemon 的 Node ABI 和建置的不同也發目標（不再 abi_mismatch，§21.10）', async () => {
    const r = release('0.2.0');
    r.files[releaseAssetName('0.2.0', 'darwin-arm64')] = archiveWithAbi('137', '22.18');
    const { hub, cookie } = await ready([r]);
    await hub.api('POST', '/api/releases/check', { cookie });
    await hub.api('POST', '/api/releases/promote', {
      cookie,
      body: { version: '0.2.0', confirm: true },
    });
    // MacBook 的 0.1.0 daemon（Node 26，只送 ABI 147）、Mac mini（Node 24）、新 daemon 送 nodeVersion 的都拿得到。
    for (const [name, extra] of [
      ['macbook', { nodeAbi: '147' }],
      ['mac mini', { nodeAbi: '137' }],
      ['new daemon', { nodeAbi: '147', nodeVersion: '26.1.0' }],
    ] as const) {
      const paired = await hub.pair(cookie, name);
      const daemon = await hub.daemon(paired.token);
      daemon.send(macHello(extra));
      expect(releaseOf(await daemon.next('hub.welcome'))).toBe('0.2.0');
    }
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines.every((m) => m.targetNote === null)).toBe(true);
  });

  it('Node 主版本低於成品的最低版本：不發目標（node_too_old）；ABI 推得出主版本的舊 daemon 也一樣', async () => {
    const r = release('0.2.0');
    r.files[releaseAssetName('0.2.0', 'darwin-arm64')] = archiveWithAbi('137', '22.18');
    const { hub, cookie } = await ready([r]);
    await hub.api('POST', '/api/releases/check', { cookie });
    await hub.api('POST', '/api/releases/promote', {
      cookie,
      body: { version: '0.2.0', confirm: true },
    });
    const viaVersion = await hub.onlineDaemon(
      cookie,
      macHello({ nodeVersion: '20.11.0' }) as never,
    );
    const viaAbi = await hub.onlineDaemon(cookie, macHello({ nodeAbi: '115' }) as never);
    const machines = (await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body
      .machines;
    for (const id of [viaVersion.machineId, viaAbi.machineId]) {
      expect(machines.find((m) => m.machineId === id)).toMatchObject({
        targetVersion: null,
        targetNote: 'node_too_old',
      });
    }
  });

  it('舊 hub 驗過的 cache（verified.json 沒有 minNode）：重讀成品補上、寫回，之後照最低版本判斷（§21.10）', async () => {
    const gh = fakeGh({ releases: [] });
    const dir = mkdtempSync(join(tmpdir(), 'ab-cache-'));
    try {
      const asset = releaseAssetName('0.2.0', 'darwin-arm64');
      const versionDir = join(dir, 'release-cache', '0.2.0');
      mkdirSync(versionDir, { recursive: true });
      const bytes = archiveWithAbi('137', '22.18');
      writeFileSync(join(versionDir, asset), bytes);
      const digest = sha(bytes);
      // 0.1.0 的 hub 寫的格式：只有 abi，沒有 minNode。
      writeFileSync(
        join(versionDir, 'verified.json'),
        JSON.stringify({
          version: '0.2.0',
          verifiedAt: '2026-11-11T00:00:00.000Z',
          assets: { 'darwin-arm64': { asset, sha256: digest, size: bytes.length, abi: '137' } },
        }),
      );
      hub = await startHub({ gh: gh.runner, releaseCheckIntervalMs: null, releaseDataDir: dir });
      await hub.running.hub.release.loadCache();
      const rewritten = JSON.parse(readFileSync(join(versionDir, 'verified.json'), 'utf8'));
      expect(rewritten.assets['darwin-arm64']).toMatchObject({ abi: '137', minNode: '22.18' });
      const cookie = await hub.setupOwner();
      await hub.api('POST', '/api/releases/promote', {
        cookie,
        body: { version: '0.2.0', confirm: true },
      });
      const paired = await hub.pair(cookie, 'macbook');
      const daemon = await hub.daemon(paired.token);
      daemon.send(macHello({ nodeAbi: '147' }));
      expect(releaseOf(await daemon.next('hub.welcome'))).toBe('0.2.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('先升 hub：hub 那台還沒到同一版時，其他機器的目標是 null（hub_first），hub 升完才送出', async () => {
    const { hub, cookie } = await ready([release('0.2.0')]);
    await hub.api('POST', '/api/releases/check', { cookie });
    await hub.api('POST', '/api/releases/promote', {
      cookie,
      body: { version: '0.2.0', confirm: true },
    });
    const hubMachine = await hub.pair(cookie, 'mac mini');
    const hubDaemon = await hub.daemon(hubMachine.token);
    hubDaemon.send(macHello({ hostsHub: true }));
    expect(releaseOf(await hubDaemon.next('hub.welcome'))).toBe('0.2.0');
    const other = await hub.pair(cookie, 'laptop');
    const daemon = await hub.daemon(other.token);
    daemon.send(macHello());
    expect((await daemon.next('hub.welcome')).release).toBeNull();
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines.find((m) => m.machineId === other.machineId)).toMatchObject({
      targetNote: 'hub_first',
    });
    // hub 那台升到 0.2.0（重連帶新版本）：其他機器拿到目標。
    hubDaemon.close();
    const again = await hub.daemon(hubMachine.token);
    again.send(macHello({ hostsHub: true, version: '0.2.0' }));
    await again.next('hub.welcome');
    const next = await daemon.next('release.target', (m) => m.target !== null);
    expect((next.target as { version: string }).version).toBe('0.2.0');
  });

  /** stable 0.2.0；hub 那台與一台一般機器。 */
  async function hubAndLaptop(hubHello: object) {
    const ctx = await ready([release('0.2.0')]);
    const { hub, cookie } = ctx;
    await hub.api('POST', '/api/releases/check', { cookie });
    await hub.api('POST', '/api/releases/promote', {
      cookie,
      body: { version: '0.2.0', confirm: true },
    });
    const hubMachine = await hub.pair(cookie, 'mac mini');
    const hubDaemon = await hub.daemon(hubMachine.token);
    hubDaemon.send(macHello({ hostsHub: true, ...hubHello }));
    await hubDaemon.next('hub.welcome');
    const laptop = await hub.pair(cookie, 'laptop');
    return { ...ctx, hubMachine, hubDaemon, laptop };
  }

  const laptopTarget = async (hub: TestHub, token: string) => {
    const daemon = await hub.daemon(token);
    daemon.send(macHello());
    return { daemon, version: releaseOf(await daemon.next('hub.welcome')) };
  };

  it('hub 那台自己拿不到這個目標（Node 太舊、Windows）：其他機器照常拿到（N1）', async () => {
    const r = release('0.2.0');
    r.files[releaseAssetName('0.2.0', 'darwin-arm64')] = archiveWithAbi('137', '22.18');
    const ctx = await ready([r]);
    await ctx.hub.api('POST', '/api/releases/check', { cookie: ctx.cookie });
    await ctx.hub.api('POST', '/api/releases/promote', {
      cookie: ctx.cookie,
      body: { version: '0.2.0', confirm: true },
    });
    await ctx.hub.onlineDaemon(
      ctx.cookie,
      macHello({ hostsHub: true, nodeVersion: '20.11.0' }) as never,
    );
    const laptop = await ctx.hub.pair(ctx.cookie, 'laptop');
    const daemon = await ctx.hub.daemon(laptop.token);
    daemon.send(macHello({ nodeAbi: '137' }));
    expect(releaseOf(await daemon.next('hub.welcome'))).toBe('0.2.0');
  });

  it('hub 那台是 Windows（還沒驗證、拿不到目標）：其他機器照常拿到（N1）', async () => {
    const { hub, laptop } = await hubAndLaptop({ os: 'win32', platform: 'win-x64' });
    expect((await laptopTarget(hub, laptop.token)).version).toBe('0.2.0');
  });

  it('hub 那台離線：其他機器不等它；它上線後又開始擋（N1）', async () => {
    const { hub, hubDaemon, hubMachine, laptop } = await hubAndLaptop({});
    hubDaemon.close();
    await until(() => !hub.running.store.getMachine(hubMachine.machineId)!.online, 'offline');
    const { daemon, version } = await laptopTarget(hub, laptop.token);
    expect(version).toBe('0.2.0');
    const again = await hub.daemon(hubMachine.token);
    again.send(macHello({ hostsHub: true }));
    await again.next('hub.welcome');
    expect((await daemon.next('release.target', (m) => m.target === null)).target).toBeNull();
  });

  it('hub 那台這一版更新失敗（rolled_back）：其他機器繼續暫停，說明是 hub_update_failed', async () => {
    const { hub, cookie, hubDaemon, laptop } = await hubAndLaptop({});
    hubDaemon.send({
      type: 'update.status',
      state: {
        phase: 'rolled_back',
        fromVersion: '0.1.0',
        toVersion: '0.2.0',
        reason: 'health_timeout',
        detail: null,
        at: new Date().toISOString(),
      },
    });
    await until(
      () =>
        hub.running.hub.release.record(
          hub.running.store.listMachines().find((m) => m.name === 'mac mini')!.id,
        ).update?.phase === 'rolled_back',
    );
    expect((await laptopTarget(hub, laptop.token)).version).toBeUndefined();
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines.find((m) => m.machineId === laptop.machineId)).toMatchObject({
      targetNote: 'hub_update_failed',
    });
  });

  it('不再自稱 hub 的機器（舊的 hostsHub 紀錄）不會繼續擋別人（N1）', async () => {
    const { hub, hubDaemon, hubMachine, laptop } = await hubAndLaptop({});
    hubDaemon.close();
    const again = await hub.daemon(hubMachine.token);
    again.send(macHello({ hostsHub: false }));
    await again.next('hub.welcome');
    expect((await laptopTarget(hub, laptop.token)).version).toBe('0.2.0');
  });

  it('更新還在進行：「立即更新」「回滾」回 409 update_in_progress（N2）', async () => {
    const { hub, cookie } = await ready([release('0.2.0')]);
    await hub.api('POST', '/api/releases/check', { cookie });
    const { daemon, machineId } = await hub.onlineDaemon(
      cookie,
      macHello({ previousVersion: '0.1.0' }) as never,
    );
    await hub.api('PUT', `/api/machines/${machineId}/channel`, {
      cookie,
      body: { channel: 'canary' },
    });
    daemon.send({ type: 'update.status', state: inProgressState(new Date()) });
    await until(() => hub.running.hub.release.record(machineId).update?.phase === 'checking');
    for (const action of ['update', 'rollback']) {
      const res = await hub.api('POST', `/api/machines/${machineId}/${action}`, { cookie });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('update_in_progress');
    }
  });

  describe('手動回滾後暫停那一版（M1）', () => {
    /** 0.2.0 是 stable；一台已經在 0.2.0、上一版 0.1.0 的機器。 */
    async function onNew(extra: object = {}) {
      const ctx = await ready([release('0.2.0'), release('0.3.0')]);
      const { hub, cookie, gh } = ctx;
      gh.state.releases = [release('0.2.0')];
      await hub.api('POST', '/api/releases/check', { cookie });
      await hub.api('POST', '/api/releases/promote', {
        cookie,
        body: { version: '0.2.0', confirm: true },
      });
      const machine = await hub.pair(cookie, 'laptop');
      const daemon = await hub.daemon(machine.token);
      daemon.send(macHello({ version: '0.2.0', previousVersion: '0.1.0', ...extra }));
      await daemon.next('hub.welcome');
      return { ...ctx, machine, daemon };
    }

    /** 回滾成功後 daemon 以 0.1.0 重連。 */
    async function rolledBack(
      hub: TestHub,
      cookie: string,
      token: string,
      daemon: Peer,
      extra = {},
    ) {
      const res = await hub.api('POST', `/api/machines/${await machineIdOf(hub, token)}/rollback`, {
        cookie,
      });
      expect(res.status).toBe(200);
      await daemon.next('release.rollback');
      daemon.close();
      const again = await hub.daemon(token);
      again.send(macHello({ version: '0.1.0', previousVersion: '0.2.0', ...extra }));
      return { again, welcome: await again.next('hub.welcome') };
    }

    const machineIdOf = async (hub: TestHub, token: string) =>
      hub.running.store.machineByTokenHash(createHash('sha256').update(token).digest('hex'))!.id;

    it('回滾後重連：目標是 null（rolled_back_hold），不會又升回去', async () => {
      const { hub, cookie, machine, daemon } = await onNew();
      const { welcome } = await rolledBack(hub, cookie, machine.token, daemon);
      expect(welcome.release).toBeNull();
      const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
      expect(overview.body.machines.find((m) => m.machineId === machine.machineId)).toMatchObject({
        targetVersion: null,
        targetNote: 'rolled_back_hold',
      });
    });

    it('按「立即更新」解除暫停（送 force 的 0.2.0）', async () => {
      const { hub, cookie, machine, daemon } = await onNew();
      const { again } = await rolledBack(hub, cookie, machine.token, daemon);
      const res = await hub.api('POST', `/api/machines/${machine.machineId}/update`, { cookie });
      expect(res.status).toBe(200);
      const next = await again.next('release.target', (m) => m.force === true);
      expect((next.target as { version: string }).version).toBe('0.2.0');
      expect(hub.running.store.getRawJson(`machineHold:${machine.machineId}`)).toBeNull();
    });

    it('通道換成別的版本（升了新的 stable）：暫停自動解除', async () => {
      const { hub, cookie, gh, machine, daemon } = await onNew();
      const { again } = await rolledBack(hub, cookie, machine.token, daemon);
      gh.state.releases = [release('0.2.0'), release('0.3.0')];
      await hub.api('POST', '/api/releases/check', { cookie });
      await hub.api('POST', '/api/releases/promote', {
        cookie,
        body: { version: '0.3.0', confirm: true },
      });
      const next = await again.next('release.target', (m) => m.target !== null);
      expect((next.target as { version: string }).version).toBe('0.3.0');
      expect(hub.running.store.getRawJson(`machineHold:${machine.machineId}`)).toBeNull();
    });

    it('hub 那台被暫停：視同拿不到目標，其他機器不卡 hub_first', async () => {
      const { hub, cookie, machine, daemon } = await onNew({ hostsHub: true });
      await rolledBack(hub, cookie, machine.token, daemon, { hostsHub: true });
      const other = await hub.pair(cookie, 'other');
      const otherDaemon = await hub.daemon(other.token);
      otherDaemon.send(macHello());
      expect(releaseOf(await otherDaemon.next('hub.welcome'))).toBe('0.2.0');
    });
  });

  it('canary 版本和 hub 那台（stable）不同：不用等 hub', async () => {
    const { hub, cookie } = await ready([release('0.2.0')]);
    await hub.api('POST', '/api/releases/check', { cookie });
    await hub.onlineDaemon(cookie, macHello({ hostsHub: true }) as never);
    const other = await hub.pair(cookie, 'laptop');
    await hub.api('PUT', `/api/machines/${other.machineId}/channel`, {
      cookie,
      body: { channel: 'canary' },
    });
    const daemon = await hub.daemon(other.token);
    daemon.send(macHello());
    expect(releaseOf(await daemon.next('hub.welcome'))).toBe('0.2.0');
  });

  it('同一版下載失敗：自動檢查照退避跳過，手動檢查不受限；成功後清掉', async () => {
    let now = new Date('2026-11-11T00:00:00Z');
    const bad = release('0.2.0');
    bad.sums = 'nothing useful';
    const gh = fakeGh({ releases: [bad] });
    const { hub, cookie } = await setup(gh, () => now);
    await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
    const downloads = () => gh.calls.filter((c) => c[1] === 'download').length;
    await hub.running.hub.release.check(); // 自動：第一次照下載
    expect(downloads()).toBe(1);
    await hub.running.hub.release.check(); // 自動：10 分鐘內跳過
    expect(downloads()).toBe(1);
    now = new Date(now.getTime() + 11 * 60_000);
    await hub.running.hub.release.check(); // 自動：10 分鐘後再試，失敗 → 下次等 20 分鐘
    expect(downloads()).toBe(2);
    now = new Date(now.getTime() + 15 * 60_000);
    await hub.running.hub.release.check();
    expect(downloads()).toBe(2);
    await hub.api('POST', '/api/releases/check', { cookie }); // 手動不受限
    expect(downloads()).toBe(3);
    bad.sums = undefined;
    await hub.api('POST', '/api/releases/check', { cookie });
    expect((await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body.canary).toBe(
      '0.2.0',
    );
    expect(hub.running.store.getRawJson('release.fetchFailure')).toBeNull();
  });

  it('release-cache 裡下載到一半的暫存在重新讀 cache 時清掉', async () => {
    const gh = fakeGh({ releases: [] });
    const dir = mkdtempSync(join(tmpdir(), 'ab-cache-'));
    try {
      mkdirSync(join(dir, 'release-cache', '.download-0.2.0-abcd'), { recursive: true });
      hub = await startHub({ gh: gh.runner, releaseCheckIntervalMs: null, releaseDataDir: dir });
      await hub.running.hub.release.loadCache();
      expect(existsSync(join(dir, 'release-cache', '.download-0.2.0-abcd'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('上一版是 0.0.0-legacy：不能從面板回滾（previous_unsupported），面板 canRollback false', async () => {
    const { hub, cookie } = await ready([]);
    const { machineId } = await hub.onlineDaemon(
      cookie,
      macHello({ previousVersion: '0.0.0-legacy' }) as never,
    );
    const res = await hub.api('POST', `/api/machines/${machineId}/rollback`, { cookie });
    expect(res.body.code).toBe('previous_unsupported');
    const overview = await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie });
    expect(overview.body.machines[0]!.canRollback).toBe(false);
  });

  it('卡在進行中太久的狀態不能讓之後的斷線都被當成預期的（S1）', async () => {
    let now = new Date('2026-11-11T00:00:00Z');
    const gh = fakeGh({ releases: [release('0.2.0')] });
    const { hub, cookie } = await setup(gh, () => now);
    await hub.api('PATCH', '/api/releases/config', { cookie, body: { repo: 'acme/agent-board' } });
    await hub.api('POST', '/api/releases/check', { cookie });
    const { daemon, machineId, token } = await hub.onlineDaemon(cookie, macHello() as never);
    await hub.api('PUT', `/api/machines/${machineId}/channel`, {
      cookie,
      body: { channel: 'canary' },
    });
    daemon.send({
      type: 'update.status',
      state: { ...inProgressState(now), phase: 'checking' },
    });
    await until(() => hub.running.hub.release.record(machineId).update?.phase === 'checking');
    daemon.close();
    await until(() => !hub.running.store.getMachine(machineId)!.online);
    let stats = (await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body
      .canaryStats;
    expect(stats.disconnects).toBe(0); // 更新中的斷線：預期的
    now = new Date(now.getTime() + 70 * 60_000);
    const again = await hub.daemon(token);
    again.send(macHello({ update: undefined }));
    await again.next('hub.welcome');
    again.close();
    await until(() => !hub.running.store.getMachine(machineId)!.online);
    stats = (await hub.api<ReleaseOverview>('GET', '/api/releases', { cookie })).body.canaryStats;
    expect(stats.disconnects).toBe(1);
  });
});

const releaseOf = (welcome: Record<string, unknown>) =>
  (welcome.release as { version?: string } | null)?.version;

const inProgressState = (now: Date): UpdateState => ({
  phase: 'checking',
  fromVersion: '0.1.0',
  toVersion: '0.2.0',
  reason: null,
  detail: null,
  at: now.toISOString(),
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
