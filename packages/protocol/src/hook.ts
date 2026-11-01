// agent-board-hook ↔ daemon 的本機 socket 協定（NDJSON，一行一則）。
// Claude Code 的欄位以 docs/claude-code-notes.md 為準；未列出的欄位用 loose 保留，避免版本更新就解析失敗。
import { z } from 'zod';
import { Id } from './models';

export const HOOK_ENV = {
  /** Agent Board 內部的 session id。沒有這個變數就代表不是我們開的 claude，hook 必須立刻 exit 0。 */
  sessionId: 'AGENT_BOARD_SESSION_ID',
  /** daemon 的 unix socket 路徑或 Windows named pipe。 */
  socket: 'AGENT_BOARD_SOCKET',
} as const;

export const HOOK_COMMAND = 'agent-board-hook';

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
]);
export type HookEventName = z.infer<typeof HookEventName>;

/** 會卡住等 daemon 回答的事件；其餘送出即結束。 */
export const BLOCKING_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
] as const satisfies readonly HookEventName[];

export const HookPayload = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string().optional(),
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
