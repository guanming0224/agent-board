// 機器資源回報（CONTRACTS §6.2）與 hello 用的硬體能力。
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CODEX_CATALOG_MAX_BYTES,
  CodexModels as CodexModelsSchema,
  parseClaudeHelp,
  parseCodexModelCatalog,
  type ClaudeFlags,
  type CodexModels,
  type DaemonToHub,
  type MachineCapabilities,
  type ResourceSample,
} from '@agent-board/protocol';
import si from 'systeminformation';
import { errorMessage, log } from './log';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;
const MIB = 1024 * 1024;

type GpuSample = NonNullable<ResourceSample['gpu']>;
type CpuMemSample = Pick<ResourceSample, 'cpuPercent' | 'memoryUsedBytes' | 'memoryTotalBytes'>;

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

export function parseNvidiaSmi(stdout: string): GpuSample | null {
  const first = stdout.split('\n')[0]?.trim();
  if (!first) return null;
  const [name, util, used, total] = first.split(',').map((part) => part.trim());
  const nums = [util, used, total].map(Number);
  if (!name || nums.some((n) => !Number.isFinite(n))) return null;
  return {
    name,
    utilizationPercent: clampPercent(nums[0] as number),
    memoryUsedBytes: Math.round((nums[1] as number) * MIB),
    memoryTotalBytes: Math.round((nums[2] as number) * MIB),
  };
}

/** 沒有 nvidia-smi 或查詢失敗都視為沒有 GPU。 */
export async function queryNvidiaGpu(): Promise<GpuSample | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return parseNvidiaSmi(stdout);
  } catch {
    return null;
  }
}

async function sampleCpuMem(): Promise<CpuMemSample> {
  const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  return {
    cpuPercent: clampPercent(load.currentLoad),
    // active 不含可回收的快取，比 used 更接近實際壓力。
    memoryUsedBytes: Math.max(0, Math.round(mem.active)),
    memoryTotalBytes: Math.max(0, Math.round(mem.total)),
  };
}

/** `<bin> --version` 輸出裡的版本號（claude：`2.1.316 (Claude Code)`；codex：`codex-cli 0.167.0`）。 */
export function parseVersion(stdout: string): string | null {
  const tokens = stdout.trim().split(/\s+/);
  return tokens.find((token) => /^\d+\.\d+/.test(token)) ?? tokens[0] ?? null;
}

export async function probeCodex(codexBin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(codexBin, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      env,
    });
    return parseVersion(stdout) || null;
  } catch {
    // 沒裝 codex 是常態，不記警告。
    return null;
  }
}

/** `claude --version` 的版本號；跑不起來回 null。 */
export async function probeClaudeVersion(
  claudeBin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      env,
    });
    return stdout.trim().split(/\s+/)[0] || null;
  } catch {
    log.warn(`無法取得 claude 版本（${claudeBin}）`);
    return null;
  }
}

/**
 * 這台 claude 認得哪些模型參數（§26.10）：跑 `claude --help`（只印說明，不呼叫模型、不開對話），
 * 解析 `--effort`、`--fallback-model`。跑不起來回 null（＝都不帶）。
 */
export async function probeClaudeFlags(
  claudeBin: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeFlags | null> {
  try {
    const { stdout } = await execFileAsync(claudeBin, ['--help'], {
      timeout: PROBE_TIMEOUT_MS,
      env,
      maxBuffer: 1024 * 1024,
    });
    return parseClaudeHelp(stdout);
  } catch (error) {
    log.warn(`無法讀取 claude --help（${claudeBin}）：${errorMessage(error)}`);
    return null;
  }
}

/**
 * `codex debug models` 的逾時：要先向 OpenAI 更新目錄（實測第一次約 0.6 秒），連不上時 codex 會用快取。
 * 在背景跑（不擋 hub 連線，§26.11），但網路被黑洞時也不要卡太久。
 */
const CODEX_CATALOG_TIMEOUT_MS = 8_000;
/** 允許的寫法（scripts/check-no-llm.mjs 逐字比對）：先照常（會更新目錄），失敗再只讀內建目錄。 */
const CODEX_CATALOG_ARGS = ['debug', 'models'];
const CODEX_BUNDLED_CATALOG_ARGS = ['debug', 'models', '--bundled'];
/**
 * 先確認這版 codex 真的有 `debug models`：沒有這個子指令的舊版會把 `debug` 當成第一句 prompt（`codex [PROMPT]`），
 * 不能直接跑。`--help` 在哪個版本都只印說明就結束；新版（0.167.0 實測）第一行是
 * 「Render the raw model catalog as JSON」，舊版印的是主說明。
 */
const CODEX_CATALOG_HELP_ARGS = ['debug', 'models', '--help'];
export const CODEX_CATALOG_HELP_RE = /model catalog/i;

export interface CodexProbeResult {
  stdout: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  tooLarge: boolean;
  /** 啟動不了（ENOENT 之類）的錯誤代碼。 */
  spawnError: string | null;
}

/** 結束整棵程序樹：POSIX 用程序群組（spawn 時 detached），Windows 用 taskkill /T。 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 群組已經沒了。
  }
}

/**
 * 跑一次 codex 探測指令（§26.11）：stdin 不接（`ignore`，codex 不會等輸入）、stderr 不留內容；逾時或輸出超過上限時
 * 連孫程序一起收掉。參數只能是本檔的 CODEX_*_ARGS 常數（scripts/check-no-llm.mjs 檢查）。
 */
export function runCodexProbe(
  codexBin: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number },
): Promise<CodexProbeResult> {
  return new Promise((resolve) => {
    const result: CodexProbeResult = {
      stdout: '',
      code: null,
      signal: null,
      timedOut: false,
      tooLarge: false,
      spawnError: null,
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      result.stdout = Buffer.concat(chunks).toString('utf8');
      resolve(result);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      killTree(child?.pid);
    }, options.timeoutMs);
    try {
      const argv = [...args];
      child = spawn(codexBin, argv, {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      result.spawnError = (error as NodeJS.ErrnoException).code ?? 'spawn_failed';
      finish();
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) {
        if (!result.tooLarge) killTree(child.pid);
        result.tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    // stderr 可能帶帳號或路徑，不留內容（只讀掉，管線才不會塞住）。
    child.stderr?.resume();
    child.on('error', (error: NodeJS.ErrnoException) => {
      result.spawnError = error.code ?? 'spawn_failed';
      finish();
    });
    child.on('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      finish();
    });
  });
}

/** 失敗原因（log 用）：只記 exit code／signal／逾時，不記 stderr 內容。 */
function probeFailure(result: CodexProbeResult): string {
  if (result.spawnError) return `無法啟動（${result.spawnError}）`;
  if (result.timedOut) return '逾時';
  if (result.tooLarge) return '輸出超過上限';
  return `exit ${result.code ?? '?'}${result.signal ? `，signal ${result.signal}` : ''}`;
}

/**
 * 這台 codex 的模型目錄（CONTRACTS §26.11）：`codex debug models` 只印目錄 JSON，不開對話、不做模型推論。
 * 注意它不是純本機：codex 會用使用者的登入向 OpenAI 抓最新目錄並寫進 codex 自己的快取（`~/.codex/models_cache.json`），
 * 連不上時用快取（2026-11-18 實測，見 docs/no-llm-review.md）。失敗再試 `--bundled`（只讀執行檔內建的目錄，不連網）。
 * 只留 slug／顯示名稱／預設強度／支援強度／visibility（`parseCodexModelCatalog`），輸出超過上限當抓不到。
 * daemon 在背景呼叫（不擋開機與 hub 連線）。
 */
export async function probeCodexModels(
  codexBin: string,
  env: NodeJS.ProcessEnv,
  codexVersion: string | null,
  timeouts: { helpMs?: number; catalogMs?: number } = {},
): Promise<CodexModels | null> {
  const help = await runCodexProbe(codexBin, CODEX_CATALOG_HELP_ARGS, {
    env,
    timeoutMs: timeouts.helpMs ?? PROBE_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  });
  if (help.code !== 0 || help.timedOut || help.tooLarge) {
    log.warn(`無法執行 codex debug models --help：${probeFailure(help)}`);
    return null;
  }
  if (!CODEX_CATALOG_HELP_RE.test(help.stdout)) {
    log.warn('這版 codex 沒有 debug models（說明裡沒有 model catalog），不抓模型目錄');
    return null;
  }
  for (const args of [CODEX_CATALOG_ARGS, CODEX_BUNDLED_CATALOG_ARGS]) {
    const run = await runCodexProbe(codexBin, args, {
      env,
      timeoutMs: timeouts.catalogMs ?? CODEX_CATALOG_TIMEOUT_MS,
      maxBytes: CODEX_CATALOG_MAX_BYTES,
    });
    if (run.code !== 0 || run.timedOut || run.tooLarge) {
      log.warn(`無法執行 codex ${args.join(' ')}：${probeFailure(run)}`);
      continue;
    }
    const models = parseCodexModelCatalog(run.stdout);
    if (models && models.length > 0) return { codexVersion, models };
    log.warn(`讀不懂 codex ${args.join(' ')} 的輸出`);
  }
  return null;
}

/** 上次抓到的目錄存在 daemon 資料夾（只有那五個欄位），開機時接回 session 用（目錄在背景重抓，還沒好）。 */
const CODEX_MODELS_CACHE = 'codex-models.json';

/** 讀上次的目錄；codex 版本不同、讀不懂就當沒有。 */
export function loadCodexModelsCache(
  dataDir: string,
  codexVersion: string | null | undefined,
): CodexModels | null {
  if (!codexVersion) return null;
  try {
    const parsed = CodexModelsSchema.safeParse(
      JSON.parse(readFileSync(join(dataDir, CODEX_MODELS_CACHE), 'utf8')),
    );
    return parsed.success && parsed.data.codexVersion === codexVersion ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveCodexModelsCache(dataDir: string, catalog: CodexModels): void {
  try {
    writeFileSync(join(dataDir, CODEX_MODELS_CACHE), JSON.stringify(catalog), { mode: 0o600 });
  } catch (error) {
    log.warn(`寫不進 Codex 模型目錄快取：${errorMessage(error)}`);
  }
}

export interface CodexProbes {
  version: (codexBin: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  models: (
    codexBin: string,
    env: NodeJS.ProcessEnv,
    codexVersion: string | null,
  ) => Promise<CodexModels | null>;
}
const CODEX_PROBES: CodexProbes = { version: probeCodex, models: probeCodexModels };

/**
 * 重抓目錄（§26.11，比照 §26.10 的 claude）：看 `codex --version`，版本變了（含剛裝好、被移除）才重跑
 * `codex debug models`；版本沒變但上次沒抓到（null，例如開機時網路不通）也重試。`force`：開機後第一次（背景）一定抓。
 * 沒有要更新的回 null。
 */
export async function refreshCodexCapabilities(
  current: MachineCapabilities,
  codexBin: string,
  env: NodeJS.ProcessEnv,
  probes: CodexProbes = CODEX_PROBES,
  force = false,
): Promise<Pick<MachineCapabilities, 'codexVersion' | 'codexModels'> | null> {
  const version = await probes.version(codexBin, env);
  const same = version === (current.codexVersion ?? null);
  if (same && !force && (version === null || current.codexModels)) return null;
  if (!same) {
    log.info(
      `codex 版本 ${current.codexVersion ?? '（沒有）'} → ${version ?? '（沒有）'}，重新抓模型目錄`,
    );
  }
  if (version === null) {
    return same && !current.codexModels ? null : { codexVersion: undefined, codexModels: null };
  }
  const codexModels = await probes.models(codexBin, env, version);
  // 版本沒變、還是抓不到：不必更新。
  if (same && !codexModels && !current.codexModels) return null;
  return { codexVersion: version, codexModels };
}

export async function probeCapabilities(
  claudeBin: string,
  env: NodeJS.ProcessEnv,
  codexBin?: string,
): Promise<MachineCapabilities> {
  const gpu = await queryNvidiaGpu();
  // 找不到 codex 就不回報（hub 與新增 session 頁據此不讓選 Codex）。
  const codexVersion = codexBin ? await probeCodex(codexBin, env) : null;
  const claudeVersion = await probeClaudeVersion(claudeBin, env);
  const claudeFlags = claudeVersion === null ? null : await probeClaudeFlags(claudeBin, env);
  return {
    hasGpu: gpu !== null,
    gpuName: gpu?.name ?? null,
    cpuCores: availableParallelism(),
    memoryBytes: totalmem(),
    claudeVersion,
    ...(codexVersion ? { codexVersion } : {}),
    // 認得 SessionSpec.effort／fallbackModel（§26）：網頁據此決定要不要提示「daemon 太舊」。
    modelOptions: true,
    claudeFlags,
    // 一律帶這個鍵（null＝還沒抓到或抓不到）：網頁據此知道 daemon 認得依模型的 Codex 強度（§26.11）。
    // 目錄由 daemon 開機後在背景抓（refreshCodexCapabilities），抓完用 daemon.capabilities 送給 hub，不擋 hub 連線。
    codexModels: null,
  };
}

export interface ResourceMonitorOptions {
  send: (message: DaemonToHub) => void;
  sampleCpuMem?: () => Promise<CpuMemSample>;
  sampleGpu?: () => Promise<GpuSample | null>;
  now?: () => Date;
  cpuIntervalMs?: number;
  gpuIntervalMs?: number;
}

export class ResourceMonitor {
  private cpuTimer: NodeJS.Timeout | null = null;
  private gpuTimer: NodeJS.Timeout | null = null;
  private gpu: GpuSample | null = null;
  private sampling = false;
  /** 每次開始觀看遞增，讓暫停前還在跑的取樣不會送出去。 */
  private generation = 0;

  constructor(private readonly options: ResourceMonitorOptions) {}

  setWatching(watching: boolean): void {
    if (watching === (this.cpuTimer !== null)) return;
    if (!watching) {
      this.stop();
      return;
    }
    this.generation += 1;
    this.cpuTimer = setInterval(() => void this.tick(), this.options.cpuIntervalMs ?? 5_000);
    this.gpuTimer = setInterval(() => void this.pollGpu(), this.options.gpuIntervalMs ?? 10_000);
    // 打開側欄就要有數字，不等第一個週期。
    void this.pollGpu().then(() => this.tick());
  }

  stop(): void {
    this.generation += 1;
    if (this.cpuTimer) clearInterval(this.cpuTimer);
    if (this.gpuTimer) clearInterval(this.gpuTimer);
    this.cpuTimer = null;
    this.gpuTimer = null;
  }

  private async pollGpu(): Promise<void> {
    this.gpu = await (this.options.sampleGpu ?? queryNvidiaGpu)().catch(() => null);
  }

  private async tick(): Promise<void> {
    if (this.sampling || this.cpuTimer === null) return;
    const generation = this.generation;
    this.sampling = true;
    try {
      const sample = await (this.options.sampleCpuMem ?? sampleCpuMem)();
      if (generation !== this.generation) return;
      this.options.send({
        type: 'resources',
        sample: {
          at: (this.options.now?.() ?? new Date()).toISOString(),
          ...sample,
          gpu: this.gpu,
        },
      });
    } catch (error) {
      log.warn(`資源取樣失敗：${errorMessage(error)}`);
    } finally {
      this.sampling = false;
    }
  }
}
