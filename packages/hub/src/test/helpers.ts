// 測試工具：真的 hub（127.0.0.1 隨機 port、臨時資料夾）、假 daemon、假瀏覽器。不碰家目錄、不打外部網路。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { Approval, SessionRuntime, SessionSpec } from '@agent-board/protocol';
import { createHub, type HubOptions, type RunningHub } from '../server';
import type { PushResult, PushTransport } from '../push';

export const FAST_PASSWORD = { memoryCost: 1024, timeCost: 2, parallelism: 1 };
export const PASSWORD = 'correct horse battery';

export const capabilities = {
  hasGpu: false,
  gpuName: null,
  cpuCores: 4,
  memoryBytes: 1024,
  claudeVersion: null,
};

export const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  name: 'test session',
  projectId: null,
  cwd: '/fake/project',
  useWorktree: false,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  resumeClaudeSessionId: null,
  firstPrompt: null,
  ...over,
});

export const runtime = (id: string, over: Partial<SessionRuntime> = {}): SessionRuntime => ({
  id,
  cwd: '/fake/project',
  branch: null,
  worktreePath: null,
  status: 'running',
  statusDetail: null,
  claudeSessionId: 'claude-1',
  lastLines: [],
  lastOutputAt: null,
  statusSince: new Date().toISOString(),
  contextTokens: null,
  endedAt: null,
  ...over,
});

export const approval = (sessionId: string, over: Partial<Approval> = {}): Approval => ({
  id: `approval-${Math.random()}`,
  sessionId,
  kind: 'permission',
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  suggestions: [],
  matchedRule: null,
  message: null,
  createdAt: new Date().toISOString(),
  ...over,
});

export const until = async (check: () => boolean, label = 'condition', timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

type Msg = Record<string, unknown> & { type: string };

/** 共用的 WebSocket 包裝：收到的訊息全部留著，可以等特定訊息出現。 */
export class Peer {
  readonly messages: Msg[] = [];
  closeCode: number | null = null;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => this.messages.push(JSON.parse(raw.toString()) as Msg));
    ws.on('close', (code) => {
      this.closeCode = code;
    });
    ws.on('error', () => undefined);
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  of(type: string): Msg[] {
    return this.messages.filter((m) => m.type === type);
  }

  /** 等下一則（尚未被取走的）符合條件的訊息。 */
  async next(type: string, match: (m: Msg) => boolean = () => true): Promise<Msg> {
    let found: Msg | undefined;
    await until(() => {
      for (let i = 0; i < this.messages.length; i += 1) {
        const m = this.messages[i]!;
        if (m.type === type && match(m)) {
          found = m;
          this.messages.splice(i, 1);
          return true;
        }
      }
      return false;
    }, `message ${type}`);
    return found!;
  }

  clear(): void {
    this.messages.length = 0;
  }

  async closed(): Promise<number> {
    await until(() => this.closeCode !== null, 'socket close');
    return this.closeCode!;
  }

  close(): void {
    this.ws.close();
  }
}

export const recordingTransport = () => {
  const sent: { endpoint: string; payload: string }[] = [];
  let result: PushResult = 'ok';
  const transport: PushTransport = {
    send: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload });
      return result;
    },
  };
  return { sent, transport, setResult: (next: PushResult) => (result = next) };
};

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestHub {
  running: RunningHub;
  url: string;
  port: number;
  origin: string;
  dir: string;
  dbPath: string;
  push: ReturnType<typeof recordingTransport>;
  api<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
    method: string,
    path: string,
    options?: { body?: unknown; cookie?: string; headers?: Record<string, string> },
  ): Promise<ApiResult<T>>;
  setupOwner(): Promise<string>;
  createMember(ownerCookie: string, name?: string): Promise<{ cookie: string; id: string }>;
  pair(ownerCookie: string, name?: string): Promise<{ machineId: string; token: string }>;
  daemon(token: string): Promise<Peer>;
  /** 配對並完成 hello／welcome。 */
  onlineDaemon(
    ownerCookie: string,
    hello?: { sessions?: SessionRuntime[]; pendingApprovals?: Approval[] },
  ): Promise<{ daemon: Peer; machineId: string; token: string }>;
  client(cookie: string): Promise<Peer>;
  stop(): Promise<void>;
}

export const hello = (over: object = {}) => ({
  type: 'daemon.hello',
  name: 'fake-machine',
  os: 'linux',
  version: '0.0.0',
  capabilities,
  sessions: [],
  pendingApprovals: [],
  ...over,
});

/** Peer 要在 open 之前掛好：hub 的第一則訊息可能跟著升級回應一起到。 */
export async function connect(url: string, headers: Record<string, string>): Promise<Peer> {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false });
  const peer = new Peer(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.once('error', reject);
  });
  return peer;
}

export async function startHub(options: Partial<HubOptions> = {}): Promise<TestHub> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-hub-test-'));
  const dbPath = options.dbPath ?? join(dir, 'hub.db');
  const push = recordingTransport();
  const running = createHub({
    host: '127.0.0.1',
    port: 0,
    webDir: null,
    passwordParams: FAST_PASSWORD,
    pushTransport: push.transport,
    ...options,
    dbPath,
  });
  const { url, port } = await running.listen();
  const peers: Peer[] = [];

  const api: TestHub['api'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // 保留原始文字（例如 CSV）
    }
    return { status: res.status, body: body as never, headers: res.headers };
  };

  const cookieFrom = (res: ApiResult) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const hub: TestHub = {
    running,
    url,
    port,
    origin: url,
    dir,
    dbPath,
    push,
    api,
    async setupOwner() {
      const res = await api('POST', '/api/auth/setup', {
        body: { name: 'owner', password: PASSWORD, locale: 'en' },
      });
      if (res.status !== 200) throw new Error(`setup failed: ${res.status}`);
      return cookieFrom(res);
    },
    async createMember(ownerCookie, name = 'member') {
      const created = await api('POST', '/api/users', {
        cookie: ownerCookie,
        body: { name, password: PASSWORD, role: 'member', locale: 'en' },
      });
      const login = await api('POST', '/api/auth/login', { body: { name, password: PASSWORD } });
      return { cookie: cookieFrom(login), id: created.body.id };
    },
    async pair(ownerCookie, name = 'fake-machine') {
      const code = await api('POST', '/api/machines/pairing-codes', { cookie: ownerCookie });
      const res = await api('POST', '/api/machines/pair', {
        body: { code: code.body.code, name, os: 'linux', capabilities },
      });
      return res.body;
    },
    async daemon(token) {
      const peer = await connect(`ws://127.0.0.1:${port}/ws/daemon`, {
        authorization: `Bearer ${token}`,
      });
      peers.push(peer);
      return peer;
    },
    async onlineDaemon(ownerCookie, helloOver = {}) {
      const { machineId, token } = await hub.pair(ownerCookie);
      const daemon = await hub.daemon(token);
      daemon.send(hello(helloOver));
      await daemon.next('hub.welcome');
      return { daemon, machineId, token };
    },
    async client(cookie) {
      const peer = await connect(`ws://127.0.0.1:${port}/ws/client`, {
        cookie,
        origin: url,
      });
      peers.push(peer);
      await peer.next('board.state');
      return peer;
    },
    async stop() {
      for (const peer of peers) peer.ws.terminate();
      await running.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return hub;
}
