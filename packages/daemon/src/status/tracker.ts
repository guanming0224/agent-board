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
const KEEP_ON_IDLE_PROMPT: readonly SessionStatus[] = ['plan_review', 'rate_limited', 'error'];

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
    if (to === 'running') {
      lastActivityAt = change.at.getTime();
      armStuckTimer();
    } else {
      clearStuckTimer();
    }
    options.onChange(change);
  }

  function onHook(event: HookEventName, payload: HookPayload): void {
    if (closed) return;
    const sessionId = stringField(payload, 'session_id');
    if (sessionId !== null) claudeSessionId = sessionId;

    const reason = `hook:${event}`;
    switch (event) {
      case 'UserPromptSubmit':
      case 'PreToolUse':
        lastActivityAt = now().getTime();
        transition('running', reason, null);
        break;
      case 'PermissionRequest':
        transition('waiting_permission', reason, stringField(payload, 'tool_name'));
        break;
      case 'Notification': {
        const type = stringField(payload, 'notification_type');
        const message = stringField(payload, 'message');
        const notificationReason = `${reason}:${type}`;
        if (type === 'permission_prompt') {
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
      case 'SessionStart':
      case 'SessionEnd':
        break;
    }
  }

  function detectUsageLimit(data: string): void {
    for (const line of splitLines(data)) {
      if (!matchesUsageLimit(line, 'idle')) continue;
      const key = line.trim();
      if (seenLimitLines.has(key)) continue;
      seenLimitLines.add(key);
      // starting 時 --resume 會重繪舊對話，裡面可能有以前的限流訊息；記下來但不算。
      if (status === 'starting' || status === 'rate_limited') continue;
      const working = status === 'running' || status === 'stuck';
      if (working && !matchesUsageLimit(line, 'strict')) continue;
      transition('rate_limited', 'output:rate-limit', key);
    }
  }

  function onOutput(data: string): void {
    if (closed || data.length === 0) return;
    lastActivityAt = now().getTime();
    detectUsageLimit(data);
    if (status === 'stuck') transition('running', 'output:resumed', null);
  }

  function onExit(exitCode: number): void {
    if (closed) return;
    closed = true;
    clearStuckTimer();
    if (exitCode !== 0) transition('error', 'exit:nonzero', `exit code ${exitCode}`);
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
    onExit,
    setStuckMinutes,
    dispose,
  };
};
