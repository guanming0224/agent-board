// corepack pnpm test:install（連同 service-templates.test.mjs）
// 安裝配置（releases/<版本> ＋ current）與獨立更新程式的各階段（CONTRACTS §21.2、§21.3）：
// 從舊的 app/ 遷移、保留 3 版、更新成功、壞版 60 秒（測試縮短）內回滾、schema 有變還原備份、手動回滾。
// 全部在臨時資料夾：HOME、資料夾、launchctl（假的，照 plist 真的把程式跑起來）都是假的，不碰這台機器的服務。
// 發布檔是假的（hub／daemon／session host 是幾行的小程式），只有 better-sqlite3 借用 repo 裡裝好的。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fakeHostCode } from './test-support/fake-host.mjs';
import {
  installFakeLaunchctl,
  runningPid,
  stopAll,
  stopOnSignal,
  sweepStale,
} from './test-support/fake-launchctl.mjs';

const repo = join(import.meta.dirname, '..');
const LABELS = ['com.agent-board.hub', 'com.agent-board.daemon', 'com.agent-board.session-host'];
const betterSqlite = dirname(
  createRequire(join(repo, 'packages/hub/package.json')).resolve('better-sqlite3/package.json'),
);
const Database = createRequire(join(repo, 'packages/hub/package.json'))('better-sqlite3');

const FAKE_HUB = `
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
const SCHEMA = manifest.fakeSchema ?? 1;
if (process.argv[2] === 'schema-version') { console.log(SCHEMA); process.exit(0); }
const Database = createRequire(import.meta.url)('better-sqlite3');
const db = new Database(join(process.env.AGENT_BOARD_DATA_DIR, 'hub.db'));
const current = db.pragma('user_version', { simple: true });
if (current > SCHEMA) { console.error('schema too new'); process.exit(1); }
db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
db.pragma('user_version = ' + SCHEMA);
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, version: manifest.version, buildId: 'x', protocolVersion: 1 }));
}).listen(Number(process.env.AGENT_BOARD_PORT), '127.0.0.1');
`;

const FAKE_DAEMON = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
if (manifest.fakeBroken) { console.error('broken build'); process.exit(1); }
const write = () => writeFileSync(join(process.env.AGENT_BOARD_DATA_DIR, 'daemon-status.json'),
  JSON.stringify({ pid: process.pid, version: manifest.version, buildId: 'x', connectedAt: new Date().toISOString() }));
setTimeout(write, 300);
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

const FAKE_HOST = fakeHostCode();

let base;
let home;
let data;
let root;
let stubs;
let launchd;
let port;
let env;

function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close(() => done(p));
    });
  });
}

/** 假發布檔：真的安裝程式、更新程式、服務模板；假的 hub、daemon、session host。 */
function makeRelease(version, { broken = false, schema = 1 } = {}) {
  const dir = join(base, `src-${version}${broken ? '-broken' : ''}`, 'agent-board');
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
    JSON.stringify({
      name: 'agent-board-release',
      version,
      fakeSchema: schema,
      fakeBroken: broken,
    }),
  );
  write('BUILD_ID', `build-${version}-${broken ? 'broken' : 'ok'}\n`);
  write('hub/dist/main.mjs', FAKE_HUB);
  write('daemon/dist/index.mjs', FAKE_DAEMON);
  write('daemon/dist/agent-board-mcp.mjs', '');
  write('daemon/node_modules/.bin/agent-board-hook', '#!/bin/sh\nexit 0\n');
  write('session-host/dist/main.mjs', FAKE_HOST);
  write('session-host/dist/meta.json', JSON.stringify({ protocol: 1 }));
  write(
    'node_modules/node-pty/package.json',
    JSON.stringify({ name: 'node-pty', version: '1.0.0' }),
  );
  symlinkSync(betterSqlite, join(dir, 'node_modules/better-sqlite3'));
  return dir;
}

function installer(args) {
  const result = spawnSync(process.execPath, [join(repo, 'scripts/installer.mjs'), ...args], {
    env,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function mustInstall(args) {
  const result = installer(args);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

/** 像 daemon 那樣跑更新程式（從新版裡跑），等它結束。 */
function updater(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const state = () => JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
const updateState = () => JSON.parse(readFileSync(join(data, 'update-state.json'), 'utf8'));
const currentTarget = () => basename(realpathSync(join(root, 'current')));
const releases = () =>
  readdirSync(join(root, 'releases'))
    .filter((name) => !name.startsWith('.'))
    .sort();
const schema = () => {
  const db = new Database(join(data, 'hub.db'), { readonly: true });
  try {
    return db.pragma('user_version', { simple: true });
  } finally {
    db.close();
  }
};

async function poll(what, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const health = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  } catch {
    return null;
  }
};

function freshHome() {
  if (launchd) stopAll(launchd, LABELS);
  home = join(base, `home-${Math.random().toString(36).slice(2, 8)}`);
  data = join(home, '.agent-board');
  root = join(home, '.local/share/agent-board');
  stubs = join(home, 'stubs');
  launchd = join(home, 'launchd');
  mkdirSync(home, { recursive: true });
  installFakeLaunchctl(stubs, launchd);
  const fakeClaude = join(home, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\n');
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

before(async () => {
  sweepStale('ab-updater-test-', LABELS);
  stopOnSignal(() => launchd, LABELS);
  base = mkdtempSync(join(realpathSync(tmpdir()), 'ab-updater-test-'));
  port = await freePort();
});
after(() => {
  if (launchd) stopAll(launchd, LABELS);
  rmSync(base, { recursive: true, force: true });
});

describe('安裝配置', () => {
  test('從舊的單一 app/ 遷移：搬成 releases/0.0.0-legacy，app 留成連結，服務指 current', () => {
    freshHome();
    const legacy = makeRelease('0.0.0');
    mkdirSync(root, { recursive: true });
    cpSync(legacy, join(root, 'app'), { recursive: true, verbatimSymlinks: true });
    writeFileSync(
      join(root, 'install.json'),
      JSON.stringify({ roles: ['hub', 'daemon'], port, sessionHostProtocol: 1 }),
    );
    mkdirSync(join(root, 'session-host/dist'), { recursive: true });
    writeFileSync(join(root, 'session-host/dist/main.mjs'), FAKE_HOST);
    const output = mustInstall(['install', 'hub', '--source', makeRelease('0.1.0'), '--no-start']);
    assert.match(output, /0\.0\.0-legacy/);
    assert.deepEqual(releases(), ['0.0.0-legacy', '0.1.0']);
    assert.ok(lstatSync(join(root, 'app')).isSymbolicLink());
    assert.equal(readlinkSync(join(root, 'app')), 'current');
    assert.equal(readlinkSync(join(root, 'current')), 'releases/0.1.0');
    // 舊路徑（還活著的 agent 的 PATH）照樣解析得到。
    assert.ok(existsSync(join(root, 'app/daemon/node_modules/.bin/agent-board-hook')));
    const s = state();
    assert.equal(s.currentVersion, '0.1.0');
    assert.equal(s.previousRelease, '0.0.0-legacy');
    assert.equal(s.previousVersion, '0.0.0-legacy');
    const plist = readFileSync(
      join(home, 'Library/LaunchAgents/com.agent-board.daemon.plist'),
      'utf8',
    );
    assert.match(plist, /current\/daemon\/dist\/index\.mjs/);
    assert.match(plist, /<key>AGENT_BOARD_INSTALL_ROOT<\/key>/);
    assert.match(plist, /current\/daemon\/node_modules\/\.bin\/agent-board-hook/);
    assert.doesNotMatch(plist, /\/app\//);
    // 捷徑也指 current。
    assert.match(readFileSync(join(home, '.local/bin/agent-board-hub'), 'utf8'), /current\/hub/);
  });

  test('同一份重跑不重裝；保留最近 3 版（current 與上一版一定留）', () => {
    freshHome();
    mustInstall([
      'install',
      'hub',
      '--source',
      makeRelease('0.1.0'),
      '--port',
      String(port),
      '--no-start',
    ]);
    assert.match(
      mustInstall(['install', 'hub', '--source', makeRelease('0.1.0'), '--no-start']),
      /略過安裝/,
    );
    for (const version of ['0.1.1', '0.1.2', '0.1.3']) {
      mustInstall(['install', 'hub', '--source', makeRelease(version), '--no-start']);
    }
    assert.deepEqual(releases(), ['0.1.1', '0.1.2', '0.1.3']);
    assert.equal(currentTarget(), '0.1.3');
    assert.equal(state().previousRelease, '0.1.2');
    // 切回較舊的版本後再裝新版：current、上一版都留。
    mustInstall(['switch', '--to', '0.1.1', '--no-start']);
    mustInstall(['install', 'hub', '--source', makeRelease('0.1.4'), '--no-start']);
    assert.deepEqual(releases(), ['0.1.1', '0.1.3', '0.1.4']);
    assert.equal(state().previousRelease, '0.1.1');
  });

  test('同版本不同內容（從原始碼重建）：裝到 <版本>+<BUILD_ID>，不動正在用的那份', () => {
    freshHome();
    mustInstall([
      'install',
      'hub',
      '--source',
      makeRelease('0.1.0'),
      '--port',
      String(port),
      '--no-start',
    ]);
    const rebuilt = makeRelease('0.1.0');
    writeFileSync(join(rebuilt, 'BUILD_ID'), 'deadbeefcafe\n');
    mustInstall(['install', 'hub', '--source', rebuilt, '--no-start']);
    assert.equal(currentTarget(), '0.1.0+deadbeef');
    assert.deepEqual(releases(), ['0.1.0', '0.1.0+deadbeef']);
  });
});

describe('更新程式的鎖與健康檢查', () => {
  const lockScript = join(repo, 'scripts', 'updater.mjs');

  test('takeLock：空的或很新的鎖當有人拿著；過期（pid 不在、10 秒以上）的清掉；同時搶只有一個拿到（W1）', async () => {
    freshHome();
    mkdirSync(root, { recursive: true });
    const { takeLock } = await import(lockScript);
    const lock = join(root, 'update.lock');
    writeFileSync(lock, '');
    assert.equal(takeLock(root), null, '空的鎖');
    writeFileSync(lock, '999999');
    assert.equal(takeLock(root), null, '剛建立的鎖（pid 不在也一樣）');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const release = takeLock(root);
    assert.ok(release, '過期的鎖');
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
    release();
    assert.ok(!existsSync(lock));
    // 同時搶：十個程序一起拿，只有一個拿到。
    const racer = join(home, 'racer.mjs');
    writeFileSync(
      racer,
      `import { takeLock } from ${JSON.stringify(lockScript)};
const got = takeLock(${JSON.stringify(root)});
console.log(got ? 'got' : 'no');
setTimeout(() => process.exit(0), 500);`,
    );
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        () =>
          new Promise((done) => {
            const child = spawn(process.execPath, [racer], { stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            child.stdout.on('data', (chunk) => (out += chunk));
            child.on('exit', () => done(out.trim()));
          }),
      ),
    );
    assert.equal(results.filter((r) => r === 'got').length, 1, results.join(','));
    assert.deepEqual(
      readdirSync(root).filter((n) => n.startsWith('update.lock.')),
      [],
    );
  });

  test('健康檢查：新 daemon 活著只是連不上 hub 時等到連線時限；起不來照原本的時限（S3b）', async () => {
    freshHome();
    mkdirSync(root, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(root, 'install.json'), JSON.stringify({ roles: ['daemon'] }));
    const { healthy } = await import(lockScript);
    const status = (over) =>
      writeFileSync(
        join(data, 'daemon-status.json'),
        JSON.stringify({
          pid: process.pid,
          version: '0.2.0',
          buildId: 'x',
          startedAt: new Date().toISOString(),
          connectedAt: null,
          ...over,
        }),
      );
    // 起不來：沒有狀態檔 → 原本的時限就放棄。
    let since = Date.now();
    let started = Date.now();
    assert.equal(
      await healthy({
        data,
        root,
        version: '0.2.0',
        since,
        timeoutMs: 500,
        connectTimeoutMs: 5000,
      }),
      false,
    );
    assert.ok(Date.now() - started < 2500);
    // 活著但連不上 hub：超過原本的時限還在等，連上了就成功。
    since = Date.now() - 10;
    status({});
    started = Date.now();
    setTimeout(() => status({ connectedAt: new Date().toISOString() }), 1800);
    assert.equal(
      await healthy({
        data,
        root,
        version: '0.2.0',
        since,
        timeoutMs: 500,
        connectTimeoutMs: 6000,
      }),
      true,
    );
    assert.ok(Date.now() - started >= 1700);
    // 活著但一直連不上：等到連線時限才放棄。
    since = Date.now() - 10;
    status({});
    started = Date.now();
    assert.equal(
      await healthy({
        data,
        root,
        version: '0.2.0',
        since,
        timeoutMs: 300,
        connectTimeoutMs: 1500,
      }),
      false,
    );
    assert.ok(Date.now() - started >= 1400);
    // 崩潰（pid 不在）：不延長。
    since = Date.now() - 10;
    status({ pid: 999999 });
    started = Date.now();
    assert.equal(
      await healthy({
        data,
        root,
        version: '0.2.0',
        since,
        timeoutMs: 300,
        connectTimeoutMs: 5000,
      }),
      false,
    );
    assert.ok(Date.now() - started < 2000);
  });

  test('app 連結不見了：下次安裝補回 app → current（W7）', () => {
    freshHome();
    mustInstall([
      'install',
      'hub',
      '--source',
      makeRelease('0.1.0'),
      '--port',
      String(port),
      '--no-start',
    ]);
    assert.equal(readlinkSync(join(root, 'app')), 'current');
    rmSync(join(root, 'app'));
    mustInstall(['install', 'hub', '--source', makeRelease('0.1.0'), '--no-start']);
    assert.equal(readlinkSync(join(root, 'app')), 'current');
  });

  test('自動更新時原生模組載不起來：不跑 npm ci，直接失敗（B5）', () => {
    freshHome();
    mustInstall([
      'install',
      'hub',
      '--source',
      makeRelease('0.1.0'),
      '--port',
      String(port),
      '--no-start',
    ]);
    const result = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/installer.mjs'),
        'install',
        'hub',
        '--source',
        makeRelease('0.1.1'),
        '--no-start',
      ],
      {
        env: { ...env, AGENT_BOARD_INSTALL_TEST_SKIP_NATIVE: '', AGENT_BOARD_UPDATER: '1' },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /自動更新不跑 npm ci/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /npm ci…/);
    assert.equal(currentTarget(), '0.1.0');
  });
});

describe('detached 更新程式', () => {
  test('停 daemon（對整個 process group 送訊號，同 launchd）時，detached 啟動的更新程式不會被收掉', async () => {
    freshHome();
    const dir = join(home, 'survive');
    mkdirSync(dir, { recursive: true });
    // 和 daemon 的 spawnDetached 一樣的選項：detached（setsid）、stdio 接檔案、unref。
    const parent = join(dir, 'parent.mjs');
    writeFileSync(
      parent,
      `import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
const code = (name) => "setInterval(()=>{},1000); require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(dir)}) + "+'/'+" + JSON.stringify(name) + ", String(process.pid));";
const out = openSync(${JSON.stringify(join(dir, 'child.log'))}, 'a');
const d = spawn(process.execPath, ['-e', code('detached')], { detached: true, stdio: ['ignore', out, out] });
d.unref();
spawn(process.execPath, ['-e', code('attached')], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
    );
    const plist = join(dir, 'job.plist');
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.agent-board.survive-test</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${parent}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict>
<key>WorkingDirectory</key><string>${dir}</string></dict></plist>`,
    );
    const launchctl = (...args) => spawnSync(join(stubs, 'launchctl'), args, { encoding: 'utf8' });
    launchctl('bootstrap', 'gui/501', plist);
    const pids = await poll('子程序起來', () => {
      try {
        return {
          detached: Number(readFileSync(join(dir, 'detached'), 'utf8')),
          attached: Number(readFileSync(join(dir, 'attached'), 'utf8')),
        };
      } catch {
        return null;
      }
    });
    launchctl('bootout', 'gui/501/com.agent-board.survive-test');
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await poll('一般子程序跟著結束', () => !alive(pids.attached));
    assert.ok(alive(pids.detached), 'detached 的更新程式應該還在');
    process.kill(pids.detached, 'SIGKILL');
  });
});

describe('更新程式', () => {
  async function installRunning(version = '0.1.0') {
    freshHome();
    mustInstall(['install', 'hub', '--source', makeRelease(version), '--port', String(port)]);
    mustInstall(['install', 'daemon', '--source', makeRelease(version)]);
    await poll('hub 起來', async () => (await health())?.version === version);
    await poll('daemon 起來', () => {
      try {
        return (
          JSON.parse(readFileSync(join(data, 'daemon-status.json'), 'utf8')).version === version
        );
      } catch {
        return false;
      }
    });
    assert.ok(runningPid(launchd, 'com.agent-board.session-host'));
  }

  function runUpdate(source, to, from, timeoutMs = 4000) {
    return updater(join(source, 'scripts', 'updater.mjs'), [
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
    ]);
  }

  /** daemon 下載解壓後的位置（更新程式結束會刪掉）。 */
  function incoming(version, options) {
    const dest = join(root, 'releases', '.incoming', version);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(dirname(makeRelease(version, options)), dest, {
      recursive: true,
      verbatimSymlinks: true,
    });
    return join(dest, 'agent-board');
  }

  test('成功：備份 hub.db（600）、換 current、重啟、健康檢查通過；session host 不重啟', async () => {
    await installRunning();
    const hostPid = runningPid(launchd, 'com.agent-board.session-host');
    const result = runUpdate(incoming('0.1.1'), '0.1.1', '0.1.0');
    assert.equal(result.status, 0, result.output);
    assert.equal(updateState().phase, 'succeeded');
    assert.equal(currentTarget(), '0.1.1');
    assert.equal((await health()).version, '0.1.1');
    const s = state();
    assert.equal(s.currentVersion, '0.1.1');
    assert.equal(s.previousVersion, '0.1.0');
    const backups = readdirSync(data).filter((name) => name.startsWith('hub.db.pre-update-0.1.0-'));
    assert.equal(backups.length, 1);
    assert.equal(statSync(join(data, backups[0])).mode & 0o777, 0o600);
    assert.equal(runningPid(launchd, 'com.agent-board.session-host'), hostPid);
    assert.ok(!existsSync(join(root, 'releases', '.incoming', '0.1.1')), '解壓的暫存要清掉');
    assert.ok(!existsSync(join(root, 'update.lock')));
  });

  test('壞版（新 daemon 起不來）：時限內回滾到舊版，schema 有變就還原備份', async () => {
    await installRunning();
    assert.equal(schema(), 1);
    const started = Date.now();
    const result = runUpdate(
      incoming('0.1.2', { broken: true, schema: 2 }),
      '0.1.2',
      '0.1.0',
      3000,
    );
    assert.equal(result.status, 1, result.output);
    const s = updateState();
    assert.equal(s.phase, 'rolled_back', result.output);
    assert.equal(s.reason, 'health_timeout');
    assert.equal(s.fromVersion, '0.1.0');
    assert.equal(s.toVersion, '0.1.2');
    assert.ok(Date.now() - started < 20_000);
    assert.equal(currentTarget(), '0.1.0');
    // 新版 hub 把 schema 升到 2；回滾時用更新前的備份還原，舊版 hub 才開得起來。
    assert.equal(schema(), 1);
    assert.match(result.output, /schema 從 v1 變成 v2/);
    assert.equal((await health()).version, '0.1.0');
    const daemon = JSON.parse(readFileSync(join(data, 'daemon-status.json'), 'utf8'));
    assert.equal(daemon.version, '0.1.0');
    assert.equal(state().currentVersion, '0.1.0');
  });

  test('安裝程式一開始就失敗（current 沒換）：直接標失敗，什麼都沒改', async () => {
    await installRunning();
    const source = incoming('0.1.3');
    writeFileSync(join(source, 'scripts/installer.mjs'), 'console.error("boom"); process.exit(1);');
    const result = runUpdate(source, '0.1.3', '0.1.0');
    assert.equal(result.status, 1, result.output);
    assert.equal(updateState().phase, 'failed');
    assert.equal(updateState().reason, 'install_failed');
    assert.equal(updateState().detail, 'boom');
    assert.equal(currentTarget(), '0.1.0');
    assert.equal((await health()).version, '0.1.0');
  });

  test('安裝程式換了 current 之後才失敗：用舊版的安裝程式切回', async () => {
    await installRunning();
    const source = incoming('0.1.3');
    // 新版的服務模板不見了：換完 current、寫服務設定時失敗，新版的 switch 也會失敗。
    rmSync(join(source, 'deploy'), { recursive: true });
    const result = runUpdate(source, '0.1.3', '0.1.0');
    assert.equal(result.status, 1, result.output);
    assert.equal(updateState().phase, 'rolled_back', result.output);
    assert.equal(updateState().reason, 'install_failed');
    assert.equal(currentTarget(), '0.1.0');
    assert.equal((await health()).version, '0.1.0');
  });

  test('已經有更新程式在跑：第二個不做事，記成 failed/busy（不是默默結束）', async () => {
    await installRunning();
    writeFileSync(join(root, 'update.lock'), String(process.pid));
    const result = runUpdate(incoming('0.1.1'), '0.1.1', '0.1.0');
    assert.equal(result.status, 1);
    assert.equal(updateState().phase, 'failed');
    assert.equal(updateState().reason, 'busy');
    assert.equal(currentTarget(), '0.1.0');
    assert.equal(
      readFileSync(join(root, 'update.lock'), 'utf8'),
      String(process.pid),
      '別人的鎖不動',
    );
    rmSync(join(root, 'update.lock'));
  });

  test('session 忙碌而這次要換 session host：安裝程式以 75 中止，記成 deferred/host_busy、不算失敗（W5）', async () => {
    await installRunning();
    // 快照記著一個工作中、agent 還活著的 session（用測試自己的 pid 當 agent）。
    mkdirSync(join(data, 'state'), { recursive: true });
    writeFileSync(
      join(data, 'state', 's1.json'),
      JSON.stringify({ sessionId: 's1', status: 'running', agentPid: process.pid }),
    );
    const source = incoming('0.1.1');
    writeFileSync(join(source, 'session-host/dist/meta.json'), JSON.stringify({ protocol: 2 }));
    const result = runUpdate(source, '0.1.1', '0.1.0');
    assert.equal(result.status, 0, result.output);
    assert.equal(updateState().phase, 'deferred');
    assert.equal(updateState().reason, 'host_busy');
    assert.equal(currentTarget(), '0.1.0');
    rmSync(join(data, 'state'), { recursive: true });
  });

  test('hub.db 備份由安裝程式在停 hub 前一刻做，只留最近 5 份（W3）', async () => {
    await installRunning();
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(data, `hub.db.pre-update-0.0.${i}-2026010${i}T000000`), '', {
        mode: 0o600,
      });
    }
    const result = runUpdate(incoming('0.1.1'), '0.1.1', '0.1.0');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /已備份 hub\.db（schema v1）/);
    const backups = readdirSync(data).filter((name) => name.startsWith('hub.db.pre-update-'));
    assert.equal(backups.length, 5);
    assert.ok(backups.some((name) => name.startsWith('hub.db.pre-update-0.1.0-')));
  });

  test('手動回滾：回到上一版（不推播的成功）；上一版的 hub 讀不了新 schema 就不做', async () => {
    await installRunning();
    assert.equal(runUpdate(incoming('0.1.1'), '0.1.1', '0.1.0').status, 0);
    const rollback = () =>
      updater(join(root, 'current', 'scripts', 'updater.mjs'), [
        'rollback',
        '--data',
        data,
        '--root',
        root,
        '--health-timeout-ms',
        '4000',
      ]);
    let result = rollback();
    assert.equal(result.status, 0, result.output);
    assert.equal(updateState().phase, 'succeeded');
    assert.equal(updateState().reason, 'rollback_requested');
    assert.equal(currentTarget(), '0.1.0');
    assert.equal((await health()).version, '0.1.0');

    // 再升到 schema 2 的版本，之後手動回滾會跨過 schema：拒絕。
    assert.equal(runUpdate(incoming('0.2.0', { schema: 2 }), '0.2.0', '0.1.0').status, 0);
    assert.equal(schema(), 2);
    result = rollback();
    assert.equal(result.status, 1);
    assert.equal(updateState().reason, 'schema_changed');
    assert.equal(currentTarget(), '0.2.0');
  });
});
