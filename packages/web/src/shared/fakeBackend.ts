// 假資料後端：只給 demo 模式（?demo=1）與測試使用，正式資料庫一開始是空的（DISPATCH §1.2）。
import { DEFAULT_DANGER_RULES, DEFAULT_STUCK_MINUTES } from '@agent-board/protocol';
import type {
  Approval,
  HandoffRule,
  Layout,
  Machine,
  ResourceSample,
  Session,
  SessionEvent,
  Settings,
  Task,
  Team,
  TeamMember,
  Template,
  User,
} from '@agent-board/protocol';
import type { BoardBackend, BoardListener, BoardSnapshot } from './backend';
import type { TerminalServerMessage, TerminalStream } from './terminal-contract';
import { DECOMPOSE_PROMPT_START } from './decomposePrompt';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const machine = (id: string, name: string, online: boolean, hasGpu: boolean): Machine => ({
  id,
  name,
  os: 'linux',
  online,
  lastSeenAt: minutesAgo(online ? 0 : 42),
  capabilities: {
    hasGpu,
    gpuName: hasGpu ? 'Demo GPU' : null,
    cpuCores: 12,
    memoryBytes: 32 * 1024 ** 3,
    claudeVersion: '0.0.0-demo',
  },
});

const session = (
  over: Partial<Session> & Pick<Session, 'id' | 'name' | 'machineId' | 'status'>,
): Session => ({
  projectId: null,
  cwd: '/home/demo/project',
  branch: 'main',
  worktreePath: null,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  statusDetail: null,
  claudeSessionId: null,
  lastLines: [],
  lastOutputAt: minutesAgo(0),
  statusSince: minutesAgo(1),
  contextTokens: 40_000,
  createdAt: minutesAgo(90),
  endedAt: null,
  archived: false,
  ...over,
});

export function demoSnapshot(): BoardSnapshot {
  return {
    machines: [
      machine('m-studio', 'demo-studio', true, false),
      machine('m-gpu', 'demo-gpu', true, true),
      machine('m-laptop', 'demo-laptop', false, false),
    ],
    sessions: [
      session({
        id: 's-auth',
        name: 'Fix login',
        machineId: 'm-studio',
        status: 'waiting_permission',
        branch: 'ab/fix-auth',
        worktreePath: '/home/demo/.agent-board-wt/fix-auth',
        statusSince: minutesAgo(12),
        lastLines: ['Bash  npm test -- auth', 'Do you want to proceed?', '> 1. Yes', '  2. No'],
      }),
      session({
        id: 's-tests',
        name: 'Write tests',
        machineId: 'm-studio',
        status: 'running',
        branch: 'ab/auth-tests',
        permissionMode: 'acceptEdits',
        worktreePath: '/home/demo/.agent-board-wt/auth-tests',
        lastLines: ['Edit  tests/auth.test.ts', '  + 42 lines', 'Running vitest', '  18 passed'],
      }),
      session({
        id: 's-etl',
        name: 'Migrate data',
        machineId: 'm-gpu',
        status: 'plan_review',
        permissionMode: 'plan',
        statusSince: minutesAgo(4),
        lastLines: [
          'Plan: 3 steps',
          '1. Add column',
          '2. Backfill in batches',
          '3. Drop old column',
        ],
      }),
      session({
        id: 's-ml',
        name: 'Train model',
        machineId: 'm-gpu',
        status: 'stuck',
        branch: 'ab/train-v2',
        permissionMode: 'bypassPermissions',
        statusSince: minutesAgo(14),
        lastLines: ['epoch 12/40', 'loss 0.4182', 'loading checkpoint'],
      }),
      session({
        id: 's-docs',
        name: 'Tidy docs',
        machineId: 'm-studio',
        status: 'rate_limited',
        lastLines: ['API Error: Rate limit reached'],
      }),
      session({
        id: 's-web',
        name: 'Nav tweaks',
        machineId: 'm-laptop',
        status: 'offline',
        branch: 'ab/nav',
        statusSince: minutesAgo(42),
        lastLines: ['Edit  src/nav.tsx', '  + 8 lines', 'Running build'],
      }),
    ],
    approvals: [
      {
        id: 'a-1',
        sessionId: 's-auth',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: { command: 'npm test -- auth' },
        suggestions: [],
        matchedRule: null,
        message: null,
        createdAt: minutesAgo(12),
      },
      {
        id: 'a-2',
        sessionId: 's-etl',
        kind: 'plan',
        toolName: null,
        toolInput: null,
        suggestions: [],
        matchedRule: null,
        message: 'Plan: 3 steps',
        createdAt: minutesAgo(4),
      },
    ],
  };
}

/** 假 PTY：訂閱時送快照，之後每秒一行輸出；輸入會回顯。 */
export class FakeTerminalStream implements TerminalStream {
  private seq = new Map<string, number>();
  private listeners = new Map<string, Set<(m: TerminalServerMessage) => void>>();

  subscribe(sessionId: string, onMessage: (m: TerminalServerMessage) => void) {
    const seq = this.seq.get(sessionId) ?? 0;
    onMessage({
      type: 'terminal.snapshot',
      sessionId,
      seq,
      cols: 80,
      rows: 24,
      data: `\x1b[1mdemo session ${sessionId}\x1b[0m\r\n$ `,
    });
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(onMessage);
    this.listeners.set(sessionId, set);
    return () => set.delete(onMessage);
  }

  send(message: Parameters<TerminalStream['send']>[0]): void {
    if (message.type === 'terminal.input') this.emit(message.sessionId, message.data);
  }

  /** 測試用：模擬 PTY 輸出。 */
  emit(sessionId: string, data: string): void {
    const seq = (this.seq.get(sessionId) ?? 0) + 1;
    this.seq.set(sessionId, seq);
    this.listeners
      .get(sessionId)
      ?.forEach((l) => l({ type: 'terminal.output', sessionId, seq, data }));
  }
}

const demoUser: User = { id: 'u-demo', name: 'demo', role: 'owner', locale: 'zh-TW' };

const defaultSettings: Settings = {
  listenAddress: '127.0.0.1',
  publicOrigin: null,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  dangerRules: DEFAULT_DANGER_RULES,
  quotaGuards: { denyReadPaths: ['data/', '*.parquet'], maxConcurrentSessions: null },
  notifications: { enabled: true, quietHours: null },
};

/** 測試可以改掉 demoReply，模擬隊長回了無法解析的內容。 */
export interface FakeBackendControls {
  /** null 模擬隊長這回合失敗（StopFailure）。 */
  demoReply: string | null;
  /** 模擬 daemon 回報的狀態變化。 */
  setSessionStatus(id: string, status: Session['status']): void;
  addSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): void;
}

/** 假隊長的回覆，請隊長拆解在 demo 模式下也能走完。 */
const DEMO_DECOMPOSE_REPLY = `Here is the breakdown:

\`\`\`json
[{"title":"Map the login redirect paths"},{"title":"Write regression tests"},{"title":"Fix the redirect"}]
\`\`\``;

const DEMO_DECOMPOSE_DELAY_MS = 300;

/** 格式正確的 P-256 公鑰，沒有對應私鑰：demo 只走訂閱流程，不會真的送推播。 */
const DEMO_VAPID_PUBLIC_KEY =
  'BGFytsGGh7T9Tx6fiDSmrbB3n0Y_cmHcn6AA6kEE_rz2bzBRefjIZZ2RAGw92MUS2pHU30Zae8RAFRArPZYiDH0';

export function createFakeBackend(): BoardBackend & FakeBackendControls {
  const state = demoSnapshot();
  const pushEndpoints = new Set<string>();
  const teams: Team[] = [
    {
      id: 'team-demo-auth',
      name: '登入重構',
      goal: 'Fix the login redirect loop and cover it with tests.',
      doneCriteria: 'All auth tests pass and the redirect works on mobile.',
      color: 'teal',
      contextMd: '# Team notes\n\nKeep the session cookie format unchanged.\n',
    },
  ];
  const members: TeamMember[] = [
    { teamId: 'team-demo-auth', sessionId: 's-tests', role: 'lead' },
    { teamId: 'team-demo-auth', sessionId: 's-auth', role: 'worker' },
  ];
  const tasks: Task[] = [
    {
      id: 'task-1',
      teamId: 'team-demo-auth',
      title: 'Reproduce the redirect loop',
      ownerSessionId: 's-auth',
      column: 'doing',
    },
    {
      id: 'task-2',
      teamId: 'team-demo-auth',
      title: 'Check mobile Safari',
      ownerSessionId: null,
      column: 'todo',
    },
  ];
  const rules: HandoffRule[] = [
    {
      id: 'rule-1',
      teamId: 'team-demo-auth',
      fromSessionId: 's-auth',
      trigger: 'on_done',
      action: { toSessionId: 's-tests' },
      enabled: true,
    },
  ];
  const events: SessionEvent[] = [];
  const addEvent = (sessionId: string, type: string, payload: Record<string, unknown>) => {
    events.push({
      id: crypto.randomUUID(),
      sessionId,
      type,
      payload,
      at: new Date().toISOString(),
    });
  };
  const findIn = <T extends { id: string }>(list: T[], id: string, label: string): T => {
    const item = list.find((x) => x.id === id);
    if (!item) throw new Error(`unknown ${label} ${id}`);
    return item;
  };
  const removeFrom = <T>(list: T[], match: (item: T) => boolean) => {
    for (let i = list.length - 1; i >= 0; i -= 1) if (match(list[i]!)) list.splice(i, 1);
  };
  const listeners = new Set<BoardListener>();
  const terminal = new FakeTerminalStream();
  let settings = defaultSettings;
  let layouts: Layout[] = [];
  const templates: Template[] = [];
  const publish = () => listeners.forEach((l) => l({ ...state }));
  const find = (id: string) => {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  };

  return {
    terminal,
    watchBoard(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    watchResources(listener: (sample: ResourceSample) => void) {
      const tick = () =>
        state.machines
          .filter((m) => m.online)
          .forEach((m) =>
            listener({
              machineId: m.id,
              at: new Date().toISOString(),
              cpuPercent: 34,
              memoryUsedBytes: 16 * 1024 ** 3,
              memoryTotalBytes: m.capabilities.memoryBytes,
              gpu: m.capabilities.hasGpu
                ? {
                    name: 'Demo GPU',
                    utilizationPercent: 64,
                    memoryUsedBytes: 8 * 1024 ** 3,
                    memoryTotalBytes: 24 * 1024 ** 3,
                  }
                : null,
            }),
          );
      tick();
      const timer = setInterval(tick, 5000);
      return () => clearInterval(timer);
    },
    needsSetup: async () => false,
    currentUser: async () => demoUser,
    setup: async () => demoUser,
    login: async () => demoUser,
    logout: async () => {},
    async createSession(input) {
      const created = session({
        id: crypto.randomUUID(),
        name: input.name,
        machineId: input.machineId,
        status: 'starting',
        cwd: input.cwd,
        permissionMode: input.permissionMode,
        model: input.model,
        projectId: input.projectId,
      });
      state.sessions = [...state.sessions, created];
      publish();
      return created;
    },
    async updateSession(id, patch) {
      const s = find(id);
      if (patch.name) s.name = patch.name;
      if (patch.archived !== undefined) s.archived = patch.archived;
      if (patch.markDone && s.status !== 'done') {
        // 和 hub 一樣留狀態事件，完成提示靠它判斷標記前是不是在等輸入。
        addEvent(id, 'status', { from: s.status, to: 'done', reason: 'user_marked_done' });
        s.status = 'done';
      }
      publish();
      return s;
    },
    async stopSession(id) {
      const s = find(id);
      s.status = 'done';
      publish();
      return s;
    },
    sendPrompt(sessionId, text) {
      terminal.emit(sessionId, `${text}\r\n`);
      find(sessionId).status = 'running';
      publish();
      if (!text.startsWith(DECOMPOSE_PROMPT_START)) return;
      setTimeout(() => {
        find(sessionId).status = 'waiting_input';
        if (this.demoReply === null) {
          addEvent(sessionId, 'hook', { event: 'StopFailure', error: 'server_error' });
        } else {
          addEvent(sessionId, 'hook', { event: 'Stop', last_assistant_message: this.demoReply });
        }
        publish();
      }, DEMO_DECOMPOSE_DELAY_MS);
    },
    demoReply: DEMO_DECOMPOSE_REPLY as string | null,
    setSessionStatus(id, status) {
      find(id).status = status;
      publish();
    },
    addSessionEvent: addEvent,
    async decideApproval(approval: Approval) {
      state.approvals = state.approvals.filter((a) => a.id !== approval.id);
      find(approval.sessionId).status = 'running';
      publish();
    },
    listProjects: async () => [],
    listTemplates: async () => templates,
    async saveTemplate(input) {
      const t = { ...input, id: crypto.randomUUID() };
      templates.push(t);
      return t;
    },
    browseDirectory: async (_machineId, path) => ({
      path,
      entries: [
        { name: 'project', isDir: true, isGitRepo: true },
        { name: 'notes', isDir: true, isGitRepo: false },
      ],
    }),
    createPairingCode: async () => ({
      code: 'DEMO-0000',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      installCommand: 'agent-board-daemon pair DEMO-0000',
    }),
    async removeMachine(id) {
      state.machines = state.machines.filter((m) => m.id !== id);
      publish();
    },
    getLayouts: async () => layouts,
    async saveLayouts(next) {
      layouts = next;
    },
    getNotes: async () => [],
    getSettings: async () => settings,
    async updateSettings(patch) {
      settings = { ...settings, ...patch };
      return settings;
    },
    pushVapidKey: async () => DEMO_VAPID_PUBLIC_KEY,
    async pushSubscribe(subscription) {
      pushEndpoints.add(subscription.endpoint);
    },
    async pushUnsubscribe(endpoint) {
      pushEndpoints.delete(endpoint);
    },

    listTeams: async () => teams.map((x) => ({ ...x })),
    async createTeam(input) {
      const team = { ...input, id: crypto.randomUUID() };
      teams.push(team);
      return team;
    },
    async updateTeam(id, patch) {
      return Object.assign(findIn(teams, id, 'team'), patch);
    },
    async deleteTeam(id) {
      removeFrom(teams, (x) => x.id === id);
      removeFrom(members, (x) => x.teamId === id);
      removeFrom(tasks, (x) => x.teamId === id);
      removeFrom(rules, (x) => x.teamId === id);
    },
    listTeamMembers: async (teamId) => members.filter((x) => x.teamId === teamId),
    async putTeamMember(teamId, sessionId, role) {
      const member = { teamId, sessionId, role };
      removeFrom(members, (x) => x.teamId === teamId && x.sessionId === sessionId);
      members.push(member);
      return member;
    },
    async deleteTeamMember(teamId, sessionId) {
      removeFrom(members, (x) => x.teamId === teamId && x.sessionId === sessionId);
    },
    listTasks: async (teamId) => tasks.filter((x) => x.teamId === teamId).map((x) => ({ ...x })),
    async createTask(teamId, input) {
      const task: Task = { ...input, id: crypto.randomUUID(), teamId, column: 'todo' };
      tasks.push(task);
      return task;
    },
    async updateTask(id, patch) {
      const task = findIn(tasks, id, 'task');
      const next = { ...task, ...patch };
      // 和 hub 相同的規則（rest.ts tasksUpdate）。
      if (next.column !== 'todo' && next.ownerSessionId === null) {
        throw new Error('Assign the task before moving it');
      }
      return Object.assign(task, next);
    },
    async deleteTask(id) {
      removeFrom(tasks, (x) => x.id === id);
    },
    listHandoffRules: async (teamId) =>
      rules.filter((x) => x.teamId === teamId).map((x) => ({ ...x })),
    async createHandoffRule(teamId, input) {
      const rule = { ...input, id: crypto.randomUUID(), teamId };
      rules.push(rule);
      return rule;
    },
    async updateHandoffRule(id, patch) {
      return Object.assign(findIn(rules, id, 'rule'), patch);
    },
    async deleteHandoffRule(id) {
      removeFrom(rules, (x) => x.id === id);
    },
    sessionEvents: async (sessionId) => events.filter((x) => x.sessionId === sessionId),
  };
}
