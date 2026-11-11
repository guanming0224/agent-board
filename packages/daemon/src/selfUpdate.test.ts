// daemon 的自動更新判斷（CONTRACTS §21.3）：延後條件、下載驗證、啟動更新程式、失敗不重試、回滾。
// 下載、解壓、啟動程式都是注入的假函式，不碰網路與系統服務。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseTarget, UpdateState } from '@agent-board/protocol';
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import {
  checkArchive,
  checkExtractedTree,
  EXTRACTED_MARKER,
  hubHttpBase,
  insideRelease,
  readUpdateState,
  SelfUpdater,
  spawnDetached,
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

function harness(
  over: Partial<SelfUpdaterDeps> & { hostProtocol?: number; bundledNode?: string } = {},
) {
  const reports: UpdateState[] = [];
  const spawned: SpawnRequest[] = [];
  const fetches: { url: string; auth: string | null }[] = [];
  let statuses: string[] = [];
  let lockPid: number | null = null;
  let nowMs = Date.now();
  const updater = new SelfUpdater({
    dataDir: data,
    installRoot: root,
    currentVersion: '0.1.0',
    platform: 'darwin-arm64',
    hubUrl: 'wss://hub.example:8443/ws/daemon',
    token: 'machine-token',
    sessionStatuses: () => statuses,
    report: (state) => reports.push(state),
    spawnUpdater: async (request) => {
      spawned.push(request);
    },
    inspectArchive: async () => {},
    lockPid: () => lockPid,
    now: () => new Date(nowMs),
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
      // 像 0.1.1 那樣自帶 Node 的成品（§21.10）：.node-modules-platform 記 bundledNode，runtime/node 裡有執行檔。
      if (over.bundledNode) {
        writeFileSync(
          join(dir, '.node-modules-platform'),
          JSON.stringify({
            platform: 'darwin-arm64',
            node: over.bundledNode,
            modules: '137',
            bundledNode: true,
          }),
        );
        mkdirSync(join(dir, 'runtime', 'node', 'bin'), { recursive: true });
        writeFileSync(join(dir, 'runtime', 'node', 'bin', 'node'), '');
      }
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
    setLock: (next: number | null) => (lockPid = next),
    advance: (ms: number) => (nowMs += ms),
    phases: () => reports.map((r) => r.phase),
  };
}

const inProgress = (over: Partial<UpdateState>): UpdateState => ({
  phase: 'checking',
  fromVersion: '0.1.0',
  toVersion: '0.2.0',
  reason: null,
  detail: null,
  at: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  ...over,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
/**
 * 等到條件成立（下載、算 SHA-256、解壓在慢的 CI 機器上超過 50ms；2026-11-12 Linux CI 停在 downloading）。
 * 最多 10 秒，逾時就照樣往下讓斷言報錯。
 */
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await settle();
};

describe('SelfUpdater', () => {
  it('hub 的 ws 網址換成 http 下載位址', () => {
    expect(hubHttpBase('wss://hub.example:8443/ws/daemon')).toBe('https://hub.example:8443');
    expect(hubHttpBase('ws://100.64.0.1:8787/ws/daemon')).toBe('http://100.64.0.1:8787');
  });

  it('新版：用機器 token 下載、驗 SHA-256、解壓，再從新版裡啟動更新程式', async () => {
    const h = harness({ healthTimeoutMs: 5000 });
    h.updater.onTarget(target(), false);
    await until(() => h.spawned.length > 0);
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
    // 解好的新版有完成標記（W2）；更新程式啟動後開始輪詢狀態檔。
    expect(existsSync(join(root, 'releases', '.incoming', '0.2.0', EXTRACTED_MARKER))).toBe(true);
    expect(readUpdateState(data)?.phase).toBe('installing');
    h.updater.dispose();
  });

  it('SHA-256 不符：失敗、不啟動更新程式、下載檔刪掉', async () => {
    const h = harness();
    h.updater.onTarget(target({ sha256: 'f'.repeat(64) }), false);
    await until(() => h.reports.at(-1)?.phase === 'failed');
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
    await until(() => h.reports.at(-1)?.phase === 'failed');
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

  it('Node（§21.10）：更新程式用安裝時記下的系統 node 跑；0.1.1 留下的自帶 Node 記錄不會讓 RUN 延後', async () => {
    // 0.1.1 的 install.json 記著 sessionHostNode 是 bundled，新版沒有自帶 Node：Node 不同不用換 host，RUN 不擋。
    writeFileSync(
      join(root, 'install.json'),
      JSON.stringify({
        roles: ['daemon'],
        previousVersion: '0.0.9',
        sessionHostProtocol: 1,
        sessionHostNode: 'bundled:24.22.2',
      }),
    );
    const h = harness({ bundledNode: '24.22.2', nodeBin: '/usr/local/bin/node' });
    h.setStatuses(['running']);
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.node).toBe('/usr/local/bin/node');
    h.updater.dispose();

    // 沒給 nodeBin（開發模式）：不指定 node（daemon 自己的）。
    rmSync(join(root, 'releases', '.incoming'), { recursive: true, force: true });
    rmSync(join(data, 'update-state.json'), { force: true });
    const plain = harness();
    plain.updater.onTarget(target(), false);
    await settle();
    expect(plain.spawned[0]!.node).toBeUndefined();
    plain.updater.dispose();
  });

  it('同版、降級、別的平台、目標 null：什麼都不做（降級要 force）', async () => {
    const h = harness();
    h.updater.onTarget(target({ version: '0.1.0' }), false);
    h.updater.onTarget(
      target({ version: '0.0.5', asset: 'agent-board-0.0.5-darwin-arm64.tar.gz' }),
      false,
    );
    h.updater.onTarget(target({ platform: 'win-x64' }), false);
    h.updater.onTarget(null, false);
    await settle();
    expect(h.reports).toEqual([]);
    h.updater.onTarget(
      target({ version: '0.0.5', asset: 'agent-board-0.0.5-darwin-arm64.tar.gz' }),
      true,
    );
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
    // 上一個回滾的狀態（rolling_back）清掉，不然會被當成「更新進行中」（N2）。
    rmSync(join(data, 'update-state.json'));
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

describe('SelfUpdater：卡住的狀態（S1）', () => {
  it('daemon 重啟時狀態還是 downloading：連上 hub 就標 failed/interrupted，之後可以自動重試', async () => {
    await writeUpdateState(data, inProgress({ phase: 'downloading', pid: 1 }));
    const h = harness();
    h.updater.onConnected();
    await settle();
    expect(h.reports[0]).toMatchObject({ phase: 'failed', reason: 'interrupted' });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.spawned).toHaveLength(1);
    h.updater.dispose();
  });

  it('installing 但更新程式的鎖沒人拿著（超過一分鐘）：過期，非 force 也重試', async () => {
    await writeUpdateState(
      data,
      inProgress({ phase: 'installing', at: new Date(Date.now() - 2 * 60_000).toISOString() }),
    );
    const h = harness();
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports[0]).toMatchObject({ phase: 'failed', reason: 'interrupted' });
    expect(h.spawned).toHaveLength(1);
    h.updater.dispose();
  });

  it('更新程式還拿著鎖：30 分鐘也不算過期；超過 60 分鐘的硬上限才算，「立即更新」清掉再做（N2）', async () => {
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    await writeUpdateState(
      data,
      inProgress({ phase: 'checking', pid: 4242, startedAt: at(30), at: at(1) }),
    );
    const h = harness();
    h.setLock(4242);
    h.updater.onTarget(target(), true);
    await settle();
    expect(h.reports).toEqual([]);
    expect(h.spawned).toEqual([]);

    await writeUpdateState(
      data,
      inProgress({ phase: 'checking', pid: 4242, startedAt: at(70), at: at(1) }),
    );
    h.updater.onTarget(target(), true);
    await settle();
    expect(h.reports[0]).toMatchObject({ phase: 'failed', reason: 'interrupted' });
    expect(h.spawned).toHaveLength(1);
    h.updater.dispose();
  });

  it('狀態是更新程式寫的，但鎖已經不是它的（它不在了）：馬上算中斷', async () => {
    await writeUpdateState(data, inProgress({ phase: 'checking', pid: 4242 }));
    const h = harness();
    h.setLock(5353);
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports[0]).toMatchObject({ phase: 'failed', reason: 'interrupted' });
    h.updater.dispose();
  });

  it('真的還在進行（鎖是寫狀態的那個更新程式拿著）：force 也不重複啟動', async () => {
    await writeUpdateState(data, inProgress({ phase: 'checking', pid: 4242 }));
    const h = harness();
    h.setLock(4242);
    h.updater.onTarget(target(), true);
    await settle();
    expect(h.reports).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  it('輪詢沒有時間上限；更新程式不在了就標中斷並停止輪詢', async () => {
    await writeUpdateState(data, inProgress({ phase: 'checking', pid: 4242 }));
    const h = harness();
    h.setLock(4242);
    h.updater.onConnected();
    h.advance(11 * 60_000); // 舊版 10 分鐘就停止輪詢
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(h.reports).toEqual([]);
    h.setLock(null);
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(h.reports.at(-1)).toMatchObject({ phase: 'failed', reason: 'interrupted' });
    h.updater.dispose();
  });
});

describe('SelfUpdater：回滾與進行中的更新（N2）', () => {
  beforeEach(() => {
    writeFileSync(
      join(root, 'install.json'),
      JSON.stringify({
        roles: ['daemon'],
        previousVersion: '0.1.0',
        previousRelease: '0.1.0',
        sessionHostProtocol: 1,
      }),
    );
  });

  it('有更新在跑：回滾不啟動第二個，狀態檔不動', async () => {
    const running = inProgress({ phase: 'checking', pid: 4242 });
    await writeUpdateState(data, running);
    const h = harness();
    h.setLock(4242);
    await h.updater.rollback();
    expect(h.spawned).toEqual([]);
    expect(readUpdateState(data)).toEqual(running);
    expect(h.reports).toEqual([running]);
  });

  it('回滾延後中收到新目標：不取消回滾（面板仍看到延後的回滾）；回滾做完才處理新目標', async () => {
    const h = harness({ deferRetryMs: 150 });
    h.setStatuses(['waiting_permission']);
    await h.updater.rollback();
    expect(h.reports.at(-1)).toMatchObject({ phase: 'deferred', toVersion: '0.1.0' });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.fetches).toEqual([]);
    expect(readUpdateState(data)).toMatchObject({ phase: 'deferred', toVersion: '0.1.0' });
    h.setStatuses([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.args[0]).toBe('rollback');
    h.updater.dispose();
  });

  it('回滾延後中按「立即更新」：明確記成被取代（superseded），再照新目標更新', async () => {
    const h = harness({ deferRetryMs: 60_000 });
    h.setStatuses(['waiting_permission']);
    await h.updater.rollback();
    h.setStatuses([]);
    h.updater.onTarget(target(), true);
    await settle();
    await settle();
    expect(h.reports.some((r) => r.phase === 'idle' && r.reason === 'superseded')).toBe(true);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.args[0]).toBe('update');
    h.updater.dispose();
  });
});

describe('SelfUpdater：啟動更新程式（S2）', () => {
  it('啟動不了更新程式：記成 failed/spawn_failed', async () => {
    const h = harness({
      spawnUpdater: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports.at(-1)).toMatchObject({
      phase: 'failed',
      reason: 'spawn_failed',
      detail: 'spawn ENOENT',
    });
  });

  it('spawnDetached：工作目錄不存在時 reject（不是丟出未處理的 error 事件）；成功時回 pid', async () => {
    const logFile = join(base, 'logs', 'updater.log');
    await expect(
      spawnDetached({ script: '-e', args: [''], cwd: join(base, 'missing'), logFile }),
    ).rejects.toThrow();
    const pid = await spawnDetached({ script: '-e', args: ['0'], cwd: base, logFile });
    expect(pid).toBeGreaterThan(0);
  });
});

describe('SelfUpdater：解壓與成品檢查', () => {
  it('解到一半的新版（沒有完成標記）：整個重新下載（W2）', async () => {
    const half = join(root, 'releases', '.incoming', '0.2.0', 'agent-board');
    mkdirSync(join(half, 'scripts'), { recursive: true });
    writeFileSync(
      join(half, 'package.json'),
      JSON.stringify({ name: 'agent-board-release', version: '0.2.0' }),
    );
    writeFileSync(join(half, 'BUILD_ID'), 'x');
    writeFileSync(join(half, 'scripts', 'updater.mjs'), '');
    const h = harness();
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.fetches).toHaveLength(1);
    expect(h.spawned).toHaveLength(1);
    expect(existsSync(join(root, 'releases', '.incoming', '0.2.0.partial'))).toBe(false);
    h.updater.dispose();
  });

  it('解壓失敗：不留 .partial、不啟動', async () => {
    const h = harness({
      extract: async () => {
        throw new Error('tar exit 1');
      },
    });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports.at(-1)).toMatchObject({ phase: 'failed', reason: 'extract_failed' });
    expect(existsSync(join(root, 'releases', '.incoming'))).toBe(false);
  });

  it('hub 給的成品名稱和版本、平台對不上：不更新（B2）', async () => {
    const h = harness();
    h.updater.onTarget(target({ asset: '../../evil.tar.gz' }), true);
    await settle();
    expect(h.fetches).toEqual([]);
  });

  it('成品內容清單檢查（B4）：路徑要在 agent-board/ 底下，連結不能指出去', async () => {
    expect(insideRelease('agent-board/hub/dist/main.mjs')).toBe(true);
    expect(insideRelease('agent-board/../x')).toBe(false);
    expect(insideRelease('/etc/passwd')).toBe(false);
    expect(insideRelease('C:/x')).toBe(false);
    expect(insideRelease('other/x')).toBe(false);
    expect(insideRelease('agent-board/node_modules/.bin/x', '../pkg/bin.js')).toBe(true);
    expect(insideRelease('agent-board/a', '../../etc')).toBe(false);
    expect(insideRelease('agent-board/a', '/etc/passwd')).toBe(false);

    const make = (name: string, link?: [string, string]) => {
      const dir = join(base, name);
      mkdirSync(join(dir, 'agent-board', 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(dir, 'agent-board', 'node_modules', 'pkg', 'bin.js'), '');
      mkdirSync(join(dir, 'agent-board', 'node_modules', '.bin'), { recursive: true });
      symlinkSync('../pkg/bin.js', join(dir, 'agent-board', 'node_modules', '.bin', 'tool'));
      if (link) symlinkSync(link[1], join(dir, 'agent-board', link[0]));
      const archive = join(base, `${name}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '-C', dir, 'agent-board']);
      return archive;
    };
    // 第一道：tar -tf 的路徑都在 agent-board/ 底下（連結的目標要解開後才看得到）。
    await expect(checkArchive(make('good'))).resolves.toBeUndefined();
    // 第二道（N3）：解開後用 lstat 走整棵樹，symlink 的實際目標要留在 agent-board 裡。
    const extracted = (name: string, link?: [string, string]) => {
      const archive = make(name, link);
      const dest = join(base, `${name}-out`);
      mkdirSync(dest);
      execFileSync('tar', ['-xf', archive, '-C', dest]);
      return dest;
    };
    await expect(checkExtractedTree(extracted('good2'))).resolves.toBeUndefined();
    await expect(checkExtractedTree(extracted('abs', ['escape', '/etc']))).rejects.toThrow(/連結/);
    await expect(checkExtractedTree(extracted('up', ['escape', '../../outside']))).rejects.toThrow(
      /連結/,
    );
    // 指到不存在的地方（懸空）也照連結文字判斷。
    await expect(
      checkExtractedTree(extracted('dangling', ['escape', '../../nowhere/x'])),
    ).rejects.toThrow(/連結/);
    await expect(
      checkExtractedTree(extracted('dangling-in', ['ok', 'node_modules/missing'])),
    ).resolves.toBeUndefined();
  });

  it('解開後發現連結指出去：不寫完成標記、不啟動、記成 extract_failed（N3）', async () => {
    const h = harness({
      extract: async (_archive, dest) => {
        const dir = join(dest, 'agent-board');
        mkdirSync(join(dir, 'scripts'), { recursive: true });
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: 'agent-board-release', version: '0.2.0' }),
        );
        writeFileSync(join(dir, 'BUILD_ID'), 'b2\n');
        writeFileSync(join(dir, 'scripts', 'updater.mjs'), '');
        symlinkSync('/etc', join(dir, 'escape'));
      },
    });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.reports.at(-1)).toMatchObject({ phase: 'failed', reason: 'extract_failed' });
    expect(h.spawned).toEqual([]);
    expect(existsSync(join(root, 'releases', '.incoming'))).toBe(false);
  });
});

describe('SelfUpdater：延後', () => {
  it('更新程式因 session 忙碌寫成 deferred/host_busy：照延後規則再試（W5）', async () => {
    const h = harness({ deferRetryMs: 200 });
    h.updater.onTarget(target(), false);
    await settle();
    expect(h.spawned).toHaveLength(1);
    // 更新程式（假的）把狀態寫成延後。
    await writeUpdateState(
      data,
      inProgress({ phase: 'deferred', reason: 'host_busy', startedAt: undefined }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2_700));
    expect(h.reports.some((r) => r.phase === 'deferred' && r.reason === 'host_busy')).toBe(true);
    expect(h.spawned).toHaveLength(2);
    h.updater.dispose();
  });

  it('手動回滾也看延後條件：有 PERM 延後；上一版要換 session host 而有 RUN 也延後（W6）', async () => {
    writeFileSync(
      join(root, 'install.json'),
      JSON.stringify({
        roles: ['daemon'],
        previousVersion: '0.1.0',
        previousRelease: '0.1.0',
        sessionHostProtocol: 1,
      }),
    );
    mkdirSync(join(root, 'releases', '0.1.0', 'session-host', 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'releases', '0.1.0', 'session-host', 'dist', 'meta.json'),
      JSON.stringify({ protocol: 2 }),
    );
    const h = harness();
    h.setStatuses(['waiting_permission']);
    await h.updater.rollback();
    expect(h.reports.at(-1)).toMatchObject({ phase: 'deferred', reason: 'waiting_permission' });
    h.setStatuses(['running']);
    await h.updater.rollback();
    expect(h.reports.at(-1)).toMatchObject({ phase: 'deferred', reason: 'host_busy' });
    expect(h.spawned).toEqual([]);
    h.setStatuses(['waiting_input']);
    await h.updater.rollback();
    expect(h.spawned).toHaveLength(1);
    h.updater.dispose();
  });
});

describe('SelfUpdater：手動回滾後的保險（M1）', () => {
  it('上次是手動回滾成功、目標是退掉的那一版：非 force 不升回去；force 才升', async () => {
    await writeUpdateState(data, {
      phase: 'succeeded',
      fromVersion: '0.2.0',
      toVersion: '0.1.0',
      reason: 'rollback_requested',
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
    h.updater.dispose();
  });
});
