// daemon 端的自動更新（docs/release-update-spec.md §5、CONTRACTS §21.3）。
//
// hub 在 welcome／release.target 給「這台的目標版本」。和目前版本不同就：
//   1. 看延後條件（有 PERM 就延後；要換 session host 而有 RUN／PERM／PLAN／starting 也延後），延後每 5 分鐘再看；
//   2. 用機器 token 向 hub 下載成品（hub 代轉 GitHub Release，這台不放 GitHub 權杖）、驗 SHA-256、解壓；
//   3. 啟動「新版裡的」獨立更新程式 scripts/updater.mjs（detached、新的 process group，不是 daemon 的子程序樹：
//      daemon 被服務管理程式停掉時不會一起被收掉），由它備份 hub.db、換 current、重啟、健康檢查、失敗回滾。
// 結果在 `<dataDir>/update-state.json`，daemon 每次連上 hub 都放進 hello，進行中時輪詢檔案用 update.status 回報。
// 只連 hub（已配對的那一台），不連 GitHub、不呼叫 LLM。
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  compareVersions,
  releaseDownloadPath,
  UPDATE_FAILED,
  UPDATE_IN_PROGRESS,
  updateDeferReason,
  UpdateState,
  type ReleaseTarget,
  type UpdateReason,
} from '@agent-board/protocol';
import { z } from 'zod';
import { errorMessage, log } from './log';

/** 延後時多久再看一次（規格 §5 第 2 點）。 */
export const UPDATE_DEFER_RETRY_MS = 5 * 60_000;
/** 進行中的更新：多久讀一次狀態檔回報 hub。 */
const STATE_POLL_MS = 2_000;
/** 讀狀態檔回報的上限（更新程式最多 60 秒健康檢查＋回滾 60 秒，留餘裕）。 */
const STATE_POLL_LIMIT_MS = 10 * 60_000;

export const UPDATE_STATE_FILE = 'update-state.json';
export const DAEMON_STATUS_FILE = 'daemon-status.json';

/** 安裝程式寫的 `<安裝根目錄>/install.json`（只讀這裡用得到的欄位）。 */
const InstallState = z.object({
  roles: z.array(z.string()).catch([]),
  currentVersion: z.string().nullable().optional().catch(null),
  previousVersion: z.string().nullable().optional().catch(null),
  sessionHostProtocol: z.number().int().nullable().optional().catch(null),
});
export type InstallState = z.infer<typeof InstallState>;

export function readInstallState(root: string | null): InstallState | null {
  if (!root) return null;
  try {
    return InstallState.parse(JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')));
  } catch {
    return null;
  }
}

export function readUpdateState(dataDir: string): UpdateState | null {
  try {
    return UpdateState.parse(JSON.parse(readFileSync(join(dataDir, UPDATE_STATE_FILE), 'utf8')));
  } catch {
    return null;
  }
}

/** 600：裡面沒有秘密，但和其他資料檔一致。 */
export async function writeUpdateState(dataDir: string, state: UpdateState): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = join(dataDir, `.${UPDATE_STATE_FILE}.${randomBytes(4).toString('hex')}`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, join(dataDir, UPDATE_STATE_FILE));
}

/** 連上 hub 時寫：更新程式的健康檢查看這個（新版 daemon 起來而且連上 hub）。 */
export async function writeDaemonStatus(
  dataDir: string,
  status: { version: string; buildId: string },
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = join(dataDir, `.${DAEMON_STATUS_FILE}.${randomBytes(4).toString('hex')}`);
  const body = { pid: process.pid, ...status, connectedAt: new Date().toISOString() };
  await writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await rename(temp, join(dataDir, DAEMON_STATUS_FILE));
}

/** ws(s)://host/ws/daemon → http(s)://host */
export function hubHttpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  return url.origin;
}

export interface SpawnRequest {
  script: string;
  args: string[];
  cwd: string;
  logFile: string;
}

/**
 * 啟動更新程式：detached（setsid，新的 session 與 process group）、stdio 接到紀錄檔、unref。
 * launchd 停 daemon 時只殺 daemon 的 process group（plist 沒開 AbandonProcessGroup 也一樣），收不到它。
 */
export function spawnDetached(request: SpawnRequest, env: NodeJS.ProcessEnv = process.env): number {
  mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
  const out = openSync(request.logFile, 'a', 0o600);
  const child = spawn(process.execPath, [request.script, ...request.args], {
    cwd: request.cwd,
    detached: true,
    stdio: ['ignore', out, out],
    env,
    windowsHide: true,
  });
  child.unref();
  return child.pid ?? 0;
}

export interface SelfUpdaterDeps {
  dataDir: string;
  /** 安裝根目錄（`AGENT_BOARD_INSTALL_ROOT`，安裝程式設定）。null＝開發模式，不自動更新。 */
  installRoot: string | null;
  currentVersion: string;
  platform: string;
  hubUrl: string;
  token: string;
  /** 目前每個 session 的狀態（延後條件用）。 */
  sessionStatuses(): string[];
  /** 送 update.status 給 hub（沒連上就丟掉，下次 hello 會帶）。 */
  report(state: UpdateState): void;
  spawnUpdater?: (request: SpawnRequest) => void;
  fetch?: typeof fetch;
  /** 解壓：預設用系統的 tar（macOS、Windows 10 以上都有，zip 也吃）。 */
  extract?: (archive: string, dest: string) => Promise<void>;
  now?: () => Date;
  deferRetryMs?: number;
  /** 更新程式健康檢查的上限（毫秒）；預設 60 秒，測試縮短（`AGENT_BOARD_UPDATE_HEALTH_MS`）。 */
  healthTimeoutMs?: number;
}

/** 系統 tar 解壓（Windows 的 tar.exe 是 bsdtar，zip 也能解）。 */
function tarExtract(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
  });
}

class UpdateFailure extends Error {
  constructor(
    readonly reason: UpdateReason,
    message: string,
  ) {
    super(message);
  }
}

export class SelfUpdater {
  private target: ReleaseTarget | null = null;
  private force = false;
  private busy = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly deps: SelfUpdaterDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  get state(): UpdateState | null {
    return readUpdateState(this.deps.dataDir);
  }

  /** 安裝程式記下的上一版（可回滾到的版本）。 */
  get previousVersion(): string | null {
    return readInstallState(this.deps.installRoot)?.previousVersion ?? null;
  }

  get hostsHub(): boolean {
    return readInstallState(this.deps.installRoot)?.roles.includes('hub') ?? false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.retryTimer = null;
    this.pollTimer = null;
  }

  private async setState(state: Omit<UpdateState, 'at'>): Promise<UpdateState> {
    const full: UpdateState = { ...state, at: this.now() };
    try {
      await writeUpdateState(this.deps.dataDir, full);
    } catch (error) {
      log.warn(`寫不進更新狀態檔：${errorMessage(error)}`);
    }
    this.deps.report(full);
    return full;
  }

  /** 連上 hub：上次的更新還在進行中（更新程式還在跑）就輪詢狀態檔，結果出來回報 hub。 */
  onConnected(): void {
    const state = this.state;
    if (!state || !UPDATE_IN_PROGRESS.includes(state.phase) || this.pollTimer) return;
    const started = Date.now();
    let last = JSON.stringify(state);
    this.pollTimer = setInterval(() => {
      const next = this.state;
      const text = JSON.stringify(next);
      if (next && text !== last) {
        last = text;
        this.deps.report(next);
      }
      if (
        !next ||
        !UPDATE_IN_PROGRESS.includes(next.phase) ||
        Date.now() - started > STATE_POLL_LIMIT_MS
      ) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }, STATE_POLL_MS);
    this.pollTimer.unref();
  }

  /** hub 給了新目標（welcome、release.target）。force：面板按「立即更新」。 */
  onTarget(target: ReleaseTarget | null, force: boolean): void {
    this.target = target;
    this.force = force;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.consider();
  }

  /** 要不要動手：版本不同、不是降級（除非 force）、上次沒在這版失敗過（除非 force）。 */
  private async consider(): Promise<void> {
    const target = this.target;
    if (!target || this.busy || this.disposed) return;
    const { currentVersion, platform } = this.deps;
    if (target.platform !== platform || target.version === currentVersion) return;
    const force = this.force;
    if (!force && compareVersions(target.version, currentVersion) < 0) return;
    const last = this.state;
    if (last && UPDATE_IN_PROGRESS.includes(last.phase)) return;
    if (!force && last && UPDATE_FAILED.includes(last.phase) && last.toVersion === target.version) {
      return;
    }
    if (!this.deps.installRoot) {
      if (last?.reason !== 'not_installed' || last.toVersion !== target.version) {
        await this.setState({
          phase: 'idle',
          fromVersion: currentVersion,
          toVersion: target.version,
          reason: 'not_installed',
          detail: null,
        });
      }
      return;
    }
    this.busy = true;
    try {
      await this.run(target);
    } finally {
      this.busy = false;
    }
  }

  private defer(target: ReleaseTarget, reason: UpdateReason): Promise<UpdateState> {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.consider();
    }, this.deps.deferRetryMs ?? UPDATE_DEFER_RETRY_MS);
    this.retryTimer.unref();
    return this.setState({
      phase: 'deferred',
      fromVersion: this.deps.currentVersion,
      toVersion: target.version,
      reason,
      detail: null,
    });
  }

  private async run(target: ReleaseTarget): Promise<void> {
    const root = this.deps.installRoot!;
    const from = this.deps.currentVersion;
    const permission = updateDeferReason(this.deps.sessionStatuses(), false);
    if (permission) {
      await this.defer(target, permission);
      return;
    }
    const incoming = join(root, 'releases', '.incoming');
    const extracted = join(incoming, target.version);
    const source = join(extracted, 'agent-board');
    try {
      if (!this.extractedOk(source, target.version)) {
        await this.setState({
          phase: 'downloading',
          fromVersion: from,
          toVersion: target.version,
          reason: null,
          detail: null,
        });
        await rm(incoming, { recursive: true, force: true });
        await mkdir(extracted, { recursive: true, mode: 0o700 });
        const archive = join(incoming, target.asset);
        await this.download(target, archive);
        try {
          await (this.deps.extract ?? tarExtract)(archive, extracted);
        } catch (error) {
          throw new UpdateFailure('extract_failed', errorMessage(error));
        } finally {
          await rm(archive, { force: true });
        }
        if (!this.extractedOk(source, target.version)) {
          throw new UpdateFailure('extract_failed', 'release content does not match the version');
        }
      }
      // 這次要不要換 session host：新版的協定和現在跑的不同才要（§20.5）。換的話有工作中的 session 就延後。
      const hostChange = this.needsHostRestart(source);
      const busy = updateDeferReason(this.deps.sessionStatuses(), hostChange);
      if (busy) {
        await this.defer(target, busy);
        return;
      }
      await this.setState({
        phase: 'installing',
        fromVersion: from,
        toVersion: target.version,
        reason: null,
        detail: null,
      });
      const args = [
        'update',
        '--source',
        source,
        '--to',
        target.version,
        '--from',
        from,
        '--data',
        this.deps.dataDir,
        '--root',
        root,
      ];
      if (this.deps.healthTimeoutMs)
        args.push('--health-timeout-ms', String(this.deps.healthTimeoutMs));
      const request: SpawnRequest = {
        script: join(source, 'scripts', 'updater.mjs'),
        args,
        cwd: root,
        logFile: join(this.deps.dataDir, 'logs', 'updater.log'),
      };
      log.info(`開始更新 ${from} → ${target.version}（獨立的更新程式，紀錄 ${request.logFile}）`);
      (this.deps.spawnUpdater ?? ((r) => spawnDetached(r)))(request);
    } catch (error) {
      const reason = error instanceof UpdateFailure ? error.reason : 'unknown';
      log.warn(`更新到 ${target.version} 失敗（${reason}）：${errorMessage(error)}`);
      await rm(incoming, { recursive: true, force: true }).catch(() => undefined);
      await this.setState({
        phase: 'failed',
        fromVersion: from,
        toVersion: target.version,
        reason,
        detail: errorMessage(error).slice(0, 500),
      });
    }
  }

  private extractedOk(source: string, version: string): boolean {
    try {
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      return (
        manifest.name === 'agent-board-release' &&
        manifest.version === version &&
        existsSync(join(source, 'BUILD_ID')) &&
        existsSync(join(source, 'scripts', 'updater.mjs'))
      );
    } catch {
      return false;
    }
  }

  private needsHostRestart(source: string): boolean {
    try {
      const { protocol } = JSON.parse(
        readFileSync(join(source, 'session-host', 'dist', 'meta.json'), 'utf8'),
      ) as { protocol?: unknown };
      const installed = readInstallState(this.deps.installRoot)?.sessionHostProtocol ?? null;
      return Number.isInteger(protocol) && installed !== null && protocol !== installed;
    } catch {
      return false;
    }
  }

  private async download(target: ReleaseTarget, archive: string): Promise<void> {
    const url = `${hubHttpBase(this.deps.hubUrl)}${releaseDownloadPath(target.version, target.platform)}`;
    let response: Response;
    try {
      // 只連已配對的 hub（機器 token），不連 GitHub（docs/no-llm-review.md「自動更新」）。
      const init: RequestInit = {
        headers: { authorization: `Bearer ${this.deps.token}` },
        signal: AbortSignal.timeout(15 * 60_000),
      };
      response = await (this.deps.fetch ? this.deps.fetch(url, init) : fetch(url, init));
    } catch (error) {
      throw new UpdateFailure('download_failed', errorMessage(error));
    }
    if (!response.ok || !response.body) {
      throw new UpdateFailure('download_failed', `HTTP ${response.status}`);
    }
    const hash = createHash('sha256');
    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => hash.update(chunk));
    try {
      await pipeline(body, createWriteStream(archive, { mode: 0o600 }));
    } catch (error) {
      throw new UpdateFailure('download_failed', errorMessage(error));
    }
    const actual = hash.digest('hex');
    if (actual !== target.sha256) {
      await rm(archive, { force: true });
      throw new UpdateFailure('checksum_mismatch', `expected ${target.sha256}, got ${actual}`);
    }
  }

  /** 面板「回滾到上一版」：用現在這版的更新程式把 current 指回上一版。 */
  async rollback(): Promise<void> {
    const root = this.deps.installRoot;
    const from = this.deps.currentVersion;
    const previous = this.previousVersion;
    if (!root || !previous || this.busy) {
      await this.setState({
        phase: 'failed',
        fromVersion: from,
        toVersion: previous,
        reason: !root ? 'not_installed' : !previous ? 'no_previous' : 'busy',
        detail: null,
      });
      return;
    }
    await this.setState({
      phase: 'rolling_back',
      fromVersion: from,
      toVersion: previous,
      reason: 'rollback_requested',
      detail: null,
    });
    const args = ['rollback', '--data', this.deps.dataDir, '--root', root];
    if (this.deps.healthTimeoutMs)
      args.push('--health-timeout-ms', String(this.deps.healthTimeoutMs));
    (this.deps.spawnUpdater ?? ((r) => spawnDetached(r)))({
      script: join(root, 'current', 'scripts', 'updater.mjs'),
      args,
      cwd: root,
      logFile: join(this.deps.dataDir, 'logs', 'updater.log'),
    });
  }
}
