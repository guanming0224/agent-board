// 深層搜尋（P3 ③b，§3.6、驗收 7）：暫存資料夾裡的假對話紀錄，不碰 ~/.claude。
import { createWriteStream, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeepSearchLimits,
  parseSearchTerms,
  type DaemonToHub,
  type DeepSearchTarget,
  type SearchItem,
} from '@agent-board/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { DeepSearcher, makePrefilter, searchScreen, type SearchRequest } from './deepSearch';
import { makeTempDir } from './test-support/harness';
import { readTranscript, readTranscriptFile } from './transcript';

const temps: string[] = [];
function temp(): string {
  const dir = makeTempDir();
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = 'sk-ant-demo03-deepSearchKEY000000';
const id = (n: number) => `0a1b2c3d-0000-0000-0000-${String(n).padStart(12, '0')}`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const user = (text: string, at = iso(60_000)) =>
  JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: text } });
const assistant = (text: string, at = iso(60_000)) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      content: [
        { type: 'thinking', thinking: 'zz' },
        { type: 'text', text },
        { type: 'tool_use', name: 'Bash', input: { command: `grep -n fee ${text.length}` } },
      ],
    },
  });
const toolResult = (text: string, at = iso(60_000)) =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] },
  });
const progress = () => JSON.stringify({ type: 'progress', data: { x: 'risk.py 手續費 0.1425' } });

function writeTranscript(config: string, n: number, lines: string[]): string {
  const dir = join(config, 'projects', `-tmp-repo-${n}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id(n)}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** 寫一份約 bytes 大小的對話紀錄（串流寫，不在記憶體組整份）。 */
async function writeBig(file: string, bytes: number, hitEvery = 0): Promise<void> {
  const out = createWriteStream(file);
  const filler = 'x'.repeat(4_000);
  let written = 0;
  let i = 0;
  while (written < bytes) {
    const line =
      (hitEvery > 0 && i % hitEvery === 0
        ? assistant(`第 ${i} 回：手續費 0.1425 改好了`)
        : toolResult(`${filler} ${i}`)) + '\n';
    i += 1;
    written += Buffer.byteLength(line);
    if (!out.write(line)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise<void>((r) => out.end(r));
}

const target = (n: number, minutesAgo = n): DeepSearchTarget => ({
  sessionId: `s${n}`,
  claudeSessionId: id(n),
  accountProfile: null,
  lastActivityAt: iso(minutesAgo * 60_000),
});

function request(
  q: string,
  sessions: DeepSearchTarget[],
  limits: Partial<DeepSearchLimits> = {},
  extra: Partial<SearchRequest> = {},
): SearchRequest {
  return {
    type: 'search.request',
    searchId: 'q1',
    terms: parseSearchTerms(q),
    mask: false,
    since: iso(7 * 24 * 3_600_000),
    sessions,
    limits: DeepSearchLimits.parse(limits),
    ...extra,
  };
}

function harness(config: string, screens: Record<string, string[]> = {}) {
  const sent: DaemonToHub[] = [];
  const searcher = new DeepSearcher({
    configDir: config,
    screen: (sessionId) => screens[sessionId] ?? null,
    send: (m) => sent.push(m),
  });
  const items = () =>
    sent.flatMap((m) => (m.type === 'search.result' ? m.items : [])) as SearchItem[];
  const done = () => sent.find((m) => m.type === 'search.done');
  return { searcher, sent, items, done };
}

describe('先篩', () => {
  it('每個單字都要在；跳脫字元與片語的空白不拿來篩', () => {
    const quick = makePrefilter(parseSearchTerms('"手續費 0.1425" Risk'));
    expect(quick('RISK … 手續費\\n0.1425')).toBe(true);
    expect(quick('risk 0.1425')).toBe(false);
    expect(makePrefilter(['say "hi"'])('完全不相干')).toBe(false); // "hi" 不篩，say 還是要在
    expect(makePrefilter(['"'])('anything')).toBe(true);
    // 非 ASCII 的字在 JSON 可能是 \u 跳脫：有跳脫的行不擋
    expect(makePrefilter(['手續費'])('{"t":"\\u624b\\u7e8c\\u8cbb"}')).toBe(true);
  });
});

describe('畫面', () => {
  it('由下往上找，最多 max 筆；遮蔽模式先遮再比對', () => {
    const lines = ['risk.py first', '', 'risk.py second', '', `risk.py token ${KEY}`, ''];
    const hits = searchScreen(lines, ['risk.py'], false, 2);
    expect(hits.map((h) => h.snippet)).toEqual([`risk.py token ${KEY}`, 'risk.py second']);
    const masked = searchScreen(lines, ['risk.py'], true, 3);
    expect(masked.map((h) => h.snippet).join('\n')).not.toContain('sk-ant');
    expect(masked[0]!.snippet).toContain('risk.py token ****');
    // 金鑰遮掉了就比對不到
    expect(searchScreen(lines, ['sk-ant-demo03'], true, 3)).toEqual([]);
  });
});

describe('對話紀錄', () => {
  it('序號和對話紀錄檢視一致；每 session 最多 3 筆（留最新的）；時間範圍之前的不算；結果邊搜邊回', async () => {
    const config = temp();
    const lines = [
      progress(),
      user('請改 risk.py 的手續費', iso(30 * 24 * 3_600_000)), // 範圍外
      assistant('手續費 0.1425 改好了 (1)'),
      toolResult('fee=0.1425 手續費 ok'),
      user('手續費 再確認'),
      assistant('手續費 (2)'),
      assistant('手續費 (3)'),
    ];
    const file = writeTranscript(config, 1, lines);
    const { searcher, items, done } = harness(config);
    await searcher.start(request('手續費', [target(1)]));
    const found = items();
    expect(found).toHaveLength(3);
    expect(found.every((i) => i.kind === 'transcript' && i.sessionId === 's1')).toBe(true);
    // 和檢視器用同一套序號：找出每一則的 index 驗證
    const page = await readTranscriptFile(file, { cursor: 0, limit: 500, query: null });
    for (const item of found) {
      const entry = page.entries.find((e) => e.index === item.transcriptIndex);
      expect(entry?.text.toLowerCase()).toContain('手續費');
    }
    expect(found.map((i) => i.snippet)).toEqual(['手續費 再確認', '手續費 (2)', '手續費 (3)']);
    expect(done()).toEqual({
      type: 'search.done',
      searchId: 'q1',
      state: 'done',
      scannedSessions: 1,
      totalSessions: 1,
    });
  });

  it('工具呼叫參數也搜得到；修改時間在範圍之前的檔不讀；遮蔽模式片段裡沒有金鑰', async () => {
    const config = temp();
    writeTranscript(config, 1, [assistant(`deploy with ${KEY}`)]);
    const old = writeTranscript(config, 2, [assistant('deploy old')]);
    const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    utimesSync(old, longAgo, longAgo);
    const { searcher, items, done } = harness(config);
    await searcher.start(request('deploy', [target(1), target(2)], {}, { mask: true }));
    expect(items()).toHaveLength(1);
    expect(items()[0]!.snippet).not.toContain('sk-ant');
    expect(JSON.stringify(items())).not.toContain(KEY);
    expect(done()).toMatchObject({ state: 'done', scannedSessions: 2, totalSessions: 2 });

    const tool = harness(config);
    await tool.searcher.start(request('"grep -n fee"', [target(1)]));
    expect(tool.items()[0]!.snippet).toContain('→ Bash');
  });

  it('畫面先搜、和對話紀錄共用每 session 3 筆；每台筆數上限到了就停（done、只搜了一部分）', async () => {
    const config = temp();
    writeTranscript(config, 1, [assistant('risk.py a'), assistant('risk.py b')]);
    writeTranscript(config, 2, [assistant('risk.py c'), assistant('risk.py d')]);
    const screens = { s1: ['risk.py on screen', '', 'risk.py again'] };
    const { searcher, sent, items, done } = harness(config, screens);
    await searcher.start(request('risk.py', [target(1), target(2)], { perMachine: 4 }));
    expect(sent[0]).toMatchObject({ type: 'search.result' });
    const kinds = items().map((i) => `${i.sessionId}:${i.kind}`);
    expect(kinds).toEqual(['s1:screen', 's1:screen', 's1:transcript', 's2:transcript']);
    expect(done()).toMatchObject({ state: 'done', scannedSessions: 1, totalSessions: 2 });
  });

  it('驗收 7：3 份 JSONL（一份 50MB），讀檔上限設小 → timeout 與正確的 scannedSessions；每 session ≤ 3 筆；同時讀對話紀錄檢視不被擋', async () => {
    const config = temp();
    writeTranscript(config, 1, [assistant('手續費 0.1425 (s1)')]);
    writeTranscript(config, 2, [assistant('手續費 0.1425 (s2)')]);
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    const big = join(bigDir, `${id(3)}.jsonl`);
    await writeBig(big, 50 * 1024 * 1024, 500);
    // s1、s2 比較新，先讀；s3（50MB）讀到 8MB 就停。
    const targets = [target(1, 1), target(2, 2), target(3, 3)];
    const { searcher, items, done } = harness(config);
    let searchDone = 0;
    let viewerDone = 0;
    const search = searcher
      .start(request('手續費', targets, { maxBytes: 8 * 1024 * 1024 }))
      .then(() => (searchDone = performance.now()));
    // 對話紀錄檢視讀另一份大檔：走自己的佇列，不用等搜尋。
    const viewer = readTranscript(config, id(3), { cursor: 0, limit: 5, query: null }).then(
      (page) => {
        viewerDone = performance.now();
        return page;
      },
    );
    const [page] = await Promise.all([viewer, search]);
    expect(page.missing).toBe(false);
    expect(page.total).toBeGreaterThan(10_000);
    expect(searchDone).toBeGreaterThan(0);
    expect(viewerDone).toBeGreaterThan(0);
    expect(done()).toMatchObject({ state: 'timeout', scannedSessions: 2, totalSessions: 3 });
    const perSession = new Map<string, number>();
    for (const item of items()) {
      perSession.set(item.sessionId!, (perSession.get(item.sessionId!) ?? 0) + 1);
    }
    expect(perSession.get('s1')).toBe(1);
    expect(perSession.get('s2')).toBe(1);
    expect(perSession.get('s3')).toBeLessThanOrEqual(3);
    expect(perSession.get('s3')).toBeGreaterThan(0); // 讀到的那一段的命中照樣回

    // 時間上限：deadline 設很短，一樣停在 timeout。
    const slow = harness(config);
    await slow.searcher.start(request('手續費', [target(3)], { deadlineMs: 50 }));
    expect(slow.done()).toMatchObject({ state: 'timeout', scannedSessions: 0, totalSessions: 1 });
  }, 60_000);

  it('取消：停止讀檔、不再回 done；新的搜尋照常', async () => {
    const config = temp();
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    await writeBig(join(bigDir, `${id(3)}.jsonl`), 20 * 1024 * 1024, 100);
    const { searcher, sent } = harness(config);
    const first = searcher.start(request('手續費', [target(3)]));
    setTimeout(() => searcher.cancel('q1'), 5);
    await first;
    expect(sent.some((m) => m.type === 'search.done')).toBe(false);
    await searcher.start({ ...request('手續費', [target(3)]), searchId: 'q2' });
    expect(sent.find((m) => m.type === 'search.done')).toMatchObject({ searchId: 'q2' });
  }, 30_000);
});
