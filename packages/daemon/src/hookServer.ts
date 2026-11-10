// 本機 hook socket：unix socket 或 Windows named pipe，NDJSON（CONTRACTS §4.2）。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookReply, HookRequest, McpReply, McpRequest } from '@agent-board/protocol';
import { installId, stableShortDir } from '@agent-board/session-host';
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

  constructor(
    private readonly dataDir: string,
    private readonly handler: HookHandler,
    private readonly mcpHandler: McpHandler | null = null,
  ) {}

  get path(): string {
    if (!this.location) throw new Error('hook server 尚未啟動');
    return this.location.path;
  }

  async start(): Promise<void> {
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
    const server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(location.path, () => {
        server.off('error', reject);
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
