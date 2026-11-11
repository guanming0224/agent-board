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
  /**
   * 跑派工 MCP server 的 node（寫進 MCP 設定檔）：AGENT_BOARD_NODE（安裝程式設成發布檔自帶的
   * current/runtime/node/…，CONTRACTS §21.10），沒有就是 daemon 自己的 process.execPath。
   */
  nodeBin?: string;
  /**
   * session host（CONTRACTS §20）：`auto`（預設）＝連得上就用，daemon 重啟時 agent 不中斷；連不上或協定不相容
   * 就退回 daemon 自己開 PTY 的舊模式。`off`＝一律舊模式（AGENT_BOARD_SESSION_HOST=off）。
   */
  sessionHost?: 'auto' | 'off';
  /**
   * 連不上 session host 時用來把它拉起來的服務名稱（AGENT_BOARD_SESSION_HOST_SERVICE，安裝程式設定）：
   * macOS launchd label、Linux systemd user unit、Windows 工作排程器的工作名稱。沒有就不拉。
   */
  sessionHostService?: string | null;
  /** 只給測試（AGENT_BOARD_SESSION_HOST_TEST_PROTOCOL）：hello 假裝成別的協定版本。 */
  sessionHostTestProtocol?: number;
  /**
   * 安裝根目錄（AGENT_BOARD_INSTALL_ROOT，安裝程式寫進服務設定）：自動更新要用（releases/、current、install.json）。
   * 沒有＝不是安裝程式裝的（開發模式、dev 實例），不自動更新（CONTRACTS §21.3）。
   */
  installRoot?: string | null;
  /** 更新程式健康檢查的上限（AGENT_BOARD_UPDATE_HEALTH_MS，只給測試縮短；預設 60 秒）。 */
  updateHealthMs?: number;
  /** 新 daemon 起來了但連不上 hub 時更新程式最多等多久（AGENT_BOARD_UPDATE_CONNECT_MS，只給測試；預設 5 分鐘）。 */
  updateConnectMs?: number;
  /** 只給測試（AGENT_BOARD_PROTOCOL_VERSION_OVERRIDE）：hello 假裝成別的 hub 協定版本。 */
  protocolVersionOverride?: number;
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
    nodeBin: env.AGENT_BOARD_NODE || process.execPath,
    sessionHost: env.AGENT_BOARD_SESSION_HOST === 'off' ? 'off' : 'auto',
    sessionHostService: env.AGENT_BOARD_SESSION_HOST_SERVICE || null,
    installRoot: env.AGENT_BOARD_INSTALL_ROOT || null,
    ...(Number(env.AGENT_BOARD_UPDATE_HEALTH_MS) > 0
      ? { updateHealthMs: Number(env.AGENT_BOARD_UPDATE_HEALTH_MS) }
      : {}),
    ...(Number(env.AGENT_BOARD_UPDATE_CONNECT_MS) > 0
      ? { updateConnectMs: Number(env.AGENT_BOARD_UPDATE_CONNECT_MS) }
      : {}),
    ...(Number(env.AGENT_BOARD_PROTOCOL_VERSION_OVERRIDE) > 0
      ? { protocolVersionOverride: Number(env.AGENT_BOARD_PROTOCOL_VERSION_OVERRIDE) }
      : {}),
    ...(env.AGENT_BOARD_SESSION_HOST_TEST_PROTOCOL
      ? { sessionHostTestProtocol: Number(env.AGENT_BOARD_SESSION_HOST_TEST_PROTOCOL) }
      : {}),
  };
}
