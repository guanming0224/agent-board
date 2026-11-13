// 不是 git 的資料夾（CONTRACTS §24）：一鍵 git init 的轉送與權限、團隊「共用資料夾」設定的存取與清除。
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_FEATURES, type GitInitResult } from '@agent-board/protocol';
import { runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const auditRows = (action: string) =>
  (
    hub.running.db
      .prepare('SELECT user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
      .all(action) as { user_id: string | null; detail: string }[]
  ).map((r) => ({ userId: r.user_id, detail: JSON.parse(r.detail) as Record<string, unknown> }));

const NEW_FEATURES = [DAEMON_FEATURES.signalGuard, DAEMON_FEATURES.gitInit];

const okResult = (path: string): GitInitResult => ({
  ok: true,
  path,
  branch: 'main',
  commit: 'abc123',
  gitignoreCreated: true,
  identity: 'fallback',
  files: 3,
  skipped: [{ path: 'big.bin', bytes: 60 * 1024 * 1024 }],
  skippedMore: 0,
});

describe('POST /api/machines/:id/git-init', () => {
  it('owner：轉給 daemon，回結果並記 audit；拒絕也回 200、ok false', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie, { features: NEW_FEATURES });
    const url = `/api/machines/${machineId}/git-init`;

    const pending = hub.api('POST', url, { cookie, body: { path: ' /work/notes ' } });
    const req = await daemon.next('fs.gitInit');
    expect(req.path).toBe('/work/notes');
    daemon.send({
      type: 'fs.gitInitResult',
      requestId: req.requestId,
      result: okResult('/work/notes'),
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toEqual(okResult('/work/notes'));
    expect(auditRows('fs.git_init')).toEqual([
      {
        userId: expect.any(String),
        detail: {
          machineId,
          path: '/work/notes',
          ok: true,
          commit: 'abc123',
          files: 3,
          gitignoreCreated: true,
          identity: 'fallback',
          skipped: 1,
        },
      },
    ]);

    const refusing = hub.api('POST', url, { cookie, body: { path: '/home/x' } });
    const req2 = await daemon.next('fs.gitInit', (m) => m.requestId !== req.requestId);
    daemon.send({
      type: 'fs.gitInitResult',
      requestId: req2.requestId,
      result: { ok: false, path: '/home/x', code: 'too_broad', message: 'it is your home folder' },
    });
    expect((await refusing).body).toMatchObject({ ok: false, code: 'too_broad' });
    expect(auditRows('fs.git_init').at(-1)?.detail).toMatchObject({ ok: false, code: 'too_broad' });
  });

  it('只有 owner；沒登入 401', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie, { features: NEW_FEATURES });
    const member = await hub.createMember(cookie);
    const url = `/api/machines/${machineId}/git-init`;
    expect(
      (await hub.api('POST', url, { cookie: member.cookie, body: { path: '/x' } })).status,
    ).toBe(403);
    expect((await hub.api('POST', url, { body: { path: '/x' } })).status).toBe(401);
    expect(daemon.of('fs.gitInit')).toHaveLength(0);
  });

  it('舊 daemon（hello 沒有 fs.gitInit）：409 daemon_too_old，不送；離線 409 machine_offline', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const url = `/api/machines/${machineId}/git-init`;
    const old = await hub.api('POST', url, { cookie, body: { path: '/x' } });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('daemon_too_old');
    expect(daemon.of('fs.gitInit')).toHaveLength(0);
    daemon.close();
    await until(() => hub.running.store.getMachine(machineId)?.online === false, 'offline');
    const offline = await hub.api('POST', url, { cookie, body: { path: '/x' } });
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe('machine_offline');
  });

  it('hub 已逾時才到的結果：照樣記 audit（late）', async () => {
    hub = await startHub({ timing: { gitInitTimeoutMs: 50 } });
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie, { features: NEW_FEATURES });
    const res = await hub.api('POST', `/api/machines/${machineId}/git-init`, {
      cookie,
      body: { path: '/work/slow' },
    });
    expect(res.status).toBe(504);
    const req = await daemon.next('fs.gitInit');
    daemon.send({
      type: 'fs.gitInitResult',
      requestId: req.requestId,
      result: okResult('/work/slow'),
    });
    await until(() => auditRows('fs.git_init').length === 1, 'late audit');
    expect(auditRows('fs.git_init')[0]).toMatchObject({
      userId: null,
      detail: { path: '/work/slow', ok: true, late: true },
    });
  });
});

describe('團隊「共用資料夾」（teamSharedWriters）', () => {
  const body = { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '' };

  it('建立時帶、PATCH 開關、列表看得到；刪團隊清掉設定；都記 audit', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const created = await hub.api('POST', '/api/teams', {
      cookie,
      body: { ...body, sharedWriters: true },
    });
    expect(created.status).toBe(200);
    expect(created.body.sharedWriters).toBe(true);
    const id = created.body.id as string;
    const key = `teamSharedWriters:${id}`;
    expect(hub.running.store.getRawJson(key)).toBe(true);
    const list = await hub.api('GET', '/api/teams', { cookie });
    expect(list.body.find((t: { id: string }) => t.id === id).sharedWriters).toBe(true);

    // 改別的欄位不動它。
    const renamed = await hub.api('PATCH', `/api/teams/${id}`, { cookie, body: { name: 'T2' } });
    expect(renamed.body.sharedWriters).toBe(true);
    const off = await hub.api('PATCH', `/api/teams/${id}`, {
      cookie,
      body: { sharedWriters: false },
    });
    expect(off.body.sharedWriters).toBeUndefined();
    expect(hub.running.store.getRawJson(key)).toBeNull();
    await hub.api('PATCH', `/api/teams/${id}`, { cookie, body: { sharedWriters: true } });
    expect(hub.running.store.getRawJson(key)).toBe(true);
    expect(auditRows('team.shared_writers').map((r) => r.detail.on)).toEqual([true, false, true]);

    expect((await hub.api('DELETE', `/api/teams/${id}`, { cookie })).status).toBe(200);
    expect(hub.running.store.getRawJson(key)).toBeNull();

    // 沒帶＝沒開。
    const plain = await hub.api('POST', '/api/teams', { cookie, body });
    expect(plain.body.sharedWriters).toBeUndefined();
  });

  it('加入成員：共用資料夾的團隊不檢查同資料夾衝突，沒勾的照樣擋', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const start = async (cwd = '/plain', repoRoot: string | null = null) => {
      const res = await hub.api('POST', '/api/sessions', {
        cookie,
        body: { ...spec({ cwd }), machineId },
      });
      const create = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
      daemon.send({
        type: 'session.created',
        requestId: create.requestId,
        session: runtime(res.body.id, { cwd, status: 'waiting_input', repoRoot }),
      });
      await until(
        () => hub.running.store.getSession(res.body.id)?.status === 'waiting_input',
        'started',
      );
      return res.body.id as string;
    };
    const a = await start();
    const b = await start();
    const put = (teamId: string, id: string, role: string) =>
      hub.api('PUT', `/api/teams/${teamId}/members/${id}`, { cookie, body: { role } });

    const strict = (await hub.api('POST', '/api/teams', { cookie, body })).body.id as string;
    expect((await put(strict, a, 'lead')).status).toBe(200);
    expect((await put(strict, b, 'worker')).body.code).toBe('worktree_required');

    const shared = (
      await hub.api('POST', '/api/teams', {
        cookie,
        body: { ...body, name: 'S', sharedWriters: true },
      })
    ).body.id as string;
    expect((await put(shared, a, 'lead')).status).toBe(200);
    expect((await put(shared, b, 'worker')).status).toBe(200);

    // N10：共用只在不是 git 的資料夾生效。git 資料夾的團隊開著也照樣要各自 worktree。
    const g1 = await start('/repo', '/repo');
    const g2 = await start('/repo', '/repo');
    const sharedGit = (
      await hub.api('POST', '/api/teams', {
        cookie,
        body: { ...body, name: 'G', sharedWriters: true },
      })
    ).body.id as string;
    expect((await put(sharedGit, g1, 'lead')).status).toBe(200);
    expect((await put(sharedGit, g2, 'worker')).body.code).toBe('worktree_required');
  });

  it('開或關都只有 owner：非 owner 帶 sharedWriters 一律 403；不帶照常', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const member = await hub.createMember(cookie);
    const denied = await hub.api('POST', '/api/teams', {
      cookie: member.cookie,
      body: { ...body, sharedWriters: true },
    });
    expect(denied.status).toBe(403);
    // 帶 false 也算「改這個設定」。
    const deniedOff = await hub.api('POST', '/api/teams', {
      cookie: member.cookie,
      body: { ...body, sharedWriters: false },
    });
    expect(deniedOff.status).toBe(403);
    const plain = await hub.api('POST', '/api/teams', { cookie: member.cookie, body });
    expect(plain.status).toBe(200);
    const id = plain.body.id as string;
    expect(
      (
        await hub.api('PATCH', `/api/teams/${id}`, {
          cookie: member.cookie,
          body: { sharedWriters: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (await hub.api('PATCH', `/api/teams/${id}`, { cookie: member.cookie, body: { name: 'X' } }))
        .status,
    ).toBe(200);
    expect(hub.running.store.getTeamSharedWriters(id)).toBe(false);
    const byOwner = await hub.api('PATCH', `/api/teams/${id}`, {
      cookie,
      body: { sharedWriters: true },
    });
    expect(byOwner.body.sharedWriters).toBe(true);
    expect(
      (
        await hub.api('PATCH', `/api/teams/${id}`, {
          cookie: member.cookie,
          body: { sharedWriters: false },
        })
      ).status,
    ).toBe(403);
    expect(hub.running.store.getTeamSharedWriters(id)).toBe(true);
  });
});
