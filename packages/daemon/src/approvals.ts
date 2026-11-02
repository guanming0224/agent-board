// 核准方式全部封裝在這裡（CONTRACTS §4.3、§4.4）。hook 卡在本機 socket 等答案，
// 這是「把決定寫成 hook output」的做法；Phase 2 若驗證後要改成對 PTY 送按鍵，只動這個檔案。
import { randomUUID } from 'node:crypto';
import {
  HOOK_WAIT_MS,
  type Approval,
  type ApprovalDecision,
  type DaemonToHub,
  type HookEventName,
  type HookPayload,
} from '@agent-board/protocol';
import type { HookOutput } from './hookServer';

/**
 * 比 CLI 的 HOOK_WAIT_MS 早一點，確保 daemon 的答案（尤其 danger 的 deny）先到，
 * 不會變成 CLI 自己逾時、不輸出就放行。
 */
export const APPROVAL_WAIT_MS = HOOK_WAIT_MS - 5_000;

const normalizeWhitespace = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** 空白正規化後的子字串比對；回傳命中的規則。 */
export function matchDangerRule(command: string, rules: readonly string[]): string | null {
  const normalized = normalizeWhitespace(command);
  for (const rule of rules) {
    const needle = normalizeWhitespace(rule);
    if (needle && normalized.includes(needle)) return rule;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function permissionKind(toolName: string | null): Approval['kind'] {
  // 未驗證：plan 模式交計畫是否走這裡（docs/claude-code-notes.md「未驗證」）。
  if (toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'permission';
}

/**
 * Claude Code 如何接收提問的答案尚未驗證，暫時轉成 deny + message，讓模型讀得到回答
 * （CONTRACTS「權限與提問」）。Phase 2 查證後只換這裡。
 */
const answerAsDenyMessage = (text: string): string => `使用者透過 Agent Board 回答：${text}`;

function permissionOutput(decision: ApprovalDecision, suggestions: unknown[]): HookOutput {
  let rendered: Record<string, unknown>;
  switch (decision.behavior) {
    case 'allow':
      rendered = {
        behavior: 'allow',
        ...(decision.remember && suggestions.length > 0 ? { updatedPermissions: suggestions } : {}),
      };
      break;
    case 'deny':
      rendered = { behavior: 'deny', message: decision.reason };
      break;
    case 'answer':
      rendered = { behavior: 'deny', message: answerAsDenyMessage(decision.text) };
      break;
  }
  return {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: rendered },
  };
}

function preToolUseOutput(behavior: 'allow' | 'deny', reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: behavior,
      permissionDecisionReason: reason,
    },
  };
}

interface PendingApproval {
  approval: Approval;
  render: (decision: ApprovalDecision) => HookOutput;
  /** 沒有等到人決定時的答案。 */
  giveUp: (why: string) => HookOutput;
  settle: (output: HookOutput) => void;
  cleanup: () => void;
}

export interface ApprovalManagerOptions {
  send: (message: DaemonToHub) => void;
  dangerRules: () => readonly string[];
  now?: () => Date;
  waitMs?: number;
}

export class ApprovalManager {
  private readonly pendingById = new Map<string, PendingApproval>();

  constructor(private readonly options: ApprovalManagerOptions) {}

  /** 尚未決定的 approval，放進 daemon.hello 讓 hub 對帳。 */
  pending(): Approval[] {
    return [...this.pendingById.values()].map((p) => p.approval);
  }

  /** 由 hook 事件產生要回給 Claude Code 的 output；不需要人決定就回 null。 */
  handleHook(
    event: HookEventName,
    sessionId: string,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<HookOutput> {
    if (event === 'PermissionRequest') return this.onPermissionRequest(sessionId, payload, signal);
    if (event === 'PreToolUse') return this.onPreToolUse(sessionId, payload, signal);
    return Promise.resolve(null);
  }

  /** 回傳 false 表示已不在等待（重複決定、已逾時或 sessionId 對不上）。 */
  decide(approvalId: string, sessionId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingById.get(approvalId);
    if (!pending || pending.approval.sessionId !== sessionId) return false;
    this.finish(pending, pending.render(decision), 'web');
    return true;
  }

  /** session 結束時，還在等的 approval 都沒有意義了。 */
  cancelSession(sessionId: string): void {
    for (const pending of [...this.pendingById.values()]) {
      if (pending.approval.sessionId !== sessionId) continue;
      this.finish(pending, pending.giveUp('session 已結束'), 'terminal');
    }
  }

  dispose(): void {
    for (const pending of [...this.pendingById.values()]) {
      pending.cleanup();
      this.pendingById.delete(pending.approval.id);
      pending.settle(pending.giveUp('daemon 正在關閉'));
    }
  }

  private onPermissionRequest(
    sessionId: string,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<HookOutput> {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
    const suggestions = Array.isArray(payload.permission_suggestions)
      ? payload.permission_suggestions
      : [];
    return this.wait(
      {
        sessionId,
        kind: permissionKind(toolName),
        toolName,
        toolInput: asRecord(payload.tool_input),
        suggestions,
        matchedRule: null,
        message: null,
      },
      (decision) => permissionOutput(decision, suggestions),
      () => null, // 交回原生對話框
      signal,
    );
  }

  private onPreToolUse(
    sessionId: string,
    payload: HookPayload,
    signal: AbortSignal,
  ): Promise<HookOutput> {
    const toolInput = asRecord(payload.tool_input);
    const command = toolInput?.command;
    if (payload.tool_name !== 'Bash' || typeof command !== 'string') return Promise.resolve(null);
    const matchedRule = matchDangerRule(command, this.options.dangerRules());
    if (matchedRule === null) return Promise.resolve(null);
    return this.wait(
      {
        sessionId,
        kind: 'danger',
        toolName: 'Bash',
        toolInput,
        suggestions: [],
        matchedRule,
        message: null,
      },
      (decision) => {
        if (decision.behavior === 'allow') {
          return preToolUseOutput('allow', `已在 Agent Board 核准（規則：${matchedRule}）`);
        }
        // answer 不是核准：危險指令一律不放行。
        return preToolUseOutput(
          'deny',
          decision.behavior === 'deny' ? decision.reason : answerAsDenyMessage(decision.text),
        );
      },
      // 不用 ask（dontAsk 模式下會被拒）；等不到人一律往安全的方向。
      (why) => preToolUseOutput('deny', `危險指令未獲核准：${why}（規則：${matchedRule}）`),
      signal,
    );
  }

  private wait(
    fields: Omit<Approval, 'id' | 'createdAt'>,
    render: PendingApproval['render'],
    giveUp: PendingApproval['giveUp'],
    signal: AbortSignal,
  ): Promise<HookOutput> {
    const now = this.options.now ?? (() => new Date());
    const approval: Approval = {
      ...fields,
      id: randomUUID(),
      createdAt: now().toISOString(),
    };
    return new Promise((settle) => {
      const onAbort = () => this.finish(pending, giveUp('hook 已離開'), 'timeout');
      const timer = setTimeout(
        () => this.finish(pending, giveUp('等待逾時'), 'timeout'),
        this.options.waitMs ?? APPROVAL_WAIT_MS,
      );
      const pending: PendingApproval = {
        approval,
        render,
        giveUp,
        settle,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        },
      };
      this.pendingById.set(approval.id, pending);
      signal.addEventListener('abort', onAbort, { once: true });
      this.options.send({ type: 'approval.requested', approval });
      if (signal.aborted) onAbort();
    });
  }

  private finish(
    pending: PendingApproval,
    output: HookOutput,
    by: 'web' | 'terminal' | 'timeout',
  ): void {
    pending.cleanup();
    this.pendingById.delete(pending.approval.id);
    pending.settle(output);
    this.options.send({
      type: 'approval.resolved',
      approvalId: pending.approval.id,
      sessionId: pending.approval.sessionId,
      by,
    });
  }
}
