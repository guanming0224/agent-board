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
/**
 * 最後一個人離開後，PTY 回到預設尺寸前等多久。全尺寸頁、展開的卡關掉時 PTY 不該一直維持超大尺寸
 * （摘要卡的最後幾行是照 PTY 寬度排版的）；等一下是因為從畫布切到全尺寸頁會先退訂再馬上訂閱，
 * 立刻縮回去會讓 TUI 多重畫兩次。
 */
const IDLE_RESIZE_MS = 30_000;
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
  // 一定要明確帶：不帶的話 claude 會用使用者設定裡的預設模式（可能是 auto），
  // 畫面的放手線顯示「每步問你」，實際卻全部自己來。`default` 在 CLI 上叫 manual。
  args.push(
    '--permission-mode',
    input.permissionMode === 'default' ? 'manual' : input.permissionMode,
  );
  if (input.model) args.push('--model', input.model);
  args.push('--name', input.name);
  return args;
}

/** 畫面上最後幾行非空白的純文字。從 xterm 緩衝區讀，TUI 重繪時才不會拿到一堆殘段。 */
export function readLastLines(term: TerminalType, count = LAST_LINES): string[] {
  return withoutPromptBox(readScreen(term)).filter(Boolean).slice(-count);
}

function readScreen(term: TerminalType): string[] {
  const buffer = term.buffer.active;
  const stop = Math.max(0, buffer.length - LAST_LINES_SCAN);
  const screen: string[] = [];
  for (let y = stop; y < buffer.length; y += 1) {
    screen.push(buffer.getLine(y)?.translateToString(true).trimEnd() ?? '');
  }
  return screen;
}

/**
 * 畫面的指紋：拿掉會自己一直變的東西（計時、spinner、提示），剩下的變了才算有進展。
 * 實測 claude 2.1.316：長指令期間每秒重畫，15 秒有 15 次輸出，所以不能用「有沒有輸出」判斷卡住。
 */
export function screenFingerprint(lines: readonly string[]): string {
  const content = withoutPromptBox(lines);
  // spinner 那行以下都是動畫區：提示會輪換，長提示還會折行，所以整塊切掉，不逐行過濾。
  const spinner = content.findLastIndex((line) => /^\s*\S?\s*\p{L}+…/u.test(line));
  return (
    (spinner === -1 ? content : content.slice(0, spinner))
      // 執行中工具行前的 ⏺ 每 0.6 秒閃一次；時間會從 59s 變成 1m 0s，所以連單位一起拿掉。
      .map((line) =>
        line
          .replace(/^\s*[⏺●]?\s*/u, '')
          .replace(/\b\d+(?:\.\d+)?[hms]\b/g, '')
          .replace(/\d+/g, '')
          .replace(/\s+/g, ''),
      )
      .filter(Boolean)
      .join('\n')
  );
}

/** 字串取自 claude 2.1.316，換版比對不到就退回 starting，不會誤報。要讀渲染後的畫面：輸出裡是分散的游標移動。 */
const TRUST_PROMPT = /Yes, I trust this folder/;

const RULE_LINE = /^[\s─╌━-]+(?:\S+[\s─╌━-]+)?$/;

/**
 * 摘要卡要看對話，不是輸入框和狀態列。claude 的輸入框是一條橫線下面一行 `❯`；
 * 權限對話框的 `❯ 1. Yes` 上面不是橫線，所以不會被切掉。認不出來就原樣回傳。
 */
export function withoutPromptBox(lines: readonly string[]): string[] {
  for (let y = lines.length - 1; y > 0; y -= 1) {
    if (!/^\s*❯(\s|$)/.test(lines[y]!)) continue;
    if (!RULE_LINE.test(lines[y - 1]!)) continue;
    const above = lines.slice(0, y - 1);
    while (above.length > 0 && !above.at(-1)) above.pop();
    return above;
  }
  return [...lines];
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
  /** 沒人看之後多久回到預設尺寸；測試用。 */
  idleResizeMs?: number;
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
  private idleResizeTimer: NodeJS.Timeout | null = null;
  private exited: Promise<void>;
  private resolveExited: () => void = () => {};

  private status: SessionStatus;
  private statusDetail: string | null = null;
  private statusSince: string;
  private lastLines: string[] = [];
  private fingerprint = '';
  private lastOutputAt: string | null = null;
  private contextTokens: number | null = null;
  private endedAt: string | null = null;
  private exitCode: number | null = null;
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
      // hub 靠這個判斷是第一次得知結果；tracker 沒給原因時，已結束的 error 也要寫得出來。
      statusDetail:
        this.statusDetail ??
        (this.status === 'error' && this.exitCode !== null ? `exit code ${this.exitCode}` : null),
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
    this.cancelIdleResize();
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
    this.scheduleIdleResize();
  }

  write(data: string): void {
    if (this.alive) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cancelIdleResize();
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
    this.cancelIdleResize();
    if (this.killTimer) clearTimeout(this.killTimer);
    this.resolveExited();
    if (this.detached) return;

    this.endedAt = this.now().toISOString();
    // 使用者要求停止不算錯誤；被其他訊號殺掉才算。
    const code = this.stopRequested ? 0 : exitCode !== 0 ? exitCode : signal ? 128 + signal : 0;
    this.exitCode = code;
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

  private noteProgress(): void {
    if (this.termDisposed) return;
    const screen = readScreen(this.term);
    if (screen.some((line) => TRUST_PROMPT.test(line))) {
      this.guardTracker(() => this.tracker.onTrustPrompt());
    }
    const fingerprint = screenFingerprint(screen);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.guardTracker(() => this.tracker.onProgress());
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
      this.noteProgress();
      this.options.onRuntime(this.runtime());
    }, this.options.runtimeThrottleMs ?? RUNTIME_THROTTLE_MS);
    this.runtimeTimer.unref();
  }

  /** 沒人看時回到預設尺寸（見 IDLE_RESIZE_MS）。已經是預設尺寸就不用動。 */
  private scheduleIdleResize(): void {
    this.cancelIdleResize();
    if (!this.alive || this.termDisposed) return;
    if (this.term.cols === DEFAULT_COLS && this.term.rows === DEFAULT_ROWS) return;
    this.idleResizeTimer = setTimeout(() => {
      this.idleResizeTimer = null;
      if (this.subscription === 'none') this.resize(DEFAULT_COLS, DEFAULT_ROWS);
    }, this.options.idleResizeMs ?? IDLE_RESIZE_MS);
    this.idleResizeTimer.unref();
  }

  private cancelIdleResize(): void {
    if (this.idleResizeTimer) clearTimeout(this.idleResizeTimer);
    this.idleResizeTimer = null;
  }

  private disposeTerm(): void {
    this.cancelIdleResize();
    if (this.termDisposed) return;
    this.termDisposed = true;
    this.term.dispose();
  }
}
