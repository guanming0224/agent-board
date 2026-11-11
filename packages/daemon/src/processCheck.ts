// 上一個 agent 還活著嗎（S1：重開前檢查，避免同一個對話有兩個 agent）。
// pid 可能被別的程序重用，所以再比對啟動時間：Mac／Linux 用 `ps -o lstart=`；
// Windows 用 `powershell.exe -NoProfile -NonInteractive` 跑 Get-Process 取 UTC 的 `o` 格式（N2）。
// 只讀程序資訊，不送訊號以外的東西。安裝程式的 busySessions 用同一套規則（scripts/lib/process-start.mjs）。
import { execFileSync } from 'node:child_process';

/** 快照記的啟動時間和讀到的差多少以內算同一個程序（ps 只到秒，spawn 也有延遲）。 */
const START_TOLERANCE_MS = 15_000;
/** Windows 開 PowerShell 很慢（冷啟動可能好幾秒）：上限 10 秒，逾時當成讀不到（＝當成還在）。 */
export const WINDOWS_QUERY_TIMEOUT_MS = 10_000;
/** 讀到的值快取 60 秒（daemon 啟動時會對每個 session 問一次，Windows 每次都開 PowerShell 太慢）。 */
export const START_TIME_CACHE_MS = 60_000;
/** 只認含時區的 ISO 8601（`o` 格式：`2026-11-12T01:02:03.4567890Z` 或 `+08:00`）。地區格式的日期一律不信。 */
export const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 執行外部指令（測試換成假的）。 */
export type RunCommand = (file: string, args: string[], timeoutMs: number) => string;

const defaultRun: RunCommand = (file, args, timeoutMs) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });

const cache = new Map<number, { at: number; value: Date }>();

/** 只給測試：清掉快取。 */
export function clearStartTimeCache(): void {
  cache.clear();
}

/** Windows 的查詢指令（`o` 格式一律含時區；先轉 UTC）。 */
export function windowsStartTimeArgs(pid: number): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  ];
}

/** PowerShell 的輸出 → 時間；不是含時區的 ISO 8601 就回 null。 */
export function parseWindowsStartTime(text: string): Date | null {
  const value = text.trim();
  if (!ISO_WITH_ZONE.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** 程序的啟動時間；讀不到（程序不在、指令失敗或逾時、格式不對）回 null。 */
export function processStartTime(
  pid: number,
  {
    platform = process.platform,
    run = defaultRun,
    now = Date.now(),
  }: { platform?: NodeJS.Platform; run?: RunCommand; now?: number } = {},
): Date | null {
  if (!(pid > 0) || !Number.isInteger(pid)) return null;
  const cached = cache.get(pid);
  if (cached && now - cached.at < START_TIME_CACHE_MS) return cached.value;
  let value: Date | null = null;
  try {
    if (platform === 'win32') {
      value = parseWindowsStartTime(
        run('powershell.exe', windowsStartTimeArgs(pid), WINDOWS_QUERY_TIMEOUT_MS),
      );
    } else {
      const text = run('ps', ['-o', 'lstart=', String(pid)], 2_000).trim();
      const at = new Date(text);
      value = text && !Number.isNaN(at.getTime()) ? at : null;
    }
  } catch {
    value = null;
  }
  // 只快取讀到的值：讀不到的下次再問。
  if (value) cache.set(pid, { at: now, value });
  return value;
}

/**
 * 快照記的 agent（pid＋啟動時間）是否還在跑。不確定時當成還在（寧可不重開，也不要兩個 agent）：
 * pid 在但讀不到啟動時間、或沒有記啟動時間。
 */
export function agentStillRunning(
  pid: number | null,
  startedAt: string | null,
  options: Parameters<typeof processStartTime>[1] = {},
): boolean {
  if (pid === null || !(pid > 0)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH：不在了。EPERM：程序在但不是這個使用者的，pid 已被別人重用。
    return false;
  }
  if (startedAt === null) return true;
  const actual = processStartTime(pid, options);
  if (actual === null) return true;
  return Math.abs(actual.getTime() - new Date(startedAt).getTime()) <= START_TOLERANCE_MS;
}
