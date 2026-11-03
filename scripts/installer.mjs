// 跨平台安裝邏輯，由 install.sh／install.ps1 呼叫（它們負責檢查 Node、取得發布檔）。
// 只用 node 內建模組。除了 npm ci 下載依賴，不對外連線、不送任何資料；只碰使用者目錄，不需要 root。
//
//   node installer.mjs install hub|daemon --source <解開的發布檔> [選項]
//   node installer.mjs uninstall [--purge]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, isIP } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  renderLaunchd,
  renderSystemd,
  renderWindowsCmd,
  renderWindowsTask,
  servicePath,
} from './lib/service-templates.mjs';

// 只給測試用：在 macOS 上演練 Linux 的流程。正式使用不設。
const platform = process.env.AGENT_BOARD_INSTALL_PLATFORM || process.platform;
const isWindows = platform === 'win32';

const DEFAULT_PORT = 8787;
const HEALTH_TIMEOUT_MS = 20_000;
const ROLES = ['hub', 'daemon'];
const SHIM_MARKER = 'agent-board-shim';
const SHIM_NAMES = ['agent-board-hub', 'agent-board-daemon', 'agent-board-hook'];

const ENTRY = {
  hub: ['hub', 'dist', 'main.mjs'],
  daemon: ['daemon', 'dist', 'index.mjs'],
};
const HOOK_PATH = ['daemon', 'node_modules', '.bin', 'agent-board-hook'];

// 使用者看 README 用什麼語言不一定，跟著系統語系走；不是中文就用英文。
const isZh = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh');
const t = (zh, en) => (isZh ? zh : en);

class InstallError extends Error {}
const fail = (message) => {
  throw new InstallError(message);
};
const say = (message) => console.log(message);

function layout() {
  const home = homedir();
  const root = isWindows
    ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agent-board')
    : join(home, '.local', 'share', 'agent-board');
  return {
    home,
    root,
    app: join(root, 'app'),
    state: join(root, 'install.json'),
    services: join(root, 'services'),
    bin: isWindows ? join(root, 'bin') : join(home, '.local', 'bin'),
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: isWindows && /^(npm)$/.test(command),
    ...options,
  });
}

function onPath(name) {
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // 繼續找
      }
    }
  }
  return null;
}

/**
 * process.execPath 是實際路徑（例如 Homebrew 帶版本號的 Cellar），升級 node 就失效。
 * PATH 上的那支指向同一個檔案時用它，升級後服務還找得到。
 */
function stableNodePath() {
  const found = onPath('node');
  if (found && realpathSync(found) === realpathSync(process.execPath)) return found;
  return process.execPath;
}

function findClaude(options, paths) {
  const explicit = options['claude-bin'] || process.env.AGENT_BOARD_CLAUDE_BIN;
  if (explicit) {
    const absolute = resolve(explicit);
    if (!existsSync(absolute))
      fail(
        t(
          `--claude-bin 指定的檔案不存在：${absolute}`,
          `--claude-bin file does not exist: ${absolute}`,
        ),
      );
    return absolute;
  }
  const found = onPath('claude');
  if (found) return found;
  const names = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [
    join(paths.home, '.local', 'bin'),
    join(paths.home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return fail(
    t(
      '找不到 claude。daemon 要用這台機器上已登入的 Claude Code：請先安裝並執行一次 claude 完成登入，或用 --claude-bin 指定路徑。',
      'Cannot find claude. The daemon uses the logged-in Claude Code on this machine: install it and run claude once to log in, or point to it with --claude-bin.',
    ),
  );
}

function readState(paths) {
  try {
    return JSON.parse(readFileSync(paths.state, 'utf8'));
  } catch {
    return { roles: [] };
  }
}

function writeIfChanged(path, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (existsSync(path) && readFileSync(path).equals(next)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return true;
}

// ── 程式檔 ───────────────────────────────────────────────

/** 回傳 app 內容有沒有變動。一樣就不重裝，服務也不用重啟（重啟會打斷 session）。 */
function installApp(paths, source, stopServices) {
  const buildId = readFileSync(join(source, 'BUILD_ID'), 'utf8').trim();
  const installedId = join(paths.app, 'BUILD_ID');
  if (existsSync(installedId) && readFileSync(installedId, 'utf8').trim() === buildId) {
    say(t('程式已是這個版本，略過安裝。', 'Already on this version, skipping install.'));
    return false;
  }
  const staging = `${paths.app}.new`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(paths.root, { recursive: true });
  cpSync(source, staging, { recursive: true });

  say(t('安裝依賴（npm ci）…', 'Installing dependencies (npm ci)...'));
  const npm = run(
    'npm',
    ['ci', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'],
    { cwd: staging, stdio: 'inherit' },
  );
  if (npm.status !== 0) {
    fail(
      platform === 'linux'
        ? t(
            'npm ci 失敗。Linux 上 node-pty 要現場編譯，請先裝 python3、make、g++（Debian/Ubuntu：sudo apt install build-essential python3），再重跑一次。',
            'npm ci failed. On Linux node-pty is compiled during install: install python3, make and g++ (Debian/Ubuntu: sudo apt install build-essential python3), then run this again.',
          )
        : t(
            'npm ci 失敗，請看上面的訊息。修好後重跑同一個指令即可。',
            'npm ci failed, see the messages above. Fix it and run the same command again.',
          ),
    );
  }
  const probe = run(
    process.execPath,
    [
      '-e',
      "require('node-pty');require('argon2');new (require('better-sqlite3'))(':memory:').close()",
    ],
    { cwd: staging },
  );
  if (probe.status !== 0) {
    fail(
      t(
        `原生模組載入失敗，這個 Node 版本或平台可能不支援：\n${probe.stderr}`,
        `Native modules failed to load. This Node version or platform may not be supported:\n${probe.stderr}`,
      ),
    );
  }

  // Windows 不能換掉執行中程式載入的 .node 檔；其他平台換完再重啟，中斷時間最短。
  if (isWindows) stopServices();
  const old = `${paths.app}.old-${randomBytes(4).toString('hex')}`;
  if (existsSync(paths.app)) renameSync(paths.app, old);
  renameSync(staging, paths.app);
  rmSync(old, { recursive: true, force: true });
  return true;
}

const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

function isOurShim(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return readlinkSync(path).includes('agent-board');
    return readFileSync(path, 'utf8').includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function writeShim(path, content, mode) {
  if (existsSync(path) && !isOurShim(path)) {
    fail(
      t(
        `${path} 已存在且不是 Agent Board 裝的，不會覆蓋。請先移開它。`,
        `${path} already exists and was not installed by Agent Board, so it will not be overwritten. Move it away first.`,
      ),
    );
  }
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function installShims(paths, node) {
  mkdirSync(paths.bin, { recursive: true });
  if (isWindows) {
    // .cmd 用系統碼頁解讀，使用者名稱有中文時不能寫死路徑；一律相對於 shim 自己。
    const relative = (parts) => `%~dp0..\\app\\${parts.join('\\')}`;
    const cmd = (parts) => `@rem ${SHIM_MARKER}\r\n@node "${relative(parts)}" %*\r\n`;
    writeShim(join(paths.bin, 'agent-board-hub.cmd'), cmd(ENTRY.hub), 0o755);
    writeShim(join(paths.bin, 'agent-board-daemon.cmd'), cmd(ENTRY.daemon), 0o755);
    writeShim(join(paths.bin, 'agent-board-hook.cmd'), cmd(HOOK_PATH), 0o755);
    // Claude Code 在 Windows 可能用 Git Bash 跑 hook，bash 不認 .cmd。
    writeShim(
      join(paths.bin, 'agent-board-hook'),
      `#!/bin/sh\n# ${SHIM_MARKER}\nexec node "$(dirname "$0")/../app/${HOOK_PATH.join('/')}" "$@"\n`,
      0o755,
    );
    return;
  }
  const script = (entry) =>
    `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
  writeShim(join(paths.bin, 'agent-board-hub'), script(join(paths.app, ...ENTRY.hub)), 0o755);
  writeShim(join(paths.bin, 'agent-board-daemon'), script(join(paths.app, ...ENTRY.daemon)), 0o755);
  // 專案的 settings.local.json 留有 hook 設定，使用者自己開 claude 時也會呼叫；
  // 放在 PATH 上它會立刻 exit 0（沒有 session 標記），否則每次工具呼叫都噴 exit 127。
  const hook = join(paths.app, ...HOOK_PATH);
  const hookLink = join(paths.bin, 'agent-board-hook');
  if (existsSync(hookLink) || isDanglingLink(hookLink)) {
    if (!isOurShim(hookLink))
      fail(
        t(
          `${hookLink} 已存在且不是 Agent Board 裝的，不會覆蓋。`,
          `${hookLink} already exists and was not installed by Agent Board, so it will not be overwritten.`,
        ),
      );
    unlinkSync(hookLink);
  }
  symlinkSync(hook, hookLink);
}

function isDanglingLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ── 服務 ─────────────────────────────────────────────────

function serviceEnv(role, ctx) {
  const { paths, node, claude, state } = ctx;
  const unixExtra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const env = {
    PATH: servicePath({
      first: [dirname(node), ...(role === 'daemon' && claude ? [dirname(claude)] : [])],
      current: process.env.PATH || '',
      delimiter,
      extra: isWindows ? [] : [paths.bin, ...unixExtra],
      absolute: isAbsolute,
    }),
  };
  if (!isWindows) {
    env.HOME = paths.home;
    // launchd 不帶語系，claude 的中文會變亂碼。
    const lang = process.env.LANG ?? '';
    env.LANG = /utf-?8/i.test(lang) ? lang : platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    if (process.env.SHELL) env.SHELL = process.env.SHELL;
  }
  if (process.env.AGENT_BOARD_DATA_DIR) env.AGENT_BOARD_DATA_DIR = process.env.AGENT_BOARD_DATA_DIR;
  if (role === 'hub') {
    env.AGENT_BOARD_PORT = String(state.port ?? DEFAULT_PORT);
    if (state.host) env.AGENT_BOARD_HOST = state.host;
  } else {
    env.AGENT_BOARD_CLAUDE_BIN = claude;
    if (state.name) env.AGENT_BOARD_MACHINE_NAME = state.name;
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

const dataDir = (paths) => process.env.AGENT_BOARD_DATA_DIR || join(paths.home, '.agent-board');
const logPath = (paths, role) => join(dataDir(paths), 'logs', `${role}.log`);
const launchdLabel = (role) => `com.agent-board.${role}`;
const launchdFile = (paths, role) =>
  join(paths.home, 'Library', 'LaunchAgents', `${launchdLabel(role)}.plist`);
const systemdName = (role) => `agent-board-${role}.service`;
const systemdFile = (paths, role) =>
  join(paths.home, '.config', 'systemd', 'user', systemdName(role));
const taskName = (role) => `AgentBoard-${role}`;

/** 寫服務設定，回傳有沒有變動。 */
function writeService(role, ctx) {
  const { paths, node } = ctx;
  const spec = {
    label: launchdLabel(role),
    description: `Agent Board ${role}`,
    node,
    entry: join(paths.app, ...ENTRY[role]),
    env: serviceEnv(role, ctx),
    workdir: paths.home,
    log: logPath(paths, role),
  };
  // launchd 與 systemd 開 log 檔時資料夾必須已存在。
  mkdirSync(dirname(spec.log), { recursive: true, mode: 0o700 });
  if (platform === 'darwin') return writeIfChanged(launchdFile(paths, role), renderLaunchd(spec));
  if (platform === 'linux') return writeIfChanged(systemdFile(paths, role), renderSystemd(spec));
  const runCmd = join(paths.services, `run-${role}.cmd`);
  const changedCmd = writeIfChanged(runCmd, renderWindowsCmd(spec));
  const task = renderWindowsTask({
    description: spec.description,
    user: `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${userInfo().username}`,
    runCmd,
  });
  const changedTask = writeIfChanged(join(paths.services, `task-${role}.xml`), task);
  return changedCmd || changedTask;
}

const guiDomain = () => `gui/${process.getuid()}`;

function startService(role, ctx, { restart }) {
  const { paths } = ctx;
  if (platform === 'darwin') {
    const target = `${guiDomain()}/${launchdLabel(role)}`;
    const loaded = run('launchctl', ['print', target]).status === 0;
    if (loaded && !restart) return true;
    if (loaded) run('launchctl', ['bootout', target]);
    run('launchctl', ['enable', target]);
    let boot = run('launchctl', ['bootstrap', guiDomain(), launchdFile(paths, role)]);
    // 剛 bootout 完，launchd 還沒收乾淨時會回 5: Input/output error；等一下再試就好。
    for (let retry = 0; loaded && boot.status !== 0 && retry < 3; retry++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
      boot = run('launchctl', ['bootstrap', guiDomain(), launchdFile(paths, role)]);
    }
    if (boot.status !== 0) {
      say(
        t(
          `launchctl bootstrap 失敗（${boot.stderr.trim()}）。常見原因是透過 SSH 執行、沒有圖形登入；設定檔已寫好，下次登入桌面會自動啟動。`,
          `launchctl bootstrap failed (${boot.stderr.trim()}). This usually means you ran this over SSH with no desktop login. The service file is written and starts at the next desktop login.`,
        ),
      );
      return false;
    }
    return true;
  }
  if (platform === 'linux') {
    const systemctl = (...args) => run('systemctl', ['--user', ...args]);
    const reload = systemctl('daemon-reload');
    if (reload.status !== 0) {
      say(
        t(
          `systemctl --user 無法使用（${(reload.stderr || reload.error?.message || '').trim()}）。設定檔已寫好；可改用手動啟動，見 README 疑難排解。`,
          `systemctl --user is unavailable (${(reload.stderr || reload.error?.message || '').trim()}). The service file is written; start it by hand instead, see Troubleshooting in the README.`,
        ),
      );
      return false;
    }
    const start = systemctl('enable', '--now', systemdName(role));
    if (start.status !== 0) {
      say(
        t(
          `無法啟動 ${systemdName(role)}：${start.stderr.trim()}`,
          `Could not start ${systemdName(role)}: ${start.stderr.trim()}`,
        ),
      );
      return false;
    }
    if (restart) systemctl('restart', systemdName(role));
    // 沒有 linger 的話，使用者沒登入時 user service 不會跑，開機也不會起來。
    const linger = run('loginctl', ['enable-linger', userInfo().username]);
    if (linger.status !== 0) {
      say(
        t(
          `提醒：無法開啟 linger，重開機後要登入才會啟動。可手動執行：loginctl enable-linger ${userInfo().username}`,
          `Note: could not enable linger, so services wait for a login after reboot. To enable it by hand: loginctl enable-linger ${userInfo().username}`,
        ),
      );
    }
    return true;
  }
  return startWindowsTask(role, ctx, { restart });
}

function startWindowsTask(role, ctx, { restart }) {
  const { paths } = ctx;
  const name = taskName(role);
  if (restart || run('schtasks', ['/Query', '/TN', name]).status !== 0) {
    run('schtasks', ['/End', '/TN', name]);
    const created = run('schtasks', [
      '/Create',
      '/TN',
      name,
      '/XML',
      join(paths.services, `task-${role}.xml`),
      '/F',
    ]);
    if (created.status !== 0) {
      // 部分環境不准一般使用者建登入觸發的工作：退回啟動資料夾，登入會啟動，但當掉不會重啟。
      const startup = join(
        process.env.APPDATA || join(paths.home, 'AppData', 'Roaming'),
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        `agent-board-${role}.cmd`,
      );
      mkdirSync(dirname(startup), { recursive: true });
      writeFileSync(
        startup,
        `@rem ${SHIM_MARKER}\r\n@start "" /min "${join(paths.services, `run-${role}.cmd`)}"\r\n`,
      );
      say(
        t(
          `無法建立排程工作（${created.stderr.trim()}），改放在啟動資料夾：${startup}。當掉不會自動重啟。`,
          `Could not create the scheduled task (${created.stderr.trim()}). Using the Startup folder instead: ${startup}. It will not restart after a crash.`,
        ),
      );
      run('cmd.exe', ['/c', 'start', '', '/min', join(paths.services, `run-${role}.cmd`)]);
      return true;
    }
  }
  run('schtasks', ['/Run', '/TN', name]);
  return true;
}

function stopService(role) {
  if (platform === 'darwin') {
    run('launchctl', ['bootout', `${guiDomain()}/${launchdLabel(role)}`]);
  } else if (platform === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', systemdName(role)]);
  } else {
    run('schtasks', ['/End', '/TN', taskName(role)]);
  }
}

function removeService(role, paths) {
  stopService(role);
  if (platform === 'darwin') {
    rmSync(launchdFile(paths, role), { force: true });
  } else if (platform === 'linux') {
    rmSync(systemdFile(paths, role), { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else {
    run('schtasks', ['/Delete', '/TN', taskName(role), '/F']);
    const startup = join(
      process.env.APPDATA || join(paths.home, 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      `agent-board-${role}.cmd`,
    );
    rmSync(startup, { force: true });
  }
}

// ── hub 與 daemon 專屬 ───────────────────────────────────

function portIsFree(host, port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen({ host, port }, () => server.close(() => done(true)));
  });
}

async function waitForHub(url) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/auth/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
    } catch {
      // 還沒起來
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

function assertHostAllowed(host) {
  if (host === 'localhost') return;
  if (isIP(host) === 0) fail(t(`--host 要填 IP：${host}`, `--host must be an IP address: ${host}`));
  if (/^(0+\.){3}0+$/.test(host) || host === '::' || /^(0*:)+0*$/.test(host)) {
    fail(
      t(
        `不能監聽所有網卡（${host}）：hub 有整批機器的終端機控制權。請填 127.0.0.1 或私有 IP（例如 Tailscale IP）。`,
        `Refusing to listen on all interfaces (${host}): the hub controls the terminals of all your machines. Use 127.0.0.1 or a private IP, such as a Tailscale IP.`,
      ),
    );
  }
}

function pairDaemon(options, ctx) {
  const { paths, node, claude, state } = ctx;
  const credentials = join(dataDir(paths), 'machine.json');
  if (!options.code) return;
  if (!options.hub)
    fail(
      t(
        '用 --code 配對時也要給 --hub。可以直接複製中控台顯示的網址。',
        '--code also needs --hub. Copy the address shown in the console.',
      ),
    );
  if (existsSync(credentials) && !options.repair) {
    say(
      t(
        `這台機器已配對過（${credentials}），略過配對。要改配對到別的 hub 請加 --repair。`,
        `This machine is already paired (${credentials}), skipping pairing. To pair with another hub, add --repair.`,
      ),
    );
    return;
  }
  const paired = run(
    node,
    [join(paths.app, ...ENTRY.daemon), 'pair', '--hub', options.hub, '--code', options.code],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENT_BOARD_CLAUDE_BIN: claude,
        ...(state.name ? { AGENT_BOARD_MACHINE_NAME: state.name } : {}),
      },
    },
  );
  if (paired.status !== 0)
    fail(
      t(
        '配對失敗，請看上面的訊息。修好後重跑同一個指令即可。',
        'Pairing failed, see the messages above. Fix it and run the same command again.',
      ),
    );
  ctx.justPaired = true;
}

// ── 指令 ─────────────────────────────────────────────────

const INSTALL_OPTIONS = {
  source: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  hub: { type: 'string' },
  code: { type: 'string' },
  name: { type: 'string' },
  'claude-bin': { type: 'string' },
  repair: { type: 'boolean' },
  'no-service': { type: 'boolean' },
  'no-start': { type: 'boolean' },
};

async function install(argv) {
  const { values: options, positionals } = parseArgs({
    args: argv,
    options: INSTALL_OPTIONS,
    allowPositionals: true,
  });
  const role = positionals[0];
  if (!ROLES.includes(role))
    fail(
      t(
        `要指定角色：hub 或 daemon（目前是 ${role ?? '沒有'}）。`,
        `Choose a role: hub or daemon (got ${role ?? 'none'}).`,
      ),
    );
  if (!options.source)
    fail(
      t(
        '缺少 --source。請用 install.sh 或 install.ps1 執行。',
        'Missing --source. Run this through install.sh or install.ps1.',
      ),
    );

  const paths = layout();
  const previous = readState(paths);
  const state = {
    roles: [...new Set([...previous.roles, role])],
    port: previous.port,
    host: previous.host,
    name: previous.name,
    claudeBin: previous.claudeBin,
  };
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      fail(t(`--port 不對：${options.port}`, `Invalid --port: ${options.port}`));
    state.port = port;
  }
  if (options.host !== undefined) {
    assertHostAllowed(options.host);
    state.host = options.host;
  }
  if (options.name !== undefined) state.name = options.name;

  const node = stableNodePath();
  if (/[\\/](\.nvm|\.fnm|fnm|\.volta|\.asdf)[\\/]/.test(node)) {
    say(
      t(
        `提醒：服務會用 ${node}。之後移除這個 Node 版本的話，請重跑一次安裝腳本。`,
        `Note: services will use ${node}. If you remove this Node version later, run the installer again.`,
      ),
    );
  }
  const manageServices = !options['no-service'];
  const activate = manageServices && !options['no-start'];
  const ctx = { paths, node, state, claude: null };
  if (state.roles.includes('daemon')) {
    if (role === 'daemon' || !state.claudeBin) {
      // 上次記下的路徑還在就沿用；claude 搬家了就重新找。
      if (state.claudeBin && existsSync(state.claudeBin)) options['claude-bin'] ??= state.claudeBin;
      ctx.claude = findClaude(options, paths);
      state.claudeBin = ctx.claude;
    } else {
      ctx.claude = state.claudeBin;
    }
  }

  const hubPort = state.port ?? DEFAULT_PORT;
  const hubHost = state.host ?? '127.0.0.1';
  // 自己的 hub 正在用這個埠不算占用；只有第一次裝或換埠才檢查。
  const portMayConflict =
    !previous.roles.includes('hub') ||
    (previous.port ?? DEFAULT_PORT) !== hubPort ||
    (previous.host ?? '127.0.0.1') !== hubHost;
  if (role === 'hub' && portMayConflict && !(await portIsFree(hubHost, hubPort))) {
    fail(
      t(
        `${hubHost}:${hubPort} 已被其他程式使用。請用 --port 換一個。`,
        `${hubHost}:${hubPort} is already in use. Choose another port with --port.`,
      ),
    );
  }

  const appChanged = installApp(paths, options.source, () => {
    if (activate) for (const r of previous.roles) stopService(r);
  });
  installShims(paths, node);
  if (role === 'daemon') pairDaemon(options, ctx);

  const started = {};
  for (const r of state.roles) {
    if (!manageServices) break;
    const serviceChanged = writeService(r, ctx);
    if (activate) {
      const restart = appChanged || serviceChanged || (r === 'daemon' && Boolean(ctx.justPaired));
      started[r] = startService(r, ctx, { restart });
    }
  }
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);

  say('');
  if (!(process.env.PATH || '').split(delimiter).includes(paths.bin)) {
    say(
      t(
        `提醒：${paths.bin} 不在 PATH 上。要直接打 agent-board-daemon，請把它加進 PATH。`,
        `Note: ${paths.bin} is not on your PATH. Add it to run agent-board-daemon directly.`,
      ),
    );
  }
  if (!manageServices) {
    say(
      t(
        `沒有設定開機自動啟動。手動啟動：${join(paths.bin, `agent-board-${role}`)}`,
        `Auto-start was not set up. To start by hand: ${join(paths.bin, `agent-board-${role}`)}`,
      ),
    );
  } else if (!activate) {
    say(
      t(
        '服務設定已寫好，未啟動（--no-start）。',
        'Service files written, not started (--no-start).',
      ),
    );
  }
  if (role === 'hub') {
    const urlHost = hubHost.includes(':') ? `[${hubHost}]` : hubHost;
    const url = `http://${urlHost}:${hubPort}`;
    if (started.hub) {
      const healthy = await waitForHub(url);
      if (!healthy) {
        fail(
          t(
            `hub 沒有在 ${HEALTH_TIMEOUT_MS / 1000} 秒內回應。請看紀錄：${logPath(paths, 'hub')}`,
            `The hub did not respond within ${HEALTH_TIMEOUT_MS / 1000} seconds. See the log: ${logPath(paths, 'hub')}`,
          ),
        );
      }
      say(t(`hub 已啟動：${url}`, `Hub started: ${url}`));
    }
    say(
      t(
        `用瀏覽器打開 ${url} 建立管理員帳號。`,
        `Open ${url} in a browser to create the admin account.`,
      ),
    );
  } else {
    const paired = existsSync(join(dataDir(paths), 'machine.json'));
    if (paired)
      say(
        t(
          `daemon 已安裝並配對。紀錄：${logPath(paths, 'daemon')}`,
          `Daemon installed and paired. Log: ${logPath(paths, 'daemon')}`,
        ),
      );
    else {
      say(
        t(
          'daemon 已安裝，還沒配對。到中控台按「產生配對碼」，執行它顯示的指令。',
          'Daemon installed, not paired yet. In the console, press "Create pairing code" and run the command it shows.',
        ),
      );
      if (started.daemon)
        say(
          t(
            '配對完成後 daemon 會自動連上（最多等 1 分鐘）。',
            'Once paired, the daemon connects by itself within a minute.',
          ),
        );
    }
  }
}

function assertSafeToDelete(path, paths) {
  const resolved = resolve(path);
  if (
    resolved === paths.home ||
    resolved === dirname(resolved) ||
    paths.home.startsWith(resolved)
  ) {
    fail(t(`拒絕刪除 ${resolved}：範圍太大。`, `Refusing to delete ${resolved}: too broad.`));
  }
}

function uninstall(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: { purge: { type: 'boolean' } },
  });
  const paths = layout();
  const state = readState(paths);
  for (const role of ROLES) removeService(role, paths);
  for (const name of SHIM_NAMES) {
    for (const suffix of isWindows ? ['', '.cmd'] : ['']) {
      const shim = join(paths.bin, name + suffix);
      if (isOurShim(shim)) rmSync(shim, { force: true });
    }
  }
  assertSafeToDelete(paths.root, paths);
  // uninstall 可能就是從 app 裡面執行的；Node 已經把程式讀進記憶體，刪掉沒關係。
  process.chdir(paths.home);
  rmSync(paths.root, { recursive: true, force: true });

  const data = dataDir(paths);
  if (options.purge) {
    assertSafeToDelete(data, paths);
    rmSync(data, { recursive: true, force: true });
    say(t(`已移除程式與資料（${data}）。`, `Removed the programs and data (${data}).`));
  } else {
    say(
      t(
        `已移除程式與服務。資料保留在 ${data}；要一起刪請加 --purge。`,
        `Removed the programs and services. Data is kept in ${data}; add --purge to delete it too.`,
      ),
    );
  }
  if (state.roles.includes('daemon')) {
    say(
      t(
        '開過 session 的專案，.claude/settings.local.json 裡還有 agent-board-hook 設定，請手動刪掉那些項目（見 README 解除安裝）。',
        'Projects that had sessions still have agent-board-hook entries in .claude/settings.local.json. Delete them by hand (see Uninstall in the README).',
      ),
    );
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'install') await install(rest);
  else if (command === 'uninstall') uninstall(rest);
  else
    fail(
      t(
        '用法：installer.mjs install hub|daemon [選項]，或 installer.mjs uninstall [--purge]',
        'Usage: installer.mjs install hub|daemon [options], or installer.mjs uninstall [--purge]',
      ),
    );
} catch (error) {
  console.error(
    `${t('安裝失敗', 'Install failed')}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
