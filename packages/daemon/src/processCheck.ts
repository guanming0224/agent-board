// 上一個 agent 還活著嗎（S1：重開前檢查，避免同一個對話有兩個 agent）。
// pid 可能被別的程序重用，所以再比對啟動時間（`ps -o lstart=`）。只讀程序資訊，不送訊號以外的東西。
import { execFileSync } from 'node:child_process';

/** 快照記的啟動時間和 ps 讀到的差多少以內算同一個程序（ps 只到秒，spawn 也有延遲）。 */
const START_TOLERANCE_MS = 15_000;

/** 程序的啟動時間；讀不到（Windows、程序不在、ps 失敗）回 null。 */
export function processStartTime(pid: number): Date | null {
  if (process.platform === 'win32' || !(pid > 0)) return null;
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim();
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/**
 * 快照記的 agent（pid＋啟動時間）是否還在跑。不確定時當成還在（寧可不重開，也不要兩個 agent）：
 * pid 在但讀不到啟動時間、或沒有記啟動時間。
 */
export function agentStillRunning(pid: number | null, startedAt: string | null): boolean {
  if (pid === null || !(pid > 0)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH：不在了。EPERM：程序在但不是這個使用者的，pid 已被別人重用。
    return false;
  }
  if (startedAt === null) return true;
  const actual = processStartTime(pid);
  if (actual === null) return true;
  return Math.abs(actual.getTime() - new Date(startedAt).getTime()) <= START_TOLERANCE_MS;
}
