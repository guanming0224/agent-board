// 帳號救援與操作紀錄篩選：管理員重設別人的密碼、reset-password 指令、audit 依使用者查詢與篩選後匯出。
// 指令一律指向臨時資料夾的 hub.db，絕不碰 ~/.agent-board。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_SYSTEM_USER, type AuditEntry } from '@agent-board/protocol';
import { CLOSE_REVOKED } from '../hub';
import { runResetPassword, type PasswordSource } from '../resetPassword';
import { FAST_PASSWORD, PASSWORD, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const NEW_PASSWORD = 'a-brand-new-password';
const login = (name: string, password: string) =>
  hub.api('POST', '/api/auth/login', { body: { name, password } });

describe('owner resets another user’s password', () => {
  it('needs no current password, signs the user out everywhere and is audited', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    const ws = await hub.client(member.cookie);

    const res = await hub.api('POST', `/api/users/${member.id}/reset-password`, {
      cookie: owner,
      body: { password: NEW_PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect((await hub.api('GET', '/api/projects', { cookie: member.cookie })).status).toBe(401);
    expect(await ws.closed()).toBe(CLOSE_REVOKED);
    expect((await login('member', PASSWORD)).status).toBe(401);
    expect((await login('member', NEW_PASSWORD)).status).toBe(200);
    // 管理員自己不受影響。
    expect((await hub.api('GET', '/api/projects', { cookie: owner })).status).toBe(200);

    const [entry] = hub.running.store.listAudit({ action: 'user.password_reset' });
    const ownerId = (await hub.api('GET', '/api/auth/status', { cookie: owner })).body.user.id;
    expect(entry).toMatchObject({ userId: ownerId });
    expect(JSON.parse(entry!.detail)).toEqual({ id: member.id, name: 'member' });
    expect(entry!.detail).not.toContain(NEW_PASSWORD);
  });

  it('members cannot reset anyone, not even themselves', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const a = await hub.createMember(owner, 'a');
    const b = await hub.createMember(owner, 'b');
    for (const id of [a.id, b.id]) {
      const res = await hub.api('POST', `/api/users/${id}/reset-password`, {
        cookie: a.cookie,
        body: { password: NEW_PASSWORD },
      });
      expect(res.status).toBe(403);
    }
    expect((await login('a', PASSWORD)).status).toBe(200);
    expect((await login('b', PASSWORD)).status).toBe(200);
    expect(hub.running.store.listAudit({ action: 'user.password_reset' })).toEqual([]);
  });

  it('an owner cannot skip the current password for their own account', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const me = (await hub.api('GET', '/api/auth/status', { cookie: owner })).body.user;
    const res = await hub.api('POST', `/api/users/${me.id}/reset-password`, {
      cookie: owner,
      body: { password: NEW_PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('own_password');
    expect((await login('owner', PASSWORD)).status).toBe(200);
  });

  it('rejects short passwords and unknown users', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    const short = await hub.api('POST', `/api/users/${member.id}/reset-password`, {
      cookie: owner,
      body: { password: 'short' },
    });
    expect(short.status).toBe(400);
    const missing = await hub.api('POST', '/api/users/nobody/reset-password', {
      cookie: owner,
      body: { password: NEW_PASSWORD },
    });
    expect(missing.status).toBe(404);
    expect((await login('member', PASSWORD)).status).toBe(200);
  });
});

describe('reset-password command', () => {
  const pipe = (text: string): PasswordSource => ({
    isTTY: false,
    promptHidden: () => Promise.reject(new Error('not a terminal')),
    readAll: async () => text,
  });
  const tty = (...answers: (string | null)[]): PasswordSource => ({
    isTTY: true,
    promptHidden: async () => answers.shift() ?? null,
    readAll: () => Promise.reject(new Error('is a terminal')),
  });
  const run = async (args: string[], input: PasswordSource, dataDir = hub.dir) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runResetPassword(args, {
      env: { AGENT_BOARD_DATA_DIR: dataDir },
      input,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      passwordParams: FAST_PASSWORD,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('resets from stdin while the hub is running, signs the user out and audits as system', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const ws = await hub.client(owner);
    const result = await run(['OWNER'], pipe(`${NEW_PASSWORD}\r\nignored second line\n`));
    expect(result).toMatchObject({ code: 0, err: '' });
    expect(result.out).toContain('"owner" was reset');
    expect(result.out).toContain('1 login session(s)');
    expect(result.out).not.toContain(NEW_PASSWORD);

    expect((await hub.api('GET', '/api/projects', { cookie: owner })).status).toBe(401);
    expect((await login('owner', PASSWORD)).status).toBe(401);
    expect((await login('owner', NEW_PASSWORD)).status).toBe(200);
    // 指令改的是資料庫，已開的 WebSocket 由 hub 的定期檢查關掉；這裡不等那 30 秒，只確認 REST 立刻失效。
    expect(ws.closeCode).toBeNull();

    const [entry] = hub.running.store.listAudit({ action: 'user.password_reset' });
    expect(entry?.userId).toBeNull();
    expect(JSON.parse(entry!.detail)).toMatchObject({ name: 'owner', via: 'cli' });
  });

  it('asks twice in a terminal and refuses when they differ', async () => {
    hub = await startHub();
    await hub.setupOwner();
    const mismatch = await run(['owner'], tty(NEW_PASSWORD, `${NEW_PASSWORD}x`));
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('do not match');
    expect((await login('owner', PASSWORD)).status).toBe(200);

    const cancelled = await run(['owner'], tty(null));
    expect(cancelled.code).toBe(130);
    expect((await login('owner', PASSWORD)).status).toBe(200);

    const ok = await run(['owner'], tty(NEW_PASSWORD, NEW_PASSWORD));
    expect(ok.code).toBe(0);
    expect((await login('owner', NEW_PASSWORD)).status).toBe(200);
  });

  it('explains what is wrong and changes nothing', async () => {
    hub = await startHub();
    await hub.setupOwner();
    const short = await run(['owner'], pipe('short\n'));
    expect(short.code).toBe(1);
    expect(short.err).toContain('at least 8');

    const unknown = await run(['ghost'], pipe(`${NEW_PASSWORD}\n`));
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('Users: owner');

    expect((await run([], pipe(''))).code).toBe(2);
    expect((await run(['a', 'b'], pipe(''))).code).toBe(2);
    expect((await run(['--help'], pipe(''))).out).toContain('reset-password <name>');
    expect((await login('owner', PASSWORD)).status).toBe(200);
    expect(hub.running.store.listAudit({ action: 'user.password_reset' })).toEqual([]);
  });

  it('does not create a database in the wrong folder', async () => {
    hub = await startHub();
    const empty = mkdtempSync(join(tmpdir(), 'ab-reset-empty-'));
    try {
      const result = await run(['owner'], pipe(`${NEW_PASSWORD}\n`), empty);
      expect(result.code).toBe(1);
      expect(result.err).toContain('AGENT_BOARD_DATA_DIR');
      expect(existsSync(join(empty, 'hub.db'))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('works through the real entry point (main.ts) with piped stdin', async () => {
    hub = await startHub();
    await hub.setupOwner();
    const TSX = join(import.meta.dirname, '../../../../node_modules/.bin/tsx');
    const MAIN = join(import.meta.dirname, '../main.ts');
    const child = spawn(TSX, [MAIN, 'reset-password', 'owner'], {
      env: { PATH: process.env.PATH, AGENT_BOARD_DATA_DIR: hub.dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    let code: number | null = null;
    child.on('exit', (c) => (code = c));
    child.stdin.end(`${NEW_PASSWORD}\n`);
    await until(() => code !== null, 'exit', 30_000);
    expect(code).toBe(0);
    expect(output).toContain('was reset');
    expect(output).not.toContain(NEW_PASSWORD);
    expect((await login('owner', NEW_PASSWORD)).status).toBe(200);
  }, 40_000);

  it('main.ts refuses unknown commands instead of starting a second hub', async () => {
    const TSX = join(import.meta.dirname, '../../../../node_modules/.bin/tsx');
    const MAIN = join(import.meta.dirname, '../main.ts');
    const dir = mkdtempSync(join(tmpdir(), 'ab-main-typo-'));
    try {
      const child = spawn(TSX, [MAIN, 'reset-pasword', 'owner'], {
        env: { PATH: process.env.PATH, AGENT_BOARD_DATA_DIR: dir, AGENT_BOARD_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      let code: number | null = null;
      child.on('exit', (c) => (code = c));
      await until(() => code !== null, 'exit', 30_000);
      expect(code).toBe(2);
      expect(output).toContain('Unknown command: reset-pasword');
      expect(existsSync(join(dir, 'hub.db'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('audit filters', () => {
  /** owner 登入、member 登入、一筆沒有使用者的登入失敗。 */
  async function seed() {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    await login('nobody', 'wrong-password');
    const ownerId = (await hub.api('GET', '/api/auth/status', { cookie: owner })).body.user.id;
    return { owner, member, ownerId: ownerId as string };
  }
  /** fetch 的 text() 會吃掉 BOM，所以列內容用 text()，BOM 另外看原始位元組。 */
  const csvRows = (csv: string) => csv.trimEnd().split('\r\n').slice(1);
  const exportBytes = async (cookie: string, query: string) =>
    new Uint8Array(
      await (
        await fetch(`${hub.url}/api/audit/export${query}`, { headers: { cookie } })
      ).arrayBuffer(),
    );
  const BOM = [0xef, 0xbb, 0xbf];

  it('lists by user, including entries without a user', async () => {
    const { owner, member, ownerId } = await seed();
    const mine = await hub.api<AuditEntry[]>('GET', `/api/audit?userId=${ownerId}`, {
      cookie: owner,
    });
    expect(mine.body.length).toBeGreaterThan(0);
    expect(mine.body.every((e) => e.userId === ownerId)).toBe(true);

    const theirs = await hub.api<AuditEntry[]>('GET', `/api/audit?userId=${member.id}`, {
      cookie: owner,
    });
    expect(theirs.body.map((e) => e.action)).toEqual(['auth.login']);

    const system = await hub.api<AuditEntry[]>('GET', `/api/audit?userId=${AUDIT_SYSTEM_USER}`, {
      cookie: owner,
    });
    expect(system.body.map((e) => e.action)).toEqual(['auth.login_failed']);
    expect(system.body.every((e) => e.userId === null)).toBe(true);

    // 和其他條件同時用是 AND。
    const none = await hub.api('GET', `/api/audit?userId=${member.id}&action=user.create`, {
      cookie: owner,
    });
    expect(none.body).toEqual([]);
  });

  it('exports exactly what the same filters list, with BOM and CSV escaping, and records the filter', async () => {
    const { owner, member, ownerId } = await seed();
    const all = await hub.api<string>('GET', '/api/audit/export', { cookie: owner });
    const allRows = csvRows(all.body);
    expect(allRows.length).toBeGreaterThanOrEqual(4);

    const byUser = await hub.api<string>('GET', `/api/audit/export?userId=${member.id}`, {
      cookie: owner,
    });
    expect(byUser.status).toBe(200);
    expect(byUser.headers.get('content-type')).toContain('text/csv');
    expect([...(await exportBytes(owner, `?userId=${member.id}`)).slice(0, 3)]).toEqual(BOM);
    const rows = csvRows(byUser.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`"${member.id}"`);
    expect(rows[0]).toContain('"auth.login"');

    const system = csvRows(
      (
        await hub.api<string>('GET', `/api/audit/export?userId=${AUDIT_SYSTEM_USER}`, {
          cookie: owner,
        })
      ).body,
    );
    // 第一份匯出也算 owner 的紀錄，不會出現在「系統」裡。
    expect(system).toHaveLength(1);
    expect(system[0]).toContain('"auth.login_failed"');

    const future = csvRows(
      (
        await hub.api<string>('GET', '/api/audit/export?from=2999-01-01T00:00:00.000Z', {
          cookie: owner,
        })
      ).body,
    );
    expect(future).toEqual([]);

    const action = await hub.api<AuditEntry[]>(
      'GET',
      `/api/audit?action=audit.export&userId=${ownerId}`,
      { cookie: owner },
    );
    const details = action.body.map((e) => e.detail).reverse();
    expect(details[0]).toBe('');
    expect(JSON.parse(details[1]!)).toEqual({ userId: member.id });

    const bad = await hub.api('GET', '/api/audit/export?from=yesterday', { cookie: owner });
    expect(bad.status).toBe(400);
  });
});
