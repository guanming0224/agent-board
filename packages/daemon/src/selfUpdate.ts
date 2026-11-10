// daemon 端的自動更新（docs/release-update-spec.md §5、CONTRACTS §21.3）。
//
// hub 在 welcome／release.target 給「這台的目標版本」。和目前版本不同就：
//   1. 看延後條件（有 PERM 就延後；要換 session host 而有 RUN／PERM／PLAN／starting 也延後），延後每 5 分鐘再看；
//   2. 用機器 token 向 hub 下載成品（hub 代轉 GitHub Release，這台不放 GitHub 權杖）、驗 SHA-256、檢查內容清單、
//      解壓到 .partial 再改名（有完成標記才算解好）；
//   3. 啟動「新版裡的」獨立更新程式 scripts/updater.mjs（detached、新的 process group，不是 daemon 的子程序樹：
//      daemon 被服務管理程式停掉時不會一起被收掉），由它備份 hub.db、換 current、重啟、健康檢查、失敗回滾。
// 結果在 `<dataDir>/update-state.json`，daemon 每次連上 hub 都放進 hello，進行中時輪詢檔案用 update.status 回報。
// 進行中的狀態會過期（S1）：downloading 只有 daemon 自己寫，daemon 重啟過就是中斷了；其他階段看更新程式的鎖
// （update.lock 的 pid 還活著）與開始時間（超過 15 分鐘）。過期的寫成 failed/interrupted，可以重試。
// 只連 hub（已配對的那一台），不連 GitHub、不呼叫 LLM。
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  compareVersions,
  releaseAssetName,
  releaseDownloadPath,
  UPDATE_FAILED,
  UPDATE_IN_PROGRESS,
  UPDATE_STALE_MS,
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
/** daemon 寫了 installing、更新程式還沒拿到鎖的空檔：這段時間內沒有鎖不算中斷。 */
const SPAWN_GRACE_MS = 60_000;

export const UPDATE_STATE_FILE = 'update-state.json';
export const DAEMON_STATUS_FILE = 'daemon-status.json';
/** 解好、檢查過的新版（`.incoming/<版本>/` 裡）才有這個檔（W2）。 */
export const EXTRACTED_MARKER = '.extracted';

/** 安裝程式寫的 `<安裝根目錄>/install.json`（只讀這裡用得到的欄位）。 */
const InstallState = z.object({
  roles: z.array(z.string()).catch([]),
  currentVersion: z.string().nullable().optional().catch(null),
  previousVersion: z.string().nullable().optional().catch(null),
  previousRelease: z.string().nullable().optional().catch(null),
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

const DAEMON_STARTED_AT = new Date().toISOString();

/**
 * 更新程式的健康檢查看這個檔（S3b）：daemon 一啟動就寫（connectedAt null＝程序起來了但還沒連上 hub），
 * 連上 hub 再寫一次。「程序活著但連不到 hub」和「起不來／崩潰」分得開。
 */
export async function writeDaemonStatus(
  dataDir: string,
  status: { version: string; buildId: string; connected: boolean },
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = join(dataDir, `.${DAEMON_STATUS_FILE}.${randomBytes(4).toString('hex')}`);
  const body = {
    pid: process.pid,
    version: status.version,
    buildId: status.buildId,
    startedAt: DAEMON_STARTED_AT,
    connectedAt: status.connected ? new Date().toISOString() : null,
  };
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** update.lock 的持有者（更新程式）還活著嗎。 */
export function updaterLockHeld(root: string): boolean {
  try {
    const pid = Number(readFileSync(join(root, 'update.lock'), 'utf8').trim());
    return pid > 0 && pidAlive(pid);
  } catch {
    return false;
  }
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
 * 啟動不了（例如 node 或工作目錄不見了）會 reject（S2）；紀錄檔的 fd 交給子程序後就關掉。
 * Linux 限制：systemd user unit 預設 KillMode=control-group，停 daemon 會殺掉整個 cgroup，setsid 擋不住；
 * 目前沒有 Linux 成品（hub 不發目標），之後要支援得改用 systemd-run --user --scope 啟動（CONTRACTS §21.7）。
 */
export function spawnDetached(
  request: SpawnRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
  const out = openSync(request.logFile, 'a', 0o600);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [request.script, ...request.args], {
        cwd: request.cwd,
        detached: true,
        stdio: ['ignore', out, out],
        env,
        windowsHide: true,
      });
    } catch (error) {
      reject(error as Error);
      return;
    } finally {
      closeSync(out);
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid ?? 0);
    });
  });
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

function tarList(archive: string, verbose: boolean): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      [verbose ? '-tvf' : '-tf', archive],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout) =>
        error ? reject(error) : resolve(stdout.split(/\r?\n/).filter((line) => line.length > 0)),
    );
  });
}

/** 一個成品裡的路徑（或連結的目標，相對於連結所在的資料夾）是否留在 agent-board/ 底下。 */
export function insideRelease(path: string, linkTarget?: string): boolean {
  const unixPath = path.replaceAll('\\', '/');
  if (unixPath.startsWith('/') || /^[A-Za-z]:/.test(unixPath)) return false;
  let resolved = posix.normalize(unixPath);
  if (linkTarget !== undefined) {
    const target = linkTarget.replaceAll('\\', '/');
    if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return false;
    resolved = posix.normalize(posix.join(posix.dirname(unixPath), target));
  }
  return resolved === 'agent-board' || resolved.startsWith('agent-board/');
}

/**
 * 解壓前檢查內容清單（B4）：每一項都要在 agent-board/ 底下、沒有絕對路徑或 ..；symlink 與 hard link 的目標
 * 也不能指出 agent-board/。`tar -tvf` 的連結寫成 `名稱 -> 目標`（symlink）或 `名稱 link to 目標`（hard link）。
 */
export async function checkArchive(archive: string): Promise<void> {
  const names = await tarList(archive, false);
  for (const name of names) {
    if (!insideRelease(name)) throw new Error(`成品裡有不該有的路徑：${name}`);
  }
  for (const line of await tarList(archive, true)) {
    for (const marker of [' -> ', ' link to ']) {
      const at = line.lastIndexOf(marker);
      if (at < 0) continue;
      const target = line.slice(at + marker.length);
      const head = line.slice(0, at);
      const name = names.find((n) => head.endsWith(` ${n}`) || head.endsWith(n.replace(/\/$/, '')));
      if (!name) throw new Error(`看不懂成品裡的連結：${line}`);
      const ok = marker === ' -> ' ? insideRelease(name, target) : insideRelease(target);
      if (!ok) throw new Error(`成品裡的連結指出了發布檔：${name} -> ${target}`);
    }
  }
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
  spawnUpdater?: (request: SpawnRequest) => Promise<unknown>;
  fetch?: typeof fetch;
  /** 解壓：預設用系統的 tar（macOS、Windows 10 以上都有，zip 也吃）。 */
  extract?: (archive: string, dest: string) => Promise<void>;
  /** 解壓前檢查內容清單；預設 checkArchive。 */
  inspectArchive?: (archive: string) => Promise<void>;
  /** 更新程式的鎖還有人拿著嗎；預設看 `<安裝根目錄>/update.lock` 的 pid。 */
  lockHeld?: () => boolean;
  now?: () => Date;
  deferRetryMs?: number;
  /** 更新程式健康檢查的上限（毫秒）；預設 60 秒，測試縮短（`AGENT_BOARD_UPDATE_HEALTH_MS`）。 */
  healthTimeoutMs?: number;
  /** 新 daemon 起來了但還連不上 hub 時最多等多久（毫秒）；預設 5 分鐘，測試縮短。 */
  connectTimeoutMs?: number;
}

class UpdateFailure extends Error {
  constructor(
    readonly reason: UpdateReason,
    message: string,
  ) {
    super(message);
  }
}

type StateFields = Omit<UpdateState, 'at'>;

export class SelfUpdater {
  private target: ReleaseTarget | null = null;
  private force = false;
  private busy = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly deps: SelfUpdaterDeps) {}

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
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

  private async setState(state: StateFields): Promise<UpdateState> {
    const full: UpdateState = { ...state, at: new Date(this.nowMs()).toISOString() };
    try {
      await writeUpdateState(this.deps.dataDir, full);
    } catch (error) {
      log.warn(`寫不進更新狀態檔：${errorMessage(error)}`);
    }
    this.deps.report(full);
    return full;
  }

  /**
   * 進行中的狀態是不是已經沒人在做了（S1）。downloading 只有這個 daemon 下載時寫（busy），不 busy 就是
   * daemon 重啟過；其他階段：開始超過 15 分鐘，或更新程式的鎖沒人拿著（寫完 installing 一分鐘後還沒有）。
   */
  private staleness(state: UpdateState): string | null {
    if (!UPDATE_IN_PROGRESS.includes(state.phase)) return null;
    if (state.phase === 'downloading') {
      return this.busy ? null : 'daemon 在下載時重啟了';
    }
    const started = Date.parse(state.startedAt ?? state.at);
    if (this.nowMs() - started > UPDATE_STALE_MS) return '超過 15 分鐘沒有結束';
    const held = this.deps.lockHeld
      ? this.deps.lockHeld()
      : this.deps.installRoot !== null && updaterLockHeld(this.deps.installRoot);
    if (!held && this.nowMs() - Date.parse(state.at) > SPAWN_GRACE_MS) {
      return '更新程式已經不在了';
    }
    return null;
  }

  /** 過期的進行中狀態改成 failed/interrupted（可以重試）。回傳改完的狀態，沒過期回 null。 */
  private async expire(state: UpdateState): Promise<UpdateState | null> {
    const why = this.staleness(state);
    if (!why) return null;
    log.warn(
      `上次的更新（${state.fromVersion} → ${state.toVersion}，${state.phase}）中斷了：${why}`,
    );
    return this.setState({
      phase: 'failed',
      fromVersion: state.fromVersion,
      toVersion: state.toVersion,
      reason: 'interrupted',
      detail: `${state.phase}：${why}`,
    });
  }

  /** 連上 hub：上次的更新過期就標失敗；還在進行中就輪詢狀態檔，結果出來回報 hub。 */
  onConnected(): void {
    const state = this.state;
    if (!state) return;
    if (this.staleness(state)) {
      void this.expire(state);
      return;
    }
    if (UPDATE_IN_PROGRESS.includes(state.phase)) this.startPolling();
  }

  /**
   * 輪詢狀態檔直到結束（沒有時間上限；過期了就標中斷）。更新程式因為 session 忙碌把狀態寫成 deferred（W5）
   * 時，照延後的規則 5 分鐘後再試。
   */
  private startPolling(): void {
    if (this.pollTimer || this.disposed) return;
    let last = JSON.stringify(this.state);
    this.pollTimer = setInterval(() => {
      const next = this.state;
      const text = JSON.stringify(next);
      if (next && text !== last) {
        last = text;
        this.deps.report(next);
      }
      if (next && UPDATE_IN_PROGRESS.includes(next.phase)) {
        if (this.staleness(next)) {
          this.stopPolling();
          void this.expire(next);
        }
        return;
      }
      this.stopPolling();
      if (next?.phase === 'deferred') this.scheduleRetry();
    }, STATE_POLL_MS);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleRetry(action: () => void = () => void this.consider()): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      action();
    }, this.deps.deferRetryMs ?? UPDATE_DEFER_RETRY_MS);
    this.retryTimer.unref();
  }

  /** hub 給了新目標（welcome、release.target）。force：面板按「立即更新」。 */
  onTarget(target: ReleaseTarget | null, force: boolean): void {
    this.target = target;
    this.force = force;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.consider();
  }

  /** 要不要動手：版本不同、不是降級（除非 force）、上次沒在這版失敗過（除非 force；中斷的可以重試）。 */
  private async consider(): Promise<void> {
    const target = this.target;
    if (!target || this.busy || this.disposed) return;
    const { currentVersion, platform } = this.deps;
    if (target.platform !== platform || target.version === currentVersion) return;
    // 檔名一定要是這個版本與平台的成品（B2）。
    if (target.asset !== releaseAssetName(target.version, target.platform)) {
      log.warn(`hub 給的成品名稱不對：${target.asset}，不更新`);
      return;
    }
    const force = this.force;
    if (!force && compareVersions(target.version, currentVersion) < 0) return;
    let last = this.state;
    if (last && UPDATE_IN_PROGRESS.includes(last.phase)) {
      const expired = await this.expire(last);
      if (!expired) return;
      last = expired;
    }
    if (
      !force &&
      last &&
      UPDATE_FAILED.includes(last.phase) &&
      last.toVersion === target.version &&
      last.reason !== 'interrupted'
    ) {
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

  private defer(target: ReleaseTarget | null, reason: UpdateReason, toVersion: string | null) {
    this.scheduleRetry(target ? undefined : () => void this.rollback());
    return this.setState({
      phase: 'deferred',
      fromVersion: this.deps.currentVersion,
      toVersion,
      reason,
      detail: null,
    });
  }

  private async run(target: ReleaseTarget): Promise<void> {
    const root = this.deps.installRoot!;
    const from = this.deps.currentVersion;
    const startedAt = new Date(this.nowMs()).toISOString();
    const base = { fromVersion: from, toVersion: target.version, startedAt };
    const permission = updateDeferReason(this.deps.sessionStatuses(), false);
    if (permission) {
      await this.defer(target, permission, target.version);
      return;
    }
    const incoming = join(root, 'releases', '.incoming');
    const extracted = join(incoming, target.version);
    const source = join(extracted, 'agent-board');
    try {
      if (!this.extractedOk(extracted, target.version)) {
        await this.setState({
          ...base,
          phase: 'downloading',
          reason: null,
          detail: null,
          pid: process.pid,
        });
        await rm(incoming, { recursive: true, force: true });
        const partial = `${extracted}.partial`;
        await mkdir(partial, { recursive: true, mode: 0o700 });
        const archive = join(incoming, target.asset);
        await this.download(target, archive);
        try {
          await (this.deps.inspectArchive ?? checkArchive)(archive);
          await (this.deps.extract ?? tarExtract)(archive, partial);
        } catch (error) {
          throw new UpdateFailure('extract_failed', errorMessage(error));
        } finally {
          await rm(archive, { force: true });
        }
        if (!this.contentOk(join(partial, 'agent-board'), target.version)) {
          throw new UpdateFailure('extract_failed', 'release content does not match the version');
        }
        // 檢查都過了才寫完成標記、改名（W2）：半途中斷的 .partial 下次會整個重來。
        writeFileSync(join(partial, EXTRACTED_MARKER), `${target.sha256}\n`, { mode: 0o600 });
        await rename(partial, extracted);
      }
      // 這次要不要換 session host：新版的協定和現在跑的不同才要（§20.5）。換的話有工作中的 session 就延後。
      const hostChange = this.hostProtocolDiffers(
        join(source, 'session-host', 'dist', 'meta.json'),
      );
      const busy = updateDeferReason(this.deps.sessionStatuses(), hostChange);
      if (busy) {
        await this.defer(target, busy, target.version);
        return;
      }
      await this.setState({ ...base, phase: 'installing', reason: null, detail: null });
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
        '--started-at',
        startedAt,
        ...this.timeoutArgs(),
      ];
      const request: SpawnRequest = {
        script: join(source, 'scripts', 'updater.mjs'),
        args,
        cwd: root,
        logFile: join(this.deps.dataDir, 'logs', 'updater.log'),
      };
      log.info(`開始更新 ${from} → ${target.version}（獨立的更新程式，紀錄 ${request.logFile}）`);
      try {
        await (this.deps.spawnUpdater ?? ((r) => spawnDetached(r)))(request);
      } catch (error) {
        throw new UpdateFailure('spawn_failed', errorMessage(error));
      }
      this.startPolling();
    } catch (error) {
      const reason = error instanceof UpdateFailure ? error.reason : 'unknown';
      log.warn(`更新到 ${target.version} 失敗（${reason}）：${errorMessage(error)}`);
      await rm(incoming, { recursive: true, force: true }).catch(() => undefined);
      await this.setState({
        ...base,
        phase: 'failed',
        reason,
        detail: errorMessage(error).slice(0, 500),
      });
    }
  }

  private timeoutArgs(): string[] {
    const args: string[] = [];
    if (this.deps.healthTimeoutMs) {
      args.push('--health-timeout-ms', String(this.deps.healthTimeoutMs));
    }
    if (this.deps.connectTimeoutMs) {
      args.push('--connect-timeout-ms', String(this.deps.connectTimeoutMs));
    }
    return args;
  }

  /** 解好的新版：有完成標記、內容版本對（W2）。 */
  private extractedOk(extracted: string, version: string): boolean {
    return (
      existsSync(join(extracted, EXTRACTED_MARKER)) &&
      this.contentOk(join(extracted, 'agent-board'), version)
    );
  }

  private contentOk(source: string, version: string): boolean {
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

  /** 某一版的 session host 協定和現在跑的不同（要換 host，會結束 agent）。 */
  private hostProtocolDiffers(metaPath: string): boolean {
    try {
      const { protocol } = JSON.parse(readFileSync(metaPath, 'utf8')) as { protocol?: unknown };
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

  /**
   * 面板「回滾到上一版」：用現在這版的更新程式把 current 指回上一版。延後條件和更新一樣（W6）：有 PERM 延後；
   * 上一版的 session host 協定不同（要換 host）而有工作中的 session 也延後，5 分鐘後再試。
   */
  async rollback(): Promise<void> {
    const root = this.deps.installRoot;
    const from = this.deps.currentVersion;
    const install = readInstallState(root);
    const previous = install?.previousVersion ?? null;
    const previousRelease = install?.previousRelease ?? null;
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
    const hostChange =
      previousRelease !== null &&
      this.hostProtocolDiffers(
        join(root, 'releases', previousRelease, 'session-host', 'dist', 'meta.json'),
      );
    const busy = updateDeferReason(this.deps.sessionStatuses(), hostChange);
    if (busy) {
      await this.defer(null, busy, previous);
      return;
    }
    const startedAt = new Date(this.nowMs()).toISOString();
    await this.setState({
      phase: 'rolling_back',
      fromVersion: from,
      toVersion: previous,
      reason: 'rollback_requested',
      detail: null,
      startedAt,
    });
    const args = [
      'rollback',
      '--data',
      this.deps.dataDir,
      '--root',
      root,
      '--started-at',
      startedAt,
      ...this.timeoutArgs(),
    ];
    try {
      await (this.deps.spawnUpdater ?? ((r) => spawnDetached(r)))({
        script: join(root, 'current', 'scripts', 'updater.mjs'),
        args,
        cwd: root,
        logFile: join(this.deps.dataDir, 'logs', 'updater.log'),
      });
    } catch (error) {
      await this.setState({
        phase: 'failed',
        fromVersion: from,
        toVersion: previous,
        reason: 'spawn_failed',
        detail: errorMessage(error).slice(0, 500),
        startedAt,
      });
      return;
    }
    this.startPolling();
  }
}
