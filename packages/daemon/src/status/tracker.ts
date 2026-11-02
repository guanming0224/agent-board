// session 狀態機，規則見 CONTRACTS.md §5。判斷不出來就維持原狀，不誤報。
import type { HookEventName, HookPayload, SessionStatus } from '@agent-board/protocol';
import { createLineSplitter, matchesUsageLimit } from './rate-limit';
import type { CreateStatusTracker, StatusChange } from './types';

const MS_PER_MINUTE = 60_000;
/** setTimeout 的上限，超過會立刻觸發。到期時會重新檢查，所以截短沒有影響。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * idle_prompt 只代表「閒置中」。這些狀態已經說明了為什麼閒置，被蓋成 waiting_input 反而是誤報：
 * 限流會看不到、計畫審核會變成一般等待。
 */
/**
 * 新資料夾的信任對話框。回答前 hook 不會跑，只能從輸出判斷；不偵測的話會一直顯示「啟動中」，
 * 使用者不知道它在等人。字串取自 claude 2.1.316，換版比對不到就退回 starting，不會誤報。
 */
const TRUST_PROMPT = /Yes, I trust this folder/;

const KEEP_ON_IDLE_PROMPT: readonly SessionStatus[] = ['plan_review', 'rate_limited', 'error'];

/** 等人決定的權限請求。Notification 不帶工具資訊，所以 toolName、toolInput 可能是 null。 */
interface PendingPermission {
  agentId: string | null;
  toolName: string | null;
  toolInput: string | null;
}

function toolInputOf(payload: HookPayload): string | null {
  return payload.tool_input === undefined ? null : JSON.stringify(payload.tool_input);
}

/** 只比對兩邊都有的欄位；PostToolUseFailure 的欄位未查證，缺了不能當成不符。 */
function settles(pending: PendingPermission, payload: HookPayload): boolean {
  const toolName = stringField(payload, 'tool_name');
  const toolInput = toolInputOf(payload);
  return (
    pending.agentId === stringField(payload, 'agent_id') &&
    (pending.toolName === null || toolName === null || pending.toolName === toolName) &&
    (pending.toolInput === null || toolInput === null || pending.toolInput === toolInput)
  );
}

function stringField(payload: HookPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const createStatusTracker: CreateStatusTracker = (options) => {
  const now = options.now ?? (() => new Date());
  const splitLines = createLineSplitter();
  /** 已處理過的限流訊息。畫面重繪會再印一次舊訊息，不能再觸發一次。 */
  const seenLimitLines = new Set<string>();

  let status: SessionStatus = 'starting';
  let claudeSessionId: string | null = null;
  let stuckMs = options.stuckMinutes * MS_PER_MINUTE;
  let lastActivityAt = now().getTime();
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;
  /** status 是 waiting_permission 時，還在等人決定的請求。 */
  let pendingPermissions: PendingPermission[] = [];
  /**
   * 這個行程裡有沒有真的開始工作過。--resume 會重繪舊對話，而 SessionStart 可能早於重繪，
   * 所以在第一個 prompt 或工具之前看到的限流訊息都視為舊訊息。
   */
  let hasWorked = false;
  /** PTY 結束或 dispose 之後，遲到的事件一律忽略。 */
  let closed = false;

  function clearStuckTimer(): void {
    if (stuckTimer !== null) clearTimeout(stuckTimer);
    stuckTimer = null;
  }

  function armStuckTimer(): void {
    clearStuckTimer();
    if (closed || status !== 'running') return;
    const remaining = lastActivityAt + stuckMs - now().getTime();
    stuckTimer = setTimeout(onStuckTimer, Math.min(Math.max(remaining, 0), MAX_TIMER_MS));
    stuckTimer.unref?.();
  }

  // 高頻輸出只更新 lastActivityAt，不重設計時器；到期才看要不要再等。
  function onStuckTimer(): void {
    stuckTimer = null;
    if (now().getTime() - lastActivityAt < stuckMs) {
      armStuckTimer();
      return;
    }
    try {
      transition('stuck', 'timer:stuck', null);
    } catch (error) {
      // 這裡在計時器裡，往外丟會讓整個 daemon 掛掉。
      console.error('StatusTracker onChange failed', error);
    }
  }

  function transition(to: SessionStatus, reason: string, detail: string | null): void {
    if (to === status) return;
    const change: StatusChange = { from: status, to, reason, detail, at: now() };
    status = to;
    if (to !== 'waiting_permission') pendingPermissions = [];
    if (to === 'running') {
      lastActivityAt = change.at.getTime();
      armStuckTimer();
    } else {
      clearStuckTimer();
    }
    options.onChange(change);
  }

  /**
   * 工具事件不一定代表主線回來工作了：子代理和主線是並行的，工具結束也不代表下一步開始。
   * 能確定的只有三件事，其他一律維持原狀（waiting_input、plan_review、rate_limited、error）：
   * - 主線的 PreToolUse：主線在工作。
   * - stuck 時任何工具事件：session 還活著。
   * - waiting_permission 時，發出請求的那一方有了進展，而且沒有其他請求在等。
   */
  function onToolEvent(event: HookEventName, payload: HookPayload): void {
    hasWorked = true;
    lastActivityAt = now().getTime();
    const reason = `hook:${event}`;
    const agentId = stringField(payload, 'agent_id');

    if (event === 'PreToolUse' && agentId === null) {
      transition('running', reason, null);
    } else if (status === 'stuck' || (status === 'starting' && agentId === null)) {
      transition('running', reason, null);
    } else if (status === 'waiting_permission') {
      settlePermission(event, payload, agentId);
      if (pendingPermissions.length === 0) transition('running', reason, null);
    }
  }

  function settlePermission(
    event: HookEventName,
    payload: HookPayload,
    agentId: string | null,
  ): void {
    if (event === 'PreToolUse') {
      // 同一方開始下一個工具，代表它先前的請求已經有結果。
      pendingPermissions = pendingPermissions.filter((pending) => pending.agentId !== agentId);
      return;
    }
    const index = pendingPermissions.findIndex((pending) => settles(pending, payload));
    if (index !== -1) pendingPermissions.splice(index, 1);
  }

  function onPermissionRequest(payload: HookPayload): void {
    // 同一個請求的 Notification 可能先到，它沒有工具資訊，由這筆取代。
    const known = pendingPermissions.filter((pending) => pending.toolName !== null);
    const toolName = stringField(payload, 'tool_name');
    pendingPermissions = [
      ...known,
      { agentId: stringField(payload, 'agent_id'), toolName, toolInput: toolInputOf(payload) },
    ];
    transition('waiting_permission', 'hook:PermissionRequest', toolName);
  }

  function onHook(event: HookEventName, payload: HookPayload): void {
    if (closed) return;
    const sessionId = stringField(payload, 'session_id');
    if (sessionId !== null) claudeSessionId = sessionId;

    const reason = `hook:${event}`;
    switch (event) {
      case 'UserPromptSubmit':
        hasWorked = true;
        lastActivityAt = now().getTime();
        transition('running', reason, null);
        break;
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
        onToolEvent(event, payload);
        break;
      case 'PermissionRequest':
        onPermissionRequest(payload);
        break;
      case 'Notification': {
        const type = stringField(payload, 'notification_type');
        const message = stringField(payload, 'message');
        const notificationReason = `${reason}:${type}`;
        if (type === 'permission_prompt') {
          if (pendingPermissions.length === 0) {
            pendingPermissions = [
              { agentId: stringField(payload, 'agent_id'), toolName: null, toolInput: null },
            ];
          }
          transition('waiting_permission', notificationReason, message);
        } else if (type === 'idle_prompt' && !KEEP_ON_IDLE_PROMPT.includes(status)) {
          transition('waiting_input', notificationReason, message);
        }
        break;
      }
      case 'Stop':
        transition(
          payload.permission_mode === 'plan' ? 'plan_review' : 'waiting_input',
          reason,
          null,
        );
        break;
      case 'StopFailure': {
        const error = stringField(payload, 'error');
        const detail = stringField(payload, 'error_details') ?? error;
        transition(error === 'rate_limit' ? 'rate_limited' : 'error', reason, detail);
        break;
      }
      case 'SessionStart': {
        // clear、compact、fork 發生在對話中途，不代表閒置。
        const source = stringField(payload, 'source');
        if (status === 'starting' && (source === 'startup' || source === 'resume')) {
          transition('waiting_input', `${reason}:${source}`, null);
        }
        break;
      }
      case 'SessionEnd':
        break;
    }
  }

  function detectUsageLimit(data: string): void {
    for (const line of splitLines(data)) {
      if (status === 'starting' && TRUST_PROMPT.test(line)) {
        transition('waiting_input', 'output:trust-prompt', 'trust');
      }
      if (!matchesUsageLimit(line, 'idle')) continue;
      const key = line.trim();
      if (seenLimitLines.has(key)) continue;
      seenLimitLines.add(key);
      if (!hasWorked || status === 'rate_limited') continue;
      const working = status === 'running' || status === 'stuck';
      if (working && !matchesUsageLimit(line, 'strict')) continue;
      transition('rate_limited', 'output:rate-limit', key);
    }
  }

  function onOutput(data: string): void {
    if (closed || data.length === 0) return;
    detectUsageLimit(data);
  }

  function onProgress(): void {
    if (closed) return;
    lastActivityAt = now().getTime();
    if (status === 'stuck') transition('running', 'output:resumed', null);
  }

  function onExit(exitCode: number): void {
    if (closed) return;
    closed = true;
    clearStuckTimer();
    if (exitCode === 0) transition('done', 'exit:0', null);
    else transition('error', 'exit:nonzero', `exit code ${exitCode}`);
  }

  function setStuckMinutes(minutes: number): void {
    if (!(minutes > 0)) return;
    stuckMs = minutes * MS_PER_MINUTE;
    armStuckTimer();
  }

  function dispose(): void {
    closed = true;
    clearStuckTimer();
  }

  return {
    get status() {
      return status;
    },
    get claudeSessionId() {
      return claudeSessionId;
    },
    onHook,
    onOutput,
    onProgress,
    onExit,
    setStuckMinutes,
    dispose,
  };
};
