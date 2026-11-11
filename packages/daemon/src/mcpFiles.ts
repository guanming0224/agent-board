// agent-board 工具（派工 CONTRACTS §11、進度卡 §14）：daemon 給每個 claude 產生 `--mcp-config` 設定檔與密鑰檔。
// 密鑰只在 0600 的檔案裡（資料夾 0700）：不在 argv（ps 看得到）、不在 claude 的環境變數（Bash 工具讀得到）、
// 不在 MCP 設定檔本身（/mcp 畫面可能顯示 env）。MCP server 從 AGENT_BOARD_MCP_SECRET_FILE 讀。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DISPATCH_MCP_SERVER,
  DispatchTool,
  HOOK_ENV,
  MCP_ENV,
  MemoryTool,
  type AgentBoardTool,
} from '@agent-board/protocol';

/** 工具全名（`mcp__agent-board__<tool>`）：daemon 用 `--allowedTools` 事先允許，只列 agent-board 自己的工具。 */
export const toolFullName = (tool: AgentBoardTool): string =>
  `mcp__${DISPATCH_MCP_SERVER}__${tool}`;

/** 派工的四個工具全名（`Settings.dispatch` 開著時）。 */
export const DISPATCH_TOOL_NAMES: readonly string[] = DispatchTool.options.map(toolFullName);
/** 進度卡的兩個工具全名（`Settings.memory` 開著時，P3 項目一）。 */
export const MEMORY_TOOL_NAMES: readonly string[] = MemoryTool.options.map(toolFullName);

/** 依設定決定這次開 PTY 掛哪些工具（短名稱）：派工 4 個、進度卡 2 個，只列開著的。 */
export function enabledTools(settings: { dispatch: boolean; memory: boolean }): AgentBoardTool[] {
  return [
    ...(settings.dispatch ? DispatchTool.options : []),
    ...(settings.memory ? MemoryTool.options : []),
  ];
}

export interface McpServerCommand {
  /** node 執行檔（發布檔自帶的那支，經過 current；開發時是 daemon 自己的 process.execPath）。 */
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
  tools: readonly AgentBoardTool[],
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
          // MCP server 的 tools/list 只列、tools/call 只接受這些（設定關著的工具不出現）。
          [MCP_ENV.tools]: tools.join(','),
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

/**
 * 清掉上次留下的設定與密鑰。舊模式（daemon 自己開 PTY）：啟動與關閉時全清，agent 已經跟著 daemon 結束。
 * session host 模式：daemon 停掉時不清（agent 還在跑、MCP server 還拿著密鑰檔）；接回後只清 keep 以外的
 * （session 真的結束才刪，CONTRACTS §20.3）。
 */
export function clearMcpDir(dataDir: string, keep: ReadonlySet<string> = new Set()): void {
  const dir = mcpDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.tmp')) rmSync(join(dir, name), { force: true });
    const match = /^(.+)\.(json|key)$/.exec(name);
    if (match && !keep.has(match[1]!)) rmSync(join(dir, name), { force: true });
  }
}

/** 接回時從檔案拿回這次 PTY 的密鑰（記憶體裡的已隨上一個 daemon 消失）。沒有回 null。 */
export function readMcpSecret(dataDir: string, sessionId: string): string | null {
  try {
    const secret = readFileSync(join(mcpDir(dataDir), `${sessionId}.key`), 'utf8').trim();
    return secret || null;
  } catch {
    return null;
  }
}

/** 固定時間比較，長度不同直接 false。 */
export function secretMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
