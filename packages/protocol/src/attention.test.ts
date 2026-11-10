import { describe, expect, it } from 'vitest';
import {
  IDLE_START_DETAIL,
  isAwaitingTeam,
  isIdleStart,
  sessionWaitsForUser,
  waitingSessions,
  WaitingThreshold,
} from './attention';
import { Session, Settings, type SessionStatus } from './models';

const session = (id: string, status: SessionStatus, over: Partial<Session> = {}): Session =>
  Session.parse({
    id,
    machineId: 'm',
    projectId: null,
    name: id,
    cwd: '/r',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    status,
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: null,
    statusSince: '2026-11-06T10:00:00.000Z',
    contextTokens: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    endedAt: null,
    archived: false,
    ...over,
  });

describe('「等你」的定義', () => {
  it('等隊長／等成員結果的 waiting_input 不算（GM 2026-11-11）；其他狀態帶了也照算', () => {
    expect(isAwaitingTeam({ status: 'waiting_input', awaiting: 'lead' })).toBe(true);
    expect(isAwaitingTeam({ status: 'waiting_input' })).toBe(false);
    expect(isAwaitingTeam({ status: 'waiting_permission', awaiting: 'lead' })).toBe(false);
    expect(sessionWaitsForUser(session('a', 'waiting_input', { awaiting: 'lead' }))).toBe(false);
    expect(sessionWaitsForUser(session('b', 'waiting_input', { awaiting: 'members' }))).toBe(false);
    expect(sessionWaitsForUser(session('c', 'waiting_permission', { awaiting: 'lead' }))).toBe(
      true,
    );
    expect(Session.parse({ ...session('d', 'waiting_input'), awaiting: 'members' }).awaiting).toBe(
      'members',
    );
  });

  it('收件匣的狀態都算；工作中、限流、排隊、完成、離線不算', () => {
    for (const status of [
      'waiting_permission',
      'waiting_input',
      'plan_review',
      'error',
      'stuck',
    ] as const) {
      expect(sessionWaitsForUser(session('a', status)), status).toBe(true);
    }
    for (const status of [
      'running',
      'starting',
      'queued',
      'rate_limited',
      'done',
      'offline',
    ] as const) {
      expect(sessionWaitsForUser(session('a', status)), status).toBe(false);
    }
  });

  it('剛開好或剛接回、什麼都沒做的 waiting_input 不算；封存的不算', () => {
    const idle = session('a', 'waiting_input', { statusDetail: IDLE_START_DETAIL });
    expect(isIdleStart(idle)).toBe(true);
    expect(sessionWaitsForUser(idle)).toBe(false);
    // 信任對話框（detail 'trust'）是真的在等你。
    expect(sessionWaitsForUser(session('a', 'waiting_input', { statusDetail: 'trust' }))).toBe(
      true,
    );
    expect(sessionWaitsForUser(session('a', 'error', { archived: true }))).toBe(false);
  });

  it('有還沒決定的 approval 也算（危險指令命中時常常還是 running），每個 session 只算一次', () => {
    const sessions = [
      session('a', 'running'),
      session('b', 'waiting_permission'),
      session('c', 'running'),
      session('d', 'running', { archived: true }),
    ];
    const approvals = [
      { sessionId: 'a' },
      { sessionId: 'b' },
      { sessionId: 'b' },
      { sessionId: 'd' },
    ];
    expect(waitingSessions(sessions, approvals).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('舊資料沒有 autoContinue 時是 null', () => {
    expect(session('a', 'running').autoContinue).toBeNull();
  });
});

describe('WaitingThreshold', () => {
  it('跨過上限時只回報一次，回到上限以內才重設', () => {
    const t = new WaitingThreshold();
    expect([1, 2, 3].map((n) => t.update(n, 3))).toEqual([false, false, false]);
    expect(t.update(4, 3)).toBe(true);
    expect(t.isOver).toBe(true);
    expect(t.update(5, 3)).toBe(false);
    expect(t.update(4, 3)).toBe(false);
    expect(t.update(3, 3)).toBe(false);
    expect(t.isOver).toBe(false);
    expect(t.update(4, 3)).toBe(true);
  });

  it('上限改了也照新的上限算', () => {
    const t = new WaitingThreshold();
    expect(t.update(2, 3)).toBe(false);
    expect(t.update(2, 1)).toBe(true);
    expect(t.update(2, 1)).toBe(false);
  });
});

describe('通知設定的預設與範圍', () => {
  const base = {
    listenAddress: '127.0.0.1',
    publicOrigin: null,
    stuckMinutes: 10,
    dangerRules: [],
    quotaGuards: { denyReadPaths: [], maxConcurrentSessions: null },
  };

  it('舊設定沒有新的鍵：合併通知開、上限 3、自動接續關', () => {
    const parsed = Settings.parse({ ...base, notifications: { enabled: true, quietHours: null } });
    expect(parsed.notifications).toMatchObject({ coalesce: true, waitingLimit: 3 });
    expect(parsed.autoContinue).toBe(false);
  });

  it('上限只能 1–20 的整數', () => {
    for (const waitingLimit of [0, 21, 1.5]) {
      expect(
        Settings.safeParse({
          ...base,
          notifications: { enabled: true, quietHours: null, waitingLimit },
        }).success,
        String(waitingLimit),
      ).toBe(false);
    }
  });
});
