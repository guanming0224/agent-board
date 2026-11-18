// 更新成品的下載（CONTRACTS §21.12）：用本機 http server 模擬傳到一半停住、斷線、不支援 Range、正常 206、hash 錯。
// 真的網路堆疊（Node 內建 fetch／undici），Windows CI 也跑（ci.yml 的 windows job、test:windows）。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadRelease,
  DownloadError,
  errorCode,
  parseContentRange,
  partPath,
  renameWithRetry,
  type DownloadProgress,
  type DownloadRequest,
} from './releaseDownload';

const BODY = randomBytes(256 * 1024);
const SHA = createHash('sha256').update(BODY).digest('hex');

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  n: number,
  range: { start: number } | null,
) => void;

let dir: string;
let server: Server | null = null;
let requests: { range: string | undefined; auth: string | undefined }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-download-'));
  requests = [];
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    requests.push({ range: req.headers.range, auth: req.headers.authorization });
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    handler(req, res, requests.length, match ? { start: Number(match[1]) } : null);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api/releases/0.2.0/win-x64`;
}

/** 照 hub 的做法回應：有 Range 回 206，沒有回 200；body 從 from 起、寫到 upto 為止（不給 upto＝寫完）。 */
function send(
  res: ServerResponse,
  range: { start: number } | null,
  opts: { upto?: number; body?: Buffer; ignoreRange?: boolean } = {},
) {
  const body = opts.body ?? BODY;
  const start = range && !opts.ignoreRange ? range.start : 0;
  if (start > 0) {
    res.writeHead(206, {
      'content-length': body.length - start,
      'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
    });
  } else {
    res.writeHead(200, { 'content-length': body.length });
  }
  const upto = opts.upto ?? body.length;
  res.write(body.subarray(start, Math.max(start, upto)));
  if (upto >= body.length) res.end();
}

function request(url: string, over: Partial<DownloadRequest> = {}) {
  const logs: string[] = [];
  const delays: number[] = [];
  const progress: DownloadProgress[] = [];
  const dest = join(dir, 'agent-board-0.2.0-win-x64.zip');
  const req: DownloadRequest = {
    url,
    token: 'machine-token',
    dest,
    sha256: SHA,
    size: BODY.length,
    stallMs: 300,
    progressMs: 0,
    sleep: async (ms) => {
      delays.push(ms);
    },
    onProgress: (p) => progress.push(p),
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    ...over,
  };
  return { req, dest, logs, delays, progress };
}

describe('downloadRelease', () => {
  it('（d）正常：一次就完成、改名、.part 與 .part.json 清掉、帶 token', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    const { req, dest, logs } = request(url);
    expect(await downloadRelease(req)).toEqual({ attempts: 1, resumed: false });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(partPath(dest))).toBe(false);
    expect(existsSync(`${dest}.part.json`)).toBe(false);
    expect(requests).toEqual([{ range: undefined, auth: 'Bearer machine-token' }]);
    expect(logs.join('\n')).toContain('結束：完成');
    // 紀錄只有路徑，沒有主機與 token。
    expect(logs.join('\n')).not.toContain('127.0.0.1');
    expect(logs.join('\n')).not.toContain('machine-token');
  });

  it('（a）傳到一半停住不關：停滯偵測中止這次連線，用 Range 續傳，最後整檔 hash 對', async () => {
    const half = BODY.length / 2;
    const url = await serve((_req, res, n, range) =>
      n === 1 ? send(res, range, { upto: half }) : send(res, range),
    );
    const { req, dest, logs, delays, progress } = request(url);
    expect(await downloadRelease(req)).toEqual({ attempts: 2, resumed: true });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests.map((r) => r.range)).toEqual([undefined, `bytes=${half}-`]);
    expect(logs.join('\n')).toContain('停滯（0 秒沒有資料）');
    // 第一次有收到資料：退避回到最短的間隔。
    expect(delays).toEqual([5_000]);
    // 第二次開始時回報一次（attempt 2，從 half 開始）。
    expect(progress).toContainEqual({
      received: half,
      total: BODY.length,
      attempt: 2,
      bytesPerSec: 0,
    });
    expect(progress.at(-1)).toMatchObject({ received: BODY.length, attempt: 2 });
  });

  it('等不到回應標頭也算停滯', async () => {
    const url = await serve((_req, res, n, range) => {
      if (n > 1) send(res, range);
    });
    const { req, dest, logs } = request(url);
    await downloadRelease(req);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(logs.join('\n')).toContain('沒有回應標頭');
  });

  it('（b）傳到一半斷線：記錯誤代碼，續傳完成', async () => {
    const url = await serve((_req, res, n, range) => {
      if (n === 1) {
        send(res, range, { upto: 100_000 });
        setTimeout(() => res.socket?.destroy(), 50);
      } else {
        send(res, range);
      }
    });
    const { req, dest, logs } = request(url);
    expect(await downloadRelease(req)).toEqual({ attempts: 2, resumed: true });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests[1]!.range).toBe('bytes=100000-');
    expect(logs.join('\n')).toMatch(/連線錯誤（.+）/);
  });

  it('（c）伺服器不支援 Range（舊 hub 回 200）：從頭重下，不接在舊資料後面', async () => {
    const url = await serve((_req, res, n, range) => {
      if (n === 1) {
        send(res, range, { upto: 100_000 });
        setTimeout(() => res.socket?.destroy(), 50);
      } else {
        send(res, range, { ignoreRange: true });
      }
    });
    const { req, dest } = request(url);
    expect(await downloadRelease(req)).toEqual({ attempts: 2, resumed: false });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests[1]!.range).toBe('bytes=100000-');
  });

  it('（e）hash 錯：checksum 錯誤，.part 刪掉，不重試', async () => {
    const wrong = Buffer.from(BODY);
    wrong[10] = wrong[10]! ^ 0xff;
    const url = await serve((_req, res, _n, range) => send(res, range, { body: wrong }));
    const { req, dest } = request(url);
    const error = await downloadRelease(req).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).kind).toBe('checksum');
    expect(requests).toHaveLength(1);
    expect(existsSync(partPath(dest))).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it('續傳之後 hash 錯：從頭重下一次；第二次對就成功', async () => {
    const wrong = Buffer.from(BODY);
    wrong[BODY.length - 1] = wrong[BODY.length - 1]! ^ 0xff;
    const url = await serve((_req, res, n, range) => {
      if (n === 1) {
        send(res, range, { upto: 1000 });
        setTimeout(() => res.socket?.destroy(), 50);
      } else {
        send(res, range, { body: n === 2 ? wrong : BODY });
      }
    });
    const { req, dest } = request(url);
    expect(await downloadRelease(req)).toMatchObject({ attempts: 3 });
    expect(requests.map((r) => r.range)).toEqual([undefined, 'bytes=1000-', undefined]);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('一直失敗：最多 maxAttempts 次、退避加長，detail 寫清楚已收、總量、次數、最後原因；.part 留著', async () => {
    const url = await serve((_req, res, _n, range) => {
      if (!range) send(res, range, { upto: 1000 });
      // 之後的續傳都停住（不回標頭）。
    });
    const { req, dest, delays } = request(url, { maxAttempts: 4 });
    const error = (await downloadRelease(req).catch((e: unknown) => e)) as DownloadError;
    expect(error.kind).toBe('download');
    expect(error.message).toContain(`1000/${BODY.length} 位元組`);
    expect(error.message).toContain('共 4 次嘗試');
    expect(error.message).toContain('停滯（0 秒沒有回應標頭）');
    expect(delays).toEqual([5_000, 15_000, 30_000]);
    expect(readFileSync(partPath(dest))).toHaveLength(1000);
  });

  it('總時間上限：下一次等待會超過就停', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    let t = 0;
    const { req } = request(url, {
      deadlineMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const error = (await downloadRelease(req).catch((e: unknown) => e)) as DownloadError;
    // 5s、15s 之後再等 30s 會超過 20s 上限：第 2 次之後就停（5s 後的第 2 次還在上限內）。
    expect(requests).toHaveLength(2);
    expect(error.message).toContain('HTTP 503');
  });

  it('401／404 不重試', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    const { req } = request(url);
    const error = (await downloadRelease(req).catch((e: unknown) => e)) as DownloadError;
    expect(error.message).toContain('HTTP 404');
    expect(requests).toHaveLength(1);
  });

  it('舊的 .part：別的成品（sha 不同）或比總長大就刪掉從頭來；同一個成品就續傳', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    const { req, dest } = request(url);
    // 別的成品留下的。
    writeFileSync(partPath(dest), BODY.subarray(0, 5000));
    writeFileSync(`${dest}.part.json`, JSON.stringify({ sha256: 'a'.repeat(64), size: 1 }));
    await downloadRelease(req);
    expect(requests.at(-1)!.range).toBeUndefined();
    rmSync(dest);
    // 比總長大。
    writeFileSync(partPath(dest), Buffer.concat([BODY, Buffer.from('xx')]));
    writeFileSync(`${dest}.part.json`, JSON.stringify({ sha256: SHA, size: BODY.length }));
    await downloadRelease(req);
    expect(requests.at(-1)!.range).toBeUndefined();
    rmSync(dest);
    // 同一個成品：續傳。
    writeFileSync(partPath(dest), BODY.subarray(0, 5000));
    writeFileSync(`${dest}.part.json`, JSON.stringify({ sha256: SHA, size: BODY.length }));
    expect(await downloadRelease(req)).toEqual({ attempts: 1, resumed: true });
    expect(requests.at(-1)!.range).toBe('bytes=5000-');
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('206 的起點不對：.part 不可信，刪掉從頭來', async () => {
    const url = await serve((_req, res, n, range) => {
      if (n === 1) {
        send(res, range, { upto: 1000 });
        setTimeout(() => res.socket?.destroy(), 50);
      } else if (n === 2) {
        res.writeHead(206, { 'content-range': `bytes 0-${BODY.length - 1}/${BODY.length}` });
        res.end(BODY);
      } else {
        send(res, range);
      }
    });
    const { req, dest, logs } = request(url);
    await downloadRelease(req);
    expect(requests.map((r) => r.range)).toEqual([undefined, 'bytes=1000-', undefined]);
    expect(logs.join('\n')).toContain('Content-Range 不符');
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('416（例如 hub 的檔案換了、.part 比較長）：刪 .part 從頭來', async () => {
    const url = await serve((_req, res, n, range) => {
      if (n === 1) {
        send(res, range, { upto: 1000 });
        setTimeout(() => res.socket?.destroy(), 50);
      } else if (n === 2) {
        res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
        res.end();
      } else {
        send(res, range);
      }
    });
    const { req, dest, logs } = request(url);
    expect(await downloadRelease(req)).toMatchObject({ attempts: 3 });
    expect(requests.map((r) => r.range)).toEqual([undefined, 'bytes=1000-', undefined]);
    expect(logs.join('\n')).toContain('從頭重下（HTTP 416）');
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('收到的比總長多（overrun）：刪 .part 從頭來', async () => {
    const url = await serve((_req, res, n, range) => {
      if (n === 1) {
        // 沒有 content-length（chunked），送比總長多的資料。
        res.writeHead(200);
        res.end(Buffer.concat([BODY, Buffer.from('extra bytes')]));
      } else {
        send(res, range);
      }
    });
    const { req, dest, logs } = request(url);
    expect(await downloadRelease(req)).toMatchObject({ attempts: 2 });
    expect(logs.join('\n')).toContain('收到的比總長');
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('上次留下的 .part 已是完整大小但 hash 錯：當成續傳過，從頭重下一次（W4）', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    const { req, dest } = request(url);
    const wrong = Buffer.from(BODY);
    wrong[0] = wrong[0]! ^ 0xff;
    writeFileSync(partPath(dest), wrong);
    writeFileSync(`${dest}.part.json`, JSON.stringify({ sha256: SHA, size: BODY.length }));
    expect(await downloadRelease(req)).toMatchObject({ attempts: 2 });
    expect(requests.map((r) => r.range)).toEqual([undefined]);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('寫檔卡住：超過 writeTimeoutMs 記成寫檔停滯並中止連線，不會永遠等（W2）', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    let opens = 0;
    const { req, logs } = request(url, {
      writeTimeoutMs: 200,
      maxAttempts: 2,
      openFile: async () => {
        opens += 1;
        return {
          write: () => new Promise(() => {}),
          close: async () => {},
        } as unknown as FileHandle;
      },
    });
    const error = (await downloadRelease(req).catch((e: unknown) => e)) as DownloadError;
    expect(error.kind).toBe('download');
    expect(error.message).toContain('寫檔停滯');
    expect(opens).toBe(2);
    expect(logs.join('\n')).toMatch(/最久一次寫檔 \d{3,} ms/);
  });

  it('磁碟錯誤（ENOSPC）：不退避重試，detail 寫錯誤代碼（W3）', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    const { req, delays } = request(url, {
      openFile: async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
    });
    const error = (await downloadRelease(req).catch((e: unknown) => e)) as DownloadError;
    expect(error.message).toContain('寫檔錯誤（ENOSPC）');
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('開檔很慢（防毒）：不算網路停滯（W3）', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    const { req, dest, logs } = request(url, {
      openFile: async (path, flags) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return open(path, flags, 0o600);
      },
    });
    expect(await downloadRelease(req)).toEqual({ attempts: 1, resumed: false });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(logs.join('\n')).not.toContain('停滯');
  });

  it('改名被鎖住（EPERM／EBUSY）：等一下再試；其他錯誤直接丟（W6）', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range));
    let calls = 0;
    const { req, dest } = request(url, {
      renameFile: async (from, to) => {
        calls += 1;
        if (calls <= 2)
          throw Object.assign(new Error('locked'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
        await rename(from, to);
      },
    });
    await downloadRelease(req);
    expect(calls).toBe(3);
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    await expect(
      renameWithRetry('a', 'b', async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      }),
    ).rejects.toThrow('nope');
    let tries = 0;
    await expect(
      renameWithRetry(
        'a',
        'b',
        async () => {
          tries += 1;
          throw Object.assign(new Error('still locked'), { code: 'EACCES' });
        },
        [1, 1],
      ),
    ).rejects.toThrow('still locked');
    expect(tries).toBe(3);
  });

  it('signal 中止：這次連線收掉、不再重試', async () => {
    const url = await serve((_req, res, _n, range) => send(res, range, { upto: 1000 }));
    const controller = new AbortController();
    const { req } = request(url, { signal: controller.signal, stallMs: 10_000 });
    setTimeout(() => controller.abort(), 200);
    const error = (await downloadRelease(req).catch((e: unknown) => e)) as DownloadError;
    expect(error.message).toContain('中止');
    expect(requests).toHaveLength(1);
  });

  it('工具函式：Content-Range、錯誤代碼', () => {
    expect(parseContentRange('bytes 5-9/10')).toEqual({ start: 5, end: 9, total: 10 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ start: 5, end: 9, total: null });
    expect(parseContentRange(null)).toBeNull();
    const err = new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    expect(errorCode(err)).toBe('UND_ERR_SOCKET terminated other side closed');
  });
});
