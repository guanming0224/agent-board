import { describe, expect, it } from 'vitest';
import {
  ApprovalDecision,
  ATTENTION_STATUSES,
  ClientToHub,
  DaemonToHub,
  HookPayload,
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

  it('defaults remember to false', () => {
    expect(ApprovalDecision.parse({ behavior: 'allow' })).toEqual({
      behavior: 'allow',
      remember: false,
    });
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
