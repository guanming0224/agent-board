import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { routes, type RouteName } from '@agent-board/protocol';
import { assertBindableHost, loadEnvConfig, UnsafeBindError } from '../config';
import { openDatabase, SCHEMA_VERSION } from '../db';
import { createHub } from '../server';
import { capabilities, FAST_PASSWORD, PASSWORD, spec, startHub, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const fill = (path: string) => path.replace(/:[a-zA-Z]+/g, 'x');
const entries = Object.entries(routes) as [RouteName, (typeof routes)[RouteName]][];

describe('access control', () => {
  it('rejects every non-public route without login (401)', async () => {
    hub = await startHub();
    await hub.setupOwner();
    const guarded = entries.filter(([, def]) => def.auth !== 'public');
    expect(guarded.length).toBeGreaterThan(50);
    for (const [name, def] of guarded) {
      const res = await hub.api(def.method, fill(def.path));
      expect(res.status, `${name} ${def.method} ${def.path}`).toBe(401);
      expect(res.body).toMatchObject({ code: 'unauthenticated' });
    }
  });

  it('rejects a forged or logged-out cookie on every non-public route', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    await hub.api('POST', '/api/auth/logout', { cookie: owner });
    for (const [name, def] of entries.filter(([, d]) => d.auth !== 'public')) {
      for (const cookie of [owner, 'ab_session=forged']) {
        const res = await hub.api(def.method, fill(def.path), { cookie });
        expect(res.status, `${name}`).toBe(401);
      }
    }
  });

  it('rejects members on every owner route (403)', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const { cookie } = await hub.createMember(owner);
    const ownerRoutes = entries.filter(([, def]) => def.auth === 'owner');
    expect(ownerRoutes.length).toBeGreaterThan(5);
    for (const [name, def] of ownerRoutes) {
      const res = await hub.api(def.method, fill(def.path), { cookie });
      expect(res.status, `${name}`).toBe(403);
      expect(res.body).toMatchObject({ code: 'forbidden' });
    }
  });

  it('lets a member edit themselves but nobody else', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const a = await hub.createMember(owner, 'a');
    const b = await hub.createMember(owner, 'b');
    const self = await hub.api('PATCH', `/api/users/${a.id}`, {
      cookie: a.cookie,
      body: { locale: 'zh-TW' },
    });
    expect(self.status).toBe(200);
    expect(self.body.locale).toBe('zh-TW');
    const other = await hub.api('PATCH', `/api/users/${b.id}`, {
      cookie: a.cookie,
      body: { password: 'attacker-chosen', currentPassword: PASSWORD },
    });
    expect(other.status).toBe(403);
    const stillWorks = await hub.api('POST', '/api/auth/login', {
      body: { name: 'b', password: PASSWORD },
    });
    expect(stillWorks.status).toBe(200);
  });

  it('rejects state-changing requests from a foreign Origin', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const res = await hub.api('POST', '/api/projects', {
      cookie,
      headers: { origin: 'https://evil.example' },
      body: { name: 'x', color: '#000' },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('bad_origin');
    expect((await hub.api('GET', '/api/projects', { cookie })).body).toEqual([]);
  });
});

describe('login', () => {
  it('allows setup exactly once even when requests race', async () => {
    hub = await startHub();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        hub.api('POST', '/api/auth/setup', {
          body: { name: `owner${i}`, password: PASSWORD, locale: 'en' },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(hub.running.store.countUsers()).toBe(1);
    const later = await hub.api('POST', '/api/auth/setup', {
      body: { name: 'late', password: PASSWORD, locale: 'en' },
    });
    expect(later.status).toBe(409);
  });

  it('sets httpOnly + SameSite=Strict, and Secure only when publicOrigin is https', async () => {
    hub = await startHub();
    const setup = await hub.api('POST', '/api/auth/setup', {
      body: { name: 'owner', password: PASSWORD, locale: 'en' },
    });
    const plain = setup.headers.get('set-cookie')!;
    expect(plain).toMatch(/HttpOnly/i);
    expect(plain).toMatch(/SameSite=Strict/i);
    expect(plain).not.toMatch(/Secure/i);
    const cookie = plain.split(';')[0]!;
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'https://board.example.ts.net' },
    });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    expect(login.headers.get('set-cookie')).toMatch(/Secure/i);
  });

  it('never returns or stores the plain password', async () => {
    hub = await startHub();
    const setup = await hub.api('POST', '/api/auth/setup', {
      body: { name: 'owner', password: PASSWORD, locale: 'en' },
    });
    expect(Object.keys(setup.body).sort()).toEqual(['id', 'locale', 'name', 'role']);
    const row = hub.running.db.prepare('SELECT password_hash FROM users').get() as {
      password_hash: string;
    };
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('rate limits failed logins, even with the right password afterwards', async () => {
    hub = await startHub({ loginLimit: { perAccount: 3, perIp: 100 } });
    await hub.setupOwner();
    const attempt = (password: string) =>
      hub.api('POST', '/api/auth/login', { body: { name: 'OWNER', password } });
    for (let i = 0; i < 3; i += 1) expect((await attempt('wrong-password')).status).toBe(401);
    const limited = await attempt(PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('counts concurrent guesses, not only finished ones', async () => {
    hub = await startHub({ loginLimit: { perAccount: 3, perIp: 100 } });
    await hub.setupOwner();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        hub.api('POST', '/api/auth/login', { body: { name: 'owner', password: 'wrong-pass' } }),
      ),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it('rate limits per IP across account names', async () => {
    hub = await startHub({ loginLimit: { perAccount: 100, perIp: 4 } });
    await hub.setupOwner();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await hub.api('POST', '/api/auth/login', {
        body: { name: `user${i}`, password: 'wrong-pass' },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
  });

  it('logs out other devices when the password changes', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    const second = await hub.api('POST', '/api/auth/login', {
      body: { name: 'member', password: PASSWORD },
    });
    const otherCookie = second.headers.get('set-cookie')!.split(';')[0]!;
    const changed = await hub.api('PATCH', `/api/users/${member.id}`, {
      cookie: member.cookie,
      body: { password: 'a-brand-new-password', currentPassword: PASSWORD },
    });
    expect(changed.status).toBe(200);
    expect((await hub.api('GET', '/api/projects', { cookie: member.cookie })).status).toBe(200);
    expect((await hub.api('GET', '/api/projects', { cookie: otherCookie })).status).toBe(401);
  });

  describe('changing a password', () => {
    const newPassword = 'a-brand-new-password';
    const change = (id: string, cookie: string, body: object) =>
      hub.api('PATCH', `/api/users/${id}`, { cookie, body });
    const login = (name: string, password: string) =>
      hub.api('POST', '/api/auth/login', { body: { name, password } });

    it('requires the current password', async () => {
      hub = await startHub();
      const owner = await hub.setupOwner();
      const member = await hub.createMember(owner);
      const missing = await change(member.id, member.cookie, { password: newPassword });
      expect(missing.status).toBe(400);
      const wrong = await change(member.id, member.cookie, {
        password: newPassword,
        currentPassword: 'not-the-password',
        locale: 'zh-TW',
      });
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe('invalid_current_password');
      // 舊密碼錯就什麼都不改，同一筆請求帶的語系也一樣。
      expect((await login('member', newPassword)).status).toBe(401);
      expect((await login('member', PASSWORD)).body.locale).toBe('en');
      const audit = hub.running.store.listAudit({ action: 'user.password_change_failed' });
      expect(audit).toHaveLength(1);

      const ok = await change(member.id, member.cookie, {
        password: newPassword,
        currentPassword: PASSWORD,
      });
      expect(ok.status).toBe(200);
      expect((await login('member', PASSWORD)).status).toBe(401);
      expect((await login('member', newPassword)).status).toBe(200);
    });

    it('counts wrong current passwords toward a rate limit, without blocking login', async () => {
      hub = await startHub({ loginLimit: { perAccount: 3, perIp: 100 } });
      const owner = await hub.setupOwner();
      const member = await hub.createMember(owner);
      const attempt = (currentPassword: string) =>
        change(member.id, member.cookie, { password: newPassword, currentPassword });
      for (let i = 0; i < 3; i += 1) expect((await attempt('wrong-guess')).status).toBe(403);
      // 猜中了也要等。
      const limited = await attempt(PASSWORD);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect((await login('member', PASSWORD)).status).toBe(200);
    });

    it('an owner cannot reset the password of someone else, but can still edit their locale', async () => {
      hub = await startHub();
      const owner = await hub.setupOwner();
      const member = await hub.createMember(owner);
      const reset = await change(member.id, owner, {
        password: newPassword,
        currentPassword: PASSWORD,
      });
      expect(reset.status).toBe(403);
      expect((await login('member', PASSWORD)).status).toBe(200);
      const locale = await change(member.id, owner, { locale: 'zh-TW' });
      expect(locale.body.locale).toBe('zh-TW');
    });
  });

  it('cannot delete the last owner', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const me = (await hub.api('GET', '/api/auth/status', { cookie })).body.user;
    const res = await hub.api('DELETE', `/api/users/${me.id}`, { cookie });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('last_owner');
  });
});

describe('validation and errors', () => {
  it('returns 400 ApiError for invalid body, query and JSON', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const badBody = await hub.api('POST', '/api/projects', { cookie, body: { name: '' } });
    expect(badBody.status).toBe(400);
    expect(badBody.body.code).toBe('invalid_request');
    expect(typeof badBody.body.message).toBe('string');
    const badQuery = await hub.api('GET', '/api/audit?limit=99999', { cookie });
    expect(badQuery.status).toBe(400);
    const badJson = await fetch(`${hub.url}/api/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { code: string }).code).toBe('invalid_json');
  });

  it('accepts JSON content-type with an empty body on no-body routes', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const res = await hub.api('POST', '/api/auth/logout', {
      cookie,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('returns ApiError 404 for unknown API paths and records', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    expect((await hub.api('GET', '/api/nope', { cookie })).body.code).toBe('not_found');
    expect((await hub.api('PATCH', '/api/projects/nope', { cookie, body: {} })).status).toBe(404);
    expect((await hub.api('POST', '/api/sessions/nope/stop', { cookie })).status).toBe(404);
  });

  it('maps a reference to a missing record to 400, not 500', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const res = await hub.api('PUT', '/api/layouts', {
      cookie,
      body: [{ workspace: 'w', sessionId: 'missing', x: 0, y: 0, w: 1, h: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_reference');
  });

  it('sends security headers', async () => {
    hub = await startHub();
    const res = await hub.api('GET', '/api/auth/status');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('listening address', () => {
  it.each(['0.0.0.0', '::', '[::]', '::0', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', '000.000.000.000'])(
    'refuses to bind %s before touching any data',
    (host) => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-board-bind-'));
      try {
        const marker = join(dir, 'never-created.db');
        expect(() => createHub({ dbPath: marker, host, port: 0 })).toThrow(UnsafeBindError);
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['0.0.0.0', '::'])(
    'the hub process exits non-zero when told to bind %s',
    (host) => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-board-bind-'));
      try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
          cwd: join(import.meta.dirname, '../..'),
          env: {
            ...process.env,
            AGENT_BOARD_HOST: host,
            AGENT_BOARD_DATA_DIR: dir,
            AGENT_BOARD_PORT: '0',
          },
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Refusing to bind');
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    40_000,
  );

  it.each(['0', '0.0.0', '', 'example.com', '*'])('refuses non-IP host %j', (host) => {
    expect(() => assertBindableHost(host)).toThrow(UnsafeBindError);
  });

  it.each(['127.0.0.1', 'localhost', '::1', '100.64.0.5', 'fe80::1%en0'])('accepts %s', (host) => {
    expect(() => assertBindableHost(host)).not.toThrow();
  });

  it('refuses 0.0.0.0 from the environment and defaults sensibly', () => {
    expect(() => loadEnvConfig({ AGENT_BOARD_HOST: '0.0.0.0' })).toThrow(UnsafeBindError);
    expect(() => loadEnvConfig({ AGENT_BOARD_HOST: '::' })).toThrow(UnsafeBindError);
    const config = loadEnvConfig({ AGENT_BOARD_DATA_DIR: '/fake/data', AGENT_BOARD_PORT: '9000' });
    expect(config).toEqual({
      host: undefined,
      port: 9000,
      dataDir: '/fake/data',
      dbPath: join('/fake/data', 'hub.db'),
      retention: { eventDays: 30, auditDays: 180 },
    });
    expect(loadEnvConfig({ AGENT_BOARD_DATA_DIR: '/fake/data' }).port).toBe(8787);
    expect(() => loadEnvConfig({ AGENT_BOARD_PORT: 'abc' })).toThrow();
  });

  it('refuses to save an unsafe listen address, or to start from one', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const res = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { listenAddress: '0.0.0.0' },
    });
    expect(res.status).toBe(400);
    expect((await hub.api('GET', '/api/settings', { cookie })).body.listenAddress).toBe(
      '127.0.0.1',
    );

    // 就算資料庫被手動改過，啟動時也不能照做。
    const tampered = createHub({ dbPath: ':memory:', webDir: null, port: 0 });
    tampered.store.updateSettings({ listenAddress: '::' });
    await expect(tampered.listen()).rejects.toThrow(UnsafeBindError);
    await tampered.close();
  });

  it('starts on the stored listen address by default', async () => {
    hub = await startHub({ host: undefined });
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('database', () => {
  it('migrates to the latest version and starts with no sample data', async () => {
    hub = await startHub();
    const db = hub.running.db;
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const expected = [
      'users',
      'machines',
      'projects',
      'sessions',
      'session_events',
      'layouts',
      'notes',
      'teams',
      'team_members',
      'tasks',
      'handoff_rules',
      'templates',
      'audit_log',
      'push_subscriptions',
      'settings',
      'auth_sessions',
      'pairing_codes',
    ];
    expect(tables.map((t) => t.name).sort()).toEqual([...expected].sort());
    for (const { name } of tables) {
      const { n } = db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number };
      // settings 只有首次啟動產生的 VAPID 金鑰。
      expect(n, name).toBe(name === 'settings' ? 1 : 0);
    }
  });

  it('v3 adds sessions.archived_at to an existing v2 database', async () => {
    hub = await startHub();
    const path = join(hub.dir, 'v2.db');
    const first = openDatabase(path);
    // 退回 v2 的樣子：沒有 archived_at。
    first.exec('ALTER TABLE sessions DROP COLUMN archived_at');
    first.exec('ALTER TABLE sessions DROP COLUMN read_only');
    first.pragma('user_version = 2');
    first.close();
    const db = openDatabase(path);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('archived_at');
    db.close();
  });

  it('v4 adds sessions.read_only (default 0) to an existing v3 database', async () => {
    hub = await startHub();
    const path = join(hub.dir, 'v3.db');
    const first = openDatabase(path);
    first.exec('ALTER TABLE sessions DROP COLUMN read_only');
    first.pragma('user_version = 3');
    first.close();
    const db = openDatabase(path);
    expect(SCHEMA_VERSION).toBe(4);
    expect(db.pragma('user_version', { simple: true })).toBe(4);
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as {
      name: string;
      dflt_value: string | null;
    }[];
    expect(columns.find((c) => c.name === 'read_only')?.dflt_value).toBe('0');
    db.close();
  });

  it('refuses a database from a newer version', async () => {
    hub = await startHub();
    const path = join(hub.dir, 'other.db');
    const first = openDatabase(path);
    first.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    first.close();
    expect(() => openDatabase(path)).toThrow(/newer/);
  });

  it('keeps data and VAPID keys across restarts, and never exposes the private key', async () => {
    hub = await startHub();
    const dbPath = join(hub.dir, 'restart.db');
    const first = createHub({
      dbPath,
      webDir: null,
      host: '127.0.0.1',
      port: 0,
      passwordParams: FAST_PASSWORD,
    });
    const keys = first.store.ensureVapidKeys(() => {
      throw new Error('should already exist');
    });
    first.store.updateSettings({ stuckMinutes: 42 });
    await first.close();

    const second = createHub({
      dbPath,
      webDir: null,
      host: '127.0.0.1',
      port: 0,
      passwordParams: FAST_PASSWORD,
    });
    expect(
      second.store.ensureVapidKeys(() => {
        throw new Error('should already exist');
      }),
    ).toEqual(keys);
    expect(second.store.getSettings().stuckMinutes).toBe(42);
    expect(JSON.stringify(second.store.getSettings())).not.toContain(keys.privateKey);
    await second.close();

    const cookie = await hub.setupOwner();
    const exposed = await hub.api('GET', '/api/settings', { cookie });
    expect(JSON.stringify(exposed.body)).not.toContain('privateKey');
    expect(
      (await hub.api('GET', '/api/push/vapid-key', { cookie })).body.publicKey.length,
    ).toBeGreaterThan(40);
  });
});

describe('static web', () => {
  it('serves web build files and falls back to index.html, but not for /api', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'agent-board-web-'));
    writeFileSync(join(webDir, 'index.html'), '<title>board</title>');
    writeFileSync(join(webDir, 'app.js'), 'ok();');
    hub = await startHub({ webDir });
    expect((await hub.api('GET', '/app.js')).body).toBe('ok();');
    expect((await hub.api('GET', '/some/client/route')).body).toContain('<title>board');
    expect((await hub.api('GET', '/missing.js')).status).toBe(404);
    expect((await hub.api('GET', '/api/missing')).body).toMatchObject({ code: 'not_found' });
    expect(readFileSync(join(webDir, 'app.js'), 'utf8')).toBe('ok();');
  });

  it('serves the service worker as JavaScript that is always revalidated', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'agent-board-web-'));
    writeFileSync(join(webDir, 'index.html'), '<title>board</title>');
    writeFileSync(join(webDir, 'sw.js'), 'self.addEventListener("push", () => {});');
    writeFileSync(join(webDir, 'app.js'), 'ok();');
    hub = await startHub({ webDir });
    const sw = await hub.api('GET', '/sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toMatch(/^(text|application)\/javascript/);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expect(sw.headers.get('content-security-policy')).toContain("worker-src 'self'");
    // 其他靜態檔不受影響。
    expect((await hub.api('GET', '/app.js')).headers.get('cache-control')).not.toBe('no-cache');
  });

  it('runs fine without a web build', async () => {
    hub = await startHub({ webDir: join('/nonexistent', 'dist') });
    expect((await hub.api('GET', '/')).status).toBe(404);
  });
});

describe('CRUD', () => {
  it('projects, notes, templates', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const project = await hub.api('POST', '/api/projects', {
      cookie,
      body: { name: 'p', color: '#111' },
    });
    expect(project.status).toBe(200);
    const patched = await hub.api('PATCH', `/api/projects/${project.body.id}`, {
      cookie,
      body: { color: '#222' },
    });
    expect(patched.body).toEqual({ id: project.body.id, name: 'p', color: '#222' });
    expect((await hub.api('DELETE', `/api/projects/${project.body.id}`, { cookie })).body).toEqual({
      ok: true,
    });
    expect((await hub.api('GET', '/api/projects', { cookie })).body).toEqual([]);

    const note = await hub.api('POST', '/api/notes', {
      cookie,
      body: { workspace: 'w', x: 1, y: 2, text: 'hi', color: 'y' },
    });
    expect((await hub.api('GET', '/api/notes?workspace=w', { cookie })).body).toEqual([note.body]);
    expect((await hub.api('GET', '/api/notes?workspace=other', { cookie })).body).toEqual([]);
    expect((await hub.api('GET', '/api/notes', { cookie })).status).toBe(400);

    const config = {
      machineId: null,
      cwd: null,
      permissionMode: 'plan',
      model: null,
      firstPrompt: null,
      quotaGuards: {
        denyReadPaths: ['**/.env'],
        maxConcurrentSessions: 2,
        queueWhenRateLimited: false,
      },
    };
    const template = await hub.api('POST', '/api/templates', {
      cookie,
      body: { name: 't', config },
    });
    expect(template.body.config).toEqual(config);
    const renamed = await hub.api('PATCH', `/api/templates/${template.body.id}`, {
      cookie,
      body: { name: 't2' },
    });
    expect(renamed.body.name).toBe('t2');
    expect(renamed.body.config).toEqual(config);
  });

  it('teams, members, tasks and handoff rules, with cascades', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { machineId } = await hub.onlineDaemon(cookie);
    const session = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec(), machineId },
    });
    const team = await hub.api('POST', '/api/teams', {
      cookie,
      body: { name: 't', goal: 'g', doneCriteria: 'd', color: 'c', contextMd: 'm' },
    });
    const teamId = team.body.id as string;
    expect(team.body.doneCriteria).toBe('d');

    const member = await hub.api('PUT', `/api/teams/${teamId}/members/${session.body.id}`, {
      cookie,
      body: { role: 'lead' },
    });
    expect(member.body).toEqual({ teamId, sessionId: session.body.id, role: 'lead' });
    await hub.api('PUT', `/api/teams/${teamId}/members/${session.body.id}`, {
      cookie,
      body: { role: 'worker' },
    });
    const members = await hub.api('GET', `/api/teams/${teamId}/members`, { cookie });
    expect(members.body).toEqual([{ teamId, sessionId: session.body.id, role: 'worker' }]);

    const task = await hub.api('POST', `/api/teams/${teamId}/tasks`, {
      cookie,
      body: { title: 'x', ownerSessionId: null },
    });
    expect(task.body.column).toBe('todo');
    const unassigned = await hub.api('PATCH', `/api/tasks/${task.body.id}`, {
      cookie,
      body: { column: 'doing' },
    });
    expect(unassigned.status).toBe(409);
    expect(unassigned.body.code).toBe('task_unassigned');
    const moved = await hub.api('PATCH', `/api/tasks/${task.body.id}`, {
      cookie,
      body: { column: 'doing', ownerSessionId: session.body.id },
    });
    expect(moved.body).toMatchObject({ column: 'doing', title: 'x' });

    const rule = await hub.api('POST', `/api/teams/${teamId}/handoff-rules`, {
      cookie,
      body: {
        fromSessionId: session.body.id,
        trigger: 'on_done',
        action: { toSessionId: session.body.id },
        enabled: true,
      },
    });
    expect(rule.status).toBe(200);
    const off = await hub.api('PATCH', `/api/handoff-rules/${rule.body.id}`, {
      cookie,
      body: { enabled: false },
    });
    expect(off.body.enabled).toBe(false);
    expect(off.body.action).toEqual({ toSessionId: session.body.id });

    expect((await hub.api('GET', '/api/teams/nope/tasks', { cookie })).status).toBe(404);
    await hub.api('DELETE', `/api/teams/${teamId}`, { cookie });
    const { n } = hub.running.db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number };
    expect(n).toBe(0);
  });

  it('layouts are per user and PUT replaces the workspace', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const member = await hub.createMember(cookie);
    const { machineId } = await hub.onlineDaemon(cookie);
    const mk = async () =>
      (await hub.api('POST', '/api/sessions', { cookie, body: { ...spec(), machineId } })).body.id;
    const [a, b] = [await mk(), await mk()];
    const layout = (sessionId: string, x: number) => ({
      workspace: 'w',
      sessionId,
      x,
      y: 0,
      w: 2,
      h: 2,
    });
    await hub.api('PUT', '/api/layouts', { cookie, body: [layout(a, 1), layout(b, 2)] });
    await hub.api('PUT', '/api/layouts', { cookie: member.cookie, body: [layout(a, 9)] });
    await hub.api('PUT', '/api/layouts', { cookie, body: [layout(b, 3)] });
    expect((await hub.api('GET', '/api/layouts?workspace=w', { cookie })).body).toEqual([
      layout(b, 3),
    ]);
    expect(
      (await hub.api('GET', '/api/layouts?workspace=w', { cookie: member.cookie })).body,
    ).toEqual([layout(a, 9)]);
  });

  it('settings: returns defaults, applies partial updates, validates', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const initial = (await hub.api('GET', '/api/settings', { cookie })).body;
    expect(initial.publicOrigin).toBeNull();
    expect(initial.dangerRules).toContain('git push --force');
    expect(initial.notifications).toEqual({ enabled: true, quietHours: null });
    const updated = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { stuckMinutes: 5, publicOrigin: 'https://x.example/path' },
    });
    expect(updated.body.stuckMinutes).toBe(5);
    expect(updated.body.publicOrigin).toBe('https://x.example');
    expect(updated.body.dangerRules).toEqual(initial.dangerRules);
    const quiet = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { notifications: { enabled: true, quietHours: { start: '25:00', end: '07:00' } } },
    });
    expect(quiet.status).toBe(400);
    const scheme = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'javascript:alert(1)' },
    });
    expect(scheme.status).toBe(400);
  });

  it('push subscriptions refuse internal endpoints', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const keys = { p256dh: 'k', auth: 'a' };
    for (const endpoint of [
      'http://push.example/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://nas.local/x',
      'https://other.tailnet.ts.net/x',
    ]) {
      const res = await hub.api('POST', '/api/push/subscriptions', {
        cookie,
        body: { endpoint, keys },
      });
      expect(res.status, endpoint).toBe(400);
    }
    const good = 'https://push.example/abc';
    expect(
      (await hub.api('POST', '/api/push/subscriptions', { cookie, body: { endpoint: good, keys } }))
        .status,
    ).toBe(200);
    expect(hub.running.store.listPushSubscriptions()).toHaveLength(1);
    await hub.api('DELETE', '/api/push/subscriptions', { cookie, body: { endpoint: good } });
    expect(hub.running.store.listPushSubscriptions()).toHaveLength(0);
  });

  it('capabilities from pairing are stored as given', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await hub.pair(cookie, 'box');
    const machines = (await hub.api('GET', '/api/machines', { cookie })).body;
    expect(machines).toMatchObject([{ name: 'box', online: false, capabilities }]);
  });
});
