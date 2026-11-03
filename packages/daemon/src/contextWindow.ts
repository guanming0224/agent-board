// session 的 context 上限與目前用量。Claude Code 唯一直接給上限的地方是 statusLine 的
// `context_window.context_window_size`，但裝 statusLine 會蓋掉使用者自己的狀態列，還會讓
// TUI 收起 `esc to interrupt` 等提示，所以不用。改從模型 id 推：`[1m]` 結尾一定是 1M，
// 其他查下表。表與來源見 docs/claude-code-notes.md「Context 上限」；查不到就回 null，前端不顯示百分比。
import { open } from 'node:fs/promises';

export const CONTEXT_200K = 200_000;
export const CONTEXT_1M = 1_000_000;

/**
 * 不加 `[1m]` 時的上限，取自 claude 2.1.317 內建模型目錄的 `context.window`。
 * 新模型不在表上就是「不知道」，不要猜。比對時取最長的前綴，`claude-opus-5` 才不會吃掉 `claude-opus-5-5`。
 */
const MODEL_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ['claude-3-5-haiku', CONTEXT_200K],
  ['claude-3-5-sonnet', CONTEXT_200K],
  ['claude-3-7-sonnet', CONTEXT_200K],
  ['claude-haiku-4-5', CONTEXT_200K],
  ['claude-sonnet-4-0', CONTEXT_200K],
  ['claude-sonnet-4-5', CONTEXT_200K],
  ['claude-sonnet-4-6', CONTEXT_200K],
  ['claude-opus-4-0', CONTEXT_200K],
  ['claude-opus-4-1', CONTEXT_200K],
  ['claude-opus-4-5', CONTEXT_200K],
  ['claude-opus-4-6', CONTEXT_200K],
  ['claude-opus-4-7', CONTEXT_1M],
  ['claude-opus-4-8', CONTEXT_1M],
  ['claude-opus-5', CONTEXT_1M],
  ['claude-opus-5-5', CONTEXT_1M],
  ['claude-sonnet-5', CONTEXT_1M],
  ['claude-sonnet-5-5', CONTEXT_1M],
  ['claude-haiku-5-5', CONTEXT_1M],
  ['claude-fable-5', CONTEXT_1M],
  ['claude-fable-5-1', CONTEXT_1M],
  ['claude-mythos-5', CONTEXT_1M],
  ['claude-mythos-5-1', CONTEXT_1M],
];

const ONE_M_SUFFIX = /\[1m\]\s*$/i;

/**
 * 單一模型 id 的上限。認得 `[1m]` 結尾、日期後綴（`claude-opus-4-1-20250805`）與
 * 雲端供應商前綴（`us.anthropic.claude-...`）；別名（`opus`、`sonnet`）解析不了，回 null。
 */
export function contextWindowForModel(model: string | null | undefined): number | null {
  if (!model) return null;
  if (ONE_M_SUFFIX.test(model)) return CONTEXT_1M;
  const id = model.toLowerCase();
  let best: readonly [string, number] | null = null;
  for (const entry of MODEL_WINDOWS) {
    const at = id.indexOf(entry[0]);
    if (at === -1) continue;
    // 後面接的不能是版本號的延續（`claude-opus-5` 對 `claude-opus-5-5`）。
    const rest = id.slice(at + entry[0].length);
    if (/^-\d(?!\d{7})/.test(rest)) continue;
    if (!best || entry[0].length > best[0].length) best = entry;
  }
  return best?.[1] ?? null;
}

export interface ContextSources {
  /** hook 回報的目前模型（SessionStart 的 `model`），可能帶 `[1m]`。 */
  hookModel: string | null;
  /** 開 session 時指定的 `--model`，可能是別名或帶 `[1m]`。 */
  specModel: string | null;
  /** 對話紀錄裡最後一則回覆的 `message.model`（API 的 id，不會帶 `[1m]`）。 */
  transcriptModel: string | null;
  contextTokens: number | null;
}

/**
 * 依序採用：hook 的模型 → 對話紀錄的模型 → 指定的模型。指定 `[1m]` 時對話紀錄只會寫基本 id，
 * 所以只要 hook 或指定的模型帶 `[1m]` 就是 1M。用量已經超過 200k，上限一定是 1M。
 */
export function resolveContextWindow(sources: ContextSources): number | null {
  const declared = sources.hookModel ?? sources.specModel;
  let window =
    declared && ONE_M_SUFFIX.test(declared)
      ? CONTEXT_1M
      : (contextWindowForModel(sources.hookModel) ??
        contextWindowForModel(sources.transcriptModel) ??
        contextWindowForModel(sources.specModel));
  if (sources.contextTokens !== null && sources.contextTokens > CONTEXT_200K) {
    window = Math.max(window ?? 0, CONTEXT_1M);
  }
  return window;
}

/** 只讀對話紀錄結尾這麼多 bytes；最後一則回覆一定在這裡面。 */
const TAIL_BYTES = 256 * 1024;

export interface LastTurn {
  /** 最後一次 API 請求送出的 prompt 大小：input + cache 讀 + cache 寫（和 statusLine 的算法相同）。 */
  contextTokens: number;
  model: string | null;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** 對話紀錄（JSONL）裡最後一則有 usage 的助理回覆。讀不到、讀不懂都回 null，不丟例外。 */
export async function readLastTurn(transcriptPath: string): Promise<LastTurn | null> {
  let text: string;
  try {
    const file = await open(transcriptPath, 'r');
    try {
      const { size } = await file.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"usage"')) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const message = record.message as Record<string, unknown> | undefined;
      if (record.type !== 'assistant' || typeof message !== 'object' || message === null) continue;
      const usage = message.usage as Record<string, unknown> | undefined;
      if (typeof usage !== 'object' || usage === null) continue;
      // 子代理的回覆不算主線的 context。
      if (record.isSidechain === true) continue;
      // CLI 自己產生的訊息（例如限流、API 錯誤）usage 全是 0，不是真的請求。
      if (message.model === '<synthetic>') continue;
      const tokens =
        count(usage.input_tokens) +
        count(usage.cache_read_input_tokens) +
        count(usage.cache_creation_input_tokens);
      return {
        contextTokens: tokens,
        model: typeof message.model === 'string' ? message.model : null,
      };
    } catch {
      // 第一行可能被切在中間，或格式變了：往前找。
    }
  }
  return null;
}
