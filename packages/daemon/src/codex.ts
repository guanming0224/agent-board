// Codex CLI（CONTRACTS §19）：組參數、把 hook 的回答換成 Codex 的格式、找 thread 的對話紀錄。
// 和 Claude 共用 PTY、approvals、危險規則、送字；只有這幾件事不一樣。
// 參數只能是互動模式用的那幾個（scripts/check-no-llm.mjs 的 CODEX_FLAGS）：不用 exec／review 這類非互動子指令。
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  codexHookOverrides,
  codexPermissionArgs,
  type HookEventName,
  type PermissionMode,
} from '@agent-board/protocol';
import type { HookOutput } from './hookServer';

export interface CodexArgsInput {
  /** 接續的 thread id：`codex resume <id>`。 */
  resumeId?: string | null;
  permissionMode: PermissionMode;
  readOnly?: boolean;
  model: string | null;
  /** 新對話的第一句（使用者在新增 session 時填的）；用官方的 `codex [PROMPT]` 帶入，接續時不帶。 */
  firstPrompt?: string | null;
}

/**
 * `codex [resume <id>] <權限> [-m <model>] --dangerously-bypass-hook-trust -c hooks.<Event>=… [-- <prompt>]`。
 * hook 設定只在這次啟動有效（-c 覆寫），不寫進 `~/.codex`、不建專案 `.codex`（GM 決策 1）；
 * `--dangerously-bypass-hook-trust` 只讓這次啟動跳過 hook 信任確認，只有中控台開的 Codex 才帶。
 */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args: string[] = [];
  if (input.resumeId) args.push('resume', input.resumeId);
  args.push(...codexPermissionArgs(input.permissionMode, input.readOnly ?? false));
  if (input.model) args.push('-m', input.model);
  args.push('--dangerously-bypass-hook-trust');
  for (const override of codexHookOverrides()) args.push('-c', override);
  // `--` 之後才是提示：提示以 - 開頭也不會被當成參數。
  if (!input.resumeId && input.firstPrompt) args.push('--', input.firstPrompt);
  return args;
}

/**
 * approvals 產生的是 Claude Code 的格式，這裡換成 Codex 收得下的（官方 hooks 文件）：
 * - PermissionRequest：只留 `decision.behavior` 與 deny 的 `message`；不能帶 updatedInput／updatedPermissions
 *   （「記住」對 Codex 沒有作用）。提問的回答（answer）Codex 沒有，當成 deny 帶訊息。
 * - PreToolUse：只能 deny。allow 不輸出（exit 0＝照常執行）；文件說 allow 只用在改寫輸入。
 */
export function codexHookOutput(event: HookEventName, output: HookOutput): HookOutput {
  if (output === null) return null;
  const specific = output.hookSpecificOutput as Record<string, unknown> | undefined;
  if (event === 'PermissionRequest') {
    const decision = specific?.decision as Record<string, unknown> | undefined;
    if (!decision) return null;
    const allow = decision.behavior === 'allow' && decision.updatedInput === undefined;
    const message =
      typeof decision.message === 'string'
        ? decision.message
        : 'Answered in Agent Board; Codex has no question tool, so this was sent back as a denial.';
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message },
      },
    };
  }
  if (event === 'PreToolUse') {
    if (specific?.permissionDecision !== 'deny') return null;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: specific.permissionDecisionReason ?? 'Blocked by Agent Board.',
      },
    };
  }
  return null;
}

/** Codex 的資料夾：`CODEX_HOME`，沒設就是 `~/.codex`。只讀 `sessions/` 底下的檔名，不碰登入資料。 */
export const codexHome = (env: NodeJS.ProcessEnv): string =>
  env.CODEX_HOME || join(env.HOME || homedir(), '.codex');

const THREAD_SEARCH_DEPTH = 4;

/**
 * 這個 thread 有沒有對話紀錄（`sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`）。daemon 重啟時用來決定
 * `codex resume <id>` 還是重新開始：開了之後一句話都沒說的 thread 可能沒有紀錄，resume 會失敗。
 * 只比對檔名（未驗證：檔名格式取自 codex 0.167.0 的資料夾）。
 */
export async function codexThreadExists(home: string, threadId: string): Promise<boolean> {
  const suffix = `${threadId.toLowerCase()}.jsonl`;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) return true;
    }
    if (depth === 0) return false;
    for (const entry of entries) {
      if (entry.isDirectory() && (await walk(join(dir, entry.name), depth - 1))) return true;
    }
    return false;
  };
  return walk(join(home, 'sessions'), THREAD_SEARCH_DEPTH);
}
