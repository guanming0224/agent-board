// daemon 端連 session host 的客戶端（CONTRACTS §20）。連不上、token 不對、協定不相容都丟 HostConnectError，
// daemon 據此退回自己開 PTY 的舊模式。
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  HostToDaemon,
  SESSION_HOST_PROTOCOL,
  type DaemonToHost,
  type HostSessionInfo,
  type HostSignal,
} from '@agent-board/protocol';
import { readToken, type HostEndpoint } from './endpoint';
import { onLines, sendLine } from './lines';

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type HostConnectFailure =
  'unreachable' | 'no_token' | 'protocol_mismatch' | 'unauthorized' | 'timeout' | 'bad_reply';

export class HostConnectError extends Error {
  constructor(
    readonly reason: HostConnectFailure,
    message: string,
  ) {
    super(message);
  }
}

/** 某個 session 的事件。attach 之後依序是 attached → (gap) → output… → replayDone → 即時 output／exit。 */
export interface HostSessionHandlers {
  onAttached?: (session: HostSessionInfo) => void;
  onOutput: (seq: number, data: Buffer) => void;
  onGap?: (lostBytes: number) => void;
  onReplayDone?: (seq: number) => void;
  onExit: (code: number, signal: number | null) => void;
  onError?: (error: string) => void;
}

interface Pending {
  resolve: (message: Extract<HostToDaemon, { type: 'result' }>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SpawnRequest {
  id: string;
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
}

export class SessionHostClient {
  private readonly handlers = new Map<string, HostSessionHandlers>();
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    readonly hostVersion: string,
    /** hello 當下 host 養著的 session。 */
    readonly sessions: HostSessionInfo[],
  ) {}

  /** 連上並完成 hello。失敗一律丟 HostConnectError。 */
  static connect(
    endpoint: HostEndpoint,
    { timeoutMs = CONNECT_TIMEOUT_MS }: { timeoutMs?: number } = {},
  ): Promise<SessionHostClient> {
    const token = readToken(endpoint.tokenPath);
    if (!token) {
      return Promise.reject(
        new HostConnectError('no_token', `讀不到 session host 的 token：${endpoint.tokenPath}`),
      );
    }
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint.path);
      let settled = false;
      const fail = (reason: HostConnectFailure, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new HostConnectError(reason, message));
      };
      const timer = setTimeout(() => fail('timeout', 'session host 沒有在時限內回應'), timeoutMs);
      socket.once('error', (error) => fail('unreachable', error.message));
      socket.once('close', () => fail('unreachable', 'session host 關閉了連線'));
      socket.once('connect', () => {
        sendLine(socket, { type: 'hello', protocol: SESSION_HOST_PROTOCOL, token });
      });
      let client: SessionHostClient | null = null;
      onLines(
        socket,
        (line) => {
          if (client) {
            client.handleLine(line);
            return;
          }
          let message: HostToDaemon;
          try {
            message = HostToDaemon.parse(JSON.parse(line));
          } catch {
            fail('bad_reply', 'session host 的回覆格式不對');
            return;
          }
          if (message.type === 'hello.error') {
            fail(
              message.error === 'protocol_mismatch' ? 'protocol_mismatch' : 'unauthorized',
              `session host 拒絕連線：${message.error}（host 協定 ${message.protocol}，daemon ${SESSION_HOST_PROTOCOL}）`,
            );
            return;
          }
          if (message.type !== 'hello.ok') {
            fail('bad_reply', `session host 先送了 ${message.type}`);
            return;
          }
          if (message.protocol !== SESSION_HOST_PROTOCOL) {
            fail('protocol_mismatch', `session host 協定 ${message.protocol} 不相容`);
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.removeAllListeners('error');
          socket.removeAllListeners('close');
          client = new SessionHostClient(socket, message.hostVersion, message.sessions);
          client.listen();
          resolve(client);
        },
        () => fail('bad_reply', 'session host 的訊息超過上限'),
      );
    });
  }

  get connected(): boolean {
    return !this.closed;
  }

  private listen(): void {
    this.socket.on('error', () => {
      // close 事件會接手。
    });
    this.socket.on('close', () => this.handleClose());
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [reqId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.reject(new Error('session host 連線已中斷'));
    }
    for (const listener of this.closeListeners) listener();
  }

  /** 連線中斷（host 結束或崩潰）時呼叫。daemon 自己 close() 也會觸發。 */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.destroy();
    this.handleClose();
  }

  private handleLine(line: string): void {
    let message: HostToDaemon;
    try {
      message = HostToDaemon.parse(JSON.parse(line));
    } catch {
      return;
    }
    switch (message.type) {
      case 'result': {
        const pending = this.pending.get(message.reqId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.reqId);
        pending.resolve(message);
        return;
      }
      case 'attached':
        this.handlers.get(message.session.id)?.onAttached?.(message.session);
        return;
      case 'output':
        this.handlers.get(message.id)?.onOutput(message.seq, Buffer.from(message.data, 'base64'));
        return;
      case 'replay.gap':
        this.handlers.get(message.id)?.onGap?.(message.lostBytes);
        return;
      case 'replay.done':
        this.handlers.get(message.id)?.onReplayDone?.(message.seq);
        return;
      case 'exit':
        this.handlers.get(message.id)?.onExit(message.code, message.signal);
        return;
      case 'error':
        if (message.id) this.handlers.get(message.id)?.onError?.(message.error);
        return;
      case 'hello.ok':
      case 'hello.error':
        return;
      default:
        message satisfies never;
    }
  }

  private send(message: DaemonToHost): void {
    if (!this.closed) sendLine(this.socket, message);
  }

  private request(
    message: Extract<DaemonToHost, { reqId: string }>,
  ): Promise<Extract<HostToDaemon, { type: 'result' }>> {
    if (this.closed) return Promise.reject(new Error('session host 連線已中斷'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.reqId);
        reject(new Error(`session host 沒有回覆 ${message.type}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(message.reqId, { resolve, reject, timer });
      this.send(message);
    });
  }

  /** 收事件的對象。先註冊再 spawn／attach，才不會漏掉第一塊輸出。 */
  register(id: string, handlers: HostSessionHandlers): void {
    this.handlers.set(id, handlers);
  }

  unregister(id: string): void {
    this.handlers.delete(id);
  }

  async spawn(request: SpawnRequest): Promise<number> {
    const reply = await this.request({ type: 'spawn', reqId: randomUUID(), ...request });
    if (!reply.ok) throw new Error(reply.error ?? 'session host 開不起來');
    return reply.pid ?? 0;
  }

  async list(): Promise<HostSessionInfo[]> {
    const reply = await this.request({ type: 'list', reqId: randomUUID() });
    return reply.sessions ?? [];
  }

  attach(id: string, fromSeq: number): void {
    this.send({ type: 'attach', id, fromSeq });
  }

  write(id: string, data: string): void {
    this.send({ type: 'write', id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ type: 'resize', id, cols, rows });
  }

  kill(id: string, signal: HostSignal): void {
    this.send({ type: 'kill', id, signal });
  }

  release(id: string): void {
    this.send({ type: 'release', id });
  }
}
