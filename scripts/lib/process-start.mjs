// 快照記的 agent（pid＋啟動時間）是不是還在跑（N2）。和 daemon 的 packages/daemon/src/processCheck.ts 同一套規則：
// pid 在、而且啟動時間對得上（誤差 15 秒內）才算還在；讀不到啟動時間（指令失敗、逾時、格式不對）當成還在。
// 一次查完所有 pid（只開一個子程序）：Mac／Linux `ps -o pid=,lstart= -p a,b,c`；Windows 用絕對路徑的
// `powershell.exe -NoProfile -NonInteractive` 跑 Get-Process 取 UTC 的 `o` 格式，逾時 10 秒、只認含時區的 ISO 8601。
// 讀到的值快取 60 秒。安裝程式是一次性的同步腳本，這裡用 spawnSync（daemon 那邊是非同步的）。只用 node 內建模組。
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

export const START_TOLERANCE_MS = 15_000;
export const WINDOWS_QUERY_TIMEOUT_MS = 10_000;
export const START_TIME_CACHE_MS = 60_000;
export const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 預設的執行方式：回 stdout（ps 對不在的 pid 回非 0，但在的照樣印）；什麼都沒有回 null。 */
function defaultRun(file, args, timeoutMs) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  return result.error || !result.stdout ? null : result.stdout;
}

/** Windows 的 PowerShell 絕對路徑（不靠 PATH）。 */
export function windowsPowerShell(env = process.env) {
  return win32.join(
    env.SystemRoot || env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

const cache = new Map();

export function clearStartTimeCache() {
  cache.clear();
}

export function windowsStartTimeArgs(pids) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToUniversalTime().ToString('o') }`,
  ];
}

export function parseWindowsStartTime(text) {
  const value = String(text ?? '').trim();
  if (!ISO_WITH_ZONE.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function parseLines(text, parse) {
  const found = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const at = parse(match[2]);
    if (at) found.set(Number(match[1]), at);
  }
  return found;
}

const parseLstart = (text) => {
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
};

/** 一次讀多個程序的啟動時間；讀不到的不在結果裡。options：platform、run(file, args, timeoutMs) → stdout|null、now。 */
export function processStartTimes(pids, options = {}) {
  const { platform = process.platform, run = defaultRun, now = Date.now() } = options;
  const result = new Map();
  const missing = [];
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cached = cache.get(pid);
    if (cached && now - cached.at < START_TIME_CACHE_MS) result.set(pid, cached.value);
    else missing.push(pid);
  }
  if (missing.length === 0) return result;
  let found = new Map();
  try {
    if (platform === 'win32') {
      const out = run(windowsPowerShell(), windowsStartTimeArgs(missing), WINDOWS_QUERY_TIMEOUT_MS);
      found = out === null ? found : parseLines(out, parseWindowsStartTime);
    } else {
      const out = run('ps', ['-o', 'pid=,lstart=', '-p', missing.join(',')], 5_000);
      found = out === null ? found : parseLines(out, parseLstart);
    }
  } catch {
    // 讀不到：當成還在
  }
  for (const [pid, at] of found) {
    if (!missing.includes(pid)) continue;
    cache.set(pid, { at: now, value: at });
    result.set(pid, at);
  }
  return result;
}

export function processStartTime(pid, options = {}) {
  return processStartTimes([pid], options).get(pid) ?? null;
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 一批 {pid, startedAt} 各自是否還在跑（順序同輸入）；只開一次查詢。不確定時當成還在。 */
export function agentsStillRunning(records, options = {}) {
  const exists = records.map((r) => Number.isInteger(r.pid) && r.pid > 0 && pidExists(r.pid));
  const toCheck = records.filter((r, i) => exists[i] && r.startedAt).map((r) => r.pid);
  const times = toCheck.length > 0 ? processStartTimes(toCheck, options) : new Map();
  return records.map((r, i) => {
    if (!exists[i]) return false;
    if (!r.startedAt) return true;
    const actual = times.get(r.pid);
    if (!actual) return true;
    const expected = new Date(r.startedAt).getTime();
    if (Number.isNaN(expected)) return true;
    return Math.abs(actual.getTime() - expected) <= START_TOLERANCE_MS;
  });
}

export function agentStillRunning(pid, startedAt, options = {}) {
  return agentsStillRunning([{ pid, startedAt }], options)[0];
}
