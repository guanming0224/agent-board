// 用量細項（GM 2026-11-09）：每日 × 模型 × Claude session、去重、時區與日期邊界、上限與「其他」、舊格式容錯。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageDetail } from '@agent-board/protocol';
import { makeTempDir } from './test-support/harness';
import { scanUsage, sessionIdFromPath, shiftDay } from './usage';

const temps: string[] = [];
function configDir(): string {
  const dir = makeTempDir();
  temps.push(dir);
  mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SA = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';
const SC = '33333333-3333-4333-8333-333333333333';
const line = (fields: Record<string, unknown>) => JSON.stringify(fields);
const usage = (input: number, output = 0, read = 0, write = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});
const write = (dir: string, name: string, lines: string[]) => {
  const file = join(dir, 'projects', 'p', name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.join('\n'));
};

/** 細項攤平成好比對的物件：`日期|模型|session` → [輸入, 輸出, 快取讀, 快取寫]。 */
function flat(detail: UsageDetail): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [d, m, s, ...counts] of detail.rows) {
    const session = s === -1 ? 'other' : detail.sessions[s]!.id.slice(0, 2);
    out[`${detail.days[d]}|${detail.models[m]}|${session}`] = counts;
  }
  return out;
}

const NOW = new Date('2026-11-09T03:00:00Z'); // 台北 11:00、UTC 03:00、紐約前一天 22:00

describe('scanUsage 細項', () => {
  it('依日期 × 模型 × session 彙總，同一則回應只算一次，cwd 取第一個看到的', async () => {
    const dir = configDir();
    write(dir, `${SA}.jsonl`, [
      line({
        timestamp: '2026-11-08T10:00:00Z',
        sessionId: SA,
        cwd: '/work/alpha',
        requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus', usage: usage(10, 5, 100, 20) },
      }),
      // 串流的同一則回應拆成兩行：各欄取最大，不相加。
      line({
        timestamp: '2026-11-08T10:00:01Z',
        sessionId: SA,
        cwd: '/work/alpha/sub',
        requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus', usage: usage(10, 50, 100, 20) },
      }),
      line({
        timestamp: '2026-11-08T11:00:00Z',
        sessionId: SA,
        requestId: 'r2',
        message: { id: 'm2', model: 'claude-haiku', usage: usage(1, 2) },
      }),
    ]);
    write(dir, `${SB}.jsonl`, [
      line({
        timestamp: '2026-11-09T01:00:00Z',
        sessionId: SB,
        cwd: '/work/beta',
        message: { id: 'm3', model: 'claude-opus', usage: usage(7) },
      }),
    ]);
    const { summary, detail } = await scanUsage([dir], NOW, { timeZone: 'UTC', detailDays: 3 });
    expect(detail.days).toEqual(['2026-11-07', '2026-11-08', '2026-11-09']);
    expect(detail.timeZone).toBe('UTC');
    expect(flat(detail)).toEqual({
      '2026-11-08|claude-opus|11': [10, 50, 100, 20],
      '2026-11-08|claude-haiku|11': [1, 2, 0, 0],
      '2026-11-09|claude-opus|22': [7, 0, 0, 0],
    });
    expect(detail.sessions).toEqual([
      { id: SA, cwd: '/work/alpha' },
      { id: SB, cwd: '/work/beta' },
    ]);
    expect(detail.otherSessions).toBe(0);
    expect(detail.earliestAt).toBe('2026-11-08T10:00:00.000Z');
    // 細項加總和總數一致（區間都涵蓋這些資料時）。
    expect(summary).toMatchObject({ inputTokens: 18, outputTokens: 52, cacheReadTokens: 100 });
    expect(UsageDetail.safeParse(detail).success).toBe(true);
  });

  it('日期用指定時區：同一刻在台北與紐約落在不同天；今天以那個時區為準', async () => {
    const dir = configDir();
    write(dir, `${SA}.jsonl`, [
      // 台北 11-09 00:30、UTC 11-08 16:30、紐約 11-08 11:30
      line({ timestamp: '2026-11-08T16:30:00Z', sessionId: SA, message: { usage: usage(3) } }),
      // 台北 11-08 23:59:59
      line({ timestamp: '2026-11-08T15:59:59Z', sessionId: SA, message: { usage: usage(4) } }),
    ]);
    const taipei = await scanUsage([dir], NOW, { timeZone: 'Asia/Taipei', detailDays: 2 });
    expect(taipei.detail.days).toEqual(['2026-11-08', '2026-11-09']);
    expect(flat(taipei.detail)).toEqual({
      '2026-11-08||11': [4, 0, 0, 0],
      '2026-11-09||11': [3, 0, 0, 0],
    });
    const ny = await scanUsage([dir], NOW, { timeZone: 'America/New_York', detailDays: 2 });
    // 紐約那時還是 11-08 晚上，所以今天是 11-08。
    expect(ny.detail.days).toEqual(['2026-11-07', '2026-11-08']);
    expect(flat(ny.detail)).toEqual({ '2026-11-08||11': [7, 0, 0, 0] });
  });

  it('細項只留最近 N 個日曆日；比第一天早、或比現在晚的不進細項', async () => {
    const dir = configDir();
    write(dir, `${SA}.jsonl`, [
      line({ timestamp: '2026-11-06T23:59:59Z', sessionId: SA, message: { usage: usage(1) } }),
      line({ timestamp: '2026-11-07T00:00:00Z', sessionId: SA, message: { usage: usage(2) } }),
      line({ timestamp: '2026-11-09T05:00:00Z', sessionId: SA, message: { usage: usage(9) } }),
    ]);
    const { summary, detail } = await scanUsage([dir], NOW, { timeZone: 'UTC', detailDays: 3 });
    expect(flat(detail)).toEqual({ '2026-11-07||11': [2, 0, 0, 0] });
    // 總數是 30×24 小時，兩筆都在；未來的那筆兩邊都不算。
    expect(summary.inputTokens).toBe(3);
  });

  it('超過 session 上限：份量小的併成「其他」(-1)，總數不變', async () => {
    const dir = configDir();
    const at = '2026-11-09T01:00:00Z';
    write(dir, `${SA}.jsonl`, [
      line({ timestamp: at, sessionId: SA, message: { model: 'x', usage: usage(100) } }),
    ]);
    write(dir, `${SB}.jsonl`, [
      line({ timestamp: at, sessionId: SB, message: { model: 'x', usage: usage(5) } }),
    ]);
    write(dir, `${SC}.jsonl`, [
      line({ timestamp: at, sessionId: SC, message: { model: 'x', usage: usage(1, 1) } }),
    ]);
    const { detail } = await scanUsage([dir], NOW, {
      timeZone: 'UTC',
      detailDays: 1,
      sessionLimit: 1,
    });
    expect(detail.sessions.map((s) => s.id)).toEqual([SA]);
    expect(detail.otherSessions).toBe(2);
    expect(flat(detail)).toEqual({
      '2026-11-09|x|11': [100, 0, 0, 0],
      '2026-11-09|x|other': [6, 1, 0, 0],
    });
  });

  it('列數超過上限：少留 session 直到放得下', async () => {
    const dir = configDir();
    const ids = Array.from(
      { length: 8 },
      (_, i) => `${String(i).repeat(8)}-0000-4000-8000-000000000000`,
    );
    for (const [i, id] of ids.entries()) {
      write(dir, `${id}.jsonl`, [
        line({
          timestamp: '2026-11-09T01:00:00Z',
          sessionId: id,
          message: { model: 'x', usage: usage(10 + i) },
        }),
      ]);
    }
    const { detail } = await scanUsage([dir], NOW, {
      timeZone: 'UTC',
      detailDays: 1,
      rowLimit: 3,
    });
    expect(detail.rows.length).toBeLessThanOrEqual(3);
    // 8 → 4 → 2 個 session ＋「其他」= 3 列。
    expect(detail.sessions).toHaveLength(2);
    expect(detail.otherSessions).toBe(6);
    const sum = detail.rows.reduce((s, r) => s + r[3], 0);
    expect(sum).toBe(ids.reduce((s, _, i) => s + 10 + i, 0));
  });

  it('舊格式容錯：沒時間只進總數；沒模型是空字串；沒 sessionId 從檔名推，推不出來進「其他」', async () => {
    const dir = configDir();
    write(dir, `${SA}.jsonl`, [
      line({ timestamp: '2026-11-09T01:00:00Z', message: { usage: usage(1) } }),
      line({ message: { usage: usage(50) } }),
      line({ timestamp: '2026-11-09T01:00:00Z', message: { usage: usage(0) } }),
      '{"usage": broken',
    ]);
    // subagent 的紀錄算在叫它的 session 上。
    write(dir, `${SB}/subagents/agent-abc.jsonl`, [
      line({ timestamp: '2026-11-09T01:00:00Z', message: { usage: usage(2) } }),
    ]);
    write(dir, 'notes.jsonl', [
      line({ timestamp: '2026-11-09T01:00:00Z', message: { usage: usage(4) } }),
    ]);
    const { summary, detail } = await scanUsage([dir], NOW, { timeZone: 'UTC', detailDays: 1 });
    expect(summary.inputTokens).toBe(57);
    expect(flat(detail)).toEqual({
      '2026-11-09||11': [1, 0, 0, 0],
      '2026-11-09||22': [2, 0, 0, 0],
      '2026-11-09||other': [4, 0, 0, 0],
    });
    expect(detail.sessions.map((s) => s.cwd)).toEqual([null, null]);
  });

  it('資料夾不存在：細項是空的，日期照列', async () => {
    const { detail } = await scanUsage([join(makeTempDir(), 'none')], NOW, {
      timeZone: 'UTC',
      detailDays: 2,
    });
    expect(detail).toMatchObject({ days: ['2026-11-08', '2026-11-09'], rows: [], sessions: [] });
    expect(detail.earliestAt).toBeNull();
  });
});

describe('工具函式', () => {
  it('sessionIdFromPath', () => {
    expect(sessionIdFromPath(`/x/p/${SA}.jsonl`)).toBe(SA);
    expect(sessionIdFromPath(`/x/p/${SA}/subagents/agent-1.jsonl`)).toBe(SA);
    expect(sessionIdFromPath('/x/p/notes.jsonl')).toBeNull();
  });

  it('shiftDay 跨月、跨年、閏年', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});
