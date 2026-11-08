import { describe, expect, it } from 'vitest';
import {
  ApprovalDecision,
  ATTENTION_STATUSES,
  ClientToHub,
  DaemonToHub,
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  DISPATCH_ROLES,
  HandoffRule,
  handoffRuleProblem,
  Team,
  TeamMember,
  HookPayload,
  HubToClient,
  HubToDaemon,
  needsAttention,
  NOT_PAUSED,
  QuotaGuards,
  routes,
  sameWorkingTree,
  isReadOnlyMember,
  Session,
  SessionSpec,
  SessionRuntime,
  SessionStatus,
  TeamRole,
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

describe('isReadOnlyMember', () => {
  it('needs both a read-only role and a read-only session; permission mode is not involved', () => {
    expect(isReadOnlyMember('reviewer', { readOnly: true })).toBe(true);
    expect(isReadOnlyMember('researcher', { readOnly: true })).toBe(true);
    expect(isReadOnlyMember('reviewer', { readOnly: false })).toBe(false);
    expect(isReadOnlyMember('worker', { readOnly: true })).toBe(false);
    expect(isReadOnlyMember('lead', { readOnly: true })).toBe(false);
  });

  it('readOnly defaults to false for old specs and sessions', () => {
    const spec = SessionSpec.parse({
      name: 'n',
      projectId: null,
      cwd: '/r',
      useWorktree: false,
      permissionMode: 'plan',
      model: null,
      accountProfile: null,
      resumeClaudeSessionId: null,
      firstPrompt: null,
    });
    expect(spec.readOnly).toBe(false);
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

describe('two-way handoff and research teams (2026-11-06)', () => {
  const rule = (action: object, trigger = 'on_done') => ({
    id: 'r',
    teamId: 't',
    fromSessionId: 'a',
    trigger,
    action: { toSessionId: 'b', ...action },
    enabled: true,
  });

  it('old rules without maxRounds or marker still parse unchanged', () => {
    expect(HandoffRule.parse(rule({ filePattern: '*.ts' }, 'on_file')).action).toEqual({
      toSessionId: 'b',
      filePattern: '*.ts',
    });
  });

  it('maxRounds is an integer 1–10; marker is 1–40 non-blank characters', () => {
    expect(HandoffRule.safeParse(rule({ maxRounds: 1 })).success).toBe(true);
    expect(HandoffRule.safeParse(rule({ maxRounds: 10 })).success).toBe(true);
    for (const bad of [0, 11, 2.5, '3']) {
      expect(HandoffRule.safeParse(rule({ maxRounds: bad })).success).toBe(false);
    }
    expect(HandoffRule.safeParse(rule({ marker: '[需要實驗]' }, 'on_marker')).success).toBe(true);
    expect(HandoffRule.safeParse(rule({ marker: '字'.repeat(40) }, 'on_marker')).success).toBe(
      true,
    );
    expect(HandoffRule.safeParse(rule({ marker: '字'.repeat(41) }, 'on_marker')).success).toBe(
      false,
    );
    expect(HandoffRule.safeParse(rule({ marker: '  ' }, 'on_marker')).success).toBe(false);
  });

  it('on_marker needs a marker', () => {
    expect(handoffRuleProblem({ trigger: 'on_marker', action: { toSessionId: 'b' } })).toBe(
      'marker_required',
    );
    expect(
      handoffRuleProblem({ trigger: 'on_marker', action: { toSessionId: 'b', marker: 'x' } }),
    ).toBeNull();
    expect(handoffRuleProblem({ trigger: 'on_done', action: { toSessionId: 'b' } })).toBeNull();
  });

  it('team phase and member kind are optional (old data has neither)', () => {
    // v9 起團隊一定帶工作區（hub 一定送）；phase、kind 仍是選填。
    const team = {
      id: 't',
      name: 'T',
      goal: '',
      doneCriteria: '',
      color: 'teal',
      contextMd: '',
      zoneId: 'main',
    };
    expect(Team.parse(team)).toEqual(team);
    expect(Team.parse({ ...team, phase: 'revision' }).phase).toBe('revision');
    expect(Team.safeParse({ ...team, phase: 'other' }).success).toBe(false);
    expect(TeamMember.parse({ teamId: 't', sessionId: 's', role: 'worker' })).not.toHaveProperty(
      'kind',
    );
    expect(TeamMember.parse({ teamId: 't', sessionId: 's', role: 'worker', kind: 'ex' }).kind).toBe(
      'ex',
    );
    const body = routes.teamsUpdate.body!;
    // PATCH 沒帶 phase 不能變成清掉（沒有 default）。
    expect(body.parse({ goal: 'g' })).toEqual({ goal: 'g' });
  });
});

describe('board pause (P2 §3)', () => {
  it('board.state from an older hub without pause means not paused', () => {
    const parsed = HubToClient.parse({
      type: 'board.state',
      machines: [],
      sessions: [],
      approvals: [],
    });
    expect(parsed.type === 'board.state' && parsed.pause).toEqual(NOT_PAUSED);
  });

  it('board.pause carries the state; modes are finish_turn and interrupt only', () => {
    const pause = {
      paused: { mode: 'interrupt', since: '2026-11-08T06:00:00.000Z', by: 'u', byName: 'GM' },
      held: { deliveries: 2, sessions: 1, autoContinues: 0 },
    };
    const parsed = HubToClient.parse({ type: 'board.pause', pause });
    expect(parsed.type === 'board.pause' && parsed.pause.paused?.clearedOnRestart).toBe(0);
    expect(routes.boardPause.body.safeParse({ mode: 'finish_turn' }).success).toBe(true);
    expect(routes.boardPause.body.safeParse({ mode: 'stop' }).success).toBe(false);
    expect(routes.boardPause.auth).toBe('user');
    expect(routes.boardResume.auth).toBe('user');
    expect(routes.boardPauseGet.auth).toBe('user');
  });

  it('only the hub can ask the daemon to check the status before an escape', () => {
    const signal = { type: 'terminal.signal', sessionId: 's', signal: 'escape' };
    expect(HubToDaemon.parse({ ...signal, onlyIfStatus: 'running' })).toMatchObject({
      onlyIfStatus: 'running',
    });
    expect(ClientToHub.parse({ ...signal, onlyIfStatus: 'running' })).not.toHaveProperty(
      'onlyIfStatus',
    );
  });
});

describe('workspaces and team broadcast (P2 §2)', () => {
  it('board.state from an older hub without zones or broadcasts: empty lists', () => {
    const parsed = HubToClient.parse({
      type: 'board.state',
      machines: [],
      sessions: [],
      approvals: [],
    });
    expect(parsed.type === 'board.state' && parsed.zones).toEqual([]);
    expect(parsed.type === 'board.state' && parsed.broadcasts).toEqual([]);
  });

  it('a session from an older hub is in the default workspace', () => {
    expect(DEFAULT_ZONE_ID).toBe('main');
    expect(DEFAULT_ZONE_NAME).toBe('主要');
    const old = Session.parse({
      id: 's',
      machineId: 'm',
      projectId: null,
      name: 'a',
      cwd: '/r',
      branch: null,
      worktreePath: null,
      permissionMode: 'default',
      model: null,
      accountProfile: null,
      status: 'waiting_input',
      statusDetail: null,
      claudeSessionId: null,
      lastLines: [],
      lastOutputAt: null,
      statusSince: '2026-11-08T00:00:00.000Z',
      contextTokens: null,
      createdAt: '2026-11-08T00:00:00.000Z',
      endedAt: null,
      archived: false,
    });
    expect(old.zoneId).toBe(DEFAULT_ZONE_ID);
  });

  it('tester is a role and can be spawned; create without zoneId, PATCH without zoneId does not move', () => {
    expect(TeamRole.options).toContain('tester');
    expect(DISPATCH_ROLES).toContain('tester');
    const create = routes.teamsCreate.body!.parse({
      name: 'T',
      goal: '',
      doneCriteria: '',
      color: 'teal',
      contextMd: '',
    });
    expect(create).not.toHaveProperty('zoneId');
    expect(routes.teamsUpdate.body!.parse({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('broadcast body: text required and trimmed, targets optional but not empty; zone names trimmed', () => {
    const body = routes.teamBroadcast.body!;
    expect(body.parse({ text: '  hi ' })).toEqual({ text: 'hi' });
    expect(body.safeParse({ text: '   ' }).success).toBe(false);
    expect(body.safeParse({ text: 'x', targets: [] }).success).toBe(false);
    expect(routes.zonesCreate.body!.parse({ name: ' 交易 ' })).toEqual({ name: '交易' });
    expect(routes.zonesCreate.body!.safeParse({ name: 'x'.repeat(41) }).success).toBe(false);
  });
});
