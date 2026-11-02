import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { HOOK_COMMAND, WS_PATHS } from '@agent-board/protocol';

export interface DaemonConfig {
  hubUrl: string;
  token: string;
  dataDir: string;
  claudeBin: string;
  /** agent-board-hook 的路徑或指令名。 */
  hookBin: string;
  machineName: string;
  /** 預設帳號的 CLAUDE_CONFIG_DIR，用量統計會讀。 */
  claudeConfigDir: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const hubUrl = env.AGENT_BOARD_HUB_URL;
  const token = env.AGENT_BOARD_MACHINE_TOKEN;
  if (!hubUrl) throw new Error('缺少環境變數 AGENT_BOARD_HUB_URL');
  if (!token) throw new Error('缺少環境變數 AGENT_BOARD_MACHINE_TOKEN');
  return {
    hubUrl: normalizeHubUrl(hubUrl),
    token,
    dataDir: env.AGENT_BOARD_DATA_DIR || join(homedir(), '.agent-board'),
    claudeBin: env.AGENT_BOARD_CLAUDE_BIN || 'claude',
    hookBin: env.AGENT_BOARD_HOOK_BIN || HOOK_COMMAND,
    machineName: env.AGENT_BOARD_MACHINE_NAME || hostname(),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  };
}
