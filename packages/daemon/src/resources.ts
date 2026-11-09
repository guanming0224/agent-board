// 機器資源回報（CONTRACTS §6.2）與 hello 用的硬體能力。
import { execFile } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { promisify } from 'node:util';
import type { DaemonToHub, MachineCapabilities, ResourceSample } from '@agent-board/protocol';
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

async function probeCodex(codexBin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
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

export async function probeCapabilities(
  claudeBin: string,
  env: NodeJS.ProcessEnv,
  codexBin?: string,
): Promise<MachineCapabilities> {
  const gpu = await queryNvidiaGpu();
  // 找不到 codex 就不回報（hub 與新增 session 頁據此不讓選 Codex）。
  const codexVersion = codexBin ? await probeCodex(codexBin, env) : null;
  let claudeVersion: string | null = null;
  try {
    const { stdout } = await execFileAsync(claudeBin, ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      env,
    });
    claudeVersion = stdout.trim().split(/\s+/)[0] || null;
  } catch {
    log.warn(`無法取得 claude 版本（${claudeBin}）`);
  }
  return {
    hasGpu: gpu !== null,
    gpuName: gpu?.name ?? null,
    cpuCores: availableParallelism(),
    memoryBytes: totalmem(),
    claudeVersion,
    ...(codexVersion ? { codexVersion } : {}),
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
