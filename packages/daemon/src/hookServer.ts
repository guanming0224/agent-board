// 本機 hook socket：unix socket 或 Windows named pipe，NDJSON（CONTRACTS §4.2）。
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookReply, HookRequest } from '@agent-board/protocol';
import { errorMessage, log } from './log';

/** macOS 的 sun_path 上限 104 bytes，保守一點。 */
const MAX_UNIX_SOCKET_BYTES = 100;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type HookOutput = HookReply['output'];
/** signal 在 hook 連線斷掉時 abort。 */
export type HookHandler = (request: HookRequest, signal: AbortSignal) => Promise<HookOutput>;

interface SocketLocation {
  path: string;
  /** 路徑太長時放在這個暫存資料夾，關閉時一併清掉。 */
  tempDir: string | null;
}

function resolveSocketLocation(dataDir: string): SocketLocation {
  if (process.platform === 'win32') {
    return { path: `\\\\.\\pipe\\agent-board-${randomUUID()}`, tempDir: null };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const preferred = join(dataDir, 'hook.sock');
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_BYTES) {
    return { path: preferred, tempDir: null };
  }
  // mkdtemp 建立的資料夾權限 0700、名稱隨機，其他使用者碰不到裡面的 socket。
  const tempDir = mkdtempSync(join(tmpdir(), 'ab-'));
  return { path: join(tempDir, 'hook.sock'), tempDir };
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

  private reply(socket: Socket, requestId: string, output: HookOutput): void {
    if (socket.destroyed || !socket.writable) return;
    const reply: HookReply = { type: 'hook.reply', requestId, output };
    socket.write(`${JSON.stringify(reply)}\n`);
  }
}
