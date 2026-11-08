// 假資料後端：只給 demo 模式（?demo=1）與測試使用，正式資料庫一開始是空的（DISPATCH §1.2）。
import {
  AUDIT_SYSTEM_USER,
  CANVAS_LAYOUT_SET,
  DEFAULT_ZONE_ID,
  DEFAULT_ZONE_NAME,
  DEFAULT_DANGER_RULES,
  DEFAULT_STUCK_MINUTES,
  cleanProgressText,
  emptyProgressCard,
  EMPTY_PROGRESS_FACTS,
  handoffRuleProblem,
  NOT_PAUSED,
  overLimit,
  planProgressWrite,
  PROGRESS_ASK_UPDATE_PROMPT,
  PROGRESS_FIELDS,
  PROGRESS_HISTORY_KEEP,
  progressLine,
  progressOwnerKey,
  progressOwnerOf,
  TeamPresetConfig,
  zoneMoveShift,
} from '@agent-board/protocol';
import type {
  Approval,
  AuditEntry,
  BoardHeld,
  BoardInterruptResult,
  BoardPauseState,
  HandoffRule,
  Layout,
  Machine,
  Project,
  PurgeOutcome,
  ResourceSample,
  Session,
  SessionEvent,
  SessionInspect,
  Settings,
  Task,
  Team,
  TeamMember,
  TeamPreset,
  Template,
  TranscriptEntry,
  UsageSummary,
  User,
  Zone,
  Broadcast,
  ProgressActor,
  ProgressCard,
  ProgressConflict,
  ProgressFacts,
  ProgressFields,
  ProgressOwner,
  ProgressRevision,
  ProgressWrite,
} from '@agent-board/protocol';
import { zoneOfSession } from '../zones/model';
import type { AuditFilter, BoardBackend, BoardListener, BoardSnapshot } from './backend';
import type { TerminalServerMessage, TerminalStream } from './terminal-contract';
import { DECOMPOSE_PROMPT_START } from './decomposePrompt';
import { fakeDeepSearch } from './fakeDeepSearch';
import { fakeSearch } from './fakeSearch';

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
  contextWindow: 200_000,
  repoRoot: null,
  repoCommonDir: null,
  createdAt: minutesAgo(90),
  endedAt: null,
  archived: false,
  archivedAt: null,
  readOnly: false,
  autoContinue: null,
  dispatchedBy: null,
  zoneId: 'main',
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
        claudeSessionId: DEMO_AUTH_CONVERSATION,
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
        claudeSessionId: DEMO_SHARED_CONVERSATION,
        lastLines: ['Edit  tests/auth.test.ts', '  + 42 lines', 'Running vitest', '  18 passed'],
      }),
      session({
        id: 's-etl',
        name: 'Migrate data',
        machineId: 'm-gpu',
        status: 'plan_review',
        permissionMode: 'plan',
        statusSince: minutesAgo(4),
        claudeSessionId: DEMO_ETL_CONVERSATION,
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

/** 深層搜尋（P3 ③b）的 demo 對話：s-auth（demo-studio）與 s-etl（demo-gpu）。 */
const DEMO_AUTH_CONVERSATION = '5a1e7c2d-3b4f-4a6e-9c8d-1f2e3d4c5b6a';
const DEMO_ETL_CONVERSATION = '6b2f8d3e-4c5a-4b7f-8d9e-2a3b4c5d6e7f';

/**
 * 深層搜尋的 demo 對話紀錄：40 則，#13 與 #32 提到「手續費 0.1425」，#20 有金鑰（遮蔽模式測試用）。
 * 對話紀錄檢視（sessionTranscript）讀的也是這一份，⌘Enter 捲到 transcriptIndex 才對得上。
 */
function demoDeepTranscript(name: string): TranscriptEntry[] {
  const start = Date.now() - 2 * 60 * 60_000;
  return Array.from({ length: 40 }, (_, index) => {
    const at = new Date(start + index * 60_000).toISOString();
    if (index === 12) {
      return { index, role: 'user', at, text: `${name}：手續費 0.1425 要用哪個設定檔？` };
    }
    if (index === 31) {
      return {
        index,
        role: 'assistant',
        at,
        text: `已把手續費 0.1425 寫進 config/fees.yaml（${name}）。`,
      };
    }
    if (index === 19) {
      return {
        index,
        role: 'tool',
        at,
        text: `→ Bash {"command":"export FEE_TOKEN=${DEMO_SEARCH_KEY}"}`,
      };
    }
    return {
      index,
      role: index % 2 === 0 ? 'user' : 'assistant',
      at,
      text: `${name} step ${index}: refactor and run the tests`,
    };
  });
}

/** 活著的 session 的畫面（demo）：深層搜尋搜這裡（手續費出現在 demo-gpu 的 s-etl）。 */
function demoScreens(): Map<string, string[]> {
  return new Map([
    [
      's-etl',
      ['Plan: 3 steps', '1. Add column', '手續費 0.1425 → config/fees.yaml', '3. Drop old column'],
    ],
    ['s-auth', ['Bash  npm test -- auth', 'Do you want to proceed?']],
  ]);
}

/** s-tests 與已封存的 s-old-resumed 共用的對話 id。 */
const DEMO_SHARED_CONVERSATION = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

/** 已封存的範例（設定頁「已封存」與舊資料頁用）。board 快照不含它們，和 hub 一樣。 */
function demoArchived(): Session[] {
  return [
    session({
      id: 's-old-api',
      name: 'Old API refactor',
      machineId: 'm-studio',
      status: 'done',
      cwd: '/home/demo/api',
      branch: 'ab/old-api',
      worktreePath: '/home/demo/.agent-board-wt/old-api',
      permissionMode: 'acceptEdits',
      model: 'opus',
      claudeSessionId: '0b7c6a52-3f1e-4c2a-9a51-6f2d8e1c4b90',
      createdAt: minutesAgo(3 * 24 * 60),
      endedAt: minutesAgo(2 * 24 * 60 + 30),
      archived: true,
      archivedAt: minutesAgo(2 * 24 * 60),
    }),
    session({
      id: 's-old-shared',
      name: 'Readme pass',
      machineId: 'm-gpu',
      status: 'done',
      branch: 'main',
      claudeSessionId: '7d0e2f44-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
      createdAt: minutesAgo(9 * 24 * 60),
      endedAt: minutesAgo(8 * 24 * 60),
      archived: true,
      archivedAt: minutesAgo(5 * 24 * 60),
    }),
    // Write tests（s-tests）接續了這段對話、也在用同一個 worktree：刪除時兩項都不能清。
    session({
      id: 's-old-resumed',
      name: 'Auth tests draft',
      machineId: 'm-studio',
      status: 'done',
      branch: 'ab/auth-tests',
      worktreePath: '/home/demo/.agent-board-wt/auth-tests',
      claudeSessionId: DEMO_SHARED_CONVERSATION,
      createdAt: minutesAgo(7 * 24 * 60),
      endedAt: minutesAgo(6 * 24 * 60 + 60),
      archived: true,
      archivedAt: minutesAgo(6 * 24 * 60),
    }),
    session({
      id: 's-old-laptop',
      name: 'Nav spike',
      machineId: 'm-laptop',
      status: 'offline',
      cwd: '/home/demo/web',
      branch: 'ab/nav-spike',
      createdAt: minutesAgo(40 * 24 * 60),
      endedAt: minutesAgo(39 * 24 * 60),
      archived: true,
      // schema 3 之前封存的資料沒有封存時間。
      archivedAt: null,
    }),
  ];
}

const DEMO_TOPICS = ['auth', 'billing', 'search', 'upload'];

/** 假對話紀錄：user／assistant／tool 輪流，夠長才測得到「載入更多」。 */
function demoTranscript(): TranscriptEntry[] {
  const start = Date.now() - 3 * DAY_MS;
  return Array.from({ length: 230 }, (_, index) => {
    const topic = DEMO_TOPICS[Math.floor(index / 3) % DEMO_TOPICS.length]!;
    const at = new Date(start + index * 45_000).toISOString();
    const step = Math.floor(index / 3) + 1;
    if (index % 3 === 0) {
      return { index, role: 'user', at, text: `Step ${step}: refactor the ${topic} handler` };
    }
    if (index % 3 === 1) {
      const extra = index === 1 ? '\nexport API_KEY=sk-ant-demo0123456789abcdefXYZ' : '';
      return {
        index,
        role: 'assistant',
        at,
        text: `I'll split the ${topic} handler into smaller functions.${extra}`,
      };
    }
    return {
      index,
      role: 'tool',
      at,
      text: `→ Edit {"file_path":"src/api/${topic}.ts","old_string":"handler(","new_string":"handle${step}("}`,
    };
  });
}

/** 和 hub 一樣的錯誤形狀（status、code），畫面才能分辨。 */
const apiError = (
  status: number,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
) => Object.assign(new Error(message), { status, code, ...(detail ? { detail } : {}) });

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

/** demo 模式的目前密碼，改密碼流程要能走完也要能失敗。 */
export const DEMO_PASSWORD = 'demo-password';

const DAY_MS = 24 * 60 * 60_000;

/** demo-laptop 沒有回報過，畫面要能顯示「還沒回報」。 */
function demoUsage(machineId: string): UsageSummary | null {
  const scale = { 'm-studio': 1, 'm-gpu': 0.4 }[machineId];
  if (scale === undefined) return null;
  const to = Date.now() - 6 * 60_000;
  return {
    machineId,
    from: new Date(to - 30 * DAY_MS).toISOString(),
    to: new Date(to).toISOString(),
    inputTokens: Math.round(184_000 * scale),
    outputTokens: Math.round(1_020_000 * scale),
    cacheReadTokens: Math.round(48_500_000 * scale),
    cacheCreationTokens: Math.round(3_100_000 * scale),
  };
}

function demoAudit(): AuditEntry[] {
  const entry = (
    minutes: number,
    action: string,
    detail: string,
    sessionId: string | null = null,
    userId: string | null = demoUser.id,
  ): AuditEntry => ({
    id: crypto.randomUUID(),
    userId,
    sessionId,
    action,
    detail,
    at: minutesAgo(minutes),
  });
  return [
    entry(2, 'terminal.input', 'npm test -- auth', 's-auth'),
    entry(
      4,
      'approval.decide',
      '{"approvalId":"a-0","behavior":"allow","remember":false}',
      's-tests',
    ),
    entry(9, 'approval.resolved', '{"approvalId":"a-9","by":"terminal"}', 's-etl', null),
    entry(30, 'session.create', '{"name":"Write tests","permissionMode":"acceptEdits"}', 's-tests'),
    entry(55, 'settings.update', 'dangerRules'),
    entry(61, 'auth.login', demoUser.name),
    entry(62, 'auth.login_failed', demoUser.name, null, null),
  ];
}

/**
 * 全域搜尋的範例資料（檔案改動、每回合最後回覆）。只給搜尋用，不放進 sessionEvents：
 * 請隊長拆解、交接動畫讀的事件維持原狀。含一把假金鑰，遮蔽模式的畫面測試用。
 */
export const DEMO_SEARCH_KEY = 'sk-ant-demo03-demoDEMOdemoDEMOdemo0000';
function demoSearchEvents(): SessionEvent[] {
  const event = (
    sessionId: string,
    minutes: number,
    type: string,
    payload: Record<string, unknown>,
  ): SessionEvent => ({
    id: crypto.randomUUID(),
    sessionId,
    type,
    payload,
    at: minutesAgo(minutes),
  });
  const reply = (sessionId: string, minutes: number, text: string) =>
    event(sessionId, minutes, 'hook', { event: 'Stop', last_assistant_message: text });
  return [
    event('s-tests', 3, 'file.changed', {
      path: '/home/demo/.agent-board-wt/auth-tests/src/risk.py',
    }),
    event('s-tests', 5, 'file.changed', {
      path: '/home/demo/.agent-board-wt/auth-tests/src/risk.py',
    }),
    event('s-tests', 8, 'file.changed', {
      path: '/home/demo/.agent-board-wt/auth-tests/tests/auth.test.ts',
    }),
    event('s-docs', 26 * 60, 'file.changed', { path: '/home/demo/project/src/risk.py' }),
    event('s-auth', 15, 'file.changed', {
      path: '/home/demo/.agent-board-wt/fix-auth/src/login.ts',
    }),
    reply('s-etl', 30, '已把手續費 0.1425 寫進設定，下一步回補資料。'),
    reply('s-ml', 50, '手續費改成 0.1425 之後重新訓練；loss 降到 0.41。'),
    reply('s-docs', 70, `部署設定用的 token: ${DEMO_SEARCH_KEY}，已寫進 .env。`),
  ];
}

const csvCell = (value: string | null) => `"${(value ?? '').replaceAll('"', '""')}"`;

const defaultSettings: Settings = {
  listenAddress: '127.0.0.1',
  publicOrigin: null,
  stuckMinutes: DEFAULT_STUCK_MINUTES,
  dangerRules: DEFAULT_DANGER_RULES,
  quotaGuards: {
    denyReadPaths: ['data/', '*.parquet'],
    maxConcurrentSessions: null,
    queueWhenRateLimited: true,
  },
  notifications: { enabled: true, quietHours: null, coalesce: true, waitingLimit: 3 },
  autoContinue: false,
  dispatch: true,
  memory: true,
};

/** 測試可以改掉 demoReply，模擬隊長回了無法解析的內容。 */
export interface FakeBackendControls {
  /** null 模擬隊長這回合失敗（StopFailure）。 */
  demoReply: string | null;
  /** 模擬 daemon 回報的狀態變化。 */
  setSessionStatus(id: string, status: Session['status']): void;
  /** 模擬 hub 改了 session 的其他欄位（statusDetail、autoContinue…）。 */
  patchSession(id: string, patch: Partial<Session>): void;
  /** 模擬 hub 的任務自動執行改了任務（最後一步、退回次數…）。假後端自己不送字、不移欄。 */
  patchTask(id: string, patch: Partial<Task>): void;
  addSessionEvent(sessionId: string, type: string, payload: Record<string, unknown>): void;
  /**
   * 模擬 hub 的交接事件（畫布的交接動畫）。沒給 reason 是交接成功：handoff.fired（排入）
   * 接著 handoff.delivered（送達，記在目標）；queuedOnly 只排入。給了 reason 就是擋下
   * （handoff.blocked），reason 為 rule_disabled 時是取消（handoff.dropped）。
   */
  emitHandoff(
    fromSessionId: string,
    toSessionId: string,
    options?: {
      summary?: string;
      reason?: string;
      queuedOnly?: boolean;
      /** 雙向交接的輪數（hub 對有 maxRounds 的規則才帶）。 */
      round?: number;
      maxRounds?: number;
    },
  ): void;
  /**
   * 模擬 hub 推來的暫停狀態（別的瀏覽器按了暫停、hub 重啟清掉排隊、排隊數變化…）。
   * 只改畫面看到的狀態；假後端自己的排隊交接不受影響。
   */
  setPauseState(pause: BoardPauseState): void;
  /**
   * 模擬 session 裡的 Claude 呼叫 update_progress（P3 項目一）：和 hub 同一套三方比對、鎖定規則。
   * 回傳 hub 會給 Claude 的結果代碼（ok／progress_conflict／card_locked）。
   */
  agentProgress(
    owner: ProgressOwner,
    sessionId: string,
    write: { baseRevision: number } & Partial<Omit<ProgressFields, 'gmNotes'>>,
  ): 'ok' | 'progress_conflict' | 'card_locked';
  /** 測試用：改卡片的自動事實（例如最後一次回合結束的時間）與更新時間。 */
  patchProgress(
    owner: ProgressOwner,
    patch: Partial<Pick<ProgressCard, 'updatedAt'>> & { facts?: Partial<ProgressFacts> },
  ): void;
}

/** 假隊長的回覆，請隊長拆解在 demo 模式下也能走完。帶 role 的照縮寫指派，最後一項沒標。 */
const DEMO_DECOMPOSE_REPLY = `Here is the breakdown:

\`\`\`json
[{"title":"Map the login redirect paths","role":"BD"},{"title":"Write regression tests","role":"LD"},{"title":"Fix the redirect"}]
\`\`\``;

const DEMO_DECOMPOSE_DELAY_MS = 300;

/** 格式正確的 P-256 公鑰，沒有對應私鑰：demo 只走訂閱流程，不會真的送推播。 */
const DEMO_VAPID_PUBLIC_KEY =
  'BGFytsGGh7T9Tx6fiDSmrbB3n0Y_cmHcn6AA6kEE_rz2bzBRefjIZZ2RAGw92MUS2pHU30Zae8RAFRArPZYiDH0';

export function createFakeBackend(): BoardBackend & FakeBackendControls {
  const state = demoSnapshot();
  // 已封存的也放在同一份清單（hub 的資料庫也是），送給畫面時濾掉。
  state.sessions.push(...demoArchived());
  const transcripts = new Map<string, TranscriptEntry[]>([
    ['0b7c6a52-3f1e-4c2a-9a51-6f2d8e1c4b90', demoTranscript()],
    [DEMO_AUTH_CONVERSATION, demoDeepTranscript('Fix login')],
    [DEMO_ETL_CONVERSATION, demoDeepTranscript('Migrate data')],
  ]);
  const screens = demoScreens();
  const pushEndpoints = new Set<string>();
  const projects: Project[] = [];
  /** 假的「建資料夾」：parent → 建過的名稱。 */
  const madeDirs = new Map<string, string[]>();
  const teams: Team[] = [
    {
      id: 'team-demo-auth',
      name: '登入重構',
      goal: 'Fix the login redirect loop and cover it with tests.',
      doneCriteria: 'All auth tests pass and the redirect works on mobile.',
      color: 'teal',
      contextMd: '# Team notes\n\nKeep the session cookie format unchanged.\n',
      taskAuto: false,
      zoneId: DEFAULT_ZONE_ID,
    },
  ];
  /** 工作區（P2 項目二）：和 hub 一樣一開始只有「主要」。 */
  let zones: Zone[] = [
    { id: DEFAULT_ZONE_ID, name: DEFAULT_ZONE_NAME, createdAt: minutesAgo(600), position: 0 },
  ];
  /** 群發（和 hub 一樣只在對象等輸入時送，其他排隊；GM 親手下的，不看暫停）。 */
  let broadcasts: Broadcast[] = [];
  /** 進度卡（和 hub 同一套規則：protocol/progress.ts）：擁有者鍵 → 卡片與歷史。 */
  const progress = new Map<string, { card: ProgressCard; history: ProgressRevision[] }>();
  /** 團隊 Presets（P3 項目二）：和 hub 一樣一開始是空的，照 position 排。 */
  let presets: TeamPreset[] = [];
  const renumberPresets = (list: TeamPreset[]) => list.map((p, i) => ({ ...p, position: i }));
  const presetNameTaken = (name: string, except?: string) =>
    presets.some((p) => p.id !== except && p.name.toLowerCase() === name.trim().toLowerCase());
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
      number: 1,
      rejectCount: 0,
      needsUser: false,
      reviewerSessionId: null,
      auto: null,
    },
    {
      id: 'task-2',
      teamId: 'team-demo-auth',
      title: 'Check mobile Safari',
      ownerSessionId: null,
      column: 'todo',
      number: 2,
      rejectCount: 0,
      needsUser: false,
      reviewerSessionId: null,
      auto: null,
    },
  ];
  /** 假的團隊任務編號（demo 只有一個團隊，從 2 接著發）。 */
  let taskSeq = tasks.length;
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
  const searchEvents = demoSearchEvents();
  const eventListeners = new Set<(event: SessionEvent) => void>();
  const addEvent = (sessionId: string, type: string, payload: Record<string, unknown>) => {
    const event = {
      id: crypto.randomUUID(),
      sessionId,
      type,
      payload,
      at: new Date().toISOString(),
    };
    events.push(event);
    eventListeners.forEach((l) => l(event));
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
  /** 和 hub 相同：移進工作區的卡排到目標工作區現有內容的右側空白（存好的版面，畫布沒開也排）。 */
  const placeInZone = (ids: readonly string[], zoneId: string) => {
    const zoneOf = (id: string) => {
      const s = state.sessions.find((x) => x.id === id);
      return s && !s.archived ? zoneOfSession(s, teams, members) : null;
    };
    const moving = new Set(ids);
    const rows = layouts.filter((l) => l.workspace === CANVAS_LAYOUT_SET);
    const shift = zoneMoveShift(
      rows.filter((l) => moving.has(l.sessionId) && zoneOf(l.sessionId) !== null),
      rows.filter((l) => !moving.has(l.sessionId) && zoneOf(l.sessionId) === zoneId),
    );
    if (!shift) return;
    layouts = layouts.map((l) =>
      l.workspace === CANVAS_LAYOUT_SET && moving.has(l.sessionId)
        ? { ...l, x: l.x + shift.dx, y: l.y + shift.dy }
        : l,
    );
  };
  const templates: Template[] = [];
  const audit = demoAudit();
  const matchAudit = (filter: AuditFilter) =>
    audit
      .filter((e) => !filter.sessionId || e.sessionId === filter.sessionId)
      .filter((e) => !filter.action || e.action === filter.action)
      .filter(
        (e) =>
          !filter.userId ||
          (filter.userId === AUDIT_SYSTEM_USER ? e.userId === null : e.userId === filter.userId),
      )
      .filter((e) => !filter.from || e.at >= filter.from)
      .filter((e) => !filter.to || e.at <= filter.to);
  // 全部暫停（P2 項目三）：和 hub 一樣，暫停中交接只排入不送，繼續時才放出。
  let pause: BoardPauseState = structuredClone(NOT_PAUSED);
  /** 暫停中被擋下的交接（繼續時照順序送達）。 */
  const heldHandoffs: { from: string; to: string; summary: string }[] = [];
  const queuedSessions = () =>
    state.sessions.filter((x) => !x.archived && x.endedAt === null && x.status === 'queued');
  const heldNow = (): BoardHeld => ({
    deliveries: heldHandoffs.length,
    sessions: queuedSessions().filter(machineOnline).length,
    sessionsWaiting: queuedSessions().filter((x) => !machineOnline(x)).length,
    autoContinues: 0,
  });
  const refreshPause = () => {
    pause = { ...pause, held: heldNow() };
  };
  let accountLocale: User['locale'] = demoUser.locale;
  let password = DEMO_PASSWORD;
  const visible = (): BoardSnapshot => ({
    ...state,
    sessions: state.sessions.filter((x) => !x.archived),
    waitingLimit: settings.notifications.waitingLimit,
    zones,
    broadcasts,
    pause,
    progress: [...progress.values()].map((p) => ({ ...p.card, facts: factsOf(p.card) })),
    presets,
  });
  /** 假的送字：打進終端機、對象開始工作。 */
  const typeInto = (s: Session, text: string) => {
    terminal.emit(s.id, `${text}\r\n`);
    s.status = 'running';
    s.statusSince = new Date().toISOString();
  };
  /** 對象變回等輸入：送出排在它身上的第一則群發（一次一則，和 hub 的佇列一樣）。 */
  const deliverQueued = (s: Session) => {
    if (s.status !== 'waiting_input') return;
    for (const b of broadcasts) {
      const target = b.targets.find((t) => t.sessionId === s.id && t.state === 'queued');
      if (!target) continue;
      typeInto(s, b.text);
      broadcasts = broadcasts.map((x) =>
        x.id === b.id
          ? {
              ...x,
              targets: x.targets.map((t) =>
                t === target ? { ...t, state: 'sent', at: new Date().toISOString() } : t,
              ),
            }
          : x,
      );
      return;
    }
  };
  const publish = () => listeners.forEach((l) => l(visible()));
  /** 群發與進度卡送字共用（和 hub 的 BroadcastEngine.start 一樣：等輸入的送出，其他排隊）。 */
  const startBroadcast = (
    head: Pick<Broadcast, 'teamId' | 'kind' | 'cardKey' | 'text' | 'mentioned'>,
    chosen: Session[],
    action: string,
  ): Broadcast => {
    const now = new Date().toISOString();
    const busy = new Set<string>();
    const broadcast: Broadcast = {
      id: crypto.randomUUID(),
      ...head,
      by: demoUser.id,
      byName: demoUser.name,
      at: now,
      boardPaused: pause.paused !== null,
      targets: chosen.map((s) => {
        const gone = s.archived || s.endedAt !== null || s.status === 'done';
        const ready = !gone && s.status === 'waiting_input' && !busy.has(s.id);
        if (ready) {
          typeInto(s, head.text);
          busy.add(s.id);
        }
        return {
          sessionId: s.id,
          name: s.name,
          state: gone ? 'skipped' : ready ? 'sent' : 'queued',
          reason: gone ? (s.archived ? 'archived' : 'ended') : null,
          at: now,
        };
      }),
    };
    broadcasts = [...broadcasts, broadcast];
    for (const t of broadcast.targets) {
      audit.unshift({
        id: crypto.randomUUID(),
        userId: demoUser.id,
        sessionId: t.sessionId,
        action,
        detail: JSON.stringify({
          teamId: head.teamId,
          broadcastId: broadcast.id,
          text: head.text,
          state: t.state,
        }),
        at: now,
      });
    }
    publish();
    return broadcast;
  };
  const userActor: ProgressActor = { kind: 'user', id: demoUser.id, name: demoUser.name };
  /** 和 hub 相同的自動事實（假資料：任務板、成員狀態；檔案改動與回合結束由測試用 patchProgress 給）。 */
  const factOverrides = new Map<string, Partial<ProgressFacts>>();
  const factsOf = (card: Pick<ProgressCard, 'teamId' | 'sessionId'>): ProgressFacts => {
    const owner = progressOwnerOf(card);
    const ids =
      'teamId' in owner
        ? members.filter((m) => m.teamId === owner.teamId).map((m) => m.sessionId)
        : [owner.sessionId];
    const teamTasks = 'teamId' in owner ? tasks.filter((t) => t.teamId === owner.teamId) : null;
    const team = 'teamId' in owner ? teams.find((t) => t.id === owner.teamId) : undefined;
    return {
      ...EMPTY_PROGRESS_FACTS,
      teamName: team?.name ?? null,
      tasks: teamTasks && {
        done: teamTasks.filter((t) => t.column === 'done').length,
        total: teamTasks.length,
        doing: teamTasks.filter((t) => t.column === 'doing').map((t) => `#${t.number} ${t.title}`),
      },
      phase: team?.phase ?? null,
      members: ids.flatMap((id) => {
        const s = state.sessions.find((x) => x.id === id);
        return s && !s.archived
          ? [
              {
                sessionId: s.id,
                name: s.name,
                role:
                  'teamId' in owner
                    ? (members.find((m) => m.teamId === owner.teamId && m.sessionId === id)?.role ??
                      null)
                    : null,
                status: s.status,
                statusDetail: s.statusDetail,
                ended: s.endedAt !== null,
              },
            ]
          : [];
      }),
      ...factOverrides.get(progressOwnerKey(owner)),
    };
  };
  const progressCard = (owner: ProgressOwner): ProgressCard => {
    const found = progress.get(progressOwnerKey(owner));
    return found
      ? { ...found.card, facts: factsOf(found.card) }
      : emptyProgressCard(owner, factsOf(emptyProgressCard(owner)));
  };
  /** 和 hub 的 ProgressEngine.writeCore 同一套：清理 → 上限 → 鎖定（只擋 agent）→ 三方比對 → 寫入、歷史 50 版。 */
  const writeProgress = (
    owner: ProgressOwner,
    write: ProgressWrite,
    by: ProgressActor,
    source: ProgressRevision['source'],
  ): ProgressCard => {
    const key = progressOwnerKey(owner);
    const entry = progress.get(key) ?? { card: emptyProgressCard(owner), history: [] };
    const current = entry.card;
    const patch: Partial<ProgressFields> = {};
    for (const f of PROGRESS_FIELDS) {
      const value = write[f];
      if (value !== undefined) patch[f] = cleanProgressText(value);
    }
    const tooLong = overLimit(patch);
    if (tooLong.length > 0)
      throw apiError(400, 'field_too_long', `Too long: ${tooLong.join(', ')}`);
    if (by.kind === 'session' && current.locked) throw apiError(409, 'card_locked', 'Locked');
    if (write.baseRevision > current.revision) throw apiError(400, 'invalid_revision', 'Ahead');
    const plan = planProgressWrite(current, write.baseRevision, patch);
    if (plan.conflicts.length > 0) {
      const conflict: ProgressConflict = {
        card: progressCard(owner),
        fields: plan.conflicts.map((field) => {
          const last = entry.history.find((r) => r.revision === current.fieldRevisions[field]);
          return {
            field,
            base:
              write.baseRevision === 0
                ? ''
                : (entry.history.find((r) => r.revision === write.baseRevision)?.fields[field] ??
                  null),
            current: current[field],
            by: last?.by ?? null,
          };
        }),
      };
      throw apiError(409, 'progress_conflict', 'Conflict', conflict as never);
    }
    let next: ProgressCard = { ...current };
    if (by.kind === 'user' && write.locked !== undefined) next.locked = write.locked;
    if (plan.changed.length > 0) {
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      const fieldRevisions = { ...current.fieldRevisions };
      for (const f of plan.changed) fieldRevisions[f] = revision;
      next = {
        ...next,
        ...patch,
        id: current.id ?? crypto.randomUUID(),
        revision,
        fieldRevisions,
        updatedAt: now,
        updatedBy: by,
      };
      const fields = {
        status: next.status,
        next: next.next,
        blockers: next.blockers,
        gmNotes: next.gmNotes,
      };
      entry.history = [{ revision, fields, by, source, at: now }, ...entry.history].slice(
        0,
        PROGRESS_HISTORY_KEEP,
      );
    } else if (next.id === null) {
      next.id = crypto.randomUUID();
    }
    progress.set(key, { ...entry, card: next });
    publish();
    return { ...next, facts: factsOf(next), ...(plan.merged ? { merged: true } : {}) };
  };
  const machineOnline = (s: Session) =>
    state.machines.find((m) => m.id === s.machineId)?.online ?? false;
  const hooksShared = (s: Session) =>
    state.sessions.some((x) => x.id !== s.id && x.machineId === s.machineId && x.cwd === s.cwd);
  // 和 hub 相同（CONTRACTS §9.6）：同機器另一個 session 用同一個 worktree（或 cwd 在裡面）、
  // 同機器同帳號另一個 session 記著同一段對話。
  const worktreeShared = (s: Session) =>
    s.worktreePath !== null &&
    state.sessions.some(
      (x) =>
        x.id !== s.id &&
        x.machineId === s.machineId &&
        (x.worktreePath === s.worktreePath || x.cwd.startsWith(`${s.worktreePath}/`)),
    );
  const transcriptShared = (s: Session) =>
    s.claudeSessionId !== null &&
    state.sessions.some(
      (x) =>
        x.id !== s.id &&
        x.machineId === s.machineId &&
        x.accountProfile === s.accountProfile &&
        x.claudeSessionId === s.claudeSessionId,
    );
  /** 範例 s-old-api 的 worktree 有沒 commit、沒 push、沒合併的東西，刪除確認框要警告。 */
  const inspectOf = (s: Session): SessionInspect => {
    const messy = s.id === 's-old-api';
    return {
      transcriptBytes: s.claudeSessionId
        ? transcripts.has(s.claudeSessionId)
          ? 1_843_200
          : null
        : s.id.startsWith('s-old')
          ? null
          : 348_160,
      git: {
        dir: s.worktreePath ?? s.cwd,
        dirtyFiles: messy ? 2 : 0,
        unpushedCommits: messy ? 1 : s.branch ? 0 : null,
        branch: s.branch,
        unmergedCommits: s.worktreePath ? (messy ? 3 : 0) : null,
      },
      worktreeExists: s.worktreePath !== null,
      hooksShared: hooksShared(s),
      worktreeShared: worktreeShared(s),
      transcriptShared: transcriptShared(s),
    };
  };
  const find = (id: string) => {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  };

  return {
    terminal,
    watchBoard(listener) {
      listeners.add(listener);
      listener(visible());
      return () => listeners.delete(listener);
    },
    watchEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
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
    currentUser: async () => ({ ...demoUser, locale: accountLocale }),
    setup: async () => ({ ...demoUser, locale: accountLocale }),
    login: async () => ({ ...demoUser, locale: accountLocale }),
    logout: async () => {},
    async changePassword({ currentPassword, password: next }) {
      // 和 hub 一樣的錯誤形狀（status、code），畫面才能分辨。
      if (currentPassword !== password) {
        throw Object.assign(new Error('Current password is incorrect'), {
          status: 403,
          code: 'invalid_current_password',
        });
      }
      password = next;
    },
    async saveLocale(locale) {
      accountLocale = locale;
    },
    async createSession(input) {
      // 假的 worktree：和 daemon 一樣放在 .agent-board-wt/ 底下、分支 ab/<名稱>，建立團隊時看得出誰有自己的 worktree。
      const slug = input.name.replace(/[^\w.-]+/g, '-');
      const created = session({
        id: crypto.randomUUID(),
        name: input.name,
        machineId: input.machineId,
        status: 'starting',
        cwd: input.cwd,
        worktreePath: input.useWorktree ? `/home/demo/.agent-board-wt/${slug}` : null,
        branch: input.useWorktree ? `ab/${slug}` : 'main',
        readOnly: input.readOnly,
        permissionMode: input.permissionMode,
        model: input.model,
        projectId: input.projectId,
        zoneId: input.zoneId ?? DEFAULT_ZONE_ID,
      });
      state.sessions = [...state.sessions, created];
      // 和 hub 相同：第一個指令也是送進終端機的輸入，記一筆 terminal.input。
      if (input.firstPrompt !== null) {
        audit.unshift({
          id: crypto.randomUUID(),
          userId: demoUser.id,
          sessionId: created.id,
          action: 'terminal.input',
          detail: input.firstPrompt,
          at: new Date().toISOString(),
        });
      }
      publish();
      return created;
    },
    async updateSession(id, patch) {
      const s = find(id);
      if (patch.name) s.name = patch.name;
      if (patch.zoneId) {
        if (!zones.some((z) => z.id === patch.zoneId)) {
          throw apiError(400, 'unknown_zone', 'Unknown workspace');
        }
        const moved = s.zoneId !== patch.zoneId && !members.some((m) => m.sessionId === id);
        s.zoneId = patch.zoneId;
        if (moved) placeInZone([id], patch.zoneId);
      }
      if (patch.archived === true && !s.archived) {
        // 和 hub 相同（CONTRACTS §9.1）：還沒結束的先停掉，相關交接規則全部關掉。
        const stopped = s.endedAt === null && !['done', 'error', 'offline'].includes(s.status);
        if (stopped) s.status = 'done';
        if (s.endedAt === null) s.endedAt = new Date().toISOString();
        const paused = rules.filter(
          (r) => r.enabled && (r.fromSessionId === id || r.action.toSessionId === id),
        );
        for (const rule of paused) rule.enabled = false;
        s.archived = true;
        s.archivedAt = new Date().toISOString();
        audit.unshift({
          id: crypto.randomUUID(),
          userId: demoUser.id,
          sessionId: id,
          action: 'session.archive',
          detail: JSON.stringify({ stopped, rulesPaused: paused.length }),
          at: new Date().toISOString(),
        });
      } else if (patch.archived === false && s.archived) {
        s.archived = false;
        s.archivedAt = null;
        audit.unshift({
          id: crypto.randomUUID(),
          userId: demoUser.id,
          sessionId: id,
          action: 'session.restore',
          detail: '',
          at: new Date().toISOString(),
        });
      }
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
    async resumeSession(id) {
      const s = find(id);
      if (s.endedAt === null) throw apiError(409, 'session_active', 'Session is still active');
      if (!s.claudeSessionId) {
        throw apiError(409, 'no_claude_session', 'Session has no Claude conversation to resume');
      }
      if (!state.machines.find((m) => m.id === s.machineId)?.online) {
        throw apiError(409, 'machine_offline', 'Machine is offline');
      }
      // 和 hub 一樣：已封存的自動還原，狀態回到啟動中。
      s.archived = false;
      s.archivedAt = null;
      s.endedAt = null;
      s.status = 'starting';
      s.statusSince = new Date().toISOString();
      publish();
      return { ...s };
    },
    listArchivedSessions: async () =>
      state.sessions.filter((x) => x.archived).map((x) => ({ ...x })),
    async inspectSession(id) {
      const s = find(id);
      if (!machineOnline(s)) throw apiError(409, 'machine_offline', 'Machine is offline');
      return inspectOf(s);
    },
    async sessionTranscript(id, { cursor = 0, limit = 100, q }) {
      const s = find(id);
      if (!machineOnline(s)) throw apiError(409, 'machine_offline', 'Machine is offline');
      const all = s.claudeSessionId ? transcripts.get(s.claudeSessionId) : undefined;
      if (!all) {
        return { entries: [], total: 0, matched: null, nextCursor: null, missing: true };
      }
      const needle = q?.trim().toLowerCase();
      const list = needle ? all.filter((e) => e.text.toLowerCase().includes(needle)) : all;
      const end = cursor + limit;
      return {
        entries: list.slice(cursor, end),
        total: all.length,
        matched: needle ? list.length : null,
        nextCursor: end < list.length ? end : null,
        missing: false,
      };
    },
    async deleteSession(id, options) {
      const s = find(id);
      if (!s.archived) throw apiError(409, 'not_archived', 'Archive the session first');
      if (s.endedAt === null) throw apiError(409, 'session_active', 'The session is still running');
      const any = options.removeWorktree || options.removeTranscript || options.removeHooks;
      if (any && !machineOnline(s)) throw apiError(409, 'machine_offline', 'Machine is offline');
      if (options.removeWorktree && worktreeShared(s)) {
        throw apiError(409, 'worktree_shared', 'Another session uses this worktree');
      }
      if (options.removeTranscript && transcriptShared(s)) {
        throw apiError(409, 'transcript_shared', 'Another session resumed this conversation');
      }
      if (options.removeHooks && hooksShared(s)) {
        throw apiError(409, 'hooks_shared', 'Another session uses the same folder');
      }
      const skipped: PurgeOutcome = { status: 'skipped', detail: null };
      const inspect = inspectOf(s);
      const worktree: PurgeOutcome = !options.removeWorktree
        ? skipped
        : s.worktreePath === null
          ? { status: 'not_found', detail: null }
          : (inspect.git?.dirtyFiles ?? 0) > 0
            ? { status: 'kept', detail: `${inspect.git?.dirtyFiles} uncommitted files` }
            : { status: 'removed', detail: null };
      const transcript: PurgeOutcome = !options.removeTranscript
        ? skipped
        : inspect.transcriptBytes === null
          ? { status: 'not_found', detail: null }
          : { status: 'removed', detail: null };
      const hooks: PurgeOutcome = options.removeHooks
        ? { status: 'removed', detail: null }
        : skipped;
      const result = { worktree, transcript, hooks };
      if (s.claudeSessionId && transcript.status === 'removed')
        transcripts.delete(s.claudeSessionId);
      removeFrom(state.sessions, (x) => x.id === id);
      removeFrom(members, (x) => x.sessionId === id);
      removeFrom(rules, (x) => x.fromSessionId === id);
      layouts = layouts.filter((l) => l.sessionId !== id);
      audit.unshift({
        id: crypto.randomUUID(),
        userId: demoUser.id,
        sessionId: id,
        action: 'session.delete',
        detail: JSON.stringify({ name: s.name, cwd: s.cwd, machineId: s.machineId, result }),
        at: new Date().toISOString(),
      });
      publish();
      return result;
    },
    async pauseBoard(mode) {
      const interrupted: BoardInterruptResult[] = [];
      if (mode === 'interrupt') {
        for (const x of state.sessions) {
          if (x.archived || x.endedAt !== null) continue;
          // demo 的失聯 session（s-web）斷線前在跑：和 hub 一樣列為「沒送到：失聯」。
          if (x.status === 'offline') {
            interrupted.push({ sessionId: x.id, name: x.name, result: 'offline' });
          } else if (x.status === 'running') {
            interrupted.push({ sessionId: x.id, name: x.name, result: 'requested' });
            // Esc 中斷回合：回到等輸入（Q8：之後不自動送「繼續」）。
            x.status = 'waiting_input';
            terminal.emit(x.id, '\r\n[Interrupted by user]\r\n');
            // 和 hub 一樣：daemon 確認送出 Esc 的每個 session 各記一筆 terminal.signal（規格 §3.6 第 5 條）。
            audit.unshift({
              id: crypto.randomUUID(),
              userId: demoUser.id,
              sessionId: x.id,
              action: 'terminal.signal',
              detail: 'escape',
              at: new Date().toISOString(),
            });
          }
        }
      }
      pause = {
        paused: {
          mode,
          since: pause.paused?.since ?? new Date().toISOString(),
          by: demoUser.id,
          byName: demoUser.name,
          clearedOnRestart: pause.paused?.clearedOnRestart ?? 0,
        },
        held: heldNow(),
      };
      audit.unshift({
        id: crypto.randomUUID(),
        userId: demoUser.id,
        sessionId: null,
        action: 'board.pause',
        detail: JSON.stringify({ mode, interrupted }),
        at: new Date().toISOString(),
      });
      publish();
      return { state: pause, interrupted };
    },
    async resumeBoard() {
      if (!pause.paused) return { state: pause, released: heldNow() };
      const released = { ...pause.held };
      pause = { paused: null, held: heldNow() };
      // 放出排隊的交接（只解除閘門，不對被中斷的 session 送「繼續」，Q8）。
      for (const h of heldHandoffs.splice(0)) {
        terminal.emit(h.to, `[Handoff] Summary: ${h.summary}\r\n`);
        addEvent(h.to, 'handoff.delivered', {
          ruleId: null,
          fromSessionId: h.from,
          toSessionId: h.to,
          summary: h.summary,
        });
      }
      refreshPause();
      audit.unshift({
        id: crypto.randomUUID(),
        userId: demoUser.id,
        sessionId: null,
        action: 'board.resume',
        detail: JSON.stringify({ released }),
        at: new Date().toISOString(),
      });
      publish();
      return { state: pause, released };
    },
    setPauseState(next) {
      pause = structuredClone(next);
      publish();
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
    patchTask(id, patch) {
      Object.assign(findIn(tasks, id, 'task'), patch);
    },
    setSessionStatus(id, status) {
      const s = find(id);
      s.status = status;
      deliverQueued(s);
      publish();
    },
    patchSession(id, patch) {
      Object.assign(find(id), patch);
      publish();
    },
    addSessionEvent: addEvent,
    emitHandoff(fromSessionId, toSessionId, options = {}) {
      const rule = rules.find(
        (r) => r.fromSessionId === fromSessionId && r.action.toSessionId === toSessionId,
      );
      const { reason, summary = 'Fixed the login redirect and added a regression test.' } = options;
      const rounds =
        options.round !== undefined && options.maxRounds !== undefined
          ? { round: options.round, maxRounds: options.maxRounds }
          : {};
      const type =
        reason === undefined
          ? 'handoff.fired'
          : reason === 'rule_disabled'
            ? 'handoff.dropped'
            : 'handoff.blocked';
      addEvent(fromSessionId, type, {
        ruleId: rule?.id ?? null,
        trigger: rule?.trigger ?? 'on_done',
        fromSessionId,
        toSessionId,
        ...(type === 'handoff.dropped' ? {} : { summary }),
        ...(reason === undefined ? {} : { reason }),
        ...rounds,
      });
      // 全部暫停中：排入但不送（board.held），繼續時才送達。
      if (reason === undefined && pause.paused) {
        heldHandoffs.push({ from: fromSessionId, to: toSessionId, summary });
        refreshPause();
        publish();
        return;
      }
      // 和 hub 一樣：送達記在目標上。queuedOnly 模擬目標還在忙、只排入。
      if (reason === undefined && !options.queuedOnly) {
        addEvent(toSessionId, 'handoff.delivered', {
          ruleId: rule?.id ?? null,
          fromSessionId,
          toSessionId,
          summary,
          ...rounds,
        });
      }
    },
    async decideApproval(approval: Approval) {
      state.approvals = state.approvals.filter((a) => a.id !== approval.id);
      find(approval.sessionId).status = 'running';
      publish();
    },
    listProjects: async () => [...projects],
    async createProject(input) {
      const project = { ...input, id: crypto.randomUUID() };
      projects.push(project);
      return project;
    },
    listTemplates: async () => templates,
    async saveTemplate(input) {
      const t = { ...input, id: crypto.randomUUID() };
      templates.push(t);
      return t;
    },
    browseDirectory: async (_machineId, path) => {
      // 假的「資料夾不存在」：路徑裡有 does-not-exist（和 daemon 讀不到資料夾一樣回 fs_error）。
      if (path.includes('does-not-exist')) {
        throw apiError(400, 'fs_error', `ENOENT: no such file or directory, scandir '${path}'`);
      }
      return {
        path,
        entries: [
          { name: 'project', isDir: true, isGitRepo: true },
          { name: 'notes', isDir: true, isGitRepo: false },
          ...(madeDirs.get(path) ?? []).map((name) => ({ name, isDir: true, isGitRepo: false })),
        ],
      };
    },
    async makeDirectory(_machineId, parent, name) {
      const list = madeDirs.get(parent) ?? [];
      if (list.includes(name) || ['project', 'notes'].includes(name)) {
        throw new Error(`EEXIST: file already exists, mkdir '${parent}/${name}'`);
      }
      madeDirs.set(parent, [...list, name]);
      return { path: `${parent.replace(/\/+$/, '')}/${name}`, entries: [] };
    },
    createPairingCode: async () => ({
      code: 'DEMO-0000',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      installCommand: 'agent-board-daemon pair DEMO-0000',
    }),
    async removeMachine(id) {
      state.machines = state.machines.filter((m) => m.id !== id);
      publish();
    },
    machineUsage: async (machineId) => demoUsage(machineId),
    getLayouts: async () => layouts,
    async saveLayouts(next) {
      layouts = next;
    },
    getNotes: async () => [],
    getSettings: async () => settings,
    async updateSettings(patch) {
      settings = { ...settings, ...patch };
      // hub 會把新的上限廣播給每個人（board.waitingLimit）。
      publish();
      return settings;
    },
    pushVapidKey: async () => DEMO_VAPID_PUBLIC_KEY,
    async pushSubscribe(subscription) {
      pushEndpoints.add(subscription.endpoint);
    },
    async pushUnsubscribe(endpoint) {
      pushEndpoints.delete(endpoint);
    },
    async listAudit(filter) {
      // 和 hub 的 store.listAudit 相同：完全相符、時間含兩端、由新到舊。
      return matchAudit(filter)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, filter.limit ?? 100);
    },
    async exportAudit(filter = {}) {
      // 和 hub 相同：同一組篩選、沒有筆數上限、由舊到新。
      const header = 'id,at,user_id,session_id,action,detail';
      const rows = matchAudit(filter)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((e) => [e.id, e.at, e.userId, e.sessionId, e.action, e.detail].map(csvCell).join(','));
      return new Blob([`\uFEFF${[header, ...rows].join('\r\n')}\r\n`], { type: 'text/csv' });
    },

    listTeams: async () => teams.map((x) => ({ ...x })),
    async createTeam(input) {
      const team = {
        ...input,
        taskAuto: input.taskAuto ?? false,
        zoneId: input.zoneId ?? DEFAULT_ZONE_ID,
        id: crypto.randomUUID(),
      };
      teams.push(team);
      return team;
    },
    async updateTeam(id, patch) {
      if (patch.zoneId && !zones.some((z) => z.id === patch.zoneId)) {
        throw apiError(400, 'unknown_zone', 'Unknown workspace');
      }
      const team = findIn(teams, id, 'team');
      const moved = patch.zoneId !== undefined && patch.zoneId !== team.zoneId;
      Object.assign(team, patch);
      if (moved) {
        placeInZone(
          members.filter((m) => m.teamId === id).map((m) => m.sessionId),
          team.zoneId,
        );
      }
      return team;
    },
    async deleteTeam(id) {
      // 和 hub 一樣：成員留在團隊原本的工作區。
      const team = findIn(teams, id, 'team');
      for (const m of members.filter((x) => x.teamId === id)) {
        const s = state.sessions.find((x) => x.id === m.sessionId);
        if (s) s.zoneId = team.zoneId;
      }
      removeFrom(teams, (x) => x.id === id);
      removeFrom(members, (x) => x.teamId === id);
      removeFrom(tasks, (x) => x.teamId === id);
      removeFrom(rules, (x) => x.teamId === id);
    },
    listTeamMembers: async (teamId) => members.filter((x) => x.teamId === teamId),
    async putTeamMember(teamId, sessionId, role, kind) {
      // 和 hub 相同：沒帶 kind 時保留原本的。
      const before = members.find((x) => x.teamId === teamId && x.sessionId === sessionId);
      const keep = kind ?? before?.kind;
      const member: TeamMember = { teamId, sessionId, role, ...(keep ? { kind: keep } : {}) };
      removeFrom(members, (x) => x.teamId === teamId && x.sessionId === sessionId);
      members.push(member);
      return member;
    },
    async deleteTeamMember(teamId, sessionId) {
      removeFrom(members, (x) => x.teamId === teamId && x.sessionId === sessionId);
      const s = state.sessions.find((x) => x.id === sessionId);
      const team = teams.find((x) => x.id === teamId);
      if (s && team && !members.some((m) => m.sessionId === sessionId)) {
        s.zoneId = team.zoneId;
        publish();
      }
    },
    async broadcastToTeam(teamId, text, targets) {
      const ids = members.filter((m) => m.teamId === teamId).map((m) => m.sessionId);
      const strangers = (targets ?? []).filter((id) => !ids.includes(id));
      if (strangers.length > 0) throw apiError(400, 'not_member', 'Not members of this team');
      const chosen = (targets ?? ids).flatMap((id) => {
        const s = state.sessions.find((x) => x.id === id);
        return s && (targets !== undefined || !s.archived) ? [s] : [];
      });
      if (chosen.length === 0) throw apiError(400, 'no_targets', 'No members to send to');
      return startBroadcast(
        { teamId, kind: 'team', cardKey: null, text, mentioned: targets !== undefined },
        chosen,
        'team.broadcast',
      );
    },
    async getProgress(owner) {
      return progressCard(owner);
    },
    async saveProgress(owner, body) {
      return writeProgress(owner, body, userActor, 'web');
    },
    async progressRevisions(owner) {
      return progress.get(progressOwnerKey(owner))?.history ?? [];
    },
    async restoreProgress(owner, revision) {
      const entry = progress.get(progressOwnerKey(owner));
      const old = entry?.history.find((r) => r.revision === revision);
      if (!entry || !old) throw apiError(404, 'not_found', 'Progress revision not found');
      return writeProgress(
        owner,
        { ...old.fields, baseRevision: entry.card.revision },
        userActor,
        'restore',
      );
    },
    async deliverProgress(owner, sessionId) {
      const target = state.sessions.find((x) => x.id === sessionId);
      if (!target) throw apiError(404, 'not_found', 'Session not found');
      const card = progressCard(owner);
      const name =
        'teamId' in owner
          ? (teams.find((t) => t.id === owner.teamId)?.name ?? '')
          : (state.sessions.find((x) => x.id === owner.sessionId)?.name ?? '');
      const line = progressLine(name, card);
      if (line === null) throw apiError(400, 'progress_empty', 'Nothing to send');
      return startBroadcast(
        {
          teamId: 'teamId' in owner ? owner.teamId : null,
          kind: 'progress',
          cardKey: progressOwnerKey(owner),
          text: line,
          mentioned: true,
        },
        [target],
        'progress.deliver',
      );
    },
    async askProgressUpdate(teamId) {
      const lead = members
        .filter((m) => m.teamId === teamId && m.role === 'lead')
        .map((m) => state.sessions.find((x) => x.id === m.sessionId))
        .find((x) => x && !x.archived);
      if (!lead) throw apiError(400, 'no_lead', 'This team has no lead');
      return startBroadcast(
        {
          teamId,
          kind: 'ask_update',
          cardKey: progressOwnerKey({ teamId }),
          text: PROGRESS_ASK_UPDATE_PROMPT,
          mentioned: true,
        },
        [lead],
        'progress.ask_update',
      );
    },
    agentProgress(owner, sessionId, write) {
      const s = find(sessionId);
      try {
        writeProgress(owner, write, { kind: 'session', id: s.id, name: s.name }, 'mcp');
        return 'ok';
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'progress_conflict' || code === 'card_locked') return code;
        throw e;
      }
    },
    patchProgress(owner, patch) {
      const key = progressOwnerKey(owner);
      if (patch.facts) factOverrides.set(key, { ...factOverrides.get(key), ...patch.facts });
      const entry = progress.get(key);
      if (entry && patch.updatedAt !== undefined) {
        entry.card = { ...entry.card, updatedAt: patch.updatedAt };
      }
      publish();
    },
    async cancelBroadcast(broadcastId, sessionId) {
      const b = findIn(broadcasts, broadcastId, 'broadcast');
      const next: Broadcast = {
        ...b,
        targets: b.targets.map((t) =>
          t.sessionId === sessionId && t.state === 'queued'
            ? { ...t, state: 'cancelled', at: new Date().toISOString() }
            : t,
        ),
      };
      broadcasts = broadcasts.map((x) => (x.id === broadcastId ? next : x));
      publish();
      return next;
    },
    async createZone(name) {
      const zone: Zone = {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        position: Math.max(...zones.map((z) => z.position)) + 1,
      };
      zones = [...zones, zone];
      publish();
      return zone;
    },
    async renameZone(id, name) {
      const zone = { ...findIn(zones, id, 'zone'), name: name.trim() };
      zones = zones.map((z) => (z.id === id ? zone : z));
      publish();
      return zone;
    },
    async deleteZone(id) {
      findIn(zones, id, 'zone');
      if (zones.length <= 1)
        throw apiError(409, 'last_zone', 'The last workspace cannot be deleted');
      const memberIds = new Set(members.map((m) => m.sessionId));
      const teamCount = teams.filter((t) => t.zoneId === id).length;
      const sessionCount = state.sessions.filter(
        (s) => s.zoneId === id && !s.archived && !memberIds.has(s.id),
      ).length;
      if (teamCount > 0 || sessionCount > 0) {
        throw apiError(409, 'zone_not_empty', `teams=${teamCount}, sessions=${sessionCount}`);
      }
      zones = zones.filter((z) => z.id !== id);
      const fallback = zones[0]!.id;
      for (const s of state.sessions) if (s.zoneId === id) s.zoneId = fallback;
      publish();
    },
    listTeamPresets: async () => presets.map((p) => structuredClone(p)),
    async createTeamPreset({ name, config, position }) {
      if (presetNameTaken(name)) {
        throw apiError(409, 'preset_name_taken', `A preset named "${name.trim()}" already exists`);
      }
      const now = new Date().toISOString();
      const preset: TeamPreset = {
        id: crypto.randomUUID(),
        name: name.trim(),
        config: TeamPresetConfig.parse(config),
        position: presets.length,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      };
      const list = [...presets];
      list.splice(Math.min(position ?? list.length, list.length), 0, preset);
      presets = renumberPresets(list);
      publish();
      return presets.find((p) => p.id === preset.id)!;
    },
    async updateTeamPreset(id, patch) {
      const current = findIn(presets, id, 'preset');
      if (patch.name !== undefined && presetNameTaken(patch.name, id)) {
        throw apiError(
          409,
          'preset_name_taken',
          `A preset named "${patch.name.trim()}" already exists`,
        );
      }
      const next: TeamPreset = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.config !== undefined ? { config: TeamPresetConfig.parse(patch.config) } : {}),
        updatedAt: new Date().toISOString(),
      };
      const list = presets.filter((p) => p.id !== id);
      list.splice(Math.min(patch.position ?? current.position, list.length), 0, next);
      presets = renumberPresets(list);
      publish();
      return presets.find((p) => p.id === id)!;
    },
    async deleteTeamPreset(id) {
      findIn(presets, id, 'preset');
      presets = renumberPresets(presets.filter((p) => p.id !== id));
      publish();
    },
    async teamPresetUsed(id, result) {
      const preset = findIn(presets, id, 'preset');
      const now = new Date().toISOString();
      if (result.created > 0) {
        presets = presets.map((p) => (p.id === id ? { ...p, lastUsedAt: now } : p));
      }
      audit.unshift({
        id: crypto.randomUUID(),
        userId: demoUser.id,
        sessionId: null,
        action: 'preset.apply',
        detail: JSON.stringify({ presetId: id, name: preset.name, ...result }),
        at: now,
      });
      publish();
      return presets.find((p) => p.id === id)!;
    },
    listTasks: async (teamId) => tasks.filter((x) => x.teamId === teamId).map((x) => ({ ...x })),
    async createTask(teamId, input) {
      taskSeq += 1;
      const task: Task = {
        ...input,
        id: crypto.randomUUID(),
        teamId,
        column: 'todo',
        number: taskSeq,
        rejectCount: 0,
        needsUser: false,
        reviewerSessionId: null,
        auto: null,
      };
      tasks.push(task);
      return task;
    },
    async updateTask(id, patch) {
      const task = findIn(tasks, id, 'task');
      const next = { ...task, ...patch };
      // 和 hub 相同的規則（hub.ts updateTask）：移欄或換負責人就清掉「等你決定」與最後一步。
      if (next.column !== 'todo' && next.ownerSessionId === null) {
        throw new Error('Assign the task before moving it');
      }
      if (next.column !== task.column || next.ownerSessionId !== task.ownerSessionId) {
        Object.assign(next, { needsUser: false, auto: null });
      }
      return Object.assign(task, next);
    },
    async deleteTask(id) {
      removeFrom(tasks, (x) => x.id === id);
    },
    listHandoffRules: async (teamId) =>
      rules.filter((x) => x.teamId === teamId).map((x) => ({ ...x })),
    async createHandoffRule(teamId, input) {
      // 和 hub 相同的檢查（rest.ts checkRule）。
      if (handoffRuleProblem(input)) throw new Error('on_marker rules need action.marker');
      const rule = { ...input, id: crypto.randomUUID(), teamId };
      rules.push(rule);
      return rule;
    },
    async updateHandoffRule(id, patch) {
      const rule = findIn(rules, id, 'rule');
      if (handoffRuleProblem({ ...rule, ...patch })) {
        throw new Error('on_marker rules need action.marker');
      }
      return Object.assign(rule, patch);
    },
    async deleteHandoffRule(id) {
      removeFrom(rules, (x) => x.id === id);
    },
    sessionEvents: async (sessionId) => events.filter((x) => x.sessionId === sessionId),
    search: async (query) =>
      fakeSearch(query, {
        sessions: state.sessions,
        events: [...searchEvents, ...events],
        teams,
        members,
        tasks,
        audit,
        progress: [...progress.values()].map((p) => p.card),
        role: demoUser.role,
        now: Date.now(),
      }),
    deepSearch: (request, listener) =>
      fakeDeepSearch(
        request,
        {
          sessions: state.sessions,
          teams,
          members,
          machines: state.machines,
          transcripts,
          screens,
          now: Date.now(),
        },
        listener,
      ),
  };
}
