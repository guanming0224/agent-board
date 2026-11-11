// N2／審查 W1：程序啟動時間。Windows 用 PowerShell 的 Get-Process，一次查完所有 pid、非同步不阻塞。
// 假的指令驗規則；真的平台（含 Windows CI）讀自己的程序。
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentsStillRunning,
  agentStillRunning,
  clearStartTimeCache,
  parseWindowsStartTime,
  processStartTime,
  processStartTimes,
  START_TIME_CACHE_MS,
  WINDOWS_QUERY_TIMEOUT_MS,
  windowsPowerShell,
  windowsStartTimeArgs,
  type RunCommand,
} from './processCheck';

afterEach(() => clearStartTimeCache());

describe('processStartTimes', () => {
  it('Windows：絕對路徑的 powershell.exe -NoProfile -NonInteractive、Get-Process 一次查全部 pid、逾時 10 秒', async () => {
    const calls: { file: string; args: string[]; timeout: number }[] = [];
    const run: RunCommand = async (file, args, timeout) => {
      calls.push({ file, args, timeout });
      return '4242 2026-11-12T01:02:03.4567890Z\r\n4243 2026-11-12T09:00:00.0000000+08:00\r\n';
    };
    const times = await processStartTimes([4242, 4243, 4244], { platform: 'win32', run });
    expect(times.get(4242)?.toISOString()).toBe('2026-11-12T01:02:03.456Z');
    expect(times.get(4243)?.toISOString()).toBe('2026-11-12T01:00:00.000Z');
    expect(times.has(4244)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(windowsPowerShell());
    expect(calls[0]!.file).toMatch(
      /[\\]System32[\\]WindowsPowerShell[\\]v1\.0[\\]powershell\.exe$/,
    );
    expect(calls[0]!.timeout).toBe(WINDOWS_QUERY_TIMEOUT_MS);
    expect(WINDOWS_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(calls[0]!.args).toEqual(windowsStartTimeArgs([4242, 4243, 4244]));
    expect(calls[0]!.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive']);
    expect(calls[0]!.args[3]).toContain('Get-Process -Id 4242,4243,4244');
    expect(calls[0]!.args[3]).toContain("ToUniversalTime().ToString('o')");
  });

  it('PowerShell 的絕對路徑跟著 SystemRoot', () => {
    expect(windowsPowerShell({ SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('只認含時區的 ISO 8601：地區格式、沒有時區、空的一律讀不到', () => {
    expect(parseWindowsStartTime('2026-11-12T09:02:03.1234567+08:00')?.toISOString()).toBe(
      '2026-11-12T01:02:03.123Z',
    );
    expect(parseWindowsStartTime('2026-11-12T01:02:03')).toBeNull();
    expect(parseWindowsStartTime('11/12/2026 1:02:03 AM')).toBeNull();
    expect(parseWindowsStartTime('')).toBeNull();
  });

  it('大量 pid 只開一次 PowerShell；查詢期間 event loop 不被卡住', async () => {
    let calls = 0;
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const run: RunCommand = async (_file, args) => {
      calls += 1;
      // 模擬 PowerShell 冷啟動很慢（非同步等待，不是忙等）。
      await new Promise((resolve) => setTimeout(resolve, 200));
      const ids = /-Id ([\d,]+)/.exec(args[3]!)![1]!.split(',');
      return ids.map((id) => `${id} 2026-11-12T01:02:03Z`).join('\r\n');
    };
    const pids = Array.from({ length: 200 }, (_, i) => 10_000 + i);
    const times = await processStartTimes(pids, { platform: 'win32', run });
    clearInterval(timer);
    expect(calls).toBe(1);
    expect(times.size).toBe(200);
    expect(ticks).toBeGreaterThan(5);
    // 第二次全部從快取拿，不再開。
    await processStartTimes(pids, { platform: 'win32', run });
    expect(calls).toBe(1);
  });

  it('agentsStillRunning：一批 agent 只對還在、有記啟動時間的 pid 查一次', async () => {
    let calls = 0;
    const run: RunCommand = async () => {
      calls += 1;
      throw new Error('powershell 逾時');
    };
    const result = await agentsStillRunning(
      [
        { pid: process.pid, startedAt: new Date(0).toISOString() },
        { pid: process.pid, startedAt: null },
        { pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() },
        { pid: null, startedAt: null },
      ],
      { platform: 'win32', run },
    );
    // 讀不到啟動時間當成還在；pid 不在、沒有 pid 不算。
    expect(result).toEqual([true, true, false, false]);
    expect(calls).toBe(1);
  });

  it('讀到的值快取 60 秒；讀不到的不快取', async () => {
    let count = 0;
    const run: RunCommand = async (_f, args) => {
      count += 1;
      return `${/-Id (\d+)/.exec(args[3]!)![1]} 2026-11-12T01:02:03.0000000Z`;
    };
    const now = 1_000_000;
    await processStartTime(77, { platform: 'win32', run, now });
    await processStartTime(77, { platform: 'win32', run, now: now + START_TIME_CACHE_MS - 1 });
    expect(count).toBe(1);
    await processStartTime(77, { platform: 'win32', run, now: now + START_TIME_CACHE_MS });
    expect(count).toBe(2);
    let failures = 0;
    const failing: RunCommand = async () => {
      failures += 1;
      throw new Error('x');
    };
    await processStartTime(78, { platform: 'win32', run: failing, now });
    await processStartTime(78, { platform: 'win32', run: failing, now });
    expect(failures).toBe(2);
  });

  it('這個平台真的讀得到自己的啟動時間，而且和 uptime 推算的差不到 15 秒（Windows CI 跑真的 PowerShell）', async () => {
    const at = await processStartTime(process.pid);
    expect(at).toBeInstanceOf(Date);
    const expected = Date.now() - process.uptime() * 1000;
    expect(Math.abs(at!.getTime() - expected)).toBeLessThan(15_000);
    expect(await agentStillRunning(process.pid, at!.toISOString())).toBe(true);
    expect(
      await agentStillRunning(process.pid, new Date(at!.getTime() - 3_600_000).toISOString()),
    ).toBe(false);
  }, 20_000);
});
