// 加開申請（CONTRACTS §23）：型別、路由權限、守則文字。
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_INSTRUCTIONS,
  DISPATCH_TOOL_DESCRIPTIONS,
  HubToClient,
  LEAD_STAFFING_RHYTHM,
  routes,
  STAFF_REQUEST_PENDING_GUIDE,
  STAFF_REQUEST_TTL_MS,
  StaffRequest,
  TEAM_FULL_GUIDE,
  TeamActivity,
} from './index';

const request = {
  id: 'sr-1',
  at: '2026-11-13T01:00:00.000Z',
  expiresAt: '2026-11-13T01:30:00.000Z',
  teamId: 't-1',
  teamName: 'Squad',
  leadSessionId: 's-lead',
  leadName: 'Lead',
  limit: 'team_full',
  limits: ['team_full'],
  teamSize: 12,
  teamLimit: 12,
  role: 'tester',
  reason: 'Nobody tests the parser yet.',
  promptPreview: 'Write regression tests.',
  status: 'pending',
};

describe('staff request (CONTRACTS §23)', () => {
  it('parses a pending request; limits must not be empty; a lead cannot be requested', () => {
    expect(StaffRequest.parse(request)).toEqual(request);
    expect(StaffRequest.safeParse({ ...request, limits: [] }).success).toBe(false);
    expect(StaffRequest.safeParse({ ...request, role: 'lead' }).success).toBe(false);
    expect(StaffRequest.safeParse({ ...request, limit: 'other' }).success).toBe(false);
    expect(STAFF_REQUEST_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('board.state carries pending requests (old hubs: empty); staff.requests replaces the list', () => {
    const state = HubToClient.parse({
      type: 'board.state',
      machines: [],
      sessions: [],
      approvals: [],
    });
    expect(state).toMatchObject({ staffRequests: [] });
    expect(HubToClient.parse({ type: 'staff.requests', items: [request] })).toMatchObject({
      items: [{ id: 'sr-1' }],
    });
  });

  it('team activity: staff kinds may have no member yet; older kinds still parse', () => {
    const base = {
      id: 'a-1',
      at: '2026-11-13T01:00:00.000Z',
      teamId: 't-1',
      teamName: 'Squad',
      leadSessionId: 's-lead',
      leadName: 'Lead',
      role: 'tester',
      reason: 'x',
      read: false,
    };
    for (const kind of ['staff_requested', 'staff_rejected', 'staff_expired', 'staff_failed']) {
      expect(
        TeamActivity.safeParse({ ...base, kind, staffRequestId: 'sr-1', limit: 'spawn_rate' })
          .success,
      ).toBe(true);
    }
    expect(
      TeamActivity.safeParse({
        ...base,
        kind: 'member_added',
        memberSessionId: 's-m',
        memberName: 'BD1',
      }).success,
    ).toBe(true);
  });

  it('approve and reject are owner-only; the list is for any signed-in user', () => {
    expect(routes.staffRequestList).toMatchObject({ method: 'GET', auth: 'user' });
    expect(routes.staffRequestApprove).toMatchObject({
      method: 'POST',
      path: '/api/staff-requests/:id/approve',
      auth: 'owner',
    });
    expect(routes.staffRequestReject).toMatchObject({
      method: 'POST',
      path: '/api/staff-requests/:id/reject',
      auth: 'owner',
    });
  });

  it('lead guide: over a limit becomes a request; the lead is told to end its turn, never to wait', () => {
    expect(TEAM_FULL_GUIDE).toMatch(/request to approve/);
    expect(LEAD_STAFFING_RHYTHM).toMatch(/pending_approval/);
    expect(LEAD_STAFFING_RHYTHM).toMatch(/\[Agent Board\]/);
    expect(DISPATCH_INSTRUCTIONS).toContain(LEAD_STAFFING_RHYTHM);
    expect(DISPATCH_TOOL_DESCRIPTIONS.spawn_member).toMatch(/pending_approval/);
    expect(STAFF_REQUEST_PENDING_GUIDE).toMatch(/end your turn now: do not sleep, poll/);
    // 實測說 wait 會讓模型在回合裡 sleep 互等（§22.4）：這幾段不能叫它 wait。
    for (const text of [
      STAFF_REQUEST_PENDING_GUIDE,
      TEAM_FULL_GUIDE,
      DISPATCH_TOOL_DESCRIPTIONS.spawn_member,
    ]) {
      expect(text).not.toMatch(/\bwait (until|for "\[Agent Board\]|for the decision)/i);
    }
  });
});
