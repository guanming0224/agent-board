// 單一 session：一個 PTY + 一個 headless xterm（畫面的權威來源）+ 狀態機。
import { createRequire } from 'node:module';
import type {
  DaemonToHub,
  HookEventName,
  HookPayload,
  PermissionMode,
  SessionRuntime,
  SessionStatus,
} from '@agent-board/protocol';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import type { Terminal as TerminalType } from '@xterm/headless';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { errorMessage, log } from './log';
import type { CreateStatusTracker, StatusChange, StatusTracker } from './status/types';

// 這兩個套件是 CJS，在 ESM 下沒有具名匯出。
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const SCROLLBACK_LINES = 5_000;
const LAST_LINES = 4;
const LAST_LINES_SCAN = 200;
const RUNTIME_THROTTLE_MS = 1_000;
const TERMINATE_GRACE_MS = 5_000;
const SHUTDOWN_GRACE_MS = 2_000;
/** prompt 和 Enter 分開送，黏在一起 TUI 可能當成貼上而不送出（未驗證，Phase 2 接真 claude 確認）。 */
const FIRST_PROMPT_ENTER_DELAY_MS = 100;
const SIGKILL = 9;

type TerminalMessage = Extract<DaemonToHub, { type: 'terminal.output' | 'terminal.snapshot' }>;

export interface ClaudeArgsInput {
  /** 新對話用 --session-id。 */
  newSessionId?: string;
  /** 接續對話用 --resume；優先於 newSessionId。 */
  resumeId?: string;
  permissionMode: PermissionMode;
  model: string | null;
  name: string;
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args: string[] = [];
  if (input.resumeId) args.push('--resume', input.resumeId);
  else if (input.newSessionId) args.push('--session-id', input.newSessionId);
  // default 不帶旗標：--help 列的是 manual，default 只有文件有寫（見筆記）。
  if (input.permissionMode !== 'default') args.push('--permission-mode', input.permissionMode);
  if (input.model) args.push('--model', input.model);
  args.push('--name', input.name);
  return args;
}

/** 畫面上最後幾行非空白的純文字。從 xterm 緩衝區讀，TUI 重繪時才不會拿到一堆殘段。 */
export function readLastLines(term: TerminalType, count = LAST_LINES): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  const stop = Math.max(0, buffer.length - LAST_LINES_SCAN);
  for (let y = buffer.length - 1; y >= stop && lines.length < count; y -= 1) {
    const text = buffer.getLine(y)?.translateToString(true).trimEnd();
    if (text) lines.unshift(text);
  }
  return lines;
}

export interface ManagedSessionOptions {
  id: string;
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  claudeSessionId: string;
  pendingFirstPrompt: string | null;
  stuckMinutes: number;
  createStatusTracker: CreateStatusTracker;
  now?: () => Date;
  runtimeThrottleMs?: number;
  terminateGraceMs?: number;
  onRuntime: (runtime: SessionRuntime) => void;
  onStatusChange: (change: StatusChange) => void;
  onTerminal: (message: TerminalMessage) => void;
  onClaudeSessionId: (claudeSessionId: string) => void;
  onFirstPromptSent: () => void;
  onExit: (exitCode: number) => void;
}

export class ManagedSession {
  readonly id: string;
  private readonly pty: IPty;
  private readonly term: TerminalType;
  private readonly serializer: SerializeAddonType;
  private readonly tracker: StatusTracker;
  private readonly now: () => Date;

  private seq = 0;
  private subscription: 'none' | 'pending' | 'live' = 'none';
  private subscribeToken = 0;
  private pendingSnapshots = 0;
  /** 快照產生前的輸出先留著，保證收方先收到快照。 */
  private held: Extract<TerminalMessage, { type: 'terminal.output' }>[] = [];

  private alive = true;
  private stopRequested = false;
  private detached = false;
  private termDisposed = false;
  private trackerDisposed = false;
  private killTimer: NodeJS.Timeout | null = null;
  private runtimeTimer: NodeJS.Timeout | null = null;
  private exited: Promise<void>;
  private resolveExited: () => void = () => {};

  private status: SessionStatus;
  private statusDetail: string | null = null;
  private statusSince: string;
  private lastLines: string[] = [];
  private lastOutputAt: string | null = null;
  private contextTokens: number | null = null;
  private endedAt: string | null = null;
  private claudeSessionId: string;
  private pendingFirstPrompt: string | null;

  constructor(private readonly options: ManagedSessionOptions) {
    this.id = options.id;
    this.now = options.now ?? (() => new Date());
    this.claudeSessionId = options.claudeSessionId;
    this.pendingFirstPrompt = options.pendingFirstPrompt;
    this.statusSince = this.now().toISOString();
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });

    this.term = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    this.status = 'starting';
    this.tracker = options.createStatusTracker({
      stuckMinutes: options.stuckMinutes,
      now: options.now,
      onChange: (change) => this.handleStatusChange(change),
    });
    this.status = this.tracker.status;

    try {
      this.pty = spawnPty(options.bin, options.args, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      this.tracker.dispose();
      this.disposeTerm();
      throw error;
    }
    this.pty.onData((data) => this.handleData(data));
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? 0));
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get currentClaudeSessionId(): string {
    return this.claudeSessionId;
  }

  runtime(): SessionRuntime {
    return {
      id: this.id,
      cwd: this.options.cwd,
      branch: this.options.branch,
      worktreePath: this.options.worktreePath,
      status: this.status,
      statusDetail: this.statusDetail,
      claudeSessionId: this.claudeSessionId,
      lastLines: this.lastLines,
      lastOutputAt: this.lastOutputAt,
      statusSince: this.statusSince,
      contextTokens: this.contextTokens,
      endedAt: this.endedAt,
    };
  }

  // ── hub 指令 ──────────────────────────────────────────────

  /** 冪等：hub 可能重送，每次都回一份新快照（第二個瀏覽器加入、慢 client、重連）。 */
  subscribe(): void {
    if (this.termDisposed) return;
    const token = this.subscribeToken;
    this.subscription = 'pending';
    this.pendingSnapshots += 1;
    const seq = this.seq;
    // xterm 的 write 是非同步的。這個 callback 跑的當下，緩衝區剛好反映到 seq 為止的
    // 所有輸出（FIFO，下一塊還沒解析），快照與序號才對得上。
    this.term.write('', () => {
      if (token !== this.subscribeToken || this.termDisposed) return;
      this.options.onTerminal({
        type: 'terminal.snapshot',
        sessionId: this.id,
        seq,
        cols: this.term.cols,
        rows: this.term.rows,
        data: this.serializer.serialize({ scrollback: SCROLLBACK_LINES }),
      });
      this.pendingSnapshots -= 1;
      if (this.pendingSnapshots > 0) return;
      // 所有快照都送完才放行：任一份快照的持有者接著收到的都是連續的 seq，
      // 比快照舊的由收方丟棄（CONTRACTS §6.1）。
      for (const message of this.held) this.options.onTerminal(message);
      this.held = [];
      this.subscription = 'live';
    });
  }

  /** 全部 client 退訂；headless 繼續更新。 */
  unsubscribe(): void {
    this.subscribeToken += 1;
    this.pendingSnapshots = 0;
    this.subscription = 'none';
    this.held = [];
  }

  write(data: string): void {
    if (this.alive) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.alive) return;
    const safeCols = Math.min(cols, MAX_COLS);
    const safeRows = Math.min(rows, MAX_ROWS);
    this.pty.resize(safeCols, safeRows);
    // 排在已收到的輸出之後，那些輸出是照舊尺寸排版的。
    this.term.write('', () => {
      if (!this.termDisposed) this.term.resize(safeCols, safeRows);
    });
  }

  /** 使用者要求結束：SIGTERM，時間到還沒走就 SIGKILL。 */
  terminate(): void {
    if (!this.alive || this.stopRequested) return;
    this.stopRequested = true;
    this.sendKill('SIGTERM');
    this.killTimer = setTimeout(
      () => this.forceKill(),
      this.options.terminateGraceMs ?? TERMINATE_GRACE_MS,
    );
    this.killTimer.unref();
  }

  /**
   * daemon 關閉：PTY 跟著結束，但不算 session 結束——不回報、不動本機清單，
   * 下次啟動才接得回來（CONTRACTS §3.2）。
   */
  async detachAndKill(): Promise<void> {
    this.detached = true;
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    this.disposeTracker();
    if (this.alive) {
      this.sendKill('SIGHUP');
      const killTimer = setTimeout(() => this.forceKill(), SHUTDOWN_GRACE_MS);
      await this.exited;
      clearTimeout(killTimer);
    }
    this.disposeTerm();
  }

  setStuckMinutes(minutes: number): void {
    if (this.alive) this.tracker.setStuckMinutes(minutes);
  }

  /** 釋放已結束 session 的畫面。 */
  dispose(): void {
    this.disposeTracker();
    this.disposeTerm();
  }

  // ── hook ─────────────────────────────────────────────────

  onHook(event: HookEventName, payload: HookPayload): void {
    if (!this.alive) return;
    try {
      this.tracker.onHook(event, payload);
    } catch (error) {
      log.error(`狀態機處理 hook ${event} 失敗：${errorMessage(error)}`);
    }
    const reported = this.tracker.claudeSessionId;
    if (reported && reported !== this.claudeSessionId) {
      this.claudeSessionId = reported;
      this.options.onClaudeSessionId(reported);
      this.scheduleRuntime();
    }
    if (event === 'SessionStart') {
      if (typeof payload.context_tokens === 'number' && payload.context_tokens >= 0) {
        this.contextTokens = Math.floor(payload.context_tokens);
        this.scheduleRuntime();
      }
      this.sendFirstPrompt();
    }
  }

  private sendFirstPrompt(): void {
    const prompt = this.pendingFirstPrompt;
    if (prompt === null) return;
    this.pendingFirstPrompt = null;
    this.pty.write(prompt);
    setTimeout(() => this.write('\r'), FIRST_PROMPT_ENTER_DELAY_MS).unref();
    this.options.onFirstPromptSent();
  }

  // ── PTY ──────────────────────────────────────────────────

  private handleData(data: string): void {
    if (this.detached) return;
    this.seq += 1;
    this.lastOutputAt = this.now().toISOString();
    this.safeTermWrite(data);
    this.guardTracker(() => this.tracker.onOutput(data));

    const message = {
      type: 'terminal.output',
      sessionId: this.id,
      seq: this.seq,
      data,
    } as const;
    if (this.subscription === 'live') this.options.onTerminal(message);
    else if (this.subscription === 'pending') this.held.push(message);

    this.scheduleRuntime();
  }

  /** xterm 積壓超過內部水位時 write 會丟例外；不能因此把 PTY 的讀取弄掛。 */
  private safeTermWrite(data: string, callback?: () => void): void {
    try {
      this.term.write(data, callback);
    } catch (error) {
      log.warn(`headless 寫入失敗（session ${this.id}）：${errorMessage(error)}`);
    }
  }

  private handleExit(exitCode: number, signal: number): void {
    this.alive = false;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.resolveExited();
    if (this.detached) return;

    this.endedAt = this.now().toISOString();
    // 使用者要求停止不算錯誤；被其他訊號殺掉才算。
    const code = this.stopRequested ? 0 : exitCode !== 0 ? exitCode : signal ? 128 + signal : 0;
    this.guardTracker(() => this.tracker.onExit(code));
    // 本機清單要立刻更新：若 daemon 下一刻就關閉，已結束的 session 不可被接回。
    this.options.onExit(code);

    // 等 headless 把剩下的輸出吃完，lastLines 才是最後的畫面。
    this.safeTermWrite('', () => {
      if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
      this.runtimeTimer = null;
      this.disposeTracker();
      if (this.detached || this.termDisposed) return;
      this.refreshLastLines();
      this.options.onRuntime(this.runtime());
    });
  }

  private disposeTracker(): void {
    if (this.trackerDisposed) return;
    this.trackerDisposed = true;
    this.guardTracker(() => this.tracker.dispose());
  }

  private sendKill(signal: 'SIGTERM' | 'SIGHUP'): void {
    try {
      // Windows 的 node-pty 不接受指定訊號。
      if (process.platform === 'win32') this.pty.kill();
      else this.pty.kill(signal);
    } catch (error) {
      log.warn(`送 ${signal} 失敗（session ${this.id}）：${errorMessage(error)}`);
    }
  }

  private forceKill(): void {
    if (!this.alive) return;
    try {
      if (process.platform === 'win32') {
        this.pty.kill();
      } else {
        // PTY 子程序是 session leader，pid 即 process group，連子程序一起收。
        process.kill(-this.pty.pid, SIGKILL);
      }
    } catch (error) {
      log.warn(`強制結束失敗（session ${this.id}）：${errorMessage(error)}`);
    }
  }

  // ── 狀態 ─────────────────────────────────────────────────

  private guardTracker(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      log.error(`狀態機例外（session ${this.id}）：${errorMessage(error)}`);
    }
  }

  private handleStatusChange(change: StatusChange): void {
    this.status = change.to;
    this.statusDetail = change.detail;
    this.statusSince = change.at.toISOString();
    if (this.detached) return;
    this.options.onStatusChange(change);
    this.refreshLastLines();
    this.options.onRuntime(this.runtime());
  }

  private refreshLastLines(): void {
    if (!this.termDisposed) this.lastLines = readLastLines(this.term);
  }

  private scheduleRuntime(): void {
    if (this.runtimeTimer || !this.alive) return;
    this.runtimeTimer = setTimeout(() => {
      this.runtimeTimer = null;
      if (!this.alive || this.detached) return;
      this.refreshLastLines();
      this.options.onRuntime(this.runtime());
    }, this.options.runtimeThrottleMs ?? RUNTIME_THROTTLE_MS);
    this.runtimeTimer.unref();
  }

  private disposeTerm(): void {
    if (this.termDisposed) return;
    this.termDisposed = true;
    this.term.dispose();
  }
}
