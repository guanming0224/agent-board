import { describe, expect, it } from 'vitest';
import {
  ApprovalDecision,
  ATTENTION_STATUSES,
  ClientToHub,
  DaemonToHub,
  HookPayload,
  HubToClient,
  needsAttention,
  routes,
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
