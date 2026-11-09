import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { HOOK_COMMAND, WS_PATHS } from '@agent-board/protocol';
import { readCredentials } from './credentials';

export interface DaemonConfig {
  hubUrl: string;
  token: string;
  dataDir: string;
  claudeBin: string;
  /** codex 的路徑或指令名（AGENT_BOARD_CODEX_BIN，預設 codex）。找不到就不開 Codex session（§19）。 */
  codexBin?: string;
  /** agent-board-hook 的路徑或指令名。 */
  hookBin: string;
  machineName: string;
  /** 預設帳號的 CLAUDE_CONFIG_DIR，用量統計會讀。 */
  claudeConfigDir: string;
  /**
   * 派工 MCP server 程式（CONTRACTS §11），用 daemon 自己的 node 跑。null：找不到，不掛派工工具。
   * 環境變數 AGENT_BOARD_MCP_SERVER 優先；入口程式會補上隨附的那支。
   */
  mcpServer?: string | null;
}

/** 接受 http(s) 或 ws(s)；沒寫路徑就補上 /ws/daemon。 */
export function normalizeHubUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`AGENT_BOARD_HUB_URL 的協定不支援：${url.protocol}`);
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = WS_PATHS.daemon;
  return url.toString();
}

export const resolveDataDir = (env: NodeJS.ProcessEnv): string =>
  env.AGENT_BOARD_DATA_DIR || join(homedir(), '.agent-board');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = resolveDataDir(env);
  // 環境變數優先；有給 token 就不必讀配對檔。
  const saved = env.AGENT_BOARD_MACHINE_TOKEN ? null : readCredentials(dataDir);
  const hubUrl = env.AGENT_BOARD_HUB_URL || saved?.hubUrl;
  const token = env.AGENT_BOARD_MACHINE_TOKEN || saved?.token;
  if (!hubUrl) {
    throw new Error(
      '不知道要連哪個 hub。請執行 agent-board-daemon pair，或設定環境變數 AGENT_BOARD_HUB_URL。',
    );
  }
  if (!token) {
    throw new Error(
      '沒有機器 token。請執行 agent-board-daemon pair，或設定環境變數 AGENT_BOARD_MACHINE_TOKEN。',
    );
  }
  if (saved && normalizeHubUrl(hubUrl) !== normalizeHubUrl(saved.hubUrl)) {
    // 保存的 token 是這台機器在原 hub 的長期憑證，不可送給別的主機。
    throw new Error(
      `AGENT_BOARD_HUB_URL（${hubUrl}）和配對時的 hub（${saved.hubUrl}）不同，不會把保存的 token 送過去。請重新配對，或同時設定 AGENT_BOARD_MACHINE_TOKEN。`,
    );
  }
  return {
    hubUrl: normalizeHubUrl(hubUrl),
    token,
    dataDir,
    claudeBin: env.AGENT_BOARD_CLAUDE_BIN || 'claude',
    codexBin: env.AGENT_BOARD_CODEX_BIN || 'codex',
    hookBin: env.AGENT_BOARD_HOOK_BIN || HOOK_COMMAND,
    machineName: env.AGENT_BOARD_MACHINE_NAME || hostname(),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    mcpServer: env.AGENT_BOARD_MCP_SERVER || null,
  };
}
