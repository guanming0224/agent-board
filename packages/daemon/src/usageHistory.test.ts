// 用量歷史（GM 2026-11-21，CONTRACTS §27）：全部時間的掃描、增量快取（新增／變大／被刪／被改）、
// 跨檔去重、Codex、時區、送給 hub 的差異（回填、只送有變的日子）。測試只用假資料夾。
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageHistory, type UsageHistoryCell } from '@agent-board/protocol';
import { makeTempDir } from './test-support/harness';
import { scanUsage } from './usage';
import {
  historyDelta,
  newHistorySendState,
  USAGE_HISTORY_CACHE_FILE,
  UsageHistoryScanner,
} from './usageHistory';

const temps: string[] = [];
const temp = () => {
  const dir = makeTempDir();
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SA = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';
const usage = (input: number, output = 0, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});
const claudeLine = (at: string, id: string, model: string, u: ReturnType<typeof usage>) =>
  JSON.stringify({
    timestamp: at,
    sessionId: SA,
    requestId: `r-${id}`,
    message: { id, model, usage: u },
  });

function setup() {
  const config = temp();
  const data = temp();
  const project = join(config, 'projects', 'p');
  mkdirSync(project, { recursive: true });
  const scanner = new UsageHistoryScanner(join(data, USAGE_HISTORY_CACHE_FILE), {
    timeZone: 'UTC',
  });
  return { config, data, project, scanner };
}

/** `來源|日期|模型` → [i, o, r, w]。 */
const flat = (cells: readonly UsageHistoryCell[]) =>
  Object.fromEntries(
    cells.map((c) => [
      `${c.source}|${c.day}|${c.model}`,
      [c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheCreationTokens],
    ]),
  );

/** mtime 秒級的檔案系統上，同一秒內改檔要手動推 mtime 才看得出變了。 */
const bump = (file: string, seconds: number) => {
  const t = new Date(Date.now() + seconds * 1000);
  utimesSync(file, t, t);
};

describe('UsageHistoryScanner 全部時間', () => {
  it('不限 90 天：一年前的紀錄也算；依日期 × 模型彙總，同一則回應只算一次（跨檔也是）', async () => {
    const { config, project, scanner } = setup();
    writeFileSync(
      join(project, `${SA}.jsonl`),
      [
        claudeLine('2025-06-01T10:00:00Z', 'm1', 'claude-opus', usage(10, 5, 100, 20)),
        // 串流拆成兩行：各欄取最大。
        claudeLine('2025-06-01T10:00:01Z', 'm1', 'claude-opus', usage(10, 50, 100, 20)),
        claudeLine('2026-11-20T10:00:00Z', 'm2', 'claude-haiku', usage(1, 2)),
        // 沒有時間的行排不進哪一天。
        JSON.stringify({ message: { id: 'm9', usage: usage(999) } }),
        'not json',
      ].join('\n') + '\n',
    );
    // resume 複製過來的同一則（另一個檔）：只算一次。
    writeFileSync(
      join(project, `${SB}.jsonl`),
      claudeLine('2025-06-01T10:00:00Z', 'm1', 'claude-opus', usage(10, 50, 100, 20)) + '\n',
    );
    const scan = await scanner.scan({ claude: [config], codex: null });
    expect(flat(scan.cells)).toEqual({
      'claude|2025-06-01|claude-opus': [10, 50, 100, 20],
      'claude|2026-11-20|claude-haiku': [1, 2, 0, 0],
    });
    expect(scan.earliest).toEqual({ claude: '2025-06-01', codex: null });
    expect(scan.stats).toMatchObject({ files: 2, rescanned: 2, reused: 0 });
  });

  it('近 90 天的數字和既有的細項掃描一致', async () => {
    const { config, project, scanner } = setup();
    writeFileSync(
      join(project, `${SA}.jsonl`),
      [
        claudeLine('2026-11-08T10:00:00Z', 'a', 'claude-opus', usage(3, 4, 5, 6)),
        claudeLine('2026-11-08T23:30:00Z', 'b', 'claude-opus', usage(1)),
        claudeLine('2026-11-09T00:30:00Z', 'c', '', usage(2)),
      ].join('\n'),
    );
    const now = new Date('2026-11-09T03:00:00Z');
    const { detail } = await scanUsage([config], now, { timeZone: 'UTC' });
    const fromDetail: Record<string, number[]> = {};
    for (const [d, m, , ...counts] of detail.rows) {
      const key = `claude|${detail.days[d]}|${detail.models[m]}`;
      const sum = fromDetail[key] ?? [0, 0, 0, 0];
      fromDetail[key] = sum.map((v, i) => v + counts[i]!);
    }
    const scan = await scanner.scan({ claude: [config], codex: null });
    expect(flat(scan.cells)).toEqual(fromDetail);
  });

  it('增量快取：沒變的用快取、變大的接著讀、被改寫的整個重讀、被刪的拿掉', async () => {
    const { config, data, project, scanner } = setup();
    const a = join(project, `${SA}.jsonl`);
    const b = join(project, `${SB}.jsonl`);
    writeFileSync(a, claudeLine('2026-01-01T00:00:00Z', 'a1', 'm', usage(1)) + '\n');
    writeFileSync(b, claudeLine('2026-02-01T00:00:00Z', 'b1', 'm', usage(10)) + '\n');
    let scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ rescanned: 2, reused: 0 });

    // 沒變：兩個都用快取，一個位元組都不讀。
    scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ reused: 2, rescanned: 0, appended: 0, bytesRead: 0 });

    // 變大（往後加）：只讀新加的部分；同一則回應跨兩次讀取也只算一次（各欄取最大）。
    const before = readFileSync(a).length;
    appendFileSync(
      a,
      [
        claudeLine('2026-01-01T00:00:01Z', 'a1', 'm', usage(1, 7)),
        claudeLine('2026-03-01T00:00:00Z', 'a2', 'm', usage(2)),
      ].join('\n') + '\n',
    );
    bump(a, 5);
    scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ appended: 1, reused: 1, rescanned: 0 });
    expect(scan.stats.bytesRead).toBe(readFileSync(a).length - before);
    expect(flat(scan.cells)).toEqual({
      'claude|2026-01-01|m': [1, 7, 0, 0],
      'claude|2026-02-01|m': [10, 0, 0, 0],
      'claude|2026-03-01|m': [2, 0, 0, 0],
    });

    // 被改寫（內容換掉、大小變小）：整個重讀，不留舊的數字。
    writeFileSync(b, claudeLine('2026-02-02T00:00:00Z', 'b2', 'm', usage(4)) + '\n');
    bump(b, 10);
    scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ rescanned: 1, reused: 1 });
    expect(flat(scan.cells)['claude|2026-02-01|m']).toBeUndefined();
    expect(flat(scan.cells)['claude|2026-02-02|m']).toEqual([4, 0, 0, 0]);

    // 前面被改、但變大（尾巴對不上）：也整個重讀。
    writeFileSync(
      b,
      [
        claudeLine('2026-02-03T00:00:00Z', 'b3', 'm', usage(5)),
        claudeLine('2026-02-04T00:00:00Z', 'b4', 'm', usage(6)),
      ].join('\n') + '\n',
    );
    bump(b, 15);
    scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ rescanned: 1, appended: 0 });
    expect(flat(scan.cells)['claude|2026-02-02|m']).toBeUndefined();

    // 被刪：從快取拿掉。
    rmSync(b);
    scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ removed: 1, reused: 1, files: 1 });
    expect(Object.keys(flat(scan.cells))).toEqual(['claude|2026-01-01|m', 'claude|2026-03-01|m']);

    // 快取寫在 daemon 資料夾，只有數字（沒有對話內容）；重開 daemon（新的掃描器）沿用。
    const cacheText = readFileSync(join(data, USAGE_HISTORY_CACHE_FILE), 'utf8');
    expect(cacheText).not.toContain('sessionId');
    expect(cacheText).not.toContain('a1');
    const again = new UsageHistoryScanner(join(data, USAGE_HISTORY_CACHE_FILE), {
      timeZone: 'UTC',
    });
    scan = await again.scan({ claude: [config], codex: null });
    expect(scan.stats).toMatchObject({ reused: 1, rescanned: 0 });
    expect(flat(scan.cells)['claude|2026-03-01|m']).toEqual([2, 0, 0, 0]);
  });

  it('最後一行還沒寫完：不算，寫完後接著讀', async () => {
    const { config, project, scanner } = setup();
    const a = join(project, `${SA}.jsonl`);
    const full = claudeLine('2026-04-01T00:00:00Z', 'x', 'm', usage(3));
    writeFileSync(
      a,
      `${claudeLine('2026-04-01T00:00:00Z', 'w', 'm', usage(1))}\n${full.slice(0, 30)}`,
    );
    let scan = await scanner.scan({ claude: [config], codex: null });
    expect(flat(scan.cells)['claude|2026-04-01|m']).toEqual([1, 0, 0, 0]);
    appendFileSync(a, `${full.slice(30)}\n`);
    bump(a, 5);
    scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats.appended).toBe(1);
    expect(flat(scan.cells)['claude|2026-04-01|m']).toEqual([4, 0, 0, 0]);
  });

  it('時區換了：快取整份重來，日期照新時區', async () => {
    const { config, data, project, scanner } = setup();
    writeFileSync(
      join(project, `${SA}.jsonl`),
      claudeLine('2026-05-01T20:00:00Z', 'a', 'm', usage(1)) + '\n',
    );
    expect(
      Object.keys(flat((await scanner.scan({ claude: [config], codex: null })).cells)),
    ).toEqual(['claude|2026-05-01|m']);
    const taipei = new UsageHistoryScanner(join(data, USAGE_HISTORY_CACHE_FILE), {
      timeZone: 'Asia/Taipei',
    });
    const scan = await taipei.scan({ claude: [config], codex: null });
    expect(scan.stats.rescanned).toBe(1);
    expect(Object.keys(flat(scan.cells))).toEqual(['claude|2026-05-02|m']);
  });

  it('Codex：token_count 換算成四欄、跨檔去重、接著讀時記得模型與上一則 total', async () => {
    const { data } = setup();
    const codexHome = temp();
    const day = join(codexHome, 'sessions', '2026', '05', '01');
    mkdirSync(day, { recursive: true });
    const thread = '019a0000-0000-7000-8000-000000000001';
    const file = join(day, `rollout-2026-05-01T00-00-00-${thread}.jsonl`);
    const event = (at: string, input: number, cached: number, output: number, total: number) =>
      JSON.stringify({
        timestamp: at,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
            },
            total_token_usage: { total_tokens: total },
          },
        },
      });
    const first = [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/w' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      event('2026-05-01T01:00:00Z', 100, 40, 10, 110),
      // 重複送的（total 一樣）略過。
      event('2026-05-01T01:00:01Z', 100, 40, 10, 110),
    ];
    writeFileSync(file, first.join('\n') + '\n');
    // fork 出來的檔整段複製了同一則事件：只算一次。
    writeFileSync(
      join(day, `rollout-2026-05-01T00-00-01-019a0000-0000-7000-8000-000000000002.jsonl`),
      [JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }), first[2]].join(
        '\n',
      ) + '\n',
    );
    const scanner = new UsageHistoryScanner(join(data, USAGE_HISTORY_CACHE_FILE), {
      timeZone: 'UTC',
    });
    let scan = await scanner.scan({ claude: [], codex: codexHome });
    expect(flat(scan.cells)).toEqual({ 'codex|2026-05-01|gpt-5.5': [60, 10, 40, 0] });

    // 接著讀：新事件沒有 turn_context，模型沿用快取記下的；total 和上一則一樣的仍略過。
    appendFileSync(
      file,
      [
        event('2026-05-01T01:00:02Z', 100, 40, 10, 110),
        event('2026-05-02T01:00:00Z', 5, 0, 1, 116),
      ].join('\n') + '\n',
    );
    bump(file, 5);
    scan = await scanner.scan({ claude: [], codex: codexHome });
    expect(scan.stats.appended).toBe(1);
    expect(flat(scan.cells)).toEqual({
      'codex|2026-05-01|gpt-5.5': [60, 10, 40, 0],
      'codex|2026-05-02|gpt-5.5': [5, 1, 0, 0],
    });
    expect(scan.earliest.codex).toBe('2026-05-01');
  });

  it('壞掉的快取檔：當沒有，整個重掃', async () => {
    const { config, data, project } = setup();
    writeFileSync(join(data, USAGE_HISTORY_CACHE_FILE), '{"version":1,"timeZone":"UTC","sources":');
    writeFileSync(
      join(project, `${SA}.jsonl`),
      claudeLine('2026-01-01T00:00:00Z', 'a', 'm', usage(1)),
    );
    const scanner = new UsageHistoryScanner(join(data, USAGE_HISTORY_CACHE_FILE), {
      timeZone: 'UTC',
    });
    const scan = await scanner.scan({ claude: [config], codex: null });
    expect(scan.stats.rescanned).toBe(1);
    expect(flat(scan.cells)).toEqual({ 'claude|2026-01-01|m': [1, 0, 0, 0] });
  });
});

describe('historyDelta 送給 hub 的差異', () => {
  const cell = (
    day: string,
    input: number,
    source: 'claude' | 'codex' = 'claude',
  ): UsageHistoryCell => ({
    day,
    source,
    model: 'm',
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
  const days = (h: UsageHistory) => h.rows.map((r) => `${h.days[r[0]]}:${r[2]}:${r[3]}`);

  it('第一次回填全部（complete）；之後只送最近 2 天與有變的日子；沒東西就不送', () => {
    const state = newHistorySendState();
    const scan = {
      timeZone: 'UTC',
      cells: [cell('2025-01-01', 1), cell('2026-11-19', 2), cell('2026-11-21', 3, 'codex')],
    };
    const first = historyDelta(scan, '2026-11-21', state)!;
    expect(UsageHistory.parse(first.history)).toBeTruthy();
    expect(first.history.complete).toBe(true);
    expect(days(first.history)).toEqual(['2026-11-21:1:3', '2026-11-19:0:2', '2025-01-01:0:1']);
    first.commit();

    // 沒變：只送最近 2 天（11-20、11-21）裡有的。
    const second = historyDelta(scan, '2026-11-21', state)!;
    expect(second.history.complete).toBe(false);
    expect(days(second.history)).toEqual(['2026-11-21:1:3']);
    second.commit();

    // 舊日子的數字變了（例如很久以前的對話被 resume 補了紀錄）：送那一天。
    const changed = { ...scan, cells: [cell('2025-01-01', 5), cell('2026-11-19', 2)] };
    expect(days(historyDelta(changed, '2026-11-21', state)!.history)).toEqual(['2025-01-01:0:5']);

    // 隔天、沒有任何變動也沒有最近的日子：不帶歷史。
    const quiet = { timeZone: 'UTC', cells: [cell('2025-01-01', 1)] };
    expect(historyDelta(quiet, '2026-11-25', state)).toBeNull();
  });

  it('沒有送成功（沒 commit）：下次照樣再送；超過上限分批，送完最後一批才 complete', () => {
    const state = newHistorySendState();
    const scan = {
      timeZone: 'UTC',
      cells: [cell('2026-01-01', 1), cell('2026-01-02', 2), cell('2026-01-03', 3)],
    };
    expect(historyDelta(scan, '2026-11-21', state, 2)!.history.complete).toBe(false);
    const a = historyDelta(scan, '2026-11-21', state, 2)!;
    expect(days(a.history)).toEqual(['2026-01-03:0:3', '2026-01-02:0:2']);
    a.commit();
    const b = historyDelta(scan, '2026-11-21', state, 2)!;
    expect(days(b.history)).toEqual(['2026-01-01:0:1']);
    expect(b.history.complete).toBe(true);
    b.commit();
    expect(historyDelta(scan, '2026-11-21', state, 2)).toBeNull();
  });

  it('機器上完全沒有紀錄：第一次仍送一則空的 complete（hub 記下「已回填」）', () => {
    const state = newHistorySendState();
    const d = historyDelta({ timeZone: 'UTC', cells: [] }, '2026-11-21', state)!;
    expect(d.history).toMatchObject({ complete: true, rows: [] });
    d.commit();
    expect(historyDelta({ timeZone: 'UTC', cells: [] }, '2026-11-21', state)).toBeNull();
  });
});
