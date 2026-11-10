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
/** Codex 的 hook 指令直接帶 session id 與 socket（protocol 的 HOOK_SESSION_FLAG／HOOK_SOCKET_FLAG），優先於環境變數。 */
export const SESSION_FLAG = '--session';
export const SOCKET_FLAG = '--socket';
/** Codex PermissionRequest 等 daemon 的上限（protocol 的 CODEX_PERMISSION_HOOK_WAIT_MS）。 */
export const CODEX_PERMISSION_HOOK_WAIT_MS = 95_000;
export const AGENTS: readonly string[] = ['claude', 'codex'];
/**
 * Codex 跑 shell 指令的工具名稱。文件說 Bash 的 tool_input.command 是字串；其他名稱是舊版或內部名稱（未驗證），
 * 一律當成 Bash 交給 daemon 比對危險指令，往安全的方向。不在這裡的工具，只要 tool_input 有 command／cmd 也當成 Bash。
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
/**
 * 連不上 daemon（session host 模式下 daemon 重啟中）時重試多久（GM 2026-11-10）：非阻擋事件最多 10 秒，
 * 阻擋事件也是 10 秒、而且不超過原本的等待上限。agent 在這段時間會等這個 hook。
 */
export const RETRY_WINDOW_MS = 10_000;
export const RETRY_INTERVAL_MS = 200;
/** Codex 給 SessionEnd、Interrupt 的 timeout 只有 3 秒（protocol 的 codexHookTimeout），重試要在那之前結束。 */
export const CODEX_SHORT_RETRY_MS = 2_000;
export const CODEX_SHORT_EVENTS: readonly string[] = ['SessionEnd', 'Interrupt'];
/**
 * daemon 在 session host 模式下停止時在 socket 旁邊留的記號（`<socket>.down`）。記號超過這麼久：daemon
 * 不是在重啟而是停了，不重試（不然每個 hook 都讓 agent 卡 10 秒）。沒有記號（daemon 崩潰）照樣重試。
 */
export const DOWN_MARKER_SUFFIX = '.down';
export const DOWN_MARKER_STALE_MS = 60_000;
/** 只給測試縮短重試時間；只能比 RETRY_WINDOW_MS 短，正式環境不設。 */
export const RETRY_OVERRIDE_ENV = 'AGENT_BOARD_HOOK_RETRY_MS';
