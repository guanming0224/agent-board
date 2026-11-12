// 從對話紀錄彙總用量。JSONL 的 usage 欄位格式未查證（docs/claude-code-notes.md「未驗證」），
// 全程容錯：讀不懂的行、檔案、資料夾一律略過，不可 crash。
// 同一次掃描算兩份：近 30 天總數（UsageSummary，頁首用）與細項（UsageDetail，「用量詳情」用：
// 每日 × 模型 × Claude session，日期用這台機器的時區）。只讀本機檔案，不呼叫任何模型。
// Codex 第二輪（GM 2026-11-12）：Codex 的對話紀錄（`$CODEX_HOME/sessions/` 底下的 rollout JSONL）用同一套彙總，
// 另外算一份（scanCodexUsage）。只讀 sessions 資料夾，不碰 `auth.json`。
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  shiftUsageDay,
  USAGE_DETAIL_DAYS,
  USAGE_DETAIL_ROW_LIMIT,
  USAGE_DETAIL_SESSION_LIMIT,
  USAGE_DETAIL_VERSION,
  type UsageDetail,
  type UsageDetailRow,
  type UsageSummary,
} from '@agent-board/protocol';

type Usage = Omit<UsageSummary, 'machineId'>;
type Counts = Omit<Usage, 'from' | 'to'>;

const DAY_MS = 24 * 60 * 60_000;
/** 日期換算的快取粒度：時區偏移都是 15 分鐘的倍數，同一格一定同一天。 */
const DAY_CACHE_MS = 15 * 60_000;

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const zero = (): Counts => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

function addInto(target: Counts, counts: Counts): void {
  target.inputTokens += counts.inputTokens;
  target.outputTokens += counts.outputTokens;
  target.cacheReadTokens += counts.cacheReadTokens;
  target.cacheCreationTokens += counts.cacheCreationTokens;
}

const weight = (c: Counts) =>
  c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens;

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 行裡沒有 sessionId 時從檔名推：`<id>.jsonl`，或 subagent 的 `<id>/subagents/agent-*.jsonl`
 * （subagent 的用量算在叫它的 session 上）。推不出來是 null，併進「其他」。
 */
export function sessionIdFromPath(file: string): string | null {
  const name = basename(file, '.jsonl');
  if (UUID.test(name)) return name;
  const parent = dirname(file);
  if (basename(parent) === 'subagents') {
    const owner = basename(dirname(parent));
    if (UUID.test(owner)) return owner;
  }
  return null;
}

interface Parsed {
  key: string | null;
  at: number | null;
  model: string;
  sessionId: string | null;
  cwd: string | null;
  counts: Counts;
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** 同一則回應可能佔好幾行且 usage 相同，有 id 的同 key 只算一次（各欄取最大）。 */
function parseLine(line: string): Parsed | null {
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
    model: text(message.model, 200) ?? '',
    sessionId: text(record.sessionId, 200),
    cwd: text(record.cwd, 4096),
    counts: {
      inputTokens: tokenCount(u.input_tokens),
      outputTokens: tokenCount(u.output_tokens),
      cacheReadTokens: tokenCount(u.cache_read_input_tokens),
      cacheCreationTokens: tokenCount(u.cache_creation_input_tokens),
    },
  };
}

/** `YYYY-MM-DD` 往前推 n 天（protocol 的 shiftUsageDay）。 */
export const shiftDay = shiftUsageDay;

/** 把時間換成某時區的日期；同一個 15 分鐘格只算一次（一次掃描有幾十萬行）。 */
function dayFormatter(timeZone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const cache = new Map<number, string>();
  return (ms) => {
    const slot = Math.floor(ms / DAY_CACHE_MS);
    let day = cache.get(slot);
    if (day === undefined) {
      // en-CA 是 YYYY-MM-DD；保險起見只取數字重組。
      const parts = format.formatToParts(ms);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      day = `${get('year')}-${get('month')}-${get('day')}`;
      cache.set(slot, day);
    }
    return day;
  };
}

export const systemTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export interface UsageScanOptions {
  /** 頁首總數的區間（預設 30 天）。 */
  windowMs?: number;
  /** 細項保留幾個日曆日（含今天）。 */
  detailDays?: number;
  sessionLimit?: number;
  rowLimit?: number;
  /** 日期用的時區；預設這台機器的時區（測試指定）。 */
  timeZone?: string;
}

export interface UsageScan {
  summary: Usage;
  detail: UsageDetail;
  /** 給 log 與量測用。 */
  stats: { files: number; skippedFiles: number; lines: number; usageLines: number; ms: number };
}

interface Entry {
  day: string | null;
  inSummary: boolean;
  model: string;
  sessionId: string | null;
  counts: Counts;
}

/** 依 session 份量留前 N 個，其餘併成 -1；列數超過上限就再少留一點。 */
function encodeDetail(
  days: string[],
  cells: Map<string, Counts>,
  cellKeys: Map<string, { day: string; model: string; sessionId: string | null }>,
  cwdOf: Map<string, string | null>,
  sessionLimit: number,
  rowLimit: number,
): Pick<UsageDetail, 'models' | 'sessions' | 'otherSessions' | 'rows'> {
  const perSession = new Map<string, number>();
  for (const [key, counts] of cells) {
    const sessionId = cellKeys.get(key)!.sessionId;
    if (sessionId === null) continue;
    perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + weight(counts));
  }
  // 份量相同時照 id 排，結果才穩定。
  const ranked = [...perSession.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  let keep = Math.min(sessionLimit, ranked.length);
  for (;;) {
    const kept = new Map(ranked.slice(0, keep).map((id, i) => [id, i]));
    const models: string[] = [];
    const modelIndex = new Map<string, number>();
    const merged = new Map<string, UsageDetailRow>();
    for (const [key, counts] of cells) {
      const { day, model, sessionId } = cellKeys.get(key)!;
      const d = dayIndex.get(day);
      if (d === undefined) continue;
      let m = modelIndex.get(model);
      if (m === undefined) {
        m = models.length;
        models.push(model);
        modelIndex.set(model, m);
      }
      const s = sessionId === null ? -1 : (kept.get(sessionId) ?? -1);
      const rowKey = `${d}:${m}:${s}`;
      const row = merged.get(rowKey);
      if (row) {
        row[3] += counts.inputTokens;
        row[4] += counts.outputTokens;
        row[5] += counts.cacheReadTokens;
        row[6] += counts.cacheCreationTokens;
      } else {
        merged.set(rowKey, [
          d,
          m,
          s,
          counts.inputTokens,
          counts.outputTokens,
          counts.cacheReadTokens,
          counts.cacheCreationTokens,
        ]);
      }
    }
    if (merged.size <= rowLimit || keep === 0) {
      const rows = [...merged.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      // 全部併成「其他」仍放不下（天數 × 模型太多）：從最舊的日子丟，總數（summary）不受影響。
      const trimmed = rows.length > rowLimit ? rows.slice(rows.length - rowLimit) : rows;
      return {
        models,
        sessions: ranked.slice(0, keep).map((id) => ({ id, cwd: cwdOf.get(id) ?? null })),
        otherSessions: ranked.length - keep,
        rows: trimmed,
      };
    }
    keep = Math.floor(keep / 2);
  }
}

/**
 * 掃一次對話紀錄，同時算總數與細項。`now` 決定「今天」與區間終點。
 * 細項的日期範圍是 daemon 這台機器時區的最近 detailDays 個日曆日；總數維持「現在往前 30×24 小時」。
 */
export async function scanUsage(
  configDirs: readonly string[],
  now: Date,
  options: UsageScanOptions = {},
): Promise<UsageScan> {
  const files = async function* () {
    for (const configDir of new Set(configDirs)) yield* jsonlFiles(join(configDir, 'projects'));
  };
  return scanFiles(files(), claudeFile, now, options);
}

/** 一個對話紀錄檔的讀法：檔名推得出的 session，和逐行解析（Codex 要記住前面的行，所以每個檔案一份）。 */
interface FileReader {
  sessionId: string | null;
  parse(line: string): Parsed | null;
}

const claudeFile = (file: string): FileReader => ({
  sessionId: sessionIdFromPath(file),
  parse: parseLine,
});

async function scanFiles(
  files: AsyncIterable<string>,
  open: (file: string) => FileReader,
  now: Date,
  options: UsageScanOptions,
): Promise<UsageScan> {
  const started = performance.now();
  const windowMs = options.windowMs ?? 30 * DAY_MS;
  const detailDays = Math.max(1, options.detailDays ?? USAGE_DETAIL_DAYS);
  const timeZone = options.timeZone ?? systemTimeZone();
  const dayOf = dayFormatter(timeZone);
  const to = now.getTime();
  const from = to - windowMs;
  const today = dayOf(to);
  const firstDay = shiftDay(today, -(detailDays - 1));
  const days = Array.from({ length: detailDays }, (_, i) => shiftDay(firstDay, i));
  // 細項的第一天從那天的 00:00 起（最多早 1 天多）；檔案 mtime 比兩個區間都舊才跳過。
  const oldest = Math.min(from, to - detailDays * DAY_MS - DAY_MS);

  const total = zero();
  const cells = new Map<string, Counts>();
  const cellKeys = new Map<string, { day: string; model: string; sessionId: string | null }>();
  const cwdOf = new Map<string, string | null>();
  const keyed = new Map<string, Entry>();
  let earliest: number | null = null;
  const stats = { files: 0, skippedFiles: 0, lines: 0, usageLines: 0, ms: 0 };

  const addEntry = (entry: Entry) => {
    if (entry.inSummary) addInto(total, entry.counts);
    if (entry.day === null || weight(entry.counts) === 0) return;
    const cellKey = `${entry.day}\0${entry.model}\0${entry.sessionId ?? ''}`;
    let cell = cells.get(cellKey);
    if (!cell) {
      cell = zero();
      cells.set(cellKey, cell);
      cellKeys.set(cellKey, { day: entry.day, model: entry.model, sessionId: entry.sessionId });
    }
    addInto(cell, entry.counts);
  };

  {
    for await (const file of files) {
      try {
        // 整個檔案都比區間舊就不用開。
        if ((await stat(file)).mtimeMs < oldest) {
          stats.skippedFiles += 1;
          continue;
        }
        stats.files += 1;
        const reader = open(file);
        const fileSession = reader.sessionId;
        const lines = createInterface({
          input: createReadStream(file, 'utf8'),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          stats.lines += 1;
          const parsed = reader.parse(line);
          if (!parsed) continue;
          stats.usageLines += 1;
          if (parsed.at !== null && parsed.at > to) continue;
          const inSummary = parsed.at === null || parsed.at >= from;
          // 沒有時間的行：照舊算進總數，但排不進哪一天，不進細項。
          const day = parsed.at === null ? null : dayOf(parsed.at);
          const inDetail = day !== null && day >= firstDay;
          if (!inSummary && !inDetail) continue;
          if (parsed.at !== null && (earliest === null || parsed.at < earliest)) {
            earliest = parsed.at;
          }
          const sessionId = parsed.sessionId ?? fileSession;
          if (sessionId !== null && !cwdOf.has(sessionId) && parsed.cwd !== null) {
            cwdOf.set(sessionId, parsed.cwd);
          }
          const entry: Entry = {
            day: inDetail ? day : null,
            inSummary,
            model: parsed.model,
            sessionId,
            counts: parsed.counts,
          };
          if (parsed.key === null) {
            addEntry(entry);
            continue;
          }
          const seen = keyed.get(parsed.key);
          if (!seen) {
            keyed.set(parsed.key, entry);
            continue;
          }
          seen.counts = {
            inputTokens: Math.max(seen.counts.inputTokens, parsed.counts.inputTokens),
            outputTokens: Math.max(seen.counts.outputTokens, parsed.counts.outputTokens),
            cacheReadTokens: Math.max(seen.counts.cacheReadTokens, parsed.counts.cacheReadTokens),
            cacheCreationTokens: Math.max(
              seen.counts.cacheCreationTokens,
              parsed.counts.cacheCreationTokens,
            ),
          };
          if (seen.model === '' && parsed.model !== '') seen.model = parsed.model;
          if (seen.sessionId === null) seen.sessionId = sessionId;
        }
      } catch {
        // 讀到一半消失或沒有權限：略過這個檔案。
      }
    }
  }
  for (const entry of keyed.values()) addEntry(entry);

  const encoded = encodeDetail(
    days,
    cells,
    cellKeys,
    cwdOf,
    Math.max(0, options.sessionLimit ?? USAGE_DETAIL_SESSION_LIMIT),
    Math.max(1, options.rowLimit ?? USAGE_DETAIL_ROW_LIMIT),
  );
  stats.ms = Math.round(performance.now() - started);
  return {
    summary: { from: new Date(from).toISOString(), to: now.toISOString(), ...total },
    detail: {
      version: USAGE_DETAIL_VERSION,
      timeZone,
      days,
      earliestAt: earliest === null ? null : new Date(earliest).toISOString(),
      ...encoded,
    },
    stats,
  };
}

// ── Codex（Codex 第二輪，GM 2026-11-12）──────────────────

/** `rollout-<時間>-<thread id>.jsonl` 的 thread id（同 codex.ts 的 codexThreadIds）。 */
const CODEX_ROLLOUT_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * 一個 Codex rollout 檔的讀法（格式取自本機 codex-cli 0.130–0.167 的真實檔案，只看欄位結構）：
 * - `{"type":"session_meta","payload":{"cwd":…}}`：工作資料夾（第一個）。
 * - `{"type":"turn_context","payload":{"model":…}}`：之後的 token 算在這個模型上。
 * - `{"type":"event_msg","timestamp":…,"payload":{"type":"token_count","info":{"last_token_usage":{…},
 *   "total_token_usage":{…}}}}`：每次模型回應一則；`info` 可能是 null（只帶額度資訊）。
 *   同一個檔案裡 `total_token_usage.total_tokens` 和上一則一樣的是重複送的（實測 4,529 則裡 45 則），略過；
 *   其餘的 `last_token_usage` 加起來等於最後的 total（實測 144 個檔全部相等）。
 * - 0.167 起另有 `token_usage_record`，和 token_count 重複，不讀。
 * session 一律用檔名裡的 thread id（`Session.claudeSessionId` 存的就是它，§19.1）。讀不懂的行略過。
 */
export function codexFile(file: string, seen: Set<string> = new Set()): FileReader {
  let model = '';
  let cwd: string | null = null;
  let previousTotal: number | null = null;
  return {
    sessionId: CODEX_ROLLOUT_ID.exec(file)?.[1]?.toLowerCase() ?? null,
    parse(line) {
      // 多數行是對話內容，先擋掉省下 JSON.parse。
      if (
        !line.includes('"token_count"') &&
        !line.includes('"turn_context"') &&
        !line.includes('"session_meta"')
      ) {
        return null;
      }
      let row: Record<string, unknown> | null;
      try {
        row = record(JSON.parse(line));
      } catch {
        return null;
      }
      const payload = record(row?.payload);
      if (!row || !payload) return null;
      if (row.type === 'session_meta') {
        cwd ??= text(payload.cwd, 4096);
        return null;
      }
      if (row.type === 'turn_context') {
        model = text(payload.model, 200) ?? model;
        cwd ??= text(payload.cwd, 4096);
        return null;
      }
      if (row.type !== 'event_msg' || payload.type !== 'token_count') return null;
      const info = record(payload.info);
      const last = record(info?.last_token_usage);
      if (!info || !last) return null;
      const total = record(info.total_token_usage);
      const totalTokens = typeof total?.total_tokens === 'number' ? total.total_tokens : null;
      if (totalTokens !== null && totalTokens === previousTotal) return null;
      if (totalTokens !== null) previousTotal = totalTokens;
      // 審查 W10：fork／resume 出來的檔可能整段複製上一個檔的事件。整次掃描共用一份去重（時間＋累計 total）。
      if (typeof row.timestamp === 'string' && totalTokens !== null) {
        const key = `${row.timestamp}\0${totalTokens}`;
        if (seen.has(key)) return null;
        seen.add(key);
      }
      const input = tokenCount(last.input_tokens);
      const cached = Math.min(tokenCount(last.cached_input_tokens), input);
      const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      return {
        key: null,
        at: Number.isNaN(at) ? null : at,
        model,
        sessionId: null,
        cwd,
        counts: {
          // Codex 的 input 含快取讀（Claude 的不含）：拆開才和 Claude 的四欄同義。
          inputTokens: input - cached,
          // output 已含推理 token（reasoning_output_tokens 是其中一部分）。
          outputTokens: tokenCount(last.output_tokens),
          cacheReadTokens: cached,
          cacheCreationTokens: tokenCount(last.cache_write_input_tokens),
        },
      };
    },
  };
}

/** Codex 的對話紀錄（`<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl`）：和 Claude 一樣的總數與細項。 */
export async function scanCodexUsage(
  codexHome: string,
  now: Date,
  options: UsageScanOptions = {},
): Promise<UsageScan> {
  const seen = new Set<string>();
  return scanFiles(
    jsonlFiles(join(codexHome, 'sessions')),
    (file) => codexFile(file, seen),
    now,
    options,
  );
}

/** 只要總數（舊介面，測試沿用）。 */
export async function summarizeUsage(
  configDirs: readonly string[],
  from: Date,
  to: Date,
): Promise<Usage> {
  const { summary } = await scanUsage(configDirs, to, { windowMs: to.getTime() - from.getTime() });
  return summary;
}
