// 建置用（不進發布檔、不在各機執行）：取得官方 Node 執行檔放進發布檔的 runtime/node（CONTRACTS §21.10）。
// 版本＝根目錄 package.json 的 bundledNode（完整版本號）。只從 https://nodejs.org/dist/ 下載，
// 一律用同一個版本的官方 SHASUMS256.txt 驗 SHA-256；快取在 release/.node-cache/v<版本>/（不進 git）。
// 快取裡已有成品時照樣驗過才用。不送任何資料、不呼叫模型。
//
//   node scripts/fetch-node.mjs [--platform darwin-arm64|win-x64|linux-x64] [--out <資料夾>]
//   不給 --out 只下載、驗證並印出快取裡的成品路徑（workflow 先跑一次確認網路與 SHASUMS）。
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
const DIST = 'https://nodejs.org/dist';

/** package.json 的 bundledNode：要是完整的 x.y.z（不接受「24」這種會漂移的寫法）。 */
export function bundledNodeVersion() {
  const { bundledNode } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof bundledNode !== 'string' || !/^\d+\.\d+\.\d+$/.test(bundledNode)) {
    throw new Error(
      `package.json 的 bundledNode 要是完整版本號（例如 24.22.2），目前是 ${bundledNode}`,
    );
  }
  return bundledNode;
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

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下載失敗 ${url}：HTTP ${response.status}`);
  const temp = `${dest}.download`;
  writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  renameSync(temp, dest);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 下載（或用快取）並驗證官方成品，回傳成品路徑。 */
export async function fetchNode(version, platform) {
  const cache = join(root, 'release', '.node-cache', `v${version}`);
  mkdirSync(cache, { recursive: true });
  const sums = join(cache, 'SHASUMS256.txt');
  if (!existsSync(sums)) {
    console.log(`下載 ${DIST}/v${version}/SHASUMS256.txt`);
    await download(`${DIST}/v${version}/SHASUMS256.txt`, sums);
  }
  const name = nodeAssetName(version, platform);
  const expected = shasumOf(readFileSync(sums, 'utf8'), name);
  if (!expected) throw new Error(`SHASUMS256.txt 裡沒有 ${name}`);
  const archive = join(cache, name);
  if (existsSync(archive) && sha256(archive) !== expected) {
    console.log(`快取的 ${name} 雜湊不符，重新下載`);
    rmSync(archive, { force: true });
  }
  if (!existsSync(archive)) {
    console.log(`下載 ${DIST}/v${version}/${name}`);
    await download(`${DIST}/v${version}/${name}`, archive);
  }
  const actual = sha256(archive);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`${name} 的 SHA-256 和官方 SHASUMS256.txt 不符（${actual} ≠ ${expected}）`);
  }
  console.log(`${name} 的 SHA-256 和官方 SHASUMS256.txt 相符`);
  return archive;
}

/**
 * 把官方成品裡的 node 執行檔與 LICENSE 放到 <out>/runtime/node/（Mac／Linux bin/node，Windows node.exe）。
 * 不帶 npm、corepack、標頭檔：各機執行只需要 node 本身。
 */
export function extractNode(archive, version, platform, out) {
  const temp = mkdtempSync(join(root, 'release', '.node-extract-'));
  try {
    execFileSync('tar', ['-xf', archive, '-C', temp]);
    const top = join(temp, nodeAssetName(version, platform).replace(/\.(zip|tar\.gz)$/, ''));
    const dest = join(out, 'runtime', 'node');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    if (platform.startsWith('win-')) {
      cpSync(join(top, 'node.exe'), join(dest, 'node.exe'));
    } else {
      mkdirSync(join(dest, 'bin'));
      cpSync(join(top, 'bin', 'node'), join(dest, 'bin', 'node'));
      chmodSync(join(dest, 'bin', 'node'), 0o755);
    }
    cpSync(join(top, 'LICENSE'), join(dest, 'LICENSE'));
    return platform.startsWith('win-') ? join(dest, 'node.exe') : join(dest, 'bin', 'node');
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
  if (values.out) console.log(extractNode(archive, version, platform, values.out));
  else console.log(archive);
}
