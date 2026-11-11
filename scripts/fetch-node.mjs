// 建置用（不進發布檔、不在各機執行）：取得官方 Node 執行檔放進發布檔的 runtime/node（CONTRACTS §21.10）。
// 版本＝根目錄 package.json 的 bundledNode（完整版本號）；每個平台成品的 SHA-256 釘在 bundledNodeSha256
// （從官方 SHASUMS256.txt 查出填入），**以釘住的值為準**：官方 SHASUMS256.txt 只當輔助（和釘住的值不同就中止）。
// 只從 https://nodejs.org/dist/ 下載（不跟隨轉址、5 分鐘逾時、確認回應來源）；快取在 release/.node-cache/v<版本>/
// （不進 git），快取裡的檔案每次重驗，不符（例如錯誤頁進了快取）就丟掉重抓。不送任何資料、不呼叫模型。
//
//   node scripts/fetch-node.mjs [--platform darwin-arm64|win-x64|linux-x64] [--out <資料夾>]
//   不給 --out 只下載、驗證並印出快取裡的成品路徑。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = join(import.meta.dirname, '..');
const ORIGIN = 'https://nodejs.org';
const DIST = `${ORIGIN}/dist`;
const DOWNLOAD_TIMEOUT_MS = 300_000;

const manifest = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** package.json 的 bundledNode：要是完整的 x.y.z（不接受「24」這種會漂移的寫法）。 */
export function bundledNodeVersion() {
  const { bundledNode } = manifest();
  if (typeof bundledNode !== 'string' || !/^\d+\.\d+\.\d+$/.test(bundledNode)) {
    throw new Error(
      `package.json 的 bundledNode 要是完整版本號（例如 24.22.2），目前是 ${bundledNode}`,
    );
  }
  return bundledNode;
}

/** package.json 的 bundledNodeSha256[平台]：釘住的官方成品 SHA-256。 */
export function pinnedSha256(platform, pkg = manifest()) {
  const value = pkg.bundledNodeSha256?.[platform];
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `package.json 的 bundledNodeSha256 沒有 ${platform} 的 SHA-256（從官方 SHASUMS256.txt 查出填入）`,
    );
  }
  return value;
}

/** 平台字串（darwin-arm64、win-x64…）對應官方成品檔名。 */
export function nodeAssetName(version, platform) {
  const [os, arch] = platform.split('-');
  if (os === 'win') return `node-v${version}-win-${arch}.zip`;
  if (os === 'darwin' || os === 'linux') return `node-v${version}-${os}-${arch}.tar.gz`;
  throw new Error(`不支援的平台：${platform}`);
}

/** SHASUMS256.txt 裡某個檔名的雜湊；沒有回 null。 */
export function shasumOf(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return null;
}

/** 下載網址一定要在 https://nodejs.org 底下。 */
export function assertNodejsOrg(url) {
  if (new URL(url).origin !== ORIGIN) throw new Error(`只從 ${ORIGIN} 下載，拒絕 ${url}`);
}

/** 只從 nodejs.org 下載：不跟隨轉址、逾時、確認實際回應的來源。 */
export async function download(url, dest, fetchImpl = fetch) {
  assertNodejsOrg(url);
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`下載失敗 ${url}：HTTP ${response.status}`);
  if (response.url) assertNodejsOrg(response.url);
  const temp = `${dest}.download`;
  writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  renameSync(temp, dest);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * 官方 SHASUMS256.txt（輔助）：和釘住的值對照。快取的版本沒有這一行或不同（錯誤頁、壞檔）就丟掉重抓一次；
 * 重抓的官方檔案還是和釘住的不同 → 中止（釘錯了，或官方檔案被換過，交給人看）。
 */
async function checkOfficialSums(cache, version, name, pinned, fetchImpl) {
  const sums = join(cache, 'SHASUMS256.txt');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existsSync(sums)) {
      console.log(`下載 ${DIST}/v${version}/SHASUMS256.txt`);
      await download(`${DIST}/v${version}/SHASUMS256.txt`, sums, fetchImpl);
    }
    const official = shasumOf(readFileSync(sums, 'utf8'), name);
    if (official === pinned) return;
    rmSync(sums, { force: true });
    if (attempt === 1) {
      throw new Error(
        `官方 SHASUMS256.txt 的 ${name} 是 ${official ?? '（沒有這一行）'}，和 package.json 釘住的 ${pinned} 不同`,
      );
    }
    console.log('快取的 SHASUMS256.txt 和釘住的值對不上，重新下載');
  }
}

/** 下載（或用快取）並驗證官方成品，回傳成品路徑。fetchImpl、pkg、cacheRoot 只給測試。 */
export async function fetchNode(
  version,
  platform,
  { fetchImpl = fetch, pkg = manifest(), cacheRoot = join(root, 'release', '.node-cache') } = {},
) {
  const pinned = pinnedSha256(platform, pkg);
  const cache = join(cacheRoot, `v${version}`);
  mkdirSync(cache, { recursive: true });
  const name = nodeAssetName(version, platform);
  await checkOfficialSums(cache, version, name, pinned, fetchImpl);
  const archive = join(cache, name);
  if (existsSync(archive) && sha256(archive) !== pinned) {
    console.log(`快取的 ${name} 雜湊不符，丟掉重新下載`);
    rmSync(archive, { force: true });
  }
  if (!existsSync(archive)) {
    console.log(`下載 ${DIST}/v${version}/${name}`);
    await download(`${DIST}/v${version}/${name}`, archive, fetchImpl);
  }
  const actual = sha256(archive);
  if (actual !== pinned) {
    rmSync(archive, { force: true });
    throw new Error(`${name} 的 SHA-256 和釘住的值不符（${actual} ≠ ${pinned}）`);
  }
  console.log(`${name} 的 SHA-256 和釘住的值、官方 SHASUMS256.txt 都相符`);
  return archive;
}

/** 解壓用的 tar：Windows 寫死系統內建的 tar.exe（bsdtar，解得開 zip），不用 PATH 上可能是 GNU tar 的那支。 */
export const systemTar = () =>
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

/**
 * 把官方成品裡的 node 執行檔與 LICENSE 放到 <out>/runtime/node/（Mac／Linux bin/node，Windows node.exe）。
 * 不帶 npm、corepack、標頭檔：各機執行只需要 node 本身。官方成品自帶的 npm 另外放到 npmDir（建置時用它跑
 * npm ci，不進發布檔）。回傳 { node, npmCli }（成品裡沒有 npm 時 npmCli 為 null）。
 */
export function extractNode(archive, version, platform, out, npmDir = null) {
  mkdirSync(join(root, 'release'), { recursive: true });
  const temp = mkdtempSync(join(root, 'release', '.node-extract-'));
  try {
    execFileSync(systemTar(), ['-xf', archive, '-C', temp]);
    const top = join(temp, nodeAssetName(version, platform).replace(/\.(zip|tar\.gz)$/, ''));
    const dest = join(out, 'runtime', 'node');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const win = platform.startsWith('win-');
    if (win) {
      cpSync(join(top, 'node.exe'), join(dest, 'node.exe'));
    } else {
      mkdirSync(join(dest, 'bin'));
      cpSync(join(top, 'bin', 'node'), join(dest, 'bin', 'node'));
      chmodSync(join(dest, 'bin', 'node'), 0o755);
    }
    cpSync(join(top, 'LICENSE'), join(dest, 'LICENSE'));
    let npmCli = null;
    const npm = win ? join(top, 'node_modules', 'npm') : join(top, 'lib', 'node_modules', 'npm');
    if (npmDir && existsSync(join(npm, 'bin', 'npm-cli.js'))) {
      rmSync(npmDir, { recursive: true, force: true });
      cpSync(npm, npmDir, { recursive: true });
      npmCli = join(npmDir, 'bin', 'npm-cli.js');
    }
    return { node: win ? join(dest, 'node.exe') : join(dest, 'bin', 'node'), npmCli };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export const platformKey = () =>
  `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({
    options: { platform: { type: 'string' }, out: { type: 'string' } },
  });
  const version = bundledNodeVersion();
  const platform = values.platform ?? platformKey();
  const archive = await fetchNode(version, platform);
  if (values.out) console.log(extractNode(archive, version, platform, values.out).node);
  else console.log(archive);
}
