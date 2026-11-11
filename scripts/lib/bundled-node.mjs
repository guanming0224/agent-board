// 發布檔自帶的 Node（CONTRACTS §21.10）：發布檔裡的 runtime/node 是建置時從 nodejs.org 下載、驗過 SHASUMS256 的
// 官方 Node 執行檔，hub、daemon、session host、更新程式、hook、MCP server 都用它跑，各機系統 Node 版本不再影響原生模組。
// 安裝程式、更新程式與建置共用。只用 node 內建模組、不開行程、不連網路。
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** 發布檔裡記錄 node_modules 平台、Node 版本、ABI、有沒有自帶 Node 的檔案（build-release 寫）。 */
export const MODULES_PLATFORM_FILE = '.node-modules-platform';

/** 發布檔（或 session host 資料夾）裡自帶 Node 執行檔的位置。Windows 的官方 zip 沒有 bin/。 */
export const runtimeNodePath = (dir, platform = process.platform) =>
  platform === 'win32'
    ? join(dir, 'runtime', 'node', 'node.exe')
    : join(dir, 'runtime', 'node', 'bin', 'node');

/**
 * path（解開 symlink 後）是不是某個發布檔自帶的 node（`…/runtime/node/bin/node`、`…\\runtime\\node\\node.exe`）。
 * 不在這次的安裝資料夾裡也算（例如解壓在暫存資料夾的新版、別處的發布檔）：這種 node 不能當成「系統的 node」記下來，
 * 它所在的資料夾隨時會被刪掉。
 */
export function isBundledRuntime(path) {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // 不存在就看原本的路徑
  }
  return /[\\/]runtime[\\/]node[\\/](bin[\\/]node|node\.exe)$/i.test(real);
}

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

/**
 * daemon/node_modules/.bin/agent-board-hook 的 sh 包裝（build-release 寫進發布檔）：用相對路徑找發布檔自帶的
 * node（沒有才用 PATH 上的 node）執行 daemon/dist/agent-board-hook.cjs。找不到 node 或 .cjs 不見了：往 stderr
 * 說明並 exit 2——Claude Code 把 2 當成擋下（危險指令檢查不能因為裝壞了就被放行）。
 * 不呼叫 dirname（每次工具呼叫都會跑 hook，少開一個行程）。
 */
export const hookWrapperSh = () =>
  [
    '#!/bin/sh',
    '# Agent Board hook：用發布檔自帶的 node 執行 daemon/dist/agent-board-hook.cjs（CONTRACTS §21.10）。',
    'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac',
    'n="$d/../../../runtime/node/bin/node"',
    '[ -x "$n" ] || n="$d/../../../runtime/node/node.exe"',
    '[ -x "$n" ] || n=$(command -v node 2>/dev/null) || n=',
    'h="$d/../../dist/agent-board-hook.cjs"',
    'if [ -z "$n" ] || [ ! -f "$h" ]; then',
    '  echo "agent-board-hook: 找不到 node 或 hook 程式（$h），這次呼叫擋下。請重新安裝 Agent Board。" >&2',
    '  exit 2',
    'fi',
    'exec "$n" "$h" "$@"',
    '',
  ].join('\n');

/** 同上的 Windows .cmd 版本（未在 Windows 實測）。 */
export const hookWrapperCmd = () =>
  [
    '@setlocal',
    '@set "AB_NODE=%~dp0..\\..\\..\\runtime\\node\\node.exe"',
    '@set "AB_HOOK=%~dp0..\\..\\dist\\agent-board-hook.cjs"',
    '@if not exist "%AB_HOOK%" goto missing',
    '@if exist "%AB_NODE%" goto run',
    '@set "AB_NODE=node"',
    '@where node >nul 2>nul || goto missing',
    ':run',
    '@"%AB_NODE%" "%AB_HOOK%" %*',
    '@exit /b %ERRORLEVEL%',
    ':missing',
    '@echo agent-board-hook: node or the hook program is missing; blocking this call. Reinstall Agent Board. 1>&2',
    '@exit /b 2',
    '',
  ].join('\r\n');
