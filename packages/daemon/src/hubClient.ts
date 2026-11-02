// 主動連 hub 的 WebSocket。斷線不影響 session，重連後由 daemon.hello 對帳（CONTRACTS §3.3）。
import { DaemonToHub, HubToDaemon } from '@agent-board/protocol';
import WebSocket from 'ws';
import { errorMessage, log } from './log';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.2;
/** token 被撤銷時重試也沒用，只偶爾確認一下（例如 owner 復原或重新配對後）。 */
const AUTH_REJECTED_RETRY_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const OUTBOX_LIMIT = 2_000;
/** 網路塞住時不再堆終端機輸出；收方看到跳號會重新訂閱拿快照。 */
const MAX_BUFFERED_OUTPUT_BYTES = 16 * 1024 * 1024;

type HelloMessage = Extract<DaemonToHub, { type: 'daemon.hello' }>;

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  return Math.round(base * (1 - BACKOFF_JITTER + random() * BACKOFF_JITTER * 2));
}

/** 無法從 hello 或重新訂閱補回的訊息：斷線時留著，重連後補送。 */
function mustDeliver(message: DaemonToHub): boolean {
  switch (message.type) {
    case 'session.event':
    case 'session.created':
    case 'session.createFailed':
      return true;
    default:
      return false;
  }
}

export interface HubClientOptions {
  url: string;
  token: string;
  buildHello: () => HelloMessage;
  onMessage: (message: HubToDaemon) => void;
  onDisconnected: () => void;
  heartbeatMs?: number;
  authRetryMs?: number;
}

export class HubClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private outbox: DaemonToHub[] = [];

  constructor(private readonly options: HubClientOptions) {}

  /** 收到 hub.welcome 後才算連上。 */
  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.ready = false;
    this.ws?.terminate();
    this.ws = null;
  }

  send(message: DaemonToHub): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      if (mustDeliver(message)) this.enqueue(message);
      return;
    }
    if (message.type === 'terminal.output' && this.ws.bufferedAmount > MAX_BUFFERED_OUTPUT_BYTES) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  /** 寫進 socket 才算送出；連不上或寫入失敗回報 false，由呼叫方決定之後重送。 */
  sendConfirmed(message: DaemonToHub, onResult: (sent: boolean) => void): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      onResult(false);
      return;
    }
    this.ws.send(JSON.stringify(message), (error) => onResult(!error));
  }

  private enqueue(message: DaemonToHub): void {
    if (this.outbox.length >= OUTBOX_LIMIT) {
      this.outbox.shift();
      log.warn('hub 斷線太久，丟棄最舊的待送訊息');
    }
    this.outbox.push(message);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    this.ws = ws;
    let authRejected = false;

    ws.on('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      authRejected = status === 401 || status === 403;
      if (authRejected) {
        const minutes = Math.round((this.options.authRetryMs ?? AUTH_REJECTED_RETRY_MS) / 60_000);
        log.error(
          `hub 拒絕這台機器的 token（HTTP ${status}），可能已被撤銷。session 繼續執行，約每 ${minutes} 分鐘重試一次；請到中控台產生配對碼，重新執行 agent-board-daemon pair。`,
        );
      } else {
        log.warn(`hub 連線被拒（HTTP ${status}）`);
      }
      ws.terminate();
    });
    ws.on('open', () => {
      this.startHeartbeat(ws);
      ws.send(JSON.stringify(this.options.buildHello()));
    });
    ws.on('message', (raw, isBinary) => {
      if (!isBinary) this.handleRaw(raw.toString());
    });
    // close 一定會跟在 error 之後，重連統一在 close 處理。
    ws.on('error', (error) => {
      if (!authRejected) log.warn(`hub 連線錯誤：${errorMessage(error)}`);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.stopHeartbeat();
      this.options.onDisconnected();
      this.scheduleReconnect(authRejected);
    });
  }

  private handleRaw(raw: string): void {
    let parsed: ReturnType<typeof HubToDaemon.safeParse>;
    try {
      parsed = HubToDaemon.safeParse(JSON.parse(raw));
    } catch {
      log.warn('hub 訊息不是合法 JSON，已丟棄');
      return;
    }
    if (!parsed.success) {
      log.warn('hub 訊息不符合協定，已丟棄');
      return;
    }
    const message = parsed.data;
    if (message.type === 'hub.welcome') {
      // 收到 welcome 才歸零，避免 hub 接受後立刻踢線時以 1 秒間隔狂連。
      this.attempt = 0;
      this.ready = true;
    }
    try {
      this.options.onMessage(message);
    } catch (error) {
      log.error(`處理 hub 訊息 ${message.type} 失敗：${errorMessage(error)}`);
    }
    if (message.type === 'hub.welcome') this.flushOutbox();
  }

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    for (const message of pending) this.send(message);
  }

  private scheduleReconnect(authRejected: boolean): void {
    if (this.stopped) return;
    let delay: number;
    if (authRejected) {
      delay = (this.options.authRetryMs ?? AUTH_REJECTED_RETRY_MS) * (0.9 + Math.random() * 0.2);
    } else {
      delay = backoffDelay(this.attempt);
      this.attempt += 1;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Tailscale 網路切換時 TCP 可能半開、永遠等不到 close，靠 ping/pong 偵測。 */
  private startHeartbeat(ws: WebSocket): void {
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!alive) {
        log.warn('hub 沒有回應 ping，中斷重連');
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.options.heartbeatMs ?? 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
