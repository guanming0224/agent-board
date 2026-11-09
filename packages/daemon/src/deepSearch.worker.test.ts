// 深層搜尋搬到 worker_threads（收尾 2026-11-10）：大檔的切行與 JSON 解析不在 daemon 主執行緒，
// 搜尋期間主執行緒的事件迴圈（PTY 轉送、hub 連線）延遲維持很低。暫存資料夾裡的合成對話紀錄，不碰 ~/.claude。
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DeepSearchLimits,
  parseSearchTerms,
  type DaemonToHub,
  type DeepSearchTarget,
} from '@agent-board/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scanTranscriptFile, SharedBudget } from './deepScan';
import { ScanWorker, scanWorker, type ScanOptions } from './deepScanPool';
import { DeepSearcher, type DeepRunStats, type SearchRequest } from './deepSearch';
import { log } from './log';
import { makeTempDir } from './test-support/harness';

const MB = 1024 * 1024;
// 40MB 每行都要解析：主執行緒掃時已經量得出延遲（每讀一塊卡一次），又不會讓整套測試慢太多、吃太多磁碟。
const FILE_BYTES = 40 * MB;
const id = (n: number) => `0a1b2c3d-0000-0000-0000-${String(n).padStart(12, '0')}`;

const config = makeTempDir();
afterAll(() => rmSync(config, { recursive: true, force: true }));

const WORDS = ['risk', 'position', '部位', '上限', 'test', 'refactor', '資料', 'pipeline', '修正'];
function prose(seed: number, chars: number): string {
  let out = '';
  let i = seed;
  while (out.length < chars) {
    out += WORDS[i % WORDS.length] + (i % 7 === 0 ? '。\n' : ' ');
    i = (i * 31 + 7) % 1_000_003;
  }
  return out;
}

/**
 * 最壞情況：每一行都過得了先篩（都有 risk），每一行都要 JSON 解析＋組搜尋全文＋比對。
 * 行的大小和真實差不多（回覆數 KB、工具結果較大）。
 */
async function writeHeavy(file: string, bytes: number): Promise<void> {
  const out = createWriteStream(file);
  const at = new Date(Date.now() - 60_000).toISOString();
  let written = 0;
  let i = 0;
  while (written < bytes) {
    const text =
      JSON.stringify(
        i % 2 === 0
          ? {
              type: 'assistant',
              timestamp: at,
              message: {
                content: [
                  { type: 'text', text: `risk ${prose(i, 1_500)}` },
                  { type: 'tool_use', name: 'Bash', input: { command: `rg -n risk src/${i}` } },
                ],
              },
            }
          : {
              type: 'user',
              timestamp: at,
              message: {
                content: [
                  { type: 'tool_result', content: [{ type: 'text', text: prose(i, 6_000) }] },
                ],
              },
            },
      ) + '\n';
    written += Buffer.byteLength(text);
    i += 1;
    if (!out.write(text)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise<void>((r) => out.end(r));
}

const heavyFile = () => join(config, 'projects', '-tmp-heavy', `${id(1)}.jsonl`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('等太久');
    await sleep(5);
  }
}

const target: DeepSearchTarget = {
  sessionId: 's1',
  claudeSessionId: id(1),
  accountProfile: null,
  lastActivityAt: new Date().toISOString(),
};

function request(limits: Partial<DeepSearchLimits> = {}, searchId = 'q1'): SearchRequest {
  return {
    type: 'search.request',
    searchId,
    terms: parseSearchTerms('risk'),
    mask: true,
    since: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
    sessions: [target],
    // 時間上限放寬到天花板：這裡要量「整份讀完」期間的延遲，不讓 15 秒預設先停下。
    limits: DeepSearchLimits.parse({ deadlineMs: 60_000, ...limits }),
  };
}

/** 搜尋期間每 10ms 排一次計時器，記下實際晚了多少（事件迴圈延遲）。 */
async function measureLag(
  run: () => Promise<DeepRunStats>,
): Promise<{ stats: DeepRunStats; p95: number; max: number; samples: number; ms: number }> {
  const INTERVAL = 10;
  const lags: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - INTERVAL));
    last = now;
  }, INTERVAL);
  const started = performance.now();
  const stats = await run();
  const ms = performance.now() - started;
  clearInterval(timer);
  lags.sort((a, b) => a - b);
  const p95 =
    lags.length > 0 ? lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.95))]! : 0;
  return { stats, p95, max: lags.at(-1) ?? 0, samples: lags.length, ms };
}

function searcher(scanIn: 'worker' | 'main') {
  const sent: DaemonToHub[] = [];
  const s = new DeepSearcher({
    configDir: config,
    knownProfile: () => false,
    screen: () => null,
    send: (m) => sent.push(m),
    scanIn,
  });
  return { searcher: s, sent };
}

beforeAll(async () => {
  const dir = join(config, 'projects', '-tmp-heavy');
  mkdirSync(dir, { recursive: true });
  await writeHeavy(heavyFile(), FILE_BYTES);
}, 60_000);

describe('深層搜尋在 worker_threads', () => {
  it('搜 40MB（每行都要解析）期間，主執行緒事件迴圈延遲 p95 < 50ms；結果、遮蔽、done 和以前一樣', async () => {
    const worker = searcher('worker');
    const inWorker = await measureLag(() => worker.searcher.start(request()));
    expect(scanWorker.disabled).toBe(false); // 真的在 worker 跑，沒有退回主執行緒
    expect(inWorker.stats.stopped).toBeNull();
    expect(inWorker.stats.bytes).toBeGreaterThanOrEqual(FILE_BYTES);
    const items = worker.sent.flatMap((m) => (m.type === 'search.result' ? m.items : []));
    expect(items.length).toBe(3); // 每 session 預設 3 筆（留最新的）
    expect(items.every((i) => i.kind === 'transcript' && i.snippet.includes('risk'))).toBe(true);
    expect(worker.sent.at(-1)).toMatchObject({
      type: 'search.done',
      state: 'done',
      scannedSessions: 1,
    });

    // 對照：同一份檔在主執行緒掃（搬之前的做法）。只印數字，不當成驗收條件（看機器）。
    const main = searcher('main');
    const inMain = await measureLag(() => main.searcher.start(request()));
    expect(inMain.stats.stopped).toBeNull();
    // 兩邊回的結果一樣（同一份程式，只是換執行緒）。
    expect(main.sent).toEqual(worker.sent);

    const fmt = (r: typeof inWorker) =>
      `p95 ${r.p95.toFixed(1)}ms、最大 ${r.max.toFixed(1)}ms（${r.samples} 個取樣，搜尋 ${Math.round(r.ms)}ms）`;
    console.log(`事件迴圈延遲（40MB）：worker ${fmt(inWorker)}；主執行緒 ${fmt(inMain)}`);
    expect(inWorker.p95).toBeLessThan(50);
  }, 120_000);

  it('worker 裡照樣：取消下一塊就停、不回 done；讓位回 timeout；時間與讀檔上限照算', async () => {
    // 取消：真的計時器，在 worker 讀到一半時進來（SharedBudget 跨執行緒看得到）。
    const a = searcher('worker');
    const first = a.searcher.start(request());
    await new Promise((r) => setTimeout(r, 150));
    a.searcher.cancel('q1');
    const cancelled = await first;
    expect(cancelled.stopped).toBe('cancelled');
    expect(cancelled.bytes).toBeLessThan(FILE_BYTES);
    expect(a.sent.some((m) => m.type === 'search.done')).toBe(false);

    // 讓位：新的請求進來，正在 worker 裡讀的那個下一塊就停、回 timeout，新的照常跑完。
    const b = searcher('worker');
    const old = b.searcher.start(request());
    await new Promise((r) => setTimeout(r, 150));
    const fresh = b.searcher.start(request({ maxBytes: 4 * MB }, 'q2'));
    const [x, y] = await Promise.all([old, fresh]);
    expect(x.stopped).toBe('deadline');
    expect(x.bytes).toBeLessThan(FILE_BYTES);
    expect(y.stopped).toBe('bytes');
    expect(y.bytes).toBeLessThanOrEqual(5 * MB); // 每讀一塊（1MB）檢查一次
    expect(b.sent.filter((m) => m.type === 'search.done')).toEqual([
      expect.objectContaining({ searchId: 'q1', state: 'timeout', scannedSessions: 0 }),
      expect.objectContaining({ searchId: 'q2', state: 'timeout', scannedSessions: 0 }),
    ]);

    // 時間上限：worker 用真的時鐘，300ms 讀不完 40MB（每行都要解析，約 1 秒）。
    const c = searcher('worker');
    const late = await c.searcher.start(request({ deadlineMs: 300 }));
    expect(late.stopped).toBe('deadline');
    expect(c.sent.at(-1)).toMatchObject({ type: 'search.done', state: 'timeout' });
    // 讀到的那一段的命中照樣先送出（分批回傳不變）：一定有一批 result，而且在 done 之前。
    const firstResult = c.sent.findIndex((m) => m.type === 'search.result');
    expect(firstResult).toBeGreaterThanOrEqual(0);
    expect(firstResult).toBeLessThan(c.sent.length - 1);
  }, 120_000);

  it('worker 閒置關掉之後，下一次搜尋會再開一個', async () => {
    scanWorker.stop();
    const d = searcher('worker');
    const stats = await d.searcher.start(request({ maxBytes: 2 * MB }));
    expect(stats.stopped).toBe('bytes');
    expect(scanWorker.disabled).toBe(false);
    expect(d.sent.flatMap((m) => (m.type === 'search.result' ? m.items : [])).length).toBe(3);
  }, 60_000);

  it('worker 換代：舊 worker 晚到的 exit／error 不會把新 worker 上的工作一起 reject', async () => {
    const pool = new ScanWorker();
    const options = (): ScanOptions => ({
      terms: parseSearchTerms('risk'),
      mask: true,
      sinceMs: 0,
      maxHits: 3,
      budget: new SharedBudget({ deadline: Date.now() + 60_000, maxBytes: 8 * MB }),
    });
    await pool.scan(heavyFile(), 's1', options());
    const old = pool.currentWorker!;
    expect(old).not.toBeNull();
    // 舊 worker 結束後 Node 會拿掉它的監聽：先留著，等新 worker 的工作送出去之後再呼叫，模擬事件晚到。
    const lateError = old.listeners('error') as ((error: Error) => void)[];
    const lateExit = old.listeners('exit') as ((code: number) => void)[];
    expect(lateError.length).toBeGreaterThan(0);
    expect(lateExit.length).toBeGreaterThan(0);
    // 關掉（閒置）之後馬上又有搜尋：新 worker 開起來、工作送出去之後，舊 worker 的事件才到。
    pool.stop();
    const fresh = pool.scan(heavyFile(), 's1', options());
    await until(() => pool.pendingCount > 0);
    expect(pool.currentWorker).not.toBe(old);
    for (const listener of lateError) listener(new Error('舊的壞掉'));
    for (const listener of lateExit) listener(1);
    const scan = await fresh;
    expect(scan.stopped).toBe('bytes');
    expect(scan.hits).toHaveLength(3);
    pool.stop();
  }, 60_000);

  it('worker 起不來：退回主執行緒、結果一樣、冷卻期內只警告一次；冷卻過了再試', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const pool = new ScanWorker({
        spec: () => ({ url: pathToFileURL(join(config, '沒有這個檔.mjs')), execArgv: undefined }),
        cooldownMs: 300,
      });
      const options = (): ScanOptions => ({
        terms: parseSearchTerms('risk'),
        mask: true,
        sinceMs: 0,
        maxHits: 3,
        budget: new SharedBudget({ deadline: Date.now() + 60_000, maxBytes: 2 * MB }),
      });
      const inline = await scanTranscriptFile(heavyFile(), 's1', { ...options(), now: Date.now });
      expect(inline.hits).toHaveLength(3);
      expect(await pool.scan(heavyFile(), 's1', options())).toEqual(inline);
      expect(pool.disabled).toBe(true);
      expect(await pool.scan(heavyFile(), 's1', options())).toEqual(inline);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('worker 起不來');
      // 冷卻過了：再試開一次（還是起不來，再警告一次），不是永久停用。
      await sleep(350);
      expect(pool.disabled).toBe(false);
      expect(await pool.scan(heavyFile(), 's1', options())).toEqual(inline);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('看門狗：取消之後 worker 超過寬限還不回（卡在讀檔或一行），關掉 worker、那份工作失敗，不會一直卡住', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // 假 worker：回 ready，之後收到工作都不回（模擬卡在單次讀檔）。
    const stuck = join(config, 'stuck-worker.mjs');
    writeFileSync(
      stuck,
      "import { parentPort } from 'node:worker_threads';\n" +
        "parentPort.on('message', () => {});\n" +
        "parentPort.postMessage({ type: 'ready' });\n",
    );
    try {
      const pool = new ScanWorker({
        spec: () => ({ url: pathToFileURL(stuck), execArgv: undefined }),
        stuckGraceMs: 100,
        watchMs: 20,
      });
      const budget = new SharedBudget({ deadline: Date.now() + 60_000, maxBytes: 8 * MB });
      const job = pool.scan(heavyFile(), 's1', {
        terms: parseSearchTerms('risk'),
        mask: true,
        sinceMs: 0,
        maxHits: 3,
        budget,
      });
      const outcome = job.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      await sleep(100);
      // 沒到該停的時候，不管多久都不關。
      expect(pool.pendingCount).toBe(1);
      const cancelledAt = Date.now();
      budget.cancelled = true;
      expect(await outcome).toContain('卡住');
      expect(Date.now() - cancelledAt).toBeLessThan(2_000);
      expect(pool.currentWorker).toBeNull();
      expect(pool.disabled).toBe(false);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it('worker 搜到一半壞掉：已送出的結果照算，回報「只搜了 N／M」而不是 0', async () => {
    const dir = join(config, 'projects', '-tmp-small');
    mkdirSync(dir, { recursive: true });
    const at = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      join(dir, `${id(2)}.jsonl`),
      JSON.stringify({ type: 'assistant', timestamp: at, message: { content: 'risk 小檔' } }) +
        '\n',
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const e = searcher('worker');
      const small: DeepSearchTarget = {
        sessionId: 's2',
        claudeSessionId: id(2),
        accountProfile: null,
        lastActivityAt: new Date(Date.now() + 1_000).toISOString(), // 比較新：先搜
      };
      const run = e.searcher.start({ ...request(), sessions: [small, target] });
      // 小檔的結果送出、大檔正在 worker 裡讀的時候，worker 被關掉（模擬當掉）。
      await until(
        () => e.sent.some((m) => m.type === 'search.result') && scanWorker.pendingCount > 0,
      );
      scanWorker.stop();
      const stats = await run;
      expect(stats.stopped).toBe('deadline');
      expect(e.sent.filter((m) => m.type === 'search.result')).toHaveLength(1);
      expect(e.sent.at(-1)).toEqual({
        type: 'search.done',
        searchId: 'q1',
        state: 'timeout',
        scannedSessions: 1,
        totalSessions: 2,
      });
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
