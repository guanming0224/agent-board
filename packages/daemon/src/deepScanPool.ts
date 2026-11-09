// 深層搜尋的 worker 管理：整個 daemon 共用一個 worker（DeepSearcher 本來就一次只跑一個搜尋、一次讀一份檔），
// 第一次搜尋才開、閒置 IDLE_MS 後關掉；unref，不會讓 daemon 因為它而不結束。
//
// 找 worker 檔：發布檔（esbuild 打包）是 daemon/dist/deepSearchWorker.mjs，和 index.mjs 同一個資料夾；
// 開發與測試直接跑 src/deepSearchWorker.ts，worker 裡沒有 tsx 的話自己加 `--import tsx`。
// worker 起不來（例如發布檔少了那個檔）：記一次警告，之後都在主執行緒掃（行為和以前一樣，只是會佔主執行緒）。
// worker 跑到一半壞掉：那一份檔的掃描失敗（DeepSearcher 回 timeout，和以前讀檔出錯一樣），下次再開新的。
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

/** worker 在 ready 之前就出錯：檔案不在、載入失敗。 */
class WorkerStartError extends Error {}

function workerSpec(): { url: URL; execArgv: string[] | undefined } {
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

class ScanWorker {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: NodeJS.Timeout | null = null;
  /** worker 起不來過一次：之後都在主執行緒掃。 */
  disabled = false;

  async scan(file: string, sessionId: string, options: ScanOptions): Promise<FileScan> {
    // 一般物件的 Budget 沒辦法跨執行緒共用（取消、讓位看不到）：在主執行緒掃。
    const budget = options.budget instanceof SharedBudget ? options.budget : null;
    if (this.disabled || budget === null) return scanInline(file, sessionId, options);
    try {
      await this.start();
    } catch (error) {
      if (!(error instanceof WorkerStartError)) throw error;
      this.disabled = true;
      log.warn(`深層搜尋的 worker 起不來，改在主執行緒掃：${error.message}`);
      return scanInline(file, sessionId, options);
    }
    const worker = this.worker!;
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
    try {
      return await new Promise<FileScan>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage(job);
      });
    } finally {
      this.pending.delete(id);
      if (this.pending.size === 0 && this.worker === worker) this.armIdle();
    }
  }

  /** 開 worker 並等它 ready（已經開好就直接回）。 */
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const { url, execArgv } = workerSpec();
    const worker = new Worker(url, execArgv ? { execArgv } : {});
    worker.unref();
    this.worker = worker;
    let isReady = false;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.on('message', (reply: ScanReply) => {
        if (reply.type === 'ready') {
          isReady = true;
          resolve();
          return;
        }
        const waiting = this.pending.get(reply.id);
        if (!waiting) return;
        if (reply.ok) waiting.resolve(reply.scan);
        else waiting.reject(new Error(reply.error));
      });
      const fail = (error: Error) => {
        if (this.worker === worker) {
          this.worker = null;
          this.ready = null;
        }
        if (!isReady) reject(new WorkerStartError(error.message));
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
      };
      worker.on('error', (error: unknown) =>
        fail(error instanceof Error ? error : new Error(errorMessage(error))),
      );
      worker.on('exit', (code) => fail(new Error(`深層搜尋 worker 結束（${code}）`)));
    });
    // 沒人等的時候 reject 不要變成 unhandled rejection。
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.pending.size > 0) return;
      this.stop();
    }, IDLE_MS);
    this.idle.unref();
  }

  /** 關掉 worker（閒置、或測試要確認重開）。 */
  stop(): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) void worker.terminate().catch((error) => log.warn(errorMessage(error)));
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
