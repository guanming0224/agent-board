// demo／e2e 用的機器面板資料（發版與自動更新，docs/release-update-spec.md §7）。
// canary 0.1.1（6 小時前，升 stable 要再確認一次）、stable 0.1.0；三台 demo 機器：
//   demo-gpu（Windows）canary 已是最新（owner 打開了「允許自動更新」）；demo-studio stable、有 session 在等你允許
//   所以延後；demo-laptop 更新失敗已回滾（離線）。新配對的 Windows 機器預設不自動更新（platform_unverified）。
// 按鈕會真的改這份資料，規則照 hub 的（protocol/release.ts 與 rest.ts 的錯誤碼）。
import {
  CANARY_SOAK_MS,
  channelTarget,
  compareVersions,
  PROTOCOL_VERSION,
  UNVERIFIED_PLATFORMS,
  updateDeferReason,
  type Machine,
  type MachineRelease,
  type ReleaseChannel,
  type ReleaseOverview,
  type UpdateState,
} from '@agent-board/protocol';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60_000;

/** 和 hub 一樣的錯誤形狀（status、code），畫面才能分辨。 */
const apiError = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code });

interface DemoRelease {
  os: MachineRelease['os'];
  platform: string;
  version: string;
  buildId: string;
  previousVersion: string | null;
  channel: ReleaseChannel;
  hasHub: boolean;
  update: UpdateState | null;
  /** 未驗證平台（win-x64）的「允許自動更新」（hub 的 settings `machineAllowUnverified:<id>`）。 */
  allowUnverified?: boolean;
}

/** 更新動畫（下載 → 安裝 → 檢查 → 成功）每一步的時間；e2e 不想等可以改小。 */
export const FAKE_UPDATE_STEP_MS = 800;

export function createFakeReleases(
  machines: () => Machine[],
  /** 這台機器上 session 的狀態（延後條件：有 PERM 就延後）。 */
  statusesOf: (machineId: string) => string[] = () => [],
) {
  let canary: string | null = '0.1.1';
  let stable: string | null = '0.1.0';
  let repo: string | null = 'demo-owner/agent-board';
  let canarySince: string | null = ago(6 * HOUR);
  let lastCheckAt: string | null = ago(8 * 60_000);
  const cached = [
    { version: '0.1.1', platforms: ['darwin-arm64', 'win-x64'] },
    { version: '0.1.0', platforms: ['darwin-arm64', 'win-x64'] },
  ];
  const demo = new Map<string, DemoRelease>([
    [
      'm-gpu',
      {
        os: 'win32',
        platform: 'win-x64',
        version: '0.1.1',
        buildId: '7c1e9a40d2b3f5e6a7b8c9d0',
        previousVersion: '0.1.0',
        channel: 'canary',
        hasHub: false,
        // Windows 還沒實機驗證：hub 預設不發，owner 對這台打開了「允許自動更新」才拿到 0.1.1。
        allowUnverified: true,
        update: {
          phase: 'succeeded',
          fromVersion: '0.1.0',
          toVersion: '0.1.1',
          reason: null,
          detail: null,
          at: ago(6 * HOUR),
        },
      },
    ],
    [
      'm-studio',
      {
        os: 'darwin',
        platform: 'darwin-arm64',
        version: '0.0.9',
        buildId: '3f2a1b0c9d8e7f6a5b4c3d2e',
        previousVersion: '0.0.8',
        channel: 'stable',
        hasHub: true,
        update: {
          phase: 'deferred',
          fromVersion: '0.0.9',
          toVersion: '0.1.0',
          reason: 'waiting_permission',
          detail: null,
          at: ago(3 * 60_000),
        },
      },
    ],
    [
      'm-laptop',
      {
        os: 'darwin',
        platform: 'darwin-arm64',
        version: '0.1.0',
        buildId: 'a9b8c7d6e5f4a3b2c1d0e9f8',
        previousVersion: null,
        channel: 'canary',
        hasHub: false,
        update: {
          phase: 'rolled_back',
          fromVersion: '0.1.0',
          toVersion: '0.1.1',
          reason: 'health_timeout',
          detail: 'daemon did not report the new version within 60s',
          at: ago(5 * HOUR),
        },
      },
    ],
  ]);

  const entry = (machine: Machine): DemoRelease => {
    let found = demo.get(machine.id);
    if (!found) {
      // 新配對的機器（demo 裡也能配對）：stable、還沒更新過。
      found = {
        os: machine.os,
        platform: machine.os === 'win32' ? 'win-x64' : `${machine.os}-arm64`,
        version: stable ?? '0.1.0',
        buildId: '0000000000000000',
        previousVersion: null,
        channel: 'stable',
        hasHub: false,
        update: null,
      };
      demo.set(machine.id, found);
    }
    return found;
  };

  const unverified = (r: DemoRelease) => UNVERIFIED_PLATFORMS.includes(r.platform);
  /** 和 hub 一樣：未驗證平台沒打開「允許自動更新」就不發（platform_unverified）。 */
  const target = (r: DemoRelease) =>
    (r.platform === 'darwin-arm64' || r.platform === 'win-x64') &&
    !(unverified(r) && !r.allowUnverified)
      ? channelTarget(r.channel, { canary, stable })
      : null;
  const targetNote = (r: DemoRelease) =>
    unverified(r) && !r.allowUnverified ? ('platform_unverified' as const) : null;

  const overview = (): ReleaseOverview => ({
    hub: {
      version: '0.0.9',
      buildId: '3f2a1b0c9d8e7f6a5b4c3d2e',
      protocolVersion: PROTOCOL_VERSION,
    },
    repo,
    gh: repo ? { state: 'ok', message: null } : { state: 'no_repo', message: null },
    canary,
    stable,
    canaryStats: { since: canarySince, errors: 1, disconnects: 0, updateFailures: 1 },
    cached,
    lastCheckAt,
    lastCheckError: null,
    checking: false,
    machines: machines().map((machine) => {
      const r = entry(machine);
      return {
        machineId: machine.id,
        name: machine.name,
        os: r.os,
        online: machine.online,
        lastSeenAt: machine.lastSeenAt,
        platform: r.platform,
        version: r.version,
        buildId: r.buildId,
        protocolVersion: PROTOCOL_VERSION,
        previousVersion: r.previousVersion,
        channel: r.channel,
        targetVersion: target(r),
        targetNote: targetNote(r),
        canRollback: r.previousVersion !== null,
        compat: 'ok',
        hasHub: r.hasHub,
        update: r.update,
        unverifiedPlatform: unverified(r),
        allowUnverified: r.allowUnverified === true,
      };
    }),
  });

  const online = (id: string) => {
    const machine = machines().find((m) => m.id === id);
    if (!machine) throw apiError(404, 'not_found', 'machine not found');
    if (!machine.online) throw apiError(409, 'machine_offline', 'machine is offline');
    return entry(machine);
  };

  const state = (
    r: DemoRelease,
    phase: UpdateState['phase'],
    over: Partial<UpdateState> = {},
  ): UpdateState => ({
    phase,
    fromVersion: r.version,
    toVersion: r.update?.toVersion ?? null,
    reason: null,
    detail: null,
    at: new Date().toISOString(),
    ...over,
  });

  /** 假的更新流程：一步一步換 phase，最後換版本。 */
  const run = (r: DemoRelease, to: string, steps: UpdateState['phase'][], finish: () => void) => {
    const from = r.version;
    steps.forEach((phase, i) => {
      setTimeout(() => {
        r.update = state(r, phase, { fromVersion: from, toVersion: to });
      }, i * FAKE_UPDATE_STEP_MS);
    });
    setTimeout(() => {
      finish();
    }, steps.length * FAKE_UPDATE_STEP_MS);
  };

  return {
    releases: async () => overview(),
    async checkReleases() {
      lastCheckAt = new Date().toISOString();
      return overview();
    },
    async promoteRelease(version: string, confirm: boolean) {
      if (!cached.some((c) => c.version === version)) {
        throw apiError(409, 'not_cached', 'version is not in the release cache');
      }
      const since = canarySince ? Date.parse(canarySince) : Date.now();
      if (version === canary && Date.now() - since < CANARY_SOAK_MS && !confirm) {
        throw apiError(409, 'canary_too_new', 'canary has run for less than 24 hours');
      }
      stable = version;
      if (canary && compareVersions(canary, version) <= 0) {
        canary = null;
        canarySince = null;
      }
      return overview();
    },
    async setReleaseRepo(next: string | null) {
      repo = next === null ? null : next.trim();
      return overview();
    },
    async setMachineChannel(machineId: string, channel: ReleaseChannel) {
      const machine = machines().find((m) => m.id === machineId);
      if (!machine) throw apiError(404, 'not_found', 'machine not found');
      entry(machine).channel = channel;
      return overview();
    },
    async setMachineAllowUnverified(machineId: string, allow: boolean, confirm: boolean) {
      const machine = machines().find((m) => m.id === machineId);
      if (!machine) throw apiError(404, 'not_found', 'machine not found');
      const r = entry(machine);
      if (!unverified(r)) {
        throw apiError(409, 'platform_verified', 'this machine runs a verified platform');
      }
      if (allow && !confirm) {
        throw apiError(400, 'confirm_required', 'allowing updates needs confirm');
      }
      r.allowUnverified = allow;
      return overview();
    },
    async updateMachine(machineId: string) {
      const r = online(machineId);
      const to = target(r);
      if (!to) throw apiError(409, 'no_target', 'no release for this platform');
      // 延後條件仍然要過（和 daemon 同一條規則）：demo-studio 有 session 在等你允許，就繼續延後。
      const defer = updateDeferReason(statusesOf(machineId), false);
      if (defer) {
        r.update = state(r, 'deferred', { toVersion: to, reason: defer });
        return overview();
      }
      r.update = state(r, 'downloading', { toVersion: to });
      run(r, to, ['downloading', 'installing', 'checking'], () => {
        r.previousVersion = r.version;
        r.version = to;
        r.update = state(r, 'succeeded', { fromVersion: r.previousVersion, toVersion: to });
      });
      return overview();
    },
    async rollbackMachine(machineId: string) {
      const r = online(machineId);
      if (!r.previousVersion) throw apiError(409, 'no_previous', 'no previous version');
      const to = r.previousVersion;
      r.update = state(r, 'rolling_back', { toVersion: to, reason: 'rollback_requested' });
      run(r, to, ['rolling_back'], () => {
        const from = r.version;
        r.version = to;
        r.previousVersion = null;
        r.update = state(r, 'succeeded', {
          fromVersion: from,
          toVersion: to,
          reason: 'rollback_requested',
        });
      });
      return overview();
    },
  };
}
