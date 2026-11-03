// 畫面只透過這個介面存取資料。Phase 1 接 fakeBackend，Phase 2 由 Lead 接真 hub。
import type {
  Approval,
  ApprovalDecision,
  HandoffRule,
  Layout,
  Machine,
  Note,
  Project,
  ResourceSample,
  Session,
  SessionEvent,
  SessionSpec,
  Settings,
  Task,
  Team,
  TeamMember,
  Template,
  User,
} from '@agent-board/protocol';
import type { TerminalStream } from './terminal-contract';

export interface BoardSnapshot {
  machines: Machine[];
  sessions: Session[];
  approvals: Approval[];
}

export type BoardListener = (snapshot: BoardSnapshot) => void;

export interface BoardBackend {
  readonly terminal: TerminalStream;

  /** 回傳值用來取消監聽；監聽時立刻收到一次目前狀態。 */
  watchBoard(listener: BoardListener): () => void;
  watchResources(listener: (sample: ResourceSample) => void): () => void;
  /** 和 hub 的連線狀態；假後端沒有這個概念。 */
  watchConnection?(listener: (connected: boolean) => void): () => void;

  needsSetup(): Promise<boolean>;
  currentUser(): Promise<User | null>;
  setup(input: { name: string; password: string; locale: User['locale'] }): Promise<User>;
  login(input: { name: string; password: string }): Promise<User>;
  logout(): Promise<void>;

  createSession(input: SessionSpec & { machineId: string }): Promise<Session>;
  updateSession(
    id: string,
    patch: { name?: string; archived?: boolean; markDone?: true },
  ): Promise<Session>;
  stopSession(id: string): Promise<Session>;
  sendPrompt(sessionId: string, text: string): void;
  decideApproval(approval: Approval, decision: ApprovalDecision): Promise<void>;

  listProjects(): Promise<Project[]>;
  listTemplates(): Promise<Template[]>;
  saveTemplate(input: Omit<Template, 'id'>): Promise<Template>;
  browseDirectory(
    machineId: string,
    path: string,
  ): Promise<{ path: string; entries: { name: string; isDir: boolean; isGitRepo: boolean }[] }>;
  createPairingCode(): Promise<{ code: string; expiresAt: string; installCommand: string }>;
  removeMachine(id: string): Promise<void>;

  getLayouts(workspace: string): Promise<Layout[]>;
  saveLayouts(layouts: Layout[]): Promise<void>;
  getNotes(workspace: string): Promise<Note[]>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  /** 這台裝置的 Web Push 訂閱（flows/push.ts）。 */
  pushVapidKey(): Promise<string>;
  pushSubscribe(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;

  /** 團隊工作台與畫布的團隊框、交接線（Phase 3）。 */
  listTeams(): Promise<Team[]>;
  createTeam(input: Omit<Team, 'id'>): Promise<Team>;
  updateTeam(id: string, patch: Partial<Omit<Team, 'id'>>): Promise<Team>;
  deleteTeam(id: string): Promise<void>;
  listTeamMembers(teamId: string): Promise<TeamMember[]>;
  putTeamMember(teamId: string, sessionId: string, role: TeamMember['role']): Promise<TeamMember>;
  deleteTeamMember(teamId: string, sessionId: string): Promise<void>;
  listTasks(teamId: string): Promise<Task[]>;
  createTask(teamId: string, input: Pick<Task, 'title' | 'ownerSessionId'>): Promise<Task>;
  updateTask(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'ownerSessionId' | 'column'>>,
  ): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  listHandoffRules(teamId: string): Promise<HandoffRule[]>;
  createHandoffRule(
    teamId: string,
    input: Omit<HandoffRule, 'id' | 'teamId'>,
  ): Promise<HandoffRule>;
  updateHandoffRule(
    id: string,
    patch: Partial<Omit<HandoffRule, 'id' | 'teamId'>>,
  ): Promise<HandoffRule>;
  deleteHandoffRule(id: string): Promise<void>;
  /** 由舊到新。請隊長拆解從這裡讀回覆；最近的交接紀錄也是。 */
  sessionEvents(sessionId: string): Promise<SessionEvent[]>;
}
