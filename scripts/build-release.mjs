// 打包發布檔：release/agent-board.tar.gz，用 Node ≥22.18 直接跑，不需要 tsx 或 pnpm。
// 目錄結構刻意和 monorepo 對齊，功能程式碼裡的相對路徑才不用改：
//   hub/dist/main.mjs    → ../../web/dist（server.ts 找前端）
//   daemon/dist/index.mjs → ../node_modules/.bin/agent-board-hook（useBundledHook 找 hook）
// 那個 .bin 只放 hook：daemon 會把它所在資料夾加進 PTY 的 PATH，不能混進別的執行檔。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outDir = join(root, 'release');
const stage = join(outDir, 'agent-board');

// 原生模組不能打包。兩個 xterm 套件是 session.ts 用 createRequire 在執行期載入的，esbuild 看不到。
const RUNTIME_DEPS = {
  daemon: ['node-pty', '@xterm/headless', '@xterm/addon-serialize'],
  hub: ['better-sqlite3', 'argon2'],
};

// ESM 輸出裡的 CJS 依賴會 require node 內建模組，需要一個真的 require。
const ESM_BANNER = [
  "import { createRequire as __abCreateRequire } from 'node:module';",
  'const require = __abCreateRequire(import.meta.url);',
].join('\n');

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

async function bundleServices() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22.18',
    format: 'esm',
    legalComments: 'none',
    banner: { js: ESM_BANNER },
    logLevel: 'warning',
  };
  await build({
    ...common,
    entryPoints: [join(root, 'packages/hub/src/main.ts')],
    outfile: join(stage, 'hub/dist/main.mjs'),
    external: RUNTIME_DEPS.hub,
  });
  await build({
    ...common,
    entryPoints: [join(root, 'packages/daemon/src/index.ts')],
    outfile: join(stage, 'daemon/dist/index.mjs'),
    external: RUNTIME_DEPS.daemon,
  });
}

/** hook 跑在每次工具呼叫的路徑上：CJS、不帶 banner、只有 node 內建模組。 */
async function bundleHook() {
  const binDir = join(stage, 'daemon/node_modules/.bin');
  const hook = join(binDir, 'agent-board-hook');
  await build({
    bundle: true,
    platform: 'node',
    target: 'node22.18',
    format: 'cjs',
    legalComments: 'none',
    minify: true,
    logLevel: 'warning',
    entryPoints: [join(root, 'packages/hook/src/cli.ts')],
    outfile: hook,
  });
  chmodSync(hook, 0o755);
  // Windows 上 Claude Code 可能用 cmd 或 Git Bash 跑 hook，兩個都要找得到。
  writeFileSync(`${hook}.cmd`, '@node "%~dp0agent-board-hook" %*\r\n');
  const code = readFileSync(hook, 'utf8');
  for (const banned of ['zod', 'require("@agent-board']) {
    if (code.includes(banned)) throw new Error(`hook 打包結果不該含有 ${banned}`);
  }
  return statSync(hook).size;
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
  for (const file of ['install.sh', 'install.ps1', 'installer.mjs', 'fix-node-pty.mjs']) {
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
function writeBuildId() {
  const hash = createHash('sha256');
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

function packTarball() {
  const tarball = join(outDir, 'agent-board.tar.gz');
  execFileSync('tar', ['-czf', 'agent-board.tar.gz', 'agent-board'], {
    cwd: outDir,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${digest}  agent-board.tar.gz\n`);
  // 一行安裝指令直接下載這兩支，要和發布檔一起上傳。
  for (const file of ['install.sh', 'install.ps1']) {
    cpSync(join(root, 'scripts', file), join(outDir, file));
  }
  return { tarball, bytes: statSync(tarball).size };
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
buildWeb();
await bundleServices();
const hookBytes = await bundleHook();
copyInstallFiles();
writeManifest();
writeBuildId();
const { tarball, bytes } = packTarball();
console.log(`hook ${hookBytes} bytes`);
console.log(`${relative(root, tarball)} ${(bytes / 1024 / 1024).toFixed(1)} MB`);
