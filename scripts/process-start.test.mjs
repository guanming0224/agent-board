// N2：安裝程式判斷 agent 還在不在（scripts/lib/process-start.mjs）。和 daemon 的 processCheck.ts 同一套規則。
// Windows CI 上最後一則跑真的 PowerShell。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import {
  agentStillRunning,
  clearStartTimeCache,
  ISO_WITH_ZONE,
  parseWindowsStartTime,
  processStartTime,
  START_TIME_CACHE_MS,
  START_TOLERANCE_MS,
  WINDOWS_QUERY_TIMEOUT_MS,
  windowsStartTimeArgs,
} from './lib/process-start.mjs';

afterEach(() => clearStartTimeCache());

describe('process-start', () => {
  it('Windows：powershell.exe -NoProfile -NonInteractive、Get-Process、UTC o 格式、逾時 10 秒', () => {
    const calls = [];
    const at = processStartTime(4242, {
      platform: 'win32',
      run: (file, args, timeout) => {
        calls.push({ file, args, timeout });
        return '2026-11-12T01:02:03.4567890Z\r\n';
      },
    });
    assert.equal(at.toISOString(), '2026-11-12T01:02:03.456Z');
    assert.deepEqual(calls, [
      { file: 'powershell.exe', args: windowsStartTimeArgs(4242), timeout: 10_000 },
    ]);
    assert.equal(WINDOWS_QUERY_TIMEOUT_MS, 10_000);
  });

  it('只認含時區的 ISO 8601', () => {
    assert.equal(
      parseWindowsStartTime('2026-11-12T09:02:03+08:00').toISOString(),
      '2026-11-12T01:02:03.000Z',
    );
    assert.equal(parseWindowsStartTime('11/12/2026 1:02:03 AM'), null);
    assert.equal(parseWindowsStartTime('2026-11-12T01:02:03'), null);
    assert.equal(parseWindowsStartTime(null), null);
  });

  it('失敗、逾時當成讀不到 → 還在；讀到的值快取 60 秒', () => {
    assert.equal(processStartTime(process.pid, { platform: 'win32', run: () => null }), null);
    assert.equal(
      agentStillRunning(process.pid, new Date(0).toISOString(), {
        platform: 'win32',
        run: () => null,
      }),
      true,
    );
    let count = 0;
    const run = () => {
      count += 1;
      return '2026-11-12T01:02:03Z';
    };
    processStartTime(9, { platform: 'win32', run, now: 0 });
    processStartTime(9, { platform: 'win32', run, now: START_TIME_CACHE_MS - 1 });
    assert.equal(count, 1);
    processStartTime(9, { platform: 'win32', run, now: START_TIME_CACHE_MS });
    assert.equal(count, 2);
  });

  it('pid 不在、沒有 pid：不算還在', () => {
    assert.equal(agentStillRunning(2 ** 22 + 12345, new Date().toISOString()), false);
    assert.equal(agentStillRunning(null, null), false);
    assert.equal(agentStillRunning(0, null), false);
  });

  it('和 daemon 的 processCheck.ts 用同樣的常數與指令', () => {
    const daemon = readFileSync(
      new URL('../packages/daemon/src/processCheck.ts', import.meta.url),
      'utf8',
    );
    assert.match(daemon, /START_TOLERANCE_MS = 15_000/);
    assert.equal(START_TOLERANCE_MS, 15_000);
    assert.match(daemon, /WINDOWS_QUERY_TIMEOUT_MS = 10_000/);
    assert.match(daemon, /START_TIME_CACHE_MS = 60_000/);
    assert.ok(daemon.includes(ISO_WITH_ZONE.source));
    assert.ok(daemon.includes("StartTime.ToUniversalTime().ToString('o')"));
  });

  it('這個平台真的讀得到自己的啟動時間（Windows CI 跑真的 PowerShell）', () => {
    const at = processStartTime(process.pid);
    assert.ok(at instanceof Date);
    assert.ok(Math.abs(at.getTime() - (Date.now() - process.uptime() * 1000)) < 15_000);
    assert.equal(agentStillRunning(process.pid, at.toISOString()), true);
    assert.equal(
      agentStillRunning(process.pid, new Date(at.getTime() - 3_600_000).toISOString()),
      false,
    );
  });
});
