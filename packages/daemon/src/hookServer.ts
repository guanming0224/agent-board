// 本機 hook socket：unix socket 或 Windows named pipe，NDJSON（CONTRACTS §4.2）。
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_KEY_FILE, HookReply, HookRequest, McpReply, McpRequest } from '@agent-board/protocol';
import { isNonce, localProof, NonceMemory } from '@agent-board/protocol/local-auth';
import {
  ensurePrivateDir,
  installId,
  stableShortDir,
  writePrivateFile,
} from '@agent-board/session-host';
import { errorMessage, log } from './log';

/** macOS 的 sun_path 上限 104 bytes，保守一點。 */
const MAX_UNIX_SOCKET_BYTES = 100;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type HookOutput = HookReply['output'];
/** signal 在 hook 連線斷掉時 abort。 */
export type HookHandler = (request: HookRequest, signal: AbortSignal) => Promise<HookOutput>;
/** 派工 MCP server 的工具呼叫（CONTRACTS §11）：同一個 socket，`type: 'mcp'`。 */
export type McpHandler = (request: McpRequest) => Promise<Pick<McpReply, 'ok' | 'text'>>;

interface SocketLocation {
  path: string;
  /** 路徑太長時放在這個暫存資料夾，關閉時一併清掉。 */
  tempDir: string | null;
}

function resolveSocketLocation(dataDir: string): SocketLocation {
  // session host 模式下 agent 比 daemon 活得久，它環境變數裡的 socket 位置在 daemon 重啟後要還是同一個：
  // 一律由資料夾決定，不隨機（CONTRACTS §20.3）。
  if (process.platform === 'win32') {
    // 每份安裝的隨機亂數（`<dataDir>/install-id`，600）：別的使用者猜不到名稱，搶不到先開同名 pipe。
    return { path: `\\\\.\\pipe\\agent-board-hook-${installId(dataDir)}`, tempDir: null };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const preferred = join(dataDir, 'hook.sock');
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_BYTES) {
    return { path: preferred, tempDir: null };
  }
  // 路徑太長：放在 tmpdir 底下固定名稱、只有自己能進的資料夾（不刪，daemon 重啟後還要用同一個）。
  try {
    return { path: join(stableShortDir(dataDir, 'ab-hook'), 'hook.sock'), tempDir: null };
  } catch (error) {
    // 固定資料夾被別人占了：退回隨機的暫存資料夾（session host 模式下 daemon 重啟後 hook 會接不回來）。
    log.warn(`${errorMessage(error)}；hook socket 改用隨機暫存資料夾`);
    const tempDir = mkdtempSync(join(tmpdir(), 'ab-'));
    return { path: join(tempDir, 'hook.sock'), tempDir };
  }
}

/**
 * daemon 在 session host 模式下停止時留的記號：hook CLI 連不上時看它決定要不要重試（剛停 → 重啟中，重試；
 * 停很久 → daemon 沒在跑，不重試、不拖慢 agent）。Windows 的 named pipe 旁邊不能放檔案，沒有記號。
 */
export function downMarkerPath(socketPath: string): string | null {
  return socketPath.startsWith('\\\\.\\pipe\\') ? null : `${socketPath}.down`;
}

export const hookKeyPath = (dataDir: string): string => join(dataDir, HOOK_KEY_FILE);

/**
 * hook 密鑰（W5）：沒有就建（600），有就沿用——活過 daemon 重啟的 agent 與 MCP server 還拿著同一個路徑，
 * 每次換掉的話它們重開時讀到的才是新的，但正在連的那一次會驗不過。
 */
export function ensureHookKey(dataDir: string): string {
  const path = hookKeyPath(dataDir);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) {
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      return existing;
    }
  } catch {
    // 還沒有
  }
  ensurePrivateDir(dataDir);
  const key = randomBytes(32).toString('base64url');
  writePrivateFile(path, `${key}\n`);
  return key;
}

function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

export class HookServer {
  private server: Server | null = null;
  private location: SocketLocation | null = null;
  private readonly sockets = new Set<Socket>();
  private key = '';
  /** hook 用過的 nonce（擋重送）。 */
  private readonly nonces = new NonceMemory();

  constructor(
    private readonly dataDir: string,
    private readonly handler: HookHandler,
    private readonly mcpHandler: McpHandler | null = null,
  ) {}

  get path(): string {
    if (!this.location) throw new Error('hook server 尚未啟動');
    return this.location.path;
  }

  /** hook 密鑰檔（`<dataDir>/hook.key`，W5）：agent 的環境變數、Codex 的 `--key-file`、MCP 設定檔都指這裡。 */
  get keyPath(): string {
    return hookKeyPath(this.dataDir);
  }

  async start(): Promise<void> {
    // 每次啟動都確認資料夾只有自己進得去（審查 W6／W2）：Mac／Linux chmod 700（「沒給密鑰檔的舊 agent 照舊不驗證」
    // 靠的就是 hook.sock 在 700 的資料夾裡）；Windows 用 ACL 只給自己與 SYSTEM，做不到就丟例外、daemon 不啟動。
    ensurePrivateDir(this.dataDir);
    const location = resolveSocketLocation(this.dataDir);
    if (process.platform !== 'win32') {
      // 還能連上就是另一個 daemon 正在用同一份資料夾，不可搶；連不上才是殘留檔。
      if (await isSocketAlive(location.path)) {
        throw new Error(`已有 daemon 在使用 ${location.path}`);
      }
      try {
        unlinkSync(location.path);
      } catch {
        // 沒有殘留檔
      }
    }
    this.key = ensureHookKey(this.dataDir);
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        // Windows：同名 pipe 已經有人開著（另一個 daemon，或別的程序搶先開了）。不搶，啟動失敗並說明（§20.7）。
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(
                `${location.path} 已經有人開著（另一個 daemon 在跑？）。先停掉另一個 daemon；` +
                  '如果沒有，可能是別的程式占用了這個名稱，重新開機後再試。',
              )
            : error,
        );
      };
      server.once('error', onError);
      server.listen(location.path, () => {
        server.off('error', onError);
        resolve();
      });
    });
    if (process.platform !== 'win32') chmodSync(location.path, 0o600);
    server.on('error', (error) => log.error(`hook socket 錯誤：${errorMessage(error)}`));
    this.server = server;
    this.location = location;
  }

  async close(): Promise<void> {
    const server = this.server;
    const location = this.location;
    this.server = null;
    this.location = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (location?.tempDir) rmSync(location.tempDir, { recursive: true, force: true });
  }

  /**
   * W5：客戶端（hook CLI、MCP server）先送 `auth.challenge`，這裡用 hook.key 回 `auth.proof`，對方驗過才送請求。
   * nonce 格式不對或最近用過：直接斷線（對方當成連不上）。
   */
  private handleChallenge(json: unknown, socket: Socket): void {
    const nonce = (json as { nonce?: unknown }).nonce;
    if (!this.key || !isNonce(nonce) || !this.nonces.remember(nonce)) {
      log.warn('hook 驗證請求的 nonce 不對或重送，中斷連線');
      socket.destroy();
      return;
    }
    if (socket.destroyed || !socket.writable) return;
    const reply = { type: 'auth.proof', proof: localProof(this.key, 'hookServer', nonce) };
    socket.write(`${JSON.stringify(reply)}\n`);
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    const abort = new AbortController();
    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        log.warn('hook 訊息超過上限，中斷連線');
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void this.handleLine(line, socket, abort.signal);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {
      // hook 程式隨時可能離開；close 事件會接手。
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      abort.abort();
    });
  }

  private async handleLine(line: string, socket: Socket, signal: AbortSignal): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      log.warn('hook 訊息不是合法 JSON，已丟棄');
      return;
    }
    if ((json as { type?: unknown } | null)?.type === 'auth.challenge') {
      this.handleChallenge(json, socket);
      return;
    }
    if ((json as { type?: unknown } | null)?.type === 'mcp') {
      await this.handleMcp(json, socket);
      return;
    }
    const parsed = HookRequest.safeParse(json);
    if (!parsed.success) {
      log.warn('hook 訊息不符合協定');
      // 帶得出 requestId 就回一聲，別讓 hook 空等到逾時。
      const requestId = (json as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId === 'string' && requestId) this.reply(socket, requestId, null);
      return;
    }
    let output: HookOutput = null;
    try {
      output = await this.handler(parsed.data, signal);
    } catch (error) {
      log.error(`處理 hook ${parsed.data.event} 失敗：${errorMessage(error)}`);
    }
    this.reply(socket, parsed.data.requestId, output);
  }

  /** 驗證交給 handler（daemon 比對密鑰）；這裡只負責格式。訊息內容（含密鑰）不進 log。 */
  private async handleMcp(json: unknown, socket: Socket): Promise<void> {
    const parsed = McpRequest.safeParse(json);
    const requestId = (json as { requestId?: unknown }).requestId;
    let result: Pick<McpReply, 'ok' | 'text'>;
    if (!parsed.success || !this.mcpHandler) {
      log.warn('派工請求格式不對或沒有啟用，已拒絕');
      result = { ok: false, text: 'invalid_request: Agent Board could not read this request.' };
    } else {
      try {
        result = await this.mcpHandler(parsed.data);
      } catch (error) {
        log.error(`處理派工請求失敗：${errorMessage(error)}`);
        result = { ok: false, text: 'internal_error: Agent Board daemon failed on this request.' };
      }
    }
    if (typeof requestId !== 'string' || !requestId) return;
    if (socket.destroyed || !socket.writable) return;
    const reply: McpReply = { type: 'mcp.reply', requestId, ...result };
    socket.write(`${JSON.stringify(reply)}\n`);
  }

  private reply(socket: Socket, requestId: string, output: HookOutput): void {
    if (socket.destroyed || !socket.writable) return;
    const reply: HookReply = { type: 'hook.reply', requestId, output };
    socket.write(`${JSON.stringify(reply)}\n`);
  }
}
