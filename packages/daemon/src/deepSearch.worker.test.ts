// 深層搜尋搬到 worker_threads（收尾 2026-11-10）：大檔的切行與 JSON 解析不在 daemon 主執行緒，
// 搜尋期間主執行緒的事件迴圈（PTY 轉送、hub 連線）延遲維持很低。暫存資料夾裡的合成對話紀錄，不碰 ~/.claude。
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeepSearchLimits,
  parseSearchTerms,
  type DaemonToHub,
  type DeepSearchTarget,
} from '@agent-board/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeepSearcher, type DeepRunStats, type SearchRequest } from './deepSearch';
import { scanWorker } from './deepScanPool';
import { makeTempDir } from './test-support/harness';

const MB = 1024 * 1024;
const FILE_BYTES = 120 * MB;
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
  await writeHeavy(join(dir, `${id(1)}.jsonl`), FILE_BYTES);
}, 60_000);

describe('深層搜尋在 worker_threads', () => {
  it('搜 120MB（每行都要解析）期間，主執行緒事件迴圈延遲 p95 < 50ms；結果、遮蔽、done 和以前一樣', async () => {
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
    console.log(`事件迴圈延遲（120MB）：worker ${fmt(inWorker)}；主執行緒 ${fmt(inMain)}`);
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

    // 時間上限：worker 用真的時鐘，50ms 讀不完 120MB（每行都要解析）。
    const c = searcher('worker');
    const late = await c.searcher.start(request({ deadlineMs: 50 }));
    expect(late.stopped).toBe('deadline');
    expect(c.sent.at(-1)).toMatchObject({ type: 'search.done', state: 'timeout' });
    // 讀到的那一段的命中照樣先送出（分批回傳不變）。
    expect(c.sent.findIndex((m) => m.type === 'search.result')).toBeLessThan(c.sent.length - 1);
  }, 120_000);

  it('worker 閒置關掉之後，下一次搜尋會再開一個', async () => {
    scanWorker.stop();
    const d = searcher('worker');
    const stats = await d.searcher.start(request({ maxBytes: 2 * MB }));
    expect(stats.stopped).toBe('bytes');
    expect(scanWorker.disabled).toBe(false);
    expect(d.sent.flatMap((m) => (m.type === 'search.result' ? m.items : [])).length).toBe(3);
  }, 60_000);
});
