// 測試用的假 launchctl：真的照 plist 把程式跑起來（不經過系統的 launchd，不碰這台機器的服務）。
// 用法：PATH 上放一支 sh 包裝 `exec node fake-launchctl.mjs <狀態資料夾> "$@"`（見 installFakeLaunchctl）。
// 照真的 launchd 的語意（2026-11-11 上架 0.1.1 時，舊的假程式和真的不一樣，沒抓到 session host 沒重新載入）：
//   - 「載入（loaded）」和「在跑」是兩件事：bootstrap 載入 job 並啟動程式；程式結束了 job 仍是載入的
//     （KeepAlive 不模擬，不會自動重啟），print 照樣回 0。
//   print gui/<uid>/<label>        載入中回 0，沒載入回 113（「Could not find service」）
//   bootstrap gui/<uid> <plist>    沒載入：載入並照 plist（ProgramArguments、EnvironmentVariables、WorkingDirectory、
//                                  StandardOutPath）在新的 process group 啟動。已載入（含 bootout 還沒收完）：
//                                  失敗，回 5「Bootstrap failed: 5: Input/output error」
//   bootout gui/<uid>/<label>      沒載入：回 3。載入中：對整個 process group 送 SIGTERM（3 秒後 SIGKILL）就回來，
//                                  **不等它結束**——程式還沒結束、或 bootout 後不到 UNLOAD_LAG_MS，job 都還算載入中
//                                  （真的 launchd 收 job 是非同步的）
//   kickstart [-k] gui/<uid>/<label>  沒載入：失敗，回 113。載入中：沒在跑就啟動；-k 先殺掉再啟動
//   enable …                       不做事
// 每次呼叫記一行到 <狀態資料夾>/calls.log。
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** bootout 之後 job 至少還算載入中這麼久（真的 launchd 要等程式結束才收掉 job）。 */
const UNLOAD_LAG_MS = 1_000;

export function installFakeLaunchctl(binDir, stateDir) {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const wrapper = join(binDir, 'launchctl');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.filename)} ${JSON.stringify(stateDir)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidFile = (stateDir, label) => join(stateDir, `${label}.pid`);
const loadedFile = (stateDir, label) => join(stateDir, `${label}.plist`);
const unloadingFile = (stateDir, label) => join(stateDir, `${label}.unloading`);

/** 某個 label 現在跑的 pid（沒有回 null）。 */
export function runningPid(stateDir, label) {
  try {
    const pid = Number(readFileSync(pidFile(stateDir, label), 'utf8'));
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** job 是不是載入中（bootout 還沒收完也算）。收完了就把狀態清掉。 */
export function isLoaded(stateDir, label) {
  if (!existsSync(loadedFile(stateDir, label))) return false;
  const unloading = unloadingFile(stateDir, label);
  if (!existsSync(unloading)) return true;
  const since = statSync(unloading).mtimeMs;
  if (runningPid(stateDir, label) || Date.now() - since < UNLOAD_LAG_MS) return true;
  for (const file of [unloading, loadedFile(stateDir, label), pidFile(stateDir, label)]) {
    rmSync(file, { force: true });
  }
  return false;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // 已經不在
  }
}

/** 測試結束：同步停掉並卸載所有假服務。 */
export function stopAll(stateDir, labels) {
  for (const label of labels) {
    const pid = runningPid(stateDir, label);
    if (pid) {
      signalGroup(pid, 'SIGTERM');
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && alive(pid)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      signalGroup(pid, 'SIGKILL');
    }
    for (const file of [
      unloadingFile(stateDir, label),
      loadedFile(stateDir, label),
      pidFile(stateDir, label),
    ]) {
      rmSync(file, { force: true });
    }
  }
}

/** 照 plist 啟動程式（新的 process group）。 */
function launch(stateDir, label, plistPath) {
  const plist = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }),
  );
  const [program, ...args] = plist.ProgramArguments;
  const log = plist.StandardOutPath ?? '/dev/null';
  if (log !== '/dev/null') mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, 'a');
  const child = spawn(program, args, {
    cwd: plist.WorkingDirectory,
    env: plist.EnvironmentVariables,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(pidFile(stateDir, label), String(child.pid));
}

function bootstrap(stateDir, plistPath) {
  const plist = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }),
  );
  const label = plist.Label;
  if (isLoaded(stateDir, label)) {
    process.stderr.write('Bootstrap failed: 5: Input/output error\n');
    return 5;
  }
  writeFileSync(loadedFile(stateDir, label), plistPath);
  launch(stateDir, label, plistPath);
  return 0;
}

/** bootout：送 SIGTERM 就回來（不等程式結束）；背景的小程序 3 秒後補 SIGKILL。 */
function bootout(stateDir, label) {
  if (!isLoaded(stateDir, label)) {
    process.stderr.write(`Boot-out failed: 3: No such process\n`);
    return 3;
  }
  if (existsSync(unloadingFile(stateDir, label))) return 0;
  writeFileSync(unloadingFile(stateDir, label), '');
  const pid = runningPid(stateDir, label);
  if (pid) {
    signalGroup(pid, 'SIGTERM');
    const killer = spawn(
      process.execPath,
      ['-e', `setTimeout(() => { try { process.kill(-${pid}, 'SIGKILL'); } catch {} }, 3000);`],
      { detached: true, stdio: 'ignore' },
    );
    killer.unref();
  }
  return 0;
}

function kickstart(stateDir, rest) {
  const kill = rest[0] === '-k';
  const label = rest.at(-1).split('/').at(-1);
  if (!isLoaded(stateDir, label) || existsSync(unloadingFile(stateDir, label))) {
    process.stderr.write(`Could not find service "${label}" in domain for user gui\n`);
    return 113;
  }
  const pid = runningPid(stateDir, label);
  if (pid && !kill) return 0;
  if (pid) {
    signalGroup(pid, 'SIGTERM');
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && alive(pid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    signalGroup(pid, 'SIGKILL');
  }
  launch(stateDir, label, readFileSync(loadedFile(stateDir, label), 'utf8'));
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  const [stateDir, command, ...rest] = process.argv.slice(2);
  appendFileSync(join(stateDir, 'calls.log'), `${[command, ...rest].join(' ')}\n`);
  const labelOf = (target) => target.split('/').at(-1);
  let code = 0;
  if (command === 'print') {
    code = isLoaded(stateDir, labelOf(rest[0])) ? 0 : 113;
  } else if (command === 'bootstrap') {
    code = bootstrap(stateDir, rest[1]);
  } else if (command === 'bootout') {
    code = bootout(stateDir, labelOf(rest[0]));
  } else if (command === 'kickstart') {
    code = kickstart(stateDir, rest);
  }
  process.exit(code);
}
