// 深層搜尋（P3 ③b，§3.6、驗收 7）：暫存資料夾裡的假對話紀錄，不碰 ~/.claude。
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  DeepSearchLimits,
  parseSearchTerms,
  type DaemonToHub,
  type DeepSearchTarget,
  type SearchItem,
} from '@agent-board/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampRequest,
  DEEP_HARD_LIMITS,
  DeepSearcher,
  makePrefilter,
  readLines,
  searchScreen,
  type Budget,
  type SearchRequest,
} from './deepSearch';
import { indexTranscripts } from './sessionFiles';
import { makeTempDir } from './test-support/harness';
import { countEntries, parseLine, readTranscript, readTranscriptFile } from './transcript';

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

function harness(
  config: string,
  screens: Record<string, string[]> = {},
  profiles: readonly string[] = [],
) {
  const sent: DaemonToHub[] = [];
  const searcher = new DeepSearcher({
    configDir: config,
    knownProfile: (profile) => profiles.includes(profile),
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

  it('驗收 7：3 份 JSONL（一份 50MB），讀檔上限設小 → timeout 與正確的 scannedSessions；每 session ≤ 3 筆', async () => {
    const config = temp();
    writeTranscript(config, 1, [assistant('手續費 0.1425 (s1)')]);
    writeTranscript(config, 2, [assistant('手續費 0.1425 (s2)')]);
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    await writeBig(join(bigDir, `${id(3)}.jsonl`), 50 * 1024 * 1024, 500);
    // s1、s2 比較新，先讀；s3（50MB）讀到 8MB 就停。
    const targets = [target(1, 1), target(2, 2), target(3, 3)];
    const { searcher, items, done } = harness(config);
    const stats = await searcher.start(request('手續費', targets, { maxBytes: 8 * 1024 * 1024 }));
    expect(stats.stopped).toBe('bytes');
    // 每讀一塊（1MB）檢查一次：最多多讀一塊。
    expect(stats.bytes).toBeLessThanOrEqual(9 * 1024 * 1024);
    expect(done()).toMatchObject({ state: 'timeout', scannedSessions: 2, totalSessions: 3 });
    const perSession = new Map<string, number>();
    for (const item of items()) {
      perSession.set(item.sessionId!, (perSession.get(item.sessionId!) ?? 0) + 1);
    }
    expect(perSession.get('s1')).toBe(1);
    expect(perSession.get('s2')).toBe(1);
    expect(perSession.get('s3')).toBeLessThanOrEqual(3);
    expect(perSession.get('s3')).toBeGreaterThan(0); // 讀到的那一段的命中照樣回

    // 時間上限：時鐘走快 1000 倍（50MB 在 page cache 裡讀得比 50ms 還快），一樣停在 timeout。
    const slow = harness(config);
    const start = Date.now();
    const fast = new DeepSearcher({
      configDir: config,
      knownProfile: () => false,
      screen: () => null,
      send: (m) => slow.sent.push(m),
      now: () => start + (Date.now() - start) * 1000,
    });
    const slowStats = await fast.start(request('手續費', [target(3)], { deadlineMs: 50 }));
    expect(slowStats.stopped).toBe('deadline');
    expect(slow.done()).toMatchObject({ state: 'timeout', scannedSessions: 0, totalSessions: 1 });
  }, 60_000);

  it('驗收 7：搜尋期間讀對話紀錄檢視不必等搜尋結束（兩條佇列並行）', async () => {
    const config = temp();
    writeTranscript(config, 1, [user('看一下'), assistant('好')]);
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    await writeBig(join(bigDir, `${id(3)}.jsonl`), 80 * 1024 * 1024, 2);
    const { searcher, done } = harness(config);
    // 搜尋整份 80MB（不設讀檔上限）；它先開始。
    const startedAt = performance.now();
    let searchDone = 0;
    const search = searcher
      .start(request('手續費', [target(3)]))
      .then(() => (searchDone = performance.now()));
    // 檢視器讀另一份小檔：走自己的佇列，不用等搜尋。若兩者排在同一條佇列，檢視器要等搜尋讀完 80MB。
    const page = await readTranscript(config, id(1), { cursor: 0, limit: 5, query: null });
    const viewerDone = performance.now();
    expect(page.entries).toHaveLength(3); // user＋assistant 的文字與工具呼叫
    // 檢視器回來時搜尋還在跑：還沒送 search.done。
    expect(done()).toBeUndefined();
    expect(searchDone).toBe(0);
    await search;
    expect(viewerDone).toBeLessThan(searchDone);
    console.log(
      `驗收 7 並行：檢視器 ${Math.round(viewerDone - startedAt)}ms、搜尋 ${Math.round(searchDone - startedAt)}ms`,
    );
    expect(done()).toMatchObject({ state: 'done', scannedSessions: 1 });
  }, 60_000);

  it('取消：下一塊就停止讀檔（讀的量遠小於檔案）、不再回 done；新的搜尋照常', async () => {
    const config = temp();
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    await writeBig(join(bigDir, `${id(3)}.jsonl`), 40 * 1024 * 1024, 100);
    const sent: DaemonToHub[] = [];
    // 取消在讀第 3 塊時進來（每讀一塊前看一次時鐘：在那裡模擬 hub 的 search.cancel 剛好到）。
    let checks = 0;
    const searcher: DeepSearcher = new DeepSearcher({
      configDir: config,
      knownProfile: () => false,
      screen: () => null,
      send: (m) => sent.push(m),
      now: () => {
        checks += 1;
        if (checks === 4) searcher.cancel('q1');
        return Date.now();
      },
    });
    const stats = await searcher.start(request('手續費', [target(3)]));
    expect(stats.stopped).toBe('cancelled');
    // 取消之後最多再讀一塊（1MB）：遠小於 40MB 的檔。
    expect(stats.bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(sent.some((m) => m.type === 'search.done')).toBe(false);

    // 用真的計時器取消一次：一樣停下、不回 done。
    const timed = harness(config);
    const first = timed.searcher.start(request('手續費', [target(3)]));
    setTimeout(() => timed.searcher.cancel('q1'), 1);
    const timedStats = await first;
    if (timedStats.stopped === 'cancelled') {
      expect(timedStats.bytes).toBeLessThan(40 * 1024 * 1024);
      expect(timed.sent.some((m) => m.type === 'search.done')).toBe(false);
    }

    const second = await searcher.start({ ...request('手續費', [target(3)]), searchId: 'q2' });
    expect(second.stopped).toBeNull();
    expect(second.bytes).toBeGreaterThanOrEqual(40 * 1024 * 1024);
    expect(sent.find((m) => m.type === 'search.done')).toMatchObject({ searchId: 'q2' });
  }, 30_000);

  it('新的請求讓舊的讓位：正在跑的那個送出部分結果並回 timeout，新的照常跑完', async () => {
    const config = temp();
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    await writeBig(join(bigDir, `${id(3)}.jsonl`), 40 * 1024 * 1024, 100);
    writeTranscript(config, 1, [assistant('手續費 (s1)')]);
    const { searcher, sent } = harness(config);
    const first = searcher.start(request('手續費', [target(3)]));
    await new Promise((r) => setTimeout(r, 5));
    const second = searcher.start({ ...request('手續費', [target(1)]), searchId: 'q2' });
    const [a, b] = await Promise.all([first, second]);
    expect(a.stopped).toBe('deadline');
    expect(a.bytes).toBeLessThan(40 * 1024 * 1024);
    expect(b.stopped).toBeNull();
    const dones = sent.filter((m) => m.type === 'search.done');
    expect(dones).toEqual([
      expect.objectContaining({ searchId: 'q1', state: 'timeout', scannedSessions: 0 }),
      expect.objectContaining({ searchId: 'q2', state: 'done', scannedSessions: 1 }),
    ]);
  }, 30_000);

  it('停下之後，剩下的 session 本來就不必讀的（修改時間在範圍前、沒有 claude id）也算搜過', async () => {
    const config = temp();
    const bigDir = join(config, 'projects', '-tmp-big');
    mkdirSync(bigDir, { recursive: true });
    await writeBig(join(bigDir, `${id(3)}.jsonl`), 10 * 1024 * 1024, 100);
    const old = writeTranscript(config, 2, [assistant('手續費 old')]);
    const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    utimesSync(old, longAgo, longAgo);
    writeTranscript(config, 4, [assistant('手續費 (s4)')]);
    const targets = [
      target(3, 1), // 最新：讀到上限
      target(2, 2), // 檔案在範圍之前：不必讀
      { ...target(5, 3), claudeSessionId: null }, // 沒有對話紀錄：只搜畫面
      target(4, 4), // 範圍內、沒讀到：不算
    ];
    const { searcher, done } = harness(config);
    await searcher.start(request('手續費', targets, { maxBytes: 2 * 1024 * 1024 }));
    expect(done()).toMatchObject({ state: 'timeout', scannedSessions: 2, totalSessions: 4 });
  }, 30_000);

  it('accountProfile 只認這台用過的帳號設定目錄；不認得的只搜畫面、不讀對話紀錄', async () => {
    const config = temp();
    const other = temp();
    writeTranscript(other, 1, [assistant('risk.py 在別的帳號')]);
    const screens = { s1: ['risk.py on screen'] };
    const withProfile = { ...target(1), accountProfile: other };
    const unknown = harness(config, screens);
    await unknown.searcher.start(request('risk.py', [withProfile]));
    expect(unknown.items().map((i) => i.kind)).toEqual(['screen']);
    const known = harness(config, screens, [other]);
    await known.searcher.start(request('risk.py', [withProfile]));
    expect(known.items().map((i) => i.kind)).toEqual(['screen', 'transcript']);
    // 相對路徑一律不讀。
    const relative = harness(config, screens, ['rel/dir']);
    await relative.searcher.start(
      request('risk.py', [{ ...withProfile, accountProfile: 'rel/dir' }]),
    );
    expect(relative.items().map((i) => i.kind)).toEqual(['screen']);
  });
});

describe('daemon 自己的防線', () => {
  it('hub 送來的上限與 session 數收斂到天花板以內', () => {
    const sessions = Array.from({ length: DEEP_HARD_LIMITS.sessions + 5 }, (_, n) => target(n));
    const clamped = clampRequest(
      request('risk', sessions, {
        perSession: 1_000,
        perMachine: 1_000_000,
        maxBytes: 50 * 1024 ** 3,
        deadlineMs: 3_600_000,
      }),
    );
    expect(clamped.sessions).toHaveLength(DEEP_HARD_LIMITS.sessions);
    expect(clamped.limits).toEqual({
      perSession: DEEP_HARD_LIMITS.perSession,
      perMachine: DEEP_HARD_LIMITS.perMachine,
      maxBytes: DEEP_HARD_LIMITS.maxBytes,
      deadlineMs: DEEP_HARD_LIMITS.deadlineMs,
    });
    // 比天花板小的照原樣。
    expect(clampRequest(request('risk', [target(1)], { deadlineMs: 50 })).limits.deadlineMs).toBe(
      50,
    );
  });

  it('檔案清單一次掃完：不跟符號連結、同一個 id 有多份取最新、只收 <uuid>.jsonl', async () => {
    const config = temp();
    const older = writeTranscript(config, 1, [assistant('old')]);
    const longAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    utimesSync(older, longAgo, longAgo);
    const newerDir = join(config, 'projects', '-tmp-newer');
    mkdirSync(newerDir, { recursive: true });
    writeFileSync(join(newerDir, `${id(1)}.jsonl`), assistant('new') + '\n');
    writeFileSync(join(newerDir, 'notes.jsonl'), '{}\n');
    const outside = join(temp(), 'secret.jsonl');
    writeFileSync(outside, assistant('secret') + '\n');
    symlinkSync(outside, join(newerDir, `${id(7)}.jsonl`));
    symlinkSync(join(temp()), join(config, 'projects', '-tmp-linked-dir'));
    const index = await indexTranscripts(config);
    expect([...index.keys()]).toEqual([id(1)]);
    expect(index.get(id(1))!.path).toBe(join(newerDir, `${id(1)}.jsonl`));
  });

  it('自己切行：和 readline 切出來的一樣（跨區塊、CRLF、最後一行沒有換行）；太長的行整行丟掉；符號連結開不起來', async () => {
    const dir = temp();
    const file = join(dir, 'lines.jsonl');
    const lines = [
      'a',
      '',
      'x'.repeat(700_000),
      '中文'.repeat(300_000),
      'crlf\r',
      'y'.repeat(1_500_000),
      'tail',
    ];
    writeFileSync(file, lines.join('\n'));
    const budget = (): Budget => ({
      deadline: Date.now() + 60_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
      bytes: 0,
      cancelled: false,
    });
    const ours: string[] = [];
    const result = await readLines(file, budget(), Date.now, (line) => ours.push(line));
    expect(result.stopped).toBeNull();
    const theirs: string[] = [];
    for await (const line of createInterface({
      input: createReadStream(file, 'utf8'),
      crlfDelay: Infinity,
    })) {
      theirs.push(line);
    }
    expect(ours.map((l) => l.length)).toEqual(theirs.map((l) => l.length));
    expect(ours).toEqual(theirs);

    // 超過 MAX_LINE_CHARS 的 3 倍位元組：整行丟掉，前後的行照常。
    const huge = join(dir, 'huge.jsonl');
    const out = createWriteStream(huge);
    out.write('before\n');
    const block = 'z'.repeat(1024 * 1024);
    for (let i = 0; i < 25; i += 1) {
      if (!out.write(block)) await new Promise((r) => out.once('drain', r));
    }
    out.write('\nafter\n');
    await new Promise<void>((r) => out.end(r));
    const kept: string[] = [];
    await readLines(huge, budget(), Date.now, (line) => kept.push(line));
    expect(kept).toEqual(['before', 'after']);

    const link = join(dir, 'link.jsonl');
    symlinkSync(file, link);
    const viaLink: string[] = [];
    expect(await readLines(link, budget(), Date.now, (line) => viaLink.push(line))).toEqual({
      bytes: 0,
      stopped: null,
    });
    expect(viaLink).toEqual([]);
  }, 30_000);

  it('countEntries 和 parseLine 算出的則數一樣', () => {
    const samples = [
      user('hi'),
      user('   '),
      assistant('text'),
      toolResult('result'),
      toolResult('  \n '),
      progress(),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }, 3, null] } }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'plain' }, { type: 'image' }] },
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '\u3000' }] } }),
      JSON.stringify({ type: 'user', message: 'no content' }),
      '{broken',
    ];
    for (const line of samples) expect(countEntries(line)).toBe(parseLine(line).length);
  });
});
