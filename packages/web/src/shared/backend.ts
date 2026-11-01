// 畫面只透過這個介面存取資料。Phase 1 接 fakeBackend，Phase 2 由 Lead 接真 hub。
import type {
  Approval,
  ApprovalDecision,
  Layout,
  Machine,
  Note,
  Project,
  ResourceSample,
  Session,
  SessionSpec,
  Settings,
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
}
