// 測試用狀態機：Agent B 的實作（src/status/）由 Lead 整合時接上。
import type { HookEventName, HookPayload, SessionStatus } from '@agent-board/protocol';
import type { CreateStatusTracker, StatusTracker, StatusTrackerOptions } from '../status/types';

export class StubTracker implements StatusTracker {
  status: SessionStatus = 'starting';
  claudeSessionId: string | null = null;
  readonly hooks: { event: HookEventName; payload: HookPayload }[] = [];
  readonly outputs: string[] = [];
  exitCode: number | null = null;
  stuckMinutes: number;
  disposed = false;

  constructor(private readonly options: StatusTrackerOptions) {
    this.stuckMinutes = options.stuckMinutes;
  }

  private change(to: SessionStatus, reason: string): void {
    const from = this.status;
    this.status = to;
    this.options.onChange({ from, to, reason, detail: null, at: new Date() });
  }

  onHook(event: HookEventName, payload: HookPayload): void {
    this.hooks.push({ event, payload });
    if (event === 'SessionStart') this.claudeSessionId = payload.session_id;
    if (event === 'UserPromptSubmit' || event === 'PreToolUse') {
      this.change('running', `hook:${event}`);
    }
    if (event === 'Stop') this.change('waiting_input', 'hook:Stop');
  }

  onOutput(data: string): void {
    this.outputs.push(data);
  }

  onExit(exitCode: number): void {
    this.exitCode = exitCode;
    if (exitCode !== 0) this.change('error', 'pty:exit');
  }

  setStuckMinutes(minutes: number): void {
    this.stuckMinutes = minutes;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function stubTrackerFactory(): { create: CreateStatusTracker; created: StubTracker[] } {
  const created: StubTracker[] = [];
  return {
    created,
    create: (options) => {
      const tracker = new StubTracker(options);
      created.push(tracker);
      return tracker;
    },
  };
}
