// agent-board 工具（派工 CONTRACTS §11、進度卡 §14）：daemon 給每個 claude 產生 `--mcp-config` 設定檔與密鑰檔。
// 密鑰只在 0600 的檔案裡（資料夾 0700）：不在 argv（ps 看得到）、不在 claude 的環境變數（Bash 工具讀得到）、
// 不在 MCP 設定檔本身（/mcp 畫面可能顯示 env）。MCP server 從 AGENT_BOARD_MCP_SECRET_FILE 讀。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
  /** node 執行檔（安裝時記下的系統 node，AGENT_BOARD_NODE；開發時是 daemon 自己的 process.execPath）。 */
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
  /** daemon 的 hook 密鑰檔（W5）：MCP server 先驗證對方是 daemon 才送請求。 */
  keyFile?: string,
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
          ...(keyFile ? { [HOOK_ENV.keyFile]: keyFile } : {}),
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

/**
 * 接回 host 裡還活著的 session 時：MCP 設定檔裡的 node 和現在的不同（或那個路徑已經不在）就改成現在的 node，
 * claude 之後重開 MCP server 才起得來（CONTRACTS §21.10：0.1.1 期間開的 session 寫的是已經不存在的
 * current/runtime/node/bin/node）。只改 command，密鑰、env、args 不動；一樣 0600、先寫暫存檔再換名。
 * 回傳有沒有改。設定檔不在、讀不懂、現在的 node 不存在：不動。
 */
export function repointMcpConfig(
  dataDir: string,
  sessionId: string,
  node: string,
  /**
   * daemon 的 hook 密鑰檔（W5）。0.1.6 以前寫的設定檔 env 沒有 `AGENT_BOARD_HOOK_KEY_FILE`：補上，
   * claude 之後重開 MCP server 時才會先驗證 daemon。已經有的不動。
   */
  keyFile?: string,
): boolean {
  const configPath = join(mcpDir(dataDir), `${sessionId}.json`);
  let config: {
    mcpServers?: Record<string, { command?: unknown; env?: Record<string, unknown> }>;
  };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as typeof config;
  } catch {
    return false;
  }
  const server = config.mcpServers?.[DISPATCH_MCP_SERVER];
  if (!server || typeof server.command !== 'string') return false;
  let changed = false;
  if (node && existsSync(node) && !(server.command === node && existsSync(server.command))) {
    server.command = node;
    changed = true;
  }
  if (keyFile) {
    const env = server.env && typeof server.env === 'object' ? server.env : {};
    if (typeof env[HOOK_ENV.keyFile] !== 'string') {
      server.env = { ...env, [HOOK_ENV.keyFile]: keyFile };
      changed = true;
    }
  }
  if (!changed) return false;
  writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return true;
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
