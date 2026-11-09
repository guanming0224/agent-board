// 深層搜尋的 worker 管理：整個 daemon 共用一個 worker（DeepSearcher 本來就一次只跑一個搜尋、一次讀一份檔），
// 第一次搜尋才開、閒置 IDLE_MS 後關掉；unref，不會讓 daemon 因為它而不結束。
//
// 找 worker 檔：發布檔（esbuild 打包）是 daemon/dist/deepSearchWorker.mjs，和 index.mjs 同一個資料夾；
// 開發與測試直接跑 src/deepSearchWorker.ts，worker 裡沒有 tsx 的話自己加 `--import tsx`。
// worker 起不來（例如發布檔少了那個檔、一時開不了檔）：記一次警告，冷卻 COOLDOWN_MS 內在主執行緒掃（行為和以前一樣，
// 只是會佔主執行緒），冷卻過了再試開一次。
// worker 跑到一半壞掉（含 heap 超過 resourceLimits）：那一份檔的掃描失敗（DeepSearcher 當成這台只搜了一部分），
// 下次再開新的；daemon 主執行緒不受影響。
// 每個 worker 有自己的一份等待中工作（Live.pending）：舊 worker 晚到的 exit／error 只清它自己的，不會牽連新 worker。
// 看門狗：該停了（取消、讓位、時間或讀檔上限到了）卻超過 STUCK_GRACE_MS 還沒回（卡在單次讀檔或很重的一行），
// 直接 terminate 那個 worker，等待中的工作 reject，佇列不會被一直卡住。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { scanTranscriptFile, SharedBudget, type Budget, type FileScan } from './deepScan';
import { errorMessage, log } from './log';

/** 主執行緒 → worker：掃一份檔。 */
export interface ScanJob {
  id: number;
  file: string;
  sessionId: string;
  terms: readonly string[];
  mask: boolean;
  sinceMs: number;
  maxHits: number;
  /** SharedBudget 的 SharedArrayBuffer（共用，不複製）。 */
  control: SharedArrayBuffer;
}

/** worker → 主執行緒。 */
export type ScanReply =
  | { type: 'ready' }
  | { type: 'scan'; id: number; ok: true; scan: FileScan }
  | { type: 'scan'; id: number; ok: false; error: string };

export interface ScanOptions {
  terms: readonly string[];
  mask: boolean;
  sinceMs: number;
  maxHits: number;
  budget: Budget;
}

/** 閒置多久關掉 worker。 */
const IDLE_MS = 60_000;
/** worker 起不來之後，多久內不再試（在主執行緒掃）。 */
const COOLDOWN_MS = 10 * 60_000;
/** 該停了之後，worker 最多再給多久回覆；超過就當成卡住、terminate。 */
const STUCK_GRACE_MS = 5_000;
/** 看門狗多久看一次。 */
const WATCH_MS = 500;
/** worker 的 heap 上限：一份檔一塊一塊讀，用不到這麼多；超過時只有 worker 壞掉，不會拖垮 daemon。 */
const WORKER_HEAP_MB = 256;

/** worker 在 ready 之前就出錯：檔案不在、載入失敗。 */
class WorkerStartError extends Error {}

export interface WorkerSpec {
  url: URL;
  execArgv: string[] | undefined;
}

function workerSpec(): WorkerSpec {
  if (!import.meta.url.endsWith('.ts')) {
    return { url: new URL('./deepSearchWorker.mjs', import.meta.url), execArgv: undefined };
  }
  const url = new URL('./deepSearchWorker.ts', import.meta.url);
  // 已經用 tsx 跑（daemon 開發模式）：worker 繼承 execArgv 就有。vitest 之類沒有的：自己加。
  // 只認 tsx 自己的載入檔（…/tsx/dist/…）；vitest 的路徑裡也有「tsx@」字樣，不能只比對 tsx。
  if (process.execArgv.some((arg) => /[\\/]tsx[\\/]dist[\\/]/.test(arg))) {
    return { url, execArgv: undefined };
  }
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return { url, execArgv: ['--import', tsx] };
}

interface Pending {
  resolve(scan: FileScan): void;
  reject(error: Error): void;
}

/** 一個 worker 和只屬於它的等待中工作。 */
interface Live {
  worker: Worker;
  pending: Map<number, Pending>;
  ready: Promise<void>;
}

export interface ScanWorkerOptions {
  /** 測試用：指定 worker 檔（例如不存在的檔、不回覆的假 worker）。 */
  spec?: () => WorkerSpec;
  cooldownMs?: number;
  stuckGraceMs?: number;
  watchMs?: number;
}

export class ScanWorker {
  private live: Live | null = null;
  private nextId = 1;
  private idle: NodeJS.Timeout | null = null;
  /** worker 起不來之後，到這個時間之前都在主執行緒掃（0＝沒有停用）。 */
  private disabledUntil = 0;
  private readonly spec: () => WorkerSpec;
  private readonly cooldownMs: number;
  private readonly stuckGraceMs: number;
  private readonly watchMs: number;

  constructor(options: ScanWorkerOptions = {}) {
    this.spec = options.spec ?? workerSpec;
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
    this.stuckGraceMs = options.stuckGraceMs ?? STUCK_GRACE_MS;
    this.watchMs = options.watchMs ?? WATCH_MS;
  }

  /** 現在是不是退回主執行緒掃（worker 起不來、還在冷卻期）。 */
  get disabled(): boolean {
    return Date.now() < this.disabledUntil;
  }

  /** 測試用：現在的 worker（模擬舊 worker 晚到的事件）。 */
  get currentWorker(): Worker | null {
    return this.live?.worker ?? null;
  }

  /** 測試用：現在的 worker 上有幾份工作在等。 */
  get pendingCount(): number {
    return this.live?.pending.size ?? 0;
  }

  async scan(file: string, sessionId: string, options: ScanOptions): Promise<FileScan> {
    // 一般物件的 Budget 沒辦法跨執行緒共用（取消、讓位看不到）：在主執行緒掃。
    const budget = options.budget instanceof SharedBudget ? options.budget : null;
    if (this.disabled || budget === null) return scanInline(file, sessionId, options);
    let live: Live;
    try {
      live = await this.start();
    } catch (error) {
      if (!(error instanceof WorkerStartError)) throw error;
      this.disabledUntil = Date.now() + this.cooldownMs;
      log.warn(
        `深層搜尋的 worker 起不來，${Math.round(this.cooldownMs / 60_000)} 分鐘內改在主執行緒掃：${error.message}`,
      );
      return scanInline(file, sessionId, options);
    }
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const id = this.nextId++;
    const job: ScanJob = {
      id,
      file,
      sessionId,
      terms: options.terms,
      mask: options.mask,
      sinceMs: options.sinceMs,
      maxHits: options.maxHits,
      control: budget.buffer,
    };
    // 看門狗：第一次看到「該停了」起算，超過寬限還沒回就 terminate 這個 worker。
    let stopSeenAt: number | null = null;
    const watch = setInterval(() => {
      const now = Date.now();
      const shouldStop =
        budget.cancelled || now > budget.deadline || budget.bytes >= budget.maxBytes;
      if (!shouldStop) return;
      stopSeenAt ??= now;
      if (now - stopSeenAt >= this.stuckGraceMs) {
        log.warn(`深層搜尋 worker 該停卻沒回（${file}），關掉重開`);
        this.kill(live, new Error('深層搜尋 worker 卡住，已關掉'));
      }
    }, this.watchMs);
    watch.unref();
    try {
      return await new Promise<FileScan>((resolve, reject) => {
        // ready 之後到這裡之間 worker 已經掉了（drop 過）：不送，直接失敗，不會一直等。
        if (this.live !== live) {
          reject(new Error('深層搜尋 worker 已關掉'));
          return;
        }
        live.pending.set(id, { resolve, reject });
        live.worker.postMessage(job);
      });
    } finally {
      clearInterval(watch);
      live.pending.delete(id);
      if (live.pending.size === 0 && this.live === live) this.armIdle();
    }
  }

  /** 開 worker 並等它 ready（已經開好就直接回）。 */
  private async start(): Promise<Live> {
    if (this.live) {
      await this.live.ready;
      return this.live;
    }
    const { url, execArgv } = this.spec();
    let worker: Worker;
    try {
      worker = new Worker(url, {
        ...(execArgv ? { execArgv } : {}),
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
    } catch (error) {
      throw new WorkerStartError(errorMessage(error));
    }
    worker.unref();
    const pending = new Map<number, Pending>();
    let isReady = false;
    const ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (reply: ScanReply) => {
        if (reply.type === 'ready') {
          isReady = true;
          resolve();
          return;
        }
        const waiting = pending.get(reply.id);
        if (!waiting) return;
        if (reply.ok) waiting.resolve(reply.scan);
        else waiting.reject(new Error(reply.error));
      });
      const fail = (error: Error) => {
        if (!isReady) reject(new WorkerStartError(error.message));
        this.drop(live, error);
      };
      worker.on('error', (error: unknown) =>
        fail(error instanceof Error ? error : new Error(errorMessage(error))),
      );
      worker.on('exit', (code) => fail(new Error(`深層搜尋 worker 結束（${code}）`)));
    });
    // 沒人等的時候 reject 不要變成 unhandled rejection。
    ready.catch(() => undefined);
    // fail 只會在事件送到時才呼叫（一定在這行之後），所以可以在上面的 closure 裡用 live。
    const live: Live = { worker, pending, ready };
    this.live = live;
    await ready;
    return live;
  }

  /** 這個 worker 不用了：不再是現在的那個，它自己等待中的工作全部 reject（別的 worker 的不碰）。 */
  private drop(live: Live, error: Error): void {
    if (this.live === live) this.live = null;
    for (const waiting of live.pending.values()) waiting.reject(error);
    live.pending.clear();
  }

  /** 丟掉並 terminate。 */
  private kill(live: Live, error: Error): void {
    this.drop(live, error);
    void live.worker.terminate().catch((e: unknown) => log.warn(errorMessage(e)));
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.pendingCount > 0) return;
      this.stop();
    }, IDLE_MS);
    this.idle.unref();
  }

  /** 關掉 worker（閒置、或測試要確認重開）。還在等的工作 reject（不會掛著）。 */
  stop(): void {
    if (this.live) this.kill(this.live, new Error('深層搜尋 worker 已關掉'));
  }
}

function scanInline(file: string, sessionId: string, options: ScanOptions): Promise<FileScan> {
  return scanTranscriptFile(file, sessionId, { ...options, now: Date.now });
}

/** 整個 daemon 共用的那一個。 */
export const scanWorker = new ScanWorker();

/** 在 worker 掃一份對話紀錄（worker 起不來就在主執行緒）。 */
export function scanInWorker(
  file: string,
  sessionId: string,
  options: ScanOptions,
): Promise<FileScan> {
  return scanWorker.scan(file, sessionId, options);
}
