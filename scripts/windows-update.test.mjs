// corepack pnpm test:install（Mac／Linux：假 schtasks）；Windows CI 的 windows job（真的工作排程器）。
// Windows 的自動更新流程（CONTRACTS §21.3、§21.7）：真的安裝程式、更新程式、服務模板（task-*.xml、run-*.cmd），
// 假的 daemon 與 session host（幾行的小程式）。
//   Mac／Linux：安裝程式設 AGENT_BOARD_INSTALL_PLATFORM=win32，PATH 上放假的 schtasks
//   （scripts/test-support/fake-schtasks.mjs：照 task-*.xml／run-*.cmd 真的把程式跑起來，/End 只結束工作排程器自己
//   啟動的根程序、cmd 底下的 node 還活著；也跑「連子程序一起結束」的另一種可能）。
//   Windows：真的 schtasks、conhost、cmd、junction。會建立、刪掉目前使用者的 AgentBoard-session-host／AgentBoard-daemon
//   排程工作，所以只在設了 AGENT_BOARD_TEST_REAL_SCHTASKS=1 時跑（CI 才設；**不要在裝了 Agent Board 的機器上設**）。
// 重現 2026-11-15／16 Windows 筆電 0.1.7→0.1.12 五次都 health_timeout：舊 daemon 停不掉、拿著 daemon.lock，
// 新 daemon 一啟動就因為「已有 daemon 在用這份資料夾」結束；回滾的舊版也一樣起不來（rollback_failed）。
// 假 daemon 和真的一樣先拿 daemon.lock（活著的 pid 拿著就結束），而且和真的一樣由 daemon 以 detached 啟動更新程式
// （更新程式是 daemon 的子孫：停 daemon 時不能連它一起收掉）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { listProcesses, serviceProcessIds, stopProcesses } from './lib/service-processes.mjs';
import { installFakeSchtasks, rootPid, stopAllTasks } from './test-support/fake-schtasks.mjs';

const repo = join(import.meta.dirname, '..');
const TASKS = ['AgentBoard-session-host', 'AgentBoard-daemon'];
/** 在真的 Windows 上跑（真的工作排程器）。 */
const real = process.platform === 'win32';
const skip =
  real && process.env.AGENT_BOARD_TEST_REAL_SCHTASKS !== '1'
    ? '會動到目前使用者的排程工作：只在 CI（AGENT_BOARD_TEST_REAL_SCHTASKS=1）跑'
    : false;

/**
 * 假 daemon：和真的一樣先拿 daemon.lock（packages/daemon/src/daemonLock.ts：活著的 pid 拿著就丟錯、結束碼 1），
 * 300ms 後寫 daemon-status.json（已連上 hub）。看到 fake-update-request.json 就照真的 spawnDetached 啟動更新程式。
 */
const FAKE_DAEMON = `
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
if (manifest.fakeBroken) { console.error('broken build'); process.exit(1); }
const data = process.env.AGENT_BOARD_DATA_DIR;
const lock = join(data, 'daemon.lock');
try {
  const held = JSON.parse(readFileSync(lock, 'utf8'));
  if (held.pid !== process.pid) {
    let alive = false;
    try { process.kill(held.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    if (alive) {
      console.error('已有 daemon（pid ' + held.pid + '）在使用 ' + data + '，不再啟動第二個');
      process.exit(1);
    }
  }
} catch {}
writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
const startedAt = new Date().toISOString();
setTimeout(() => writeFileSync(join(data, 'daemon-status.json'), JSON.stringify({
  pid: process.pid, version: manifest.version, buildId: 'x', startedAt, connectedAt: new Date().toISOString(),
})), 300);
const request = join(data, 'fake-update-request.json');
setInterval(() => {
  if (!existsSync(request)) return;
  const { node, script, args, cwd, env } = JSON.parse(readFileSync(request, 'utf8'));
  rmSync(request, { force: true });
  const out = openSync(join(data, 'logs', 'updater.log'), 'a');
  const child = spawn(node, [script, ...args], { cwd, detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env }, windowsHide: true });
  child.unref();
  writeFileSync(join(data, 'fake-updater.pid'), String(child.pid));
}, 100);
process.on('SIGTERM', () => process.exit(0));
`;

/**
 * 假 session host：一啟動就把自己的 pid 寫進 session-host.token（Windows 的安裝程式只看 token 有沒有更新），
 * 之後一直活著。
 */
const FAKE_HOST = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.env.AGENT_BOARD_DATA_DIR, { recursive: true });
writeFileSync(join(process.env.AGENT_BOARD_DATA_DIR, 'session-host.token'), String(process.pid));
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

let base;
let home;
let data;
let root;
let stubs;
let tasks;
let env;

function makeRelease(version, { broken = false, hostProtocol = 2 } = {}) {
  const dir = join(base, `src-${version}${broken ? '-broken' : ''}-${hostProtocol}`, 'agent-board');
  rmSync(dirname(dir), { recursive: true, force: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const file of ['installer.mjs', 'updater.mjs']) {
    cpSync(join(repo, 'scripts', file), join(dir, 'scripts', file));
  }
  cpSync(join(repo, 'scripts/lib'), join(dir, 'scripts/lib'), { recursive: true });
  cpSync(join(repo, 'deploy/windows'), join(dir, 'deploy/windows'), { recursive: true });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  write(
    'package.json',
    JSON.stringify({ name: 'agent-board-release', version, fakeBroken: broken }),
  );
  write('BUILD_ID', `build-${version}-${broken ? 'broken' : 'ok'}-${hostProtocol}\n`);
  write('daemon/dist/index.mjs', FAKE_DAEMON);
  write('daemon/dist/agent-board-mcp.mjs', '');
  write('daemon/node_modules/.bin/agent-board-hook', '#!/bin/sh\nexit 0\n');
  write('daemon/node_modules/.bin/agent-board-hook.cmd', '@exit /b 0\r\n');
  write('session-host/dist/main.mjs', FAKE_HOST);
  write('session-host/dist/meta.json', JSON.stringify({ protocol: hostProtocol }));
  write(
    'node_modules/node-pty/package.json',
    JSON.stringify({ name: 'node-pty', version: '1.0.0' }),
  );
  return dir;
}

function freshHome(endMode = 'root') {
  cleanup();
  home = join(base, `home-${Math.random().toString(36).slice(2, 8)}`);
  data = join(home, '.agent-board');
  root = join(home, 'AppData', 'Local', 'agent-board');
  stubs = join(home, 'stubs');
  tasks = join(home, 'tasks');
  mkdirSync(home, { recursive: true });
  if (!real) installFakeSchtasks(stubs, tasks, { endMode });
  const fakeClaude = join(home, 'claude.cmd');
  writeFileSync(fakeClaude, '@exit /b 0\r\n');
  // 已配對（安裝程式才會確認 daemon 有在跑）。
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'machine.json'), JSON.stringify({ machineId: 'm1' }));
  const overlay = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    AGENT_BOARD_INSTALL_TEST_SKIP_NATIVE: '1',
    AGENT_BOARD_DATA_DIR: data,
    AGENT_BOARD_CLAUDE_BIN: fakeClaude,
  };
  env = real
    ? { ...process.env, ...overlay }
    : {
        ...overlay,
        PATH: [stubs, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        TMPDIR: tmpdir(),
        LANG: 'zh_TW.UTF-8',
        AGENT_BOARD_INSTALL_PLATFORM: 'win32',
      };
}

/**
 * 停掉這次測試開的所有服務程序。假 schtasks：照它記的 pid；真的 Windows：解除安裝（安裝程式會停服務、刪排程工作），
 * 再把指令列含這次安裝資料夾的 node 都結束（修好前的版本留下的舊 daemon）。
 */
function cleanup() {
  if (!home) return;
  if (!real) {
    stopAllTasks(tasks, TASKS);
    return;
  }
  installer(['uninstall']);
  for (const task of TASKS) {
    spawnSync('schtasks', ['/Delete', '/TN', task, '/F'], { stdio: 'ignore' });
  }
  const list = listProcesses() ?? [];
  stopProcesses(serviceProcessIds(list, root));
}

function installer(args) {
  const result = spawnSync(process.execPath, [join(repo, 'scripts/installer.mjs'), ...args], {
    env,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function poll(what, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const daemonStatus = () => readJson(join(data, 'daemon-status.json'));
const updateState = () => readJson(join(data, 'update-state.json'));
const currentTarget = () => basename(realpathSync(join(root, 'current')));
/** session host 的 pid（假 host 把 pid 寫在 token 裡；程序不在了回 null）。 */
const hostPid = () => {
  const pid = readJson(join(data, 'session-host.token'));
  return pid > 0 && alive(pid) ? pid : null;
};

async function installRunning(version = '0.1.7') {
  const result = installer(['install', 'daemon', '--source', makeRelease(version)]);
  assert.equal(result.status, 0, result.output);
  await poll('daemon 起來', () => daemonStatus()?.version === version);
  assert.ok(hostPid(), 'session host 在跑');
  if (real) {
    // 確定走的是排程工作（不是建不了工作時退回的「啟動資料夾」）。
    for (const task of TASKS) {
      assert.equal(spawnSync('schtasks', ['/Query', '/TN', task]).status, 0, `${task} 已登記`);
    }
  }
  return daemonStatus().pid;
}

/** daemon 下載解壓後的位置（.incoming/<版本>/agent-board）。 */
function incoming(version, options) {
  const dest = join(root, 'releases', '.incoming', version);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(dirname(makeRelease(version, options)), dest, { recursive: true });
  return join(dest, 'agent-board');
}

/** 像 daemon（selfUpdate.ts）那樣：由正在跑的 daemon 以 detached 啟動更新程式，等它結束。 */
async function updateViaDaemon(args, timeoutMs = 40_000) {
  rmSync(join(data, 'fake-updater.pid'), { force: true });
  rmSync(join(data, 'update-state.json'), { force: true });
  const script = args[0];
  // 真的 Windows 上，工作排程器開的 daemon 拿的是使用者的環境（LOCALAPPDATA 等指向真的位置）：
  // 把這次測試的環境帶給更新程式（daemon 照樣用它自己的環境啟動，這裡多帶的只有測試用的資料夾）。
  writeFileSync(
    join(data, 'fake-update-request.json'),
    JSON.stringify({ node: process.execPath, script, args: args.slice(1), cwd: root, env }),
  );
  const pid = await poll('daemon 啟動更新程式', () => readJson(join(data, 'fake-updater.pid')));
  await poll('更新程式結束', () => !alive(pid), timeoutMs);
  return { state: updateState(), log: readFileSync(join(data, 'logs', 'updater.log'), 'utf8') };
}

const updateArgs = (source, to, from, timeoutMs = 4000) => [
  join(source, 'scripts', 'updater.mjs'),
  'update',
  '--source',
  source,
  '--to',
  to,
  '--from',
  from,
  '--data',
  data,
  '--root',
  root,
  '--health-timeout-ms',
  String(timeoutMs),
];

before(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'ab-windows-update-test-'));
});
after(() => {
  cleanup();
  if (!process.env.KEEP_TEST_DIR) rmSync(base, { recursive: true, force: true });
});

describe('Windows 自動更新（假 schtasks）', { skip }, () => {
  test('/End 只結束根程序時：舊 daemon 被確實停掉，新版通過健康檢查；更新程式沒被收掉；session host 不重啟', async () => {
    freshHome('root');
    const oldDaemon = await installRunning('0.1.7');
    const host = hostPid();
    const started = Date.now();
    const { state, log } = await updateViaDaemon(updateArgs(incoming('0.1.12'), '0.1.12', '0.1.7'));
    assert.equal(state?.phase, 'succeeded', `${JSON.stringify(state)}\n${log}`);
    assert.ok(Date.now() - started < 30_000);
    assert.equal(currentTarget(), '0.1.12');
    assert.equal(daemonStatus().version, '0.1.12');
    assert.ok(!alive(oldDaemon), '舊 daemon 要停掉（不然拿著 daemon.lock）');
    assert.ok(alive(daemonStatus().pid), '新 daemon 在跑');
    assert.equal(hostPid(), host, 'session host 沒重啟');
    if (!real)
      assert.ok(rootPid(tasks, 'AgentBoard-daemon'), '工作排程器看得到新 daemon 的工作在跑');
  });

  test(
    '/End 連子程序一起結束時（另一種可能）一樣成功',
    { skip: real && '真的 Windows 只有一種行為' },
    async () => {
      freshHome('tree');
      const oldDaemon = await installRunning('0.1.7');
      const { state, log } = await updateViaDaemon(
        updateArgs(incoming('0.1.12'), '0.1.12', '0.1.7'),
      );
      assert.equal(state?.phase, 'succeeded', `${JSON.stringify(state)}\n${log}`);
      assert.ok(!alive(oldDaemon));
      assert.equal(daemonStatus().version, '0.1.12');
    },
  );

  test('壞版（新 daemon 起不來）：時限內回滾，舊版重新起來、沒有殘留的新版程序', async () => {
    freshHome('root');
    await installRunning('0.1.7');
    const started = Date.now();
    const { state, log } = await updateViaDaemon(
      updateArgs(incoming('0.1.13', { broken: true }), '0.1.13', '0.1.7', 3000),
    );
    assert.equal(state?.phase, 'rolled_back', `${JSON.stringify(state)}\n${log}`);
    assert.ok(['install_failed', 'health_timeout'].includes(state.reason), state.reason);
    assert.ok(Date.now() - started < 30_000);
    assert.equal(currentTarget(), '0.1.7');
    await poll(
      '舊版 daemon 回來',
      () => daemonStatus()?.version === '0.1.7' && alive(daemonStatus().pid),
    );
  });

  test('手動回滾（面板「回滾到上一版」）：切回上一版並通過健康檢查', async () => {
    freshHome('root');
    await installRunning('0.1.7');
    let result = await updateViaDaemon(updateArgs(incoming('0.1.12'), '0.1.12', '0.1.7'));
    assert.equal(result.state?.phase, 'succeeded', result.log);
    const newDaemon = daemonStatus().pid;
    result = await updateViaDaemon([
      join(root, 'current', 'scripts', 'updater.mjs'),
      'rollback',
      '--data',
      data,
      '--root',
      root,
      '--health-timeout-ms',
      '4000',
    ]);
    assert.equal(
      result.state?.phase,
      'succeeded',
      `${JSON.stringify(result.state)}\n${result.log}`,
    );
    assert.equal(result.state.reason, 'rollback_requested');
    assert.equal(currentTarget(), '0.1.7');
    assert.equal(daemonStatus().version, '0.1.7');
    assert.ok(!alive(newDaemon));
  });

  test('換 session host（協定變了）：舊 host 確實停掉才換資料夾，新 host 起來', async () => {
    freshHome('root');
    await installRunning('0.1.7');
    const oldHost = hostPid();
    const { state, log } = await updateViaDaemon(
      updateArgs(incoming('0.1.12', { hostProtocol: 3 }), '0.1.12', '0.1.7'),
    );
    assert.equal(state?.phase, 'succeeded', `${JSON.stringify(state)}\n${log}`);
    assert.ok(!alive(oldHost), '舊 session host 要停掉');
    assert.ok(hostPid() && hostPid() !== oldHost, '新 session host 在跑');
  });

  test('解除安裝：服務的 node 程序都停掉', async () => {
    freshHome('root');
    const daemon = await installRunning('0.1.7');
    const host = hostPid();
    const result = installer(['uninstall']);
    assert.equal(result.status, 0, result.output);
    await poll('daemon 與 host 都停了', () => !alive(daemon) && !alive(host), 15_000);
    assert.ok(!existsSync(root));
  });
});
