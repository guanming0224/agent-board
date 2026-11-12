// Codex CLI 接口第一版（GM 2026-11-10，CONTRACTS §19）。daemon 組參數、web 預覽與畫面說明共用這一份，
// 兩邊顯示的一定是實際執行的參數。
import {
  HOOK_AGENT_FLAG,
  HOOK_COMMAND,
  HOOK_KEY_FILE_FLAG,
  HOOK_SESSION_FLAG,
  HOOK_SOCKET_FLAG,
  HOOK_TIMEOUT_SECONDS,
  type HookEventName,
} from './hook';
import { DISPATCH_MCP_SERVER, type PermissionMode } from './models';

/**
 * 中控台替 Codex 開的 hook 事件。以 `-c hooks.<Event>=[...]` 在每次啟動時帶入（不寫進 `~/.codex`、
 * 不建專案 `.codex`，GM 決策 1），command 是 `agent-board-hook --agent codex --session <id> --socket <path> <Event>`。
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'SessionEnd',
  'Interrupt',
  'PostModelRequest',
] as const satisfies readonly HookEventName[];
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/**
 * Codex 的 PermissionRequest 是「先等 hook，沒決定才顯示原生確認」（和 Claude 並行顯示不同），
 * 等太久終端機就一直卡著，所以比 Claude 短很多（CONTRACTS §19.4）。三層各差 5 秒：
 * daemon 先放棄（不輸出）→ hook CLI 自己的上限 → Codex 給 hook 的 timeout。
 */
export const CODEX_PERMISSION_WAIT_MS = 90_000;
/** hook CLI 等 daemon 回答 Codex PermissionRequest 的上限（cli-constants.ts 抄一份，測試保證一致）。 */
export const CODEX_PERMISSION_HOOK_WAIT_MS = CODEX_PERMISSION_WAIT_MS + 5_000;
const CODEX_PERMISSION_TIMEOUT_SECONDS = CODEX_PERMISSION_HOOK_WAIT_MS / 1000 + 5;

/**
 * 每個事件的 timeout（秒）。危險指令（PreToolUse）和 Claude 一樣等網頁 600 秒；PermissionRequest 見上；
 * SessionEnd／Interrupt 文件寫上限 3 秒；其他送出就走（hook CLI 自己 1 秒內結束），給 30 秒只是上限。
 */
export function codexHookTimeout(event: CodexHookEvent): number {
  if (event === 'PreToolUse') return HOOK_TIMEOUT_SECONDS;
  if (event === 'PermissionRequest') return CODEX_PERMISSION_TIMEOUT_SECONDS;
  if (event === 'SessionEnd' || event === 'Interrupt') return 3;
  return 30;
}

/** POSIX shell 的單引號（也是 shlex 的寫法）：Codex 用 shell 或自己拆字都讀得對。 */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** TOML basic string 的內容（雙引號裡面）。 */
function tomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 每個 session 自己的 hook 位址，直接寫進 hook 指令（不依賴 Codex 有沒有把環境變數傳給 hook）。 */
export interface CodexHookTarget {
  sessionId: string;
  socketPath: string;
  /** daemon 的 hook 密鑰檔（W5）；hook CLI 先驗證對方是 daemon 才送。 */
  keyFile?: string;
}

export const codexHookCommand = (event: CodexHookEvent, target: CodexHookTarget): string =>
  [
    HOOK_COMMAND,
    HOOK_AGENT_FLAG,
    'codex',
    HOOK_SESSION_FLAG,
    shellArg(target.sessionId),
    HOOK_SOCKET_FLAG,
    shellArg(target.socketPath),
    ...(target.keyFile ? [HOOK_KEY_FILE_FLAG, shellArg(target.keyFile)] : []),
    event,
  ].join(' ');

/**
 * `-c` 的值（TOML）：`hooks.<Event>=[{hooks=[{type="command",command="…",timeout=N}]}]`。
 * 不寫 matcher＝每個工具都送（daemon 只對 Bash 比對危險指令）。指令用 POSIX 單引號，Windows 的 cmd 讀不懂：
 * Windows 機器先不開 Codex（hub 回 codex_windows_unsupported、daemon 也擋，審查 W5），`commandWindows` 不帶。
 */
export function codexHookOverrides(target: CodexHookTarget): string[] {
  return CODEX_HOOK_EVENTS.map(
    (event) =>
      `hooks.${event}=[{hooks=[{type="command",command="${tomlString(codexHookCommand(event, target))}",timeout=${codexHookTimeout(event)}}]}]`,
  );
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
/**
 * codex-cli 0.167.0 的 `-a` 只收這兩個（`codex --help` 與實際傳值確認）：`untrusted` 已移除
 * （設定檔寫 `approval_policy="untrusted"` 會被拒絕：「is no longer supported」）。
 */
export type CodexApproval = 'on-request' | 'never';

/** Claude 權限模式換成 Codex 的設定。`bypass` 為 true 時改帶 `--dangerously-bypass-approvals-and-sandbox`。 */
export interface CodexPermission {
  sandbox: CodexSandbox | null;
  approval: CodexApproval | null;
  bypass: boolean;
}

/**
 * 對應表（GM 決策 3，2026-11-10 補充）。理由見 CONTRACTS §19.2。0.167.0 沒有「改檔自動、指令要問」的 `untrusted`：
 * - plan、default：唯讀沙盒、需要時問你（寫檔、連網、跑沙盒外的指令都要你允許）。唯讀沙盒裡的指令仍不問就跑、
 *   讀得到工作區外的檔案（已知差距，見 §19.2）。
 * - acceptEdits、auto：**GM 2026-11-10 決定用可寫工作區**（workspace-write＋on-request）：工作區內改檔與跑指令都不問，
 *   連網、寫工作區外要問。這比 Claude 的 acceptEdits 寬（Claude 的 Bash 仍會問），GM 知情接受；新增頁照實寫出。
 * - dontAsk：唯讀沙盒、從不問（做不到的直接失敗回給模型，和 Claude 的 dontAsk 一樣不問就拒）。
 * - bypassPermissions：`--dangerously-bypass-approvals-and-sandbox`（沿用 bypass 的警示）。
 * 唯讀 session：bypass 也改成 read-only＋never，不開沙盒外的權限。
 */
export function codexPermission(mode: PermissionMode, readOnly = false): CodexPermission {
  if (mode === 'bypassPermissions') {
    return readOnly
      ? { sandbox: 'read-only', approval: 'never', bypass: false }
      : { sandbox: null, approval: null, bypass: true };
  }
  if (readOnly)
    return {
      sandbox: 'read-only',
      approval: mode === 'dontAsk' ? 'never' : 'on-request',
      bypass: false,
    };
  return {
    sandbox: mode === 'acceptEdits' || mode === 'auto' ? 'workspace-write' : 'read-only',
    approval: mode === 'dontAsk' ? 'never' : 'on-request',
    bypass: false,
  };
}

/** `codexPermission` 的 argv。 */
export function codexPermissionArgs(mode: PermissionMode, readOnly = false): string[] {
  const permission = codexPermission(mode, readOnly);
  if (permission.bypass) return ['--dangerously-bypass-approvals-and-sandbox'];
  return ['-s', permission.sandbox ?? 'read-only', '-a', permission.approval ?? 'on-request'];
}

// ── agent-board MCP server（Codex 第二輪，GM 2026-11-12）──────────────

/** Codex 掛 agent-board MCP server 要的東西：和 Claude 的 `--mcp-config` 設定檔同一支程式、同一組環境變數。 */
export interface CodexMcpServer {
  /** node 執行檔。 */
  command: string;
  /** MCP server 程式（發布檔 daemon/dist/agent-board-mcp.mjs）。 */
  args: readonly string[];
  /** 同 Claude 設定檔的 env：session id、hook socket、密鑰**檔案路徑**、工具清單、hook 密鑰檔（W5）。 */
  env: Readonly<Record<string, string>>;
  /** 這次開著的工具（短名稱）。 */
  tools: readonly string[];
}

/** TOML 的 key：英數、底線、連字號直接寫，其他加引號。 */
const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : `"${tomlString(key)}"`);
const tomlStrings = (values: readonly string[]) =>
  `[${values.map((v) => `"${tomlString(v)}"`).join(',')}]`;

/**
 * `-c mcp_servers.agent-board.<key>=<TOML>`：只在這次啟動有效，不寫 `~/.codex/config.toml`（GM 決策 1）。
 * - `enabled_tools`：只露出開著的工具（同 Claude 的 `--allowedTools` 只列這幾個）。
 * - `default_tools_approval_mode="approve"`：這些工具呼叫不跳 Codex 的核准（同 Claude 事先允許的理由，§11.1）。
 *   值取自 Codex 官方設定文件（`auto | prompt | writes | approve`，文件範例用 `approve` 對單一工具免核准）；
 *   **未用真的 codex 驗證**。
 * 密鑰本身不在 argv：env 只有密鑰檔路徑（`ps` 看得到 argv，§11.1）。
 */
export function codexMcpOverrides(server: CodexMcpServer): string[] {
  const prefix = `mcp_servers.${DISPATCH_MCP_SERVER}`;
  const env = Object.entries(server.env)
    .map(([key, value]) => `${tomlKey(key)}="${tomlString(value)}"`)
    .join(',');
  return [
    `${prefix}.command="${tomlString(server.command)}"`,
    `${prefix}.args=${tomlStrings(server.args)}`,
    `${prefix}.env={${env}}`,
    `${prefix}.enabled_tools=${tomlStrings(server.tools)}`,
    `${prefix}.default_tools_approval_mode="approve"`,
  ];
}
