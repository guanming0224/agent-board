// 找出並停掉某個服務的 node 程序（Windows 安裝程式用，CONTRACTS §21.7）。只用 node 內建模組。
// 為什麼要：工作排程器的工作動作是 `conhost.exe --headless cmd.exe /c run-<角色>.cmd`，`schtasks /End` 只結束
// 工作排程器自己啟動的那個程序，cmd 底下的 node 照樣活著（2026-11-15／16 Windows 筆電 0.1.7→0.1.12 五次自動更新
// 都 health_timeout：舊 daemon 停不掉、拿著 daemon.lock，新 daemon 一啟動就結束；回滾的舊版也一樣）。
// 所以 /End 之後照指令列找出還活著的服務程序（指令列含它的入口檔，例如 `…\current\daemon\dist\index.mjs`）並結束它。
// 程序清單：Windows 用絕對路徑的 powershell.exe 跑 Get-CimInstance Win32_Process（UTF-8 輸出，路徑可能有中文）；
// Mac／Linux（測試用 AGENT_BOARD_INSTALL_PLATFORM=win32 演練時）用 ps。看的是實際的作業系統（process.platform）。
import { spawnSync } from 'node:child_process';
import { windowsPowerShell, withoutPSModulePath } from './process-start.mjs';

export const LIST_TIMEOUT_MS = 20_000;

export const WINDOWS_LIST_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  // 不用雙引號（經過命令列跳脫容易壞）；[char]9 是 tab。
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.CommandLine }',
];

function defaultRun(file, args, timeoutMs) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: withoutPSModulePath(process.env),
  });
  return result.error || result.status !== 0 ? null : result.stdout;
}

/** `pid<tab>指令列` 或 ps 的 `  pid 指令列` 一行一筆 → [{ pid, command }]。 */
export function parseProcessList(text) {
  const list = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)[\t ](.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 0) list.push({ pid, command: match[2].trim() });
  }
  return list;
}

/** 這台機器的程序清單；查不了回 null。options：platform、run(file, args, timeoutMs) → stdout|null。 */
export function listProcesses(options = {}) {
  const { platform = process.platform, run = defaultRun } = options;
  const out =
    platform === 'win32'
      ? run(windowsPowerShell(), WINDOWS_LIST_ARGS, LIST_TIMEOUT_MS)
      : run('ps', ['-axww', '-o', 'pid=,args='], LIST_TIMEOUT_MS);
  return out === null ? null : parseProcessList(out);
}

/**
 * 指令列含 entry（服務的入口檔）的程序 pid，不含自己。Windows 的路徑不分大小寫、`/` 與 `\` 都可能出現。
 * 只認入口檔的完整路徑：cmd.exe、conhost.exe 的指令列是 run-*.cmd，更新程式與安裝程式的路徑也不同，不會被找到。
 */
export function serviceProcessIds(
  list,
  entry,
  { windows = process.platform === 'win32', self = process.pid } = {},
) {
  const norm = (text) => (windows ? text.replaceAll('/', '\\').toLowerCase() : text);
  const needle = norm(entry);
  return list
    .filter(({ pid, command }) => pid !== self && norm(command).includes(needle))
    .map(({ pid }) => pid);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 結束這些程序並等它們真的不在，最多 timeoutMs；回傳還活著的 pid（空陣列＝都停了）。
 * tree：連子程序一起（Windows 用 `taskkill /T /F`，session host 的 agent 跟著結束，同 Mac 停 host 的效果）。
 * 不用 tree 的時候只結束那一個程序（Windows 的 TerminateProcess）：daemon 的子孫裡有正在跑這支安裝程式的更新程式，
 * 不能一起收掉。
 */
export function stopProcesses(pids, options = {}) {
  const {
    tree = false,
    platform = process.platform,
    timeoutMs = 10_000,
    kill = (pid) => {
      if (platform === 'win32' && tree) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 15_000,
        });
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已經不在
      }
    },
    isAlive = alive,
  } = options;
  for (const pid of pids) if (isAlive(pid)) kill(pid);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = pids.filter(isAlive);
    if (left.length === 0 || Date.now() > deadline) return left;
    sleepMs(100);
  }
}
