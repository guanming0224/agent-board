// corepack pnpm test:install（連同 service-templates、updater 的測試）
// 發布檔自帶 Node（CONTRACTS §21.10）：manifest 判斷、安裝程式寫出的服務設定用自帶的 node、
// session host 換版判斷含 Node 版本（忙碌時 75 中止、--keep-session-host 先不換）、從沒自帶 Node 的舊版手動升級、
// 回滾到舊版時改回系統 node、更新程式用那一版的 node 跑。
// 全部在臨時資料夾：HOME、launchctl（假的，照 plist 真的把程式跑起來）都是假的，不碰這台機器的服務。
// 「自帶的 node」是一支 exec 系統 node 的 shell 腳本（只驗路徑與流程；真的官方 Node 由 build:release、
// smoke:release、e2e:update 驗）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
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
import { nodeAssetName, shasumOf } from './fetch-node.mjs';
import { bundledNodeOf, hostNodeId, runtimeNodePath } from './lib/bundled-node.mjs';
import { installFakeLaunchctl, runningPid, stopAll } from './test-support/fake-launchctl.mjs';

const repo = join(import.meta.dirname, '..');
const LABELS = ['com.agent-board.hub', 'com.agent-board.daemon', 'com.agent-board.session-host'];
const NODE_VERSION = '24.22.2';

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
const FAKE_HOST = `setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));`;

let base;
let home;
let data;
let root;
let launchd;
let env;

/** 假發布檔：真的安裝程式、更新程式、服務模板；bundled 時帶 runtime/node 與 .node-modules-platform。 */
function makeRelease(version, { bundled = null } = {}) {
  const dir = join(base, `src-${version}-${bundled ?? 'legacy'}`, 'agent-board');
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
  write('package.json', JSON.stringify({ name: 'agent-board-release', version }));
  write('BUILD_ID', `build-${version}-${bundled ?? 'legacy'}\n`);
  write('hub/dist/main.mjs', '');
  write('daemon/dist/index.mjs', FAKE_DAEMON);
  write('daemon/dist/agent-board-mcp.mjs', '');
  write('daemon/node_modules/.bin/agent-board-hook', '#!/bin/sh\nexit 0\n');
  write('session-host/dist/main.mjs', FAKE_HOST);
  write('session-host/dist/meta.json', JSON.stringify({ protocol: 1 }));
  write(
    'node_modules/node-pty/package.json',
    JSON.stringify({ name: 'node-pty', version: '1.0.0' }),
  );
  if (bundled) {
    write(
      '.node-modules-platform',
      JSON.stringify({
        platform: 'darwin-arm64',
        node: bundled,
        modules: '137',
        bundledNode: true,
      }),
    );
    // 「自帶的 node」：exec 系統 node，另外留個記號證明是經過它跑的。
    const node = runtimeNodePath(dir, 'darwin');
    write(
      'runtime/node/bin/node',
      `#!/bin/sh\nexport AB_TEST_BUNDLED_NODE=${bundled}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    chmodSync(node, 0o755);
  } else {
    write(
      '.node-modules-platform',
      JSON.stringify({ platform: 'darwin-arm64', node: '24.0.0', modules: '137' }),
    );
  }
  return dir;
}

function installer(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [join(repo, 'scripts/installer.mjs'), ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
function mustInstall(args, extraEnv) {
  const result = installer(args, extraEnv);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

const state = () => JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
const plist = (role) =>
  readFileSync(join(home, `Library/LaunchAgents/com.agent-board.${role}.plist`), 'utf8');
const programOf = (role) =>
  /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist(role))[1];
const envOf = (role, key) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist(role))?.[1] ?? null;
const hostPid = () => runningPid(launchd, 'com.agent-board.session-host');
const systemNodeOnPath = join(dirname(process.execPath), 'node');

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
    PATH: [stubs, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    TMPDIR: tmpdir(),
    LANG: 'zh_TW.UTF-8',
    AGENT_BOARD_INSTALL_TEST_SKIP_NATIVE: '1',
    AGENT_BOARD_DATA_DIR: data,
    AGENT_BOARD_CLAUDE_BIN: fakeClaude,
  };
}

/** 快照記著一個還在工作的 session（agent 是這個測試程序，活著）。 */
function markBusy() {
  mkdirSync(join(data, 'state'), { recursive: true });
  writeFileSync(
    join(data, 'state', 'busy.json'),
    JSON.stringify({ sessionId: 'busy', status: 'running', agentPid: process.pid }),
  );
}
const clearBusy = () => rmSync(join(data, 'state', 'busy.json'), { force: true });

async function waitFor(what, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

before(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'ab-bundled-node-test-'));
});
after(() => {
  if (launchd) stopAll(launchd, LABELS);
  rmSync(base, { recursive: true, force: true });
});

describe('manifest 與官方成品', () => {
  test('bundledNodeOf：只有 .node-modules-platform 記 bundledNode 而且執行檔在才算；hostNodeId', () => {
    const legacy = makeRelease('0.1.0');
    const bundled = makeRelease('0.1.1', { bundled: NODE_VERSION });
    assert.equal(bundledNodeOf(legacy, 'darwin'), null);
    assert.deepEqual(bundledNodeOf(bundled, 'darwin'), {
      path: join(bundled, 'runtime/node/bin/node'),
      version: NODE_VERSION,
      abi: '137',
    });
    // 記了 bundledNode 但執行檔不見：不算（不會寫出指向不存在的 node 的服務設定）。
    rmSync(join(bundled, 'runtime'), { recursive: true });
    assert.equal(bundledNodeOf(bundled, 'darwin'), null);
    assert.equal(hostNodeId(null), 'system');
    assert.equal(hostNodeId({ version: NODE_VERSION }), `bundled:${NODE_VERSION}`);
    assert.equal(runtimeNodePath('/x', 'win32').replaceAll('\\', '/'), '/x/runtime/node/node.exe');
  });

  test('官方成品檔名與 SHASUMS256.txt 解析', () => {
    assert.equal(nodeAssetName('24.22.2', 'darwin-arm64'), 'node-v24.22.2-darwin-arm64.tar.gz');
    assert.equal(nodeAssetName('24.22.2', 'win-x64'), 'node-v24.22.2-win-x64.zip');
    assert.throws(() => nodeAssetName('24.22.2', 'aix-ppc64'));
    const sums = [
      `${'a'.repeat(64)}  node-v24.22.2-darwin-arm64.tar.gz`,
      `${'b'.repeat(64)}  node-v24.22.2-darwin-arm64.tar.xz`,
      `${'c'.repeat(64)}  node-v24.22.2-win-x64.zip`,
    ].join('\n');
    assert.equal(shasumOf(sums, 'node-v24.22.2-darwin-arm64.tar.gz'), 'a'.repeat(64));
    assert.equal(shasumOf(sums, 'node-v24.22.2-win-x64.zip'), 'c'.repeat(64));
    assert.equal(shasumOf(sums, 'node-v24.22.2-linux-x64.tar.gz'), null);
  });

  test('package.json 的 bundledNode 是完整版本號', () => {
    const { bundledNode } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    assert.match(bundledNode, /^\d+\.\d+\.\d+$/);
  });
});

describe('安裝程式與自帶 Node', () => {
  test('全新安裝：hub、daemon 用 current/runtime/node，session host 用自己資料夾複製的那份；PATH 不放自帶的 node', () => {
    freshHome();
    mustInstall([
      'install',
      'daemon',
      '--source',
      makeRelease('0.1.1', { bundled: NODE_VERSION }),
      '--no-start',
    ]);
    const current = join(root, 'current');
    assert.equal(programOf('daemon'), join(current, 'runtime/node/bin/node'));
    assert.equal(programOf('session-host'), join(root, 'session-host/runtime/node/bin/node'));
    assert.ok(
      existsSync(join(root, 'session-host/runtime/node/bin/node')),
      'host 有自己的 runtime',
    );
    // MCP server 用自帶的 node（經過 current）；agent 的 PATH 最前面不是自帶的 node（使用者專案用自己的）。
    assert.equal(envOf('daemon', 'AGENT_BOARD_NODE'), join(current, 'runtime/node/bin/node'));
    assert.doesNotMatch(envOf('daemon', 'PATH'), /runtime\/node/);
    assert.doesNotMatch(envOf('session-host', 'PATH'), /runtime\/node/);
    const s = state();
    assert.equal(s.bundledNode, NODE_VERSION);
    assert.equal(s.sessionHostNode, `bundled:${NODE_VERSION}`);
    // 捷徑：hub／daemon 用自帶的 node；hook 是 exec 發布檔裡包裝的 shell 腳本（不是 symlink）。
    assert.match(
      readFileSync(join(home, '.local/bin/agent-board-daemon'), 'utf8'),
      /current\/runtime\/node\/bin\/node/,
    );
    const hookShim = join(home, '.local/bin/agent-board-hook');
    assert.ok(!lstatSync(hookShim).isSymbolicLink());
    assert.match(
      readFileSync(hookShim, 'utf8'),
      /exec '.*current\/daemon\/node_modules\/\.bin\/agent-board-hook'/,
    );
  });

  test('從沒自帶 Node 的舊版（0.1.0）手動升級：忙碌時 75 中止並提示 --keep-session-host；--keep-session-host 只換 hub／daemon；之後沒人工作時換 host', async () => {
    freshHome();
    // 0.1.0：服務用系統的 node，install.json 沒有 sessionHostNode。
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.0')]);
    assert.equal(programOf('daemon'), systemNodeOnPath);
    assert.equal(programOf('session-host'), systemNodeOnPath);
    const legacyState = state();
    delete legacyState.sessionHostNode;
    delete legacyState.sessionHostNodePath;
    delete legacyState.bundledNode;
    delete legacyState.systemNode;
    writeFileSync(join(root, 'install.json'), JSON.stringify(legacyState));
    const host0 = await waitFor('舊 session host 在跑', () => hostPid());

    // 有 session 在工作：要換 host（Node 從 system 變成 bundled），中止、什麼都不改。
    const next = makeRelease('0.1.1', { bundled: NODE_VERSION });
    markBusy();
    const busy = installer(['install', 'daemon', '--source', next]);
    assert.equal(busy.status, 75, busy.output);
    assert.match(busy.output, /Node 從 system 換成 bundled:24\.22\.2/);
    assert.match(busy.output, /--keep-session-host/);
    assert.equal(basename(realpathSync(join(root, 'current'))), '0.1.0');
    assert.equal(programOf('daemon'), systemNodeOnPath);

    // --keep-session-host：hub／daemon 換到自帶的 node，session host 不動（agent 不中斷）。
    const kept = mustInstall(['install', 'daemon', '--source', next, '--keep-session-host']);
    assert.match(kept, /Node system → bundled:24\.22\.2/);
    assert.equal(basename(realpathSync(join(root, 'current'))), '0.1.1');
    assert.equal(programOf('daemon'), join(root, 'current/runtime/node/bin/node'));
    assert.equal(programOf('session-host'), systemNodeOnPath, 'host 的設定維持舊的 node');
    assert.equal(hostPid(), host0, 'session host 沒重啟');
    assert.equal(state().sessionHostNode ?? 'system', 'system');
    await waitFor('新 daemon 經過自帶的 node 起來', () =>
      runningPid(launchd, 'com.agent-board.daemon'),
    );

    // 沒人在工作了：同一個指令（不加參數）換 host，改用 host 資料夾裡的 runtime。
    clearBusy();
    mustInstall(['install', 'daemon', '--source', next]);
    assert.equal(programOf('session-host'), join(root, 'session-host/runtime/node/bin/node'));
    assert.equal(state().sessionHostNode, `bundled:${NODE_VERSION}`);
    const host1 = await waitFor('新 session host 起來', () => hostPid());
    assert.notEqual(host1, host0, 'session host 重啟過');

    // 下一個自帶同一版 Node 的版本：不用換 host（忙碌也照裝）。
    markBusy();
    mustInstall(['install', 'daemon', '--source', makeRelease('0.1.2', { bundled: NODE_VERSION })]);
    assert.equal(hostPid(), host1);
    // 自帶 Node 換版（24.22.2 → 24.23.0）：要換 host，忙碌就 75。
    const bumped = installer([
      'install',
      'daemon',
      '--source',
      makeRelease('0.1.3', { bundled: '24.23.0' }),
    ]);
    assert.equal(bumped.status, 75, bumped.output);
    assert.match(bumped.output, /bundled:24\.22\.2 換成 bundled:24\.23\.0/);
    clearBusy();

    // 回滾到 0.1.0（沒自帶 Node）：hub／daemon 改回系統的 node；host 協定相同、不動（它的 runtime 自己帶著）。
    mustInstall(['switch', '--to', '0.1.0']);
    assert.equal(programOf('daemon'), systemNodeOnPath);
    assert.equal(programOf('session-host'), join(root, 'session-host/runtime/node/bin/node'));
    assert.equal(hostPid(), host1);
    assert.equal(state().bundledNode, null);
  });

  test('自帶 Node 的發布檔是別的平台：直接失敗，不跑 npm ci', () => {
    freshHome();
    const other = makeRelease('0.1.1', { bundled: NODE_VERSION });
    writeFileSync(
      join(other, '.node-modules-platform'),
      JSON.stringify({
        platform: 'win-x64',
        node: NODE_VERSION,
        modules: '137',
        bundledNode: true,
      }),
    );
    const result = installer(['install', 'daemon', '--source', other, '--no-start'], {
      AGENT_BOARD_INSTALL_TEST_SKIP_NATIVE: '',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /win-x64/);
    assert.doesNotMatch(result.output, /npm ci/);
  });
});

describe('更新程式用那一版的 node', () => {
  test('nodeFor：自帶的用 runtime/node；舊版用 install.json 記的系統 node', async () => {
    freshHome();
    const { nodeFor } = await import(join(repo, 'scripts/updater.mjs'));
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'install.json'),
      JSON.stringify({ roles: [], systemNode: process.execPath }),
    );
    const bundled = makeRelease('0.1.1', { bundled: NODE_VERSION });
    assert.equal(nodeFor(bundled, root), join(bundled, 'runtime/node/bin/node'));
    assert.equal(nodeFor(makeRelease('0.1.0'), root), process.execPath);
  });
});
