// 派工工具（CONTRACTS §11）：daemon 給每個 claude 產生 `--mcp-config` 設定檔與密鑰檔。
// 密鑰只在 0600 的檔案裡（資料夾 0700）：不在 argv（ps 看得到）、不在 claude 的環境變數（Bash 工具讀得到）、
// 不在 MCP 設定檔本身（/mcp 畫面可能顯示 env）。MCP server 從 AGENT_BOARD_MCP_SECRET_FILE 讀。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISPATCH_MCP_SERVER, DispatchTool, HOOK_ENV, MCP_ENV } from '@agent-board/protocol';

/** 工具全名，daemon 用 `--allowedTools` 事先允許（只有這四個，不放寬別的工具）。 */
export const DISPATCH_TOOL_NAMES: readonly string[] = DispatchTool.options.map(
  (tool) => `mcp__${DISPATCH_MCP_SERVER}__${tool}`,
);

export interface McpServerCommand {
  /** node 執行檔（daemon 自己的 process.execPath）。 */
  command: string;
  /** MCP server 程式的路徑（發布檔的 daemon/dist/agent-board-mcp.mjs，開發時 packages/hook/src/mcp.ts）。 */
  args: string[];
}

export interface McpLaunch {
  configPath: string;
  secret: string;
}

export const mcpDir = (dataDir: string) => join(dataDir, 'mcp');

/** 先寫暫存檔、設好權限再換名：檔案從出現的那一刻起就是 0600。 */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** 每次開 PTY 都換新的密鑰：重開、接續、daemon 重啟後舊的一律無效。 */
export function writeMcpFiles(
  dataDir: string,
  sessionId: string,
  server: McpServerCommand,
  socketPath: string,
): McpLaunch {
  const dir = mcpDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const secret = randomBytes(32).toString('base64url');
  const secretPath = join(dir, `${sessionId}.key`);
  const configPath = join(dir, `${sessionId}.json`);
  writePrivate(secretPath, secret);
  const config = {
    mcpServers: {
      [DISPATCH_MCP_SERVER]: {
        type: 'stdio',
        command: server.command,
        args: server.args,
        env: {
          [HOOK_ENV.sessionId]: sessionId,
          [HOOK_ENV.socket]: socketPath,
          [MCP_ENV.secretFile]: secretPath,
        },
      },
    },
  };
  writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, secret };
}

export function removeMcpFiles(dataDir: string, sessionId: string): void {
  for (const ext of ['json', 'key']) {
    rmSync(join(mcpDir(dataDir), `${sessionId}.${ext}`), { force: true });
  }
}

/** daemon 啟動時：上次留下的設定與密鑰都作廢（記憶體裡的密鑰已經不在）。 */
export function clearMcpDir(dataDir: string): void {
  const dir = mcpDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/\.(json|key|tmp)$/.test(name)) rmSync(join(dir, name), { force: true });
  }
}

/** 固定時間比較，長度不同直接 false。 */
export function secretMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
