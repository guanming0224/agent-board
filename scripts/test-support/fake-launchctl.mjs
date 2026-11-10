// 測試用的假 launchctl：真的照 plist 把程式跑起來（不經過系統的 launchd，不碰這台機器的服務）。
// 用法：PATH 上放一支 sh 包裝 `exec node fake-launchctl.mjs <狀態資料夾> "$@"`（見 installFakeLaunchctl）。
//   print gui/<uid>/<label>        在跑回 0，沒有回 113（同 launchd 的「找不到服務」）
//   bootstrap gui/<uid> <plist>    照 plist（ProgramArguments、EnvironmentVariables、WorkingDirectory、
//                                  StandardOutPath）在新的 process group 啟動
//   bootout gui/<uid>/<label>      對整個 process group 送 SIGTERM，3 秒後 SIGKILL（同 launchd 停服務）
//   kickstart [-k] gui/<uid>/<label>
//   enable …                       不做事
// 每次呼叫記一行到 <狀態資料夾>/calls.log。KeepAlive 不模擬（程式掛了不會自動重啟）。
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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

/** 某個 label 現在跑的 pid（沒有回 null）。 */
export function runningPid(stateDir, label) {
  try {
    const pid = Number(readFileSync(join(stateDir, `${label}.pid`), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** 測試結束：停掉所有假服務。 */
export function stopAll(stateDir, labels) {
  for (const label of labels) bootout(stateDir, label);
}

function bootout(stateDir, label) {
  const pid = runningPid(stateDir, label);
  rmSync(join(stateDir, `${label}.pid`), { force: true });
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // 已經不在
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 已經不在
  }
}

function bootstrap(stateDir, plistPath) {
  const plist = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }),
  );
  const label = plist.Label;
  if (runningPid(stateDir, label)) return 37; // 已載入
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
  writeFileSync(join(stateDir, `${label}.pid`), String(child.pid));
  writeFileSync(join(stateDir, `${label}.plist`), plistPath);
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  const [stateDir, command, ...rest] = process.argv.slice(2);
  appendFileSync(join(stateDir, 'calls.log'), `${[command, ...rest].join(' ')}\n`);
  const labelOf = (target) => target.split('/').at(-1);
  let code = 0;
  if (command === 'print') {
    code = runningPid(stateDir, labelOf(rest[0])) ? 0 : 113;
  } else if (command === 'bootstrap') {
    code = bootstrap(stateDir, rest[1]);
  } else if (command === 'bootout') {
    bootout(stateDir, labelOf(rest[0]));
  } else if (command === 'kickstart') {
    const kill = rest[0] === '-k';
    const label = labelOf(rest.at(-1));
    const plistFile = join(stateDir, `${label}.plist`);
    if (kill) bootout(stateDir, label);
    if (!runningPid(stateDir, label) && existsSync(plistFile)) {
      code = bootstrap(stateDir, readFileSync(plistFile, 'utf8'));
    }
  }
  process.exit(code);
}
