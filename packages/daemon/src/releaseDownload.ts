// daemon 向 hub 下載更新成品（CONTRACTS §21.3、§21.12）：續傳、停滯偵測、退避重試、最後整檔驗 SHA-256。
//
// 2026-11-19 Windows 筆電連續兩次 download_failed（detail `terminated`：undici 的 body 5 分鐘沒資料就中止），
// 同一條路 Mac 正常。原因未確定，所以這裡的目標是「不管原因為何都自己下載完」，並留下下次找原因用的紀錄：
// - 寫到 `<成品>.part`（旁邊 `<成品>.part.json` 記 sha256／大小，不是這個成品的就刪掉重來），完成而且整檔
//   SHA-256 正確才改名成 `<成品>`。續傳時記憶體裡的 hash 不完整，所以完成後對整個檔案重算。
// - 自己的停滯偵測：連續 stallMs（預設 45 秒）沒收到資料（含等回應標頭）就中止這次連線，不等 undici 的 5 分鐘。
//   寫檔的時間不算網路停滯（寫檔前停表、寫完再開），但每次嘗試會記下最久一次寫檔花多久（防毒掃描的線索）。
// - 中斷後送 `Range: bytes=<已下載>-` 續傳；伺服器回 200（舊 hub 不支援 Range）就從頭寫。回 206 但起點不對、
//   或 416，就刪掉 .part 從頭來。401／403／404 不重試（token 或成品有問題，重試也沒用）。
// - 重試間隔退避（5s、15s、30s、60s…；這次有收到資料就回到最短的間隔），最多 maxAttempts 次（預設 8），
//   總時間上限 deadlineMs（預設 30 分鐘）。
// - 進度每 progressMs（預設 5 秒；或多收 5% 而且距上次至少 1 秒）回呼一次：已收／總量、速度、第幾次嘗試。
// - 每次嘗試在 daemon 紀錄寫一行：起點、HTTP 狀態、收到的位元組、耗時、平均速度、最久寫檔、結束原因。
//   只記網址的路徑（不記主機、不記 token）。
// 用 Node 內建 fetch（測試注入），讀 body 用 reader，停滯／總時限都用自己的 AbortController。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Logger } from './log';

export const DEFAULT_STALL_MS = 45_000;
/** 第 n 次失敗後等多久再試（超過長度用最後一個）。 */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000];
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_DEADLINE_MS = 30 * 60_000;
export const DEFAULT_PROGRESS_MS = 5_000;

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
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  deadlineMs?: number;
  progressMs?: number;
  onProgress?: (progress: DownloadProgress) => void;
  logger?: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DownloadResult {
  attempts: number;
  /** 有沒有用過 Range 續傳（伺服器回 206）。 */
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
  | { kind: 'stall'; seconds: number; phase: 'headers' | 'body' }
  | { kind: 'network'; code: string }
  | { kind: 'http'; status: number; fatal: boolean }
  /** 連線正常結束但少了資料（伺服器提早關）。 */
  | { kind: 'short' }
  /** 206 的起點和要的不同、或收到的比總長多：.part 不可信，刪掉從頭來。 */
  | { kind: 'restart'; why: string }
  | { kind: 'deadline' };

export const partPath = (dest: string): string => `${dest}.part`;
const metaPath = (dest: string): string => `${dest}.part.json`;

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
        : `停滯（${outcome.seconds} 秒沒有資料）`;
    case 'network':
      return `連線錯誤（${outcome.code}）`;
    case 'http':
      return `HTTP ${outcome.status}`;
    case 'short':
      return '連線提早結束（資料不完整）';
    case 'restart':
      return `從頭重下（${outcome.why}）`;
    case 'deadline':
      return '超過總時間上限';
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
  } = request;
  const now = request.now ?? Date.now;
  const sleep = request.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const logger = request.logger;
  const part = partPath(dest);
  const meta = metaPath(dest);
  const path = new URL(url).pathname;
  const deadlineAt = now() + deadlineMs;

  const dropPart = async () => {
    await rm(part, { force: true });
    await rm(meta, { force: true });
  };

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

  let resumed = false;

  const attemptOnce = async (attempt: number): Promise<{ outcome: Outcome; bytes: number }> => {
    const start = (await sizeOf(part)) ?? 0;
    if (start === total && total > 0) return { outcome: { kind: 'complete' }, bytes: 0 };
    const startedAt = now();
    const controller = new AbortController();
    let stalled: 'headers' | 'body' | null = null;
    let deadlineHit = false;
    let phase: 'headers' | 'body' = 'headers';
    let stallTimer: NodeJS.Timeout | undefined;
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
    let status = 0;
    let bytes = 0;
    let maxWriteMs = 0;
    let written = start;
    lastEmit = now();
    lastEmitBytes = start;
    if (attempt > 1) emit(start, attempt, true);

    const finish = (outcome: Outcome) => {
      clearTimeout(stallTimer);
      clearTimeout(deadlineTimer);
      const secs = Math.max(0.001, (now() - startedAt) / 1000);
      logger?.info(
        `下載 ${path} 第 ${attempt} 次：從 ${start} 位元組開始，HTTP ${status || '-'}，` +
          `收 ${bytes} 位元組（目前 ${written}/${total}），${secs.toFixed(1)} 秒，` +
          `平均 ${(bytes / 1024 / secs).toFixed(1)} KB/s，最久一次寫檔 ${maxWriteMs} ms，` +
          `結束：${describeOutcome(outcome)}`,
      );
      return { outcome, bytes };
    };

    const failure = (error: unknown): Outcome => {
      if (stalled) return { kind: 'stall', seconds: Math.round(stallMs / 1000), phase: stalled };
      if (deadlineHit) return { kind: 'deadline' };
      return { kind: 'network', code: errorCode(error) };
    };

    arm();
    let response: Response;
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (start > 0) headers.range = `bytes=${start}-`;
      // 只連已配對的 hub（機器 token），不連 GitHub（docs/no-llm-review.md「自動更新」）。
      const init: RequestInit = { headers, signal: controller.signal };
      response = await (request.fetch ? request.fetch(url, init) : fetch(url, init));
    } catch (error) {
      return finish(failure(error));
    }
    status = response.status;
    const cancelBody = () => response.body?.cancel().catch(() => undefined);

    let append: boolean;
    if (status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (!range || range.start !== start || (range.total !== null && range.total !== total)) {
        await cancelBody();
        await dropPart();
        return finish({
          kind: 'restart',
          why: `Content-Range 不符：${range ? `${range.start}-${range.end}/${range.total}` : '沒有'}`,
        });
      }
      append = true;
      resumed = true;
    } else if (status === 200) {
      // 舊 hub 不支援 Range：從頭寫。
      append = false;
      written = 0;
      lastEmitBytes = 0;
    } else if (status === 416) {
      await cancelBody();
      await dropPart();
      return finish({ kind: 'restart', why: 'HTTP 416' });
    } else {
      await cancelBody();
      return finish({ kind: 'http', status, fatal: [401, 403, 404].includes(status) });
    }
    if (!response.body) return finish({ kind: 'short' });

    if (!append || start === 0) {
      await writeFile(meta, JSON.stringify({ sha256, size: total }), { mode: 0o600 });
    }
    const file = await open(part, append ? 'a' : 'w', 0o600);
    const reader = response.body.getReader();
    phase = 'body';
    arm();
    let outcome: Outcome | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pause();
        if (written + value.byteLength > total) {
          outcome = { kind: 'restart', why: `收到的比總長 ${total} 多` };
          break;
        }
        const writeStarted = now();
        await file.write(value);
        maxWriteMs = Math.max(maxWriteMs, now() - writeStarted);
        bytes += value.byteLength;
        written += value.byteLength;
        emit(written, attempt, false);
        arm();
      }
    } catch (error) {
      outcome = failure(error);
    } finally {
      pause();
      await file.close().catch(() => undefined);
    }
    if (outcome?.kind === 'restart') {
      await reader.cancel().catch(() => undefined);
      await dropPart();
      return finish(outcome);
    }
    if (outcome) return finish(outcome);
    return finish(written === total ? { kind: 'complete' } : { kind: 'short' });
  };

  let attempt = 0;
  let redone = false;
  let last: Outcome = { kind: 'short' };
  for (;;) {
    attempt += 1;
    const { outcome, bytes } = await attemptOnce(attempt);
    last = outcome;
    if (outcome.kind === 'complete') {
      const actual = await fileSha256(part);
      if (actual === sha256) {
        await rename(part, dest);
        await rm(meta, { force: true });
        return { attempts: attempt, resumed };
      }
      await dropPart();
      // 用過續傳而 hash 不對：可能是接起來的地方壞了，從頭重下一次（不等待）；否則就是成品本身不對。
      if (resumed && !redone && attempt < maxAttempts && now() < deadlineAt) {
        logger?.warn(`下載 ${path}：續傳後 SHA-256 不符（${actual}），從頭重下一次`);
        redone = true;
        resumed = false;
        continue;
      }
      throw new DownloadError('checksum', `expected ${sha256}, got ${actual}`);
    }
    if (outcome.kind === 'http' && outcome.fatal) break;
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
