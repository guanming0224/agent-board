// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { UsageSummary } from '@agent-board/protocol';
import { conversationTokens, fetchUsage, formatTokens, usageTotals, windowDays } from './usage';

const DAY = 24 * 60 * 60_000;

const summary = (machineId: string, over: Partial<UsageSummary> = {}): UsageSummary => ({
  machineId,
  from: new Date(Date.UTC(2026, 9, 4)).toISOString(),
  to: new Date(Date.UTC(2026, 9, 4) + 30 * DAY).toISOString(),
  inputTokens: 100,
  outputTokens: 900,
  cacheReadTokens: 50_000,
  cacheCreationTokens: 2_000,
  ...over,
});

describe('usageTotals', () => {
  it('沒有任何一台回報時是 null，不是 0', () => {
    expect(usageTotals([])).toBeNull();
    expect(usageTotals([null, undefined])).toBeNull();
  });

  it('主數字只算輸入＋輸出，快取另計；沒回報的機器不算進台數', () => {
    const totals = usageTotals([summary('a'), null, summary('b', { outputTokens: 0 })]);
    expect(totals).toEqual({ tokens: 1100, cacheTokens: 104_000, machines: 2, days: 30 });
  });

  it('天數照回報的區間，不寫死 30', () => {
    const s = summary('a', { to: new Date(Date.parse(summary('a').from) + 7 * DAY).toISOString() });
    expect(windowDays(s)).toBe(7);
    expect(usageTotals([s])?.days).toBe(7);
  });

  it('conversationTokens 不含快取', () => {
    expect(conversationTokens(summary('a'))).toBe(1000);
  });
});

describe('fetchUsage', () => {
  it('逐台問；單台失敗沿用上一輪的值，沒上一輪就不放', async () => {
    const backend = {
      machineUsage: async (id: string) => {
        if (id.startsWith('bad')) throw new Error('boom');
        return id === 'never' ? null : summary(id);
      },
    };
    const previous = { bad: summary('bad', { inputTokens: 7 }) };
    const result = await fetchUsage(backend, ['ok', 'never', 'bad', 'bad2'], previous);
    expect(result.failed).toBe(false);
    expect(result.byMachine.ok?.inputTokens).toBe(100);
    expect(result.byMachine.never).toBeNull();
    expect(result.byMachine.bad?.inputTokens).toBe(7);
    expect('bad2' in result.byMachine).toBe(false);
  });

  it('每台都失敗才算失敗；沒有機器不算失敗', async () => {
    const backend = {
      machineUsage: async () => {
        throw new Error('offline');
      },
    };
    expect((await fetchUsage(backend, ['a', 'b'], {})).failed).toBe(true);
    expect((await fetchUsage(backend, [], {})).failed).toBe(false);
  });
});

describe('formatTokens', () => {
  it('大數字用精簡寫法', () => {
    expect(formatTokens(1_234_567, 'en')).toBe('1.2M');
    expect(formatTokens(950, 'en')).toBe('950');
    expect(formatTokens(1_200_000, 'zh-TW')).toBe('120萬');
  });
});
