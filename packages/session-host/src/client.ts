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
} from '@agent-board/protocol/session-host';
import { localProof, newNonce, verifyLocalProof } from '@agent-board/protocol/local-auth';
import { readToken, type HostEndpoint } from './endpoint';
import { onLines, sendLine } from './lines';

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type HostConnectFailure =
  'unreachable' | 'no_token' | 'protocol_mismatch' | 'unauthorized' | 'timeout' | 'bad_reply';

/** 請求逾時：host 可能之後還是會做（例如 spawn），呼叫端要自己收尾。 */
export class HostRequestTimeoutError extends Error {}

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
    {
      timeoutMs = CONNECT_TIMEOUT_MS,
      protocol = SESSION_HOST_PROTOCOL,
    }: {
      timeoutMs?: number;
      /** 只給測試：假裝成別的協定版本（驗證不相容時的處理）。 */
      protocol?: number;
    } = {},
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
      // 協定 2（W5）：只送 nonce；host 先證明自己拿得到 token，daemon 驗過才回自己的證明。token 不經過 socket。
      const nonce = newNonce();
      let challenged = false;
      socket.once('connect', () => {
        sendLine(socket, { type: 'hello', protocol, nonce });
      });
      let client: SessionHostClient | null = null;
      onLines(
        socket,
        (line) => {
          if (client) {
            client.handleLine(line);
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            fail('bad_reply', 'session host 的回覆格式不對');
            return;
          }
          // 協定 1 的舊 host 看不懂沒有 token 的 hello，回 `error bad_message` 後斷線：當成協定不相容。
          const legacy = raw as { type?: unknown; error?: unknown } | null;
          if (!challenged && legacy?.type === 'error' && legacy.error === 'bad_message') {
            fail(
              'protocol_mismatch',
              `session host 是舊版（協定 1），看不懂協定 ${protocol} 的 hello`,
            );
            return;
          }
          const parsed = HostToDaemon.safeParse(raw);
          if (!parsed.success) {
            fail('bad_reply', 'session host 的回覆格式不對');
            return;
          }
          const message = parsed.data;
          if (message.type === 'hello.challenge') {
            if (challenged) {
              fail('bad_reply', 'session host 送了兩次 hello.challenge');
              return;
            }
            challenged = true;
            if (message.protocol !== protocol) {
              fail('protocol_mismatch', `session host 協定 ${message.protocol} 不相容`);
              return;
            }
            if (!verifyLocalProof(token, 'hostServer', nonce, message.proof)) {
              // 對方不知道 token：可能是別的程序搶先開了同名 pipe。什麼都不送，直接斷。
              fail('unauthorized', 'session host 無法證明身分（token 不符），不送任何東西');
              return;
            }
            sendLine(socket, {
              type: 'hello.auth',
              proof: localProof(token, 'hostClient', message.nonce),
            });
            return;
          }
          if (message.type === 'hello.error') {
            fail(
              message.error === 'protocol_mismatch' ? 'protocol_mismatch' : 'unauthorized',
              `session host 拒絕連線：${message.error}（host 協定 ${message.protocol}，daemon ${SESSION_HOST_PROTOCOL}）`,
            );
            return;
          }
          if (message.type !== 'hello.ok' || !challenged) {
            fail('bad_reply', `session host 先送了 ${message.type}`);
            return;
          }
          if (message.protocol !== protocol) {
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
      case 'shutdown':
        // host 要收掉所有 agent：之後的結束都不是 session 自己結束的，當成連線中斷處理（daemon 會改用 --resume）。
        this.close();
        return;
      case 'hello.ok':
      case 'hello.error':
      case 'hello.challenge':
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
        reject(new HostRequestTimeoutError(`session host 沒有回覆 ${message.type}`));
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

/**
 * 占著這個位置的是不是真的 session host（審查 W3）：讀 token 檔、送 hello（只有 nonce），對方要在時限內用 token
 * 證明自己（hello.challenge）。只驗對方、不送自己的證明，驗完就斷。token 檔讀不到、對方不回、證明不對都回 false。
 */
export function proveHost(
  endpoint: HostEndpoint,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  const token = readToken(endpoint.tokenPath);
  if (!token) return Promise.resolve(false);
  return new Promise((resolve) => {
    const nonce = newNonce();
    const socket = connect(endpoint.path);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
    socket.once('connect', () => {
      sendLine(socket, { type: 'hello', protocol: SESSION_HOST_PROTOCOL, nonce });
    });
    onLines(
      socket,
      (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return done(false);
        }
        const m = message as { type?: unknown; proof?: unknown };
        done(m.type === 'hello.challenge' && verifyLocalProof(token, 'hostServer', nonce, m.proof));
      },
      () => done(false),
    );
  });
}

/**
 * host 的 socket 有沒有人在聽（不送任何東西）。`absent`＝確定沒有 host（socket 不存在或連線被拒），
 * 只有這種情況 daemon 才能放心用 --resume 重開；`alive`＝連得上；`unknown`＝其他錯誤（當成可能還在）。
 */
export function probeHost(
  endpoint: HostEndpoint,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<'absent' | 'alive' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = connect(endpoint.path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('unknown');
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('alive');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'absent' : 'unknown');
    });
  });
}
