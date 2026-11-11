// 快照記的 agent（pid＋啟動時間）是不是還在跑（N2）。和 daemon 的 packages/daemon/src/processCheck.ts 同一套規則：
// pid 在、而且啟動時間對得上（誤差 15 秒內）才算還在；讀不到啟動時間（指令失敗、逾時、格式不對）當成還在。
// Mac／Linux 用 `ps -o lstart=`；Windows 用 `powershell.exe -NoProfile -NonInteractive` 跑 Get-Process 取 UTC 的 `o` 格式，
// 逾時 10 秒、只認含時區的 ISO 8601。讀到的值快取 60 秒。只用 node 內建模組（安裝程式與更新程式用）。
import { spawnSync } from 'node:child_process';

export const START_TOLERANCE_MS = 15_000;
export const WINDOWS_QUERY_TIMEOUT_MS = 10_000;
export const START_TIME_CACHE_MS = 60_000;
export const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 預設的執行方式：成功回 stdout，失敗（非 0、逾時、找不到）回 null。 */
function defaultRun(file, args, timeoutMs) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

const cache = new Map();

export function clearStartTimeCache() {
  cache.clear();
}

export function windowsStartTimeArgs(pid) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  ];
}

export function parseWindowsStartTime(text) {
  const value = String(text ?? '').trim();
  if (!ISO_WITH_ZONE.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 啟動時間；讀不到回 null。options：platform、run(file, args, timeoutMs) → stdout|null、now。 */
export function processStartTime(pid, options = {}) {
  const { platform = process.platform, run = defaultRun, now = Date.now() } = options;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cached = cache.get(pid);
  if (cached && now - cached.at < START_TIME_CACHE_MS) return cached.value;
  let value = null;
  try {
    if (platform === 'win32') {
      const out = run('powershell.exe', windowsStartTimeArgs(pid), WINDOWS_QUERY_TIMEOUT_MS);
      value = out === null ? null : parseWindowsStartTime(out);
    } else {
      const text = (run('ps', ['-o', 'lstart=', String(pid)], 2_000) ?? '').trim();
      const at = new Date(text);
      value = text && !Number.isNaN(at.getTime()) ? at : null;
    }
  } catch {
    value = null;
  }
  if (value) cache.set(pid, { at: now, value });
  return value;
}

/** pid 在（signal 0）而且啟動時間對得上；不確定時當成還在。 */
export function agentStillRunning(pid, startedAt, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!startedAt) return true;
  const actual = processStartTime(pid, options);
  if (actual === null) return true;
  const expected = new Date(startedAt).getTime();
  if (Number.isNaN(expected)) return true;
  return Math.abs(actual.getTime() - expected) <= START_TOLERANCE_MS;
}
