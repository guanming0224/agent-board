// agent-board-daemon pair：用一次性配對碼向 hub 換長期 token。
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { ApiError, MachineOs, routes, type MachineCapabilities } from '@agent-board/protocol';
import { credentialsPath, writeCredentials } from './credentials';
import { errorMessage } from './log';

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_ATTEMPTS = 3;
const USAGE = "用法：agent-board-daemon pair --hub '<origin>' --code <code>";
/** 連線根本沒建立，請求沒到 hub，配對碼不會被用掉，可以安全重試。 */
const NEVER_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export interface PairOptions {
  hub: string;
  code: string;
  dataDir: string;
  name?: string;
  capabilities: MachineCapabilities;
  retryDelayMs?: number;
}

function parseOrigin(hub: string): URL {
  let url: URL;
  try {
    url = new URL(hub);
  } catch {
    throw new Error(
      `--hub 的值「${hub}」不是合法網址。請用 https://主機:埠 的形式，到中控台複製配對指令。`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--hub 只接受 http 或 https，目前是 ${url.protocol}。請到中控台複製配對指令。`);
  }
  return url;
}

function networkCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

async function postPair(url: URL, body: string, retryDelayMs: number): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, {
        method: routes.pairingExchange.method,
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const code = networkCode(error);
      if (attempt < CONNECT_ATTEMPTS && code !== undefined && NEVER_SENT.has(code)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
      if ((error as Error).name === 'TimeoutError') {
        // 逾時不重試：hub 可能已收到並用掉配對碼。
        throw new Error(
          `hub ${url.origin} 超過 ${REQUEST_TIMEOUT_MS / 1000} 秒沒有回應。請確認 hub 正常，再到中控台產生新的配對碼重試。`,
        );
      }
      throw new Error(
        `連不到 hub ${url.origin}（${code ?? errorMessage(error)}）。請確認 hub 有開、網址正確、這台機器連得到（例如 Tailscale 已連線）。`,
      );
    }
  }
}

async function describeFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    detail = ApiError.parse(await response.json()).message;
  } catch {
    // 回應不是 ApiError，只靠狀態碼說明
  }
  const suffix = detail ? `：${detail}` : '';
  if (response.status === 429) {
    const after = response.headers.get('retry-after');
    return `配對嘗試太頻繁（HTTP 429${suffix}）。請${after ? `等 ${after} 秒後` : '稍後'}再試。`;
  }
  if (response.status >= 500) {
    return `hub 內部錯誤（HTTP ${response.status}${suffix}）。請查看 hub 的紀錄，修好後再試。`;
  }
  return `配對被拒絕（HTTP ${response.status}${suffix}）。配對碼可能打錯、已過期或已用過，請到中控台產生新的配對碼。`;
}

/** 成功回傳 machineId。token 只寫進檔案，不會回傳。 */
export async function pairMachine(
  options: PairOptions,
): Promise<{ machineId: string; path: string }> {
  const url = parseOrigin(options.hub);
  const origin = url.origin;
  const os = MachineOs.parse(process.platform);
  const body = routes.pairingExchange.body.parse({
    code: options.code,
    name: options.name ?? hostname(),
    os,
    capabilities: options.capabilities,
  });
  const response = await postPair(
    new URL(routes.pairingExchange.path, origin),
    JSON.stringify(body),
    options.retryDelayMs ?? 1_000,
  );
  if (!response.ok) throw new Error(await describeFailure(response));

  let credentials;
  try {
    credentials = routes.pairingExchange.response.parse(await response.json());
  } catch {
    throw new Error(
      `hub ${origin} 的回應格式不對。請確認 --hub 指向 Agent Board，且 hub 與 daemon 版本相符。`,
    );
  }
  try {
    writeCredentials(options.dataDir, { ...credentials, hubUrl: origin });
  } catch (error) {
    throw new Error(
      `已配對，但憑證寫不進 ${credentialsPath(options.dataDir)}（${errorMessage(error)}）。請修好資料夾權限後，到中控台產生新的配對碼重試。`,
    );
  }
  return { machineId: credentials.machineId, path: credentialsPath(options.dataDir) };
}

export interface PairArgs {
  hub: string;
  code: string;
}

export function parsePairArgs(argv: string[]): PairArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { hub: { type: 'string' }, code: { type: 'string' } },
    }));
  } catch (error) {
    throw new Error(`${errorMessage(error)}\n${USAGE}`);
  }
  if (!values.hub || !values.code) throw new Error(`缺少 --hub 或 --code。\n${USAGE}`);
  return { hub: values.hub, code: values.code };
}
