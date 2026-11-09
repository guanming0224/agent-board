// CLI 的常數。值的來源是 @agent-board/protocol，但 CLI 跑在每次工具呼叫的路徑上，
// 不能為了幾個常數載入 zod，所以在這裡抄一份；cli.test.ts 保證兩邊不會分岔。

export const SESSION_ID_ENV = 'AGENT_BOARD_SESSION_ID';
export const SOCKET_ENV = 'AGENT_BOARD_SOCKET';
export const HOOK_WAIT_MS = 570_000;
export const HOOK_EVENTS: readonly string[] = [
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
  // Codex 才有（`--agent codex`）。
  'Interrupt',
  'PostModelRequest',
];
/** `agent-board-hook --agent codex <Event>`（protocol 的 HOOK_AGENT_FLAG）。 */
export const AGENT_FLAG = '--agent';
export const AGENTS: readonly string[] = ['claude', 'codex'];
/**
 * Codex 跑 shell 指令的工具名稱。文件說 Bash 的 tool_input.command 是字串；其他名稱是舊版或內部名稱（未驗證），
 * 一律當成 Bash 交給 daemon 比對危險指令，往安全的方向。
 */
export const CODEX_SHELL_TOOLS: readonly string[] = [
  'Bash',
  'shell',
  'local_shell',
  'exec_command',
  'unified_exec',
  'container.exec',
];
export const BLOCKING_EVENTS: readonly string[] = ['PreToolUse', 'PermissionRequest'];

/** 只給測試縮短等待；只能比 HOOK_WAIT_MS 短，正式環境不設。 */
export const WAIT_OVERRIDE_ENV = 'AGENT_BOARD_HOOK_WAIT_MS';
/** stdin 讀不完就放棄。Claude Code 寫完會關閉 stdin，正常碰不到。 */
export const STDIN_DEADLINE_MS = 5_000;
/** 連 socket 的上限，超過視同連不上。 */
export const CONNECT_DEADLINE_MS = 2_000;
/** 非 blocking 事件從連線到送完的上限。 */
export const SEND_DEADLINE_MS = 1_000;
