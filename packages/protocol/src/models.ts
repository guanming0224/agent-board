// 資料模型（DISPATCH §3、§4）。API 與 WebSocket 一律 camelCase；hub 自行對應 SQLite 的 snake_case。
import { z } from 'zod';

export const Id = z.string().min(1);
export const IsoTime = z.string().datetime({ offset: true });

/** DISPATCH §4 的 10 個狀態，加上 §8-4 排隊需要的 `queued`（Lead 增補）。 */
export const SessionStatus = z.enum([
  'queued',
  'starting',
  'running',
  'waiting_permission',
  'waiting_input',
  'plan_review',
  'error',
  'rate_limited',
  'stuck',
  'done',
  'offline',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** 需要人處理的狀態：進入時推播（§4），也是「下一個等我的」的範圍。 */
export const ATTENTION_STATUSES = [
  'waiting_permission',
  'waiting_input',
  'plan_review',
  'error',
  'stuck',
] as const satisfies readonly SessionStatus[];

export function needsAttention(status: SessionStatus): boolean {
  return (ATTENTION_STATUSES as readonly SessionStatus[]).includes(status);
}

/** `claude --permission-mode` 的值。`manual` 是 `default` 的別名，這裡統一存 `default`。 */
export const PermissionMode = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const UserRole = z.enum(['owner', 'member']);
export const Locale = z.enum(['zh-TW', 'en']);
export const TeamRole = z.enum(['lead', 'worker', 'researcher', 'reviewer']);
export const TaskColumn = z.enum(['todo', 'doing', 'review', 'done']);
export const HandoffTrigger = z.enum(['on_done', 'on_file', 'on_fail']);

export const User = z.object({
  id: Id,
  name: z.string().min(1),
  role: UserRole,
  locale: Locale,
});
export type User = z.infer<typeof User>;

export const MachineCapabilities = z.object({
  hasGpu: z.boolean(),
  gpuName: z.string().nullable(),
  cpuCores: z.number().int().positive(),
  memoryBytes: z.number().int().nonnegative(),
  claudeVersion: z.string().nullable(),
});
export type MachineCapabilities = z.infer<typeof MachineCapabilities>;

export const MachineOs = z.enum(['darwin', 'linux', 'win32']);

export const Machine = z.object({
  id: Id,
  name: z.string().min(1),
  os: MachineOs,
  online: z.boolean(),
  lastSeenAt: IsoTime.nullable(),
  capabilities: MachineCapabilities,
});
export type Machine = z.infer<typeof Machine>;

export const Project = z.object({ id: Id, name: z.string().min(1), color: z.string() });
export type Project = z.infer<typeof Project>;

export const Session = z.object({
  id: Id,
  machineId: Id,
  projectId: Id.nullable(),
  name: z.string().min(1),
  cwd: z.string().min(1),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  permissionMode: PermissionMode,
  model: z.string().nullable(),
  /** 該機器上的 CLAUDE_CONFIG_DIR 絕對路徑；null 表示用預設帳號。 */
  accountProfile: z.string().nullable(),
  status: SessionStatus,
  statusDetail: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  /** 摘要卡用：最後 4 行純文字（已去除 ANSI）。 */
  lastLines: z.array(z.string()).max(4),
  lastOutputAt: IsoTime.nullable(),
  /** 進入目前狀態的時間，用來算「等了多久」。 */
  statusSince: IsoTime,
  contextTokens: z.number().int().nonnegative().nullable(),
  createdAt: IsoTime,
  endedAt: IsoTime.nullable(),
  archived: z.boolean(),
});
export type Session = z.infer<typeof Session>;

export const SessionEvent = z.object({
  id: Id,
  sessionId: Id,
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  at: IsoTime,
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const Layout = z.object({
  workspace: z.string().min(1),
  sessionId: Id,
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type Layout = z.infer<typeof Layout>;

export const Note = z.object({
  id: Id,
  workspace: z.string().min(1),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  color: z.string(),
});
export type Note = z.infer<typeof Note>;

export const Team = z.object({
  id: Id,
  name: z.string().min(1),
  goal: z.string(),
  doneCriteria: z.string(),
  color: z.string(),
  contextMd: z.string(),
});
export type Team = z.infer<typeof Team>;

export const TeamMember = z.object({ teamId: Id, sessionId: Id, role: TeamRole });
export type TeamMember = z.infer<typeof TeamMember>;

export const Task = z.object({
  id: Id,
  teamId: Id,
  title: z.string().min(1),
  ownerSessionId: Id.nullable(),
  column: TaskColumn,
});
export type Task = z.infer<typeof Task>;

export const HandoffRule = z.object({
  id: Id,
  teamId: Id,
  fromSessionId: Id,
  trigger: HandoffTrigger,
  action: z.object({ toSessionId: Id, filePattern: z.string().optional() }),
  enabled: z.boolean(),
});
export type HandoffRule = z.infer<typeof HandoffRule>;

/** §8 省額度預設。 */
export const QuotaGuards = z.object({
  denyReadPaths: z.array(z.string()),
  maxConcurrentSessions: z.number().int().positive().nullable(),
});

export const TemplateConfig = z.object({
  machineId: Id.nullable(),
  cwd: z.string().nullable(),
  permissionMode: PermissionMode,
  model: z.string().nullable(),
  firstPrompt: z.string().nullable(),
  quotaGuards: QuotaGuards,
});

export const Template = z.object({ id: Id, name: z.string().min(1), config: TemplateConfig });
export type Template = z.infer<typeof Template>;

export const AuditEntry = z.object({
  id: Id,
  userId: Id.nullable(),
  sessionId: Id.nullable(),
  action: z.string().min(1),
  detail: z.string(),
  at: IsoTime,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/**
 * 等人決定的請求。擁有者是 daemon（hook 正卡在本機 socket 上等答案），hub 只快取與轉送，
 * 不另開資料表；決定結果寫進 audit_log 與 session_events。
 */
export const ApprovalKind = z.enum(['permission', 'danger', 'plan', 'question']);
export const Approval = z.object({
  id: Id,
  sessionId: Id,
  kind: ApprovalKind,
  toolName: z.string().nullable(),
  toolInput: z.record(z.string(), z.unknown()).nullable(),
  /** Claude Code 提供的 permission_suggestions，原樣保留給「允許並記住」。 */
  suggestions: z.array(z.unknown()),
  /** 命中的危險指令規則；非 danger 為 null。 */
  matchedRule: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: IsoTime,
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalDecision = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('allow'), remember: z.boolean().default(false) }),
  z.object({ behavior: z.literal('deny'), reason: z.string().trim().min(1) }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ResourceSample = z.object({
  machineId: Id,
  at: IsoTime,
  cpuPercent: z.number().min(0).max(100),
  memoryUsedBytes: z.number().int().nonnegative(),
  memoryTotalBytes: z.number().int().nonnegative(),
  gpu: z
    .object({
      name: z.string(),
      utilizationPercent: z.number().min(0).max(100),
      memoryUsedBytes: z.number().int().nonnegative(),
      memoryTotalBytes: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type ResourceSample = z.infer<typeof ResourceSample>;

export const UsageSummary = z.object({
  machineId: Id,
  from: IsoTime,
  to: IsoTime,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/** Lead 增補的 `settings` 鍵值表內容（§3 沒有列，但 §5.3-7、§7、§8 都需要）。 */
export const Settings = z.object({
  listenAddress: z.string(),
  publicOrigin: z.string().url().nullable(),
  stuckMinutes: z.number().int().positive(),
  dangerRules: z.array(z.string()),
  quotaGuards: QuotaGuards,
  notifications: z.object({
    enabled: z.boolean(),
    quietHours: z.object({ start: z.string(), end: z.string() }).nullable(),
  }),
});
export type Settings = z.infer<typeof Settings>;

/** 預設危險指令清單（§7）。比對方式見 CONTRACTS.md §4.3。 */
export const DEFAULT_DANGER_RULES = ['rm -rf /', 'git push --force', 'git reset --hard'];
export const DEFAULT_STUCK_MINUTES = 10;
