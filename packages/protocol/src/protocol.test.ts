import { describe, expect, it } from 'vitest';
import {
  ApprovalDecision,
  ATTENTION_STATUSES,
  ClientToHub,
  DaemonToHub,
  HookPayload,
  HubToClient,
  needsAttention,
  QuotaGuards,
  routes,
  sameWorkingTree,
  SessionRuntime,
  SessionStatus,
} from './index';

describe('session status', () => {
  it('covers every state in DISPATCH §4 plus queued', () => {
    expect(SessionStatus.options).toHaveLength(11);
  });

  it('flags only the states that push notifications per §4', () => {
    expect([...ATTENTION_STATUSES].sort()).toEqual(
      ['error', 'plan_review', 'stuck', 'waiting_input', 'waiting_permission'].sort(),
    );
    expect(needsAttention('running')).toBe(false);
    expect(needsAttention('rate_limited')).toBe(false);
  });
});

describe('approval decision', () => {
  it('requires a reason to deny', () => {
    expect(ApprovalDecision.safeParse({ behavior: 'deny', reason: '  ' }).success).toBe(false);
    expect(ApprovalDecision.safeParse({ behavior: 'deny', reason: 'too risky' }).success).toBe(
      true,
    );
  });

  it('keeps an answer distinct from a denial, and requires text', () => {
    expect(ApprovalDecision.safeParse({ behavior: 'answer', text: '' }).success).toBe(false);
    expect(ApprovalDecision.parse({ behavior: 'answer', text: 'English' }).behavior).toBe('answer');
  });

  it('defaults remember to false', () => {
    expect(ApprovalDecision.parse({ behavior: 'allow' })).toEqual({
      behavior: 'allow',
      remember: false,
    });
  });
});

describe('rest bodies', () => {
  it('parses archived=false as false', () => {
    expect(routes.sessionsList.query.parse({ archived: 'false' }).archived).toBe(false);
  });

  it('requires the current password to change the password', () => {
    expect(routes.usersUpdate.body.safeParse({ password: 'new-password' }).success).toBe(false);
    expect(
      routes.usersUpdate.body.safeParse({ password: 'new-password', currentPassword: 'old' })
        .success,
    ).toBe(true);
    expect(routes.usersUpdate.body.safeParse({ locale: 'en' }).success).toBe(true);
  });

  it('owner reset takes only a new password of the usual minimum length', () => {
    expect(routes.usersResetPassword.body.safeParse({ password: 'short' }).success).toBe(false);
    expect(routes.usersResetPassword.body.safeParse({ password: 'long-enough' }).success).toBe(
      true,
    );
  });

  it('audit list and export share the same filters, export has no limit', () => {
    const filter = { userId: 'system', action: 'auth.login', from: '2026-01-01T00:00:00.000Z' };
    expect(routes.auditList.query.parse(filter)).toEqual({ ...filter, limit: 100 });
    expect(routes.auditExport.query.parse({ ...filter, limit: '5' })).toEqual(filter);
    expect(routes.auditExport.query.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});

describe('hook payload', () => {
  it('keeps fields we do not model, so new Claude Code versions do not lose data', () => {
    const parsed = HookPayload.parse({
      session_id: 'abc',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      some_future_field: 1,
    });
    expect(parsed.notification_type).toBe('permission_prompt');
    expect(parsed.some_future_field).toBe(1);
  });
});

describe('websocket messages', () => {
  it('rejects unknown message types', () => {
    expect(ClientToHub.safeParse({ type: 'nope' }).success).toBe(false);
    expect(DaemonToHub.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('resize can claim the size; old clients without claim still parse', () => {
    const base = { type: 'terminal.resize', sessionId: 's', cols: 80, rows: 24 };
    expect(ClientToHub.parse(base)).toEqual(base);
    expect(ClientToHub.parse({ ...base, claim: true })).toMatchObject({ claim: true });
  });

  it('terminal.size tells each viewer who owns the PTY size', () => {
    const size = { type: 'terminal.size', sessionId: 's', cols: 80, rows: 24 };
    for (const owner of ['you', 'other', 'none']) {
      expect(HubToClient.safeParse({ ...size, owner }).success).toBe(true);
    }
    expect(HubToClient.safeParse({ ...size, owner: 'me' }).success).toBe(false);
  });
});

describe('rest routes', () => {
  const list = Object.values(routes);

  it('has no duplicate method + path', () => {
    const keys = list.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('exposes only setup, login, status and pairing without a session (§10)', () => {
    const open = list
      .filter((r) => r.auth === 'public')
      .map((r) => r.path)
      .sort();
    expect(open).toEqual(
      ['/api/auth/login', '/api/auth/setup', '/api/auth/status', '/api/machines/pair'].sort(),
    );
  });
});

describe('quota guards (§8-5)', () => {
  it('queues on a rate-limited account by default, including settings saved before the option', () => {
    expect(
      QuotaGuards.parse({ denyReadPaths: [], maxConcurrentSessions: null }).queueWhenRateLimited,
    ).toBe(true);
    expect(
      QuotaGuards.parse({
        denyReadPaths: [],
        maxConcurrentSessions: 1,
        queueWhenRateLimited: false,
      }).queueWhenRateLimited,
    ).toBe(false);
  });
});

describe('fields added for older daemons', () => {
  it('fills repo, context window and repo identity with null when a daemon does not send them', () => {
    const listed = DaemonToHub.parse({
      type: 'fs.listResult',
      requestId: 'r',
      path: '/x',
      entries: [],
      error: null,
    });
    expect(listed).toMatchObject({ repo: null });
    const runtime = SessionRuntime.parse({
      id: 's',
      cwd: '/x',
      branch: null,
      worktreePath: null,
      status: 'running',
      statusDetail: null,
      claudeSessionId: null,
      lastLines: [],
      lastOutputAt: null,
      statusSince: '2026-11-03T00:00:00Z',
      contextTokens: null,
      endedAt: null,
    });
    expect(runtime).toMatchObject({ contextWindow: null, repoRoot: null, repoCommonDir: null });
  });
});

describe('sameWorkingTree', () => {
  const at = (dir: string, repoRoot: string | null = null) => ({ dir, repoRoot });

  it('two subfolders of one repo share a working tree once the root is known', () => {
    expect(sameWorkingTree(at('/r/a', '/r'), at('/r/b', '/r'))).toBe(true);
    // 根目錄還不知道：只能比資料夾，不相干的子資料夾判斷不出來。
    expect(sameWorkingTree(at('/r/a'), at('/r/b'))).toBe(false);
  });

  it('uses the known root against an unknown side', () => {
    expect(sameWorkingTree(at('/r/a', '/r'), at('/r/b'))).toBe(true);
    expect(sameWorkingTree(at('/other'), at('/r/a', '/r'))).toBe(false);
  });

  it('a linked worktree of the same repo is a different working tree, even nested inside it', () => {
    expect(sameWorkingTree(at('/r', '/r'), at('/r/.wt/x/sub', '/r/.wt/x'))).toBe(false);
    expect(sameWorkingTree(at('/wt/a', '/wt/a'), at('/wt/a/src', '/wt/a'))).toBe(true);
  });

  it('falls back to same or nested folders, ignoring trailing slashes and Windows separators', () => {
    expect(sameWorkingTree(at('/r/'), at('/r/packages/web'))).toBe(true);
    expect(sameWorkingTree(at('C:\\r'), at('C:\\r\\sub'))).toBe(true);
    expect(sameWorkingTree(at('/r'), at('/rx'))).toBe(false);
    expect(sameWorkingTree(at(''), at('/r'))).toBe(false);
  });
});
