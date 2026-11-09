// 派工 MCP server 的常數。值的來源是 @agent-board/protocol，但 mcp.ts 只用 node 內建模組（不載入 zod），
// 所以在這裡抄一份；mcp.test.ts 保證兩邊不會分岔。

export const SESSION_ID_ENV = 'AGENT_BOARD_SESSION_ID';
export const SOCKET_ENV = 'AGENT_BOARD_SOCKET';
export const MCP_SECRET_FILE_ENV = 'AGENT_BOARD_MCP_SECRET_FILE';
/** 這次掛了哪些工具（逗號分隔的短名稱）。沒有＝舊版 daemon，只有派工工具。 */
export const MCP_TOOLS_ENV = 'AGENT_BOARD_MCP_TOOLS';
/** 派工工具（和 protocol 的 DispatchTool 一致）。 */
export const DISPATCH_TOOLS = [
  'list_members',
  'spawn_member',
  'send_task',
  'get_result',
  'release_member',
] as const;
/**
 * 舊版 daemon 沒給 MCP_TOOLS_ENV 時只列這四個：舊 daemon 的 --allowedTools 沒有 release_member，
 * 列出來隊長一呼叫就會跳權限框。新工具只在 daemon 明確列出時才出現（hub、daemon、hook 要一起更新）。
 */
export const LEGACY_DISPATCH_TOOLS = [
  'list_members',
  'spawn_member',
  'send_task',
  'get_result',
] as const;
/** 進度卡工具（P3 項目一）。 */
export const MEMORY_TOOLS = ['get_progress', 'update_progress'] as const;
export const MCP_SERVER_NAME = 'agent-board';
/** 比 daemon 等 hub 的上限（30 秒）長一點，daemon 的逾時訊息才會先到。 */
export const MCP_TOOL_TIMEOUT_MS = 45_000;
