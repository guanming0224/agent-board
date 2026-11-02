// 監聽設定。絕不綁定所有介面：hub 上有整批機器的終端機控制權。
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

export class UnsafeBindError extends Error {}

/** 判斷是否為「所有介面」位址，包含各種等價寫法（`::0`、`0:0:0:0:0:0:0:0`、`::ffff:0.0.0.0`）。 */
function isUnspecifiedAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 4) return bare.split('.').every((octet) => Number(octet) === 0);
  if (family === 6) {
    const normalized = new URL(`http://[${bare}]`).hostname;
    return normalized === '[::]' || normalized === '[::ffff:0:0]';
  }
  return false;
}

/**
 * 只接受明確的 IP 或 `localhost`。主機名稱不接受：解析結果無法事先確認，
 * `0`、`0.0.0` 這類 inet_aton 簡寫也會在這裡被擋下。
 */
export function assertBindableHost(host: string): void {
  if (isUnspecifiedAddress(host)) {
    throw new UnsafeBindError(
      `Refusing to bind to ${host}: listening on all interfaces is not allowed. Set a specific IP.`,
    );
  }
  const bare = host.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (host !== 'localhost' && isIP(bare) === 0) {
    throw new UnsafeBindError(`Refusing to bind to "${host}": expected an IP address.`);
  }
}

export interface EnvConfig {
  /** 未設定時用 settings.listenAddress。 */
  host: string | undefined;
  port: number;
  dataDir: string;
  dbPath: string;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const rawPort = env.AGENT_BOARD_PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid AGENT_BOARD_PORT: ${rawPort}`);
  }
  const host = env.AGENT_BOARD_HOST === '' ? undefined : env.AGENT_BOARD_HOST;
  if (host !== undefined) assertBindableHost(host);
  const dataDir = env.AGENT_BOARD_DATA_DIR || join(homedir(), '.agent-board');
  return { host, port, dataDir, dbPath: join(dataDir, 'hub.db') };
}
