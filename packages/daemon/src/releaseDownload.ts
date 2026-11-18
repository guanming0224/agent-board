// daemon 向 hub 下載更新成品（CONTRACTS §21.3、§21.12）：續傳、停滯偵測、退避重試、最後整檔驗 SHA-256。
//
// 2026-11-19 Windows 筆電連續兩次 download_failed（detail `terminated`：undici 的 body 5 分鐘沒資料就中止），
// 同一條路 Mac 正常。原因未確定，所以這裡的目標是「不管原因為何都自己下載完」，並留下下次找原因用的紀錄：
// - 寫到 `<成品>.part`（旁邊 `<成品>.part.json` 記 sha256／大小，不是這個成品的就刪掉重來），完成而且整檔
//   SHA-256 正確才改名成 `<成品>`。續傳時記憶體裡的 hash 不完整，所以完成後對整個檔案重算。用過續傳
//   （或沿用了上次留下的 .part）而 hash 不對，先從頭重下一次。
// - 自己的停滯偵測：連續 stallMs（預設 45 秒）沒收到資料（含等回應標頭）就中止這次連線，不等 undici 的 5 分鐘。
//   磁碟動作（寫 .part.json、開檔、寫入）不算網路停滯（做的時候停表），但各有上限 writeTimeoutMs
//   （預設 max(stallMs, 5 分鐘)），超過記成「寫檔停滯」並中止這次連線（防毒掃描卡住時不會永遠等下去）。
//   每次嘗試記下最久一次寫檔花多久（防毒掃描的線索）。磁碟錯誤（ENOSPC、EACCES…）不重試。
// - 中斷後送 `Range: bytes=<已下載>-` 續傳；伺服器回 200（舊 hub 不支援 Range）就從頭寫。回 206 但起點不對、
//   416、或收到的比總長多，就刪掉 .part 從頭來。401／403／404 不重試（token 或成品有問題，重試也沒用）。
// - 重試間隔退避（5s、15s、30s、60s…；這次有收到資料就回到最短的間隔），最多 maxAttempts 次（預設 8），
//   總時間上限 deadlineMs（預設 30 分鐘）。
// - 拿到回應之後不管怎麼結束都在同一個 finally 收：清所有計時器、沒完成就 abort 連線、關檔。
// - 改名被防毒／索引程式鎖住（Windows 的 EPERM／EBUSY／EACCES）：等 100ms、300ms、1s、3s 再試。
// - 進度每 progressMs（預設 5 秒；或多收 5% 而且距上次至少 1 秒）回呼一次：已收／總量、速度、第幾次嘗試。
// - 每次嘗試在 daemon 紀錄寫一行：起點、HTTP 狀態、收到的位元組、耗時、平均速度、最久寫檔、結束原因。
//   只記網址的路徑（不記主機、不記 token）。
// - `signal`（daemon 結束時）中止整個下載，不再重試。
// 用 Node 內建 fetch（測試注入），讀 body 用 reader，停滯／總時限都用自己的 AbortController。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Logger } from './log';

export const DEFAULT_STALL_MS = 45_000;
/** 第 n 次失敗後等多久再試（超過長度用最後一個）。 */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000];
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_DEADLINE_MS = 30 * 60_000;
export const DEFAULT_PROGRESS_MS = 5_000;
/** 單一磁碟動作的上限下限（實際是 max(stallMs, 這個)）。 */
export const MIN_WRITE_TIMEOUT_MS = 5 * 60_000;
/** 改名被鎖住時的重試間隔（Windows 防毒、索引程式）。 */
export const RENAME_RETRY_MS = [100, 300, 1_000, 3_000];

export interface DownloadProgress {
  received: number;
  total: number;
  /** 第幾次嘗試（1 起算）。 */
  attempt: number;
  /** 最近一段時間的速度（位元組／秒）。 */
  bytesPerSec: number;
}

export interface DownloadRequest {
  url: string;
  token: string;
  /** 完成後的成品路徑；下載中寫 `<dest>.part`。 */
  dest: string;
  sha256: string;
  size: number;
  fetch?: typeof fetch;
  stallMs?: number;
  /** 單一磁碟動作（寫記錄、開檔、寫入）的上限；預設 max(stallMs, 5 分鐘)。 */
  writeTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  deadlineMs?: number;
  progressMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  logger?: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 中止整個下載（daemon 結束）。 */
  signal?: AbortSignal;
  /** 測試用：開檔（模擬寫入卡住、磁碟錯誤）。 */
  openFile?: (path: string, flags: 'a' | 'w') => Promise<FileHandle>;
  /** 測試用：改名（模擬被鎖住）。 */
  renameFile?: (from: string, to: string) => Promise<void>;
}

export interface DownloadResult {
  attempts: number;
  /** 有沒有接著舊資料下載（伺服器回 206，或沿用了上次留下的 .part）。 */
  resumed: boolean;
}

/** 下載失敗：kind download＝連不上／一直斷（.part 保留，下次可續傳）；checksum＝整檔 SHA-256 不對（.part 刪掉）。 */
export class DownloadError extends Error {
  constructor(
    readonly kind: 'download' | 'checksum',
    message: string,
  ) {
    super(message);
  }
}

/** 一次嘗試怎麼結束的。 */
type Outcome =
  | { kind: 'complete' }
  | { kind: 'stall'; seconds: number; phase: 'headers' | 'body' | 'write' }
  | { kind: 'network'; code: string }
  /** 寫 .part／.part.json 失敗（磁碟滿、權限…）：不重試。 */
  | { kind: 'disk'; code: string }
  | { kind: 'http'; status: number; fatal: boolean }
  /** 連線正常結束但少了資料（伺服器提早關）。 */
  | { kind: 'short' }
  /** 206 的起點和要的不同、416、或收到的比總長多：.part 不可信，刪掉從頭來。 */
  | { kind: 'restart'; why: string }
  | { kind: 'deadline' }
  /** 外面要求中止（daemon 結束）。 */
  | { kind: 'aborted' };

export const partPath = (dest: string): string => `${dest}.part`;
const metaPath = (dest: string): string => `${dest}.part.json`;

/** 磁碟動作的錯誤（和網路錯誤分開）。 */
class DiskFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** 磁碟動作超過上限。 */
class WriteTimeout extends Error {}

/** fetch／undici 的錯誤代碼：cause 的 code（ECONNRESET、UND_ERR_SOCKET…）優先，其次訊息。 */
export function errorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const cause = e?.cause as { code?: unknown; message?: unknown } | undefined;
  const parts: string[] = [];
  if (typeof cause?.code === 'string') parts.push(cause.code);
  else if (typeof e?.code === 'string') parts.push(e.code);
  const message = typeof e?.message === 'string' ? e.message : String(error);
  parts.push(message);
  if (typeof cause?.message === 'string' && cause.message !== message) parts.push(cause.message);
  return parts.join(' ').slice(0, 160);
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export function describeOutcome(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'complete':
      return '完成';
    case 'stall':
      return outcome.phase === 'headers'
        ? `停滯（${outcome.seconds} 秒沒有回應標頭）`
        : outcome.phase === 'write'
          ? `寫檔停滯（${outcome.seconds} 秒沒有寫完）`
          : `停滯（${outcome.seconds} 秒沒有資料）`;
    case 'network':
      return `連線錯誤（${outcome.code}）`;
    case 'disk':
      return `寫檔錯誤（${outcome.code}）`;
    case 'http':
      return `HTTP ${outcome.status}`;
    case 'short':
      return '連線提早結束（資料不完整）';
    case 'restart':
      return `從頭重下（${outcome.why}）`;
    case 'deadline':
      return '超過總時間上限';
    case 'aborted':
      return '中止（daemon 結束）';
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** 解析 `Content-Range: bytes <起>-<迄>/<總長>`。 */
export function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header?.trim() ?? '');
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

/** 改名；被鎖住（EPERM／EBUSY／EACCES，Windows 防毒常見）就照 RENAME_RETRY_MS 再試。 */
export async function renameWithRetry(
  from: string,
  to: string,
  renameFn: (from: string, to: string) => Promise<void> = rename,
  delays: readonly number[] = RENAME_RETRY_MS,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await renameFn(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = delays[i];
      if (delay === undefined || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function downloadRelease(request: DownloadRequest): Promise<DownloadResult> {
  const {
    url,
    token,
    dest,
    sha256,
    size: total,
    stallMs = DEFAULT_STALL_MS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    progressMs = DEFAULT_PROGRESS_MS,
    signal,
  } = request;
  const writeTimeoutMs = request.writeTimeoutMs ?? Math.max(stallMs, MIN_WRITE_TIMEOUT_MS);
  const now = request.now ?? Date.now;
  const sleep = request.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const openFile = request.openFile ?? ((path, flags) => open(path, flags, 0o600));
  const logger = request.logger;
  const part = partPath(dest);
  const meta = metaPath(dest);
  const path = new URL(url).pathname;
  const deadlineAt = now() + deadlineMs;

  const dropPart = async () => {
    await rm(part, { force: true });
    await rm(meta, { force: true });
  };

  /** 是不是接在舊資料後面（206 續傳，或沿用上次的 .part）：hash 不對時先從頭重下一次。 */
  let resumed = false;

  // 舊的 .part：不是這個成品（sha256／大小不同，或沒有記錄）、或比總長大，就刪掉重來。
  {
    let ok = false;
    try {
      const saved = JSON.parse(await readFile(meta, 'utf8')) as {
        sha256?: unknown;
        size?: unknown;
      };
      ok = saved.sha256 === sha256 && saved.size === total;
    } catch {
      ok = false;
    }
    const have = await sizeOf(part);
    if (have !== null && (!ok || have > total)) {
      logger?.info(`下載 ${path}：舊的 .part（${have} 位元組）不是這個成品或比總長大，刪掉重來`);
      await dropPart();
    } else if (have !== null) {
      logger?.info(`下載 ${path}：找到上次的 .part（${have}/${total} 位元組），續傳`);
      if (have > 0) resumed = true;
    }
  }

  let lastEmit = 0;
  let lastEmitBytes = 0;
  const emit = (received: number, attempt: number, force: boolean) => {
    const t = now();
    const dt = t - lastEmit;
    const bigStep = received - lastEmitBytes >= total * 0.05 && dt >= 1_000;
    if (!force && dt < progressMs && !bigStep) return;
    const bytesPerSec = dt > 0 && !force ? Math.round(((received - lastEmitBytes) * 1000) / dt) : 0;
    lastEmit = t;
    lastEmitBytes = received;
    request.onProgress?.({ received, total, attempt, bytesPerSec });
  };

  const attemptOnce = async (attempt: number): Promise<{ outcome: Outcome; bytes: number }> => {
    const start = (await sizeOf(part)) ?? 0;
    if (start === total && total > 0) return { outcome: { kind: 'complete' }, bytes: 0 };
    const startedAt = now();
    const controller = new AbortController();
    let stalled: 'headers' | 'body' | 'write' | null = null;
    let deadlineHit = false;
    let aborted = false;
    let phase: 'headers' | 'body' = 'headers';
    let stallTimer: NodeJS.Timeout | undefined;
    let writeTimer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = phase;
        controller.abort(new Error('stalled'));
      }, stallMs);
    };
    const pause = () => clearTimeout(stallTimer);
    const deadlineTimer = setTimeout(
      () => {
        deadlineHit = true;
        controller.abort(new Error('deadline'));
      },
      Math.max(0, deadlineAt - now()),
    );
    const onOuterAbort = () => {
      aborted = true;
      controller.abort(new Error('aborted'));
    };
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    let status = 0;
    let bytes = 0;
    let maxWriteMs = 0;
    let written = start;
    let file: FileHandle | null = null;
    /** 寫入卡住：close 會等卡住的寫入，不能 await。 */
    let writeHung = false;
    lastEmit = now();
    lastEmitBytes = start;
    if (attempt > 1) emit(start, attempt, true);

    /** 磁碟動作：停網路停滯表、限時、錯誤分成 DiskFailure。 */
    const disk = async <T>(op: () => Promise<T>): Promise<T> => {
      pause();
      const started = now();
      try {
        return await new Promise<T>((resolve, reject) => {
          writeTimer = setTimeout(() => {
            stalled = 'write';
            writeHung = true;
            controller.abort(new Error('write stalled'));
            reject(new WriteTimeout());
          }, writeTimeoutMs);
          op().then(resolve, (error: unknown) =>
            reject(new DiskFailure((error as NodeJS.ErrnoException).code ?? errorCode(error))),
          );
        });
      } finally {
        clearTimeout(writeTimer);
        maxWriteMs = Math.max(maxWriteMs, now() - started);
      }
    };

    const failure = (error: unknown): Outcome => {
      if (aborted) return { kind: 'aborted' };
      if (stalled) {
        const ms = stalled === 'write' ? writeTimeoutMs : stallMs;
        return { kind: 'stall', seconds: Math.round(ms / 1000), phase: stalled };
      }
      if (deadlineHit) return { kind: 'deadline' };
      if (error instanceof DiskFailure) return { kind: 'disk', code: error.code };
      return { kind: 'network', code: errorCode(error) };
    };

    const run = async (): Promise<Outcome> => {
      arm();
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (start > 0) headers.range = `bytes=${start}-`;
      // 只連已配對的 hub（機器 token），不連 GitHub（docs/no-llm-review.md「自動更新」）。
      const init: RequestInit = { headers, signal: controller.signal };
      const response = await (request.fetch ? request.fetch(url, init) : fetch(url, init));
      pause();
      status = response.status;
      let append: boolean;
      if (status === 206) {
        const range = parseContentRange(response.headers.get('content-range'));
        if (!range || range.start !== start || (range.total !== null && range.total !== total)) {
          return {
            kind: 'restart',
            why: `Content-Range 不符：${range ? `${range.start}-${range.end}/${range.total}` : '沒有'}`,
          };
        }
        append = true;
        resumed = true;
      } else if (status === 200) {
        // 舊 hub 不支援 Range：從頭寫。
        append = false;
        written = 0;
        lastEmitBytes = 0;
      } else if (status === 416) {
        return { kind: 'restart', why: 'HTTP 416' };
      } else {
        return { kind: 'http', status, fatal: [401, 403, 404].includes(status) };
      }
      if (!response.body) return { kind: 'short' };
      if (!append || start === 0) {
        await disk(() => writeFile(meta, JSON.stringify({ sha256, size: total }), { mode: 0o600 }));
      }
      const handle = await disk(() => openFile(part, append ? 'a' : 'w'));
      file = handle;
      const reader = response.body.getReader();
      phase = 'body';
      arm();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.byteLength > total) {
          return { kind: 'restart', why: `收到的比總長 ${total} 多` };
        }
        await disk(() => handle.write(value));
        bytes += value.byteLength;
        written += value.byteLength;
        emit(written, attempt, false);
        arm();
      }
      return written === total ? { kind: 'complete' } : { kind: 'short' };
    };

    let outcome: Outcome;
    try {
      outcome = await run();
    } catch (error) {
      outcome = failure(error);
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(writeTimer);
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
    // 沒完成就把連線收掉（標頭到了、body 還沒讀完的也會被取消）。
    if (outcome.kind !== 'complete') controller.abort(new Error('attempt ended'));
    const opened = file as FileHandle | null;
    if (opened) {
      const closing = opened.close().catch(() => undefined);
      if (!writeHung) await closing;
    }
    if (outcome.kind === 'restart') await dropPart();
    const secs = Math.max(0.001, (now() - startedAt) / 1000);
    logger?.info(
      `下載 ${path} 第 ${attempt} 次：從 ${start} 位元組開始，HTTP ${status || '-'}，` +
        `收 ${bytes} 位元組（目前 ${written}/${total}），${secs.toFixed(1)} 秒，` +
        `平均 ${(bytes / 1024 / secs).toFixed(1)} KB/s，最久一次寫檔 ${maxWriteMs} ms，` +
        `結束：${describeOutcome(outcome)}`,
    );
    return { outcome, bytes };
  };

  let attempt = 0;
  let redone = false;
  let last: Outcome = { kind: 'short' };
  for (;;) {
    if (signal?.aborted) {
      last = { kind: 'aborted' };
      break;
    }
    attempt += 1;
    const { outcome, bytes } = await attemptOnce(attempt);
    last = outcome;
    if (outcome.kind === 'complete') {
      const actual = await fileSha256(part);
      if (actual === sha256) {
        await renameWithRetry(part, dest, request.renameFile);
        await rm(meta, { force: true });
        return { attempts: attempt, resumed };
      }
      await dropPart();
      // 接在舊資料後面而 hash 不對：可能是接起來的地方（或上次留下的 .part）壞了，從頭重下一次（不等待）；
      // 否則就是成品本身不對。
      if (resumed && !redone && attempt < maxAttempts && now() < deadlineAt) {
        logger?.warn(`下載 ${path}：續傳後 SHA-256 不符（${actual}），從頭重下一次`);
        redone = true;
        resumed = false;
        continue;
      }
      throw new DownloadError('checksum', `expected ${sha256}, got ${actual}`);
    }
    if (outcome.kind === 'http' && outcome.fatal) break;
    if (outcome.kind === 'disk' || outcome.kind === 'aborted') break;
    if (outcome.kind === 'deadline' || attempt >= maxAttempts) break;
    // 被要求從頭來（.part 不可信）：不算網路問題，馬上再試。
    if (outcome.kind === 'restart') continue;
    const index = bytes > 0 ? 0 : Math.min(attempt - 1, retryDelaysMs.length - 1);
    const delay = retryDelaysMs[index] ?? 0;
    if (now() + delay >= deadlineAt) break;
    logger?.warn(`下載 ${path}：${describeOutcome(outcome)}，${Math.round(delay / 1000)} 秒後續傳`);
    await sleep(delay);
  }
  const have = (await sizeOf(part)) ?? 0;
  throw new DownloadError(
    'download',
    `已收 ${mb(have)}/${mb(total)} MB（${have}/${total} 位元組），共 ${attempt} 次嘗試；` +
      `最後一次：${describeOutcome(last)}`,
  );
}
