// 安全強化的行為測試（docs/security-checklist.md 引用這份）。只在 127.0.0.1 上測自己的 hub。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditToCsv, PromptWatcher, REDACTED_INPUT, redactSecrets } from '../audit';
import { assertBindableHost, loadEnvConfig, UnsafeBindError } from '../config';
import { isAllowedHost, isAllowedOrigin } from '../auth';
import { archiveDir, runRetention } from '../retention';
import { createHub } from '../server';
import { connect, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const startedSession = async () => {
  const cookie = await hub.setupOwner();
  const { daemon, machineId, token } = await hub.onlineDaemon(cookie);
  const res = await hub.api('POST', '/api/sessions', {
    cookie,
    body: { ...spec(), machineId },
  });
  const session = res.body as { id: string };
  const create = await daemon.next('session.create');
  daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(session.id),
  });
  return { cookie, daemon, machineId, token, session };
};

const auditDetails = (action: string) =>
  (
    hub.running.db
      .prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY rowid')
      .all(action) as { detail: string }[]
  ).map((row) => row.detail);

/** fetch 不准自訂 Host，所以用 http.request。 */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; body: string; headers: NodeJS.Dict<string | string[]> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('listen address', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.128.0.1',
    '172.32.0.1',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ])('refuses public address %s', (host) => {
    expect(() => assertBindableHost(host)).toThrow(UnsafeBindError);
  });

  it.each([
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.5',
    '100.100.100.100',
    'fd7a:115c:a1e0::1',
    '::ffff:192.168.1.1',
  ])('accepts private address %s', (host) => {
    expect(() => assertBindableHost(host)).not.toThrow();
  });

  it('refuses a public address from the environment', () => {
    expect(() => loadEnvConfig({ AGENT_BOARD_HOST: '8.8.8.8' })).toThrow(UnsafeBindError);
  });

  it('PATCH /api/settings refuses a public address; a tampered database fails at startup', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const res = await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { listenAddress: '8.8.8.8' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsafe_listen_address');

    const dir = mkdtempSync(join(tmpdir(), 'ab-sec-'));
    try {
      const first = createHub({ dbPath: join(dir, 'h.db'), webDir: null });
      first.store.updateSettings({ listenAddress: '8.8.8.8' });
      await first.close();
      const second = createHub({ dbPath: join(dir, 'h.db'), webDir: null, port: 0 });
      await expect(second.listen()).rejects.toThrow(UnsafeBindError);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the real entry point (main.ts)', () => {
  const TSX = join(import.meta.dirname, '../../../../node_modules/.bin/tsx');
  const MAIN = join(import.meta.dirname, '../main.ts');

  const startMain = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-main-'));
    const child = spawn(TSX, [MAIN], {
      env: { PATH: process.env.PATH, AGENT_BOARD_DATA_DIR: dir, AGENT_BOARD_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state = { output: '', code: null as number | null, exited: false };
    child.stdout.on('data', (d: Buffer) => (state.output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (state.output += d.toString()));
    child.on('exit', (code) => {
      state.code = code;
      state.exited = true;
    });
    return {
      child,
      state,
      cleanup: () => {
        child.kill('SIGTERM');
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  it.each(['0.0.0.0', '::', '8.8.8.8', 'example.com'])(
    'refuses to start on %s, exits non-zero and says why',
    async (host) => {
      const { state, cleanup } = startMain({ AGENT_BOARD_HOST: host });
      try {
        await until(() => state.exited, 'exit', 20_000);
        expect(state.code).not.toBe(0);
        expect(state.output).toContain('Refusing to bind');
      } finally {
        cleanup();
      }
    },
    30_000,
  );

  it('logs never contain tokens, cookies, passwords, or pairing codes', async () => {
    const { state, cleanup } = startMain({ AGENT_BOARD_HOST: '127.0.0.1' });
    try {
      await until(
        () => /listening on http:\/\/127\.0\.0\.1:(\d+)/.test(state.output),
        'listen',
        20_000,
      );
      const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(state.output)![1]!;
      const password = 'LOG_MARKER_password_value';
      const json = { 'content-type': 'application/json' };
      const setup = await fetch(`${url}/api/auth/setup`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'owner', password, locale: 'en' }),
      });
      const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]!;
      await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'owner', password: `${password}-wrong` }),
      });
      const code = (await (
        await fetch(`${url}/api/machines/pairing-codes`, { method: 'POST', headers: { cookie } })
      ).json()) as { code: string };
      const pair = (await (
        await fetch(`${url}/api/machines/pair`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            code: code.code,
            name: 'm',
            os: 'linux',
            capabilities: {
              hasGpu: false,
              gpuName: null,
              cpuCores: 1,
              memoryBytes: 1,
              claudeVersion: null,
            },
          }),
        })
      ).json()) as { token: string };
      expect(pair.token).toMatch(/^abm_/);
      const peer = await connect(`${url.replace('http', 'ws')}/ws/daemon`, {
        authorization: `Bearer ${pair.token}`,
      });
      peer.ws.close();
      await fetch(`${url}/api/machines`, { headers: { cookie } });
      // pino 是非同步寫出，等它把這些請求都印完。
      await until(() => state.output.includes('/api/machines"'), 'log flush', 5000).catch(
        () => undefined,
      );

      expect(state.output.length).toBeGreaterThan(100);
      expect(state.output).not.toContain(password);
      expect(state.output).not.toContain(pair.token);
      expect(state.output).not.toContain(code.code);
      expect(state.output).not.toContain(cookie.split('=')[1]!);
    } finally {
      cleanup();
    }
  }, 40_000);
});

describe('Host check (DNS rebinding)', () => {
  it('unit', () => {
    const none = () => null;
    const set = () => 'https://board.example.ts.net';
    expect(isAllowedHost('127.0.0.1:8787', none)).toBe(true);
    expect(isAllowedHost('localhost:8787', none)).toBe(true);
    expect(isAllowedHost('[::1]:8787', none)).toBe(true);
    expect(isAllowedHost('100.64.0.1', none)).toBe(true);
    expect(isAllowedHost('evil.example:8787', none)).toBe(false);
    expect(isAllowedHost('evil.example', set)).toBe(false);
    expect(isAllowedHost('board.example.ts.net', set)).toBe(true);
    expect(isAllowedHost('board.example.ts.net', none)).toBe(false);
    expect(isAllowedHost('a b', none)).toBe(false);
  });

  it('a rebinding page cannot claim the owner account of an unconfigured hub', async () => {
    hub = await startHub();
    const res = await rawRequest(
      hub.port,
      '/api/auth/setup',
      { host: 'evil.example:8787' },
      'POST',
    );
    expect(res.status).toBe(421);
    expect(JSON.parse(res.body).code).toBe('bad_host');
    expect((await hub.api('GET', '/api/auth/status')).body.needsSetup).toBe(true);
  });

  it('accepts the publicOrigin hostname once configured', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const host = { host: 'board.example.ts.net' };
    expect((await rawRequest(hub.port, '/api/auth/status', host)).status).toBe(421);
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'https://board.example.ts.net' },
    });
    expect((await rawRequest(hub.port, '/api/auth/status', host)).status).toBe(200);
  });

  it('refuses a rebinding WebSocket upgrade even with a valid cookie and same-host Origin', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await expect(
      connect(`ws://127.0.0.1:${hub.port}/ws/client`, {
        cookie,
        host: 'evil.example',
        origin: 'http://evil.example',
      }),
    ).rejects.toThrow('HTTP 421');
  });
});

describe('Origin and cookie', () => {
  it('publicOrigin over http does not set Secure', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'http://100.64.0.1:8787' },
    });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: 'correct horse battery' },
    });
    expect(login.headers.get('set-cookie')).not.toMatch(/Secure/i);
  });

  it('Origin rules with publicOrigin', () => {
    const pub = 'https://board.example.ts.net';
    expect(isAllowedOrigin(pub, 'board.example.ts.net', pub)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', 'board.example.ts.net', pub)).toBe(false);
    expect(isAllowedOrigin('http://board.example.ts.net', 'board.example.ts.net', pub)).toBe(false);
    // Host 被帶成 evil 不會讓 evil 變同源：有 publicOrigin 時只有 loopback 才看同 Host。
    expect(isAllowedOrigin('https://evil.example', 'evil.example', pub)).toBe(false);
    expect(isAllowedOrigin('null', '127.0.0.1:8787', null)).toBe(false);
    expect(isAllowedOrigin(undefined, '127.0.0.1:8787', null)).toBe(false);
  });

  it('REST mutation with a foreign Origin is refused while publicOrigin is set', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await hub.api('PATCH', '/api/settings', {
      cookie,
      body: { publicOrigin: 'https://board.example.ts.net' },
    });
    const bad = await hub.api('POST', '/api/projects', {
      cookie,
      headers: { origin: 'https://evil.example' },
      body: { name: 'x', color: '#000000' },
    });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('bad_origin');
  });

  it('CSP limits WebSocket targets to this host, blocks inline scripts and plugins', async () => {
    hub = await startHub();
    const csp = (await hub.api('GET', '/api/auth/status')).headers.get('content-security-policy')!;
    expect(csp).toContain(
      `connect-src 'self' ws://127.0.0.1:${hub.port} wss://127.0.0.1:${hub.port};`,
    );
    expect(csp).not.toMatch(/connect-src[^;]* ws: /);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('static files', () => {
  it('path traversal cannot escape webDir; dotfiles are not served', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-static-'));
    const webDir = join(root, 'dist');
    mkdirSync(webDir);
    writeFileSync(join(webDir, 'index.html'), '<!doctype html>APP');
    writeFileSync(join(webDir, '.secret'), 'DOTFILE_MARKER');
    writeFileSync(join(root, 'outside.txt'), 'OUTSIDE_MARKER');
    hub = await startHub({ webDir });
    try {
      for (const path of [
        '/../outside.txt',
        '/..%2foutside.txt',
        '/%2e%2e/outside.txt',
        '/%2e%2e%2foutside.txt',
        '/....//outside.txt',
        '/..%5coutside.txt',
        '/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '/.secret',
      ]) {
        const res = await rawRequest(hub.port, path, { host: `127.0.0.1:${hub.port}` });
        expect(res.body, path).not.toContain('OUTSIDE_MARKER');
        expect(res.body, path).not.toContain('DOTFILE_MARKER');
        expect(res.body, path).not.toContain('root:');
      }
      const index = await rawRequest(hub.port, '/', { host: `127.0.0.1:${hub.port}` });
      expect(index.body).toContain('APP');
      expect(index.headers['content-security-policy']).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('machine token paths', () => {
  it('token only appears in the pair response; never in audit, machine list or the database', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { token, machineId } = await hub.pair(cookie);
    expect(token).toMatch(/^abm_/);
    const list = await hub.api('GET', '/api/machines', { cookie });
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(list.body)).not.toContain('token');
    expect(JSON.stringify(list.body)).toContain(machineId);
    const audit = await hub.api('GET', '/api/audit', { cookie });
    expect(JSON.stringify(audit.body)).not.toContain(token);
    hub.running.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(hub.dbPath).includes(token)).toBe(false);
  });

  it('database file is owner-only', async () => {
    hub = await startHub();
    expect(statSync(hub.dbPath).mode & 0o777).toBe(0o600);
  });
});

describe('audit: secrets', () => {
  it('redactSecrets', () => {
    expect(redactSecrets('curl -H "x-api-key: sk-ant-api03-abcdefghijklmnop"')).not.toContain(
      'abcdefghijkl',
    );
    expect(redactSecrets('export GITHUB_TOKEN=abc123def')).toBe('export GITHUB_TOKEN=[redacted]');
    expect(redactSecrets('ls -la')).toBe('ls -la');
    expect(redactSecrets('git log -1 --format=%H')).toBe('git log -1 --format=%H');
  });

  it('a pasted key is redacted, the rest of the line is kept', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    const key = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEE';
    client.send({ type: 'terminal.input', sessionId: session.id, data: `use key ${key}\r` });
    await daemon.next('terminal.input');
    expect(auditDetails('terminal.input')).toEqual(['use key [redacted]']);
  });

  it('input is still forwarded unchanged: redaction only touches the record', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: 'Password: ',
    });
    await client.next('terminal.snapshot');
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'hunter2\r' });
    expect((await daemon.next('terminal.input')).data).toBe('hunter2\r');
  });
});

describe('audit: password prompts', () => {
  const at = (...chunks: string[]) => {
    const watcher = new PromptWatcher();
    for (const chunk of chunks) watcher.onOutput('s', chunk);
    return watcher.atPasswordPrompt('s');
  };

  it.each([
    ['sudo', '[sudo] password for someone: '],
    ['macOS sudo', 'Password:'],
    ['ssh', 'someone@host.example password: '],
    ['ssh key', "Enter passphrase for key '/path/id_ed25519': "],
    ['zh', '請輸入密碼：'],
    ['2fa', 'Verification code: '],
    ['colored', '\x1b[1mPassword:\x1b[0m '],
    ['cut across chunks', 'Passw', 'ord: '],
    ['TUI box', '│ Enter your API key: │\r\n│ > │'],
  ])('detects %s', (_name, ...chunks) => {
    expect(at(...chunks)).toBe(true);
  });

  it.each([
    ['normal output', 'total 12\r\ndrwxr-xr-x  2 a b 64 x\r\n$ '],
    ['the word without a prompt', 'I changed the password handling in auth.ts\r\n$ '],
    ['echoed text after the prompt', 'Password: \r\nwelcome back\r\nok\r\nfine\r\n$ '],
    ['no output at all'],
  ])('does not flag %s', (_name, ...chunks) => {
    expect(at(...chunks)).toBe(false);
  });

  it('tail is bounded and dropped on forget', () => {
    const watcher = new PromptWatcher();
    watcher.onOutput('s', 'Password: ');
    watcher.onOutput('s', 'x'.repeat(10_000));
    expect(watcher.atPasswordPrompt('s')).toBe(false);
    watcher.onSnapshot('s', 'Password: ');
    expect(watcher.atPasswordPrompt('s')).toBe(true);
    watcher.forget('s');
    expect(watcher.atPasswordPrompt('s')).toBe(false);
  });

  it('typing at a password prompt is not recorded in plain text, in any table or file', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: '$ ',
    });
    await client.next('terminal.snapshot');
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'sudo ls\r' });
    await daemon.next('terminal.input');
    daemon.send({
      type: 'terminal.output',
      sessionId: session.id,
      seq: 1,
      data: 'sudo ls\r\nPassword:',
    });
    await client.next('terminal.output');
    for (const ch of 'PLAINTEXT_MARKER') {
      client.send({ type: 'terminal.input', sessionId: session.id, data: ch });
      await daemon.next('terminal.input');
    }
    client.send({ type: 'terminal.input', sessionId: session.id, data: '\r' });
    await daemon.next('terminal.input');
    daemon.send({
      type: 'terminal.output',
      sessionId: session.id,
      seq: 2,
      data: '\r\nok\r\nreal\r\nwork\r\n$ ',
    });
    await client.next('terminal.output');
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'next command\r' });
    await daemon.next('terminal.input');

    expect(auditDetails('terminal.input')).toEqual(['sudo ls', REDACTED_INPUT, 'next command']);
    hub.running.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(hub.dbPath).includes('PLAINTEXT_MARKER')).toBe(false);
  });

  it('left without pressing Enter: the partial row is redacted too', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.subscribe', sessionId: session.id });
    await daemon.next('terminal.subscribe');
    daemon.send({
      type: 'terminal.snapshot',
      sessionId: session.id,
      seq: 0,
      cols: 80,
      rows: 24,
      data: 'Password: ',
    });
    await client.next('terminal.snapshot');
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'half' });
    await daemon.next('terminal.input');
    client.ws.close();
    await until(() => auditDetails('terminal.input.partial').length === 1, 'partial row');
    expect(auditDetails('terminal.input.partial')).toEqual([REDACTED_INPUT]);
  });

  it('known limit: without any output the prompt cannot be seen, and the line is recorded', async () => {
    hub = await startHub();
    const { cookie, daemon, session } = await startedSession();
    const client = await hub.client(cookie);
    client.send({ type: 'terminal.input', sessionId: session.id, data: 'hunter2\r' });
    await daemon.next('terminal.input');
    expect(auditDetails('terminal.input')).toEqual(['hunter2']);
  });
});

describe('removing a machine', () => {
  it('asks the online daemon to stop every live session before closing', async () => {
    hub = await startHub();
    const { cookie, daemon, machineId, session } = await startedSession();
    const res = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec({ name: 'second' }), machineId },
    });
    const second = res.body as { id: string };
    const create = await daemon.next('session.create');
    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(second.id),
    });
    await until(
      () => hub.running.store.getSession(second.id)?.status === 'running',
      'second running',
    );
    await hub.api('DELETE', `/api/machines/${machineId}`, { cookie });
    expect(await daemon.closed()).toBe(4401);
    const stopped = daemon.of('session.stop').map((m) => m.sessionId);
    expect(stopped.sort()).toEqual([session.id, second.id].sort());
  });

  it('does not ask to stop sessions that already ended', async () => {
    hub = await startHub();
    const { cookie, daemon, machineId, session } = await startedSession();
    daemon.send({
      type: 'session.runtime',
      session: runtime(session.id, { status: 'done', endedAt: new Date().toISOString() }),
    });
    await until(() => hub.running.store.getSession(session.id)?.endedAt !== null, 'ended');
    await hub.api('DELETE', `/api/machines/${machineId}`, { cookie });
    await daemon.closed();
    expect(daemon.of('session.stop')).toEqual([]);
  });
});

describe('retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2027-06-01T00:00:00.000Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

  const seedAudit = (store: TestHub['running']['store'], days: number, detail: string) =>
    store.insertAudit({
      id: `a-${detail}`,
      userId: null,
      sessionId: null,
      action: 'terminal.input',
      detail,
      at: ago(days),
    });

  const seedEvent = async (id: string, days: number) => {
    const { session } = await startedSessionOnce();
    hub.running.store.insertEvent({
      id,
      sessionId: session.id,
      type: 'status',
      payload: {},
      at: ago(days),
    });
  };
  let cached: { session: { id: string } } | null = null;
  const startedSessionOnce = async () => (cached ??= await startedSession());
  const eventCount = () =>
    (hub.running.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n;
  const auditCount = () =>
    (hub.running.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;

  afterEach(() => {
    cached = null;
  });

  it('expired audit rows are exported to an owner-only CSV before being deleted', async () => {
    hub = await startHub({ retention: null });
    const { store } = hub.running;
    seedAudit(store, 200, 'OLD_ONE');
    seedAudit(store, 190, 'OLD_TWO');
    seedAudit(store, 10, 'RECENT');

    const result = runRetention(store, { eventDays: 0, auditDays: 180 }, hub.dbPath, now);

    expect(result.auditDeleted).toBe(2);
    expect(store.listAudit({}).map((e) => e.detail)).toEqual(['RECENT']);
    const csv = readFileSync(result.archive!, 'utf8');
    expect(csv).toContain('OLD_ONE');
    expect(csv).toContain('OLD_TWO');
    expect(csv).not.toContain('RECENT');
    expect(statSync(result.archive!).mode & 0o777).toBe(0o600);
    expect(statSync(archiveDir(hub.dbPath)).mode & 0o777).toBe(0o700);
    expect(readdirSync(archiveDir(hub.dbPath))).toHaveLength(1);
  });

  it('if the export fails nothing is deleted', async () => {
    hub = await startHub({ retention: null });
    const { store } = hub.running;
    seedAudit(store, 200, 'KEEP_ME');
    // 用同名檔案占住封存資料夾的位置，mkdir 會失敗。
    writeFileSync(archiveDir(hub.dbPath), 'blocker');
    expect(() => runRetention(store, { eventDays: 0, auditDays: 180 }, hub.dbPath, now)).toThrow();
    expect(store.listAudit({}).map((e) => e.detail)).toEqual(['KEEP_ME']);
  });

  it('nothing to do leaves no archive; a second run does not duplicate', async () => {
    hub = await startHub({ retention: null });
    const { store } = hub.running;
    seedAudit(store, 1, 'RECENT');
    const empty = runRetention(store, { eventDays: 0, auditDays: 180 }, hub.dbPath, now);
    expect(empty).toEqual({ eventsDeleted: 0, auditDeleted: 0, archive: null });
    expect(existsSync(archiveDir(hub.dbPath))).toBe(false);

    seedAudit(store, 200, 'OLD');
    runRetention(store, { eventDays: 0, auditDays: 180 }, hub.dbPath, now);
    runRetention(store, { eventDays: 0, auditDays: 180 }, hub.dbPath, now);
    expect(readdirSync(archiveDir(hub.dbPath))).toHaveLength(1);
  });

  it('0 days means keep forever', async () => {
    hub = await startHub({ retention: null });
    const { store } = hub.running;
    seedAudit(store, 5000, 'ANCIENT');
    await seedEvent('e-ancient', 5000);
    const before = eventCount();
    runRetention(store, { eventDays: 0, auditDays: 0 }, hub.dbPath, now);
    expect(auditCount()).toBeGreaterThanOrEqual(1);
    expect(store.listAudit({}).some((e) => e.detail === 'ANCIENT')).toBe(true);
    expect(eventCount()).toBe(before);
  });

  it('session events expire by age', async () => {
    hub = await startHub({ retention: null });
    await seedEvent('e-old', 40);
    await seedEvent('e-new', 1);
    const result = runRetention(
      hub.running.store,
      { eventDays: 30, auditDays: 0 },
      hub.dbPath,
      now,
    );
    expect(result.eventsDeleted).toBeGreaterThanOrEqual(1);
    const left = hub.running.db.prepare('SELECT id FROM session_events').all() as { id: string }[];
    expect(left.map((row) => row.id)).toContain('e-new');
    expect(left.map((row) => row.id)).not.toContain('e-old');
  });

  it('session events are capped by row count, oldest first', async () => {
    hub = await startHub({ retention: null });
    await seedEvent('e-1', 3);
    await seedEvent('e-2', 2);
    await seedEvent('e-3', 1);
    hub.running.db.prepare("DELETE FROM session_events WHERE id NOT LIKE 'e-%'").run();
    hub.running.store.pruneEvents(ago(100), 2);
    const left = hub.running.db.prepare('SELECT id FROM session_events ORDER BY at').all() as {
      id: string;
    }[];
    expect(left.map((row) => row.id)).toEqual(['e-2', 'e-3']);
  });

  it('runs at startup with the default policy and records itself in the audit log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-ret-'));
    const dbPath = join(dir, 'hub.db');
    const seed = createHub({ dbPath, webDir: null, retention: null });
    seed.store.insertAudit({
      id: 'very-old',
      userId: null,
      sessionId: null,
      action: 'terminal.input',
      detail: 'VERY_OLD',
      at: '2001-01-01T00:00:00.000Z',
    });
    await seed.close();
    const running = createHub({ dbPath, webDir: null, host: '127.0.0.1', port: 0 });
    try {
      await running.listen();
      const details = running.store.listAudit({}).map((e) => e.detail);
      expect(details).not.toContain('VERY_OLD');
      const record = running.store.listAudit({ action: 'audit.retention' });
      expect(record).toHaveLength(1);
      expect(JSON.parse(record[0]!.detail)).toMatchObject({ auditDeleted: 1 });
      const [file] = readdirSync(archiveDir(dbPath));
      expect(readFileSync(join(archiveDir(dbPath), file!), 'utf8')).toContain('VERY_OLD');
    } finally {
      await running.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retention days come from the environment; invalid values are refused', () => {
    expect(loadEnvConfig({ AGENT_BOARD_AUDIT_RETENTION_DAYS: '7' }).retention.auditDays).toBe(7);
    expect(loadEnvConfig({}).retention).toEqual({ eventDays: 30, auditDays: 180 });
    expect(() => loadEnvConfig({ AGENT_BOARD_EVENT_RETENTION_DAYS: '-1' })).toThrow();
  });

  it('archived CSV keeps the injection guard of the normal export', () => {
    const csv = auditToCsv([
      { id: '1', at: 'x', userId: null, sessionId: null, action: 'a', detail: '=HYPERLINK("x")' },
    ]);
    expect(csv).toContain(`"'=HYPERLINK`);
  });
});

describe('authorization of audit and export', () => {
  it('members cannot read audit, and unauthenticated requests get 401', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    expect((await hub.api('GET', '/api/audit', { cookie: member.cookie })).status).toBe(403);
    expect((await hub.api('GET', '/api/audit/export', { cookie: member.cookie })).status).toBe(403);
    expect((await hub.api('GET', '/api/audit')).status).toBe(401);
  });
});
