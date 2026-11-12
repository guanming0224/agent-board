// 交叉審查的執行（Codex 第二輪，docs/codex-round2-spec.md §2-2，CONTRACTS §22）。
// **no-llm 界線**（docs/no-llm-review.md「交叉審查」）：這是 daemon 唯一用非互動模式開 CLI 的地方
// （`claude -p`、`codex exec`），而且只在收到 hub 的 `review.run` 時跑；hub 只有在 GM 按確認或隊長呼叫
// `request_review` 時才送 `review.run`（scripts/check-no-llm.mjs 檢查呼叫點）。跑的是使用者自己登入的官方 CLI，
// 吃使用者自己的訂閱額度，和開一個 session 一樣；中控台不呼叫任何模型 API、不讀任何憑證。
// 兩邊都唯讀：Claude 用 plan 模式並拿掉改檔工具；Codex 用唯讀沙盒、從不詢問。一邊失敗、逾時不影響另一邊。
import { spawn, type ChildProcess } from 'node:child_process';
import {
  REVIEW_INSTRUCTIONS,
  REVIEW_OUTPUT_MAX_CHARS,
  REVIEW_PREPARED_TTL_MS,
  REVIEW_TIMEOUT_MS,
  type AgentKind,
  type DaemonToHub,
  type HubToDaemon,
  type ReviewSide,
} from '@agent-board/protocol';
import { codexProjectHookFiles } from './codex';
import { branchDiff, ReviewDiffError, sessionDiff, type ReviewDiffLimits } from './reviewDiff';

type PrepareRequest = Extract<HubToDaemon, { type: 'review.prepare' }>;
type RunRequest = Extract<HubToDaemon, { type: 'review.run' }>;
type SideMessage = Extract<DaemonToHub, { type: 'review.side' }>;

/** stdout 最多收多少（JSON／JSONL 事件），超過就不再收。 */
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;
/** 逾時先 SIGTERM，這麼久還在就 SIGKILL。 */
const KILL_GRACE_MS = 5_000;
/** 同時最多幾份審查在跑（每份兩個 CLI）。 */
export const REVIEW_CONCURRENCY = 2;

export interface ReviewRunnerDeps {
  claudeBin: string;
  codexBin: string | null;
  /** CLI 的環境變數（daemon 的 childEnv：已拿掉 daemon 自己的秘密）。 */
  env(): Record<string, string>;
  /** 送給 hub（斷線時留著，連回來 flush 再送）。 */
  send(message: SideMessage, onResult: (sent: boolean) => void): void;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  limits?: ReviewDiffLimits;
  now?(): number;
  log?: { warn(message: string): void; info(message: string): void };
}

/** Claude 審查端唯一可用的工具（只讀）。 */
export const CLAUDE_REVIEW_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** 一律拒絕的工具（第二層，`--tools` 已經只給讀檔工具）。 */
export const CLAUDE_REVIEW_DENIED = [
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'mcp__*',
] as const;

/**
 * Claude 那一邊的參數（審查 S2，claude 2.1.322 的 `--help` 確認過參數名）。層層唯讀：
 * - `--restricted`：拿掉跑指令的工具與 WebFetch、**不讀 user／project／local 設定檔**（repo 的 `.claude/settings*.json`
 *   裡的 hooks 不會載入）、檔案工具限在工作資料夾；
 * - `--tools Read,Grep,Glob`＋`--allowedTools`：可用的工具只有讀檔三個；`--disallowedTools` 再明列拒絕；
 * - `--strict-mcp-config --mcp-config {"mcpServers":{}}`：不載入任何 MCP server（含 repo 的 `.mcp.json`）；
 * - `--permission-mode plan`：第三層；`--no-session-persistence`：不留對話紀錄。
 * 在 repo 資料夾執行（模型要讀得到程式碼）：設定檔與 MCP 已經都不載入，所以不必另開暫存資料夾。
 * prompt 從 stdin 給（不在 argv，`ps` 看不到 diff）。
 */
export function claudeReviewArgs(model: string | null): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--restricted',
    '--tools',
    CLAUDE_REVIEW_TOOLS.join(','),
    '--allowedTools',
    ...CLAUDE_REVIEW_TOOLS,
    '--disallowedTools',
    ...CLAUDE_REVIEW_DENIED,
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
}

/** 推理強度只收這幾個字（不會被拿來注入別的設定）。 */
const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

/**
 * Codex 那一邊：`codex exec --json`、唯讀沙盒、從不詢問、不留對話紀錄（`--ephemeral`）、prompt 從 stdin（`-`）。
 * codex-cli 0.167 的 `exec` 沒有 `-a`（只有互動模式有），所以用設定覆寫 `approval_policy="never"`（同 `-a never`）。
 * 沒用 `--ignore-user-config`：會連使用者自己的 provider／登入相關設定一起略過（未驗證影響），先不帶。
 */
export function codexReviewArgs(model: string | null, effort: string | null): string[] {
  return [
    'exec',
    '--json',
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--skip-git-repo-check',
    '--ephemeral',
    ...(model ? ['-m', model] : []),
    ...(effort && CODEX_EFFORTS.has(effort) ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '-',
  ];
}

export const reviewPrompt = (diff: string): string =>
  `${REVIEW_INSTRUCTIONS}\n\n===== CHANGE UNDER REVIEW =====\n${diff}`;

const clipOutput = (text: string) =>
  text.length > REVIEW_OUTPUT_MAX_CHARS
    ? `${text.slice(0, REVIEW_OUTPUT_MAX_CHARS)}\n[... truncated ...]`
    : text;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

interface Parsed {
  output: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** `claude -p --output-format json` 的結果：一個 `{type:"result", is_error, result, usage}` 物件。 */
export function parseClaudeOutput(stdout: string): Parsed {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    data = parsed as Record<string, unknown>;
  } catch {
    return { output: null, error: 'unreadable output', inputTokens: null, outputTokens: null };
  }
  const usage = (typeof data.usage === 'object' && data.usage !== null ? data.usage : {}) as Record<
    string,
    unknown
  >;
  const result = typeof data.result === 'string' ? data.result : null;
  const failed =
    data.is_error === true || (data.subtype !== undefined && data.subtype !== 'success');
  return {
    output: failed ? null : result,
    error: failed
      ? (result ?? String(data.subtype ?? 'error'))
      : result === null
        ? 'empty result'
        : null,
    inputTokens:
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

/**
 * `codex exec --json` 的 JSONL 事件：最後一則 `item.completed`（item.type agent_message）的 text 是意見；
 * `turn.completed.usage` 是用量（input 含快取）；`turn.failed`／`error` 是失敗。讀不懂的行略過。
 * （事件格式取自官方文件與社群整理；未用真的 codex 0.167 驗證。）
 */
export function parseCodexOutput(stdout: string): Parsed {
  let output: string | null = null;
  let error: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = (
      typeof event.item === 'object' && event.item !== null ? event.item : {}
    ) as Record<string, unknown>;
    if (
      event.type === 'item.completed' &&
      (item.type === 'agent_message' || item.type === 'assistant_message') &&
      typeof item.text === 'string'
    ) {
      output = item.text;
    } else if (event.type === 'turn.completed') {
      const usage = (
        typeof event.usage === 'object' && event.usage !== null ? event.usage : {}
      ) as Record<string, unknown>;
      inputTokens = (inputTokens ?? 0) + count(usage.input_tokens);
      outputTokens = (outputTokens ?? 0) + count(usage.output_tokens);
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const err = (
        typeof event.error === 'object' && event.error !== null ? event.error : {}
      ) as Record<string, unknown>;
      const message =
        typeof err.message === 'string'
          ? err.message
          : typeof event.message === 'string'
            ? event.message
            : String(event.type);
      error = message;
    }
  }
  if (output === null && error === null) error = 'no review text in output';
  return {
    output: error !== null && output === null ? null : output,
    error: output ? null : error,
    inputTokens,
    outputTokens,
  };
}

interface Running {
  children: Set<ChildProcess>;
  cancelled: boolean;
}

export class ReviewRunner {
  private readonly prepared = new Map<string, { cwd: string; text: string; expiresAt: number }>();
  private readonly running = new Map<string, Running>();
  /** 還沒確定送到 hub 的結果（斷線時留著，連回來再送）。 */
  private readonly unsent = new Map<string, SideMessage>();

  constructor(private readonly deps: ReviewRunnerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 產生 diff（只跑 git，不跑模型），全文留在記憶體，回摘要。 */
  async prepare(
    message: PrepareRequest,
  ): Promise<Extract<DaemonToHub, { type: 'review.prepared' }>> {
    this.dropExpired();
    const base = {
      type: 'review.prepared' as const,
      requestId: message.requestId,
      reviewId: message.reviewId,
    };
    try {
      const diff =
        message.kind === 'session'
          ? await sessionDiff(message.cwd, this.deps.limits)
          : await branchDiff(
              message.cwd,
              message.branch ?? '',
              message.base ?? 'main',
              this.deps.limits,
            );
      this.prepared.set(message.reviewId, {
        cwd: message.cwd,
        text: diff.text,
        expiresAt: this.now() + REVIEW_PREPARED_TTL_MS,
      });
      return { ...base, diff: diff.summary, error: null };
    } catch (error) {
      const code =
        error instanceof ReviewDiffError ? `${error.code}: ${error.message}` : 'git_failed';
      return { ...base, diff: null, error: code };
    }
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, entry] of this.prepared) if (entry.expiresAt < now) this.prepared.delete(id);
  }

  /**
   * hub 的 `review.run`（GM 按了確認，或隊長呼叫了 request_review）。兩邊並行，各自回報。
   * 只有這個函式會開審查用的 CLI。
   */
  run(message: RunRequest): void {
    this.dropExpired();
    const entry = this.prepared.get(message.reviewId);
    this.prepared.delete(message.reviewId);
    const fail = (agent: AgentKind, error: string) =>
      this.report(message.reviewId, { ...blank(agent), status: 'failed', error });
    if (!entry) {
      fail('claude', 'prepared_diff_missing: prepare the review again');
      if (message.codex) fail('codex', 'prepared_diff_missing: prepare the review again');
      return;
    }
    if (this.running.size >= REVIEW_CONCURRENCY) {
      fail('claude', 'busy: too many reviews running on this machine');
      if (message.codex) fail('codex', 'busy: too many reviews running on this machine');
      return;
    }
    const state: Running = { children: new Set(), cancelled: false };
    this.running.set(message.reviewId, state);
    const prompt = reviewPrompt(entry.text);
    const env = this.deps.env();
    const sides: Promise<void>[] = [];
    sides.push(
      this.runSide(message.reviewId, state, {
        agent: 'claude',
        bin: this.deps.claudeBin,
        args: claudeReviewArgs(message.claude.model),
        model: message.claude.model,
        env: message.claude.accountProfile
          ? { ...env, CLAUDE_CONFIG_DIR: message.claude.accountProfile }
          : env,
        cwd: entry.cwd,
        prompt,
        parse: parseClaudeOutput,
      }),
    );
    const platform = this.deps.platform ?? process.platform;
    if (message.codex) {
      // 專案自己有 Codex hook 設定（.codex/hooks.json、config.toml）：codex exec 可能會執行它們，不跑（同 §19.2）。
      const projectHooks = codexProjectHookFiles(entry.cwd);
      if (platform === 'win32' || !this.deps.codexBin || projectHooks.length > 0) {
        // hub 已經擋了 Windows 與沒有 codex 的機器；這裡是保險。
        this.report(message.reviewId, {
          ...blank('codex'),
          status: 'skipped',
          error:
            platform === 'win32'
              ? 'windows: Codex is not available on Windows machines yet.'
              : !this.deps.codexBin
                ? 'codex_unavailable'
                : 'project_codex_hooks: this repository has its own .codex hook settings; Codex review was not run.',
        });
      } else {
        sides.push(
          this.runSide(message.reviewId, state, {
            agent: 'codex',
            bin: this.deps.codexBin,
            args: codexReviewArgs(message.codex.model, message.codex.effort),
            model: message.codex.model,
            env,
            cwd: entry.cwd,
            prompt,
            parse: parseCodexOutput,
          }),
        );
      }
    }
    void Promise.allSettled(sides).then(() => this.running.delete(message.reviewId));
  }

  cancel(reviewId: string): void {
    this.prepared.delete(reviewId);
    const state = this.running.get(reviewId);
    if (!state) return;
    state.cancelled = true;
    for (const child of state.children) killTree(child, 'SIGTERM');
  }

  /** daemon 關閉：跑到一半的全部結束（結果不會送了，hub 那邊逾時標失敗）。 */
  stopAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
    this.prepared.clear();
  }

  /** 連回 hub 之後補送沒送到的結果。 */
  flush(): void {
    for (const message of [...this.unsent.values()]) this.sendSide(message);
  }

  get activeCount(): number {
    return this.running.size;
  }

  private report(reviewId: string, side: ReviewSide): void {
    this.sendSide({ type: 'review.side', reviewId, side });
  }

  private sendSide(message: SideMessage): void {
    const key = `${message.reviewId}:${message.side.agent}`;
    this.unsent.set(key, message);
    this.deps.send(message, (sent) => {
      if (sent && this.unsent.get(key) === message) this.unsent.delete(key);
    });
  }

  private runSide(
    reviewId: string,
    state: Running,
    input: {
      agent: AgentKind;
      bin: string;
      args: string[];
      model: string | null;
      env: Record<string, string>;
      cwd: string;
      prompt: string;
      parse(stdout: string): Parsed;
    },
  ): Promise<void> {
    const started = this.now();
    const timeoutMs = this.deps.timeoutMs ?? REVIEW_TIMEOUT_MS;
    return new Promise<void>((resolve) => {
      let child: ChildProcess;
      const finish = (side: Omit<ReviewSide, 'agent' | 'model' | 'durationMs'>) => {
        this.report(reviewId, {
          ...side,
          agent: input.agent,
          model: input.model,
          durationMs: Math.max(0, Math.round(this.now() - started)),
        });
        resolve();
      };
      try {
        child = spawn(input.bin, input.args, {
          cwd: input.cwd,
          env: input.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // 自己一個程序群組：逾時、取消時整組結束（CLI 自己開的子程序一起）。
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        finish({ ...counts(null), status: 'failed', output: null, error: String(error) });
        return;
      }
      state.children.add(child);
      let stdout = '';
      let stdoutBytes = 0;
      let stderr = '';
      let timedOut = false;
      let settled = false;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes <= STDOUT_MAX_BYTES) stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
      // CLI 不讀 stdin 就結束時寫入會 EPIPE：不要讓它變成未捕捉的例外。
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input.prompt);
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);
      timer.unref();
      const done = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.children.delete(child);
        if (state.cancelled) {
          finish({ ...counts(null), status: 'failed', output: null, error: 'cancelled' });
          return;
        }
        if (timedOut) {
          finish({
            ...counts(null),
            status: 'timeout',
            output: null,
            error: `timed out after ${Math.round(timeoutMs / 1000)} s`,
          });
          return;
        }
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          finish({
            ...counts(null),
            status: 'failed',
            output: null,
            error: missing ? `${input.agent} CLI not found` : error.message,
          });
          return;
        }
        const parsed = input.parse(stdout);
        if (code !== 0 || parsed.output === null) {
          const tail = stderr.trim().split('\n').slice(-3).join(' ').trim();
          finish({
            ...counts(parsed),
            status: 'failed',
            output: parsed.output === null ? null : clipOutput(parsed.output),
            error: parsed.error ?? (tail || `exit code ${code}`),
          });
          return;
        }
        finish({
          ...counts(parsed),
          status: 'done',
          output: clipOutput(parsed.output),
          error: null,
        });
      };
      child.on('error', (error) => done(null, error));
      child.on('close', (code) => done(code));
    });
  }
}

const counts = (parsed: Parsed | null) => ({
  inputTokens: parsed?.inputTokens ?? null,
  outputTokens: parsed?.outputTokens ?? null,
});

const blank = (agent: AgentKind): ReviewSide => ({
  agent,
  status: 'pending',
  output: null,
  error: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  durationMs: null,
});

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已經結束。
    }
  }
}
