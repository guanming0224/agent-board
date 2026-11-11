// 上一個 agent 還活著嗎（S1：重開前檢查，避免同一個對話有兩個 agent）。
// pid 可能被別的程序重用，所以再比對啟動時間：Mac／Linux 用 `ps -o pid=,lstart= -p a,b,c`；
// Windows 用 PowerShell 的 Get-Process 取 UTC 的 `o` 格式（N2）。只讀程序資訊，不送訊號以外的東西。
// **非同步、一次查完**（審查 W1）：Windows 開一次 PowerShell 要好幾秒，daemon 重啟時對每個 pid 各同步跑一次會卡住
// event loop 數十秒（hook 等不到 auth.proof、hub 心跳停）。所以全部 pid 合成一次查詢、用 execFile 不阻塞。
// 安裝程式的 busySessions 用同一套規則（scripts/lib/process-start.mjs）。
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

/** 快照記的啟動時間和讀到的差多少以內算同一個程序（ps 只到秒，spawn 也有延遲）。 */
const START_TOLERANCE_MS = 15_000;
/** Windows 開 PowerShell 很慢（冷啟動可能好幾秒）：上限 10 秒，逾時當成讀不到（＝當成還在）。 */
export const WINDOWS_QUERY_TIMEOUT_MS = 10_000;
/** 讀到的值快取 60 秒。 */
export const START_TIME_CACHE_MS = 60_000;
/** 只認含時區的 ISO 8601（`o` 格式：`2026-11-12T01:02:03.4567890Z` 或 `+08:00`）。地區格式的日期一律不信。 */
export const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 執行外部指令（測試換成假的）：成功回 stdout；失敗、逾時丟例外。 */
export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRun: RunCommand = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (error, stdout) => {
        // ps 對不在的 pid 回非 0，但在的那幾個照樣印出來：有輸出就用。
        if (error && !stdout) reject(error);
        else resolve(String(stdout ?? ''));
      },
    );
  });

/** Windows 的 PowerShell：用絕對路徑（不靠 PATH，別人放在 PATH 前面的同名程式不會被執行）。 */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(
    env.SystemRoot || env.windir || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

const cache = new Map<number, { at: number; value: Date }>();

/** 只給測試：清掉快取。 */
export function clearStartTimeCache(): void {
  cache.clear();
}

/** Windows 的查詢指令：一次查全部 pid，每行 `<pid> <UTC o 格式>`；不在的 pid 不印。 */
export function windowsStartTimeArgs(pids: readonly number[]): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToUniversalTime().ToString('o') }`,
  ];
}

/** PowerShell 一行的時間 → Date；不是含時區的 ISO 8601 就回 null。 */
export function parseWindowsStartTime(text: string): Date | null {
  const value = text.trim();
  if (!ISO_WITH_ZONE.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** `<pid> <時間>` 一行一個 → Map。認不得的行略過。 */
function parseLines(text: string, parse: (rest: string) => Date | null): Map<number, Date> {
  const found = new Map<number, Date>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const at = parse(match[2]!);
    if (at) found.set(Number(match[1]), at);
  }
  return found;
}

const parseLstart = (text: string): Date | null => {
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
};

export interface StartTimeOptions {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  now?: number;
}

/**
 * 一次讀多個程序的啟動時間（只開一個子程序）。讀不到的 pid（不在、指令失敗或逾時、格式不對）不在結果裡。
 * 只快取讀到的值。
 */
export async function processStartTimes(
  pids: readonly number[],
  { platform = process.platform, run = defaultRun, now = Date.now() }: StartTimeOptions = {},
): Promise<Map<number, Date>> {
  const result = new Map<number, Date>();
  const missing: number[] = [];
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cached = cache.get(pid);
    if (cached && now - cached.at < START_TIME_CACHE_MS) result.set(pid, cached.value);
    else missing.push(pid);
  }
  if (missing.length === 0) return result;
  let found = new Map<number, Date>();
  try {
    if (platform === 'win32') {
      const out = await run(
        windowsPowerShell(),
        windowsStartTimeArgs(missing),
        WINDOWS_QUERY_TIMEOUT_MS,
      );
      found = parseLines(out, parseWindowsStartTime);
    } else {
      const out = await run('ps', ['-o', 'pid=,lstart=', '-p', missing.join(',')], 5_000);
      found = parseLines(out, parseLstart);
    }
  } catch {
    // 讀不到：呼叫端當成還在。
  }
  for (const [pid, at] of found) {
    if (!missing.includes(pid)) continue;
    cache.set(pid, { at: now, value: at });
    result.set(pid, at);
  }
  return result;
}

/** 單一程序的啟動時間；讀不到回 null。 */
export async function processStartTime(
  pid: number,
  options: StartTimeOptions = {},
): Promise<Date | null> {
  return (await processStartTimes([pid], options)).get(pid) ?? null;
}

export interface AgentRecord {
  pid: number | null;
  startedAt: string | null;
}

/** pid 在不在（signal 0）。ESRCH：不在。EPERM：程序在但不是這個使用者的，pid 已被別人重用。 */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一批快照記的 agent（pid＋啟動時間）各自是否還在跑，結果順序同輸入。只對還在、有記啟動時間的 pid 開一次查詢。
 * 不確定時當成還在（寧可不重開，也不要兩個 agent）：pid 在但讀不到啟動時間、或沒有記啟動時間。
 */
export async function agentsStillRunning(
  records: readonly AgentRecord[],
  options: StartTimeOptions = {},
): Promise<boolean[]> {
  const exists = records.map((r) => r.pid !== null && r.pid > 0 && pidExists(r.pid));
  const toCheck = records
    .filter((r, i) => exists[i] && r.startedAt !== null)
    .map((r) => r.pid as number);
  const times = toCheck.length > 0 ? await processStartTimes(toCheck, options) : new Map();
  return records.map((r, i) => {
    if (!exists[i]) return false;
    if (r.startedAt === null) return true;
    const actual = times.get(r.pid as number);
    if (!actual) return true;
    return Math.abs(actual.getTime() - new Date(r.startedAt).getTime()) <= START_TOLERANCE_MS;
  });
}

export async function agentStillRunning(
  pid: number | null,
  startedAt: string | null,
  options: StartTimeOptions = {},
): Promise<boolean> {
  return (await agentsStillRunning([{ pid, startedAt }], options))[0]!;
}
