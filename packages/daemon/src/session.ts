// 單一 session：一個 PTY + 一個 headless xterm（畫面的權威來源）+ 狀態機。
import { createRequire } from 'node:module';
import type {
  AgentKind,
  DaemonToHub,
  HookEventName,
  HookPayload,
  PermissionMode,
  RepoInfo,
  SessionRuntime,
  SessionStatus,
} from '@agent-board/protocol';
import { ClaudeSessionId, READ_ONLY_DISALLOWED_TOOLS } from '@agent-board/protocol';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import type { Terminal as TerminalType } from '@xterm/headless';
import { readLastTurn, resolveContextWindow } from './contextWindow';
import { errorMessage, log } from './log';
import { localPtyBackend, type PtyAttachInfo, type PtyBackend, type PtyProcess } from './pty';
import type { SessionSnapshot, SessionSnapshotInput } from './sessionState';
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
/** 接回後微調尺寸讓 TUI 重畫（W7）：等重畫的上限，與「沒有新輸出多久算畫完」。 */
const REDRAW_MAX_WAIT_MS = 800;
const REDRAW_QUIET_MS = 150;
/** cols-1 之後等多久再改回（讓程式先讀到不同的尺寸）。 */
const REDRAW_STEP_MS = 100;
/** prompt 和 Enter 分開送，黏在一起 TUI 可能當成貼上而不送出（未驗證，Phase 2 接真 claude 確認）。 */
const FIRST_PROMPT_ENTER_DELAY_MS = 100;

type TerminalMessage = Extract<DaemonToHub, { type: 'terminal.output' | 'terminal.snapshot' }>;

export interface ClaudeArgsInput {
  /** 新對話用 --session-id。 */
  newSessionId?: string;
  /** 接續對話用 --resume；優先於 newSessionId。 */
  resumeId?: string;
  permissionMode: PermissionMode;
  model: string | null;
  name: string;
  /** 唯讀 session：拿掉改檔工具（SessionSpec.readOnly）。 */
  readOnly?: boolean;
  /**
   * 派工工具（CONTRACTS §11）：`--mcp-config` 設定檔路徑與要事先允許的工具全名。設定關著就不給，
   * 完全不帶這兩個參數。不用 `--strict-mcp-config`：使用者自己的 MCP server 照常載入。
   */
  mcp?: { configPath: string; allowedTools: readonly string[] } | null;
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
  // `--disallowedTools <tools...>` 是可變長度參數：一個工具一個 argv，後面一定接著 --name
  // （另一個選項），參數才不會被吞掉。只擋這些工具，Bash 仍然寫得了檔案（CONTRACTS 團隊事件）。
  if (input.readOnly) args.push('--disallowedTools', ...READ_ONLY_DISALLOWED_TOOLS);
  if (input.model) args.push('--model', input.model);
  // 兩個都是可變長度參數：一個值一個 argv，最後一定接 --name，才不會吞到別的參數。
  // `--allowedTools` 只列設定開著的 agent-board 工具（派工 4 個、進度卡 2 個），不放寬任何其他工具
  // （docs/claude-code-notes.md、docs/no-llm-review.md）。
  if (input.mcp) {
    args.push('--mcp-config', input.mcp.configPath);
    if (input.mcp.allowedTools.length > 0) args.push('--allowedTools', ...input.mcp.allowedTools);
  }
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
/**
 * Codex 的資料夾信任畫面（未驗證：沒有在真的 codex 上看過，字串取自 codex 的 onboarding 文字）。
 * 認不出來就只是一直顯示啟動中，不會誤報。回答要使用者自己在終端機按，daemon 不替他選。
 */
const CODEX_TRUST_PROMPT =
  /Do you trust the contents of this directory|allow Codex to work in this folder/;
/** Codex 開好後畫面頂端的標題框（`>_ OpenAI Codex (v…)`，未驗證）。 */
const CODEX_READY = /OpenAI Codex/;
/** 看到 Codex 標題後再等多久還沒有 SessionStart，才自己標成「剛開好」（§19.3）。 */
const CODEX_READY_GRACE_MS = 3_000;

const RULE_LINE = /^[\s─╌━-]+(?:\S+[\s─╌━-]+)?$/;

/** 輸入框下面只會有橫線與一兩行狀態列；離最底下更遠的 `❯` 是舊畫面。 */
const INPUT_BOX_TAIL = 8;
/** 選單的選項（權限對話框、額度選單）：`❯ 1. Yes`。 */
const MENU_OPTION = /^\s*❯\s+\d+\./;
/** claude 工作中畫面上的提示（使用者設了 statusLine 時會被收起；只在 claude 2.1.x 看過，其他版本未驗證）。 */
const BUSY_HINT = /esc to interrupt/i;
/** 接回時看畫面最下面幾行判斷狀態。 */
const CORRECTION_TAIL = 15;

const KEEP_ON_DIALOG: readonly SessionStatus[] = [
  'waiting_permission',
  'plan_review',
  'rate_limited',
  'error',
];
const BUSY_FROM: readonly SessionStatus[] = [
  'waiting_input',
  'waiting_permission',
  'plan_review',
  'starting',
  'stuck',
];
const IDLE_FROM: readonly SessionStatus[] = [
  'running',
  'stuck',
  'waiting_permission',
  'plan_review',
  'starting',
];

/**
 * daemon 停機期間漏掉的 hook：接回後看畫面補正狀態（docs/session-host-spec.md §3.3-3、CONTRACTS §20.3）。
 * 對話框（`❯ 1. …`）＝等你允許；工作中提示＝跑；平常的輸入框＝等你回覆。只認 Claude Code 的畫面，
 * 認不出來回 null（維持快照的狀態，不誤報）。限流、錯誤遇到對話框不動（額度選單也是 `❯ 1.`）。
 */
export function screenCorrection(
  lines: readonly string[],
  status: SessionStatus,
): { to: SessionStatus; reason: string } | null {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end -= 1;
  const tail = lines.slice(Math.max(0, end - CORRECTION_TAIL), end);
  if (tail.some((line) => MENU_OPTION.test(line))) {
    return KEEP_ON_DIALOG.includes(status)
      ? null
      : { to: 'waiting_permission', reason: 'screen:dialog' };
  }
  if (tail.some((line) => BUSY_HINT.test(line))) {
    return BUSY_FROM.includes(status) ? { to: 'running', reason: 'screen:busy' } : null;
  }
  if (inputBoxVisible(lines)) {
    return IDLE_FROM.includes(status) ? { to: 'waiting_input', reason: 'screen:input-box' } : null;
  }
  return null;
}

/**
 * 畫面最下面是不是 claude 平常的輸入框（橫線下一行 `❯`）。對話框（權限、額度選單）出現時輸入框會被換掉，
 * 選項 `❯ 1. …` 上面也不是橫線。hub 只用它判斷限流中的 session 能不能送自動接續（CONTRACTS §3.5）。
 * 認不出來就是 false（不送）。
 */
export function inputBoxVisible(lines: readonly string[]): boolean {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]) end -= 1;
  for (let y = end - 1; y > 0 && y >= end - INPUT_BOX_TAIL; y -= 1) {
    const line = lines[y]!;
    if (MENU_OPTION.test(line)) return false;
    if (/^\s*❯(\s|$)/.test(line) && RULE_LINE.test(lines[y - 1]!)) return true;
  }
  return false;
}

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
  /** 跑的是哪個 CLI；不給＝Claude Code。只影響畫面上的提示比對（信任對話框、開好的畫面）。 */
  agent?: AgentKind;
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  branch: string | null;
  worktreePath: string | null;
  /** cwd 所在的 git working tree；不是 git 就是 null。 */
  repo?: RepoInfo | null;
  /** `--model` 指定的值，用來推 context 上限。 */
  model?: string | null;
  /** CLI 的對話 id。Codex 新開時還不知道（等 SessionStart 回報），是 null。 */
  claudeSessionId: string | null;
  pendingFirstPrompt: string | null;
  stuckMinutes: number;
  createStatusTracker: CreateStatusTracker;
  now?: () => Date;
  runtimeThrottleMs?: number;
  terminateGraceMs?: number;
  /** 沒人看之後多久回到預設尺寸；測試用。 */
  idleResizeMs?: number;
  /** 開 agent 用哪個 PTY 後端；不給＝daemon 自己開（舊模式）。 */
  backend?: PtyBackend;
  /**
   * 從 session host 接回還在跑的 session（CONTRACTS §20.3）：不開新程序，從緩衝開頭重播輸出重建畫面，
   * 再載入快照、用畫面補正。cols／rows 是 host 那邊 PTY 目前的尺寸。
   */
  reattach?: {
    snapshot: SessionSnapshot | null;
    cols: number;
    rows: number;
    /** 重播的逾時（daemon 依緩衝大小算，S2）；不給用後端的預設值。 */
    timeoutMs?: number;
  };
  onRuntime: (runtime: SessionRuntime) => void;
  onStatusChange: (change: StatusChange) => void;
  onTerminal: (message: TerminalMessage) => void;
  onClaudeSessionId: (claudeSessionId: string) => void;
  onFirstPromptSent: () => void;
  onExit: (exitCode: number) => void;
}

export class ManagedSession {
  readonly id: string;
  /** 開起來（或接回、重播完）了才 resolve；開不起來 reject。 */
  readonly ready: Promise<void>;
  private readonly pty: PtyProcess;
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
  /** 接回時正在重播舊輸出：只餵 headless 與限流偵測，不轉送、不算進度。 */
  private replaying = false;
  /** 最後一次收到輸出（不含重播）的時間，等重畫用。 */
  private lastDataAt = 0;
  /** agent 開起來的時間（快照記，重開前比對 pid 是不是同一個程序，S1）。 */
  private agentStartedAt: string | null = null;
  /** 重播中就收到結束（session 在 daemon 停機時結束了）：等快照載入後再處理。 */
  private pendingExit: { exitCode: number; signal: number } | null = null;
  private stopRequested = false;
  private detached = false;
  private termDisposed = false;
  private trackerDisposed = false;
  private killTimer: NodeJS.Timeout | null = null;
  private runtimeTimer: NodeJS.Timeout | null = null;
  private idleResizeTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private exited: Promise<void>;
  private resolveExited: () => void = () => {};

  private status: SessionStatus;
  private statusDetail: string | null = null;
  private statusSince: string;
  private lastLines: string[] = [];
  private inputReady = false;
  private fingerprint = '';
  private lastOutputAt: string | null = null;
  private contextTokens: number | null = null;
  private hookModel: string | null = null;
  private transcriptModel: string | null = null;
  /** 讀對話紀錄是非同步的；只採用最後一次發出的結果。 */
  private transcriptReads = 0;
  private endedAt: string | null = null;
  private exitCode: number | null = null;
  private claudeSessionId: string | null;
  private rejectedSessionId: string | null = null;
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

    const reattach = options.reattach ?? null;
    this.term = new Terminal({
      cols: reattach ? Math.min(reattach.cols, MAX_COLS) : DEFAULT_COLS,
      rows: reattach ? Math.min(reattach.rows, MAX_ROWS) : DEFAULT_ROWS,
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
    const snapshot = reattach?.snapshot ?? null;
    if (snapshot) {
      this.contextTokens = snapshot.contextTokens;
      this.hookModel = snapshot.hookModel;
      this.transcriptModel = snapshot.transcriptModel;
      this.lastOutputAt = snapshot.lastOutputAt;
      this.claudeSessionId ??= snapshot.claudeSessionId;
    }

    const backend = options.backend ?? localPtyBackend;
    try {
      if (reattach) {
        if (!backend.attach) throw new Error('這個 PTY 後端不能接回 session');
        this.replaying = true;
        this.pty = backend.attach(options.id, { timeoutMs: reattach.timeoutMs });
        this.agentStartedAt = snapshot?.agentStartedAt ?? null;
      } else {
        this.pty = backend.spawn({
          id: options.id,
          bin: options.bin,
          args: options.args,
          env: options.env,
          cwd: options.cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        });
        // 真的時間（不用注入的時鐘）：要和 ps 讀到的程序啟動時間比對。
        this.agentStartedAt = new Date().toISOString();
      }
    } catch (error) {
      this.tracker.dispose();
      this.disposeTerm();
      throw error;
    }
    this.pty.onData((data) => this.handleData(data));
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal));
    if (reattach) {
      const pty = this.pty;
      this.ready = new Promise<void>((resolve, reject) => {
        pty.ready.catch(reject);
        pty.onReplayDone?.((info) => this.finishReplay(info, snapshot, resolve));
      });
    } else {
      this.ready = this.pty.ready;
    }
    this.ready.catch(() => {});
  }

  /** 從 session host 開的（daemon 停掉時可以留著 agent）。 */
  get detachable(): boolean {
    return this.pty.detach !== undefined;
  }

  get agent(): AgentKind {
    return this.options.agent ?? 'claude';
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get currentClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  /** 最後一次輸出的時間（深層搜尋依新到舊排）。 */
  get lastOutput(): string | null {
    return this.lastOutputAt;
  }

  /**
   * 深層搜尋（P3 ③b）用：headless 畫面（含 scrollback，最多 5,000 行）的純文字，一個邏輯行一筆
   * （自動折行的接回上一行）。只在記憶體讀，不落地；畫面已釋放回 null。
   */
  screenLines(): string[] | null {
    if (this.termDisposed) return null;
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
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
      inputReady: this.inputReady,
      lastOutputAt: this.lastOutputAt,
      statusSince: this.statusSince,
      contextTokens: this.contextTokens,
      contextWindow: resolveContextWindow({
        hookModel: this.hookModel,
        specModel: this.options.model ?? null,
        transcriptModel: this.transcriptModel,
        contextTokens: this.contextTokens,
      }),
      repoRoot: this.options.repo?.root ?? null,
      repoCommonDir: this.options.repo?.commonDir ?? null,
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

  /**
   * daemon 關閉、agent 留在 session host 繼續跑（CONTRACTS §20.3）：不殺、不回報、不動本機清單；
   * 狀態快照由 daemon 先存好，下一個 daemon 接回。只有 detachable 的 session 能這樣做。
   */
  detach(): void {
    this.detached = true;
    if (this.runtimeTimer) clearTimeout(this.runtimeTimer);
    this.runtimeTimer = null;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.disposeTracker();
    this.pty.detach?.();
    this.disposeTerm();
  }

  /** 存檔用的狀態（不含審批，daemon 補上）。 */
  stateSnapshot(): Omit<
    SessionSnapshotInput,
    'pendingApprovalIds' | 'pendingApprovals' | 'approvalsHandedOff'
  > {
    return {
      agentPid: this.pty.pid > 0 ? this.pty.pid : null,
      agentStartedAt: this.agentStartedAt,
      version: 1,
      sessionId: this.id,
      savedAt: this.now().toISOString(),
      status: this.status,
      statusDetail: this.statusDetail,
      statusSince: this.statusSince,
      claudeSessionId: this.claudeSessionId,
      contextTokens: this.contextTokens,
      hookModel: this.hookModel,
      transcriptModel: this.transcriptModel,
      lastOutputAt: this.lastOutputAt,
    };
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
    if (this.syncClaudeSessionId()) this.scheduleRuntime();
    if (event === 'SessionStart') {
      if (typeof payload.context_tokens === 'number' && payload.context_tokens >= 0) {
        this.contextTokens = Math.floor(payload.context_tokens);
        this.scheduleRuntime();
      }
      // 文件：model 可能省略（/clear 之後、對話復原時），沒有就沿用舊值。
      if (typeof payload.model === 'string' && payload.model) {
        this.hookModel = payload.model;
        this.scheduleRuntime();
      }
      this.sendFirstPrompt();
    }
    // 回合結束時對話紀錄已寫好最後一則回覆：context 用量與實際模型從這裡更新。
    // SessionStart 只在 resume 時給 context_tokens，沒有這步新對話會一直沒有數值。
    if ((event === 'Stop' || event === 'StopFailure') && payload.transcript_path) {
      void this.refreshFromTranscript(payload.transcript_path);
    }
  }

  private async refreshFromTranscript(transcriptPath: string): Promise<void> {
    const ticket = (this.transcriptReads += 1);
    const turn = await readLastTurn(transcriptPath);
    if (!turn || ticket !== this.transcriptReads || !this.alive) return;
    this.contextTokens = turn.contextTokens;
    if (turn.model) this.transcriptModel = turn.model;
    this.scheduleRuntime();
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
    if (this.replaying) {
      // 重播的舊輸出：重建畫面；限流偵測要看過（記下舊訊息，之後重畫時不會當成新的）。
      this.seq += 1;
      this.safeTermWrite(data);
      this.guardTracker(() => this.tracker.onOutput(data));
      return;
    }
    this.lastDataAt = Date.now();
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

  /** 重播完：等 headless 吃完，載入快照、看畫面補正，再處理重播途中收到的結束。 */
  private finishReplay(
    info: PtyAttachInfo,
    snapshot: SessionSnapshot | null,
    done: () => void,
  ): void {
    this.safeTermWrite('', () => {
      this.replaying = false;
      if (this.detached || this.termDisposed) {
        done();
        return;
      }
      if (snapshot) this.restoreSnapshot(snapshot);
      const exit = this.pendingExit;
      this.pendingExit = null;
      if (exit || !info.alive) {
        this.refreshLastLines();
        done();
        if (exit) this.handleExit(exit.exitCode, exit.signal);
        return;
      }
      // 重播的是舊畫面：微調尺寸讓 TUI 整個重畫，等畫完再看畫面補正狀態（W7）。
      this.nudgeRedraw(() => {
        if (this.detached || this.termDisposed) {
          done();
          return;
        }
        if (this.alive) this.correctFromScreen();
        this.refreshLastLines();
        this.fingerprint = screenFingerprint(readScreen(this.term));
        done();
        if (this.alive) this.options.onRuntime(this.runtime());
      });
    });
  }

  /**
   * cols-1、等一下再改回，觸發兩次 SIGWINCH（兩次之間不等的話，程式讀到的尺寸沒變，Node／Ink 不會重畫）。
   * 改回之後有輸出、安靜一下（或到上限）就當畫完，等 headless 吃完再往下。
   */
  private nudgeRedraw(then: () => void): void {
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols < 3 || !this.alive) {
      then();
      return;
    }
    const resize = (c: number): boolean => {
      try {
        this.pty.resize(c, rows);
        return true;
      } catch (error) {
        log.warn(`接回後重畫失敗（session ${this.id}）：${errorMessage(error)}`);
        return false;
      }
    };
    if (!resize(cols - 1)) {
      then();
      return;
    }
    setTimeout(() => {
      if (!this.alive || this.detached || !resize(cols)) {
        this.safeTermWrite('', then);
        return;
      }
      const started = Date.now();
      const before = this.lastDataAt;
      const check = () => {
        const now = Date.now();
        const redrawn = this.lastDataAt > before && now - this.lastDataAt >= REDRAW_QUIET_MS;
        if (redrawn || now - started >= REDRAW_MAX_WAIT_MS || !this.alive || this.detached) {
          this.safeTermWrite('', then);
          return;
        }
        setTimeout(check, 30).unref();
      };
      setTimeout(check, 30).unref();
    }, REDRAW_STEP_MS).unref();
  }

  private restoreSnapshot(snapshot: SessionSnapshot): void {
    if (!this.tracker.restore) return;
    this.guardTracker(() =>
      this.tracker.restore!({
        status: snapshot.status,
        detail: snapshot.statusDetail,
        at: new Date(snapshot.statusSince),
        claudeSessionId: snapshot.claudeSessionId,
      }),
    );
    this.status = this.tracker.status;
    this.statusDetail = snapshot.statusDetail;
    this.statusSince = snapshot.statusSince;
  }

  /** 只認 Claude Code 的畫面；Codex 維持快照的狀態（它的畫面沒有實測過）。 */
  private correctFromScreen(): void {
    if (this.agent !== 'claude' || !this.tracker.correct) return;
    const screen = readScreen(this.term);
    if (screen.some((line) => TRUST_PROMPT.test(line))) {
      this.guardTracker(() => this.tracker.onTrustPrompt());
      return;
    }
    const correction = screenCorrection(screen, this.tracker.status);
    if (correction) {
      this.guardTracker(() => this.tracker.correct!(correction.to, correction.reason, null));
    }
  }

  private handleExit(exitCode: number, signal: number): void {
    if (this.replaying) {
      this.pendingExit = { exitCode, signal };
      return;
    }
    this.alive = false;
    this.cancelIdleResize();
    this.cancelReadyTimer();
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
    this.cancelReadyTimer();
    if (this.trackerDisposed) return;
    this.trackerDisposed = true;
    this.guardTracker(() => this.tracker.dispose());
  }

  private sendKill(signal: 'SIGTERM' | 'SIGHUP'): void {
    try {
      this.pty.kill(signal);
    } catch (error) {
      log.warn(`送 ${signal} 失敗（session ${this.id}）：${errorMessage(error)}`);
    }
  }

  private forceKill(): void {
    if (!this.alive) return;
    try {
      this.pty.kill('SIGKILL');
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

  /**
   * tracker 從 hook 讀到的對話 id 變了就記下來（`/clear` 之後；Codex 新開的 session 第一次知道 thread id）。
   * 狀態變化的 runtime 也要帶到新 id，所以 handleStatusChange 先同步一次。
   */
  private syncClaudeSessionId(): boolean {
    const reported = this.trackerDisposed ? null : this.tracker.claudeSessionId;
    if (!reported || reported === this.claudeSessionId) return false;
    // runtime 的 claudeSessionId 只收 UUID：不合格的送出去，hub 會整則拒收（tracker 已先擋，這裡再保險一次）。
    if (!ClaudeSessionId.safeParse(reported).success) {
      if (reported !== this.rejectedSessionId) {
        this.rejectedSessionId = reported;
        log.warn(`session ${this.options.id} 回報的對話 id 不是 UUID，忽略`);
      }
      return false;
    }
    this.claudeSessionId = reported;
    this.options.onClaudeSessionId(reported);
    return true;
  }

  private handleStatusChange(change: StatusChange): void {
    this.syncClaudeSessionId();
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
    const codex = this.options.agent === 'codex';
    const trust = codex ? CODEX_TRUST_PROMPT : TRUST_PROMPT;
    if (screen.some((line) => trust.test(line))) {
      this.guardTracker(() => this.tracker.onTrustPrompt());
    } else if (
      codex &&
      this.status === 'starting' &&
      !this.readyTimer &&
      screen.some((line) => CODEX_READY.test(line))
    ) {
      this.scheduleReady();
    }
    const fingerprint = screenFingerprint(screen);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.guardTracker(() => this.tracker.onProgress());
  }

  /** Codex 開好了但 SessionStart 還沒到：等一下，還在 starting 才自己標成「剛開好」。 */
  private scheduleReady(): void {
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (!this.alive || this.detached || this.status !== 'starting') return;
      const screen = this.termDisposed ? [] : readScreen(this.term);
      if (screen.some((line) => CODEX_TRUST_PROMPT.test(line))) return;
      this.guardTracker(() => this.tracker.onReadyScreen());
    }, CODEX_READY_GRACE_MS);
    this.readyTimer.unref();
  }

  private cancelReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private refreshLastLines(): void {
    if (this.termDisposed) return;
    const screen = readScreen(this.term);
    this.lastLines = withoutPromptBox(screen).filter(Boolean).slice(-LAST_LINES);
    this.inputReady = inputBoxVisible(screen);
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
