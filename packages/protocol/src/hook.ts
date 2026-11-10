// agent-board-hook ↔ daemon 的本機 socket 協定（NDJSON，一行一則）。
// Claude Code 的欄位以 docs/claude-code-notes.md 為準；未列出的欄位用 loose 保留，避免版本更新就解析失敗。
import { z } from 'zod';
import { AgentKind, Id } from './models';
import { AgentBoardTool } from './progress';

export const HOOK_ENV = {
  /** Agent Board 內部的 session id。沒有這個變數就代表不是我們開的 claude，hook 必須立刻 exit 0。 */
  sessionId: 'AGENT_BOARD_SESSION_ID',
  /** daemon 的 unix socket 路徑或 Windows named pipe。 */
  socket: 'AGENT_BOARD_SOCKET',
} as const;

export const HOOK_COMMAND = 'agent-board-hook';
/** `agent-board-hook --agent codex <Event>`：Codex 開的 hook。沒帶就是 Claude Code。 */
export const HOOK_AGENT_FLAG = '--agent';
/**
 * Codex 的 hook 指令直接帶 session id 與 socket 路徑（不靠繼承環境變數，§19.2）。
 * hook CLI 優先用這兩個參數，沒有才看環境變數。
 */
export const HOOK_SESSION_FLAG = '--session';
export const HOOK_SOCKET_FLAG = '--socket';

/** 需要安裝的 hook 事件。 */
export const HookEventName = z.enum([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  // 以下兩個只有 Codex 有（Codex 接口第一版）：使用者中斷這一輪、每次模型請求結束（帶 error）。
  'Interrupt',
  'PostModelRequest',
]);
export type HookEventName = z.infer<typeof HookEventName>;

/** 會卡住等 daemon 回答的事件；其餘送出即結束。 */
export const BLOCKING_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
] as const satisfies readonly HookEventName[];

export const HookPayload = z.looseObject({
  session_id: z.string(),
  // Codex 在還沒有對話紀錄時可能送 null（文件沒寫明，往寬鬆的方向收）。
  transcript_path: z.string().nullish(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string(),
});
export type HookPayload = z.infer<typeof HookPayload>;

export const HookRequest = z.object({
  type: z.literal('hook'),
  requestId: Id,
  sessionId: Id,
  event: HookEventName,
  payload: HookPayload,
  /** 送 hook 的是哪個 CLI（hook CLI 的 `--agent`）。daemon 依此決定回答的格式；不送＝Claude Code。 */
  agent: AgentKind.optional(),
});
export type HookRequest = z.infer<typeof HookRequest>;

export const HookReply = z.object({
  type: z.literal('hook.reply'),
  requestId: Id,
  /** 要原樣印到 stdout 的 JSON；null 表示什麼都不印、exit 0，交回 Claude Code 自己處理。 */
  output: z.record(z.string(), z.unknown()).nullable(),
});
export type HookReply = z.infer<typeof HookReply>;

/** hook 等 daemon 回答的上限。必須小於設定裡的 hook timeout，到時間就交回原生對話框。 */
export const HOOK_WAIT_MS = 570_000;
/** 寫進 settings.local.json 的 timeout（秒）。 */
export const HOOK_TIMEOUT_SECONDS = 600;

// ── 派工 MCP server ↔ daemon（同一個 socket，CONTRACTS §11） ─────────────

/**
 * MCP server（`agent-board-mcp`）讀密鑰的檔案路徑。daemon 在 `--mcp-config` 檔的 `env` 給它；
 * 密鑰本身只在 0600 的檔案裡，不在 argv、不在 claude 的環境變數（Bash 工具讀不到）、不在 MCP 設定檔。
 */
export const MCP_ENV = {
  secretFile: 'AGENT_BOARD_MCP_SECRET_FILE',
  /**
   * 這次開 PTY 掛了哪些工具（逗號分隔的短名稱，例如 `list_members,get_progress`；P3 項目一）。
   * MCP server 的 tools/list 只列這些、只接受這些。沒有這個變數＝舊版 daemon，只有派工的四個。
   */
  tools: 'AGENT_BOARD_MCP_TOOLS',
} as const;

export const McpRequest = z.object({
  type: z.literal('mcp'),
  requestId: Id,
  sessionId: Id,
  /** 這個 session 這次開 PTY 時 daemon 產生的密鑰；結束或重開就換掉。 */
  secret: z.string().min(16).max(200),
  tool: AgentBoardTool,
  args: z.record(z.string(), z.unknown()),
});
export type McpRequest = z.infer<typeof McpRequest>;

export const McpReply = z.object({
  type: z.literal('mcp.reply'),
  requestId: Id,
  ok: z.boolean(),
  text: z.string(),
});
export type McpReply = z.infer<typeof McpReply>;
