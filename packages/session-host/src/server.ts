// session host 本體：用 node-pty 開 agent、養著程序、保留最近的原始輸出、轉送輸入與 resize、回報結束碼。
// daemon 重啟時 agent 不會跟著結束；daemon 回來後 attach 重播輸出（CONTRACTS §20）。
// 不懂 claude／codex、不解析畫面、不連網路、不呼叫 LLM。執行紀錄不寫終端機內容、env、token。
import { timingSafeEqual } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  DaemonToHost,
  SESSION_HOST_BUFFER_BYTES,
  SESSION_HOST_PROTOCOL,
  type HostSessionInfo,
  type HostSignal,
  type HostToDaemon,
} from '@agent-board/protocol';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { ensurePrivateDir, hostEndpoint, writeToken, type HostEndpoint } from './endpoint';
import { onLines, sendLine } from './lines';
import { RingBuffer } from './ringBuffer';

/** 第一則一定要是 hello，等太久就斷。 */
const HELLO_TIMEOUT_MS = 5_000;
/** 結束了但 daemon 還沒 release 的 session 最多留幾個（daemon 一直沒回來時不無限長）。 */
const MAX_EXITED = 100;
/** 關閉 host 時：SIGHUP 之後等多久才強制結束。 */
const SHUTDOWN_GRACE_MS = 2_000;
const SIGKILL = 9;

export interface HostLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export const consoleLogger: HostLogger = {
  info: (message) => console.error('[agent-board-session-host]', message),
  warn: (message) => console.error('[agent-board-session-host] WARN', message),
  error: (message) => console.error('[agent-board-session-host] ERROR', message),
};

export interface SessionHostServerOptions {
  dataDir: string;
  /** 不給就照資料夾算（hostEndpoint）。 */
  endpoint?: HostEndpoint;
  bufferBytes?: number;
  version?: string;
  log?: HostLogger;
  helloTimeoutMs?: number;
  maxExited?: number;
}

interface Connection {
  socket: Socket;
  authed: boolean;
}

interface HostSession {
  id: string;
  pty: IPty;
  pid: number;
  alive: boolean;
  exitCode: number | null;
  signal: number | null;
  exitedAt: number | null;
  buffer: RingBuffer;
  /** 目前接著的 daemon 連線；沒人接時輸出只進緩衝。 */
  owner: Connection | null;
  cols: number;
  rows: number;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

export class SessionHostServer {
  readonly endpoint: HostEndpoint;
  private readonly log: HostLogger;
  private readonly sessions = new Map<string, HostSession>();
  private readonly connections = new Set<Connection>();
  private server: Server | null = null;
  private token = '';

  constructor(private readonly options: SessionHostServerOptions) {
    this.endpoint = options.endpoint ?? hostEndpoint(options.dataDir);
    this.log = options.log ?? consoleLogger;
  }

  get path(): string {
    return this.endpoint.path;
  }

  /** 目前養著的 session 數（含已結束、還沒 release 的）。 */
  get sessionCount(): number {
    return this.sessions.size;
  }

  async start(): Promise<void> {
    ensurePrivateDir(this.options.dataDir);
    if (this.endpoint.kind === 'unix') {
      ensurePrivateDir(dirname(this.endpoint.path));
      // 還連得上就是另一個 host 正在用同一份資料夾，不可搶；連不上才是殘留檔。
      if (await socketAlive(this.endpoint.path)) {
        throw new HostAlreadyRunningError(this.endpoint.path);
      }
      try {
        unlinkSync(this.endpoint.path);
      } catch {
        // 沒有殘留檔
      }
    }
    const server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.endpoint.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.endpoint.kind === 'unix') chmodSync(this.endpoint.path, 0o600);
    server.on('error', (error) => this.log.error(`socket 錯誤：${errorMessage(error)}`));
    this.server = server;
    // socket 開好才換 token：daemon 讀到新 token 時一定連得上。
    this.token = writeToken(this.endpoint.tokenPath);
    this.log.info(`已啟動（協定 ${SESSION_HOST_PROTOCOL}）：${this.endpoint.path}`);
  }

  /**
   * 關閉 host。killSessions：agent 一起結束（host 換版、使用者停服務）；false 只給測試用，
   * 模擬 host 程序被殺但不收 agent 的情況。
   */
  async close({ killSessions = true }: { killSessions?: boolean } = {}): Promise<void> {
    const server = this.server;
    this.server = null;
    if (killSessions) await this.killAll();
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async killAll(): Promise<void> {
    const alive = [...this.sessions.values()].filter((s) => s.alive);
    if (alive.length === 0) return;
    this.log.info(`結束 ${alive.length} 個 agent`);
    const exited = alive.map(
      (session) =>
        new Promise<void>((resolve) => {
          const done = () => resolve();
          session.pty.onExit(done);
          if (!session.alive) done();
        }),
    );
    for (const session of alive) this.signal(session, 'SIGHUP');
    const timer = setTimeout(() => {
      for (const session of alive) if (session.alive) this.signal(session, 'SIGKILL');
    }, SHUTDOWN_GRACE_MS);
    await Promise.race([
      Promise.all(exited),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS * 2)),
    ]);
    clearTimeout(timer);
  }

  private handleConnection(socket: Socket): void {
    const connection: Connection = { socket, authed: false };
    this.connections.add(connection);
    const helloTimer = setTimeout(() => {
      if (!connection.authed) socket.destroy();
    }, this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref();
    socket.on('error', () => {
      // daemon 隨時可能離開；close 事件會接手。
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.connections.delete(connection);
      // daemon 走了，agent 照跑；輸出只進緩衝，等下一個 daemon attach。
      for (const session of this.sessions.values()) {
        if (session.owner === connection) session.owner = null;
      }
    });
    onLines(
      socket,
      (line) => this.handleLine(connection, line),
      () => {
        this.log.warn('訊息超過上限，中斷連線');
        socket.destroy();
      },
    );
  }

  private send(connection: Connection, message: HostToDaemon): void {
    sendLine(connection.socket, message);
  }

  private handleLine(connection: Connection, line: string): void {
    let parsed: DaemonToHost;
    try {
      parsed = DaemonToHost.parse(JSON.parse(line));
    } catch {
      this.send(connection, { type: 'error', id: null, error: 'bad_message' });
      if (!connection.authed) connection.socket.destroy();
      return;
    }
    if (parsed.type === 'hello') {
      this.handleHello(connection, parsed);
      return;
    }
    if (!connection.authed) {
      connection.socket.destroy();
      return;
    }
    try {
      this.handleCommand(connection, parsed);
    } catch (error) {
      this.log.warn(`處理 ${parsed.type} 失敗：${errorMessage(error)}`);
      const id = 'id' in parsed ? parsed.id : null;
      this.send(connection, { type: 'error', id, error: errorMessage(error) });
    }
  }

  private handleHello(
    connection: Connection,
    hello: Extract<DaemonToHost, { type: 'hello' }>,
  ): void {
    if (hello.protocol !== SESSION_HOST_PROTOCOL) {
      this.send(connection, {
        type: 'hello.error',
        protocol: SESSION_HOST_PROTOCOL,
        error: 'protocol_mismatch',
      });
      connection.socket.end();
      return;
    }
    if (!this.token || !tokensMatch(this.token, hello.token)) {
      this.log.warn('hello 的 token 不符，拒絕連線');
      this.send(connection, {
        type: 'hello.error',
        protocol: SESSION_HOST_PROTOCOL,
        error: 'unauthorized',
      });
      connection.socket.end();
      return;
    }
    connection.authed = true;
    this.send(connection, {
      type: 'hello.ok',
      protocol: SESSION_HOST_PROTOCOL,
      hostVersion: this.options.version ?? '0.0.0',
      sessions: this.list(),
    });
  }

  private handleCommand(
    connection: Connection,
    command: Exclude<DaemonToHost, { type: 'hello' }>,
  ): void {
    switch (command.type) {
      case 'spawn':
        this.spawn(connection, command);
        return;
      case 'list':
        this.send(connection, {
          type: 'result',
          reqId: command.reqId,
          ok: true,
          error: null,
          sessions: this.list(),
        });
        return;
      case 'attach':
        this.attach(connection, command.id, command.fromSeq);
        return;
      case 'release': {
        const session = this.sessions.get(command.id);
        if (session && !session.alive) this.sessions.delete(command.id);
        return;
      }
    }
    const session = this.sessions.get(command.id);
    if (!session) {
      this.send(connection, { type: 'error', id: command.id, error: 'unknown_session' });
      return;
    }
    switch (command.type) {
      case 'write':
        if (session.alive) session.pty.write(command.data);
        return;
      case 'resize':
        if (!session.alive) return;
        session.pty.resize(command.cols, command.rows);
        session.cols = command.cols;
        session.rows = command.rows;
        return;
      case 'kill':
        if (session.alive) this.signal(session, command.signal);
        return;
      default:
        command satisfies never;
    }
  }

  private spawn(connection: Connection, command: Extract<DaemonToHost, { type: 'spawn' }>): void {
    const existing = this.sessions.get(command.id);
    if (existing?.alive) {
      this.send(connection, {
        type: 'result',
        reqId: command.reqId,
        ok: false,
        error: 'session_exists',
      });
      return;
    }
    let pty: IPty;
    try {
      pty = spawnPty(command.bin, command.args, {
        name: 'xterm-256color',
        cols: command.cols,
        rows: command.rows,
        cwd: command.cwd,
        env: command.env,
      });
    } catch (error) {
      this.send(connection, {
        type: 'result',
        reqId: command.reqId,
        ok: false,
        error: errorMessage(error),
      });
      return;
    }
    // 同一個 id 已結束的舊紀錄（接續 session）換成新的。
    this.sessions.delete(command.id);
    const session: HostSession = {
      id: command.id,
      pty,
      pid: pty.pid,
      alive: true,
      exitCode: null,
      signal: null,
      exitedAt: null,
      buffer: new RingBuffer(this.options.bufferBytes ?? SESSION_HOST_BUFFER_BYTES),
      owner: connection,
      cols: command.cols,
      rows: command.rows,
    };
    this.sessions.set(command.id, session);
    pty.onData((data) => this.handleData(session, data));
    pty.onExit(({ exitCode, signal }) => this.handleExit(session, exitCode, signal ?? 0));
    this.send(connection, {
      type: 'result',
      reqId: command.reqId,
      ok: true,
      error: null,
      pid: pty.pid,
    });
  }

  private handleData(session: HostSession, data: string): void {
    const bytes = Buffer.from(data, 'utf8');
    const seq = session.buffer.append(bytes);
    if (session.owner) {
      this.send(session.owner, {
        type: 'output',
        id: session.id,
        seq,
        data: bytes.toString('base64'),
      });
    }
  }

  private handleExit(session: HostSession, exitCode: number, signal: number): void {
    session.alive = false;
    session.exitCode = exitCode;
    session.signal = signal || null;
    session.exitedAt = Date.now();
    if (session.owner) {
      this.send(session.owner, {
        type: 'exit',
        id: session.id,
        code: exitCode,
        signal: session.signal,
      });
    }
    this.pruneExited();
  }

  /** 結束紀錄太多（daemon 很久沒回來）時丟最舊的。 */
  private pruneExited(): void {
    const exited = [...this.sessions.values()]
      .filter((s) => !s.alive)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));
    const limit = this.options.maxExited ?? MAX_EXITED;
    for (const session of exited.slice(0, Math.max(0, exited.length - limit))) {
      this.sessions.delete(session.id);
    }
  }

  /**
   * 接回：先回現況、重播緩衝、標記重播結束，全在同一個同步區段，中間不會插進新的即時輸出。
   * 已結束的 session 重播完再送 exit。同一個 session 改由這條連線接收。
   */
  private attach(connection: Connection, id: string, fromSeq: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      this.send(connection, { type: 'error', id, error: 'unknown_session' });
      return;
    }
    session.owner = connection;
    this.send(connection, { type: 'attached', session: this.info(session) });
    const { lostBytes, chunks } = session.buffer.readFrom(fromSeq);
    if (lostBytes > 0) this.send(connection, { type: 'replay.gap', id, lostBytes });
    for (const chunk of chunks) {
      this.send(connection, {
        type: 'output',
        id,
        seq: chunk.seq,
        data: chunk.data.toString('base64'),
      });
    }
    this.send(connection, { type: 'replay.done', id, seq: session.buffer.seqEnd });
    if (!session.alive) {
      this.send(connection, {
        type: 'exit',
        id,
        code: session.exitCode ?? 0,
        signal: session.signal,
      });
    }
  }

  private signal(session: HostSession, signal: HostSignal): void {
    try {
      // Windows 的 node-pty 不接受指定訊號。
      if (process.platform === 'win32') session.pty.kill();
      // PTY 子程序是 session leader，pid 即 process group，連子程序一起收。
      else if (signal === 'SIGKILL') process.kill(-session.pid, SIGKILL);
      else session.pty.kill(signal);
    } catch (error) {
      this.log.warn(`送 ${signal} 給 session ${session.id} 失敗：${errorMessage(error)}`);
    }
  }

  private info(session: HostSession): HostSessionInfo {
    return {
      id: session.id,
      pid: session.pid,
      alive: session.alive,
      exitCode: session.exitCode,
      signal: session.signal,
      seqStart: session.buffer.seqStart,
      seqEnd: session.buffer.seqEnd,
      cols: session.cols,
      rows: session.rows,
    };
  }

  private list(): HostSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.info(session));
  }
}

export class HostAlreadyRunningError extends Error {
  constructor(path: string) {
    super(`已有 session host 在使用 ${path}`);
  }
}
