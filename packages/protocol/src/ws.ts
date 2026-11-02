// WebSocket 訊息。兩條通道：/ws/daemon（機器 token）、/ws/client（登入 cookie）。
// 每則都是一個 JSON 物件，以 `type` 區分。
import { z } from 'zod';
import {
  Approval,
  ApprovalDecision,
  Id,
  IsoTime,
  Machine,
  MachineCapabilities,
  MachineOs,
  PermissionMode,
  ResourceSample,
  Session,
  SessionEvent,
  UsageSummary,
} from './models';

export const WS_PATHS = { daemon: '/ws/daemon', client: '/ws/client' } as const;

export const TerminalSignal = z.enum(['escape', 'ctrl_c', 'terminate']);

const TerminalData = z.object({
  sessionId: Id,
  /** 每個 session 從 1 遞增；收方發現跳號就要重新訂閱。 */
  seq: z.number().int().positive(),
  data: z.string(),
});

const TerminalSnapshot = z.object({
  sessionId: Id,
  /** 快照涵蓋到的 seq；之後只接受更大的 seq。 */
  seq: z.number().int().nonnegative(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** @xterm/addon-serialize 的輸出，直接 write 進 xterm 即可還原。 */
  data: z.string(),
});

const Resize = z.object({
  sessionId: Id,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** 建立 session 的參數。 */
export const SessionSpec = z.object({
  name: z.string().min(1),
  projectId: Id.nullable(),
  cwd: z.string().min(1),
  useWorktree: z.boolean(),
  permissionMode: PermissionMode,
  model: z.string().nullable(),
  accountProfile: z.string().nullable(),
  resumeClaudeSessionId: z.string().nullable(),
  firstPrompt: z.string().nullable(),
});
export type SessionSpec = z.infer<typeof SessionSpec>;

export const DirEntry = z.object({ name: z.string(), isDir: z.boolean(), isGitRepo: z.boolean() });

/** daemon 回報的 session 欄位：hub 擁有的（archived、projectId…）不在內。 */
export const SessionRuntime = Session.pick({
  id: true,
  cwd: true,
  branch: true,
  worktreePath: true,
  status: true,
  statusDetail: true,
  claudeSessionId: true,
  lastLines: true,
  lastOutputAt: true,
  statusSince: true,
  contextTokens: true,
  endedAt: true,
});
export type SessionRuntime = z.infer<typeof SessionRuntime>;

// ── daemon → hub ─────────────────────────────────────────────
export const DaemonToHub = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('daemon.hello'),
    name: z.string(),
    os: MachineOs,
    version: z.string(),
    capabilities: MachineCapabilities,
    /** 目前活著的 session，hub 用來對帳（重連、daemon 重啟）。 */
    sessions: z.array(SessionRuntime),
    pendingApprovals: z.array(Approval),
  }),
  z.object({ type: z.literal('session.created'), requestId: Id, session: SessionRuntime }),
  z.object({ type: z.literal('session.createFailed'), requestId: Id, error: z.string() }),
  z.object({ type: z.literal('session.runtime'), session: SessionRuntime }),
  z.object({ type: z.literal('session.event'), event: SessionEvent }),
  TerminalData.extend({ type: z.literal('terminal.output') }),
  TerminalSnapshot.extend({ type: z.literal('terminal.snapshot') }),
  z.object({ type: z.literal('approval.requested'), approval: Approval }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: Id,
    sessionId: Id,
    /** web：網頁決定；terminal：在終端機處理了或 session 已結束；timeout：等太久、hook 已離開或機器被移除。 */
    by: z.enum(['web', 'terminal', 'timeout']),
  }),
  z.object({ type: z.literal('resources'), sample: ResourceSample.omit({ machineId: true }) }),
  z.object({ type: z.literal('usage'), summary: UsageSummary.omit({ machineId: true }) }),
  z.object({
    type: z.literal('fs.listResult'),
    requestId: Id,
    path: z.string(),
    entries: z.array(DirEntry),
    error: z.string().nullable(),
  }),
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

// ── hub → daemon ─────────────────────────────────────────────
export const HubToDaemon = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hub.welcome'),
    machineId: Id,
    dangerRules: z.array(z.string()),
    stuckMinutes: z.number().int().positive(),
  }),
  z.object({ type: z.literal('session.create'), requestId: Id, sessionId: Id, spec: SessionSpec }),
  z.object({ type: z.literal('session.stop'), sessionId: Id }),
  z.object({ type: z.literal('terminal.subscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.unsubscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.input'), sessionId: Id, data: z.string() }),
  Resize.extend({ type: z.literal('terminal.resize') }),
  z.object({ type: z.literal('terminal.signal'), sessionId: Id, signal: TerminalSignal }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: Id,
    sessionId: Id,
    decision: ApprovalDecision,
  }),
  z.object({ type: z.literal('resources.watch'), watching: z.boolean() }),
  z.object({ type: z.literal('fs.list'), requestId: Id, path: z.string() }),
]);
export type HubToDaemon = z.infer<typeof HubToDaemon>;

// ── browser → hub ────────────────────────────────────────────
export const ClientToHub = z.discriminatedUnion('type', [
  z.object({ type: z.literal('terminal.subscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.unsubscribe'), sessionId: Id }),
  z.object({ type: z.literal('terminal.input'), sessionId: Id, data: z.string() }),
  Resize.extend({ type: z.literal('terminal.resize') }),
  z.object({ type: z.literal('terminal.signal'), sessionId: Id, signal: TerminalSignal }),
  z.object({
    type: z.literal('approval.decide'),
    approvalId: Id,
    sessionId: Id,
    decision: ApprovalDecision,
  }),
  z.object({ type: z.literal('resources.watch'), watching: z.boolean() }),
  z.object({ type: z.literal('ping'), at: IsoTime }),
]);
export type ClientToHub = z.infer<typeof ClientToHub>;

// ── hub → browser ────────────────────────────────────────────
export const HubToClient = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('board.state'),
    machines: z.array(Machine),
    sessions: z.array(Session),
    approvals: z.array(Approval),
  }),
  TerminalData.extend({ type: z.literal('terminal.output') }),
  TerminalSnapshot.extend({ type: z.literal('terminal.snapshot') }),
  z.object({ type: z.literal('session.updated'), session: Session }),
  z.object({ type: z.literal('session.removed'), sessionId: Id }),
  z.object({ type: z.literal('session.event'), event: SessionEvent }),
  z.object({ type: z.literal('machine.updated'), machine: Machine }),
  z.object({ type: z.literal('machine.removed'), machineId: Id }),
  z.object({ type: z.literal('approval.requested'), approval: Approval }),
  z.object({
    type: z.literal('approval.resolved'),
    approvalId: Id,
    sessionId: Id,
    by: z.enum(['web', 'terminal', 'timeout']),
  }),
  z.object({ type: z.literal('resources'), sample: ResourceSample }),
  z.object({ type: z.literal('pong'), at: IsoTime }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type HubToClient = z.infer<typeof HubToClient>;
