// 假資料後端：只給 demo 模式（?demo=1）與測試使用，正式資料庫一開始是空的（DISPATCH §1.2）。
import { DEFAULT_DANGER_RULES, DEFAULT_STUCK_MINUTES } from '@agent-board/protocol';
import type {
  Approval,
  Layout,
  Machine,
  ResourceSample,
  Session,
  Settings,
  Template,
  User,
} from '@agent-board/protocol';
import type { BoardBackend, BoardListener, BoardSnapshot } from './backend';
import type { TerminalServerMessage, TerminalStream } from './terminal-contract';

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

export function createFakeBackend(): BoardBackend {
  const state = demoSnapshot();
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
      if (patch.markDone) s.status = 'done';
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
    },
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
  };
}
