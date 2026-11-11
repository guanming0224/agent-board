// 自動更新的端到端測試（CONTRACTS §21，corepack pnpm e2e:update；先跑 corepack pnpm build:release）：
// 用本機建的成品當假 Release（改版本號重新打包）、PATH 上的假 gh、照 plist 真的把程式跑起來的假 launchctl，
// 走一次完整的鏈：hub 查到新 tag → 下載驗證 → canary 機器的 daemon 向 hub 下載 → detached 更新程式換 current、
// 重啟 → 新 daemon 連上 hub 回報新版 → 成功；再發一個壞版（新 daemon 起不來）→ 時限內自動回滾、hub 面板標失敗。
// hub 從工作目錄的原始碼跑；daemon 與 session host 是裝在臨時 HOME 的發布檔。不碰這台機器的服務、不連 GitHub。
// 自帶 Node（CONTRACTS §21.10）：先裝「沒自帶 Node 的舊版」（E2E_LEGACY_TARBALL 指定真的 0.1.0 成品；沒給就把
// 這次的成品拿掉 runtime/ 當舊版），再用 install.sh --from 手動升到自帶 Node 的版本（三個服務改用自帶的 node、
// session host 換成自帶的、忙碌時中止），之後自帶 Node 的版本之間照常自動更新。
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { installFakeLaunchctl, runningPid, stopAll } from './test-support/fake-launchctl.mjs';

const repo = join(import.meta.dirname, '..');
const { version: BASE } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const platform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
if (platform !== 'darwin-arm64')
  throw new Error('這個測試只在 Apple Silicon Mac 上跑（成品平台 darwin-arm64）');
const tarball = join(repo, 'release', `agent-board-${BASE}-${platform}.tar.gz`);
if (!existsSync(tarball)) throw new Error('先執行 corepack pnpm build:release');
const HEALTH_MS = 15_000;
const LABELS = ['com.agent-board.hub', 'com.agent-board.daemon', 'com.agent-board.session-host'];

const base = mkdtempSync(join(realpathSync(tmpdir()), 'ab e2e update-'));
const home = join(base, 'home');
const stubs = join(base, 'stubs');
const launchd = join(base, 'launchd');
const ghDir = join(base, 'fake-github');
const hubData = join(base, 'hub-data');
const data = join(home, '.agent-board');
const root = join(home, '.local/share/agent-board');
mkdirSync(home, { recursive: true });
mkdirSync(ghDir, { recursive: true });
installFakeLaunchctl(stubs, launchd);

const v = (patch) => BASE.replace(/\d+$/, (n) => String(Number(n) + patch));
/** 第一個自帶 Node 的版本（手動安裝）；之後三版走自動更新。 */
const FIRST_BUNDLED = v(1);
const GOOD = v(2);
const HUB_DOWN = v(3);
const BAD = v(4);
/** hub 停掉的時間：比健康檢查時限長，舊版的更新程式會誤判回滾（S3b）。 */
const HUB_DOWN_MS = HEALTH_MS + 10_000;

// ── 假 Release ────────────────────────────────────────────
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * 沒自帶 Node 的舊版成品：E2E_LEGACY_TARBALL（真的 0.1.0）；沒給就把這次的成品拿掉 runtime/、改掉
 * .node-modules-platform 當舊版（程式是新的，只驗配置與服務設定的轉換）。
 */
function legacyTarball() {
  if (process.env.E2E_LEGACY_TARBALL) return { path: process.env.E2E_LEGACY_TARBALL, real: true };
  const work = join(base, 'pack-legacy');
  mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', work]);
  const dir = join(work, 'agent-board');
  rmSync(join(dir, 'runtime'), { recursive: true, force: true });
  const info = JSON.parse(readFileSync(join(dir, '.node-modules-platform'), 'utf8'));
  delete info.bundledNode;
  writeFileSync(join(dir, '.node-modules-platform'), `${JSON.stringify(info)}\n`);
  writeFileSync(
    join(dir, 'BUILD_ID'),
    `${readFileSync(join(dir, 'BUILD_ID'), 'utf8').trim()}-legacy\n`,
  );
  const out = join(base, `agent-board-${BASE}-legacy-${platform}.tar.gz`);
  execFileSync('tar', ['-czf', out, 'agent-board'], {
    cwd: work,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  rmSync(work, { recursive: true, force: true });
  return { path: out, real: false };
}

/** 把本機成品解開、改版本號（壞版把 daemon 換成一啟動就失敗的程式）、重新打包；回傳成品路徑。 */
function repack(version, { broken = false } = {}) {
  const work = join(base, `pack-${version}`);
  mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', work]);
  const dir = join(work, 'agent-board');
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'BUILD_ID'),
    `${readFileSync(join(dir, 'BUILD_ID'), 'utf8').trim()}-${version}\n`,
  );
  if (broken) {
    writeFileSync(
      join(dir, 'daemon/dist/index.mjs'),
      "console.error('broken build'); process.exit(1);\n",
    );
  }
  const asset = `agent-board-${version}-${platform}.tar.gz`;
  const out = join(ghDir, `v${version}`);
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-czf', join(out, asset), 'agent-board'], {
    cwd: work,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  writeFileSync(join(out, 'SHA256SUMS'), `${sha(join(out, asset))}  ${asset}\n`);
  rmSync(work, { recursive: true, force: true });
  return join(out, asset);
}

/** 重新打包並放進假 GitHub（hub 下一次檢查會看到）。 */
function publish(version, options) {
  repack(version, options);
  const list = existsSync(join(ghDir, 'releases.json'))
    ? JSON.parse(readFileSync(join(ghDir, 'releases.json'), 'utf8'))
    : [];
  list.push({ tagName: `v${version}`, isDraft: false, publishedAt: new Date().toISOString() });
  writeFileSync(join(ghDir, 'releases.json'), JSON.stringify(list));
}

/** 假 gh：auth status 成功；release list 讀 releases.json；release download 從假 GitHub 複製（記下呼叫）。 */
const fakeGh = join(stubs, 'gh');
writeFileSync(
  fakeGh,
  `#!${process.execPath}
const { appendFileSync, copyFileSync, readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const dir = ${JSON.stringify(ghDir)};
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.log'), JSON.stringify({ args, token: process.env.GH_TOKEN ?? null }) + '\\n');
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'release' && args[1] === 'list') { process.stdout.write(readFileSync(join(dir, 'releases.json'))); process.exit(0); }
if (args[0] === 'release' && args[1] === 'download') {
  const out = args[args.indexOf('--dir') + 1];
  for (const name of readdirSync(join(dir, args[2]))) copyFileSync(join(dir, args[2], name), join(out, name));
  process.exit(0);
}
process.exit(1);
`,
);
chmodSync(fakeGh, 0o755);

// ── hub（原始碼）────────────────────────────────────────────
function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function poll(what, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((done) => setTimeout(done, 300));
  }
}

let passed = 0;
const step = (name) => {
  passed += 1;
  console.log(`  ok ${passed} ${name}`);
};

let hubProc = null;
let cookie = '';
let hubUrl = '';
async function api(method, path, body) {
  const response = await fetch(`${hubUrl}${path}`, {
    method,
    headers: {
      cookie,
      origin: hubUrl,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!cookie && response.headers.get('set-cookie')) {
    cookie = response.headers.get('set-cookie').split(';')[0];
  }
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

let hubPort = 0;
/** hub（原始碼）：測試中會停掉再開（S3b），同一個資料夾與埠。 */
async function startHub(port = hubPort) {
  hubPort = port;
  hubProc = spawn(join(repo, 'node_modules/.bin/tsx'), [join(repo, 'packages/hub/src/main.ts')], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      AGENT_BOARD_DATA_DIR: hubData,
      AGENT_BOARD_PORT: String(port),
      AGENT_BOARD_HOST: '127.0.0.1',
      AGENT_BOARD_GH_BIN: fakeGh,
      AGENT_BOARD_DISABLE_RELEASE_CHECK: '1',
      AGENT_BOARD_DISABLE_PUSH: '1',
      // 權杖環境變數不能傳給 gh（hub 會拿掉）。
      GH_TOKEN: 'sk-ant-demo-should-not-reach-gh',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await poll('hub 起來', async () => (await fetch(`${hubUrl}/api/health`).catch(() => null))?.ok);
}

async function stopHub() {
  const proc = hubProc;
  hubProc = null;
  await new Promise((done) => {
    proc.once('exit', done);
    proc.kill('SIGTERM');
  });
}

async function main() {
  const port = await freePort();
  hubUrl = `http://127.0.0.1:${port}`;
  await startHub(port);
  await poll('hub 起來', async () => (await fetch(`${hubUrl}/api/health`).catch(() => null))?.ok);
  await api('POST', '/api/auth/setup', {
    name: 'owner',
    password: 'correct horse battery',
    locale: 'en',
  });
  assert.equal(
    (await api('PATCH', '/api/releases/config', { repo: 'example/agent-board' })).status,
    200,
  );
  const code = (await api('POST', '/api/machines/pairing-codes')).body.code;
  step('hub（原始碼）起來，設定 Release repo，假 gh 在 PATH 外以 AGENT_BOARD_GH_BIN 指定');

  // ── daemon：裝在臨時 HOME 的發布檔 ───────────────────────────
  const fakeClaude = join(base, 'fake-bin', 'claude');
  mkdirSync(dirname(fakeClaude), { recursive: true });
  cpSync(join(repo, 'packages/web/e2e/fixtures/fake-claude.mjs'), fakeClaude);
  chmodSync(fakeClaude, 0o755);
  const env = {
    HOME: home,
    PATH: [stubs, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    TMPDIR: tmpdir(),
    LANG: 'zh_TW.UTF-8',
    AGENT_BOARD_UPDATE_HEALTH_MS: String(HEALTH_MS),
    AGENT_BOARD_UPDATE_CONNECT_MS: String(HUB_DOWN_MS + 60_000),
  };
  const legacy = legacyTarball();
  const install = spawnSync(
    'sh',
    [
      join(repo, 'scripts/install.sh'),
      'daemon',
      '--from',
      legacy.path,
      '--hub',
      hubUrl,
      '--code',
      code,
      '--name',
      'canary mac',
      '--claude-bin',
      fakeClaude,
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
  const machine = await poll('daemon 連上 hub', async () => {
    const overview = await api('GET', '/api/releases');
    return overview.body.machines?.find((m) => m.online && m.version === BASE);
  });
  assert.equal(machine.platform, platform);
  assert.equal(machine.protocolVersion, 1);
  assert.equal(machine.previousVersion, null);
  const plistNode = (label) =>
    JSON.parse(
      execFileSync(
        'plutil',
        ['-convert', 'json', '-o', '-', join(home, 'Library/LaunchAgents', `${label}.plist`)],
        { encoding: 'utf8' },
      ),
    ).ProgramArguments[0];
  assert.ok(!plistNode('com.agent-board.daemon').includes('runtime/node'), '舊版用系統的 node');
  const legacyHostPid = runningPid(launchd, 'com.agent-board.session-host');
  assert.ok(legacyHostPid, 'session host 在跑');
  step(
    `沒自帶 Node 的舊版 ${BASE}（${legacy.real ? '真的成品' : '這次的成品拿掉 runtime/'}）從發布檔安裝並連上 hub，服務用系統的 node`,
  );

  const channel = await api('PUT', `/api/machines/${machine.machineId}/channel`, {
    channel: 'canary',
  });
  assert.equal(channel.body.machines[0].channel, 'canary');

  // ── 升到第一個自帶 Node 的版本 ─────────────────────────────────
  // 正式上架用手動（install.sh --from）：0.1.0 的 hub 用舊邏輯比 ABI（成品記的 ABI 和那台的系統 Node 一樣才發）。
  // E2E_LEGACY_AUTO=1：改成讓舊版 daemon 自己自動更新（舊 daemon 用它自己的系統 node 啟動新版的更新程式），
  // 驗證 0.1.0 的 hub 剛好發了目標時這條路也走得通。
  const first = repack(FIRST_BUNDLED);
  if (process.env.E2E_LEGACY_AUTO === '1') {
    publish(FIRST_BUNDLED);
    assert.equal((await api('POST', '/api/releases/check')).body.canary, FIRST_BUNDLED);
    await poll(
      '舊版 daemon 自動更新到自帶 Node 的版本',
      async () => {
        const m = (await api('GET', '/api/releases')).body.machines[0];
        return m.online && m.version === FIRST_BUNDLED && m.update?.phase === 'succeeded';
      },
      120_000,
    );
    const log = readFileSync(join(data, 'logs/updater.log'), 'utf8');
    assert.match(log, /runtime\/node\/bin\/node .*installer\.mjs install/);
  } else {
    const manual = (extra = []) =>
      spawnSync('sh', [join(repo, 'scripts/install.sh'), 'daemon', '--from', first, ...extra], {
        env,
        encoding: 'utf8',
      });
    mkdirSync(join(data, 'state'), { recursive: true });
    const busyFile = join(data, 'state', 'e2e-busy.json');
    writeFileSync(
      busyFile,
      JSON.stringify({ sessionId: 'e2e-busy', status: 'running', agentPid: process.pid }),
    );
    const refused = manual();
    assert.equal(refused.status, 75, `${refused.stdout}${refused.stderr}`);
    assert.match(`${refused.stdout}${refused.stderr}`, /--keep-session-host/);
    assert.equal(basename(realpathSync(join(root, 'current'))), BASE);
    rmSync(busyFile);
    step(
      '手動升級時有 session 在工作：要換 session host（Node 變了），以 75 中止、什麼都沒改，提示 --keep-session-host',
    );
    const upgraded = manual();
    assert.equal(upgraded.status, 0, `${upgraded.stdout}${upgraded.stderr}`);
  }
  const bundledNode = join(root, 'current/runtime/node/bin/node');
  assert.equal(plistNode('com.agent-board.daemon'), bundledNode);
  assert.equal(
    plistNode('com.agent-board.session-host'),
    join(root, 'session-host/runtime/node/bin/node'),
  );
  const installState = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
  const { bundledNode: pinned } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(installState.sessionHostNode, `bundled:${pinned}`);
  const hostPid = await poll('新的 session host 起來', () =>
    runningPid(launchd, 'com.agent-board.session-host'),
  );
  assert.notEqual(hostPid, legacyHostPid, 'session host 換成自帶 Node 的那份（重啟過）');
  const daemonPid = await poll('新 daemon 起來', () =>
    runningPid(launchd, 'com.agent-board.daemon'),
  );
  const command = execFileSync('ps', ['-o', 'command=', '-p', String(daemonPid)], {
    encoding: 'utf8',
  });
  assert.match(command, /runtime\/node\/bin\/node/, `daemon 用自帶的 node 跑：${command}`);
  await poll('daemon 以新版連上 hub', async () => {
    const m = (await api('GET', '/api/releases')).body.machines[0];
    return m.online && m.version === FIRST_BUNDLED ? m : null;
  });
  step(
    `${process.env.E2E_LEGACY_AUTO === '1' ? '舊版 daemon 自動更新' : '沒人在工作時手動 install.sh --from'} 升到 ${FIRST_BUNDLED}：hub／daemon 改用 current/runtime/node、session host 改用自己資料夾的 runtime（重啟一次），daemon 以新版連上 hub`,
  );

  // ── 好的新版 ─────────────────────────────────────────────
  publish(GOOD);
  const started = Date.now();
  const check = await api('POST', '/api/releases/check');
  assert.equal(check.body.gh.state, 'ok');
  assert.equal(check.body.canary, GOOD, JSON.stringify(check.body));
  assert.equal(check.body.machines[0].targetVersion, GOOD);
  const calls = readFileSync(join(ghDir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(
    calls.every((c) => c.token === null),
    'gh 不該拿到環境裡的 GH_TOKEN',
  );
  step(`hub 用 gh 查到 v${GOOD}、下載並驗 SHA-256，設為 canary（gh 拿不到 GH_TOKEN）`);

  const updated = await poll(
    'canary 自動更新完成',
    async () => {
      const m = (await api('GET', '/api/releases')).body.machines[0];
      return m.online && m.version === GOOD && m.update?.phase === 'succeeded' ? m : null;
    },
    90_000,
  );
  assert.equal(updated.previousVersion, FIRST_BUNDLED);
  assert.equal(basename(realpathSync(join(root, 'current'))), GOOD);
  assert.equal(
    runningPid(launchd, 'com.agent-board.session-host'),
    hostPid,
    'session host 不該重啟',
  );
  const state = JSON.parse(readFileSync(join(data, 'update-state.json'), 'utf8'));
  assert.equal(state.phase, 'succeeded');
  assert.ok(
    !existsSync(join(root, 'releases/.incoming')) ||
      !existsSync(join(root, 'releases/.incoming', GOOD)),
  );
  const audit = await api('GET', '/api/audit?action=release.download');
  assert.match(JSON.stringify(audit.body), new RegExp(GOOD.replaceAll('.', '\\.')));
  const updaterLog = readFileSync(join(data, 'logs/updater.log'), 'utf8');
  assert.match(updaterLog, /runtime\/node\/bin\/node .*installer\.mjs install/);
  step(
    `canary 機器從自帶 Node 的版本自動更新到 ${GOOD}（hub 不比 ABI）：向 hub 下載、用新版自帶的 node 跑 detached 更新程式換 current、健康檢查通過（${Math.round((Date.now() - started) / 1000)} 秒），session host 沒重啟`,
  );

  // ── hub 在更新途中停掉（S3b）：新 daemon 起來了但連不上 hub，不該被當成壞版回滾 ─────────
  publish(HUB_DOWN);
  assert.equal((await api('POST', '/api/releases/check')).body.canary, HUB_DOWN);
  await poll(
    '更新程式開始安裝',
    () => {
      try {
        const s = JSON.parse(readFileSync(join(data, 'update-state.json'), 'utf8'));
        return s.toVersion === HUB_DOWN && ['installing', 'checking'].includes(s.phase);
      } catch {
        return false;
      }
    },
    60_000,
  );
  await stopHub();
  await new Promise((done) => setTimeout(done, HUB_DOWN_MS));
  await startHub();
  const survived = await poll(
    'hub 停過之後更新照樣成功',
    async () => {
      const m = (await api('GET', '/api/releases')).body.machines[0];
      return m.online && m.version === HUB_DOWN && m.update?.phase === 'succeeded' ? m : null;
    },
    120_000,
  );
  assert.equal(survived.previousVersion, GOOD);
  assert.equal(basename(realpathSync(join(root, 'current'))), HUB_DOWN);
  step(
    `更新途中 hub 停了 ${HUB_DOWN_MS / 1000} 秒（超過 ${HEALTH_MS / 1000} 秒健康檢查）：新 daemon 活著就等它連上，更新到 ${HUB_DOWN} 成功、沒有誤判回滾`,
  );

  // ── 壞版：新 daemon 起不來 ────────────────────────────────────
  publish(BAD, { broken: true });
  const badStarted = Date.now();
  assert.equal((await api('POST', '/api/releases/check')).body.canary, BAD);
  const failed = await poll(
    '壞版自動回滾',
    async () => {
      const m = (await api('GET', '/api/releases')).body.machines[0];
      return m.online && m.update?.phase === 'rolled_back' ? m : null;
    },
    HEALTH_MS + 60_000,
  );
  const elapsed = Date.now() - badStarted;
  assert.equal(failed.version, HUB_DOWN);
  assert.equal(failed.update.reason, 'health_timeout');
  assert.equal(failed.update.toVersion, BAD);
  assert.equal(basename(realpathSync(join(root, 'current'))), HUB_DOWN);
  const failures = await api('GET', '/api/audit?action=release.update_failed');
  assert.match(JSON.stringify(failures.body), /rolled_back/);
  step(
    `壞版 ${BAD}（新 daemon 起不來）：${HEALTH_MS / 1000} 秒健康檢查沒過，自動回滾到 ${HUB_DOWN}，hub 面板標失敗並記 audit（共 ${Math.round(elapsed / 1000)} 秒）`,
  );

  // 同一個壞版不會自動重試。
  await new Promise((done) => setTimeout(done, 3_000));
  const still = (await api('GET', '/api/releases')).body.machines[0];
  assert.equal(still.update.phase, 'rolled_back');
  assert.equal(still.version, HUB_DOWN);
  step('回滾後不會自動再試同一個壞版（要按「立即更新」）');
}

let failed = false;
try {
  console.log(`自動更新 e2e（${base}）`);
  await main();
  console.log(`通過 ${passed} 項`);
  if (process.env.E2E_UPDATE_VERBOSE) {
    console.log(readFileSync(join(data, 'logs/updater.log'), 'utf8'));
  }
} catch (error) {
  failed = true;
  console.error(`失敗（已通過 ${passed} 項）：`, error);
  for (const file of ['logs/updater.log', 'logs/daemon.log']) {
    const path = join(data, file);
    if (existsSync(path))
      console.error(`── ${file} ──\n${readFileSync(path, 'utf8').slice(-4000)}`);
  }
} finally {
  stopAll(launchd, LABELS);
  hubProc?.kill('SIGTERM');
  await new Promise((done) => setTimeout(done, 500));
  if (!failed) rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
