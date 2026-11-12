// Codex 第二輪：agent-board MCP server 的 -c 覆寫（TOML 跳脫、只露出開著的工具、免核准）。
import { describe, expect, it } from 'vitest';
import { codexMcpOverrides } from './codex';

describe('codexMcpOverrides', () => {
  it('每個 key 一個 -c 值；路徑的空白、中文、反斜線、雙引號都照 TOML basic string 跳脫', () => {
    const values = codexMcpOverrides({
      command: '/opt/node "22"/bin/node',
      args: ['C:\\ab\\mcp.mjs'],
      env: {
        AGENT_BOARD_SESSION_ID: 's-1',
        AGENT_BOARD_MCP_SECRET_FILE: '/Users/x/控制 中心/mcp/s-1.key',
        'odd key': 'v',
      },
      tools: ['list_members', 'get_progress'],
    });
    expect(values).toEqual([
      'mcp_servers.agent-board.command="/opt/node \\"22\\"/bin/node"',
      'mcp_servers.agent-board.args=["C:\\\\ab\\\\mcp.mjs"]',
      'mcp_servers.agent-board.env={AGENT_BOARD_SESSION_ID="s-1",AGENT_BOARD_MCP_SECRET_FILE="/Users/x/控制 中心/mcp/s-1.key","odd key"="v"}',
      'mcp_servers.agent-board.enabled_tools=["list_members","get_progress"]',
      'mcp_servers.agent-board.default_tools_approval_mode="approve"',
    ]);
  });
});
