// 測試用狀態機：Agent B 的實作（src/status/）由 Lead 整合時接上。
import type { HookEventName, HookPayload, SessionStatus } from '@agent-board/protocol';
import type {
  CreateStatusTracker,
  StatusTracker,
  StatusTrackerOptions,
  TrackerRestoreState,
} from '../status/types';

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
    if (event === 'PermissionRequest') this.change('waiting_permission', 'hook:PermissionRequest');
    if (event === 'SessionStart') this.claudeSessionId = payload.session_id;
    if (event === 'UserPromptSubmit' || event === 'PreToolUse') {
      this.change('running', `hook:${event}`);
    }
    if (event === 'Stop') this.change('waiting_input', 'hook:Stop');
  }

  onProgress(): void {}

  onTrustPrompt(): void {}
  onReadyScreen(): void {}

  onOutput(data: string): void {
    this.outputs.push(data);
  }

  onExit(exitCode: number): void {
    // 和 B 的 tracker 一樣：dispose 之後的 onExit 會被忽略。
    if (this.disposed) return;
    this.exitCode = exitCode;
    this.change(exitCode === 0 ? 'done' : 'error', 'pty:exit');
  }

  setStuckMinutes(minutes: number): void {
    this.stuckMinutes = minutes;
  }

  dispose(): void {
    this.disposed = true;
  }

  restored: TrackerRestoreState | null = null;

  restore(state: TrackerRestoreState): void {
    this.restored = state;
    this.status = state.status;
    if (state.claudeSessionId) this.claudeSessionId = state.claudeSessionId;
  }

  correct(to: SessionStatus, reason: string): void {
    if (to !== this.status) this.change(to, reason);
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
