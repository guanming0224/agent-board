// 發版與自動更新的 hub 端（docs/release-update-spec.md §4、CONTRACTS §21）。
//
// - 用這台機器上「已經登入」的 gh CLI（子程序）查 Release、下載成品到 `<dataDir>/release-cache/<版本>/`、
//   對 SHA256SUMS 驗 SHA-256。hub 不讀任何權杖檔，也把環境裡的 GH_TOKEN／GITHUB_TOKEN 拿掉再叫 gh，
//   gh 只能用它自己登入時存的憑證。gh 不存在或沒登入只影響這個功能，hub 其他功能照常。
// - 通道與目標：settings `release.canary`、`release.stable`、`machineChannel:<機器 id>`（預設 stable）。
// - 各機回報的版本、平台、更新狀態存在 settings `machineRelease:<機器 id>`（hub 重啟後面板照樣看得到）。
// - 不呼叫 LLM、不送 Claude 寫的內容：推播只有機器名稱、版本、原因代碼。
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CANARY_SOAK_MS,
  channelTarget,
  compareVersions,
  DEFAULT_RELEASE_CHANNEL,
  isReleasePlatform,
  isVersion,
  LEGACY_PROTOCOL_VERSION,
  parseSha256Sums,
  PROTOCOL_VERSION,
  protocolCompat,
  RELEASE_PLATFORMS,
  ReleaseChannel,
  releaseAssetName,
  rollbackSupported,
  UNVERIFIED_PLATFORMS,
  UPDATE_FAILED,
  UPDATE_STALE_MS,
  type TargetNote,
  UPDATE_IN_PROGRESS,
  UpdateState,
  versionFromTag,
  type CanaryStats,
  type GhState,
  type MachineRelease,
  type ReleaseOverview,
  type ReleaseTarget,
} from '@agent-board/protocol';
import { z } from 'zod';
import { HttpError } from './errors';
import type { Store } from './store';
import type { AppVersion } from './version';

/** 每 10 分鐘查一次新版（規格 §4）。 */
export const RELEASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** release-cache 最多留幾個版本（canary、stable 一定留）。 */
const CACHE_KEEP = 5;
const GH_TIMEOUT_MS = 60_000;
const GH_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

const KEY = {
  canary: 'release.canary',
  stable: 'release.stable',
  repo: 'release.repo',
  stats: 'release.canaryStats',
  lastCheck: 'release.lastCheck',
  fetchFailure: 'release.fetchFailure',
  /** 最後一次 hello 說自己有 hub 的那台（N1）：只認這一台，舊紀錄會被取代或清掉。 */
  hubMachine: 'release.hubMachine',
  /** 手動回滾退掉的版本（M1）：通道目標還是這一版就不發，免得一分鐘內又升回去。 */
  hold: (id: string) => `machineHold:${id}`,
  channel: (id: string) => `machineChannel:${id}`,
  machine: (id: string) => `machineRelease:${id}`,
};

/** gh 子程序的結果。`missing`：找不到 gh 執行檔。 */
export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}
export type GhRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<GhResult>;

/** gh 會自己讀的權杖環境變數：一律拿掉，只用 gh 登入時存的憑證（GM 決定：只有已登入的 gh）。 */
const GH_TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

export function ghEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const key of GH_TOKEN_ENV) delete next[key];
  return next;
}

/** 真的 gh：`AGENT_BOARD_GH_BIN`（測試放假的 gh）或 PATH 上的 gh。 */
export function execGh(bin: string = process.env.AGENT_BOARD_GH_BIN || 'gh'): GhRunner {
  return (args, options = {}) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          env: ghEnv(),
          timeout: options.timeoutMs ?? GH_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            missing: err?.code === 'ENOENT',
          });
        },
      );
    });
}

/** 一台機器最後回報的版本資訊（`machineRelease:<id>`）。 */
const MachineRecord = z.object({
  platform: z.string().nullable().catch(null),
  version: z.string().nullable().catch(null),
  buildId: z.string().nullable().catch(null),
  protocolVersion: z.number().int().nullable().catch(null),
  previousVersion: z.string().nullable().catch(null),
  hostsHub: z.boolean().catch(false),
  /** daemon 的 Node 原生模組 ABI（`process.versions.modules`）；舊 daemon 不送。 */
  nodeAbi: z.string().nullable().catch(null),
  update: UpdateState.nullable().catch(null),
  /** 已經推播過的失敗（update.at）：同一次失敗只通知一次。 */
  notifiedAt: z.string().nullable().catch(null),
});
type MachineRecord = z.infer<typeof MachineRecord>;
const EMPTY_RECORD: MachineRecord = {
  platform: null,
  version: null,
  buildId: null,
  protocolVersion: null,
  previousVersion: null,
  hostsHub: false,
  nodeAbi: null,
  update: null,
  notifiedAt: null,
};

const StoredStats = z.object({
  since: z.string(),
  disconnects: z.number().int().nonnegative().catch(0),
  updateFailures: z.number().int().nonnegative().catch(0),
});

/** release-cache/<版本>/verified.json：驗過的成品。 */
const Verified = z.object({
  version: z.string(),
  verifiedAt: z.string(),
  assets: z.record(
    z.string(),
    z.object({
      asset: z.string(),
      sha256: z.string(),
      size: z.number().int().nonnegative(),
      /** 成品附的 node_modules 是哪個 Node ABI 建的（`.node-modules-platform`）；讀不到為 null（不擋）。 */
      abi: z.string().nullable().optional(),
      /**
       * 成品自帶 Node（`.node-modules-platform` 的 bundledNode，CONTRACTS §21.10）：各機用它跑，原生模組 ABI
       * 一定相同，**不和 daemon 的 nodeAbi 比**。沒有這個欄位＝舊成品（或舊 hub 驗的），照舊比 ABI。
       */
      bundledNode: z.boolean().optional(),
    }),
  ),
});
type Verified = z.infer<typeof Verified>;

/** 同一版下載失敗的退避（W9）：10 分鐘起、每次加倍、上限 6 小時；手動「檢查新版」不受限。 */
const FetchFailure = z.object({
  version: z.string(),
  count: z.number().int().positive(),
  nextAt: z.string(),
});
const FETCH_BACKOFF_BASE_MS = 10 * 60 * 1000;
const FETCH_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export interface HelloRelease {
  version: string;
  protocolVersion?: number | undefined;
  buildId?: string | undefined;
  platform?: string | undefined;
  previousVersion?: string | null | undefined;
  hostsHub?: boolean | undefined;
  nodeAbi?: string | undefined;
  update?: UpdateState | null | undefined;
}

export interface ReleaseDeps {
  store: Store;
  /** release-cache 的上層資料夾；null＝不能下載（測試、記憶體資料庫）。 */
  dataDir: string | null;
  gh: GhRunner;
  now(): Date;
  hubVersion: AppVersion;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  audit(userId: string | null, action: string, detail: string): void;
  /** 有哪些機器連著（online 判斷與送目標用）。 */
  isOnline(machineId: string): boolean;
  /** 目標變了：hub 把新的 release.target 送給連著的 daemon。 */
  onTargetsChanged(): void;
  /** 更新失敗（第一次看到這次失敗）：推播。 */
  notifyUpdateFailed(machineId: string, machineName: string, state: UpdateState): void;
}

export class ReleaseManager {
  private checking: Promise<void> | null = null;
  private ghState: { state: GhState; message: string | null } = { state: 'unknown', message: null };
  private cacheIndex = new Map<string, Verified>();
  private cacheLoaded: Promise<void> | null = null;

  constructor(private readonly deps: ReleaseDeps) {}

  get hubVersion(): AppVersion {
    return this.deps.hubVersion;
  }

  private get cacheDir(): string | null {
    return this.deps.dataDir ? join(this.deps.dataDir, 'release-cache') : null;
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  // ── 設定 ─────────────────────────────────────────────

  private str(key: string): string | null {
    const value = this.deps.store.getRawJson(key);
    return typeof value === 'string' ? value : null;
  }

  get canary(): string | null {
    return this.str(KEY.canary);
  }

  get stable(): string | null {
    return this.str(KEY.stable);
  }

  repo(): string | null {
    return this.str(KEY.repo) ?? process.env.AGENT_BOARD_RELEASE_REPO ?? null;
  }

  channelOf(machineId: string): ReleaseChannel {
    const parsed = ReleaseChannel.safeParse(this.deps.store.getRawJson(KEY.channel(machineId)));
    return parsed.success ? parsed.data : DEFAULT_RELEASE_CHANNEL;
  }

  record(machineId: string): MachineRecord {
    const parsed = MachineRecord.safeParse(this.deps.store.getRawJson(KEY.machine(machineId)));
    return parsed.success ? parsed.data : { ...EMPTY_RECORD };
  }

  private saveRecord(machineId: string, record: MachineRecord): void {
    this.deps.store.setRawJson(KEY.machine(machineId), record);
  }

  /** 刪機器時一起清。 */
  forgetMachine(machineId: string): void {
    if (this.str(KEY.hubMachine) === machineId) this.deps.store.setRawJson(KEY.hubMachine, null);
    this.deps.store.setRawJson(KEY.hold(machineId), null);
    this.deps.store.setRawJson(KEY.channel(machineId), null);
    this.deps.store.setRawJson(KEY.machine(machineId), null);
  }

  setRepo(repo: string | null, userId: string): void {
    this.deps.store.setRawJson(KEY.repo, repo);
    this.ghState = { state: 'unknown', message: null };
    this.deps.audit(userId, 'release.repo', repo ?? '');
  }

  setChannel(machineId: string, channel: ReleaseChannel, userId: string): void {
    if (!this.deps.store.getMachine(machineId))
      throw new HttpError(404, 'not_found', 'No such machine');
    this.deps.store.setRawJson(KEY.channel(machineId), channel);
    this.deps.audit(userId, 'release.channel', JSON.stringify({ machineId, channel }));
    this.deps.onTargetsChanged();
  }

  /** 手動回滾：暫停退掉的那一版（M1）。 */
  holdVersion(machineId: string, version: string): void {
    this.deps.store.setRawJson(KEY.hold(machineId), version);
  }

  /** 「立即更新」：解除暫停（M1）。 */
  releaseHold(machineId: string): void {
    this.deps.store.setRawJson(KEY.hold(machineId), null);
  }

  // ── hello 與狀態回報 ──────────────────────────────────

  /** hello：記下版本資訊，回傳協定相容性。 */
  onHello(machineId: string, hello: HelloRelease): ReturnType<typeof protocolCompat> {
    const prev = this.record(machineId);
    const record: MachineRecord = {
      ...prev,
      version: hello.version,
      protocolVersion: hello.protocolVersion ?? LEGACY_PROTOCOL_VERSION,
      buildId: hello.buildId ?? null,
      platform: hello.platform ?? null,
      previousVersion: hello.previousVersion ?? null,
      hostsHub: hello.hostsHub ?? false,
      nodeAbi: hello.nodeAbi ?? null,
      update: hello.update === undefined ? prev.update : hello.update,
    };
    this.saveRecord(machineId, record);
    this.afterUpdateState(machineId, record);
    // 哪一台是 hub：最後一次 hello 說自己有 hub 的那台；原本是 hub 的機器改說沒有就清掉（N1）。
    const hubMachine = this.str(KEY.hubMachine);
    if (record.hostsHub && hubMachine !== machineId) {
      this.deps.store.setRawJson(KEY.hubMachine, machineId);
    } else if (!record.hostsHub && hubMachine === machineId) {
      this.deps.store.setRawJson(KEY.hubMachine, null);
    }
    // hub 那台上線或換了版本：其他機器可能在等它（hub_first），重新送目標（等 welcome 送完）。
    if (record.hostsHub || hubMachine === machineId) {
      queueMicrotask(() => this.deps.onTargetsChanged());
    }
    return protocolCompat(PROTOCOL_VERSION, record.protocolVersion ?? LEGACY_PROTOCOL_VERSION);
  }

  onUpdateStatus(machineId: string, state: UpdateState): void {
    const record = { ...this.record(machineId), update: state };
    this.saveRecord(machineId, record);
    this.afterUpdateState(machineId, record);
  }

  /** 新的失敗：audit、推播一次；canary 機器算進 canary 統計。 */
  private afterUpdateState(machineId: string, record: MachineRecord): void {
    const state = record.update;
    if (!state || !UPDATE_FAILED.includes(state.phase) || record.notifiedAt === state.at) return;
    this.saveRecord(machineId, { ...record, notifiedAt: state.at });
    const machine = this.deps.store.getMachine(machineId);
    this.deps.audit(
      null,
      'release.update_failed',
      JSON.stringify({
        machineId,
        phase: state.phase,
        from: state.fromVersion,
        to: state.toVersion,
        reason: state.reason,
      }),
    );
    if (this.channelOf(machineId) === 'canary') this.bumpStat('updateFailures');
    this.deps.notifyUpdateFailed(machineId, machine?.name ?? machineId, state);
  }

  /**
   * daemon 斷線：更新進行中（而且狀態是最近 15 分鐘內的）的斷線是預期的（換版重啟），其他的算 canary 的崩潰／重啟。
   * 狀態停在進行中太久不算（S1：卡住的狀態不能讓之後的崩潰都被當成預期的）。
   */
  onDisconnect(machineId: string): void {
    // hub 那台離線：其他機器不用再等它（N1）。
    if (this.str(KEY.hubMachine) === machineId) {
      queueMicrotask(() => this.deps.onTargetsChanged());
    }
    if (this.channelOf(machineId) !== 'canary') return;
    const update = this.record(machineId).update;
    const recent =
      update !== null && this.deps.now().getTime() - Date.parse(update.at) < UPDATE_STALE_MS;
    if (update && UPDATE_IN_PROGRESS.includes(update.phase) && recent) return;
    this.bumpStat('disconnects');
  }

  private stats(): z.infer<typeof StoredStats> | null {
    const parsed = StoredStats.safeParse(this.deps.store.getRawJson(KEY.stats));
    return parsed.success ? parsed.data : null;
  }

  private bumpStat(key: 'disconnects' | 'updateFailures'): void {
    const stats = this.stats();
    if (!stats || !this.canary) return;
    this.deps.store.setRawJson(KEY.stats, { ...stats, [key]: stats[key] + 1 });
  }

  canaryStats(): CanaryStats {
    const stats = this.stats();
    if (!stats || !this.canary)
      return { since: null, errors: 0, disconnects: 0, updateFailures: 0 };
    const canaryMachines = this.deps.store
      .listMachines()
      .filter((m) => this.channelOf(m.id) === 'canary')
      .map((m) => m.id);
    return {
      since: stats.since,
      errors: this.deps.store.countErrorEvents(canaryMachines, stats.since),
      disconnects: stats.disconnects,
      updateFailures: stats.updateFailures,
    };
  }

  // ── 目標 ─────────────────────────────────────────────

  /** 這台機器現在的更新目標；沒有就是 null。 */
  targetFor(machineId: string): ReleaseTarget | null {
    return this.resolveTarget(machineId).target;
  }

  private channelVersion(machineId: string): string | null {
    return channelTarget(this.channelOf(machineId), { canary: this.canary, stable: this.stable });
  }

  /**
   * 目標與沒有目標的原因：
   * - 平台沒有成品、版本不在 cache 裡：null（沒有說明）。
   * - 還沒實機驗證的平台（win-x64，W8）：platform_unverified。hub 照樣下載成品，只是不發。
   * - 成品附的原生模組 ABI 和這台 daemon 的 Node 不合（B5）：abi_mismatch（不在更新中跑 npm ci）。
   *   只適用沒自帶 Node 的舊成品；自帶 Node 的成品（bundledNode）不比（§21.10），hello 的 nodeAbi 只供顯示。
   * - hub 那台也要升到同一版但還沒升（S3a）：hub_first。先升 hub，其他機器才不會在 hub 重啟時健康檢查失敗。
   *   只在 hub 那台真的拿得到這個目標（它自己沒被平台、ABI 擋住）而且在線時才擋（N1）。
   *   hub 那台這一版更新失敗（rolled_back／rollback_failed）：繼續擋，說明改成 hub_update_failed（不管在不在線）。
   */
  resolveTarget(
    machineId: string,
    options: { skipHubCheck?: boolean } = {},
  ): { target: ReleaseTarget | null; note: TargetNote | null } {
    const none = { target: null, note: null };
    const record = this.record(machineId);
    const version = this.channelVersion(machineId);
    if (!version || !record.platform) return none;
    // 手動回滾後暫停那一版（M1）；通道已經換成別的版本就解除。hub_first 的計算也走這裡，
    // 所以 hub 那台被暫停時視同它拿不到目標，不會卡住其他機器。
    const hold = this.str(KEY.hold(machineId));
    if (hold !== null) {
      if (hold === version) return { target: null, note: 'rolled_back_hold' };
      this.deps.store.setRawJson(KEY.hold(machineId), null);
    }
    if (
      UNVERIFIED_PLATFORMS.includes(record.platform) &&
      process.env.AGENT_BOARD_ALLOW_UNVERIFIED_PLATFORMS !== '1'
    ) {
      return { target: null, note: 'platform_unverified' };
    }
    const entry = this.cacheIndex.get(version)?.assets[record.platform];
    if (!entry || entry.asset !== releaseAssetName(version, record.platform)) return none;
    if (!entry.bundledNode && entry.abi && record.nodeAbi && entry.abi !== record.nodeAbi) {
      return { target: null, note: 'abi_mismatch' };
    }
    const hubId = this.str(KEY.hubMachine);
    if (!options.skipHubCheck && hubId && hubId !== machineId) {
      const hubMachine = this.deps.store.getMachine(hubId);
      const hub = this.record(hubId);
      const hubTarget = hubMachine
        ? this.resolveTarget(hubId, { skipHubCheck: true }).target
        : null;
      if (hubTarget?.version === version && hub.version !== version) {
        const failed =
          hub.update !== null &&
          hub.update.toVersion === version &&
          (hub.update.phase === 'rolled_back' || hub.update.phase === 'rollback_failed');
        if (failed) return { target: null, note: 'hub_update_failed' };
        if (hubMachine?.online) return { target: null, note: 'hub_first' };
      }
    }
    return {
      target: {
        version,
        platform: record.platform,
        asset: entry.asset,
        sha256: entry.sha256,
        size: entry.size,
      },
      note: null,
    };
  }

  // ── 檢查與下載 ────────────────────────────────────────

  /** 讀 release-cache 裡驗過的版本（啟動時、檢查後）。 */
  loadCache(): Promise<void> {
    this.cacheLoaded ??= this.reloadCache();
    return this.cacheLoaded;
  }

  private async reloadCache(): Promise<void> {
    const dir = this.cacheDir;
    const index = new Map<string, Verified>();
    if (dir) {
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        names = [];
      }
      for (const name of names) {
        // 上次 hub 下載到一半就結束留下的暫存（W9）。
        if (name.startsWith('.download-')) {
          await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (!isVersion(name)) continue;
        try {
          const verified = Verified.parse(
            JSON.parse(await readFile(join(dir, name, 'verified.json'), 'utf8')),
          );
          if (verified.version === name) index.set(name, verified);
        } catch {
          // 沒驗完的半成品：不算
        }
      }
    }
    this.cacheIndex = index;
    // hub 剛開機時 daemon 可能比 cache 先連上（welcome 的目標是 null）：讀完補送一次。
    if (index.size > 0) this.deps.onTargetsChanged();
  }

  isChecking(): boolean {
    return this.checking !== null;
  }

  /** 查新版（同時只跑一次）。錯誤記在 lastCheck，不丟出去。 */
  check(userId: string | null = null): Promise<void> {
    this.checking ??= this.runCheck(userId).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private setLastCheck(error: string | null): void {
    this.deps.store.setRawJson(KEY.lastCheck, { at: this.nowIso(), error });
  }

  private lastCheck(): { at: string | null; error: string | null } {
    const value = this.deps.store.getRawJson(KEY.lastCheck) as { at?: unknown; error?: unknown };
    return {
      at: typeof value?.at === 'string' ? value.at : null,
      error: typeof value?.error === 'string' ? value.error : null,
    };
  }

  private async runCheck(userId: string | null): Promise<void> {
    await this.loadCache();
    const repo = this.repo();
    if (!repo) {
      this.ghState = { state: 'no_repo', message: null };
      this.setLastCheck('no_repo');
      return;
    }
    const cacheDir = this.cacheDir;
    if (!cacheDir) {
      this.setLastCheck('no_data_dir');
      return;
    }
    const auth = await this.deps.gh(['auth', 'status', '--hostname', 'github.com']);
    if (auth.missing) {
      this.ghState = { state: 'missing', message: null };
      this.setLastCheck('gh_missing');
      return;
    }
    if (auth.code !== 0) {
      this.ghState = { state: 'not_logged_in', message: firstLine(auth.stderr || auth.stdout) };
      this.setLastCheck('gh_not_logged_in');
      return;
    }
    const list = await this.deps.gh([
      'release',
      'list',
      '--repo',
      repo,
      '--limit',
      '30',
      '--exclude-drafts',
      '--json',
      'tagName,isDraft,publishedAt',
    ]);
    if (list.code !== 0) {
      const message = firstLine(list.stderr || list.stdout);
      this.ghState = { state: 'error', message };
      this.setLastCheck(`gh release list: ${message}`);
      return;
    }
    this.ghState = { state: 'ok', message: null };
    let latest: string | null = null;
    try {
      const rows = z
        .array(z.object({ tagName: z.string(), isDraft: z.boolean().optional() }))
        .parse(JSON.parse(list.stdout));
      for (const row of rows) {
        const version = versionFromTag(row.tagName);
        if (!version || row.isDraft) continue;
        if (!latest || compareVersions(version, latest) > 0) latest = version;
      }
    } catch {
      this.setLastCheck('gh release list: invalid output');
      return;
    }
    if (!latest) {
      this.setLastCheck(null);
      return;
    }
    const canary = this.canary;
    if (canary && compareVersions(latest, canary) <= 0) {
      this.setLastCheck(null);
      return;
    }
    if (!this.cacheIndex.has(latest)) {
      // 同一版一直下載失敗：自動檢查照退避時間跳過（手動「檢查新版」不受限）。
      const failure = FetchFailure.safeParse(this.deps.store.getRawJson(KEY.fetchFailure));
      const previous = failure.success && failure.data.version === latest ? failure.data : null;
      if (previous && userId === null && Date.parse(previous.nextAt) > this.deps.now().getTime()) {
        return;
      }
      const error = await this.download(repo, latest, cacheDir);
      if (error) {
        const count = (previous?.count ?? 0) + 1;
        const wait = Math.min(FETCH_BACKOFF_BASE_MS * 2 ** (count - 1), FETCH_BACKOFF_MAX_MS);
        this.deps.store.setRawJson(KEY.fetchFailure, {
          version: latest,
          count,
          nextAt: new Date(this.deps.now().getTime() + wait).toISOString(),
        });
        this.setLastCheck(error);
        this.deps.audit(userId, 'release.fetch_failed', JSON.stringify({ version: latest, error }));
        return;
      }
      this.deps.store.setRawJson(KEY.fetchFailure, null);
    }
    this.deps.store.setRawJson(KEY.canary, latest);
    this.deps.store.setRawJson(KEY.stats, {
      since: this.nowIso(),
      disconnects: 0,
      updateFailures: 0,
    });
    this.setLastCheck(null);
    this.deps.audit(
      userId,
      'release.canary',
      JSON.stringify({ version: latest, previous: canary }),
    );
    this.deps.log.info({ version: latest }, 'new canary release');
    await this.pruneCache();
    this.deps.onTargetsChanged();
  }

  /** 下載一個版本的成品與 SHA256SUMS、驗 SHA-256；成功才搬進 cache。回傳錯誤訊息或 null。 */
  private async download(repo: string, version: string, cacheDir: string): Promise<string | null> {
    const temp = join(cacheDir, `.download-${version}-${randomBytes(4).toString('hex')}`);
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      const result = await this.deps.gh(
        [
          'release',
          'download',
          `v${version}`,
          '--repo',
          repo,
          '--dir',
          temp,
          '--clobber',
          '--pattern',
          'SHA256SUMS',
          ...RELEASE_PLATFORMS.flatMap((p) => ['--pattern', releaseAssetName(version, p)]),
        ],
        { timeoutMs: GH_DOWNLOAD_TIMEOUT_MS },
      );
      if (result.code !== 0)
        return `gh release download: ${firstLine(result.stderr || result.stdout)}`;
      let sums: Map<string, string>;
      try {
        sums = parseSha256Sums(await readFile(join(temp, 'SHA256SUMS'), 'utf8'));
      } catch {
        return 'SHA256SUMS missing';
      }
      const assets: Verified['assets'] = {};
      for (const platform of RELEASE_PLATFORMS) {
        const asset = releaseAssetName(version, platform);
        const path = join(temp, asset);
        let size: number;
        try {
          size = (await stat(path)).size;
        } catch {
          continue; // 這個平台沒有成品
        }
        const expected = sums.get(asset);
        if (!expected) return `${asset} not listed in SHA256SUMS`;
        const actual = await sha256File(path);
        if (actual !== expected) return `${asset} SHA-256 mismatch`;
        const modules = await modulesPlatform(path);
        assets[platform] = { asset, sha256: actual, size, ...modules };
      }
      if (Object.keys(assets).length === 0) return 'no release assets';
      const verified: Verified = { version, verifiedAt: this.nowIso(), assets };
      await writeFile(join(temp, 'verified.json'), `${JSON.stringify(verified, null, 2)}\n`, {
        mode: 0o600,
      });
      const final = join(cacheDir, version);
      await rm(final, { recursive: true, force: true });
      await rename(temp, final);
      this.cacheIndex.set(version, verified);
      return null;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  /** 只留最新的幾版；canary、stable 一定留。 */
  private async pruneCache(): Promise<void> {
    const dir = this.cacheDir;
    if (!dir) return;
    const keep = new Set([this.canary, this.stable].filter((v): v is string => v !== null));
    const versions = [...this.cacheIndex.keys()].sort((a, b) => compareVersions(b, a));
    for (const version of versions.slice(CACHE_KEEP)) {
      if (keep.has(version)) continue;
      this.cacheIndex.delete(version);
      await rm(join(dir, version), { recursive: true, force: true });
    }
  }

  /** daemon 下載：只給 cache 裡驗過的檔案。 */
  releaseFile(
    version: string,
    platform: string,
  ): { path: string; sha256: string; size: number } | null {
    const dir = this.cacheDir;
    if (!dir || !isVersion(version) || !isReleasePlatform(platform)) return null;
    const asset = this.cacheIndex.get(version)?.assets[platform];
    // 檔名一定是這個版本與平台的成品名稱（B3）：verified.json 被改過也只會給到 cache 資料夾裡的那一個檔。
    if (!asset || asset.asset !== releaseAssetName(version, platform)) return null;
    return { path: join(dir, version, asset.asset), sha256: asset.sha256, size: asset.size };
  }

  // ── 面板操作 ─────────────────────────────────────────

  promote(version: string, confirm: boolean, userId: string): void {
    if (!this.cacheIndex.has(version)) {
      throw new HttpError(409, 'not_cached', 'This version is not in the release cache');
    }
    const since = this.canary === version ? this.stats()?.since : null;
    const young = since ? this.deps.now().getTime() - Date.parse(since) < CANARY_SOAK_MS : true;
    if (young && !confirm) {
      throw new HttpError(
        409,
        'canary_too_new',
        'Canary has run for less than 24 hours. Send confirm: true to promote anyway.',
      );
    }
    const previous = this.stable;
    this.deps.store.setRawJson(KEY.stable, version);
    this.deps.audit(userId, 'release.promote', JSON.stringify({ version, previous, early: young }));
    this.deps.onTargetsChanged();
  }

  overview(): ReleaseOverview {
    const last = this.lastCheck();
    const machines: MachineRelease[] = this.deps.store.listMachines().map((machine) => {
      const record = this.record(machine.id);
      const resolved = this.resolveTarget(machine.id);
      return {
        machineId: machine.id,
        name: machine.name,
        os: machine.os,
        online: machine.online,
        lastSeenAt: machine.lastSeenAt,
        platform: record.platform,
        version: record.version,
        buildId: record.buildId,
        protocolVersion: record.protocolVersion,
        previousVersion: record.previousVersion,
        channel: this.channelOf(machine.id),
        targetVersion: resolved.target?.version ?? null,
        targetNote: resolved.note,
        canRollback: rollbackSupported(record.previousVersion),
        compat:
          record.protocolVersion === null
            ? 'ok'
            : protocolCompat(PROTOCOL_VERSION, record.protocolVersion),
        hasHub: record.hostsHub,
        update: record.update,
      };
    });
    return {
      hub: { ...this.hubVersion, protocolVersion: PROTOCOL_VERSION },
      repo: this.repo(),
      gh: this.repo() ? this.ghState : { state: 'no_repo', message: null },
      canary: this.canary,
      stable: this.stable,
      canaryStats: this.canaryStats(),
      cached: [...this.cacheIndex.values()]
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v) => ({ version: v.version, platforms: Object.keys(v.assets) })),
      lastCheckAt: last.at,
      lastCheckError: last.error,
      checking: this.isChecking(),
      machines,
    };
  }
}

/**
 * 成品裡 `.node-modules-platform` 記的 Node ABI 與有沒有自帶 Node（用系統 tar 讀，tar.gz 與 zip 都行）；
 * 讀不到 ABI 為 null、bundledNode 為 false。
 */
export function modulesPlatform(
  archive: string,
): Promise<{ abi: string | null; bundledNode: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'tar',
      ['-xOf', archive, 'agent-board/.node-modules-platform'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve({ abi: null, bundledNode: false });
        try {
          const info = JSON.parse(stdout) as { modules?: unknown; bundledNode?: unknown };
          resolve({
            abi: typeof info.modules === 'string' ? info.modules : null,
            bundledNode: info.bundledNode === true,
          });
        } catch {
          resolve({ abi: null, bundledNode: false });
        }
      },
    );
  });
}

function firstLine(text: string): string {
  return (text.trim().split(/\r?\n/)[0] ?? '').slice(0, 300);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
