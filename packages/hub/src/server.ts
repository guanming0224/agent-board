// 把 Fastify、WebSocket 升級與 Hub 組起來。測試與 main.ts 都走這裡。
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { relative, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import { WS_PATHS } from '@agent-board/protocol';
import { z } from 'zod';
import {
  DEFAULT_PASSWORD_PARAMS,
  isAllowedHost,
  isAllowedOrigin,
  sha256,
  type PasswordParams,
} from './auth';
import {
  assertBindableHost,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_RETENTION,
  type RetentionDays,
} from './config';
import { openDatabase, type Db } from './db';
import { HttpError } from './errors';
import { DEFAULT_TIMING, Hub, type Timing } from './hub';
import { generateVapidKeys, webPushTransport, type PushTransport } from './push';
import { AUTH_COOKIE, registerRest } from './rest';
import { runRetention, RETENTION_INTERVAL_MS } from './retention';
import { Store } from './store';

export interface HubOptions {
  dbPath: string;
  /** 未指定時用 settings.listenAddress。 */
  host?: string;
  port?: number;
  /** 前端 build 目錄；undefined 表示自動找 packages/web/dist，null 表示不提供。 */
  webDir?: string | null;
  passwordParams?: PasswordParams;
  pushTransport?: PushTransport;
  /** true 印到 stdout；給 stream 時寫到那裡（測試攔日誌用）。 */
  logger?: boolean | { stream: { write(line: string): void } };
  now?: () => Date;
  timing?: Partial<Timing>;
  loginLimit?: { perAccount: number; perIp: number };
  pairingLimit?: { perIp: number; global: number };
  /** undefined 用預設天數；null 不跑（測試用）。 */
  retention?: RetentionDays | null;
}

export interface RunningHub {
  app: FastifyInstance;
  hub: Hub;
  store: Store;
  db: Db;
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

/**
 * 請求日誌只記路徑、不記查詢字串：`GET /api/search?q=…` 的查詢字可能是 GM 貼上的金鑰（§3.5、D9 金鑰不落地），
 * 其他路由的查詢參數也沒有要留在日誌裡的。
 */
export const LOG_SERIALIZERS = {
  req: (req: { method: string; url: string; ip?: string }) => ({
    method: req.method,
    url: req.url.split('?')[0],
    remoteAddress: req.ip,
  }),
};

/** 瀏覽器貼上的大段文字要過得來，但不能無上限。 */
const CLIENT_MAX_PAYLOAD = 4 * 1024 * 1024;
/** 快照可能含整段 scrollback。 */
const DAEMON_MAX_PAYLOAD = 64 * 1024 * 1024;

/** 推播用的 service worker，放在網站根目錄，scope 才涵蓋整個 app（web 的 flows/pwa/sw.js）。 */
const SERVICE_WORKER_FILE = 'sw.js';

/**
 * 首頁與開機檢查每次都重抓（no-store），檔名帶 hash 的 assets/ 永久快取（immutable），兩邊都不會走 304。
 * 2026-11-09 iPhone Safari 從入口頁點進來時，首頁與主程式走 304 快取就停在「畫面沒有載入成功」，整頁 200 才正常
 * （hub.log 01:57:03／:19／:34）；首頁換新版時也不會再拿舊首頁去要已經不存在的舊 hash 檔。
 */
const NO_STORE_FILES = new Set(['index.html', 'boot-check.js']);
const IMMUTABLE_DIR = 'assets';

function cacheControlFor(webDir: string, path: string): string | null {
  const rel = relative(webDir, path);
  if (rel === SERVICE_WORKER_FILE) return 'no-cache';
  if (NO_STORE_FILES.has(rel)) return 'no-store';
  if (rel.startsWith(`${IMMUTABLE_DIR}${sep}`)) return 'public, max-age=31536000, immutable';
  return null;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

/** ws: wss: 全開等於 XSS 可以把東西送到任何地方，所以只放行自己的主機。 */
function contentSecurityPolicy(host: string | undefined): string {
  const self = host && /^[\w.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : '';
  // worker-src 本來就會退回 default-src；寫明是為了推播的 service worker 只能是同源檔案。
  return (
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "worker-src 'self'; manifest-src 'self'; " +
    `connect-src 'self'${self}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; ` +
    "form-action 'self'"
  );
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.on('error', () => undefined);
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHub(options: HubOptions): RunningHub {
  // 明確傳入的位址在碰任何資料之前就先擋。
  if (options.host !== undefined) assertBindableHost(options.host);

  const now = options.now ?? (() => new Date());
  const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
  const db = openDatabase(options.dbPath);
  const store = new Store(db, DEFAULT_HOST);
  const vapid = store.ensureVapidKeys(generateVapidKeys);

  const app = Fastify({
    logger: options.logger
      ? {
          serializers: LOG_SERIALIZERS,
          ...(typeof options.logger === 'object' ? { stream: options.logger.stream } : {}),
        }
      : false,
    // tailscale serve 等反向代理在本機；只有來自 loopback 的 X-Forwarded-For 才可信，限速才分得出來源。
    trustProxy: 'loopback',
    bodyLimit: 1024 * 1024,
  });
  const log = app.log;

  const hub = new Hub({
    store,
    log: {
      info: (obj, msg) => log.info(obj, msg),
      warn: (obj, msg) => log.warn(obj, msg),
      error: (obj, msg) => log.error(obj, msg),
    },
    timing,
    now,
    pushTransport: options.pushTransport ?? webPushTransport,
    vapid,
  });

  // 前端的 fetch 可能帶 JSON content-type 卻沒有 body（stop、logout 這類路由）。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'invalid_json', 'Request body is not valid JSON'));
    }
  });

  app.setErrorHandler((error: FastifyError | Error, req, reply) => {
    if (error instanceof HttpError) {
      if (error.retryAfterSeconds) reply.header('retry-after', error.retryAfterSeconds);
      return reply.status(error.status).send({
        code: error.code,
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      });
    }
    const sqlite = (error as { code?: string }).code ?? '';
    if (sqlite === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return reply
        .status(400)
        .send({ code: 'invalid_reference', message: 'Referenced record does not exist' });
    }
    if (sqlite === 'SQLITE_CONSTRAINT_UNIQUE' || sqlite === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return reply.status(409).send({ code: 'conflict', message: 'Record already exists' });
    }
    const status = (error as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ code: 'invalid_request', message: error.message });
    }
    req.log.error({ err: error }, 'request failed');
    if (error instanceof z.ZodError) {
      // handler 自己回傳了不合 schema 的東西，是我們的 bug，不是使用者的錯。
      return reply.status(500).send({ code: 'internal', message: 'Invalid server response' });
    }
    return reply.status(500).send({ code: 'internal', message: 'Internal server error' });
  });

  app.addHook('onSend', async (req, reply) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) reply.header(key, value);
    reply.header('content-security-policy', contentSecurityPolicy(req.headers.host));
  });

  app.addHook('onRequest', async (req) => {
    if (!isAllowedHost(req.headers.host, () => store.getSettings().publicOrigin)) {
      throw new HttpError(
        421,
        'bad_host',
        'Host not allowed. Open the hub by IP or localhost, or set publicOrigin in settings.',
      );
    }
  });

  app.register(fastifyCookie);
  app.register(async (scope) => {
    registerRest(scope, {
      store,
      hub,
      passwordParams: options.passwordParams ?? DEFAULT_PASSWORD_PARAMS,
      now,
      vapid,
      loginLimit: options.loginLimit ?? { perAccount: 5, perIp: 20 },
      pairingLimit: options.pairingLimit ?? { perIp: 10, global: 30 },
    });
  });

  const webDir =
    options.webDir === undefined ? resolve(import.meta.dirname, '../../web/dist') : options.webDir;
  const serveWeb = webDir !== null && existsSync(webDir);
  if (serveWeb) {
    app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      // service worker 每次都要回來問有沒有新版，不然改了推播處理要等快取過期。其他規則見 cacheControlFor。
      setHeaders: (reply, path) => {
        const cacheControl = cacheControlFor(webDir, path);
        if (cacheControl) reply.header('cache-control', cacheControl);
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    const isAsset = /\.[a-zA-Z0-9]+$/.test(path);
    if (serveWeb && req.method === 'GET' && !path.startsWith('/api/') && !isAsset) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ code: 'not_found', message: 'Not found' });
  });

  const daemonWss = new WebSocketServer({
    noServer: true,
    maxPayload: DAEMON_MAX_PAYLOAD,
    perMessageDeflate: false,
  });
  const clientWss = new WebSocketServer({
    noServer: true,
    maxPayload: CLIENT_MAX_PAYLOAD,
    perMessageDeflate: false,
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const path = new URL(req.url ?? '/', 'http://hub.invalid').pathname;
      if (path === WS_PATHS.daemon) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const machine = bearer ? store.machineByTokenHash(sha256(bearer)) : null;
        if (!machine) return rejectUpgrade(socket, 401, 'Unauthorized');
        daemonWss.handleUpgrade(req, socket, head, (ws) => hub.attachDaemon(ws, machine));
        return;
      }
      if (path === WS_PATHS.client) {
        if (!isAllowedHost(req.headers.host, () => store.getSettings().publicOrigin)) {
          return rejectUpgrade(socket, 421, 'Misdirected Request');
        }
        // 先認證再看 Origin：未登入一律 401。
        const token = fastifyCookie.parse(req.headers.cookie ?? '')[AUTH_COOKIE];
        const tokenHash = token ? sha256(token) : null;
        const user = tokenHash ? store.authSessionUser(tokenHash, now().toISOString()) : null;
        if (!user || !tokenHash) return rejectUpgrade(socket, 401, 'Unauthorized');
        const { publicOrigin } = store.getSettings();
        if (!isAllowedOrigin(req.headers.origin, req.headers.host, publicOrigin)) {
          return rejectUpgrade(socket, 403, 'Forbidden');
        }
        clientWss.handleUpgrade(req, socket, head, (ws) => hub.attachClient(ws, user, tokenHash));
        return;
      }
      rejectUpgrade(socket, 404, 'Not Found');
    } catch (error) {
      app.log.error({ err: error }, 'websocket upgrade failed');
      rejectUpgrade(socket, 500, 'Internal Server Error');
    }
  };
  app.server.on('upgrade', onUpgrade);

  const retentionDays = options.retention === undefined ? DEFAULT_RETENTION : options.retention;
  let retentionTimer: NodeJS.Timeout | null = null;
  const retain = () => {
    if (!retentionDays) return;
    try {
      const result = runRetention(store, retentionDays, options.dbPath, now());
      if (result.archive) {
        hub.audit(null, null, 'audit.retention', JSON.stringify(result));
      }
    } catch (error) {
      // 匯出失敗就不清（runRetention 先寫檔才刪），留到下一輪。
      app.log.error({ err: error }, 'retention failed');
    }
  };

  let closing: Promise<void> | null = null;

  return {
    app,
    hub,
    store,
    db,
    async listen() {
      const host = options.host ?? store.getSettings().listenAddress;
      assertBindableHost(host);
      await app.listen({ host, port: options.port ?? DEFAULT_PORT });
      retain();
      retentionTimer = setInterval(retain, RETENTION_INTERVAL_MS);
      retentionTimer.unref();
      const { port } = app.server.address() as AddressInfo;
      const urlHost = host.includes(':') ? `[${host}]` : host;
      return { host, port, url: `http://${urlHost}:${port}` };
    },
    close() {
      closing ??= (async () => {
        if (retentionTimer) clearInterval(retentionTimer);
        app.server.off('upgrade', onUpgrade);
        await hub.close();
        daemonWss.close();
        clientWss.close();
        await app.close();
        db.close();
      })();
      return closing;
    },
  };
}
