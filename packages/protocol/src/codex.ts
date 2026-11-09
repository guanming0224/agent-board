// Codex CLI 接口第一版（GM 2026-11-10，CONTRACTS §19）。daemon 組參數、web 預覽與畫面說明共用這一份，
// 兩邊顯示的一定是實際執行的參數。
import { HOOK_AGENT_FLAG, HOOK_COMMAND, HOOK_TIMEOUT_SECONDS, type HookEventName } from './hook';
import type { PermissionMode } from './models';

/**
 * 中控台替 Codex 開的 hook 事件。以 `-c hooks.<Event>=[...]` 在每次啟動時帶入（不寫進 `~/.codex`、
 * 不建專案 `.codex`，GM 決策 1），command 是 `agent-board-hook --agent codex <Event>`。
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
 * 每個事件的 timeout（秒）。等網頁決定的兩個和 Claude 一樣；SessionEnd／Interrupt 文件寫上限 3 秒；
 * 其他送出就走（hook CLI 自己 1 秒內結束），給 30 秒只是上限。
 */
export function codexHookTimeout(event: CodexHookEvent): number {
  if (event === 'PreToolUse' || event === 'PermissionRequest') return HOOK_TIMEOUT_SECONDS;
  if (event === 'SessionEnd' || event === 'Interrupt') return 3;
  return 30;
}

export const codexHookCommand = (event: CodexHookEvent): string =>
  `${HOOK_COMMAND} ${HOOK_AGENT_FLAG} codex ${event}`;

/**
 * `-c` 的值（TOML）：`hooks.<Event>=[{hooks=[{type="command",command="…",timeout=N}]}]`。
 * 不寫 matcher＝每個工具都送（daemon 只對 Bash 比對危險指令）。Windows 的 `commandWindows` 先不帶（第一版不做 Windows）。
 */
export function codexHookOverrides(): string[] {
  return CODEX_HOOK_EVENTS.map(
    (event) =>
      `hooks.${event}=[{hooks=[{type="command",command="${codexHookCommand(event)}",timeout=${codexHookTimeout(event)}}]}]`,
  );
}

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApproval = 'on-request' | 'never';

/** Claude 權限模式換成 Codex 的設定。`bypass` 為 true 時改帶 `--dangerously-bypass-approvals-and-sandbox`。 */
export interface CodexPermission {
  sandbox: CodexSandbox | null;
  approval: CodexApproval | null;
  bypass: boolean;
}

/**
 * 對應表（GM 決策 3：寬鬆程度相當、不比選的更寬）。理由見 CONTRACTS §19.2。
 * - plan、default：唯讀沙盒、需要時問你（要寫檔、連網、跑沙盒外的指令都要你允許）。
 * - acceptEdits、auto：工作資料夾可寫的沙盒、需要時問你（沙盒內的指令不問就跑，不能連網、不能寫工作區外）。
 * - dontAsk：唯讀沙盒、從不問（做不到的直接失敗回給模型，和 Claude 的 dontAsk 一樣不問就拒）。
 * - bypassPermissions：`--dangerously-bypass-approvals-and-sandbox`（沿用 bypass 的警示）。
 * 唯讀 session：沙盒一律 read-only；bypass 也改成 read-only＋never，不開沙盒外的權限。
 */
export function codexPermission(mode: PermissionMode, readOnly = false): CodexPermission {
  if (mode === 'bypassPermissions') {
    return readOnly
      ? { sandbox: 'read-only', approval: 'never', bypass: false }
      : { sandbox: null, approval: null, bypass: true };
  }
  const writable = mode === 'acceptEdits' || mode === 'auto';
  return {
    sandbox: writable && !readOnly ? 'workspace-write' : 'read-only',
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
