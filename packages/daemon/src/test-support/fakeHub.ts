// 綁 127.0.0.1 隨機 port 的假 hub。
import type { AddressInfo } from 'node:net';
import { DaemonToHub, type HubToDaemon } from '@agent-board/protocol';
import { WebSocket, WebSocketServer } from 'ws';

type Predicate = (message: DaemonToHub) => boolean;

export class FakeHub {
  readonly received: DaemonToHub[] = [];
  /** 不符合 schema 的訊息；測試結束時應為空。 */
  readonly invalid: unknown[] = [];
  readonly authHeaders: (string | undefined)[] = [];
  autoWelcome = true;
  /** 設定後升級請求一律回這個狀態碼（模擬 token 被撤銷）。 */
  rejectStatus: number | null = null;
  upgradeAttempts = 0;
  dangerRules = ['rm -rf /', 'git push --force'];
  stuckMinutes = 7;
  private wss!: WebSocketServer;
  private socket: WebSocket | null = null;
  private waiters: { predicate: Predicate; resolve: (m: DaemonToHub) => void }[] = [];
  port = 0;

  async start(port = 0): Promise<void> {
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      path: '/ws/daemon',
      verifyClient: (_info, done) => {
        this.upgradeAttempts += 1;
        if (this.rejectStatus !== null) done(false, this.rejectStatus);
        else done(true);
      },
    });
    await new Promise<void>((resolve) => this.wss.once('listening', () => resolve()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (socket, request) => {
      this.authHeaders.push(request.headers.authorization);
      this.socket = socket;
      socket.on('message', (raw) => this.handle(socket, raw.toString()));
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws/daemon`;
  }

  private handle(socket: WebSocket, raw: string): void {
    const parsed = DaemonToHub.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      this.invalid.push({ raw, issues: parsed.error.issues });
      return;
    }
    const message = parsed.data;
    this.received.push(message);
    if (message.type === 'daemon.hello' && this.autoWelcome) {
      socket.send(
        JSON.stringify({
          type: 'hub.welcome',
          machineId: 'machine-1',
          dangerRules: this.dangerRules,
          stuckMinutes: this.stuckMinutes,
        } satisfies HubToDaemon),
      );
    }
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.predicate(message)) return true;
      waiter.resolve(message);
      return false;
    });
  }

  send(message: HubToDaemon): void {
    this.socket?.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.socket?.send(text);
  }

  /** 等下一則符合的訊息；includePast 時已收到的也算。 */
  waitFor<T extends DaemonToHub['type']>(
    type: T,
    predicate: (message: Extract<DaemonToHub, { type: T }>) => boolean = () => true,
    { includePast = true, timeoutMs = 8_000 }: { includePast?: boolean; timeoutMs?: number } = {},
  ): Promise<Extract<DaemonToHub, { type: T }>> {
    const match = (m: DaemonToHub): m is Extract<DaemonToHub, { type: T }> =>
      m.type === type && predicate(m as Extract<DaemonToHub, { type: T }>);
    if (includePast) {
      const found = this.received.find(match);
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`等不到 ${type}；已收到 ${this.received.map((m) => m.type).join(',')}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate: match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<DaemonToHub, { type: T }>);
        },
      });
    });
  }

  /** 把目前連線切斷，但繼續監聽。 */
  dropConnection(): void {
    this.socket?.terminate();
    this.socket = null;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
