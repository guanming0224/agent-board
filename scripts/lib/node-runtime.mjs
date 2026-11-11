// Node 相關的共用判斷（CONTRACTS §21.10）：安裝程式、更新程式與建置共用。只用 node 內建模組、不開行程、不連網路。
// 發布檔**不自帶 Node**（2026-11-11 GM 改回）：hub、daemon、session host、更新程式、hook、MCP server 都用安裝時
// 找到的系統 node。原生模組（node-pty、better-sqlite3、argon2）都是 N-API，prebuilds 只分平台、不分 Node 版本。
// 0.1.1 曾經自帶 Node（runtime/node），這裡的 isBundledRuntime 用來認出那份殘留，不把它當成系統的 node。
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** 發布檔裡記錄 node_modules 平台、建置用的 Node、最低 Node 版本的檔案（build-release 寫）。 */
export const MODULES_PLATFORM_FILE = '.node-modules-platform';

/** `.node-modules-platform` 的內容；沒有或壞掉回 null。 */
export function readModulesPlatform(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, MODULES_PLATFORM_FILE), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * `.node-modules-platform` 的內容（build-release 寫）。建置用 Node 的 ABI 記成 **buildModules**（只供參考），
 * 不用 0.1.1 以前的 `modules` 這個名字：0.1.0／0.1.1 的 hub 讀 `modules` 跟 daemon 的 ABI 比，不合就不發目標
 * （abi_mismatch）；讀不到就不擋，所以舊 hub 也會把 0.1.2 發給 Node 26 的機器（§21.10）。
 */
export function modulesPlatformManifest({ platform, node, buildModules, engines }) {
  return {
    platform,
    node,
    buildModules,
    // 原生模組都是 N-API：不同 Node 版本也載得起來。hub 只擋低於 minNode 的機器。
    napi: true,
    minNode: minNodeFromEngines(engines),
  };
}

/**
 * package.json 的 engines.node（例如 `>=22.18`）裡的最低版本（`22.18`）；讀不懂回預設的 `22`。
 * hub 用它的主版本擋 Node 太舊的機器（node_too_old）。
 */
export function minNodeFromEngines(engines) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(engines ?? ''));
  return match
    ? match
        .slice(1)
        .filter((part) => part !== undefined)
        .join('.')
    : '22';
}

/** 版本字串（`26.1.0`、`v24.17.0`、`22.18`）的主版本；讀不懂回 null。 */
export function nodeMajor(version) {
  const match = /^v?(\d+)/.exec(String(version ?? ''));
  return match ? Number(match[1]) : null;
}

/** a ≥ b（只比數字部分，缺的當 0）。 */
export function versionAtLeast(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * path（解開 symlink 後）是不是某個發布檔自帶的 node（0.1.1 的 `…/runtime/node/bin/node`、
 * `…\runtime\node\node.exe`）。這種 node 不能當成「系統的 node」記下來：它所在的資料夾會被清掉，
 * 而且 macOS 的隱私權限（TCC）不認它（2026-11-11 事故，§21.10）。
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

/**
 * daemon/node_modules/.bin/agent-board-hook 的 sh 包裝（build-release 寫進發布檔）：用安裝時記下的 node
 * （daemon 傳給 agent 的 AGENT_BOARD_NODE，絕對路徑）執行 daemon/dist/agent-board-hook.cjs；沒有或不能執行
 * 才用 PATH 上的 node。找不到 node 或 .cjs 不見了：往 stderr 說明並 exit 2——Claude Code 把 2 當成擋下
 * （危險指令檢查不能因為裝壞了就被放行）。不呼叫 dirname（每次工具呼叫都會跑 hook，少開一個行程）。
 */
export const hookWrapperSh = () =>
  [
    '#!/bin/sh',
    '# Agent Board hook：用安裝時記下的 node（AGENT_BOARD_NODE）執行 daemon/dist/agent-board-hook.cjs（CONTRACTS §21.10）。',
    'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac',
    'n=${AGENT_BOARD_NODE:-}',
    '[ -n "$n" ] && [ -x "$n" ] || n=$(command -v node 2>/dev/null) || n=',
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
    '@set "AB_HOOK=%~dp0..\\..\\dist\\agent-board-hook.cjs"',
    '@if not exist "%AB_HOOK%" goto missing',
    '@if defined AGENT_BOARD_NODE if exist "%AGENT_BOARD_NODE%" goto run',
    '@set "AGENT_BOARD_NODE=node"',
    '@where node >nul 2>nul || goto missing',
    ':run',
    '@"%AGENT_BOARD_NODE%" "%AB_HOOK%" %*',
    '@exit /b %ERRORLEVEL%',
    ':missing',
    '@echo agent-board-hook: node or the hook program is missing; blocking this call. Reinstall Agent Board. 1>&2',
    '@exit /b 2',
    '',
  ].join('\r\n');
