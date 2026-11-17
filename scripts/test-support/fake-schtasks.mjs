// 測試用的假 schtasks（Windows 工作排程器）：在 Mac／Linux 上照安裝程式寫的 task-<角色>.xml 與 run-<角色>.cmd
// 真的把程式跑起來（不碰這台機器的服務）。用法：PATH 上放一支 sh 包裝 `exec node fake-schtasks.mjs <狀態資料夾> "$@"`
// （見 installFakeSchtasks），安裝程式設 AGENT_BOARD_INSTALL_PLATFORM=win32。
// 照真的工作排程器與實機紀錄模擬（2026-11-15／16 Windows 筆電 0.1.7→0.1.12 五次更新都 health_timeout）：
//   - 工作的動作是 `conhost.exe --headless cmd.exe /c run-<角色>.cmd`，cmd 再開 node。工作排程器只認它自己啟動的
//     那個程序（這裡的「根程序」＝一支小 node 包裝，代表 conhost＋cmd）；node 是根程序的子程序。
//   - /End 只結束根程序，**不收子程序**：node 照樣活著（END_MODE=root，預設；實機推論見 CONTRACTS §21.7）。
//     END_MODE=tree 時連子程序一起結束（另一種可能，測試兩種都要過）。
//   - MultipleInstancesPolicy=IgnoreNew：根程序還活著時 /Run 什麼都不做，照樣回 0（真的 schtasks 也印 SUCCESS）。
//   - RestartOnFailure 不模擬。
//   /Create /TN <名稱> /XML <檔> /F   登記（讀 UTF-16 的 XML，取出 run-*.cmd 的路徑）
//   /Query /TN <名稱>                 登記了回 0，否則 1
//   /Run /TN <名稱>                   沒登記回 1；根程序還活著不做事；否則照 run-*.cmd 啟動
//   /End /TN <名稱>                   結束根程序（END_MODE=tree 時整個 process group）
//   /Delete /TN <名稱> /F             取消登記
// 每次呼叫記一行到 <狀態資料夾>/calls.log。
import { spawn } from 'node:child_process';
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

export function installFakeSchtasks(binDir, stateDir, { endMode = 'root' } = {}) {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'end-mode'), endMode);
  const wrapper = join(binDir, 'schtasks');
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

const taskFile = (stateDir, name) => join(stateDir, `${name}.task`);
const rootPidFile = (stateDir, name) => join(stateDir, `${name}.root`);
const childPidFile = (stateDir, name) => join(stateDir, `${name}.child`);

const readPid = (path) => {
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    return pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
};

/** 根程序（工作排程器認得的那個）還活著就回 pid。 */
export const rootPid = (stateDir, name) => readPid(rootPidFile(stateDir, name));
/** 最近一次 /Run 開出來的 node（子程序）還活著就回 pid。 */
export const childPid = (stateDir, name) => readPid(childPidFile(stateDir, name));

/** run-<角色>.cmd（模板 deploy/windows/run-service.cmd.template）→ { env, cwd, node, entry, log }。 */
export function parseRunCmd(text) {
  const env = {};
  let cwd = null;
  let command = null;
  const unpercent = (value) => value.replaceAll('%%', '%');
  for (const line of text.split(/\r?\n/)) {
    let match = /^set "([^=]+)=(.*)"$/.exec(line);
    if (match) {
      env[match[1]] = unpercent(match[2]);
      continue;
    }
    match = /^cd \/d "(.*)"$/.exec(line);
    if (match) {
      cwd = unpercent(match[1]);
      continue;
    }
    match = /^"(.*)" "(.*)" >> "(.*)" 2>&1$/.exec(line);
    if (match)
      command = { node: unpercent(match[1]), entry: unpercent(match[2]), log: unpercent(match[3]) };
  }
  if (!command) throw new Error('run-*.cmd 裡找不到啟動指令');
  return { env, cwd, ...command };
}

/** 根程序：開 node（子程序，同一個 process group）、記 pid、等它結束後照它的結束碼結束（像 cmd /c）。 */
const ROOT_CODE = `
const { spawn } = require('node:child_process');
const { appendFileSync, openSync, writeFileSync } = require('node:fs');
const spec = JSON.parse(process.argv[1]);
const out = openSync(spec.log, 'a');
const child = spawn(spec.node, [spec.entry], { cwd: spec.cwd, env: spec.env, stdio: ['ignore', out, out] });
writeFileSync(spec.childPidFile, String(child.pid));
appendFileSync(spec.childPidFile + 's', child.pid + '\\n');
child.on('exit', (code) => process.exit(code ?? 1));
`;

function run(stateDir, name) {
  if (!existsSync(taskFile(stateDir, name))) {
    process.stderr.write(`ERROR: The system cannot find the file specified.\n`);
    return 1;
  }
  // IgnoreNew：還在跑（根程序活著）就不開新的。
  if (rootPid(stateDir, name)) {
    process.stdout.write(`SUCCESS: Attempted to run the scheduled task "${name}".\n`);
    return 0;
  }
  const runCmd = readFileSync(taskFile(stateDir, name), 'utf8');
  const spec = parseRunCmd(readFileSync(runCmd, 'utf8'));
  mkdirSync(dirname(spec.log), { recursive: true });
  const root = spawn(
    process.execPath,
    [
      '-e',
      ROOT_CODE,
      JSON.stringify({
        ...spec,
        env: { ...process.env, ...spec.env },
        childPidFile: childPidFile(stateDir, name),
      }),
    ],
    {
      detached: true,
      stdio: ['ignore', 'ignore', openSync(join(stateDir, `${name}.root.log`), 'a')],
    },
  );
  root.unref();
  writeFileSync(rootPidFile(stateDir, name), String(root.pid));
  process.stdout.write(`SUCCESS: Attempted to run the scheduled task "${name}".\n`);
  return 0;
}

function end(stateDir, name) {
  const pid = rootPid(stateDir, name);
  if (!pid) {
    process.stderr.write(`ERROR: The task is not running.\n`);
    return 1;
  }
  const mode = readFileSync(join(stateDir, 'end-mode'), 'utf8').trim();
  try {
    // 根程序用 detached 開，是自己 process group 的組長：tree 模式對整組送。
    process.kill(mode === 'tree' ? -pid : pid, 'SIGKILL');
  } catch {
    // 已經不在
  }
  process.stdout.write(`SUCCESS: The scheduled task "${name}" has been terminated successfully.\n`);
  return 0;
}

/** 測試結束：把所有假工作的根程序與（每一次 /Run 開過的）子程序都停掉。 */
export function stopAllTasks(stateDir, names) {
  for (const name of names) {
    let children = [];
    try {
      children = readFileSync(`${childPidFile(stateDir, name)}s`, 'utf8')
        .split('\n')
        .map(Number);
    } catch {
      // 沒開過
    }
    for (const pid of [rootPid(stateDir, name), ...children]) {
      if (!(pid > 0) || !alive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已經不在
      }
    }
    rmSync(rootPidFile(stateDir, name), { force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const [stateDir, command, ...rest] = process.argv.slice(2);
  appendFileSync(join(stateDir, 'calls.log'), `${[command, ...rest].join(' ')}\n`);
  const arg = (flag) => rest[rest.indexOf(flag) + 1];
  const name = arg('/TN');
  let code = 0;
  if (command === '/Create') {
    const xml = readFileSync(arg('/XML')).toString('utf16le');
    const match = /cmd\.exe \/c &quot;(.*?)&quot;/.exec(xml) ?? /cmd\.exe \/c "(.*?)"/.exec(xml);
    if (!match) {
      process.stderr.write('ERROR: bad task XML\n');
      code = 1;
    } else {
      writeFileSync(taskFile(stateDir, name), match[1].replaceAll('&amp;', '&'));
    }
  } else if (command === '/Query') {
    code = existsSync(taskFile(stateDir, name)) ? 0 : 1;
  } else if (command === '/Run') {
    code = run(stateDir, name);
  } else if (command === '/End') {
    code = end(stateDir, name);
  } else if (command === '/Delete') {
    rmSync(taskFile(stateDir, name), { force: true });
  } else {
    code = 1;
  }
  process.exit(code);
}
