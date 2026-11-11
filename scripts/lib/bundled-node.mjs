// 發布檔自帶的 Node（CONTRACTS §21.10）：發布檔裡的 runtime/node 是建置時從 nodejs.org 下載、驗過 SHASUMS256 的
// 官方 Node 執行檔，hub、daemon、session host、更新程式、hook、MCP server 都用它跑，各機系統 Node 版本不再影響原生模組。
// 安裝程式、更新程式與建置共用。只用 node 內建模組、不開行程、不連網路。
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 發布檔裡記錄 node_modules 平台、Node 版本、ABI、有沒有自帶 Node 的檔案（build-release 寫）。 */
export const MODULES_PLATFORM_FILE = '.node-modules-platform';

/** 發布檔（或 session host 資料夾）裡自帶 Node 執行檔的位置。Windows 的官方 zip 沒有 bin/。 */
export const runtimeNodePath = (dir, platform = process.platform) =>
  platform === 'win32'
    ? join(dir, 'runtime', 'node', 'node.exe')
    : join(dir, 'runtime', 'node', 'bin', 'node');

/** `.node-modules-platform` 的內容；沒有或壞掉回 null。 */
export function readModulesPlatform(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, MODULES_PLATFORM_FILE), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const executable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * 這個發布檔自帶的 Node：`{ path, version, abi }`；不是自帶 Node 的成品（0.1.0 以前）或執行檔不在回 null。
 * 只看記錄，不執行它（版本在建置時已經用它本身確認過）。
 */
export function bundledNodeOf(dir, platform = process.platform) {
  const info = readModulesPlatform(dir);
  if (info?.bundledNode !== true || typeof info.node !== 'string') return null;
  const path = runtimeNodePath(dir, platform);
  if (!executable(path)) return null;
  return { path, version: info.node, abi: typeof info.modules === 'string' ? info.modules : null };
}

/**
 * session host 跑的 Node 的識別字（install.json 的 sessionHostNode）：自帶的是 `bundled:<版本>`，
 * 系統的是 `system`。換了就要重啟 session host（照忙碌延後規則）。
 */
export const hostNodeId = (bundled) => (bundled ? `bundled:${bundled.version}` : 'system');
