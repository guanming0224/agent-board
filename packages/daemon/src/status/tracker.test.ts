import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookEventName, HookPayload, SessionStatus } from '@agent-board/protocol';
import { createStatusTracker } from './index';
import type { StatusChange, StatusTracker } from './index';

// 欄位取自 docs/claude-code-notes.md。
const common = {
  session_id: 'claude-1',
  transcript_path: '/tmp/fake/transcript.jsonl',
  cwd: '/tmp/fake',
  permission_mode: 'default',
};

function payload(event: HookEventName, extra: Record<string, unknown> = {}): HookPayload {
  return { ...common, hook_event_name: event, ...extra };
}

const planRequest = payload('PermissionRequest', {
  tool_name: 'ExitPlanMode',
  tool_input: { plan: 'one line' },
  permission_mode: 'plan',
});

const toolCall = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1' };
/** 文件範例的 Notification 沒有 permission_mode。 */
function notification(type: string): HookPayload {
  return {
    session_id: common.session_id,
    transcript_path: common.transcript_path,
    cwd: common.cwd,
    hook_event_name: 'Notification',
    message: `message for ${type}`,
    title: 'Claude Code',
    notification_type: type,
  };
}

const MINUTE = 60_000;
const STUCK_MINUTES = 10;
const LIMIT_LINE = "You've hit your 5-hour limit · resets 3pm (Asia/Taipei)";

describe('createStatusTracker', () => {
  let changes: StatusChange[];
  let tracker: StatusTracker;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-02T00:00:00Z') });
    changes = [];
    tracker = createStatusTracker({
      stuckMinutes: STUCK_MINUTES,
      onChange: (change) => changes.push(change),
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  function toRunning(): void {
    tracker.onHook('UserPromptSubmit', payload('UserPromptSubmit', { prompt: 'hi' }));
  }

  function last(): StatusChange | undefined {
    return changes.at(-1);
  }

  describe('信任對話框', () => {
    it('啟動中看到對話框就是在等人，不會一直顯示啟動中', () => {
      tracker.onTrustPrompt();
      expect(tracker.status).toBe('waiting_input');
      expect(last()).toMatchObject({ reason: 'output:trust-prompt', detail: 'trust' });
    });

    it('已經在工作時不算（對話裡可能剛好提到這句話）', () => {
      toRunning();
      tracker.onTrustPrompt();
      expect(tracker.status).toBe('running');
    });
  });

  describe('初始狀態', () => {
    it('PTY 開啟是 starting，不發事件', () => {
      expect(tracker.status).toBe('starting');
      expect(tracker.claudeSessionId).toBeNull();
      expect(changes).toEqual([]);
    });
  });

  describe('CONTRACTS §5 的 hook 規則', () => {
    const cases: [string, HookEventName, HookPayload, SessionStatus][] = [
      ['UserPromptSubmit', 'UserPromptSubmit', payload('UserPromptSubmit'), 'running'],
      ['PreToolUse', 'PreToolUse', payload('PreToolUse', toolCall), 'running'],
      [
        'PermissionRequest',
        'PermissionRequest',
        payload('PermissionRequest', { tool_name: 'Bash', permission_suggestions: [] }),
        'waiting_permission',
      ],
      ['PostToolUse', 'PostToolUse', payload('PostToolUse', toolCall), 'running'],
      [
        'PostToolUseFailure',
        'PostToolUseFailure',
        payload('PostToolUseFailure', toolCall),
        'running',
      ],
      [
        'Notification permission_prompt',
        'Notification',
        notification('permission_prompt'),
        'waiting_permission',
      ],
      ['Notification idle_prompt', 'Notification', notification('idle_prompt'), 'waiting_input'],
      ['Stop', 'Stop', payload('Stop', { last_assistant_message: 'ok' }), 'waiting_input'],
      [
        'Stop 在 plan 模式：可能只是提問或計畫剛被拒絕，不算審計畫',
        'Stop',
        payload('Stop', { permission_mode: 'plan', last_assistant_message: 'plan' }),
        'waiting_input',
      ],
      ['ExitPlanMode 的權限請求才是交出計畫', 'PermissionRequest', planRequest, 'plan_review'],
      [
        'StopFailure rate_limit',
        'StopFailure',
        payload('StopFailure', { error: 'rate_limit', error_details: '429' }),
        'rate_limited',
      ],
      [
        'StopFailure 其他錯誤',
        'StopFailure',
        payload('StopFailure', { error: 'server_error' }),
        'error',
      ],
    ];

    it.each(cases)('%s', (_name, event, hookPayload, expected) => {
      tracker.onHook(event, hookPayload);
      expect(tracker.status).toBe(expected);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ from: 'starting', to: expected });
      expect(changes[0]?.reason).toContain(`hook:${event}`);
      expect(changes[0]?.at).toEqual(new Date('2026-11-02T00:00:00Z'));
    });

    it('StopFailure 的 error_details 寫進 detail', () => {
      tracker.onHook(
        'StopFailure',
        payload('StopFailure', { error: 'server_error', error_details: 'boom' }),
      );
      expect(last()?.detail).toBe('boom');
    });

    it('StopFailure 沒有 error 欄位也算 error，不是 rate_limited', () => {
      tracker.onHook('StopFailure', payload('StopFailure'));
      expect(tracker.status).toBe('error');
    });

    it.each(['rate_limited', 'error', 'plan_review', 'waiting_input'] as const)(
      '%s 收到新的 prompt 回到 running',
      (status) => {
        const events: Record<string, () => void> = {
          rate_limited: () =>
            tracker.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' })),
          error: () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'x' })),
          plan_review: () => tracker.onHook('PermissionRequest', planRequest),
          waiting_input: () => tracker.onHook('Stop', payload('Stop')),
        };
        events[status]?.();
        expect(tracker.status).toBe(status);
        toRunning();
        expect(tracker.status).toBe('running');
      },
    );

    it('同狀態不重複發事件', () => {
      toRunning();
      tracker.onHook('PreToolUse', payload('PreToolUse', toolCall));
      tracker.onHook('PreToolUse', payload('PreToolUse', toolCall));
      expect(changes).toHaveLength(1);
    });

    it('permission_prompt 與 PermissionRequest 接連到達只算一次', () => {
      toRunning();
      tracker.onHook('PermissionRequest', payload('PermissionRequest', { tool_name: 'Bash' }));
      tracker.onHook('Notification', notification('permission_prompt'));
      expect(changes.map((change) => change.to)).toEqual(['running', 'waiting_permission']);
    });
  });

  describe('不改變狀態的事件', () => {
    it.each([
      'auth_success',
      'elicitation_dialog',
      'agent_needs_input',
      'agent_completed',
      'quota_auto_resume_fired',
      'plugin_notification',
      'something_new_in_a_future_version',
    ])('notification_type=%s 維持原狀', (type) => {
      toRunning();
      tracker.onHook('Notification', notification(type));
      expect(tracker.status).toBe('running');
      expect(changes).toHaveLength(1);
    });

    it('Notification 沒有 notification_type 或型別不對不會壞', () => {
      toRunning();
      tracker.onHook('Notification', payload('Notification'));
      tracker.onHook('Notification', payload('Notification', { notification_type: 42 }));
      expect(tracker.status).toBe('running');
    });

    it('SessionEnd 維持原狀', () => {
      toRunning();
      tracker.onHook('SessionEnd', payload('SessionEnd', { reason: 'other' }));
      expect(tracker.status).toBe('running');
      expect(changes).toHaveLength(1);
    });

    it('未知事件維持原狀', () => {
      toRunning();
      tracker.onHook('SomethingNew' as HookEventName, payload('Stop'));
      expect(tracker.status).toBe('running');
    });
  });

  describe('SessionStart', () => {
    it.each(['startup', 'resume'])('starting 時 source=%s 變 waiting_input', (source) => {
      tracker.onHook('SessionStart', payload('SessionStart', { source }));
      expect(tracker.status).toBe('waiting_input');
      expect(last()).toMatchObject({
        from: 'starting',
        to: 'waiting_input',
        reason: `hook:SessionStart:${source}`,
      });
    });

    it.each(['clear', 'compact', 'fork', 'future_source'])(
      'starting 時 source=%s 維持 starting',
      (source) => {
        tracker.onHook('SessionStart', payload('SessionStart', { source }));
        expect(tracker.status).toBe('starting');
        expect(changes).toEqual([]);
      },
    );

    it('沒有 source 維持 starting', () => {
      tracker.onHook('SessionStart', payload('SessionStart'));
      expect(tracker.status).toBe('starting');
    });

    it.each(['startup', 'resume', 'clear', 'compact', 'fork'])(
      '工作中 source=%s 不改狀態',
      (source) => {
        toRunning();
        tracker.onHook('SessionStart', payload('SessionStart', { source }));
        expect(tracker.status).toBe('running');
        expect(changes).toHaveLength(1);
      },
    );

    it.each(['clear', 'compact', 'fork'])('waiting_input 時 source=%s 不改狀態', (source) => {
      tracker.onHook('SessionStart', payload('SessionStart', { source: 'startup' }));
      tracker.onHook('SessionStart', payload('SessionStart', { source }));
      expect(tracker.status).toBe('waiting_input');
      expect(changes).toHaveLength(1);
    });
  });

  describe('工具事件與等人決定的狀態', () => {
    const sub = { agent_id: 'agent-1', agent_type: 'Explore' };
    const lsCall = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    const rmCall = { tool_name: 'Bash', tool_input: { command: 'rm x' } };
    const readCall = { tool_name: 'Read', tool_input: { file_path: '/tmp/x' } };
    const postEvents = ['PostToolUse', 'PostToolUseFailure'] as const;

    function waitForPermission(extra: Record<string, unknown> = lsCall): void {
      toRunning();
      tracker.onHook('PermissionRequest', payload('PermissionRequest', extra));
      expect(tracker.status).toBe('waiting_permission');
    }

    describe.each(postEvents)('%s', (event) => {
      it('核准的工具結束：waiting_permission 回 running，並重新計 stuck', () => {
        waitForPermission();
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe('running');
        expect(last()).toMatchObject({ from: 'waiting_permission', reason: `hook:${event}` });
        vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
        expect(tracker.status).toBe('stuck');
      });

      it('只有 Notification、沒有工具資訊時，主線工具結束也能離開', () => {
        toRunning();
        tracker.onHook('Notification', notification('permission_prompt'));
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe('running');
      });

      it('payload 沒有工具欄位時不當成不符', () => {
        waitForPermission();
        tracker.onHook(event, payload(event));
        expect(tracker.status).toBe('running');
      });

      it('主線並行的另一個工具結束：維持 waiting_permission', () => {
        waitForPermission(rmCall);
        tracker.onHook(event, payload(event, readCall));
        expect(tracker.status).toBe('waiting_permission');
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe('waiting_permission');
        tracker.onHook(event, payload(event, rmCall));
        expect(tracker.status).toBe('running');
      });

      it('輸入相同但工具不同：維持 waiting_permission', () => {
        const input = { file_path: '/tmp/x' };
        waitForPermission({ tool_name: 'Write', tool_input: input });
        tracker.onHook(event, payload(event, { tool_name: 'Read', tool_input: input }));
        expect(tracker.status).toBe('waiting_permission');
      });

      it('後到的 Notification 不會洗掉請求的工具資訊', () => {
        waitForPermission(rmCall);
        tracker.onHook('Notification', notification('permission_prompt'));
        tracker.onHook(event, payload(event, readCall));
        expect(tracker.status).toBe('waiting_permission');
      });

      it('子代理的工具結束：主線的權限請求維持 waiting_permission', () => {
        waitForPermission();
        tracker.onHook(event, payload(event, { ...lsCall, ...sub }));
        expect(tracker.status).toBe('waiting_permission');
      });

      it('子代理自己的請求被核准後，它的工具結束就離開', () => {
        waitForPermission({ ...lsCall, ...sub });
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe('waiting_permission');
        tracker.onHook(event, payload(event, { ...lsCall, agent_id: 'agent-2' }));
        expect(tracker.status).toBe('waiting_permission');
        tracker.onHook(event, payload(event, { ...lsCall, ...sub }));
        expect(tracker.status).toBe('running');
      });

      it('兩個請求都結束才離開', () => {
        waitForPermission({ ...lsCall, ...sub });
        tracker.onHook(
          'PermissionRequest',
          payload('PermissionRequest', { ...readCall, agent_id: 'agent-2' }),
        );
        tracker.onHook(event, payload(event, { ...lsCall, ...sub }));
        expect(tracker.status).toBe('waiting_permission');
        tracker.onHook(event, payload(event, { ...readCall, agent_id: 'agent-2' }));
        expect(tracker.status).toBe('running');
      });

      it('Notification 與 PermissionRequest 不論先後都算同一個請求', () => {
        toRunning();
        tracker.onHook('Notification', notification('permission_prompt'));
        tracker.onHook('PermissionRequest', payload('PermissionRequest', lsCall));
        tracker.onHook('Notification', notification('permission_prompt'));
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe('running');
      });

      it('上一輪留下的請求不影響下一輪', () => {
        waitForPermission(rmCall);
        tracker.onHook('Stop', payload('Stop')); // 使用者拒絕，工具沒跑。
        waitForPermission(lsCall);
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe('running');
      });

      it.each([
        ['plan_review', () => tracker.onHook('PermissionRequest', planRequest)],
        ['waiting_input', () => tracker.onHook('Stop', payload('Stop'))],
        [
          'rate_limited',
          () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' })),
        ],
        ['error', () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'x' }))],
      ] as const)('%s：主線或子代理的工具結束都維持原狀', (status, enter) => {
        toRunning();
        enter();
        tracker.onHook(event, payload(event, lsCall));
        expect(tracker.status).toBe(status);
        tracker.onHook(event, payload(event, { ...lsCall, ...sub }));
        expect(tracker.status).toBe(status);
      });

      it('stuck：工具結束代表還活著，回 running', () => {
        toRunning();
        vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
        tracker.onHook(event, payload(event, { ...lsCall, ...sub }));
        expect(tracker.status).toBe('running');
      });

      it('running：工具結束算有動靜，重新計 stuck', () => {
        toRunning();
        vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
        tracker.onHook(event, payload(event, lsCall));
        vi.advanceTimersByTime(1);
        expect(tracker.status).toBe('running');
      });

      it('starting：子代理不改狀態', () => {
        tracker.onHook(event, payload(event, { ...lsCall, ...sub }));
        expect(tracker.status).toBe('starting');
      });
    });

    describe('子代理的 PreToolUse', () => {
      it.each([
        ['plan_review', () => tracker.onHook('PermissionRequest', planRequest)],
        ['waiting_input', () => tracker.onHook('Stop', payload('Stop'))],
        [
          'rate_limited',
          () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' })),
        ],
        ['error', () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'x' }))],
      ] as const)('%s 維持原狀', (status, enter) => {
        toRunning();
        enter();
        tracker.onHook('PreToolUse', payload('PreToolUse', { ...toolCall, ...sub }));
        expect(tracker.status).toBe(status);
      });

      it('主線的權限請求還在等：維持 waiting_permission', () => {
        waitForPermission();
        tracker.onHook('PreToolUse', payload('PreToolUse', { ...toolCall, ...sub }));
        expect(tracker.status).toBe('waiting_permission');
      });

      it('自己的請求有結果（被拒後做下一步）：離開 waiting_permission', () => {
        waitForPermission({ ...lsCall, ...sub });
        tracker.onHook('PreToolUse', payload('PreToolUse', { ...readCall, ...sub }));
        expect(tracker.status).toBe('running');
      });

      it('stuck 回 running', () => {
        toRunning();
        vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
        tracker.onHook('PreToolUse', payload('PreToolUse', { ...toolCall, ...sub }));
        expect(tracker.status).toBe('running');
      });

      it('子代理的 PermissionRequest 仍然算等人決定', () => {
        toRunning();
        tracker.onHook('Stop', payload('Stop'));
        tracker.onHook('PermissionRequest', payload('PermissionRequest', { ...lsCall, ...sub }));
        expect(tracker.status).toBe('waiting_permission');
      });
    });

    describe('主線的 PreToolUse', () => {
      it.each([
        ['plan_review', () => tracker.onHook('PermissionRequest', planRequest)],
        ['waiting_input', () => tracker.onHook('Stop', payload('Stop'))],
        [
          'rate_limited',
          () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' })),
        ],
        ['error', () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'x' }))],
      ] as const)('%s 回 running', (_status, enter) => {
        toRunning();
        enter();
        tracker.onHook('PreToolUse', payload('PreToolUse', toolCall));
        expect(tracker.status).toBe('running');
      });

      it('waiting_permission 回 running，也清掉子代理留下的請求', () => {
        waitForPermission({ ...lsCall, ...sub });
        tracker.onHook('PreToolUse', payload('PreToolUse', toolCall));
        expect(tracker.status).toBe('running');
        tracker.onHook('PermissionRequest', payload('PermissionRequest', lsCall));
        tracker.onHook('PostToolUse', payload('PostToolUse', lsCall));
        expect(tracker.status).toBe('running');
      });
    });
  });

  describe('審計畫', () => {
    it('在終端機批准（工具跑完）就離開 plan_review', () => {
      tracker.onHook('PermissionRequest', planRequest);
      tracker.onHook(
        'PostToolUse',
        payload('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: 'one line' } }),
      );
      expect(tracker.status).toBe('running');
    });

    it('計畫被拒絕後的 Stop 是等你回覆，不是等你審計畫', () => {
      tracker.onHook('PermissionRequest', planRequest);
      tracker.onHook('Stop', payload('Stop', { permission_mode: 'plan' }));
      expect(tracker.status).toBe('waiting_input');
    });
  });

  describe('Notification 沒有 permission_mode', () => {
    it('交出計畫後的 idle_prompt 不會把 plan_review 蓋掉', () => {
      tracker.onHook('PermissionRequest', planRequest);
      tracker.onHook('Notification', notification('idle_prompt'));
      expect(tracker.status).toBe('plan_review');
    });

    it('Stop 沒有 permission_mode 視為非 plan', () => {
      tracker.onHook('Stop', { ...payload('Stop'), permission_mode: undefined });
      expect(tracker.status).toBe('waiting_input');
    });
  });

  describe('idle_prompt 不覆蓋更具體的原因', () => {
    it.each([
      ['rate_limit', 'rate_limited'],
      ['server_error', 'error'],
    ] as const)('StopFailure %s 之後維持 %s', (error, expected) => {
      tracker.onHook('StopFailure', payload('StopFailure', { error }));
      tracker.onHook('Notification', notification('idle_prompt'));
      expect(tracker.status).toBe(expected);
    });

    it.each(['running', 'stuck', 'waiting_permission'] as const)(
      '%s 收到 idle_prompt 變 waiting_input',
      (status) => {
        toRunning();
        if (status === 'stuck') vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
        if (status === 'waiting_permission') {
          tracker.onHook('Notification', notification('permission_prompt'));
        }
        expect(tracker.status).toBe(status);
        tracker.onHook('Notification', notification('idle_prompt'));
        expect(tracker.status).toBe('waiting_input');
      },
    );
  });

  describe('claudeSessionId', () => {
    it('從 hook 更新，/clear 換 id 時跟著換，且 /clear 不改狀態', () => {
      tracker.onHook('SessionStart', payload('SessionStart', { source: 'startup' }));
      expect(tracker.claudeSessionId).toBe('claude-1');
      tracker.onHook(
        'SessionStart',
        payload('SessionStart', { source: 'clear', session_id: 'claude-2' }),
      );
      expect(tracker.claudeSessionId).toBe('claude-2');
      // 只有 startup 那次改了狀態，/clear 沒有。
      expect(changes.map((change) => change.reason)).toEqual(['hook:SessionStart:startup']);
    });

    it('任何事件的 session_id 都算', () => {
      tracker.onHook('Notification', { ...notification('auth_success'), session_id: 'claude-3' });
      expect(tracker.claudeSessionId).toBe('claude-3');
    });

    it('空字串不覆蓋', () => {
      tracker.onHook('SessionStart', payload('SessionStart'));
      tracker.onHook('SessionStart', payload('SessionStart', { session_id: '' }));
      expect(tracker.claudeSessionId).toBe('claude-1');
    });
  });

  describe('stuck', () => {
    it('只有輸出、畫面沒進展，還是會變 stuck（TUI 的計時器每秒重畫）', () => {
      toRunning();
      for (let i = 0; i < STUCK_MINUTES * 60; i += 1) {
        vi.advanceTimersByTime(1000);
        tracker.onOutput(`\x1b[2K✶ Osmosing… (${i}s · ↓ ${i * 3} tokens)`);
      }
      expect(tracker.status).toBe('stuck');
    });

    it('running 超過 stuckMinutes 沒輸出變 stuck', () => {
      toRunning();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
      expect(tracker.status).toBe('running');
      vi.advanceTimersByTime(1);
      expect(tracker.status).toBe('stuck');
      expect(last()).toMatchObject({ from: 'running', to: 'stuck', reason: 'timer:stuck' });
    });

    it('有輸出就重新計時', () => {
      toRunning();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
      tracker.onProgress();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
      expect(tracker.status).toBe('running');
      vi.advanceTimersByTime(1);
      expect(tracker.status).toBe('stuck');
    });

    it('running 中的 hook 也算有動靜', () => {
      toRunning();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
      tracker.onHook('PreToolUse', payload('PreToolUse', toolCall));
      vi.advanceTimersByTime(1);
      expect(tracker.status).toBe('running');
    });

    it('stuck 後有新輸出回 running，且會再次計時', () => {
      toRunning();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
      tracker.onProgress();
      expect(tracker.status).toBe('running');
      expect(last()).toMatchObject({ from: 'stuck', to: 'running', reason: 'output:resumed' });
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
      expect(tracker.status).toBe('stuck');
    });

    it('stuck 後收到 hook 回 running', () => {
      toRunning();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
      tracker.onHook('PreToolUse', payload('PreToolUse', toolCall));
      expect(tracker.status).toBe('running');
    });

    it.each(['starting', 'waiting_input', 'waiting_permission'] as const)(
      '%s 不會變 stuck',
      (status) => {
        if (status === 'waiting_input') {
          toRunning();
          tracker.onHook('Stop', payload('Stop'));
        }
        if (status === 'waiting_permission') {
          toRunning();
          tracker.onHook('PermissionRequest', payload('PermissionRequest'));
        }
        vi.advanceTimersByTime(STUCK_MINUTES * MINUTE * 10);
        expect(tracker.status).toBe(status);
      },
    );

    it('離開 running 再回來，從回來的時間開始算', () => {
      toRunning();
      tracker.onProgress();
      tracker.onHook('Stop', payload('Stop'));
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE * 2);
      toRunning();
      expect(tracker.status).toBe('running');
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
      expect(tracker.status).toBe('running');
    });

    it('setStuckMinutes 調短後已超時就變 stuck，用新的時間計算', () => {
      toRunning();
      vi.advanceTimersByTime(5 * MINUTE);
      tracker.setStuckMinutes(3);
      vi.advanceTimersByTime(0);
      expect(tracker.status).toBe('stuck');
    });

    it('setStuckMinutes 調長會延後', () => {
      toRunning();
      tracker.setStuckMinutes(20);
      vi.advanceTimersByTime(19 * MINUTE);
      expect(tracker.status).toBe('running');
      vi.advanceTimersByTime(MINUTE);
      expect(tracker.status).toBe('stuck');
    });

    it('setStuckMinutes 不接受非正數', () => {
      toRunning();
      tracker.setStuckMinutes(0);
      tracker.setStuckMinutes(Number.NaN);
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE - 1);
      expect(tracker.status).toBe('running');
      vi.advanceTimersByTime(1);
      expect(tracker.status).toBe('stuck');
    });

    it('超過 setTimeout 上限的 stuckMinutes 不會立刻觸發', () => {
      toRunning();
      tracker.setStuckMinutes(60 * 24 * 365);
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE * 100);
      expect(tracker.status).toBe('running');
    });

    it('用注入的 now 判斷時間，不看系統時鐘', () => {
      let clock = 0;
      const seen: StatusChange[] = [];
      const injected = createStatusTracker({
        stuckMinutes: 1,
        now: () => new Date(clock),
        onChange: (change) => seen.push(change),
      });
      injected.onHook('UserPromptSubmit', payload('UserPromptSubmit'));
      // 計時器到期但注入的時鐘沒走，不算超時。
      vi.advanceTimersByTime(MINUTE);
      expect(injected.status).toBe('running');
      clock = MINUTE;
      vi.advanceTimersByTime(MINUTE);
      expect(injected.status).toBe('stuck');
      expect(seen.at(-1)?.at).toEqual(new Date(MINUTE));
      injected.dispose();
    });

    it('計時器裡 onChange 丟例外不會往外炸', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const throwing = createStatusTracker({
        stuckMinutes: 1,
        onChange: (change) => {
          if (change.to === 'stuck') throw new Error('boom');
        },
      });
      throwing.onHook('UserPromptSubmit', payload('UserPromptSubmit'));
      expect(() => vi.advanceTimersByTime(MINUTE)).not.toThrow();
      expect(throwing.status).toBe('stuck');
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
      throwing.dispose();
    });
  });

  describe('限流的重置時間（§8-5 排隊放行用）', () => {
    it('StopFailure 先到、畫面訊息後到：補上帶重置時間的 detail，不改狀態也不重算等待時間', () => {
      toRunning();
      vi.advanceTimersByTime(1_000);
      tracker.onHook(
        'StopFailure',
        payload('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests' }),
      );
      const entered = last()!;
      vi.advanceTimersByTime(1_000);
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('rate_limited');
      expect(last()).toMatchObject({
        from: 'rate_limited',
        to: 'rate_limited',
        reason: 'output:rate-limit',
        detail: LIMIT_LINE,
      });
      expect(last()!.at).toEqual(entered.at);
    });

    it('detail 已經有重置時間就不再補；沒有重置時間的訊息也不補', () => {
      toRunning();
      tracker.onOutput(`${LIMIT_LINE}\n`);
      const count = changes.length;
      tracker.onOutput("You've hit your weekly limit · resets Nov 5, 3pm (Asia/Taipei)\n");
      expect(changes).toHaveLength(count);

      const other = createStatusTracker({ stuckMinutes: 1, onChange: (c) => changes.push(c) });
      other.onHook('UserPromptSubmit', payload('UserPromptSubmit'));
      other.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' }));
      const before = changes.length;
      other.onOutput('Usage limit reached\n');
      expect(changes).toHaveLength(before);
      other.dispose();
    });
  });

  describe('輸出偵測限流', () => {
    it('running 時符合 CLI 完整格式就算', () => {
      toRunning();
      tracker.onOutput(`${LIMIT_LINE}\r\n`);
      expect(tracker.status).toBe('rate_limited');
      expect(last()).toMatchObject({ reason: 'output:rate-limit', detail: LIMIT_LINE });
    });

    it.each([
      "You've hit your weekly limit · resets Nov 5, 3pm · progress saved",
      'Usage limit reached · limit resets 3pm',
      'Usage limit reached · continuing automatically at 3pm · esc to cancel',
    ])('running 時算：%s', (line) => {
      toRunning();
      tracker.onOutput(`${line}\n`);
      expect(tracker.status).toBe('rate_limited');
    });

    it('去 ANSI 後比對，含被切開的控制序列與行', () => {
      toRunning();
      tracker.onOutput("\u001b[31mYou've hit your 5-hour");
      tracker.onOutput(' limit \u001b');
      tracker.onOutput('[0m· resets 3pm\u001b[3');
      expect(tracker.status).toBe('running');
      tracker.onOutput('9m\r\n');
      expect(tracker.status).toBe('rate_limited');
    });

    it('游標移動視為換段，把訊息和下一段切開', () => {
      toRunning();
      tracker.onOutput(`\u001b[10;1H${LIMIT_LINE}\u001b[11;1Hnext line\n`);
      expect(tracker.status).toBe('rate_limited');
    });

    it('前面的介面裝飾可以略過', () => {
      toRunning();
      tracker.onOutput(`  ⎿  ${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('rate_limited');
    });

    // 寧可不報：這些都是 agent 工作時可能印出來的東西。
    it.each([
      'Added rate limit handling to the API client',
      'rate limit',
      'Rate limit exceeded',
      '429 Too Many Requests: rate limit',
      'Usage limit reached',
      "You've hit your limit",
      'if (msg.includes("You\'ve hit your 5-hour limit · resets 3pm")) {',
      "⏺ I'll detect `You've hit your limit · resets 3pm` from the output",
      "// You've hit your 5-hour limit · resets 3pm is what the CLI prints",
      '  12 + const LIMIT = "You\'ve hit your weekly limit · resets Monday";',
      'expect(line).toBe("Usage limit reached · limit resets 3pm")',
      "You've hit your fast limit · resets in 5m",
      'Usage limit reached · wrapping up',
    ])('running 時不算：%s', (line) => {
      toRunning();
      tracker.onOutput(`${line}\r\n`);
      expect(tracker.status).toBe('running');
    });

    it.each([
      'Usage limit reached',
      "You've hit your limit",
      "You've hit your monthly spend limit · your 5-hour limit resets 3pm",
      "You're out of usage credits",
    ])('非 running 時短訊息也算：%s', (line) => {
      toRunning();
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput(`${line}\n`);
      expect(tracker.status).toBe('rate_limited');
    });

    it.each([
      'we should handle the rate limit better',
      'Rate limit exceeded',
      'Usage limit reached · wrapping up',
      "You've hit your fast limit",
    ])('非 running 時也不算：%s', (line) => {
      toRunning();
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput(`${line}\n`);
      expect(tracker.status).toBe('waiting_input');
    });

    it('還沒結束的行不比對（可能只是長句的開頭）', () => {
      toRunning();
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput('Usage limit reached');
      expect(tracker.status).toBe('waiting_input');
      tracker.onOutput(' is a phrase we should handle\n');
      expect(tracker.status).toBe('waiting_input');
    });

    it('SessionStart 之後、開始工作之前的重繪不算（--resume）', () => {
      tracker.onHook('SessionStart', payload('SessionStart', { source: 'resume' }));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('waiting_input');
      tracker.onOutput('Usage limit reached\n');
      expect(tracker.status).toBe('waiting_input');
      toRunning();
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('waiting_input');
    });

    it('開始工作後的新限流訊息照常偵測', () => {
      tracker.onHook('SessionStart', payload('SessionStart', { source: 'resume' }));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      toRunning();
      tracker.onOutput("You've hit your weekly limit · resets Monday\n");
      expect(tracker.status).toBe('rate_limited');
    });

    it('--resume 重繪舊對話時（starting）不算，之後再次重繪也不算', () => {
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('starting');
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('waiting_input');
    });

    it('畫面重繪同一則舊訊息不會再次觸發', () => {
      toRunning();
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('rate_limited');
      toRunning();
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('waiting_input');
    });

    it('hook 已報限流時印出的訊息，之後重繪也不會再觸發', () => {
      tracker.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' }));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      toRunning();
      tracker.onHook('Stop', payload('Stop'));
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('waiting_input');
    });

    it('重置時間不同的新訊息會再次觸發', () => {
      toRunning();
      tracker.onOutput(`${LIMIT_LINE}\n`);
      toRunning();
      tracker.onOutput("You've hit your 5-hour limit · resets 8pm (Asia/Taipei)\n");
      expect(tracker.status).toBe('rate_limited');
    });

    it('stuck 時看到限流訊息變 rate_limited，不是回 running', () => {
      toRunning();
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('rate_limited');
      expect(changes.map((change) => change.to)).toEqual(['running', 'stuck', 'rate_limited']);
    });

    it('rate_limited 不會觸發 stuck', () => {
      toRunning();
      tracker.onOutput(`${LIMIT_LINE}\n`);
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE * 10);
      expect(tracker.status).toBe('rate_limited');
    });

    it('一直沒換行的大量輸出不會無限累積，之後的行照常比對', () => {
      toRunning();
      for (let i = 0; i < 100; i += 1) tracker.onOutput('x'.repeat(10_000));
      tracker.onOutput('\n');
      expect(tracker.status).toBe('running');
      tracker.onOutput(`${LIMIT_LINE}\n`);
      expect(tracker.status).toBe('rate_limited');
    });
  });

  describe('一般輸出不改變狀態', () => {
    it.each(['starting', 'waiting_input', 'waiting_permission'] as const)('%s', (status) => {
      if (status === 'waiting_input') tracker.onHook('Stop', payload('Stop'));
      if (status === 'waiting_permission') tracker.onHook('PermissionRequest', payload('Stop'));
      tracker.onOutput('some ordinary output\n');
      tracker.onOutput('');
      expect(tracker.status).toBe(status);
    });
  });

  describe('PTY 結束', () => {
    it('exit ≠ 0 變 error', () => {
      toRunning();
      tracker.onExit(137);
      expect(tracker.status).toBe('error');
      expect(last()).toMatchObject({ from: 'running', to: 'error', detail: 'exit code 137' });
    });

    it('exit 0 變 done', () => {
      toRunning();
      tracker.onExit(0);
      expect(tracker.status).toBe('done');
      expect(last()).toMatchObject({ from: 'running', to: 'done', reason: 'exit:0', detail: null });
    });

    describe.each<[SessionStatus, () => void]>([
      ['starting', () => undefined],
      ['running', () => toRunning()],
      [
        'stuck',
        () => {
          toRunning();
          vi.advanceTimersByTime(STUCK_MINUTES * MINUTE);
        },
      ],
      ['waiting_input', () => tracker.onHook('Stop', payload('Stop'))],
      [
        'waiting_permission',
        () => tracker.onHook('PermissionRequest', payload('PermissionRequest')),
      ],
      ['plan_review', () => tracker.onHook('PermissionRequest', planRequest)],
      [
        'rate_limited',
        () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'rate_limit' })),
      ],
      ['error', () => tracker.onHook('StopFailure', payload('StopFailure', { error: 'x' }))],
    ])('從 %s 退出', (status, enter) => {
      beforeEach(() => {
        enter();
        expect(tracker.status).toBe(status);
      });

      it('exit 0 變 done', () => {
        tracker.onExit(0);
        expect(tracker.status).toBe('done');
        expect(last()).toMatchObject({ from: status, to: 'done', reason: 'exit:0' });
      });

      it('exit ≠ 0 變 error', () => {
        const before = changes.length;
        tracker.onExit(1);
        expect(tracker.status).toBe('error');
        // 原本就是 error 時不重複發事件。
        expect(changes).toHaveLength(status === 'error' ? before : before + 1);
      });
    });

    describe.each([
      ['done', 0],
      ['error', 1],
    ] as const)('退出成 %s 之後', (expected, exitCode) => {
      const hookEvents: [HookEventName, HookPayload][] = [
        ['SessionStart', payload('SessionStart', { source: 'startup', session_id: 'late' })],
        ['UserPromptSubmit', payload('UserPromptSubmit', { session_id: 'late' })],
        ['PreToolUse', payload('PreToolUse', { ...toolCall, session_id: 'late' })],
        ['PermissionRequest', payload('PermissionRequest', { session_id: 'late' })],
        ['PostToolUse', payload('PostToolUse', { ...toolCall, session_id: 'late' })],
        ['PostToolUseFailure', payload('PostToolUseFailure', { ...toolCall, session_id: 'late' })],
        ['Notification', { ...notification('permission_prompt'), session_id: 'late' }],
        ['Notification', { ...notification('idle_prompt'), session_id: 'late' }],
        ['Stop', payload('Stop', { session_id: 'late' })],
        ['StopFailure', payload('StopFailure', { error: 'rate_limit', session_id: 'late' })],
        ['SessionEnd', payload('SessionEnd', { reason: 'exit', session_id: 'late' })],
      ];

      it.each(hookEvents)('遲到的 %s 被忽略', (event, hookPayload) => {
        toRunning();
        tracker.onExit(exitCode);
        const count = changes.length;
        tracker.onHook(event, hookPayload);
        expect(tracker.status).toBe(expected);
        expect(tracker.claudeSessionId).toBe('claude-1');
        expect(changes).toHaveLength(count);
      });

      it('輸出（含限流訊息）、再次 onExit、計時器都不改狀態', () => {
        toRunning();
        tracker.onExit(exitCode);
        const count = changes.length;
        tracker.onOutput('ordinary output\n');
        tracker.onOutput(`${LIMIT_LINE}\n`);
        tracker.onExit(exitCode === 0 ? 1 : 0);
        tracker.setStuckMinutes(1);
        vi.advanceTimersByTime(STUCK_MINUTES * MINUTE * 10);
        expect(vi.getTimerCount()).toBe(0);
        expect(tracker.status).toBe(expected);
        expect(changes).toHaveLength(count);
      });
    });
  });

  describe('dispose', () => {
    it('停止計時器，之後不再發事件', () => {
      toRunning();
      const count = changes.length;
      tracker.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(STUCK_MINUTES * MINUTE * 10);
      tracker.onHook('Stop', payload('Stop'));
      tracker.onExit(1);
      expect(tracker.status).toBe('running');
      expect(changes).toHaveLength(count);
    });
  });
});
