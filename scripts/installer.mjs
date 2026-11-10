// 跨平台安裝邏輯，由 install.sh／install.ps1 與自動更新程式（updater.mjs）呼叫。
// 只用 node 內建模組。除了發布檔沒帶這個平台的依賴時用 npm ci 下載，不對外連線、不送任何資料；
// 只碰使用者目錄，不需要 root。
//
//   node installer.mjs install hub|daemon --source <解開的發布檔> [選項]
//   node installer.mjs switch --to <releases 底下的資料夾> [--restore-db <備份檔>]   （更新程式回滾用）
//   node installer.mjs uninstall [--purge]
//
// 配置（CONTRACTS §21.2）：每版一個資料夾 releases/<版本>/，current 指向正在用的那版（Mac／Linux 是 symlink，
// Windows 是 junction），服務與捷徑一律指 current/…，換版只換 current。保留最近 3 版。
// 舊的單一 app/ 第一次執行時搬成 releases/<版本或 0.0.0-legacy>/，app 留成指向 current 的連結
// （舊 session 的 PATH、MCP 設定檔寫的是 app/… 的路徑）。
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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
// 只給測試用：假發布檔沒有原生模組，略過 npm ci、原生模組與 PTY 檢查（scripts/updater.test.mjs）。正式使用不設。
const skipNativeChecks = process.env.AGENT_BOARD_INSTALL_TEST_SKIP_NATIVE === '1';

const DEFAULT_PORT = 8787;
const HEALTH_TIMEOUT_MS = 20_000;
const ROLES = ['hub', 'daemon'];
const SHIM_MARKER = 'agent-board-shim';
const SHIM_NAMES = ['agent-board-hub', 'agent-board-daemon', 'agent-board-hook'];

const ENTRY = {
  hub: ['hub', 'dist', 'main.mjs'],
  daemon: ['daemon', 'dist', 'index.mjs'],
  'session-host': ['session-host', 'dist', 'main.mjs'],
};
/**
 * session host（CONTRACTS §20）：跟著 daemon 角色一起裝的獨立服務，agent 是它的子程序，daemon 重啟時不會結束。
 * 一定要是另一個服務：launchd 停 daemon 會殺掉整個程序群組。順序在 daemon 前面，daemon 起來時它已經在了。
 */
const SESSION_HOST = 'session-host';
const servicesFor = (roles) =>
  roles.flatMap((role) => (role === 'daemon' ? [SESSION_HOST, 'daemon'] : [role]));
const HOOK_PATH = ['daemon', 'node_modules', '.bin', 'agent-board-hook'];

// 使用者看 README 用什麼語言不一定，跟著系統語系走；不是中文就用英文。
const isZh = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh');
const t = (zh, en) => (isZh ? zh : en);

class InstallError extends Error {
  exitCode = 1;
}
/** session 忙碌、這次要換 session host 而中止（什麼都沒改）：更新程式看這個結束碼記成延後（W5）。 */
const EXIT_BUSY = 75;
const fail = (message, exitCode = 1) => {
  const error = new InstallError(message);
  error.exitCode = exitCode;
  throw error;
};
/** 自動更新程式（updater.mjs）呼叫的：不在更新中跑 npm ci（B5）。 */
const fromUpdater = process.env.AGENT_BOARD_UPDATER === '1';
const say = (message) => console.log(message);

function layout() {
  const home = homedir();
  const root = isWindows
    ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agent-board')
    : join(home, '.local', 'share', 'agent-board');
  return {
    home,
    root,
    /** 舊版的單一程式資料夾；搬到 releases 之後留成指向 current 的連結。 */
    app: join(root, 'app'),
    releases: join(root, 'releases'),
    /** 正在用的那一版（連結）。服務、捷徑、hook 路徑都指這裡。 */
    current: join(root, 'current'),
    state: join(root, 'install.json'),
    services: join(root, 'services'),
    // session host 跑的那一份（W1）：和 app 分開，換 app 時不動正在跑的 host 載入的檔案（node-pty、spawn-helper）。
    host: join(root, 'session-host'),
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

// ── 程式檔（releases/<版本> ＋ current） ─────────────────────

/** 保留幾版（current、上一版一定留）。 */
const KEEP_RELEASES = 3;
/** 依賴與原生模組檢查都過了才寫：沒有這個檔的資料夾是半成品。 */
const INSTALLED_MARKER = '.installed';
/** 發布檔裡 node_modules 是哪個平台建的（build-release 寫）；和這台一樣才直接用。 */
const MODULES_PLATFORM_FILE = '.node-modules-platform';
const thisPlatform = () => `${platform === 'win32' ? 'win' : platform}-${process.arch}`;

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const readBuildId = (dir) => {
  try {
    return readFileSync(join(dir, 'BUILD_ID'), 'utf8').trim();
  } catch {
    return null;
  }
};
/** 發布檔的版本（package.json）；舊版發布檔是 0.0.0 或沒有，記成 0.0.0-legacy。 */
const releaseVersion = (dir) => {
  const version = readJsonFile(join(dir, 'package.json'))?.version;
  return typeof version === 'string' && version !== '0.0.0' ? version : '0.0.0-legacy';
};

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** current 指向的 releases 底下的資料夾名稱；沒有回 null。 */
function currentRelease(paths) {
  try {
    const real = realpathSync(paths.current);
    return dirname(real) === realpathSync(paths.releases) ? basename(real) : null;
  } catch {
    return null;
  }
}

/**
 * 把 link 指向 target（資料夾）。Mac／Linux：先建暫時的 symlink 再 rename 蓋過去（原子操作，任何時刻
 * current 都指著一個完整的版本）；目標用相對路徑，整個安裝資料夾搬家也不會斷。
 * Windows：junction 不能 rename 蓋過，先刪再建（有極短的空窗；未在 Windows 實測）。
 */
function pointLink(link, target) {
  if (isWindows) {
    if (existsSync(link) || isLink(link)) rmSync(link, { recursive: false, force: true });
    symlinkSync(target, link, 'junction');
    return;
  }
  const base = dirname(link);
  const relativeTarget = target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target;
  const temp = `${link}.new-${randomBytes(4).toString('hex')}`;
  symlinkSync(relativeTarget, temp);
  renameSync(temp, link);
}

/**
 * 舊配置（單一 app/ 資料夾）第一次遇到新安裝程式：搬成 releases/<版本或 0.0.0-legacy>/、建 current，
 * app 留成指向 current 的連結。正在跑的 hub、daemon 不受影響（檔案沒變，只是換了名字），換版時才重啟。
 */
function migrateLegacyApp(paths, state) {
  let stat;
  try {
    stat = lstatSync(paths.app);
  } catch {
    return;
  }
  if (!stat.isDirectory() || existsSync(paths.current)) return;
  mkdirSync(paths.releases, { recursive: true });
  let name = releaseVersion(paths.app);
  if (existsSync(join(paths.releases, name))) name = `${name}-${randomBytes(3).toString('hex')}`;
  const target = join(paths.releases, name);
  renameSync(paths.app, target);
  writeFileSync(join(target, INSTALLED_MARKER), `${new Date().toISOString()}\n`);
  pointLink(paths.current, target);
  pointLink(paths.app, paths.current);
  state.currentRelease = name;
  state.currentVersion = releaseVersion(target);
  say(
    t(
      `已把舊的程式資料夾搬到 ${target}，current 指向它（app 留成連結）。`,
      `Moved the old program folder to ${target} and pointed current at it (app is kept as a link).`,
    ),
  );
}

const probeNative = (dir) =>
  run(
    process.execPath,
    [
      '-e',
      "require('node-pty');require('argon2');new (require('better-sqlite3'))(':memory:').close()",
    ],
    { cwd: dir },
  );

/** 依賴與原生模組：發布檔帶了這個平台的 node_modules 就先試；載不起來（例如 Node 版本不同）再 npm ci。 */
function installDependencies(dir) {
  if (skipNativeChecks) return;
  const bundled =
    existsSync(join(dir, 'node_modules')) &&
    readJsonFile(join(dir, MODULES_PLATFORM_FILE))?.platform === thisPlatform();
  if (bundled && probeNative(dir).status === 0) return;
  if (fromUpdater) {
    // 自動更新不現場 npm ci（要連 npm registry、原生模組可能要編譯）：hub 只發 ABI 相同的成品，到這裡就是例外。
    fail(
      t(
        `發布檔附的原生模組在這台的 Node（${process.versions.node}，ABI ${process.versions.modules}）載不起來，自動更新不跑 npm ci。請用 install.sh --from 手動安裝。`,
        `The bundled native modules do not load on this Node (${process.versions.node}, ABI ${process.versions.modules}); automatic updates do not run npm ci. Install by hand with install.sh --from.`,
      ),
    );
  }
  if (bundled) {
    say(
      t(
        '發布檔附的原生模組在這個 Node 版本載不起來，改用 npm ci 重新安裝…',
        'The bundled native modules do not load on this Node version; reinstalling with npm ci...',
      ),
    );
  }
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  say(t('安裝依賴（npm ci）…', 'Installing dependencies (npm ci)...'));
  const npm = run(
    'npm',
    ['ci', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'],
    { cwd: dir, stdio: 'inherit' },
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
  const probe = probeNative(dir);
  if (probe.status !== 0) {
    fail(
      t(
        `原生模組載入失敗，這個 Node 版本或平台可能不支援：\n${probe.stderr}`,
        `Native modules failed to load. This Node version or platform may not be supported:\n${probe.stderr}`,
      ),
    );
  }
}

/**
 * 把發布檔裝到 releases/<版本>/（先在 .partial 準備好、依賴與原生模組都過了才改名），再把 current 指過去。
 * current 已經是同一份內容（BUILD_ID 相同）就什麼都不做：服務也不用重啟（重啟會打斷 session）。
 * 同版本但內容不同（從原始碼重建）而且那版正在用：裝到 <版本>+<BUILD_ID 前 8 碼>，不動正在用的那份。
 * 回傳 current 有沒有換。
 */
function installRelease(paths, source, state) {
  const buildId = readBuildId(source);
  const version = releaseVersion(source);
  const active = currentRelease(paths);
  if (active && readBuildId(join(paths.releases, active)) === buildId) {
    say(t('程式已是這個版本，略過安裝。', 'Already on this version, skipping install.'));
    return false;
  }
  mkdirSync(paths.releases, { recursive: true });
  let name = version;
  if (name === active) {
    name = `${version}+${buildId.slice(0, 8)}`;
    say(
      t(`同版本不同內容，裝到 ${name}。`, `Same version, different build: installing as ${name}.`),
    );
  }
  const target = join(paths.releases, name);
  const ready = existsSync(join(target, INSTALLED_MARKER)) && readBuildId(target) === buildId;
  if (!ready) {
    rmSync(target, { recursive: true, force: true });
    const staging = `${target}.partial`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
    installDependencies(staging);
    writeFileSync(join(staging, INSTALLED_MARKER), `${new Date().toISOString()}\n`);
    renameSync(staging, target);
  }
  pointLink(paths.current, target);
  if (active && active !== name) {
    state.previousRelease = active;
    state.previousVersion = releaseVersion(join(paths.releases, active));
  }
  state.currentRelease = name;
  state.currentVersion = version;
  pruneReleases(paths, state);
  return true;
}

/** 只留最近 KEEP_RELEASES 版（依安裝時間）；current 與上一版一定留。 */
function pruneReleases(paths, state) {
  let names;
  try {
    names = readdirSync(paths.releases).filter(
      (name) => !name.startsWith('.') && !name.endsWith('.partial'),
    );
  } catch {
    return;
  }
  const keep = new Set([state.currentRelease, state.previousRelease].filter(Boolean));
  const installedAt = (name) => {
    try {
      return lstatSync(join(paths.releases, name, INSTALLED_MARKER)).mtimeMs;
    } catch {
      return 0;
    }
  };
  const others = names
    .filter((name) => !keep.has(name))
    .sort((a, b) => installedAt(b) - installedAt(a));
  // 清不掉（例如 Windows 檔案被鎖住）就留著，下次再清（W4）。agent 的 PATH 與 MCP 設定檔指的是 current／app，
  // 不會直接參照 releases/<版本>，所以只要 current 與上一版留著，還活著的 agent 不受影響。
  for (const name of others.slice(Math.max(0, KEEP_RELEASES - keep.size))) {
    try {
      rmSync(join(paths.releases, name), { recursive: true, force: true });
    } catch (error) {
      say(
        t(
          `舊版 ${name} 清不掉，下次再清：${error.message}`,
          `Could not remove old release ${name}; will retry next time: ${error.message}`,
        ),
      );
    }
  }
}

/** current 在而 app 不在：補建 app → current（舊 session 的路徑、被手動刪掉的連結，W7）。 */
function ensureAppLink(paths) {
  if (existsSync(paths.app) || isLink(paths.app) || !existsSync(paths.current)) return;
  try {
    pointLink(paths.app, paths.current);
  } catch {
    // 補不了不影響這次安裝
  }
}

/**
 * 停 hub 前一刻備份 hub.db（W3，更新程式帶 --backup-db）：用 current 這版的 better-sqlite3 線上備份（含 WAL），
 * 先用 0600 建空檔再寫進去，做完確認讀得出 schema 版本。失敗就中止（hub 還沒重啟，資料庫沒變）。
 */
function backupHubDb(paths, target) {
  const db = join(dataDir(paths), 'hub.db');
  if (!existsSync(db)) return;
  writeFileSync(target, '', { mode: 0o600, flag: 'wx' });
  const script = `
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
db.backup(process.argv[2]).then(() => {
  db.close();
  const check = new Database(process.argv[2], { readonly: true });
  console.log(check.pragma('user_version', { simple: true }));
  check.close();
}, (error) => { console.error(error.message); process.exit(1); });
`;
  const result = run(process.execPath, ['-e', script, db, target], { cwd: paths.current });
  if (result.status !== 0) {
    rmSync(target, { force: true });
    fail(
      t(
        `備份 hub.db 失敗：${result.stderr.trim()}`,
        `Backing up hub.db failed: ${result.stderr.trim()}`,
      ),
    );
  }
  chmodSync(target, 0o600);
  say(
    t(
      `已備份 hub.db（schema v${result.stdout.trim()}）到 ${target}`,
      `Backed up hub.db (schema v${result.stdout.trim()}) to ${target}`,
    ),
  );
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
    const relative = (parts) => `%~dp0..\\current\\${parts.join('\\')}`;
    const cmd = (parts) => `@rem ${SHIM_MARKER}\r\n@node "${relative(parts)}" %*\r\n`;
    writeShim(join(paths.bin, 'agent-board-hub.cmd'), cmd(ENTRY.hub), 0o755);
    writeShim(join(paths.bin, 'agent-board-daemon.cmd'), cmd(ENTRY.daemon), 0o755);
    writeShim(join(paths.bin, 'agent-board-hook.cmd'), cmd(HOOK_PATH), 0o755);
    // Claude Code 在 Windows 可能用 Git Bash 跑 hook，bash 不認 .cmd。
    writeShim(
      join(paths.bin, 'agent-board-hook'),
      `#!/bin/sh\n# ${SHIM_MARKER}\nexec node "$(dirname "$0")/../current/${HOOK_PATH.join('/')}" "$@"\n`,
      0o755,
    );
    return;
  }
  const script = (entry) =>
    `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
  writeShim(join(paths.bin, 'agent-board-hub'), script(join(paths.current, ...ENTRY.hub)), 0o755);
  writeShim(
    join(paths.bin, 'agent-board-daemon'),
    script(join(paths.current, ...ENTRY.daemon)),
    0o755,
  );
  // 專案的 settings.local.json 留有 hook 設定，使用者自己開 claude 時也會呼叫；
  // 放在 PATH 上它會立刻 exit 0（沒有 session 標記），否則每次工具呼叫都噴 exit 127。
  const hook = join(paths.current, ...HOOK_PATH);
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
      first: [
        dirname(node),
        ...((role === 'daemon' || role === SESSION_HOST) && claude ? [dirname(claude)] : []),
      ],
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
  // 只給測試：縮短更新程式的健康檢查時限（scripts/e2e-update.mjs）。正式使用不設。
  for (const key of ['AGENT_BOARD_UPDATE_HEALTH_MS', 'AGENT_BOARD_UPDATE_CONNECT_MS']) {
    if (role === 'daemon' && process.env[key]) env[key] = process.env[key];
  }
  if (role === 'hub') {
    env.AGENT_BOARD_PORT = String(state.port ?? DEFAULT_PORT);
    if (state.host) env.AGENT_BOARD_HOST = state.host;
  } else if (role === 'daemon') {
    env.AGENT_BOARD_CLAUDE_BIN = claude;
    if (state.name) env.AGENT_BOARD_MACHINE_NAME = state.name;
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    // 連不上 session host 時，daemon 用這個名稱叫服務管理程式把它拉起來（launchctl kickstart 等）。
    env.AGENT_BOARD_SESSION_HOST_SERVICE = serviceName(SESSION_HOST);
    // 自動更新（CONTRACTS §21.3）：daemon 從這裡找 releases、current、install.json。
    env.AGENT_BOARD_INSTALL_ROOT = paths.root;
    // hook 與派工 MCP server 用 current 底下的路徑：node 會把入口的 symlink 解開，不指定的話 daemon 寫進
    // agent 環境（PATH）與 MCP 設定檔的是 releases/<版本>/…，舊版被清掉後還活著的 agent 就找不到。
    env.AGENT_BOARD_HOOK_BIN = join(paths.current, ...HOOK_PATH);
    env.AGENT_BOARD_MCP_SERVER = join(paths.current, 'daemon', 'dist', 'agent-board-mcp.mjs');
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
/** 各平台服務管理程式認得的名稱。 */
const serviceName = (role) =>
  platform === 'darwin'
    ? launchdLabel(role)
    : platform === 'linux'
      ? systemdName(role)
      : taskName(role);

/** 某一份 session host 的檔案：app 裡的新版，或 host 資料夾裡正在跑的那份。 */
const appHostFiles = (base) => ({
  main: join(base, ...ENTRY[SESSION_HOST]),
  meta: join(base, 'session-host', 'dist', 'meta.json'),
  nodePty: join(base, 'node_modules', 'node-pty'),
});
const runningHostFiles = (paths) => ({
  main: join(paths.host, 'dist', 'main.mjs'),
  meta: join(paths.host, 'dist', 'meta.json'),
  nodePty: join(paths.host, 'node_modules', 'node-pty'),
});

/**
 * session host 的版本雜湊（W1）：程式本身、node-pty 的版本、這個平台的原生檔與 spawn-helper。
 * 任何一個變了都要重啟 host 才生效（重啟會結束所有 agent）。
 */
function sessionHostBuild(files) {
  try {
    const hash = createHash('sha256').update(readFileSync(files.main));
    hash.update(JSON.parse(readFileSync(join(files.nodePty, 'package.json'), 'utf8')).version);
    const prebuild = join(files.nodePty, 'prebuilds', `${process.platform}-${process.arch}`);
    for (const name of ['pty.node', 'spawn-helper', 'conpty.node']) {
      const file = join(prebuild, name);
      if (existsSync(file)) hash.update(name).update(readFileSync(file));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** session host 的協定版本（build-release 寫的 meta.json）；讀不到回 null。 */
function sessionHostProtocol(files) {
  try {
    const { protocol } = JSON.parse(readFileSync(files.meta, 'utf8'));
    return Number.isInteger(protocol) ? protocol : null;
  } catch {
    return null;
  }
}

/** 快照記著正在工作（RUN／PERM／PLAN／starting）而且 agent 還在的 session。重啟 host 會把它們結束。 */
const BUSY_STATUSES = ['running', 'waiting_permission', 'plan_review', 'starting'];
function busySessions(paths) {
  const dir = join(dataDir(paths), 'state');
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const busy = [];
  for (const name of names) {
    try {
      const snapshot = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!BUSY_STATUSES.includes(snapshot.status) || !(snapshot.agentPid > 0)) continue;
      process.kill(snapshot.agentPid, 0);
      busy.push(snapshot.sessionId);
    } catch {
      // 壞檔或 agent 已經不在：不算
    }
  }
  return busy;
}

/**
 * 把 app 裡的 session host 複製到它自己的資料夾（連同 node-pty），確認載得起來再換上（W1）。
 * 只在 host 要（重新）啟動時做：換 app 時正在跑的那份完全不動。
 */
function prepareHostRuntime(paths) {
  const source = appHostFiles(paths.current);
  const staging = `${paths.host}.new`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'node_modules'), { recursive: true });
  cpSync(dirname(source.main), join(staging, 'dist'), { recursive: true });
  cpSync(source.nodePty, join(staging, 'node_modules', 'node-pty'), { recursive: true });
  // 不只載入：真的用這份 node-pty 開一個 PTY 跑 echo（spawn-helper 壞掉、權限不對都會在這裡被擋下）。
  const probe = skipNativeChecks
    ? { status: 0 }
    : run(process.execPath, ['-e', PTY_PROBE], { cwd: staging, timeout: 15_000 });
  if (probe.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    fail(
      t(
        `session host 的 node-pty 開不了 PTY，沒有換掉正在跑的 session host：\n${probe.stderr || probe.stdout}`,
        `The session host's node-pty could not open a PTY; the running session host was left alone:\n${probe.stderr || probe.stdout}`,
      ),
    );
  }
  return staging;
}

/** 換上準備好的那份（呼叫前 host 已停）。 */
function swapHostRuntime(paths, staging) {
  const old = `${paths.host}.old-${randomBytes(4).toString('hex')}`;
  if (existsSync(paths.host)) renameSync(paths.host, old);
  renameSync(staging, paths.host);
  rmSync(old, { recursive: true, force: true });
}

/** 在 .new 準備好並實際開過 PTY，通過了才停 host、換資料夾（N3）；檢查失敗 host 不動、中止安裝。 */
function installHostRuntime(paths, { stopRunning = false } = {}) {
  const staging = prepareHostRuntime(paths);
  if (stopRunning) stopService(SESSION_HOST);
  swapHostRuntime(paths, staging);
}

/** 用 node-pty 開 echo，看得到輸出、結束碼 0 才算通過。 */
const PTY_PROBE = `
const pty = require('node-pty');
const win = process.platform === 'win32';
const p = pty.spawn(win ? 'cmd.exe' : '/bin/echo', win ? ['/c', 'echo', 'agent-board-pty-ok'] : ['agent-board-pty-ok'], { cols: 80, rows: 24 });
let out = '';
p.onData((d) => (out += d));
p.onExit(({ exitCode }) => {
  if (exitCode === 0 && out.includes('agent-board-pty-ok')) process.exit(0);
  console.error('PTY 測試失敗：exit ' + exitCode + '，輸出 ' + JSON.stringify(out));
  process.exit(1);
});
setTimeout(() => { console.error('PTY 測試逾時'); process.exit(2); }, 10000);
`;

/** 寫服務設定，回傳有沒有變動。 */
function writeService(role, ctx) {
  const { paths, node } = ctx;
  const spec = {
    label: launchdLabel(role),
    description: `Agent Board ${role}`,
    node,
    entry:
      role === SESSION_HOST ? runningHostFiles(paths).main : join(paths.current, ...ENTRY[role]),
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
    [join(paths.current, ...ENTRY.daemon), 'pair', '--hub', options.hub, '--code', options.code],
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
  // session host 換版要重啟才生效，重啟會結束所有 agent（之後用 --resume 接回）；確認沒有在跑的 session 才加。
  'restart-session-host': { type: 'boolean' },
  // 更新程式用：重啟 hub 前一刻把 hub.db 備份到這個路徑（W3）。
  'backup-db': { type: 'string' },
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
    sessionHostBuild: previous.sessionHostBuild,
    sessionHostProtocol: previous.sessionHostProtocol,
    currentRelease: previous.currentRelease,
    currentVersion: previous.currentVersion,
    previousRelease: previous.previousRelease,
    previousVersion: previous.previousVersion,
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

  // session host 要不要重啟（S1、W1）：協定變了一定要（新 daemon 連不上舊 host），或使用者明確要求。
  // 重啟會結束所有 agent：還有 session 在工作就中止安裝（什麼都還沒動）。
  const hostWanted = manageServices && state.roles.includes('daemon');
  const hostInstalled = existsSync(runningHostFiles(paths).main);
  const newProtocol = sessionHostProtocol(appHostFiles(options.source));
  const protocolChanged =
    hostInstalled && newProtocol !== null && newProtocol !== (state.sessionHostProtocol ?? null);
  const restartHost =
    hostWanted && hostInstalled && (protocolChanged || Boolean(options['restart-session-host']));
  if (restartHost && activate) {
    const busy = busySessions(paths);
    if (busy.length > 0) {
      fail(
        t(
          `session host 需要重啟（${protocolChanged ? `協定從 ${state.sessionHostProtocol ?? '舊版'} 變成 ${newProtocol}` : '加了 --restart-session-host'}），重啟會結束所有 agent，但還有 ${busy.length} 個 session 在工作（RUN／PERM／PLAN／starting）。等它們停下來再執行一次同樣的指令。這次什麼都沒有改。`,
          `The session host must restart (${protocolChanged ? `protocol ${state.sessionHostProtocol ?? 'old'} → ${newProtocol}` : '--restart-session-host'}), which ends every agent, but ${busy.length} session(s) are still working. Run the same command again once they stop. Nothing was changed.`,
        ),
        EXIT_BUSY,
      );
    }
  }

  // 新版裝在自己的資料夾，不會蓋到正在跑的程式載入的檔案（Windows 的 .node 也不會被鎖住），換 current 再重啟。
  migrateLegacyApp(paths, state);
  const appChanged = installRelease(paths, options.source, state);
  // current 換了就先記下來：後面（服務設定、啟動）失敗時，install.json 和實際的 current 也一致。
  if (appChanged) writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  ensureAppLink(paths);
  installShims(paths, node);
  if (role === 'daemon') pairDaemon(options, ctx);

  const started = {};
  let hostUpdatePending = false;
  for (const r of servicesFor(state.roles)) {
    if (!manageServices) break;
    const serviceChanged = writeService(r, ctx);
    // --no-start：服務設定寫好，host 的程式也要在（第一次裝），只是不啟動。
    if (!activate) {
      if (r === SESSION_HOST && !existsSync(runningHostFiles(paths).main)) {
        installHostRuntime(paths);
        state.sessionHostBuild = sessionHostBuild(runningHostFiles(paths));
        state.sessionHostProtocol = sessionHostProtocol(runningHostFiles(paths));
      }
      continue;
    }
    if (r === SESSION_HOST) {
      // session host 不跟著 app 重啟（會結束所有 agent），跑的是自己資料夾裡那份。第一次裝、協定變了、
      // 或加了 --restart-session-host 才換上新版並（重新）啟動；其他時候只確定它在跑。
      if (!hostInstalled || restartHost) {
        installHostRuntime(paths, { stopRunning: hostInstalled });
        state.sessionHostBuild = sessionHostBuild(runningHostFiles(paths));
        state.sessionHostProtocol = sessionHostProtocol(runningHostFiles(paths));
      } else if (
        sessionHostBuild(appHostFiles(paths.current)) !== state.sessionHostBuild ||
        serviceChanged
      ) {
        hostUpdatePending = true;
      }
      started[r] = startService(r, ctx, { restart: false });
      continue;
    }
    const restart = appChanged || serviceChanged || (r === 'daemon' && Boolean(ctx.justPaired));
    if (r === 'hub' && restart && options['backup-db']) backupHubDb(paths, options['backup-db']);
    started[r] = startService(r, ctx, { restart });
  }
  if (hostUpdatePending) {
    say(
      t(
        'session host 有新版，但沒有重啟（重啟會結束所有 session，之後用 --resume 接回）。確認沒有在跑的 session 後，再執行一次同樣的安裝指令並加上 --restart-session-host。',
        'A new session host is installed but was not restarted (restarting ends every session; they come back with --resume). When no session is running, run the same install command again with --restart-session-host.',
      ),
    );
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
  for (const role of servicesFor(ROLES)) removeService(role, paths);
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

/**
 * 把 current 指回 releases 底下已裝好的某一版並重啟 hub、daemon（更新程式的回滾，CONTRACTS §21.3）。
 * --restore-db：先停 hub、用更新前的備份蓋回 hub.db（這次升級改了 schema 時，舊版 hub 開不了新的資料庫）。
 * 目標版的 session host 協定和現在跑的不同：連 session host 一起換回（不然舊 daemon 連不上新 host；
 * 會結束所有 agent，之後照 §3.2 --resume 接回）。不檢查有沒有 session 在工作：回滾時不換的話 agent 一樣接不回。
 */
async function switchRelease(argv) {
  const { values: options } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      'restore-db': { type: 'string' },
      'no-start': { type: 'boolean' },
    },
  });
  const paths = layout();
  const state = { ...readState(paths) };
  const name = options.to;
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.'))
    fail(
      t('要用 --to 指定 releases 底下的資料夾名稱。', '--to must name a folder under releases.'),
    );
  const target = join(paths.releases, name);
  if (!existsSync(join(target, INSTALLED_MARKER)))
    fail(t(`${target} 不是裝好的版本。`, `${target} is not an installed release.`));
  const ctx = { paths, node: stableNodePath(), state, claude: state.claudeBin ?? null };
  const roles = state.roles.filter((r) => ROLES.includes(r));
  const activate = !options['no-start'];

  const restore = options['restore-db'];
  if (restore) {
    if (!existsSync(restore)) fail(t(`找不到備份：${restore}`, `Backup not found: ${restore}`));
    if (activate && roles.includes('hub')) stopService('hub');
    const db = join(dataDir(paths), 'hub.db');
    for (const suffix of ['-wal', '-shm']) rmSync(`${db}${suffix}`, { force: true });
    cpSync(restore, db);
    chmodSync(db, 0o600);
    say(t(`已用 ${restore} 還原 ${db}。`, `Restored ${db} from ${restore}.`));
  }

  const from = currentRelease(paths);
  pointLink(paths.current, target);
  if (from && from !== name) {
    state.previousRelease = from;
    state.previousVersion = releaseVersion(join(paths.releases, from));
  }
  state.currentRelease = name;
  state.currentVersion = releaseVersion(target);

  if (roles.includes('daemon') && existsSync(runningHostFiles(paths).main)) {
    const wanted = sessionHostProtocol(appHostFiles(paths.current));
    if (wanted !== null && wanted !== (state.sessionHostProtocol ?? null)) {
      installHostRuntime(paths, { stopRunning: activate });
      state.sessionHostBuild = sessionHostBuild(runningHostFiles(paths));
      state.sessionHostProtocol = sessionHostProtocol(runningHostFiles(paths));
      if (activate) startService(SESSION_HOST, ctx, { restart: false });
    }
  }
  installShims(paths, ctx.node);
  for (const role of roles) {
    writeService(role, ctx);
    if (activate) startService(role, ctx, { restart: true });
  }
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  say(t(`current 已指向 ${name}。`, `current now points to ${name}.`));
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'install') await install(rest);
  else if (command === 'switch') await switchRelease(rest);
  else if (command === 'uninstall') uninstall(rest);
  else
    fail(
      t(
        '用法：installer.mjs install hub|daemon [選項]、installer.mjs switch --to <版本資料夾>，或 installer.mjs uninstall [--purge]',
        'Usage: installer.mjs install hub|daemon [options], installer.mjs switch --to <release folder>, or installer.mjs uninstall [--purge]',
      ),
    );
} catch (error) {
  console.error(
    `${t('安裝失敗', 'Install failed')}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(error instanceof InstallError ? error.exitCode : 1);
}
