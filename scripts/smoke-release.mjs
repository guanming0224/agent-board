// 發布檔冒煙測試：release/agent-board.tar.gz 裝到臨時 HOME（路徑含空格與中文），
// 用服務設定檔裡「只有」的環境變數啟動 hub 與 daemon（重現 launchd 的乾淨環境），
// 再走配對、開 session、真 hook、危險指令攔截、重裝、解除安裝。claude 是假的，不花額度。
//
// launchctl、systemctl、loginctl 全部換成只會記錄參數的假程式，不碰這台機器的系統服務。
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const tarball = join(repo, 'release', 'agent-board.tar.gz');
if (!existsSync(tarball)) throw new Error('先執行 corepack pnpm build:release');

const WebSocket = createRequire(join(repo, 'packages/hub/package.json'))('ws');

const base = mkdtempSync(join(realpathSync(tmpdir()), 'ab smoke 空白-'));
const home = join(base, 'home dir');
const stubs = join(base, 'stubs');
const callLog = join(base, 'system-calls.log');
const workdir = join(base, 'my project 資料夾');
mkdirSync(home);
mkdirSync(stubs);
mkdirSync(workdir);

const realAgents = join(homedir(), 'Library', 'LaunchAgents');
const listAgents = () =>
  existsSync(realAgents)
    ? readdirSync(realAgents).filter((name) => name.includes('agent-board'))
    : [];
const agentsBefore = listAgents();

for (const name of ['launchctl', 'systemctl', 'loginctl']) {
  const stub = join(stubs, name);
  // launchctl print 回 1 代表「尚未載入」，讓安裝腳本走 bootstrap。
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${callLog}"\n[ "$1" = "print" ] && exit 1\nexit 0\n`,
  );
  chmodSync(stub, 0o755);
}
const fakeClaude = join(base, 'fake bin', 'claude');
mkdirSync(dirname(fakeClaude));
cpSync(join(repo, 'packages/web/e2e/fixtures/fake-claude.mjs'), fakeClaude);
chmodSync(fakeClaude, 0o755);

// 只留最少的環境：開發機的 CLAUDE*、npm_config_*、pnpm 路徑都不可以幫到忙。
const cleanEnv = {
  HOME: home,
  PATH: [stubs, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
  TMPDIR: tmpdir(),
  LANG: 'zh_TW.UTF-8',
};
const realNpmCache = spawnSync('npm', ['config', 'get', 'cache'], {
  encoding: 'utf8',
}).stdout.trim();
if (realNpmCache) cleanEnv.npm_config_cache = realNpmCache;

const installScript = join(repo, 'scripts', 'install.sh');
function installer(args, extraEnv = {}) {
  const result = spawnSync('sh', [installScript, ...args], {
    env: { ...cleanEnv, ...extraEnv },
    cwd: base,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}
function mustInstall(args, extraEnv) {
  const result = installer(args, extraEnv);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

function freePort() {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const children = [];
/** 完全照 plist 啟動：程式、參數、環境變數、工作目錄都讀自設定檔，其他環境一律不給。 */
function startFromPlist(role) {
  const file = join(home, 'Library', 'LaunchAgents', `com.agent-board.${role}.plist`);
  execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
  const plist = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }),
  );
  const [program, ...args] = plist.ProgramArguments;
  const child = spawn(program, args, {
    cwd: plist.WorkingDirectory,
    env: plist.EnvironmentVariables,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  children.push(child);
  return { child, plist, output: () => output };
}

async function poll(what, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`逾時：${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

let passed = 0;
const step = (name) => {
  passed += 1;
  console.log(`  ok ${passed} ${name}`);
};

async function main() {
  const port = await freePort();
  const hub = `http://127.0.0.1:${port}`;
  const from = ['--from', tarball];

  // ── 安裝 hub ──
  const first = mustInstall(['hub', ...from, '--port', String(port), '--no-start']);
  assert.match(first, /--no-start/);
  const app = join(home, '.local/share/agent-board/app');
  assert.ok(existsSync(join(app, 'node_modules/node-pty')));
  assert.ok(!existsSync(join(app, 'node_modules/typescript')), '不該裝到開發依賴');
  assert.ok(
    existsSync(join(app, 'daemon/dist/deepSearchWorker.mjs')),
    '深層搜尋 worker 要在發布檔裡',
  );
  for (const name of readdirSync(join(app, 'node_modules/node-pty/prebuilds'))) {
    const helper = join(app, 'node_modules/node-pty/prebuilds', name, 'spawn-helper');
    if (existsSync(helper)) assert.ok(lstatSync(helper).mode & 0o100, `${helper} 要可執行`);
  }
  step('安裝 hub 到含空格與中文的 HOME，npm ci 只裝執行依賴，spawn-helper 可執行');

  const rerun = mustInstall(['hub', ...from, '--no-start']);
  assert.match(rerun, /略過安裝/);
  step('重跑是冪等的：內容相同不重裝，保留 --port');

  const tooOld = spawnSync('sh', [installScript, 'hub'], {
    env: { ...cleanEnv, PATH: `${stubs}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  assert.notEqual(tooOld.status, 0);
  assert.match(tooOld.stderr, /node/);
  step('沒有 node 時給出清楚訊息');

  // ── 用服務設定的環境跑 hub ──
  const hubProc = startFromPlist('hub');
  assert.ok(!('AGENT_BOARD_HOST' in hubProc.plist.EnvironmentVariables));
  await poll('hub 回應', async () => (await fetch(`${hub}/api/auth/status`).catch(() => null))?.ok);
  const index = await fetch(`${hub}/`);
  assert.match(await index.text(), /<div id="root">/);
  const { chromium } = createRequire(join(repo, 'packages/web/package.json'))('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: 'zh-TW' });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(hub);
    await page.getByRole('button', { name: '建立管理員' }).waitFor({ timeout: 15_000 });
    assert.match(page.url(), /#\/onboarding/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
  step('hub 在服務環境下啟動；瀏覽器開打包的前端直接進首次引導');

  const setup = await fetch(`${hub}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'owner', password: 'smoke-test-password', locale: 'en' }),
  });
  assert.ok(setup.ok, `setup ${setup.status}`);
  const cookie = setup.headers.getSetCookie()[0].split(';')[0];
  const api = async (method, path, body) => {
    const response = await fetch(`${hub}${path}`, {
      method,
      headers: { cookie, origin: hub, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, `${method} ${path} → ${response.status}`);
    return response.json();
  };
  step('建立管理員（argon2 原生模組可用）');

  // ── 安裝 daemon，配對碼帶入 ──
  const pairing = await api('POST', '/api/machines/pairing-codes');
  const daemonOutput = mustInstall([
    'daemon',
    ...from,
    '--hub',
    hub,
    '--code',
    pairing.code,
    '--claude-bin',
    fakeClaude,
    '--name',
    'smoke machine 機器',
    '--no-start',
  ]);
  assert.match(daemonOutput, /配對成功/);
  const credentials = join(home, '.agent-board/machine.json');
  assert.equal(lstatSync(credentials).mode & 0o777, 0o600);
  step('daemon 安裝帶配對碼，憑證權限 0600');

  const plistText = readFileSync(
    join(home, 'Library/LaunchAgents/com.agent-board.daemon.plist'),
    'utf8',
  );
  const { token } = JSON.parse(readFileSync(credentials, 'utf8'));
  assert.ok(!plistText.includes(token), 'token 不可寫進服務設定');
  step('服務設定不含機器 token');

  const again = mustInstall([
    'daemon',
    ...from,
    '--hub',
    hub,
    '--code',
    pairing.code,
    '--no-start',
  ]);
  assert.match(again, /略過配對/);
  step('重跑舊的配對指令不會失敗，也不會重新配對');

  // session host（CONTRACTS §20）：照 plist 啟動打包的 session-host/dist/main.mjs（node-pty 用發布檔的 node_modules），
  // daemon 起來時先連它。daemon 的服務設定要知道怎麼拉起它。
  const hostProc = startFromPlist('session-host');
  const hostToken = join(home, '.agent-board/session-host.token');
  await poll('session host 起來', () => existsSync(hostToken));
  assert.equal(lstatSync(hostToken).mode & 0o777, 0o600);
  // socket 的位置看路徑長度（太長時改放 tmpdir 底下），權限由單元測試驗。
  step('session host 在服務環境下啟動：token 檔 0600');

  // 拿掉 PATH 上的 hook：確定 daemon 靠 useBundledHook 找到打包進去的那一支。
  rmSync(join(home, '.local/bin/agent-board-hook'));
  const daemonProc = startFromPlist('daemon');
  assert.equal(
    daemonProc.plist.EnvironmentVariables.AGENT_BOARD_SESSION_HOST_SERVICE,
    'com.agent-board.session-host',
  );
  assert.ok(!('AGENT_BOARD_HOOK_BIN' in daemonProc.plist.EnvironmentVariables));
  const machine = await poll('機器上線', async () => {
    const machines = await api('GET', '/api/machines');
    return machines.find((m) => m.online);
  });
  assert.equal(machine.name, 'smoke machine 機器');
  step('daemon 在服務環境下連上 hub，名稱有空格與中文也傳得過去');

  // ── 另一台機器：先裝、再貼中控台給的配對指令 ──
  const second = join(base, 'second machine');
  mkdirSync(second);
  mustInstall(['daemon', ...from, '--claude-bin', fakeClaude, '--no-start'], { HOME: second });
  const shim = join(second, '.local/bin/agent-board-daemon');
  const secondEnv = { ...cleanEnv, HOME: second, AGENT_BOARD_CLAUDE_BIN: fakeClaude };
  const unpaired = spawnSync(shim, [], { env: secondEnv, encoding: 'utf8', timeout: 10_000 });
  assert.equal(unpaired.status, 1, '沒配對要非零結束，launchd 才會重試');
  assert.match(unpaired.stderr + unpaired.stdout, /agent-board-daemon pair/);
  const secondCode = await api('POST', '/api/machines/pairing-codes');
  const pasted = spawnSync('sh', ['-c', secondCode.installCommand], {
    env: { ...secondEnv, PATH: `${dirname(shim)}:${secondEnv.PATH}` },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(pasted.status, 0, pasted.stdout + pasted.stderr);
  assert.ok(existsSync(join(second, '.agent-board/machine.json')));
  step('先安裝後配對：未配對的 daemon 非零結束（服務會重試），中控台給的指令原樣可用');

  // ── 開 session：真 hook ──
  const session = await api('POST', '/api/sessions', {
    machineId: machine.id,
    name: 'smoke',
    projectId: null,
    cwd: workdir,
    useWorktree: false,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    resumeClaudeSessionId: null,
    firstPrompt: null,
  });
  const statusOf = async () =>
    (await api('GET', '/api/sessions')).find((s) => s.id === session.id)?.status;
  await poll('session 進 waiting_input', async () => (await statusOf()) === 'waiting_input');
  const settings = JSON.parse(readFileSync(join(workdir, '.claude/settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'agent-board-hook Stop');
  step('開 session：打包的 hook 從含空格的路徑執行成功，SessionStart 接上');
  // 狀態快照只有 session host 模式才寫：有這個檔就代表 agent 是 host 開的。
  assert.ok(existsSync(join(home, '.agent-board/state', `${session.id}.json`)));
  step('session 由打包的 session host 開（狀態快照存在）');

  // ── 危險指令：真 hook 卡住、網頁決定 ──
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/client`, {
    headers: { cookie, origin: hub },
  });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  await new Promise((done, fail) => {
    ws.once('open', done);
    ws.once('error', fail);
  });
  ws.send(JSON.stringify({ type: 'terminal.subscribe', sessionId: session.id }));
  ws.send(JSON.stringify({ type: 'terminal.input', sessionId: session.id, data: 'danger\r' }));
  const requested = await poll('危險指令被攔下', () =>
    messages.find((m) => m.type === 'approval.requested' && m.approval.kind === 'danger'),
  );
  assert.equal(await statusOf(), 'waiting_permission');
  ws.send(
    JSON.stringify({
      type: 'approval.decide',
      approvalId: requested.approval.id,
      sessionId: session.id,
      decision: { behavior: 'deny', reason: 'smoke-deny' },
    }),
  );
  await poll('拒絕回到 claude', () =>
    messages.some(
      (m) => m.type === 'terminal.output' && String(m.data).includes('"permissionDecision":"deny"'),
    ),
  );
  ws.close();
  step('危險指令檢查有效：hook 卡住，網頁拒絕後 deny 回到 claude');

  // ── hook 冷啟動 ──
  const hookFile = join(app, 'daemon/node_modules/.bin/agent-board-hook');
  const timeIt = (command, args) => {
    const samples = [];
    for (let i = 0; i < 15; i += 1) {
      const start = process.hrtime.bigint();
      spawnSync(command, args, {
        env: { PATH: cleanEnv.PATH },
        input: '{}',
      });
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    return samples.sort((a, b) => a - b)[7];
  };
  const bundledMs = timeIt(hookFile, ['Stop']);
  const sourceMs = timeIt(process.execPath, [join(repo, 'packages/hook/src/cli.ts'), 'Stop']);
  console.log(
    `     hook 中位數：打包 ${bundledMs.toFixed(1)}ms，TS 原始碼 ${sourceMs.toFixed(1)}ms`,
  );
  assert.ok(bundledMs <= sourceMs * 1.2, '打包後的 hook 不可比原始碼慢');
  step('hook 啟動沒有變慢');

  await api('POST', `/api/sessions/${session.id}/stop`);
  await new Promise((done) => {
    daemonProc.child.once('exit', done);
    daemonProc.child.kill('SIGTERM');
  });
  assert.equal(daemonProc.child.exitCode, 0, daemonProc.output());
  await new Promise((done) => {
    hostProc.child.once('exit', done);
    hostProc.child.kill('SIGTERM');
  });
  assert.equal(hostProc.child.exitCode, 0, hostProc.output());
  step('session host 收到 SIGTERM 正常結束');

  // ── 啟動服務的流程（launchctl 是假的）──
  const activated = mustInstall(['hub', ...from]);
  assert.match(activated, /hub 已啟動/);
  const calls = readFileSync(callLog, 'utf8');
  assert.ok(calls.includes(`launchctl print gui/${process.getuid()}/com.agent-board.hub`));
  assert.ok(
    calls.includes(
      `launchctl bootstrap gui/${process.getuid()} ${join(home, 'Library/LaunchAgents/com.agent-board.hub.plist')}`,
    ),
    calls,
  );
  assert.ok(lstatSync(join(home, '.local/bin/agent-board-hook')).isSymbolicLink());
  assert.ok(readlinkSync(join(home, '.local/bin/agent-board-hook')).includes('agent-board-hook'));
  step('啟動流程呼叫 launchctl bootstrap（假程式記錄），hook 捷徑補回');

  // ── 埠被占用 ──
  const fresh = join(base, 'home2');
  mkdirSync(fresh);
  const busy = installer(['hub', ...from, '--port', String(port), '--no-start'], { HOME: fresh });
  assert.notEqual(busy.status, 0);
  assert.match(busy.output, /已被其他程式使用/);
  const busyEn = installer(['hub', ...from, '--port', String(port), '--no-start'], {
    HOME: fresh,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  });
  assert.match(busyEn.output, /already in use/);
  step('埠被占用時提早報錯，不留下 crash loop 的服務；非中文語系用英文');

  const open = installer(['hub', ...from, '--host', '0.0.0.0', '--no-start'], { HOME: fresh });
  assert.notEqual(open.status, 0);
  assert.match(open.output, /不能監聽所有網卡/);
  step('拒絕 --host 0.0.0.0');

  // ── Linux 流程演練（只驗檔案與呼叫，沒有真的 systemd）──
  const linuxHome = join(base, 'linux home');
  mkdirSync(linuxHome);
  const linuxEnv = { HOME: linuxHome, AGENT_BOARD_INSTALL_PLATFORM: 'linux' };
  const linuxPort = await freePort();
  const linuxPlan = mustInstall(
    ['hub', ...from, '--port', String(linuxPort), '--no-start'],
    linuxEnv,
  );
  assert.match(linuxPlan, /--no-start/);
  const unit = readFileSync(
    join(linuxHome, '.config/systemd/user/agent-board-hub.service'),
    'utf8',
  );
  assert.match(unit, /^ExecStart="[^"]*node" "[^"]*linux home[^"]*main\.mjs"$/m);
  assert.ok(unit.includes(`Environment="AGENT_BOARD_PORT=${linuxPort}"`));
  mustInstall(['--uninstall'], linuxEnv);
  assert.ok(!existsSync(join(linuxHome, '.config/systemd/user/agent-board-hub.service')));
  step('Linux 流程演練：unit 內容正確、解除安裝會移除（未在真 systemd 上跑）');

  // ── 忘記密碼：透過安裝的捷徑跑打包後的 reset-password（hub 還在跑）──
  const resetTo = 'smoke-reset-password';
  const reset = spawnSync(join(home, '.local/bin/agent-board-hub'), ['reset-password', 'owner'], {
    env: cleanEnv,
    input: `${resetTo}\n`,
    encoding: 'utf8',
  });
  assert.equal(reset.status, 0, `${reset.stdout}${reset.stderr}`);
  assert.match(reset.stdout, /was reset/);
  assert.ok(!`${reset.stdout}${reset.stderr}`.includes(resetTo), '不可印出密碼');
  const revoked = await fetch(`${hub}/api/sessions`, { headers: { cookie } });
  assert.equal(revoked.status, 401);
  const relogin = await fetch(`${hub}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'owner', password: resetTo }),
  });
  assert.ok(relogin.ok, `login ${relogin.status}`);
  step('agent-board-hub reset-password：捷徑傳參數、打包的 argon2 可用、舊登入失效');

  // ── 解除安裝 ──
  hubProc.child.kill('SIGTERM');
  await new Promise((done) => hubProc.child.once('exit', done));
  const removed = mustInstall(['--uninstall']);
  assert.match(removed, /資料保留/);
  assert.ok(!existsSync(join(home, '.local/share/agent-board')));
  assert.ok(!existsSync(join(home, 'Library/LaunchAgents/com.agent-board.hub.plist')));
  assert.ok(!existsSync(join(home, 'Library/LaunchAgents/com.agent-board.daemon.plist')));
  assert.ok(!existsSync(join(home, 'Library/LaunchAgents/com.agent-board.session-host.plist')));
  assert.deepEqual(readdirSync(join(home, '.local/bin')), []);
  assert.ok(existsSync(join(home, '.agent-board/hub.db')));
  assert.ok(existsSync(credentials));
  step('解除安裝：移除程式、服務、捷徑，資料預設保留');

  writeFileSync(join(home, '.local/bin/agent-board-hub'), '#!/bin/sh\necho 別人的程式\n');
  const foreign = installer(['hub', ...from, '--no-start']);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.output, /不會覆蓋/);
  rmSync(join(home, '.local/bin/agent-board-hub'));
  step('不會覆蓋別人放在 ~/.local/bin 的同名檔案');

  mustInstall(['hub', ...from, '--no-start']);
  mustInstall(['--uninstall', '--purge']);
  assert.ok(!existsSync(join(home, '.agent-board')));
  step('--purge 連資料一起刪');

  assert.deepEqual(listAgents(), agentsBefore, '真實 LaunchAgents 不可被動到');
  step('這台機器真實的 ~/Library/LaunchAgents 沒有變動');
}

try {
  await main();
  console.log(`通過 ${passed} 項`);
  rmSync(base, { recursive: true, force: true });
} catch (error) {
  console.error(`失敗（已通過 ${passed} 項）：`, error);
  console.error(`保留現場：${base}`);
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
}
