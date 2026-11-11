// N2：程序啟動時間（Windows 用 PowerShell 的 Get-Process）。假的指令驗規則；真的平台（含 Windows CI）讀自己的程序。
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentStillRunning,
  clearStartTimeCache,
  parseWindowsStartTime,
  processStartTime,
  START_TIME_CACHE_MS,
  WINDOWS_QUERY_TIMEOUT_MS,
  windowsStartTimeArgs,
  type RunCommand,
} from './processCheck';

afterEach(() => clearStartTimeCache());

describe('processStartTime', () => {
  it('Windows：powershell.exe -NoProfile -NonInteractive、Get-Process 取 UTC 的 o 格式、逾時 10 秒', () => {
    const calls: { file: string; args: string[]; timeout: number }[] = [];
    const run: RunCommand = (file, args, timeout) => {
      calls.push({ file, args, timeout });
      return '2026-11-12T01:02:03.4567890Z\r\n';
    };
    const at = processStartTime(4242, { platform: 'win32', run });
    expect(at?.toISOString()).toBe('2026-11-12T01:02:03.456Z');
    expect(calls).toEqual([
      {
        file: 'powershell.exe',
        args: windowsStartTimeArgs(4242),
        timeout: WINDOWS_QUERY_TIMEOUT_MS,
      },
    ]);
    expect(WINDOWS_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive']);
    expect(calls[0]!.args[3]).toContain('Get-Process -Id 4242');
    expect(calls[0]!.args[3]).toContain("ToUniversalTime().ToString('o')");
  });

  it('只認含時區的 ISO 8601：地區格式、沒有時區、空的一律讀不到', () => {
    expect(parseWindowsStartTime('2026-11-12T09:02:03.1234567+08:00')?.toISOString()).toBe(
      '2026-11-12T01:02:03.123Z',
    );
    expect(parseWindowsStartTime('2026-11-12T01:02:03')).toBeNull();
    expect(parseWindowsStartTime('11/12/2026 1:02:03 AM')).toBeNull();
    expect(parseWindowsStartTime('2026/11/12 上午 01:02:03')).toBeNull();
    expect(parseWindowsStartTime('')).toBeNull();
  });

  it('指令失敗、逾時、格式不對：讀不到（agentStillRunning 當成還在）', () => {
    const throwing: RunCommand = () => {
      throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
    };
    expect(processStartTime(process.pid, { platform: 'win32', run: throwing })).toBeNull();
    expect(
      processStartTime(process.pid, { platform: 'win32', run: () => 'Get-Process : 找不到' }),
    ).toBeNull();
    // pid 是自己（一定在）、讀不到啟動時間 → 當成還在。
    expect(
      agentStillRunning(process.pid, new Date(0).toISOString(), {
        platform: 'win32',
        run: throwing,
      }),
    ).toBe(true);
  });

  it('讀到的值快取 60 秒；讀不到的不快取', () => {
    let count = 0;
    const run: RunCommand = () => {
      count += 1;
      return '2026-11-12T01:02:03.0000000Z';
    };
    const now = 1_000_000;
    processStartTime(77, { platform: 'win32', run, now });
    processStartTime(77, { platform: 'win32', run, now: now + START_TIME_CACHE_MS - 1 });
    expect(count).toBe(1);
    processStartTime(77, { platform: 'win32', run, now: now + START_TIME_CACHE_MS });
    expect(count).toBe(2);
    let failures = 0;
    const failing: RunCommand = () => {
      failures += 1;
      throw new Error('x');
    };
    processStartTime(78, { platform: 'win32', run: failing, now });
    processStartTime(78, { platform: 'win32', run: failing, now });
    expect(failures).toBe(2);
    expect(START_TIME_CACHE_MS).toBe(60_000);
  });

  it('這個平台真的讀得到自己的啟動時間，而且和 uptime 推算的差不到 15 秒（Windows CI 跑真的 PowerShell）', () => {
    const at = processStartTime(process.pid);
    expect(at).toBeInstanceOf(Date);
    const expected = Date.now() - process.uptime() * 1000;
    expect(Math.abs(at!.getTime() - expected)).toBeLessThan(15_000);
    expect(agentStillRunning(process.pid, at!.toISOString())).toBe(true);
    expect(agentStillRunning(process.pid, new Date(at!.getTime() - 3_600_000).toISOString())).toBe(
      false,
    );
  }, 20_000);
});
