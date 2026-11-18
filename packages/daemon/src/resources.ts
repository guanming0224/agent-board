// 機器資源回報（CONTRACTS §6.2）與 hello 用的硬體能力。
import { execFile } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { promisify } from 'node:util';
import {
  CODEX_CATALOG_MAX_BYTES,
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

/** `codex debug models` 的逾時：要先向 OpenAI 更新目錄（實測第一次約 0.6 秒），網路慢時寬一點。 */
const CODEX_CATALOG_TIMEOUT_MS = 20_000;
/** 允許的兩種寫法（scripts/check-no-llm.mjs 逐字比對）：先照常（會更新目錄），失敗再只讀內建目錄。 */
const CODEX_CATALOG_ARGS = ['debug', 'models'];
const CODEX_BUNDLED_CATALOG_ARGS = ['debug', 'models', '--bundled'];
/**
 * 先確認這版 codex 真的有 `debug models`：沒有這個子指令的舊版會把 `debug` 當成第一句 prompt（`codex [PROMPT]`），
 * 不能直接跑。`--help` 在哪個版本都只印說明就結束；新版的說明有「model catalog」，舊版印的是主說明。
 */
const CODEX_CATALOG_HELP_ARGS = ['debug', 'models', '--help'];
const CODEX_CATALOG_HELP_RE = /model catalog/i;

/**
 * 這台 codex 的模型目錄（CONTRACTS §26.11）：`codex debug models` 只印目錄 JSON，不開對話、不做模型推論。
 * 注意它不是純本機：codex 會用使用者的登入向 OpenAI 抓最新目錄並寫進 codex 自己的快取（`~/.codex/models_cache.json`），
 * 連不上時用快取（2026-11-18 實測，見 docs/no-llm-review.md）。失敗再試 `--bundled`（只讀執行檔內建的目錄，不連網）。
 * 只留 slug／顯示名稱／預設強度／支援強度／visibility（`parseCodexModelCatalog`），輸出超過上限當抓不到。
 */
export async function probeCodexModels(
  codexBin: string,
  env: NodeJS.ProcessEnv,
  codexVersion: string | null,
): Promise<CodexModels | null> {
  try {
    const { stdout } = await execFileAsync(codexBin, CODEX_CATALOG_HELP_ARGS, {
      timeout: PROBE_TIMEOUT_MS,
      env,
      maxBuffer: 1024 * 1024,
    });
    if (!CODEX_CATALOG_HELP_RE.test(stdout)) {
      log.warn('這版 codex 沒有 debug models（說明裡沒有 model catalog），不抓模型目錄');
      return null;
    }
  } catch (error) {
    log.warn(`無法執行 codex debug models --help：${errorMessage(error)}`);
    return null;
  }
  for (const args of [CODEX_CATALOG_ARGS, CODEX_BUNDLED_CATALOG_ARGS]) {
    try {
      const { stdout } = await execFileAsync(codexBin, args, {
        timeout: CODEX_CATALOG_TIMEOUT_MS,
        env,
        maxBuffer: CODEX_CATALOG_MAX_BYTES,
      });
      const models = parseCodexModelCatalog(stdout);
      if (models && models.length > 0) return { codexVersion, models };
      log.warn(`讀不懂 codex ${args.join(' ')} 的輸出`);
    } catch (error) {
      log.warn(`無法執行 codex ${args.join(' ')}：${errorMessage(error)}`);
    }
  }
  return null;
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
 * codex 自動更新後重抓目錄（§26.11，比照 §26.10 的 claude）：看 `codex --version`，版本變了（含剛裝好、被移除）才重跑
 * `codex debug models`。沒變回 null（不必更新 capabilities）。
 */
export async function refreshCodexCapabilities(
  current: MachineCapabilities,
  codexBin: string,
  env: NodeJS.ProcessEnv,
  probes: CodexProbes = CODEX_PROBES,
): Promise<Pick<MachineCapabilities, 'codexVersion' | 'codexModels'> | null> {
  const version = await probes.version(codexBin, env);
  if (version === (current.codexVersion ?? null)) return null;
  log.info(
    `codex 版本 ${current.codexVersion ?? '（沒有）'} → ${version ?? '（沒有）'}，重新抓模型目錄`,
  );
  if (version === null) return { codexVersion: undefined, codexModels: null };
  return { codexVersion: version, codexModels: await probes.models(codexBin, env, version) };
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
  const codexModels =
    codexBin && codexVersion ? await probeCodexModels(codexBin, env, codexVersion) : null;
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
    // 一律帶這個鍵（null＝抓不到）：網頁據此知道 daemon 認得依模型的 Codex 強度（§26.11）。
    codexModels,
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
