// daemon 的自動更新判斷（CONTRACTS §21.3）：延後條件、下載驗證、啟動更新程式、失敗不重試、回滾。
// 下載、解壓、啟動程式都是注入的假函式，不碰網路與系統服務。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseTarget, UpdateState } from '@agent-board/protocol';
import {
  hubHttpBase,
  readUpdateState,
  SelfUpdater,
  writeUpdateState,
  type SelfUpdaterDeps,
  type SpawnRequest,
} from './selfUpdate';

const ARCHIVE = 'fake archive bytes';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let base: string;
let root: string;
let data: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ab-selfupdate-'));
  root = join(base, 'install');
  data = join(base, 'data');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'install.json'),
    JSON.stringify({ roles: ['daemon'], previousVersion: '0.0.9', sessionHostProtocol: 1 }),
  );
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const target = (over: Partial<ReleaseTarget> = {}): ReleaseTarget => ({
  version: '0.2.0',
  platform: 'darwin-arm64',
  asset: 'agent-board-0.2.0-darwin-arm64.tar.gz',
  sha256: sha(ARCHIVE),
  size: ARCHIVE.length,
  ...over,
});

function harness(over: Partial<SelfUpdaterDeps> & { hostProtocol?: number } = {}) {
  const reports: UpdateState[] = [];
  const spawned: SpawnRequest[] = [];
  const fetches: { url: string; auth: string | null }[] = [];
  let statuses: string[] = [];
  const updater = new SelfUpdater({
    dataDir: data,
    installRoot: root,
    currentVersion: '0.1.0',
    platform: 'darwin-arm64',
    hubUrl: 'wss://hub.example:8443/ws/daemon',
    token: 'machine-token',
    sessionStatuses: () => statuses,
    report: (state) => reports.push(state),
    spawnUpdater: (request) => spawned.push(request),
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new Response(ARCHIVE);
    }) as typeof fetch,
    // 假解壓：寫出一份最小的發布檔。
    extract: async (_archive, dest) => {
      const dir = join(dest, 'agent-board');
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'session-host', 'dist'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'agent-board-release', version: '0.2.0' }),
      );
      writeFileSync(join(dir, 'BUILD_ID'), 'b2\n');
      writeFileSync(join(dir, 'scripts', 'updater.mjs'), '');
      writeFileSync(
        join(dir, 'session-host', 'dist', 'meta.json'),
        JSON.stringify({ protocol: over.hostProtocol ?? 1 }),
      );
    },
    deferRetryMs: 60_000,
    ...over,
  });
  return {
    updater,
    reports,
    spawned,
    fetches,
    setStatuses: (next: string[]) => (statuses = next),
    phases: () => reports.map((r) => r.phase),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('SelfUpdater', () => {
  it('hub 的 ws 網址換成 http 下載位址', () => {
    expect(hubHttpBase('wss://hub.example:8443/ws/daemon')).toBe('https://hub.example:8443');
    expect(hubHttpBase('ws://100.64.0.1:8787/ws/daemon')).toBe('http://100.64.0.1:8787');
  });

  it('新版：用機器 token 下載、驗 SHA-256、解壓，再從新版裡啟動更新程式', async () => {
    const h = harness({ healthTimeoutMs: 5000 });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.fetches).toEqual([
      {
        url: 'https://hub.example:8443/api/releases/0.2.0/darwin-arm64',
        auth: 'Bearer machine-token',
      },
    ]);
    expect(h.phases()).toEqual(['downloading', 'installing']);
    expect(h.spawned).toHaveLength(1);
    const request = h.spawned[0]!;
    const source = join(root, 'releases', '.incoming', '0.2.0', 'agent-board');
    expect(request.script).toBe(join(source, 'scripts', 'updater.mjs'));
    expect(request.args).toEqual([
      'update',
      '--source',
      source,
      '--to',
      '0.2.0',
      '--from',
      '0.1.0',
      '--data',
      data,
      '--root',
      root,
      '--health-timeout-ms',
      '5000',
    ]);
    expect(readUpdateState(data)?.phase).toBe('installing');
    h.updater.dispose();
  });

  it('SHA-256 不符：失敗、不啟動更新程式、下載檔刪掉', async () => {
    const h = harness();
    h.updater.onTarget(target({ sha256: 'f'.repeat(64) }), false);
    await settle();
    expect(h.spawned).toEqual([]);
    expect(h.reports.at(-1)).toMatchObject({ phase: 'failed', reason: 'checksum_mismatch' });
    expect(() =>
      readFileSync(join(root, 'releases', '.incoming', 'agent-board-0.2.0-darwin-arm64.tar.gz')),
    ).toThrow();
  });

  it('下載失敗（HTTP 404）回報 download_failed', async () => {
    const h = harness({
      fetch: (async () => new Response('nope', { status: 404 })) as typeof fetch,
    });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'download_failed',
      detail: 'HTTP 404',
    });
  });

  it('有 PERM 延後（不下載），5 分鐘後再看；PERM 沒了就更新', async () => {
    const h = harness({ deferRetryMs: 30 });
    h.setStatuses(['running', 'waiting_permission']);
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports[0]).toMatchObject({ phase: 'deferred', reason: 'waiting_permission' });
    expect(h.fetches).toEqual([]);
    h.setStatuses(['running']);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.spawned).toHaveLength(1);
    h.updater.dispose();
  });

  it('要換 session host（協定變了）而有 RUN：延後；不換就不擋 RUN', async () => {
    const h = harness({ hostProtocol: 2 });
    h.setStatuses(['running']);
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports.at(-1)).toMatchObject({ phase: 'deferred', reason: 'host_busy' });
    expect(h.spawned).toEqual([]);
    h.updater.dispose();

    // 延後時解開的新版留著（下次不用重下載）；這裡換一份協定相同的新版。
    rmSync(join(root, 'releases', '.incoming'), { recursive: true, force: true });
    const same = harness({ hostProtocol: 1 });
    same.setStatuses(['running']);
    same.updater.onTarget(target(), false);
    await settle();
    expect(same.spawned).toHaveLength(1);
    same.updater.dispose();
  });

  it('同版、降級、別的平台、目標 null：什麼都不做（降級要 force）', async () => {
    const h = harness();
    h.updater.onTarget(target({ version: '0.1.0' }), false);
    h.updater.onTarget(target({ version: '0.0.5' }), false);
    h.updater.onTarget(target({ platform: 'win-x64' }), false);
    h.updater.onTarget(null, false);
    await settle();
    expect(h.reports).toEqual([]);
    h.updater.onTarget(target({ version: '0.0.5' }), true);
    await settle();
    expect(h.fetches).toHaveLength(1);
  });

  it('上次在這版失敗過（回滾）：不自動重試；按「立即更新」（force）才再試', async () => {
    await writeUpdateState(data, {
      phase: 'rolled_back',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      reason: 'health_timeout',
      detail: null,
      at: new Date().toISOString(),
    });
    const h = harness();
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.fetches).toEqual([]);
    h.updater.onTarget(target(), true);
    await settle();
    expect(h.spawned).toHaveLength(1);
  });

  it('更新程式還在跑（狀態檔是 installing）：不重複啟動', async () => {
    await writeUpdateState(data, {
      phase: 'checking',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      reason: null,
      detail: null,
      at: new Date().toISOString(),
    });
    const h = harness();
    h.updater.onTarget(target(), true);
    await settle();
    expect(h.fetches).toEqual([]);
  });

  it('開發模式（沒有安裝根目錄）：只回報 not_installed，不推播（phase idle），同一版不重複回報', async () => {
    const h = harness({ installRoot: null });
    h.updater.onTarget(target(), false);
    await settle();
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({ phase: 'idle', reason: 'not_installed' });
    expect(h.fetches).toEqual([]);
  });

  it('回滾：用 current 裡的更新程式；不知道上一版就失敗', async () => {
    const h = harness();
    expect(h.updater.previousVersion).toBe('0.0.9');
    await h.updater.rollback();
    expect(h.spawned[0]!.script).toBe(join(root, 'current', 'scripts', 'updater.mjs'));
    expect(h.spawned[0]!.args.slice(0, 1)).toEqual(['rollback']);
    expect(h.reports[0]).toMatchObject({ phase: 'rolling_back', toVersion: '0.0.9' });

    writeFileSync(join(root, 'install.json'), JSON.stringify({ roles: ['daemon'] }));
    const none = harness();
    await none.updater.rollback();
    expect(none.spawned).toEqual([]);
    expect(none.reports[0]).toMatchObject({ phase: 'failed', reason: 'no_previous' });
  });

  it('連上 hub 時更新還在進行：輪詢狀態檔，結果出來就回報', async () => {
    await writeUpdateState(data, {
      phase: 'checking',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      reason: null,
      detail: null,
      at: new Date().toISOString(),
    });
    const h = harness();
    h.updater.onConnected();
    await writeUpdateState(data, {
      phase: 'succeeded',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      reason: null,
      detail: null,
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(h.phases()).toEqual(['succeeded']);
    h.updater.dispose();
  });
});
