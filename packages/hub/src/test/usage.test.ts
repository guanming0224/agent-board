// 用量詳情（GM 2026-11-09）：合併多機、對應 session／團隊／工作區／專案、中控台外、舊 daemon 沒細項、
// 重啟後讀回上次存的、REST 權限。
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUsageReport,
  type LatestUsage,
  type Machine,
  type Session,
  type Team,
  type UsageDetail,
  type UsageReport,
  type UsageSummary,
} from '@agent-board/protocol';
import { PASSWORD, runtime, spec, startHub, until, type TestHub } from './helpers';

const CA = 'aaaaaaaa-0000-4000-8000-000000000001';
const CB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CX = 'cccccccc-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-09T03:00:00Z');

const machine = (id: string, online = true): Machine => ({
  id,
  name: `name-${id}`,
  os: 'linux',
  online,
  lastSeenAt: NOW.toISOString(),
  capabilities: {
    hasGpu: false,
    gpuName: null,
    cpuCores: 1,
    memoryBytes: 1,
    claudeVersion: null,
  },
});

const summary = (machineId: string, input = 1): UsageSummary => ({
  machineId,
  from: '2026-10-10T03:00:00.000Z',
  to: '2026-11-09T02:55:00.000Z',
  inputTokens: input,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

const detail = (over: Partial<UsageDetail> = {}): UsageDetail => ({
  version: 1,
  timeZone: 'Asia/Taipei',
  days: ['2026-11-08', '2026-11-09'],
  models: ['claude-opus', 'claude-haiku'],
  sessions: [
    { id: CA, cwd: '/work/alpha' },
    { id: CX, cwd: '/elsewhere/tool' },
  ],
  otherSessions: 3,
  earliestAt: '2026-10-20T00:00:00.000Z',
  rows: [
    [0, 0, 0, 10, 20, 30, 40],
    [1, 1, 1, 1, 2, 3, 4],
    [1, 0, -1, 5, 0, 0, 0],
  ],
  ...over,
});

const boardSession = (over: Partial<Session> & Pick<Session, 'id' | 'machineId'>): Session =>
  ({
    projectId: null,
    name: over.id,
    cwd: '/work/alpha',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    status: 'running',
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: null,
    statusSince: NOW.toISOString(),
    contextTokens: null,
    contextWindow: null,
    repoRoot: null,
    repoCommonDir: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    endedAt: null,
    archived: false,
    archivedAt: null,
    readOnly: false,
    autoContinue: null,
    dispatchedBy: null,
    zoneId: 'main',
    ...over,
  }) as Session;

const team = (id: string, name: string, zoneId = 'z-team'): Team => ({
  id,
  name,
  goal: '',
  doneCriteria: '',
  color: 'teal',
  contextMd: '',
  zoneId,
});

const latest = (s: UsageSummary, d: UsageDetail | null, restored = false): LatestUsage => ({
  summary: s,
  detail: d,
  restored,
});

/** 列攤平：`機器|日期|模型|session 名稱或 cwd` → [i,o,r,w]。 */
const flat = (r: UsageReport) =>
  Object.fromEntries(
    r.rows.map(([m, d, mo, s, ...c]) => {
      const ses = r.sessions[s]!;
      const who = ses.claudeSessionId === null ? 'other' : (ses.name ?? `out:${ses.cwd}`);
      return [`${r.machines[m]!.machineId}|${r.days[d]}|${r.models[mo]}|${who}`, c];
    }),
  );

describe('buildUsageReport', () => {
  it('合併多機：日期取聯集、模型共用一張表、各機的「其他」分開', () => {
    const report = buildUsageReport({
      now: NOW,
      machines: [machine('m1'), machine('m2')],
      latest: new Map([
        ['m1', latest(summary('m1'), detail())],
        [
          'm2',
          latest(
            summary('m2'),
            detail({
              timeZone: 'UTC',
              days: ['2026-11-07', '2026-11-08'],
              models: ['claude-haiku'],
              sessions: [{ id: CB, cwd: '/work/beta' }],
              otherSessions: 0,
              rows: [
                [0, 0, 0, 7, 0, 0, 0],
                [1, 0, -1, 1, 0, 0, 0],
              ],
            }),
          ),
        ],
      ]),
      sessions: [boardSession({ id: 's-a', machineId: 'm1', claudeSessionId: CA, name: 'Alpha' })],
      teams: [],
      members: [],
      zones: [],
      projects: [],
    });
    expect(report.days).toEqual(['2026-11-07', '2026-11-08', '2026-11-09']);
    expect(report.models).toEqual(['claude-opus', 'claude-haiku']);
    expect(flat(report)).toEqual({
      'm1|2026-11-08|claude-opus|Alpha': [10, 20, 30, 40],
      'm1|2026-11-09|claude-haiku|out:/elsewhere/tool': [1, 2, 3, 4],
      'm1|2026-11-09|claude-opus|other': [5, 0, 0, 0],
      'm2|2026-11-07|claude-haiku|out:/work/beta': [7, 0, 0, 0],
      'm2|2026-11-08|claude-haiku|other': [1, 0, 0, 0],
    });
    const others = report.sessions.filter((s) => s.claudeSessionId === null);
    expect(others.map((s) => s.machineId)).toEqual(['m1', 'm2']);
    expect(report.machines.map((m) => [m.machineId, m.state, m.timeZone])).toEqual([
      ['m1', 'detail', 'Asia/Taipei'],
      ['m2', 'detail', 'UTC'],
    ]);
  });

  it('對應 session、團隊、工作區、專案；同 id 在別台不算；中控台外留 cwd', () => {
    const report = buildUsageReport({
      now: NOW,
      machines: [machine('m1')],
      latest: new Map([['m1', latest(summary('m1'), detail())]]),
      sessions: [
        // 大小寫不同也對得到；封存的舊卡和新卡同 id 時取沒封存的。
        boardSession({
          id: 's-old',
          machineId: 'm1',
          claudeSessionId: CA.toUpperCase(),
          archived: true,
          createdAt: '2026-11-05T00:00:00.000Z',
        }),
        boardSession({
          id: 's-a',
          machineId: 'm1',
          claudeSessionId: CA,
          name: 'Alpha',
          projectId: 'p1',
          createdAt: '2026-11-01T00:00:00.000Z',
        }),
        // 同一個 Claude id 在別台：不是同一個對話。
        boardSession({ id: 's-x', machineId: 'm9', claudeSessionId: CX }),
      ],
      teams: [team('t-b', 'Beta team'), team('t-a', 'Alpha team')],
      members: [
        { teamId: 't-b', sessionId: 's-a', role: 'worker' },
        { teamId: 't-a', sessionId: 's-a', role: 'lead' },
      ],
      zones: [{ id: 'z-team', name: 'Team zone', createdAt: NOW.toISOString(), position: 0 }],
      projects: [{ id: 'p1', name: 'Proj', color: 'x' }],
    });
    const alpha = report.sessions.find((s) => s.claudeSessionId === CA)!;
    expect(alpha).toMatchObject({
      boardSessionId: 's-a',
      name: 'Alpha',
      archived: false,
      // 在兩個團隊：取名稱排序第一個；工作區跟著團隊。
      teamId: 't-a',
      teamName: 'Alpha team',
      zoneId: 'z-team',
      zoneName: 'Team zone',
      projectId: 'p1',
      projectName: 'Proj',
      cwd: '/work/alpha',
    });
    const outside = report.sessions.find((s) => s.claudeSessionId === CX)!;
    expect(outside).toMatchObject({ boardSessionId: null, name: null, cwd: '/elsewhere/tool' });
  });

  it('舊 daemon（沒細項）、還沒回報、看不懂的版本：只有總數，沒有列', () => {
    const report = buildUsageReport({
      now: NOW,
      machines: [machine('old'), machine('none', false), machine('future')],
      latest: new Map([
        ['old', latest(summary('old', 42), null, true)],
        ['future', latest(summary('future'), detail({ version: 99 }))],
      ]),
      sessions: [],
      teams: [],
      members: [],
      zones: [],
      projects: [],
    });
    expect(report.machines.map((m) => [m.machineId, m.state, m.online])).toEqual([
      ['old', 'old_daemon', true],
      ['none', 'not_reported', false],
      ['future', 'old_daemon', true],
    ]);
    expect(report.machines[0]).toMatchObject({
      summary: { inputTokens: 42 },
      restored: true,
      countedAt: null,
    });
    expect(report.rows).toEqual([]);
    expect(report.days).toEqual([]);
  });
});

describe('buildUsageReport：Codex（Codex 第二輪）', () => {
  it('Codex 細項標 agent codex、只對 Codex session 的 thread id、各自的「其他」分開；總數另放', () => {
    const codexDetail = detail({
      models: ['gpt-5-codex'],
      sessions: [{ id: CB, cwd: '/work/beta' }],
      otherSessions: 2,
      rows: [
        [1, 0, 0, 5, 6, 7, 0],
        [1, 0, -1, 1, 1, 1, 0],
      ],
    });
    const report = buildUsageReport({
      now: NOW,
      machines: [machine('m1')],
      latest: new Map([
        [
          'm1',
          {
            ...latest(summary('m1'), detail()),
            codex: {
              summary: (({ machineId: _, ...rest }) => rest)(summary('m1', 9)),
              detail: codexDetail,
            },
          },
        ],
      ]),
      sessions: [
        // 同一個 id：Claude session 不能對到 Codex 的用量，反之亦然。
        boardSession({ id: 'claude-b', machineId: 'm1', claudeSessionId: CB }),
        boardSession({ id: 'codex-b', machineId: 'm1', claudeSessionId: CB, agent: 'codex' }),
      ],
      teams: [],
      members: [],
      zones: [],
      projects: [],
    });
    const codexRows = report.rows.filter(([, , , s]) => report.sessions[s]!.agent === 'codex');
    expect(codexRows.map(([, , , s, ...c]) => [report.sessions[s]!.boardSessionId, c])).toEqual([
      ['codex-b', [5, 6, 7, 0]],
      [null, [1, 1, 1, 0]],
    ]);
    expect(
      report.sessions.filter((s) => s.agent === 'codex' && s.claudeSessionId === null),
    ).toHaveLength(1);
    expect(
      report.sessions.filter((s) => s.agent === 'claude' && s.claudeSessionId === null),
    ).toHaveLength(1);
    expect(report.machines[0]).toMatchObject({
      codexSummary: { machineId: 'm1', inputTokens: 9 },
      codexOtherSessions: 2,
      summary: { inputTokens: 1 },
    });
    expect(report.models).toContain('gpt-5-codex');
  });
});

describe('GET /api/usage', () => {
  let hub: TestHub;
  afterEach(async () => {
    await hub?.stop();
  });

  const wireSummary = {
    from: '2026-10-10T03:00:00.000Z',
    to: '2026-11-09T02:55:00.000Z',
    inputTokens: 16,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheCreationTokens: 44,
  };

  it('收細項、對應到看板的 session；舊 daemon 只有總數；hub 重啟後先用存下來的', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    const created = await hub.api('POST', '/api/sessions', {
      cookie,
      body: { ...spec({ name: 'Alpha' }), machineId },
    });
    const create = await daemon.next('session.create');
    daemon.send({
      type: 'session.created',
      requestId: create.requestId,
      session: runtime(created.body.id, { claudeSessionId: CA }),
    });
    daemon.send({ type: 'usage', summary: wireSummary, detail: detail() });
    await until(
      () =>
        hub.running.hub.usageReport().sessions.some((s) => s.boardSessionId === created.body.id),
      'usage mapped',
    );

    // 頁首用的單台總數不帶細項。
    const single = await hub.api('GET', `/api/machines/${machineId}/usage`, { cookie });
    expect(single.body).toEqual({ ...wireSummary, machineId });

    const res = await hub.api<UsageReport>('GET', '/api/usage', { cookie });
    expect(res.status).toBe(200);
    expect(res.body.machines[0]).toMatchObject({ machineId, state: 'detail', restored: false });
    const alpha = res.body.sessions.find((s) => s.claudeSessionId === CA);
    expect(alpha).toMatchObject({ boardSessionId: created.body.id, name: 'Alpha' });
    expect(res.body.rows).toHaveLength(3);

    // 未登入不行；一般成員可以看（user 權限）。
    expect((await hub.api('GET', '/api/usage')).status).toBe(401);
    const member = await hub.createMember(cookie);
    expect((await hub.api('GET', '/api/usage', { cookie: member.cookie })).status).toBe(200);

    // 重啟：還沒收到新掃描前，用上次存的。
    const { dbPath } = hub;
    await hub.running.close();
    hub = await startHub({ dbPath });
    const login = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    const again = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const restored = await hub.api<UsageReport>('GET', '/api/usage', { cookie: again });
    expect(restored.body.machines[0]).toMatchObject({ state: 'detail', restored: true });
    expect(restored.body.rows).toHaveLength(3);
    expect(
      (await hub.api('GET', `/api/machines/${machineId}/usage`, { cookie: again })).body,
    ).toMatchObject({ inputTokens: 16 });
    // 設定 API 看不到用量的鍵。
    const settings = await hub.api('GET', '/api/settings', { cookie: again });
    expect(JSON.stringify(settings.body)).not.toContain('usage:');
  });

  it('舊 daemon 不送細項、細項壞掉：總數照收，狀態是 old_daemon', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);
    daemon.send({ type: 'usage', summary: wireSummary });
    await until(() => hub.running.hub.latestUsage(machineId) !== null, 'usage');
    let res = await hub.api<UsageReport>('GET', '/api/usage', { cookie });
    expect(res.body.machines[0]).toMatchObject({
      state: 'old_daemon',
      summary: { inputTokens: 16 },
    });

    // 細項格式壞掉（列不是 7 格）：當沒送，總數更新。
    daemon.send({
      type: 'usage',
      summary: { ...wireSummary, inputTokens: 99 },
      detail: { ...detail(), rows: [[0, 0]] },
    });
    await until(() => hub.running.hub.latestUsage(machineId)?.inputTokens === 99, 'second');
    res = await hub.api<UsageReport>('GET', '/api/usage', { cookie });
    expect(res.body.machines[0]!.state).toBe('old_daemon');
  });
});
