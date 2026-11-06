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
import {
  bundleOptions,
  collectShipped,
  lockfilePackages,
  missingNotices,
  RUNTIME_DEPS,
} from './release-shipped.mjs';

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
  chmodSync(hook, 0o755);
  // Windows 上 Claude Code 可能用 cmd 或 Git Bash 跑 hook，兩個都要找得到。
  writeFileSync(`${hook}.cmd`, '@node "%~dp0agent-board-hook" %*\r\n');
  const code = readFileSync(hook, 'utf8');
  for (const banned of ['zod', 'require("@agent-board']) {
    if (code.includes(banned)) throw new Error(`hook 打包結果不該含有 ${banned}`);
  }
  // 派工 MCP server 也只能有 node 內建模組（claude 每開一個 session 就啟動一次）。
  const mcp = readFileSync(bundleOptions(root, stage).mcp.outfile, 'utf8');
  if (mcp.includes('zod')) throw new Error('派工 MCP server 打包結果不該含有 zod');
  return { metafiles, hookBytes: statSync(hook).size };
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
const { metafiles, hookBytes } = await bundleAll();
copyInstallFiles();
writeManifest();
const noticed = await checkNotices(metafiles);
writeBuildId();
const { tarball, bytes } = packTarball();
console.log(`hook ${hookBytes} bytes`);
console.log(`THIRD_PARTY_NOTICES.md 涵蓋 ${noticed} 個散布的套件`);
console.log(`${relative(root, tarball)} ${(bytes / 1024 / 1024).toFixed(1)} MB`);
