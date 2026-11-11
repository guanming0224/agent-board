// 打包發布檔（CONTRACTS §21.1、§21.10）：release/agent-board-<版本>-<平台>.tar.gz（Windows 是 .zip）與 SHA256SUMS，
// 用 Node ≥22.18 直接跑，不需要 tsx 或 pnpm。平台是建置這台機器的平台（darwin-arm64、win-x64…）：
// 發布檔**自帶固定版本的官方 Node**（runtime/node，版本＝package.json 的 bundledNode，從 nodejs.org 下載並用
// 官方 SHASUMS256.txt 驗證，快取在 release/.node-cache/），另附這個平台的 node_modules（node-pty、better-sqlite3、
// argon2 的原生檔）——**用自帶的 node 跑 npm ci**，原生模組的 ABI 一定和自帶的 Node 相同，和建置機的系統 Node
// 版本無關；裝完再用自帶的 node 實際載入一次，載不起來就失敗，不會產出 ABI 不合的發布檔。
// GitHub Actions 在 macos-14 與 windows-latest 各建一份。
// 目錄結構刻意和 monorepo 對齊，功能程式碼裡的相對路徑才不用改：
//   hub/dist/main.mjs    → ../../web/dist（server.ts 找前端）
//   daemon/dist/index.mjs → ../node_modules/.bin/agent-board-hook（useBundledHook 找 hook）
//   daemon/dist/agent-board-hook.cjs（hook 本體；.bin 裡的 agent-board-hook 是用自帶 node 執行它的小包裝）
//   daemon/dist/deepSearchWorker.mjs（深層搜尋的 worker_threads 入口，和 index.mjs 同資料夾）
//   session-host/dist/main.mjs、meta.json（session host 服務與協定版本，CONTRACTS §20；安裝時連同 node-pty
//   與 runtime/node 複製到自己的資料夾跑，換 app 時不動它）
//   runtime/node/bin/node（Windows runtime/node/node.exe）與它的 LICENSE
// 那個 .bin 只放 hook：daemon 會把它所在資料夾加進 PTY 的 PATH，不能混進別的執行檔。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import {
  bundleOptions,
  collectShipped,
  lockfilePackages,
  missingNotices,
  RUNTIME_DEPS,
} from './release-shipped.mjs';
import { bundledNodeVersion, extractNode, fetchNode } from './fetch-node.mjs';
import { hookWrapperCmd, hookWrapperSh } from './lib/bundled-node.mjs';

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'release');
const stage = join(outDir, 'agent-board');

const installedVersion = (pkg, dep) => {
  const require = createRequire(join(root, 'packages', pkg, 'package.json'));
  // 有些套件的 exports 不開放 package.json，改從進入點往上找。
  let dir = dirname(require.resolve(dep));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === dep) return manifest.version;
    } catch {
      // 這層沒有 package.json，繼續往上
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`找不到 ${dep} 的版本`);
    dir = parent;
  }
};

/** 打包 hub、daemon、hook、派工 MCP server；回傳 metafile，檢查 notices 時要知道打包進去哪些套件。 */
async function bundleAll() {
  const metafiles = {};
  for (const [name, options] of Object.entries(bundleOptions(root, stage))) {
    metafiles[name] = (await build({ ...options, metafile: true })).metafile;
  }
  const hook = bundleOptions(root, stage).hook.outfile;
  writeHookWrappers();
  const code = readFileSync(hook, 'utf8');
  for (const banned of ['zod', 'require("@agent-board']) {
    if (code.includes(banned)) throw new Error(`hook 打包結果不該含有 ${banned}`);
  }
  // 派工 MCP server 也只能有 node 內建模組（claude 每開一個 session 就啟動一次）。
  const mcp = readFileSync(bundleOptions(root, stage).mcp.outfile, 'utf8');
  if (mcp.includes('zod')) throw new Error('派工 MCP server 打包結果不該含有 zod');
  // 安裝程式比對協定版本決定要不要重啟 host（協定變了，新 daemon 連不上舊 host）。
  const protocol = Number(
    /SESSION_HOST_PROTOCOL = (\d+)/.exec(
      readFileSync(join(root, 'packages/protocol/src/sessionHost.ts'), 'utf8'),
    )?.[1],
  );
  if (!Number.isInteger(protocol)) throw new Error('讀不到 SESSION_HOST_PROTOCOL');
  writeFileSync(
    join(dirname(bundleOptions(root, stage).sessionHost.outfile), 'meta.json'),
    `${JSON.stringify({ protocol })}\n`,
  );
  // session host 不懂畫面、不連網路：不該打包進 xterm 或 ws。
  const host = readFileSync(bundleOptions(root, stage).sessionHost.outfile, 'utf8');
  // 只看模組名稱（帶引號）：protocol 的註解裡有提到 @xterm 的字樣。
  for (const banned of ['"@xterm/', "'@xterm/", '"ws"', "'ws'"]) {
    if (host.includes(banned)) throw new Error(`session host 打包結果不該含有 ${banned}`);
  }
  await checkSearchWorker();
  return { metafiles, hookBytes: statSync(hook).size };
}

/**
 * daemon/node_modules/.bin/agent-board-hook：Claude Code／Codex 依 PATH 找到它，它再用發布檔自帶的 node
 * 執行 daemon/dist/agent-board-hook.cjs（CONTRACTS §21.10）。不靠 `#!/usr/bin/env node`：agent 的 PATH 上的
 * node 是使用者自己的（不把自帶的 node 放進 agent 的 PATH，免得 agent 跑專案時用錯 Node）。
 * 自帶的不在（例如開發時複製出來的舊配置）才退回 PATH 上的 node。$0 是 PATH 找到的完整路徑；
 * ~/.local/bin 的捷徑是 exec 這支的 shell 腳本，不是 symlink，所以相對路徑不會算錯。
 */
function writeHookWrappers() {
  const bin = join(stage, 'daemon', 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const sh = join(bin, 'agent-board-hook');
  writeFileSync(sh, hookWrapperSh());
  chmodSync(sh, 0o755);
  // Windows 上 Claude Code 可能用 cmd 或 Git Bash 跑 hook，兩個都要找得到（未在 Windows 實測）。
  writeFileSync(`${sh}.cmd`, hookWrapperCmd());
}

/**
 * 深層搜尋的 worker 要和 daemon/dist/index.mjs 放在一起，而且打包後真的起得來（回 ready）：
 * 少了或壞了 daemon 不會掛，只會退回主執行緒掃（大檔會卡 PTY 轉送），所以在這裡擋。
 */
async function checkSearchWorker() {
  const file = bundleOptions(root, stage).daemonSearchWorker.outfile;
  if (dirname(file) !== dirname(bundleOptions(root, stage).daemon.outfile)) {
    throw new Error('深層搜尋 worker 要和 daemon/dist/index.mjs 在同一個資料夾');
  }
  const worker = new Worker(file);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('深層搜尋 worker 10 秒內沒有 ready')),
        10_000,
      );
      worker.once('message', (reply) => {
        clearTimeout(timer);
        if (reply?.type === 'ready') resolve();
        else reject(new Error(`深層搜尋 worker 回了 ${JSON.stringify(reply)}`));
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await worker.terminate();
  }
}

/** 實際散布的第三方套件（打包進去的、npm ci 會裝的）都要在 THIRD_PARTY_NOTICES.md 裡。 */
async function checkNotices(metafiles) {
  const { found, unknownWebSources } = await collectShipped(root, metafiles);
  const shipped = [...found.values(), ...lockfilePackages(join(stage, 'package-lock.json'))];
  const problems = missingNotices(
    readFileSync(join(stage, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    shipped,
  );
  for (const source of unknownWebSources) problems.push(`網頁打包裡有不明來源：${source}`);
  if (problems.length) {
    throw new Error(
      `THIRD_PARTY_NOTICES.md 不完整，先跑 corepack pnpm notices：\n  ${problems.join('\n  ')}`,
    );
  }
  return found.size;
}

function buildWeb() {
  execFileSync('corepack', ['pnpm', '--filter', '@agent-board/web', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  cpSync(join(root, 'packages/web/dist'), join(stage, 'web/dist'), { recursive: true });
}

function copyInstallFiles() {
  mkdirSync(join(stage, 'scripts'), { recursive: true });
  for (const file of [
    'install.sh',
    'install.ps1',
    'installer.mjs',
    'updater.mjs',
    'fix-node-pty.mjs',
  ]) {
    cpSync(join(root, 'scripts', file), join(stage, 'scripts', file));
  }
  cpSync(join(root, 'scripts/lib'), join(stage, 'scripts/lib'), { recursive: true });
  for (const dir of ['launchd', 'systemd', 'windows']) {
    cpSync(join(root, 'deploy', dir), join(stage, 'deploy', dir), { recursive: true });
  }
  cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));
}

function writeManifest() {
  const { version, license, engines } = JSON.parse(readFileSync(join(root, 'package.json')));
  const dependencies = {};
  for (const [pkg, deps] of Object.entries(RUNTIME_DEPS)) {
    for (const dep of deps) dependencies[dep] = installedVersion(pkg, dep);
  }
  const manifest = {
    name: 'agent-board-release',
    version,
    private: true,
    license,
    engines,
    scripts: { postinstall: 'node scripts/fix-node-pty.mjs' },
    dependencies,
  };
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // 鎖定間接依賴，安裝時用 npm ci。
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' },
  );
}

/** 內容沒變就不必重裝、重啟服務（installer.mjs 比對這個值）。 */
function writeBuildId(nodeVersion) {
  const hash = createHash('sha256');
  // 自帶 Node 在算完之後才放進來（兩個平台的執行檔不同），版本號要算進去：只換 Node 也是新的內容。
  hash.update(`bundledNode:${nodeVersion}\n`);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        hash.update(relative(stage, path).replaceAll('\\', '/'));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(stage);
  writeFileSync(join(stage, 'BUILD_ID'), `${hash.digest('hex')}\n`);
}

/** 這台機器的平台字串，和 protocol 的 platformKey 一樣（win32 寫成 win）。 */
const platformKey = () =>
  `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

/** 系統 npm 的 npm-cli.js（官方 Node 成品裡沒有 npm 時的退路）：一樣用自帶的 node 執行它。 */
function npmCli() {
  const candidates = [
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  try {
    const npm = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['npm'], {
      encoding: 'utf8',
    })
      .split(/\r?\n/)[0]
      .trim();
    if (npm) {
      const real = realpathSync(npm);
      if (real.endsWith('.js')) candidates.push(real);
      candidates.push(join(dirname(real), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
      candidates.push(join(dirname(real), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  } catch {
    // 找不到 npm：用上面的候選
  }
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('找不到 npm 的 npm-cli.js，無法用自帶的 node 跑 npm ci');
  return found;
}

/**
 * 自帶 Node：下載（或用快取）官方成品、驗 SHASUMS256，放進 runtime/node，再用它本身確認版本與 ABI。
 * 建置機的系統 Node 主版本不同也沒關係：後面的 npm ci 與原生模組檢查都用這支跑。
 */
async function bundleNode(version) {
  const archive = await fetchNode(version, platformKey());
  // 官方成品自帶的 npm 放到快取旁（不進發布檔），npm ci 用它跑；沒有才退回系統的 npm。
  const npmDir = join(outDir, '.node-cache', `v${version}`, `npm-${platformKey()}`);
  const { node, npmCli: bundledNpm } = extractNode(archive, version, platformKey(), stage, npmDir);
  const reported = execFileSync(
    node,
    ['-p', 'process.versions.node + " " + process.versions.modules'],
    {
      encoding: 'utf8',
    },
  ).trim();
  const [actual, abi] = reported.split(' ');
  if (actual !== version) throw new Error(`自帶的 node 回報版本 ${actual}，預期 ${version}`);
  if (process.versions.node.split('.')[0] !== version.split('.')[0]) {
    console.log(
      `建置機的系統 Node 是 ${process.versions.node}，自帶的是 ${version}：npm ci 與原生模組檢查一律用自帶的跑。`,
    );
  }
  return { node, version, abi, npmCli: bundledNpm };
}

/** 子程序的環境：PATH 最前面放自帶 node 的資料夾。Windows 的環境變數不分大小寫，先刪掉 Path 再設 PATH。 */
function envWithNodeFirst(node) {
  const env = { ...process.env };
  let current = '';
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') {
      current ||= env[key] ?? '';
      delete env[key];
    }
  }
  env.PATH = `${dirname(node)}${delimiter}${current}`;
  return env;
}

/**
 * 執行依賴裝進發布檔（npm ci --omit=dev，跑 postinstall 修 spawn-helper 權限），**用自帶的 node 跑**，
 * 原生模組（prebuild 下載或現場編譯）都是自帶 Node 的 ABI；裝完用自帶的 node 實際載入並開一次 PTY，
 * 失敗就中止建置。記下平台、Node 版本、ABI 與 bundledNode。
 * BUILD_ID 在這之前算：內容雜湊只看我們自己的檔案，兩個平台的發布檔是同一個 BUILD_ID。
 */
function bundleDependencies(runtime) {
  execFileSync(
    runtime.node,
    [
      runtime.npmCli ?? npmCli(),
      'ci',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--loglevel=error',
    ],
    {
      cwd: stage,
      stdio: 'inherit',
      // 安裝腳本裡的 node（prebuild-install、node-gyp、postinstall）也要是自帶的那支。
      env: { ...envWithNodeFirst(runtime.node), npm_node_execpath: runtime.node },
    },
  );
  const probe = `
const pty = require('node-pty');
require('argon2');
new (require('better-sqlite3'))(':memory:').close();
const win = process.platform === 'win32';
const p = pty.spawn(win ? 'cmd.exe' : '/bin/echo', win ? ['/c', 'echo', 'ok'] : ['ok'], { cols: 80, rows: 24 });
p.onExit(({ exitCode }) => process.exit(exitCode));
setTimeout(() => process.exit(3), 10000);
`;
  try {
    execFileSync(runtime.node, ['-e', probe], { cwd: stage, stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `原生模組用自帶的 node ${runtime.version}（ABI ${runtime.abi}）載不起來，不產出發布檔：${error.stderr ?? error.message}`,
    );
  }
  writeFileSync(
    join(stage, '.node-modules-platform'),
    `${JSON.stringify({ platform: platformKey(), node: runtime.version, modules: runtime.abi, bundledNode: true })}\n`,
  );
}

/** 成品檔名：agent-board-<版本>-<平台>.tar.gz（Windows .zip，Windows 10 以上內建的 tar 解得開）。 */
function packArchive() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const platform = platformKey();
  const name = `agent-board-${version}-${platform}.${platform.startsWith('win-') ? 'zip' : 'tar.gz'}`;
  const archive = join(outDir, name);
  // bsdtar（macOS、Windows）用 -a 依副檔名選格式；GNU tar 只建 tar.gz。
  const args = name.endsWith('.zip')
    ? ['-a', '-cf', name, 'agent-board']
    : ['-czf', name, 'agent-board'];
  execFileSync('tar', args, { cwd: outDir, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  // sha256sum 的格式，GitHub Release 上兩個平台的 job 各自產一份，release.yml 合併成一個 SHA256SUMS。
  writeFileSync(join(outDir, 'SHA256SUMS'), `${digest}  ${name}\n`);
  // 一行安裝指令直接下載這兩支，要和發布檔一起上傳。
  for (const file of ['install.sh', 'install.ps1']) {
    cpSync(join(root, 'scripts', file), join(outDir, file));
  }
  return { archive, bytes: statSync(archive).size };
}

// release/.node-cache（自帶 Node 的官方成品快取）留著，其他清掉。
mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name !== '.node-cache') rmSync(join(outDir, name), { recursive: true, force: true });
}
mkdirSync(stage, { recursive: true });
const nodeVersion = bundledNodeVersion();
buildWeb();
const { metafiles, hookBytes } = await bundleAll();
copyInstallFiles();
writeManifest();
const noticed = await checkNotices(metafiles);
writeBuildId(nodeVersion);
const runtime = await bundleNode(nodeVersion);
bundleDependencies(runtime);
const { archive, bytes } = packArchive();
console.log(`自帶 Node ${runtime.version}（ABI ${runtime.abi}）`);
console.log(`hook ${hookBytes} bytes`);
console.log(`THIRD_PARTY_NOTICES.md 涵蓋 ${noticed} 個散布的套件`);
console.log(`${relative(root, archive)} ${(bytes / 1024 / 1024).toFixed(1)} MB`);
