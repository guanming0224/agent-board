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
import { matchDangerRule } from './dangerRules';
import type { HookOutput } from './hookServer';

export { matchDangerRule };

/**
 * 比 CLI 的 HOOK_WAIT_MS 早一點，確保 daemon 的答案（尤其 danger 的 deny）先到，
 * 不會變成 CLI 自己逾時、不輸出就放行。
 */
export const APPROVAL_WAIT_MS = HOOK_WAIT_MS - 5_000;

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

/**
 * 提問的答案放進 updatedInput.answers，Claude Code 當作使用者在對話框裡選的。
 * 答案的鍵是問題原文（AskUserQuestion 的 input 格式）；有多題時同一個回答給每一題。
 */
function answerInput(toolInput: Record<string, unknown> | null, text: string) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const answers: Record<string, string> = {};
  for (const item of questions) {
    const question = asRecord(item)?.question;
    if (typeof question === 'string') answers[question] = text;
  }
  return { ...toolInput, answers };
}

function permissionOutput(
  decision: ApprovalDecision,
  suggestions: unknown[],
  toolInput: Record<string, unknown> | null,
): HookOutput {
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
      rendered = { behavior: 'allow', updatedInput: answerInput(toolInput, decision.text) };
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
  /** 危險指令開始等人決定。合約的狀態表只有 PreToolUse→running，畫面要靠這個顯示在等人。 */
  onDangerPending?: (sessionId: string, payload: HookPayload) => void;
  /** 網頁決定了。工具可能跑很久，不能等到 PostToolUse 才離開「等你允許」。 */
  onDecided?: (approval: Approval) => void;
  now?: () => Date;
  waitMs?: number;
}

export interface HandleHookOptions {
  /**
   * PermissionRequest 等網頁的上限（毫秒）。Codex 的終端機在這段時間看不到原生確認，所以比 Claude 短
   * （CODEX_PERMISSION_WAIT_MS）。不給＝APPROVAL_WAIT_MS；測試設的 waitMs 比較短時用測試的。
   */
  permissionWaitMs?: number;
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
    hookOptions: HandleHookOptions = {},
  ): Promise<HookOutput> {
    if (event === 'PermissionRequest') {
      return this.onPermissionRequest(sessionId, payload, signal, hookOptions.permissionWaitMs);
    }
    if (event === 'PreToolUse') return this.onPreToolUse(sessionId, payload, signal);
    return Promise.resolve(null);
  }

  /** 回傳 false 表示已不在等待（重複決定、已逾時或 sessionId 對不上）。 */
  decide(approvalId: string, sessionId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingById.get(approvalId);
    if (!pending || pending.approval.sessionId !== sessionId) return false;
    this.finish(pending, pending.render(decision), 'web');
    this.options.onDecided?.(pending.approval);
    return true;
  }

  /**
   * 使用者直接在終端機回答時，Claude Code 2.1.316 不會結束卡住的 hook，只能從之後的事件推得；
   * 較新的版本會結束 hook（見 request 的 onAbort），兩條路都記成 terminal。工具跑完比對同工具同輸入；輪次結束或下一句話代表前面的請求都結束了。
   */
  settleAnsweredInTerminal(event: HookEventName, sessionId: string, payload: HookPayload): void {
    const toolDone = event === 'PostToolUse' || event === 'PostToolUseFailure';
    const turnMoved =
      event === 'Stop' ||
      event === 'StopFailure' ||
      event === 'UserPromptSubmit' ||
      event === 'SessionEnd';
    if (!toolDone && !turnMoved) return;
    const input = JSON.stringify(payload.tool_input);
    for (const pending of [...this.pendingById.values()]) {
      const { approval } = pending;
      // danger 是 PreToolUse 自己卡住，工具根本還沒開始，終端機也回答不了。
      if (approval.sessionId !== sessionId || approval.kind === 'danger') continue;
      if (
        toolDone &&
        (approval.toolName !== payload.tool_name ||
          (payload.tool_input !== undefined && JSON.stringify(approval.toolInput) !== input))
      ) {
        continue;
      }
      this.finish(pending, pending.giveUp('已在終端機處理'), 'terminal');
    }
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
    waitMs?: number,
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
      (decision) => permissionOutput(decision, suggestions, asRecord(payload.tool_input)),
      () => null, // 交回原生對話框
      signal,
      waitMs,
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
    const result = this.wait(
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
    if (!signal.aborted) this.options.onDangerPending?.(sessionId, payload);
    return result;
  }

  private wait(
    fields: Omit<Approval, 'id' | 'createdAt'>,
    render: PendingApproval['render'],
    giveUp: PendingApproval['giveUp'],
    signal: AbortSignal,
    waitMs?: number,
  ): Promise<HookOutput> {
    const now = this.options.now ?? (() => new Date());
    const approval: Approval = {
      ...fields,
      id: randomUUID(),
      createdAt: now().toISOString(),
    };
    return new Promise((settle) => {
      // hook 連線斷掉＝Claude Code 已經不等這個 hook 了。實測（2026-11-08）使用者在終端機回答
      // 原生對話框後 0.2 秒內 hook 就被結束，所以記成 terminal，不是 timeout（timeout 只給真的等太久）。
      const onAbort = () => this.finish(pending, giveUp('hook 已離開'), 'terminal');
      const timer = setTimeout(
        () => this.finish(pending, giveUp('等待逾時'), 'timeout'),
        Math.min(this.options.waitMs ?? APPROVAL_WAIT_MS, waitMs ?? APPROVAL_WAIT_MS),
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
