// 深層搜尋的效能量測（P3 §3.6、§3.10）：合成資料，形狀仿 Claude Code 的 JSONL（user／assistant／tool_result
// 為主，夾雜 progress、system 行，中英混合）。只量本機讀檔與解析，不碰 ~/.claude。
//
// 預設跑小規模（約 60MB、30 份），每次 `pnpm -r test` 都會印出數字；設 AB_DEEP_PERF=1 跑實際量級：
// 225 份、共約 629MB，其中 7 天內修改的約 400MB（其中一台機器實測的量），用預設上限（1GB、15 秒）。
import { createWriteStream, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeepSearchLimits,
  parseSearchTerms,
  type DaemonToHub,
  type DeepSearchTarget,
} from '@agent-board/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { DeepSearcher } from './deepSearch';
import { makeTempDir } from './test-support/harness';

const FULL = process.env.AB_DEEP_PERF === '1';
const MB = 1024 * 1024;
const DAY = 24 * 3_600_000;

const config = makeTempDir();
afterAll(() => rmSync(config, { recursive: true, force: true }));

const WORDS = [
  'risk',
  'position',
  'limit',
  '部位',
  '上限',
  'test',
  'refactor',
  '資料',
  'pipeline',
  'commit',
  '檢查',
  'output',
  'error',
  '修正',
];
function prose(seed: number, chars: number): string {
  let out = '';
  let i = seed;
  while (out.length < chars) {
    out += WORDS[i % WORDS.length] + (i % 7 === 0 ? '。\n' : ' ');
    i = (i * 31 + 7) % 1_000_003;
  }
  return out;
}

/** 一行 JSONL（大小大致照真實比例：工具結果最大、回覆次之、progress 小）。 */
function line(i: number, at: string, needle: boolean): string {
  const base = { uuid: `u-${i}`, sessionId: 'x', cwd: '/tmp/repo', timestamp: at };
  switch (i % 6) {
    case 0:
      return JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', content: needle ? '把手續費改成 0.1425' : prose(i, 200) },
      });
    case 1:
    case 4:
      return JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: prose(i + 1, 600) },
            { type: 'text', text: prose(i + 2, 800) },
            { type: 'tool_use', name: 'Bash', input: { command: `rg -n "${WORDS[i % 14]}" src` } },
          ],
        },
      });
    case 2:
    case 5:
      return JSON.stringify({
        ...base,
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [{ type: 'text', text: prose(i + 3, 6_000 + (i % 5) * 3_000) }],
            },
          ],
        },
      });
    default:
      return JSON.stringify({ ...base, type: 'progress', data: { text: prose(i + 4, 400) } });
  }
}

async function writeFile(file: string, bytes: number, atMs: number): Promise<void> {
  const out = createWriteStream(file);
  let written = 0;
  let i = 0;
  const at = new Date(atMs).toISOString();
  while (written < bytes) {
    const text = line(i, at, i % 997 === 0) + '\n';
    written += Buffer.byteLength(text);
    i += 1;
    if (!out.write(text)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise<void>((r) => out.end(r));
  const when = new Date(atMs);
  utimesSync(file, when, when);
}

const id = (n: number) => `0a1b2c3d-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('深層搜尋效能（合成資料）', () => {
  it(
    FULL ? '實際量級：225 份、約 629MB（7 天內約 400MB）' : '小規模：30 份、約 60MB',
    async () => {
      const files = FULL ? 225 : 30;
      const recent = FULL ? 145 : 20; // 7 天內修改的份數
      const recentBytes = FULL ? 400 * MB : 40 * MB;
      const oldBytes = FULL ? 229 * MB : 20 * MB;
      const now = Date.now();
      const targets: DeepSearchTarget[] = [];
      const writeStart = performance.now();
      for (let n = 0; n < files; n += 1) {
        const isRecent = n < recent;
        const dir = join(config, 'projects', `-tmp-repo-${n % 12}`);
        mkdirSync(dir, { recursive: true });
        // 大小不平均：少數幾份很大（同真實：長時間 session 的紀錄可達數十 MB）。
        const share = isRecent ? recentBytes / recent : oldBytes / (files - recent);
        const size = Math.round(share * (n % 10 === 0 ? 4 : n % 10 === 1 ? 2 : 0.67));
        const atMs = isRecent ? now - (n / recent) * 6 * DAY : now - (8 + n) * DAY;
        await writeFile(join(dir, `${id(n)}.jsonl`), size, atMs);
        targets.push({
          sessionId: `s${n}`,
          claudeSessionId: id(n),
          accountProfile: null,
          lastActivityAt: new Date(atMs).toISOString(),
        });
      }
      const writeMs = performance.now() - writeStart;

      const run = async (q: string) => {
        const sent: { at: number; m: DaemonToHub }[] = [];
        const start = performance.now();
        const searcher = new DeepSearcher({
          configDir: config,
          knownProfile: () => false,
          screen: () => null,
          send: (m) => sent.push({ at: performance.now() - start, m }),
        });
        const stats = await searcher.start({
          type: 'search.request',
          searchId: q,
          terms: parseSearchTerms(q),
          mask: false,
          since: new Date(now - 7 * DAY).toISOString(),
          sessions: targets,
          limits: DeepSearchLimits.parse({}),
        });
        const total = performance.now() - start;
        const first = sent.find((s) => s.m.type === 'search.result')?.at ?? null;
        const done = sent.find((s) => s.m.type === 'search.done')?.m;
        const items = sent.reduce(
          (n, s) => n + (s.m.type === 'search.result' ? s.m.items.length : 0),
          0,
        );
        return {
          q,
          totalMs: Math.round(total),
          firstMs: first && Math.round(first),
          items,
          readMB: Math.round(stats.bytes / MB),
          stopped: stats.stopped,
          done,
        };
      };

      const results = [await run('手續費 0.1425'), await run('zzqx-沒有這個')];
      // 印出來寫進回報（vitest 預設會顯示 console.log）。
      console.log(
        JSON.stringify(
          {
            scale: FULL ? 'full' : 'small',
            files,
            recentFiles: recent,
            recentMB: recentBytes / MB,
            totalMB: (recentBytes + oldBytes) / MB,
            writeMs: Math.round(writeMs),
            results,
          },
          null,
          2,
        ),
      );
      for (const r of results) {
        expect(r.done?.type).toBe('search.done');
        // 15 秒 deadline＋檔案收尾的餘裕。
        expect(r.totalMs).toBeLessThan(17_000);
      }
      expect(results[0]!.items).toBeGreaterThan(0);
    },
    FULL ? 600_000 : 120_000,
  );
});
