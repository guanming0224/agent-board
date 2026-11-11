// corepack pnpm test:install（連同 service-templates、updater 的測試）
// 系統 Node（CONTRACTS §21.10，2026-11-11 GM 改回不自帶 Node）：
//   - 服務設定用安裝時找到的系統 node 路徑（PATH 上的那支，不 realpath；TCC 照實際執行的路徑認）
//   - 0.1.1 自帶的 runtime 不當系統 node；session host 資料夾裡的殘留在沒人用時清掉
//   - 從 Mac mini 的現況（0.1.1 自帶 node＋host plist 手動改成系統 node）升級：不重啟 host
//   - launchd 的語意（bootout 非同步）：換 host 之後一定重新載入（2026-11-11 事故的回歸測試）
//   - hook 包裝：用 AGENT_BOARD_NODE，找不到 node 或 .cjs 就 exit 2
// 全部在臨時資料夾：HOME、launchctl（假的，照真的 launchd 語意、照 plist 真的把程式跑起來）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  hookWrapperSh,
  modulesPlatformManifest,
  isBundledRuntime,
  minNodeFromEngines,
  nodeMajor,
  versionAtLeast,
} from './lib/node-runtime.mjs';
import { fakeHostCode } from './test-support/fake-host.mjs';
import {
  installFakeLaunchctl,
  isLoaded,
  runningPid,
  stopAll,
} from './test-support/fake-launchctl.mjs';

const repo = join(import.meta.dirname, '..');
const LABELS = ['com.agent-board.hub', 'com.agent-board.daemon', 'com.agent-board.session-host'];
const HOST = 'com.agent-board.session-host';

const FAKE_DAEMON = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
const write = () => writeFileSync(join(process.env.AGENT_BOARD_DATA_DIR, 'daemon-status.json'),
  JSON.stringify({ pid: process.pid, version: manifest.version, buildId: 'x', startedAt: new Date().toISOString(), connectedAt: new Date().toISOString() }));
setTimeout(write, 300);
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;
// 真的 session host 收到 SIGTERM 要 2 秒才結束（先結束 agent）：假的也拖一下，launchd 收 job 才會是非同步的。
const FAKE_HOST = fakeHostCode({ termDelayMs: 800 });

let base;
let home;
let data;
let root;
let launchd;
let env;
let nodeLink;

/** 假發布檔：真的安裝程式、更新程式、服務模板；假的 daemon、session host。 */
function makeRelease(version, { protocol = 1, hostCode = FAKE_HOST } = {}) {
  const dir = join(base, `src-${version}-${protocol}`, 'agent-board');
  rmSync(dirname(dir), { recursive: true, force: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const file of ['installer.mjs', 'updater.mjs']) {
    cpSync(join(repo, 'scripts', file), join(dir, 'scripts', file));
  }
  cpSync(join(repo, 'scripts/lib'), join(dir, 'scripts/lib'), { recursive: true });
  cpSync(join(repo, 'deploy/launchd'), join(dir, 'deploy/launchd'), { recursive: true });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  write(
    'package.json',
    JSON.stringify({ name: 'agent-board-release', version, engines: { node: '>=22.18' } }),
  );
  write('BUILD_ID', `build-${version}-${protocol}\n`);
  write('hub/dist/main.mjs', '');
  write('daemon/dist/index.mjs', FAKE_DAEMON);
  write('daemon/dist/agent-board-mcp.mjs', '');
  write('daemon/node_modules/.bin/agent-board-hook', '#!/bin/sh\nexit 0\n');
  write('session-host/dist/main.mjs', hostCode);
  write('session-host/dist/meta.json', JSON.stringify({ protocol }));
  write(
    'node_modules/node-pty/package.json',
    JSON.stringify({ name: 'node-pty', version: '1.0.0' }),
  );
  write(
    '.node-modules-platform',
    JSON.stringify({ platform: 'darwin-arm64', node: '24.0.0', modules: '137', napi: true }),
  );
  return dir;
}

function installer(args, { node = process.execPath, extraEnv = {} } = {}) {
  const result = spawnSync(node, [join(repo, 'scripts/installer.mjs'), ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
function mustInstall(args, options) {
  const result = installer(args, options);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

const state = () => JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
const plistFile = (label) => join(home, `Library/LaunchAgents/${label}.plist`);
const plist = (role) => readFileSync(plistFile(`com.agent-board.${role}`), 'utf8');
const programOf = (role) =>
  /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist(role))[1];
const envOf = (role, key) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist(role))?.[1] ?? null;
const hostPid = () => runningPid(launchd, HOST);

/** 把 plist 的執行檔換掉（Lead 在 Mac mini 手動改 host plist 那樣）。 */
function setProgram(role, node) {
  const file = plistFile(`com.agent-board.${role}`);
  const text = readFileSync(file, 'utf8').replace(
    /(<key>ProgramArguments<\/key>\s*<array>\s*<string>)[^<]*(<\/string>)/,
    `$1${node}$2`,
  );
  writeFileSync(file, text);
}
const launchctl = (...args) =>
  spawnSync(join(home, 'stubs', 'launchctl'), args, { encoding: 'utf8' });

function freshHome() {
  if (launchd) stopAll(launchd, LABELS);
  home = join(base, `home-${Math.random().toString(36).slice(2, 8)}`);
  data = join(home, '.agent-board');
  root = join(home, '.local/share/agent-board');
  const stubs = join(home, 'stubs');
  launchd = join(home, 'launchd');
  mkdirSync(home, { recursive: true });
  installFakeLaunchctl(stubs, launchd);
  const fakeClaude = join(home, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\n');
  chmodSync(fakeClaude, 0o755);
  env = {
    HOME: home,
    // nodeLink 是指向系統 node 的 symlink（像 Homebrew 的 /opt/homebrew/bin/node）：服務要寫它，不是 realpath。
    PATH: [stubs, dirname(nodeLink), '/usr/bin', '/bin'].join(':'),
    TMPDIR: tmpdir(),
    LANG: 'zh_TW.UTF-8',
    AGENT_BOARD_INSTALL_TEST_SKIP_NATIVE: '1',
    AGENT_BOARD_DATA_DIR: data,
    AGENT_BOARD_CLAUDE_BIN: fakeClaude,
  };
}

async function waitFor(what, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

before(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'ab-system-node-test-'));
  nodeLink = join(base, 'node-bin', 'node');
  mkdirSync(dirname(nodeLink));
  symlinkSync(realpathSync(process.execPath), nodeLink);
});
after(() => {
  if (launchd) stopAll(launchd, LABELS);
  rmSync(base, { recursive: true, force: true });
});

describe('共用判斷', () => {
  test('最低版本、主版本、比較；自帶 runtime 的路徑', () => {
    assert.equal(minNodeFromEngines('>=22.18'), '22.18');
    assert.equal(minNodeFromEngines(undefined), '22');
    assert.equal(nodeMajor('v26.1.0'), 26);
    assert.equal(nodeMajor('x'), null);
    assert.equal(versionAtLeast('26.0.0', '22.18'), true);
    assert.equal(versionAtLeast('22.17.9', '22.18'), false);
    assert.equal(versionAtLeast('22.18.0', '22.18'), true);
    assert.equal(isBundledRuntime('/x/releases/0.1.1/runtime/node/bin/node'), true);
    assert.equal(isBundledRuntime('C:\\x\\runtime\\node\\node.exe'), true);
    assert.equal(isBundledRuntime('/usr/local/bin/node'), false);
  });

  test('hook 包裝：用 AGENT_BOARD_NODE；不能用就退 PATH；node 或 .cjs 都找不到就 stderr＋exit 2（擋下）', () => {
    const dir = join(base, 'hook-layout', 'agent-board');
    const bin = join(dir, 'daemon/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'daemon/dist'), { recursive: true });
    const wrapper = join(bin, 'agent-board-hook');
    writeFileSync(wrapper, hookWrapperSh());
    chmodSync(wrapper, 0o755);
    const hook = join(dir, 'daemon/dist/agent-board-hook.cjs');
    writeFileSync(hook, "console.log('hook ran ' + process.argv[2]);\n");
    const noNode = { PATH: '/usr/bin:/bin' };
    const viaEnv = spawnSync(wrapper, ['Stop'], {
      env: { ...noNode, AGENT_BOARD_NODE: nodeLink },
      encoding: 'utf8',
    });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(viaEnv.stdout.trim(), 'hook ran Stop');
    // 0.1.1 的 session 帶著已經不存在的自帶 node 路徑：退回 PATH 上的 node。
    const stale = spawnSync(wrapper, ['Stop'], {
      env: { PATH: `${dirname(nodeLink)}:/usr/bin:/bin`, AGENT_BOARD_NODE: '/gone/runtime/node' },
      encoding: 'utf8',
    });
    assert.equal(stale.status, 0, stale.stderr);
    const missingNode = spawnSync(wrapper, ['Stop'], {
      env: { ...noNode, AGENT_BOARD_NODE: '/gone/node' },
      encoding: 'utf8',
    });
    assert.equal(missingNode.status, 2);
    assert.match(missingNode.stderr, /擋下/);
    rmSync(hook);
    const missingHook = spawnSync(wrapper, ['Stop'], {
      env: { ...noNode, AGENT_BOARD_NODE: nodeLink },
      encoding: 'utf8',
    });
    assert.equal(missingHook.status, 2);
    assert.match(missingHook.stderr, /agent-board-hook/);
  });
});

describe('安裝程式用系統 node', () => {
  test('三個服務、捷徑、AGENT_BOARD_NODE 都是 PATH 上那支 node 的路徑（不 realpath）', () => {
    freshHome();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2'), '--no-start']);
    for (const role of ['daemon', 'session-host']) assert.equal(programOf(role), nodeLink);
    assert.equal(envOf('daemon', 'AGENT_BOARD_NODE'), nodeLink);
    assert.equal(state().systemNode, nodeLink);
    assert.equal(state().sessionHostNode, 'system');
    assert.match(
      readFileSync(join(home, '.local/bin/agent-board-daemon'), 'utf8'),
      new RegExp(nodeLink.replaceAll('/', '\\/')),
    );
  });

  test('用 0.1.1 自帶的 runtime 跑安裝程式（0.1.1 的 daemon 啟動的更新）：不把它當系統 node（W2）', () => {
    freshHome();
    const runtime = join(base, 'old-release', 'agent-board', 'runtime', 'node', 'bin', 'node');
    mkdirSync(dirname(runtime), { recursive: true });
    copyFileSync(realpathSync(process.execPath), runtime, constants.COPYFILE_FICLONE);
    chmodSync(runtime, 0o755);
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2'), '--no-start'], {
      node: runtime,
    });
    assert.equal(programOf('daemon'), nodeLink);
    assert.equal(state().systemNode, nodeLink);
  });

  test('系統 node 太舊：中止，什麼都不改', () => {
    freshHome();
    const source = makeRelease('0.1.2');
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ ...manifest, engines: { node: '>=99' } }),
    );
    const result = installer(['install', 'daemon', '--source', source, '--no-start']);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /需要 Node\.js 99 以上/);
    assert.ok(!existsSync(join(root, 'current')));
  });
});

describe('launchd 與 session host', () => {
  test('協定變了換 host：bootout 是非同步的，安裝程式要等卸載完再重新載入（2026-11-11 事故回歸）', async () => {
    freshHome();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2')]);
    const host0 = await waitFor('session host 起來', () => hostPid());
    const output = mustInstall([
      'install',
      'daemon',
      '--source',
      makeRelease('0.1.3', { protocol: 2 }),
    ]);
    const host1 = await waitFor('新的 session host 起來', () => {
      const pid = hostPid();
      return pid && pid !== host0 ? pid : null;
    });
    assert.ok(host1);
    assert.ok(isLoaded(launchd, HOST), `host 要是載入的：\n${output}`);
    assert.equal(state().sessionHostProtocol, 2);
    // daemon 也重新載入了。
    assert.ok(isLoaded(launchd, 'com.agent-board.daemon'));
  });

  test('host 不理 SIGTERM（超過 launchd 預設的 20 秒）：靠 plist 的 ExitTimeOut 15 秒被收掉，安裝程式等得到並重新載入（S1）', async () => {
    freshHome();
    mustInstall([
      'install',
      'daemon',
      '--source',
      makeRelease('0.1.2', { hostCode: fakeHostCode({ ignoreTerm: true }) }),
    ]);
    assert.match(plist('session-host'), /<key>ExitTimeOut<\/key>\s*<integer>15<\/integer>/);
    const host0 = await waitFor('session host 起來', () => hostPid());
    const started = Date.now();
    const output = mustInstall([
      'install',
      'daemon',
      '--source',
      makeRelease('0.1.3', { protocol: 2 }),
    ]);
    assert.ok(Date.now() - started >= 14_000, '要等到 ExitTimeOut 收掉舊的 host');
    const host1 = hostPid();
    assert.ok(host1 && host1 !== host0, `新的 host 在跑：\n${output}`);
    assert.ok(isLoaded(launchd, HOST));
  });

  test('安裝程式結束碼：換了 host 卻沒起來（socket 沒開）就非 0', () => {
    freshHome();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2')]);
    const result = installer([
      'install',
      'daemon',
      '--source',
      makeRelease('0.1.3', { protocol: 2, hostCode: 'setInterval(() => {}, 1000);' }),
    ]);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /socket 連不上/);
    assert.match(result.output, /這些服務沒有起來：com\.agent-board\.session-host/);
  });

  test('假 launchctl 照真的語意：bootstrap 已載入的回 5、kickstart 沒載入的回 113、bootout 不等程式結束', async () => {
    freshHome();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2')]);
    await waitFor('session host 起來', () => hostPid());
    assert.equal(launchctl('bootstrap', 'gui/501', plistFile(HOST)).status, 5);
    assert.match(launchctl('print', `gui/501/${HOST}`).stdout, /pid = \d+/);
    assert.equal(launchctl('bootout', `gui/501/${HOST}`).status, 0);
    // 剛 bootout：程式還沒結束，job 還算載入中；再 bootout 一次回 36。
    assert.equal(launchctl('print', `gui/501/${HOST}`).status, 0);
    assert.equal(launchctl('bootout', `gui/501/${HOST}`).status, 36);
    await waitFor('卸載完', () => launchctl('print', `gui/501/${HOST}`).status === 113);
    assert.equal(launchctl('kickstart', `gui/501/${HOST}`).status, 113);
    assert.equal(launchctl('bootout', `gui/501/${HOST}`).status, 3);
  });

  test('Mac mini 的現況（0.1.1 自帶 node、host plist 手動改成系統 node）升到 0.1.2：不重啟 host，清掉沒人用的 runtime', async () => {
    freshHome();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.1')]);
    const host0 = await waitFor('session host 起來', () => hostPid());
    // 0.1.1 留下的：install.json 記 bundled、host 資料夾有 runtime/、hub／daemon 用 current/runtime。
    const s = state();
    writeFileSync(
      join(root, 'install.json'),
      JSON.stringify({ ...s, sessionHostNode: 'bundled:24.22.2', bundledNode: '24.22.2' }),
    );
    const leftover = join(root, 'session-host', 'runtime', 'node', 'bin', 'node');
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(leftover, '#!/bin/sh\n');
    chmodSync(leftover, 0o755);
    setProgram('daemon', join(root, 'current', 'runtime', 'node', 'bin', 'node'));
    const output = mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2')]);
    assert.equal(hostPid(), host0, 'session host 沒重啟（agent 不中斷）');
    for (const role of ['daemon', 'session-host']) assert.equal(programOf(role), nodeLink);
    assert.ok(!existsSync(join(root, 'session-host', 'runtime')), output);
    assert.equal(state().sessionHostNode, 'system');
  });

  test('host 還在用自己資料夾的 runtime 跑：改設定、不重啟、不刪它正在用的檔案', async () => {
    freshHome();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.1')]);
    await waitFor('session host 起來', () => hostPid());
    // 讓 host 從 session-host/runtime/node/bin/node（真的 node 的 clone）跑，像 0.1.1 剛裝好那樣。
    const runtime = join(root, 'session-host', 'runtime', 'node', 'bin', 'node');
    mkdirSync(dirname(runtime), { recursive: true });
    copyFileSync(realpathSync(process.execPath), runtime, constants.COPYFILE_FICLONE);
    chmodSync(runtime, 0o755);
    setProgram('session-host', runtime);
    launchctl('bootout', `gui/501/${HOST}`);
    await waitFor('卸載', () => !isLoaded(launchd, HOST));
    launchctl('bootstrap', 'gui/501', plistFile(HOST));
    const host0 = await waitFor('host 從 runtime 跑', () => hostPid());
    const output = mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2')]);
    assert.equal(hostPid(), host0, 'session host 沒重啟');
    assert.equal(programOf('session-host'), nodeLink, '下次重啟改用系統 node');
    assert.ok(existsSync(runtime), '還在用的 runtime 不刪');
    assert.match(output, /重新載入（重開機或 --restart-session-host）時生效/);
    assert.match(output, /先留著/);
    // 程式結束了（例如當掉），但 launchd 載入的設定還是 runtime 那支（KeepAlive／kickstart 用載入當下的設定）：照樣不刪。
    process.kill(host0, 'SIGKILL');
    await waitFor('host 結束', () => !hostPid());
    assert.match(
      launchctl('print', `gui/501/${HOST}`).stdout,
      /program = .*runtime\/node\/bin\/node/,
    );
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2')]);
    assert.ok(existsSync(runtime), 'launchd 載入的設定還指著它，不刪');
    // kickstart 用的是載入當下的快照（runtime），不是改過的 plist。
    assert.equal(launchctl('kickstart', `gui/501/${HOST}`).status, 0);
    const restarted = await waitFor('kickstart 之後', () => hostPid());
    const args = spawnSync('ps', ['-o', 'args=', '-p', String(restarted)], { encoding: 'utf8' });
    assert.match(args.stdout, /runtime\/node\/bin\/node/);
  });
});

describe('舊 hub 看 0.1.2 的成品（W1）', () => {
  test('.node-modules-platform 把建置的 ABI 記成 buildModules：0.1.0／0.1.1 的 hub 讀不到 modules，不會對 Node 26 回 abi_mismatch', () => {
    const manifest = modulesPlatformManifest({
      platform: 'darwin-arm64',
      node: '24.17.0',
      buildModules: '137',
      engines: '>=22.18',
    });
    assert.equal(manifest.modules, undefined);
    assert.equal(manifest.buildModules, '137');
    assert.equal(manifest.minNode, '22.18');
    // 0.1.0 hub 的 bundledAbi()：讀 modules 字串；resolveTarget：entry.abi && record.nodeAbi && 不同 → abi_mismatch。
    const oldHubAbi = typeof manifest.modules === 'string' ? manifest.modules : null;
    const blocks010 = (nodeAbi) => Boolean(oldHubAbi && nodeAbi && oldHubAbi !== nodeAbi);
    // 0.1.1 hub 另外看 bundledNode（0.1.2 沒有）。
    const blocks011 = (nodeAbi) => !manifest.bundledNode && blocks010(nodeAbi);
    for (const abi of ['147', '137', '127']) {
      assert.equal(blocks010(abi), false, `0.1.0 hub 對 ABI ${abi}`);
      assert.equal(blocks011(abi), false, `0.1.1 hub 對 ABI ${abi}`);
    }
  });
});
