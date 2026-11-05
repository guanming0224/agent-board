// 加入團隊成員時的 worktree 檢查：hub 是防線，繞過前端也要擋。
import type { PermissionMode } from '@agent-board/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type Peer, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

interface Ctx {
  cookie: string;
  daemon: Peer;
  machineId: string;
  teamId: string;
}

async function setup(): Promise<Ctx> {
  hub = await startHub();
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie);
  const team = await hub.api('POST', '/api/teams', {
    cookie,
    body: { name: 'T', goal: '', doneCriteria: '', color: 'teal', contextMd: '' },
  });
  return { cookie, daemon, machineId, teamId: team.body.id };
}

const statusOf = (id: string) =>
  (
    hub.running.db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;

/** 建立並等 daemon 收到；`started` 帶入回報的欄位，不帶就停在 starting。 */
async function session(
  c: Ctx,
  over: {
    cwd?: string;
    useWorktree?: boolean;
    machineId?: string;
    daemon?: Peer;
    permissionMode?: PermissionMode;
  } = {},
  started?: object,
) {
  const {
    cwd = '/r',
    useWorktree = false,
    machineId = c.machineId,
    daemon = c.daemon,
    permissionMode = 'default',
  } = over;
  const res = await hub.api('POST', '/api/sessions', {
    cookie: c.cookie,
    body: { ...spec({ cwd, useWorktree, permissionMode }), machineId },
  });
  const create = await daemon.next('session.create');
  const id = res.body.id as string;
  if (started) {
    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(id, { cwd, status: 'waiting_input', ...started }),
    });
    await until(() => statusOf(id) === 'waiting_input', 'session started');
  }
  return id;
}

const join = (c: Ctx, id: string, role = 'worker') =>
  hub.api('PUT', `/api/teams/${c.teamId}/members/${id}`, { cookie: c.cookie, body: { role } });

const memberIds = async (c: Ctx) =>
  (await hub.api('GET', `/api/teams/${c.teamId}/members`, { cookie: c.cookie })).body.map(
    (m: { sessionId: string }) => m.sessionId,
  );

describe('PUT team member: own worktree required', () => {
  it('answers 409 for the same folder or a nested one, and does not add the member', async () => {
    const c = await setup();
    const first = await session(c, {}, {});
    expect((await join(c, first)).status).toBe(200);

    const same = await session(c, {}, {});
    const refused = await join(c, same);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_required');
    expect(refused.body.message).toContain('test session');
    expect(await memberIds(c)).toEqual([first]);

    const nested = await session(c, { cwd: '/r/packages/web/' }, {});
    expect((await join(c, nested)).status).toBe(409);
  });

  it('treats Windows separators the same', async () => {
    const c = await setup();
    const first = await session(c, { cwd: 'C:\\r' }, {});
    await join(c, first);
    const nested = await session(c, { cwd: 'C:\\r\\sub' }, {});
    expect((await join(c, nested)).status).toBe(409);
  });

  it('allows own worktrees, other folders and other machines', async () => {
    const c = await setup();
    const first = await session(c, {}, { worktreePath: '/wt/a' });
    const second = await session(c, {}, { worktreePath: '/wt/b' });
    const main = await session(c, {}, {});
    const sibling = await session(c, { cwd: '/other' }, {});
    const far = await hub.onlineDaemon(c.cookie);
    const remote = await session(c, { machineId: far.machineId, daemon: far.daemon }, {});
    for (const id of [first, second, main, sibling, remote]) {
      expect((await join(c, id)).status).toBe(200);
    }
    expect(await memberIds(c)).toHaveLength(5);
  });

  it('uses the repo root the daemon reports: sibling subfolders of one repo clash, linked worktrees do not', async () => {
    const c = await setup();
    const repo = { repoRoot: '/r', repoCommonDir: '/r/.git' };
    const a = await session(c, { cwd: '/r/a' }, { cwd: '/r/a', ...repo });
    await join(c, a);
    const b = await session(c, { cwd: '/r/b' }, { cwd: '/r/b', ...repo });
    expect((await join(c, b)).status).toBe(409);
    // 同 repo 的 linked worktree，即使放在主 repo 資料夾裡面，也是另一份檔案。
    const inner = await session(
      c,
      { cwd: '/r/.wt/x' },
      { cwd: '/r/.wt/x', worktreePath: '/r/.wt/x', repoRoot: '/r/.wt/x', repoCommonDir: '/r/.git' },
    );
    expect((await join(c, inner)).status).toBe(200);
  });

  it('refuses two sessions sharing one worktree', async () => {
    const c = await setup();
    const first = await session(c, {}, { worktreePath: '/wt/a' });
    await join(c, first);
    const second = await session(c, {}, { worktreePath: '/wt/a' });
    expect((await join(c, second)).status).toBe(409);
  });

  it('uses the requested worktree setting of a session that has not started yet', async () => {
    const c = await setup();
    const first = await session(c, {}, {});
    await join(c, first);
    expect((await join(c, await session(c, { useWorktree: true }))).status).toBe(200);
    expect((await join(c, await session(c, { useWorktree: false }))).status).toBe(409);
  });

  it('ignores members that have ended', async () => {
    const c = await setup();
    const first = await session(c, {}, {});
    await join(c, first);
    c.daemon.send({
      type: 'session.runtime',
      session: runtime(first, {
        cwd: '/r',
        status: 'done',
        endedAt: new Date().toISOString(),
      }),
    });
    await until(() => statusOf(first) === 'done', 'ended');
    const next = await session(c, {}, {});
    expect((await join(c, next)).status).toBe(200);
  });

  it('still lets an existing member change role, even if the team already clashes', async () => {
    const c = await setup();
    const first = await session(c, {}, {});
    await join(c, first);
    expect((await join(c, first, 'lead')).status).toBe(200);
    // 檢查上線前就存在的衝突：直接寫進資料庫模擬。
    const second = await session(c, {}, {});
    hub.running.db
      .prepare('INSERT INTO team_members (team_id, session_id, role) VALUES (?, ?, ?)')
      .run(c.teamId, second, 'worker');
    expect((await join(c, second, 'reviewer')).status).toBe(200);
  });

  it('lets read-only members (researcher/reviewer in plan mode) share the folder with a writer', async () => {
    const c = await setup();
    const lead = await session(c, {}, {});
    expect((await join(c, lead, 'lead')).status).toBe(200);
    const reviewer = await session(c, { permissionMode: 'plan' }, {});
    expect((await join(c, reviewer, 'reviewer')).status).toBe(200);
    // 還沒開好的也一樣（permissionMode 建立時就知道）。
    const researcher = await session(c, { permissionMode: 'plan' });
    expect((await join(c, researcher, 'researcher')).status).toBe(200);
    expect((await memberIds(c)).sort()).toEqual([lead, reviewer, researcher].sort());
  });

  it('needs both the read-only role and plan mode', async () => {
    const c = await setup();
    const lead = await session(c, {}, {});
    await join(c, lead, 'lead');
    const looseReviewer = await session(c, { permissionMode: 'default' }, {});
    expect((await join(c, looseReviewer, 'reviewer')).status).toBe(409);
    const planWorker = await session(c, { permissionMode: 'plan' }, {});
    expect((await join(c, planWorker, 'worker')).status).toBe(409);
    const planLead = await session(c, { permissionMode: 'plan' }, {});
    expect((await join(c, planLead, 'lead')).status).toBe(409);
  });

  it('a read-only member already in the folder does not block a writer; two read-only do not clash', async () => {
    const c = await setup();
    const reviewer = await session(c, { permissionMode: 'plan' }, {});
    await join(c, reviewer, 'reviewer');
    const researcher = await session(c, { permissionMode: 'plan' }, {});
    expect((await join(c, researcher, 'researcher')).status).toBe(200);
    const writer = await session(c, {}, {});
    expect((await join(c, writer, 'worker')).status).toBe(200);
    // 第二個會改檔案的照樣擋：只讀成員不會讓規則失效。
    const second = await session(c, {}, {});
    const refused = await join(c, second, 'worker');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('worktree_required');
  });

  it('a researcher whose session left plan mode counts as a writer for new members', async () => {
    const c = await setup();
    const researcher = await session(c, { permissionMode: 'plan' }, {});
    await join(c, researcher, 'researcher');
    hub.running.db
      .prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?')
      .run('acceptEdits', researcher);
    expect((await join(c, await session(c, {}, {}), 'worker')).status).toBe(409);
  });

  it('answers 404 for an unknown session or team', async () => {
    const c = await setup();
    expect((await join(c, 'nope')).status).toBe(404);
    const res = await hub.api('PUT', `/api/teams/nope/members/x`, {
      cookie: c.cookie,
      body: { role: 'worker' },
    });
    expect(res.status).toBe(404);
  });
});
