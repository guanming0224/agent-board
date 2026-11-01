// 從對話紀錄彙總用量。JSONL 的 usage 欄位格式未查證（docs/claude-code-notes.md「未驗證」），
// 全程容錯：讀不懂的行、檔案、資料夾一律略過，不可 crash。
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { UsageSummary } from '@agent-board/protocol';

type Usage = Omit<UsageSummary, 'machineId'>;
type Counts = Omit<Usage, 'from' | 'to'>;

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    // 符號連結不跟，避免繞圈。
    if (dirent.isDirectory()) yield* jsonlFiles(full);
    else if (dirent.isFile() && dirent.name.endsWith('.jsonl')) yield full;
  }
}

/** 同一則回應可能佔好幾行且 usage 相同，有 id 的同 key 只算一次（各欄取最大）。 */
function parseLine(line: string): { key: string | null; at: number | null; counts: Counts } | null {
  // 多數行沒有 usage，先擋掉省下 JSON.parse。
  if (!line.includes('"usage"')) return null;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = (
    typeof record.message === 'object' && record.message !== null ? record.message : {}
  ) as Record<string, unknown>;
  const usage = message.usage ?? record.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  const messageId = typeof message.id === 'string' ? message.id : null;
  return {
    key: messageId === null ? null : `${messageId}:${String(record.requestId ?? '')}`,
    at: Number.isNaN(at) ? null : at,
    counts: {
      inputTokens: tokenCount(u.input_tokens),
      outputTokens: tokenCount(u.output_tokens),
      cacheReadTokens: tokenCount(u.cache_read_input_tokens),
      cacheCreationTokens: tokenCount(u.cache_creation_input_tokens),
    },
  };
}

export async function summarizeUsage(
  configDirs: readonly string[],
  from: Date,
  to: Date,
): Promise<Usage> {
  const total: Counts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const add = (counts: Counts) => {
    total.inputTokens += counts.inputTokens;
    total.outputTokens += counts.outputTokens;
    total.cacheReadTokens += counts.cacheReadTokens;
    total.cacheCreationTokens += counts.cacheCreationTokens;
  };
  const keyed = new Map<string, Counts>();

  for (const configDir of new Set(configDirs)) {
    for await (const file of jsonlFiles(join(configDir, 'projects'))) {
      try {
        // 整個檔案都比區間舊就不用開。
        if ((await stat(file)).mtimeMs < from.getTime()) continue;
        const lines = createInterface({
          input: createReadStream(file, 'utf8'),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          const parsed = parseLine(line);
          if (!parsed) continue;
          if (parsed.at !== null && (parsed.at < from.getTime() || parsed.at > to.getTime())) {
            continue;
          }
          if (parsed.key === null) {
            add(parsed.counts);
            continue;
          }
          const seen = keyed.get(parsed.key);
          keyed.set(
            parsed.key,
            seen
              ? {
                  inputTokens: Math.max(seen.inputTokens, parsed.counts.inputTokens),
                  outputTokens: Math.max(seen.outputTokens, parsed.counts.outputTokens),
                  cacheReadTokens: Math.max(seen.cacheReadTokens, parsed.counts.cacheReadTokens),
                  cacheCreationTokens: Math.max(
                    seen.cacheCreationTokens,
                    parsed.counts.cacheCreationTokens,
                  ),
                }
              : parsed.counts,
          );
        }
      } catch {
        // 讀到一半消失或沒有權限：略過這個檔案。
      }
    }
  }
  for (const counts of keyed.values()) add(counts);
  return { from: from.toISOString(), to: to.toISOString(), ...total };
}
