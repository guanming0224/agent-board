// 發布檔實際帶出去的第三方套件。build-release（打包與檢查）和 third-party-notices（產生）共用，
// 兩邊看到的清單才會一致。這支不進發布檔（scripts/lib 才會被複製進去）。
//   1. esbuild 打包進 hub、daemon、hook 的套件：看 metafile。
//   2. vite 打包進網頁的套件：另外帶 sourcemap 建一次，看 sources。
//   3. 安裝時 npm ci 裝的執行依賴：RUNTIME_DEPS 和它們的間接依賴（發布檔的 package-lock.json）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';

// 原生模組不能打包。兩個 xterm 套件是 session.ts 用 createRequire 在執行期載入的，esbuild 看不到。
export const RUNTIME_DEPS = {
  daemon: ['node-pty', '@xterm/headless', '@xterm/addon-serialize'],
  hub: ['better-sqlite3', 'argon2'],
};

// ESM 輸出裡的 CJS 依賴會 require node 內建模組，需要一個真的 require。
const ESM_BANNER = [
  "import { createRequire as __abCreateRequire } from 'node:module';",
  'const require = __abCreateRequire(import.meta.url);',
].join('\n');

/** 四個打包檔（hub、daemon、hook、派工 MCP server）的 esbuild 設定。 */
export function bundleOptions(root, stage) {
  const service = {
    bundle: true,
    platform: 'node',
    target: 'node22.18',
    format: 'esm',
    legalComments: 'none',
    banner: { js: ESM_BANNER },
    logLevel: 'warning',
  };
  return {
    hub: {
      ...service,
      entryPoints: [join(root, 'packages/hub/src/main.ts')],
      outfile: join(stage, 'hub/dist/main.mjs'),
      external: RUNTIME_DEPS.hub,
    },
    daemon: {
      ...service,
      entryPoints: [join(root, 'packages/daemon/src/index.ts')],
      outfile: join(stage, 'daemon/dist/index.mjs'),
      external: RUNTIME_DEPS.daemon,
    },
    // hook 跑在每次工具呼叫的路徑上：CJS、不帶 banner、只有 node 內建模組。
    hook: {
      bundle: true,
      platform: 'node',
      target: 'node22.18',
      format: 'cjs',
      legalComments: 'none',
      minify: true,
      logLevel: 'warning',
      entryPoints: [join(root, 'packages/hook/src/cli.ts')],
      outfile: join(stage, 'daemon/node_modules/.bin/agent-board-hook'),
    },
    // 派工工具的 MCP server（CONTRACTS §11）：claude 用 daemon 的 node 執行。只有 node 內建模組。
    // 放在 daemon/dist、不放 .bin：.bin 會加進 PTY 的 PATH，只能有 hook。
    mcp: {
      bundle: true,
      platform: 'node',
      target: 'node22.18',
      format: 'esm',
      legalComments: 'none',
      logLevel: 'warning',
      entryPoints: [join(root, 'packages/hook/src/mcp.ts')],
      outfile: join(stage, 'daemon/dist/agent-board-mcp.mjs'),
    },
  };
}

/** 檔案所屬的 node_modules 套件；不在 node_modules 底下（自己的原始碼）回傳 null。 */
export function packageOf(file) {
  const parts = resolve(file).split(sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const depth = parts[at + 1].startsWith('@') ? 2 : 1;
  const dir = parts.slice(0, at + 1 + depth).join(sep);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version, dir: realpathSync(dir) };
}

function add(found, pkg, via) {
  const key = `${pkg.name}@${pkg.version}`;
  const entry = found.get(key) ?? { ...pkg, via: new Set() };
  entry.via.add(via);
  found.set(key, entry);
}

/** 從 esbuild metafile 找出打包進去的套件。 */
export function addFromMetafile(found, metafile, via) {
  for (const input of Object.keys(metafile.inputs)) {
    const file = resolve(input);
    if (!existsSync(file)) continue; // esbuild 的虛擬模組
    const pkg = packageOf(file);
    if (pkg) add(found, pkg, via);
  }
}

/** 不寫檔，重跑一次三個打包，只取 metafile。 */
export async function addBundled(found, root) {
  for (const [name, options] of Object.entries(bundleOptions(root, join(tmpdir(), 'ab-unused')))) {
    const result = await build({ ...options, write: false, metafile: true });
    addFromMetafile(found, result.metafile, `${name} bundle`);
  }
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else yield path;
  }
}

/**
 * vite 帶 sourcemap 另建一次到暫存資料夾，從 sources 找出打包進去的套件。
 * 不在 node_modules 的來源只能是自己的程式碼；其他的（例如 vite 注入的 helper）回傳在 unknown，
 * 由呼叫端決定要不要擋。
 */
export function addWeb(found, root) {
  const out = mkdtempSync(join(tmpdir(), 'ab-web-map-'));
  const unknown = new Set();
  try {
    execFileSync(
      'corepack',
      [
        'pnpm',
        '--filter',
        '@agent-board/web',
        'exec',
        'vite',
        'build',
        '--sourcemap',
        '--outDir',
        out,
        '--emptyOutDir',
        '--logLevel',
        'error',
      ],
      { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' },
    );
    for (const file of walkFiles(out)) {
      if (!file.endsWith('.map')) continue;
      const map = JSON.parse(readFileSync(file, 'utf8'));
      const base = resolve(dirname(file), map.sourceRoot ?? '');
      for (const source of map.sources) {
        const path = resolve(base, source);
        if (existsSync(path)) {
          const pkg = packageOf(path);
          if (pkg) add(found, pkg, 'web bundle');
          else if (!path.startsWith(join(root, 'packages') + sep)) unknown.add(source);
        } else {
          unknown.add(source);
        }
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return [...unknown];
}

/** 套件宣告的依賴（含 optional；沒裝到的是其他平台的）一路往下都加進來。 */
function addDependencies(found, dir, via, seen = new Set()) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const require = createRequire(join(dir, 'package.json'));
  const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const dep of Object.keys(deps)) {
    const next = installedDir(require, dep);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    const pkg = JSON.parse(readFileSync(join(next, 'package.json'), 'utf8'));
    add(found, { name: pkg.name, version: pkg.version, dir: next }, via);
    addDependencies(found, next, via, seen);
  }
}

/**
 * 有些套件發布的是自己預先打包好的檔案（例如 glob 的 index.min.js 內含 minimatch、lru-cache），
 * metafile 只看得到外層套件。所以打包進去的套件，宣告的依賴也一律列入（可能多列，不會漏列）。
 */
export function addBundledDependencies(found) {
  for (const entry of [...found.values()]) {
    if ([...entry.via].some((via) => via.endsWith('bundle'))) {
      addDependencies(found, entry.dir, `dependency of ${entry.name}`);
    }
  }
}

/** pnpm 安裝的 RUNTIME_DEPS 和它們的間接依賴，對應發布檔裡 npm ci 會裝的。 */
export function addRuntime(found, root) {
  for (const [pkg, deps] of Object.entries(RUNTIME_DEPS)) {
    const require = createRequire(join(root, 'packages', pkg, 'package.json'));
    for (const dep of deps) {
      const dir = installedDir(require, dep);
      if (!dir) throw new Error(`找不到 ${dep}，先跑 corepack pnpm install`);
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      add(found, { name: manifest.name, version: manifest.version, dir }, 'npm ci');
      addDependencies(found, dir, 'npm ci');
    }
  }
}

/**
 * 全部散布出去的套件。metafiles 給了就用 build-release 剛打包的結果，沒給就重新打包一次（不寫檔）。
 * 回傳 { found: Map<"name@version", {name, version, dir, via}>, unknownWebSources }。
 */
export async function collectShipped(root, metafiles) {
  const found = new Map();
  if (metafiles) {
    for (const [name, metafile] of Object.entries(metafiles)) {
      addFromMetafile(found, metafile, `${name} bundle`);
    }
  } else {
    await addBundled(found, root);
  }
  const unknownWebSources = addWeb(found, root);
  addBundledDependencies(found);
  addRuntime(found, root);
  return { found, unknownWebSources };
}

/** 照 node 的解析順序往上找 node_modules/<dep>；exports 不開放 package.json 也找得到。 */
function installedDir(require, dep) {
  for (const base of require.resolve.paths(dep) ?? []) {
    const dir = join(base, ...dep.split('/'));
    if (existsSync(join(dir, 'package.json'))) return realpathSync(dir);
  }
  return null;
}

/** 發布檔 package-lock.json 列的套件，也就是 npm ci 實際會裝的。 */
export function lockfilePackages(lockfile) {
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
  return Object.entries(lock.packages)
    .filter(([path]) => path !== '')
    .map(([path, entry]) => ({
      name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version,
    }));
}

/** THIRD_PARTY_NOTICES.md 裡每個套件段落：`### name@version` 到下一個標題之間。 */
export function noticeSections(text) {
  const headings = [...text.matchAll(/^### (@?[^\s@]+@[^\s@]+)[ \t]*$/gm)];
  const sections = new Map();
  headings.forEach((match, i) => {
    const end = headings[i + 1]?.index ?? text.length;
    sections.set(match[1], text.slice(match.index, end));
  });
  return sections;
}

/**
 * 實際散布的套件都要在 notices 裡，而且附授權全文。回傳問題清單，空的表示通過。
 * shipped：Map 或 {name, version} 陣列。
 */
export function missingNotices(noticesText, shipped) {
  const sections = noticeSections(noticesText);
  const problems = [];
  const keys = new Set([...shipped].map(({ name, version }) => `${name}@${version}`));
  for (const key of keys) {
    const section = sections.get(key);
    if (!section) problems.push(`${key}：THIRD_PARTY_NOTICES.md 沒有這個套件`);
    else if (!section.includes('```text')) problems.push(`${key}：沒有授權全文`);
  }
  return problems;
}
