// 用量歷史（GM 2026-11-21「從始至今」）：掃機器上還在的全部對話紀錄（Claude＋Codex，不限 90 天），
// 算「日期（這台機器的時區）× 來源 × 模型」的四種 token。只讀本機檔案，不呼叫任何模型，不碰 Codex 的 auth.json。
//
// 增量快取（`<daemon 資料夾>/usage-history-cache.json`）：每個檔以「路徑的 sha256」為鍵（路徑本身含 session id
// 與專案資料夾，不寫進檔案），記大小、mtime、讀到哪個位元組、最後 256 位元組的雜湊，與這個檔的彙總數字
// （不存對話內容、不存 session、不存 cwd）：
// - 大小、mtime 都沒變：直接用快取。
// - 變大且讀過的最後 256 位元組沒變（JSONL 只會往後加）：從上次讀到的位置接著讀。
// - 變小、同大小但 mtime 變了、或尾巴對不上（被改寫）：整個檔重讀。
// - 檔案不見了：從快取拿掉（hub 已存的歷史不受影響，見 CONTRACTS §28）。
// 時區或快取格式不同就整份重來。
//
// 去重和 30／90 天的掃描（usage.ts）一樣：Claude 同一則回應（`message.id`＋`requestId`）、Codex 同一則事件
// （時間＋累計 total）跨檔只算一次、各欄取最大。快取裡有 key 的每一則各存一筆
// `[key 的 48 位元雜湊, 日期, 模型, 四個數字]`，彙總時才跨檔去重；沒有 key 的行直接累加成格子。
//
// 效能：逐塊（256KB）讀、逐行判斷，只有含用量關鍵字的行才 JSON.parse；每個檔之間讓出事件迴圈，
// 不擋其他工作；記憶體只放快取裡的數字（不放整個檔）。
import { createHash } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  shiftUsageDay,
  USAGE_HISTORY_MODEL_LIMIT,
  USAGE_HISTORY_RECENT_DAYS,
  USAGE_HISTORY_ROW_LIMIT,
  USAGE_HISTORY_VERSION,
  type UsageHistory,
  type UsageHistoryCell,
  type UsageHistoryRow,
  type UsageSource,
} from '@agent-board/protocol';
import {
  codexFile,
  dayFormatter,
  jsonlFiles,
  parseLine,
  systemTimeZone,
  type CodexReaderState,
  type FileReader,
  type Parsed,
} from './usage';

/** 快取格式版本：解析規則改了就加一，舊快取整份丟掉重掃。 */
export const USAGE_HISTORY_CACHE_VERSION = 2;
export const USAGE_HISTORY_CACHE_FILE = 'usage-history-cache.json';

const DAY_MS = 24 * 60 * 60_000;
const CHUNK_BYTES = 256 * 1024;
const TAIL_BYTES = 256;
/** 每列幾個數字：cells 是 [日期, 模型, 輸入, 輸出, 快取讀, 快取寫]；entries 前面多一個 key 雜湊。 */
const CELL = 6;
const ENTRY = 7;

/** 先擋掉不含這些字的行，省下 JSON.parse（和 usage.ts 的 parse 裡的預先檢查一致）。 */
const NEEDLES: Record<UsageSource, readonly string[]> = {
  claude: ['"usage"'],
  codex: ['"token_count"', '"turn_context"', '"session_meta"'],
};

interface FileEntry {
  size: number;
  mtimeMs: number;
  /** 讀過（已算進來）的位元組數；最後一行還沒寫完時會小於 size。 */
  offset: number;
  /** `offset` 前最多 256 位元組的 sha1（判斷檔案是不是只往後加）。 */
  tail: string;
  models: string[];
  cells: number[];
  entries: number[];
  /** Codex 讀到一半的狀態（模型、上一則 total；不存 cwd），接著讀時還原。 */
  codex?: { model: string; previousTotal: number | null };
}

interface CacheData {
  version: number;
  timeZone: string;
  /** 來源 → 路徑的 sha256 → 這個檔的彙總。 */
  sources: Record<UsageSource, Record<string, FileEntry>>;
}

/** 快取的鍵：路徑的 sha256（快取檔不留路徑；路徑裡有 session id 與專案資料夾）。 */
const pathKey = (file: string): string => createHash('sha256').update(file).digest('hex');

export interface UsageHistoryRoots {
  /** Claude 的帳號設定資料夾（掃 `<dir>/projects/**\/*.jsonl`）。 */
  claude: readonly string[];
  /** `$CODEX_HOME`（掃 `<dir>/sessions/**\/*.jsonl`）；null 不掃。 */
  codex: string | null;
}

export interface UsageHistoryStats {
  files: number;
  /** 沒變、直接用快取的檔。 */
  reused: number;
  /** 只往後加、接著讀的檔。 */
  appended: number;
  /** 新檔或被改寫、整個重讀的檔。 */
  rescanned: number;
  /** 快取裡有、但已經不在的檔。 */
  removed: number;
  bytesRead: number;
  ms: number;
}

export interface UsageHistoryScan {
  timeZone: string;
  cells: UsageHistoryCell[];
  /** 各來源目前掃得到的最早一天（沒有紀錄是 null）。 */
  earliest: Record<UsageSource, string | null>;
  stats: UsageHistoryStats;
}

const dayToNum = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const numToDay = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** key 的 48 位元雜湊（存成 JS 數字不失真；幾十萬則也幾乎不會撞）。 */
const keyHash = (key: string): number => createHash('md5').update(key).digest().readUIntBE(0, 6);

const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex').slice(0, 20);

const emptySources = (): CacheData['sources'] => ({ claude: {}, codex: {} });

function validEntry(value: unknown): value is FileEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.size === 'number' &&
    typeof e.mtimeMs === 'number' &&
    typeof e.offset === 'number' &&
    typeof e.tail === 'string' &&
    Array.isArray(e.models) &&
    Array.isArray(e.cells) &&
    e.cells.length % CELL === 0 &&
    Array.isArray(e.entries) &&
    e.entries.length % ENTRY === 0
  );
}

/** 讀快取；壞掉、版本或時區不同就當沒有。 */
async function loadCache(path: string, timeZone: string): Promise<CacheData> {
  const fresh: CacheData = {
    version: USAGE_HISTORY_CACHE_VERSION,
    timeZone,
    sources: emptySources(),
  };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fresh;
  }
  const data = raw as Partial<CacheData> | null;
  if (
    !data ||
    data.version !== USAGE_HISTORY_CACHE_VERSION ||
    data.timeZone !== timeZone ||
    typeof data.sources !== 'object' ||
    data.sources === null
  ) {
    return fresh;
  }
  for (const source of ['claude', 'codex'] as const) {
    const files = (data.sources as Record<string, unknown>)[source];
    if (typeof files !== 'object' || files === null) continue;
    for (const [file, entry] of Object.entries(files)) {
      if (validEntry(entry)) fresh.sources[source][file] = entry;
    }
  }
  return fresh;
}

async function readTail(path: string, end: number): Promise<string> {
  const start = Math.max(0, end - TAIL_BYTES);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return sha1(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/** 一個檔的彙總（讀的時候用 Map 找格子，存回快取時是平的數字陣列）。 */
class FileAggregate {
  readonly models: string[];
  readonly cells: number[];
  readonly entries: number[];
  private readonly modelIndex = new Map<string, number>();
  private readonly cellAt = new Map<string, number>();
  private readonly entryAt = new Map<number, number>();

  constructor(base?: FileEntry) {
    this.models = base ? [...base.models] : [];
    this.cells = base ? [...base.cells] : [];
    this.entries = base ? [...base.entries] : [];
    this.models.forEach((m, i) => this.modelIndex.set(m, i));
    for (let i = 0; i < this.cells.length; i += CELL) {
      this.cellAt.set(`${this.cells[i]}:${this.cells[i + 1]}`, i);
    }
    for (let i = 0; i < this.entries.length; i += ENTRY) this.entryAt.set(this.entries[i]!, i);
  }

  private model(name: string): number {
    let m = this.modelIndex.get(name);
    if (m === undefined) {
      m = this.models.length;
      this.models.push(name);
      this.modelIndex.set(name, m);
    }
    return m;
  }

  add(parsed: Parsed, day: number): void {
    const c = parsed.counts;
    if (parsed.key === null) {
      if (c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreationTokens === 0) return;
      const m = this.model(parsed.model);
      const k = `${day}:${m}`;
      let i = this.cellAt.get(k);
      if (i === undefined) {
        i = this.cells.length;
        this.cells.push(day, m, 0, 0, 0, 0);
        this.cellAt.set(k, i);
      }
      this.cells[i + 2]! += c.inputTokens;
      this.cells[i + 3]! += c.outputTokens;
      this.cells[i + 4]! += c.cacheReadTokens;
      this.cells[i + 5]! += c.cacheCreationTokens;
      return;
    }
    // 同一則回應拆成好幾行：各欄取最大，日期與模型用第一次看到的（模型沒寫的補上）。
    const hash = keyHash(parsed.key);
    const i = this.entryAt.get(hash);
    if (i === undefined) {
      this.entryAt.set(hash, this.entries.length);
      this.entries.push(
        hash,
        day,
        this.model(parsed.model),
        c.inputTokens,
        c.outputTokens,
        c.cacheReadTokens,
        c.cacheCreationTokens,
      );
      return;
    }
    const e = this.entries;
    e[i + 3] = Math.max(e[i + 3]!, c.inputTokens);
    e[i + 4] = Math.max(e[i + 4]!, c.outputTokens);
    e[i + 5] = Math.max(e[i + 5]!, c.cacheReadTokens);
    e[i + 6] = Math.max(e[i + 6]!, c.cacheCreationTokens);
    if (this.models[e[i + 2]!] === '' && parsed.model !== '') e[i + 2] = this.model(parsed.model);
  }
}

/**
 * 從 start 讀到檔尾，逐行交給 onLine（只有含關鍵字的行）。回傳讀完（算進來）的位元組位置：
 * 最後一行沒有換行時，只有完整的 JSON 才算讀完，寫到一半的留到下次。
 */
async function readLines(
  path: string,
  start: number,
  needles: readonly string[],
  onLine: (line: string) => void,
): Promise<{ consumed: number; bytes: number }> {
  const fh = await open(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = start;
    let consumed = start;
    // 還沒遇到換行的半行：先收成一串塊，看到換行才合併一次（很長的單行不會每塊都重新複製，避免 O(n²)）。
    let pending: Buffer[] = [];
    let pendingLength = 0;
    let bytes = 0;
    const handle = (slice: Buffer) => {
      for (const needle of needles) {
        if (slice.includes(needle)) {
          onLine(slice.toString('utf8'));
          return;
        }
      }
    };
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      bytes += bytesRead;
      const buf = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      let nl = buf.indexOf(10);
      if (nl !== -1 && pendingLength > 0) {
        const line = Buffer.concat([...pending, buf.subarray(0, nl)]);
        handle(line);
        consumed += pendingLength + nl + 1;
        pending = [];
        pendingLength = 0;
        lineStart = nl + 1;
        nl = buf.indexOf(10, lineStart);
      }
      while (nl !== -1) {
        if (nl > lineStart) handle(buf.subarray(lineStart, nl));
        consumed += nl + 1 - lineStart;
        lineStart = nl + 1;
        nl = buf.indexOf(10, lineStart);
      }
      if (lineStart < bytesRead) {
        // chunk 會被下一次讀覆蓋，剩下的半行要複製出來。
        pending.push(Buffer.from(buf.subarray(lineStart)));
        pendingLength += bytesRead - lineStart;
      }
    }
    if (pendingLength > 0) {
      const carry = Buffer.concat(pending);
      let complete = false;
      try {
        JSON.parse(carry.toString('utf8'));
        complete = true;
      } catch {
        // 還沒寫完：下次從這行開頭再讀。
      }
      if (complete) {
        handle(carry);
        consumed += carry.length;
      }
    }
    return { consumed, bytes };
  } finally {
    await fh.close();
  }
}

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface UsageHistoryScannerOptions {
  /** 日期用的時區；預設這台機器的時區（測試指定）。 */
  timeZone?: string;
}

/**
 * 全部時間的用量掃描器。同一時間只跑一次（重複呼叫拿到同一個 Promise）；快取放記憶體，掃完寫回檔案。
 */
export class UsageHistoryScanner {
  private cache: CacheData | null = null;
  private running: Promise<UsageHistoryScan> | null = null;
  private runningKey = '';

  constructor(
    private readonly cachePath: string,
    private readonly options: UsageHistoryScannerOptions = {},
  ) {}

  /** 同樣的 roots 正在掃就共用那一次；roots 不同（例如多了帳號資料夾）就排在後面重掃，不回舊結果。 */
  scan(roots: UsageHistoryRoots): Promise<UsageHistoryScan> {
    const key = JSON.stringify(roots);
    if (this.running && this.runningKey === key) return this.running;
    const previous = this.running?.catch(() => undefined) ?? Promise.resolve();
    const next = previous
      .then(() => this.run(roots))
      .finally(() => {
        if (this.running === next) this.running = null;
      });
    this.running = next;
    this.runningKey = key;
    return next;
  }

  private async run(roots: UsageHistoryRoots): Promise<UsageHistoryScan> {
    const started = performance.now();
    const timeZone = this.options.timeZone ?? systemTimeZone();
    if (!this.cache || this.cache.timeZone !== timeZone) {
      this.cache = await loadCache(this.cachePath, timeZone);
    }
    const cache = this.cache;
    const dayOf = dayFormatter(timeZone);
    const stats: UsageHistoryStats = {
      files: 0,
      reused: 0,
      appended: 0,
      rescanned: 0,
      removed: 0,
      bytesRead: 0,
      ms: 0,
    };
    let dirty = false;

    // 資料夾先換成真實路徑再去重（符號連結、/tmp 與 /private/tmp 這類別名不會算兩次）。
    const real = (dir: string) => realpath(dir).catch(() => dir);
    const claudeRoots = [...new Set(await Promise.all(roots.claude.map(real)))];
    const codexRoot = roots.codex === null ? null : await real(roots.codex);
    const lists: Record<UsageSource, string[]> = { claude: [], codex: [] };
    // 讀不到（不存在以外的錯）或這次沒掃（codex 是 null）：這個來源的快取一個都不刪，免得暫時的錯把整份清掉。
    const unstable: Record<UsageSource, boolean> = { claude: false, codex: codexRoot === null };
    for (const dir of claudeRoots) {
      for await (const file of jsonlFiles(join(dir, 'projects'), () => (unstable.claude = true))) {
        lists.claude.push(file);
      }
    }
    if (codexRoot !== null) {
      for await (const file of jsonlFiles(
        join(codexRoot, 'sessions'),
        () => (unstable.codex = true),
      )) {
        lists.codex.push(file);
      }
    }

    for (const source of ['claude', 'codex'] as const) {
      const files = [...new Set(lists[source])].sort();
      const known = cache.sources[source];
      const present = new Set(files.map(pathKey));
      for (const key of Object.keys(known)) {
        if (!present.has(key) && !unstable[source]) {
          delete known[key];
          stats.removed += 1;
          dirty = true;
        }
      }
      for (const file of files) {
        stats.files += 1;
        try {
          const changed = await this.updateFile(source, file, known, dayOf, stats);
          if (changed) dirty = true;
        } catch {
          // 讀到一半消失或沒有權限：這次略過，快取裡舊的照留（下次再試）。
        }
        await yieldLoop();
      }
    }

    if (dirty) await this.save(cache);
    const { cells, earliest } = assemble(cache);
    stats.ms = Math.round(performance.now() - started);
    return { timeZone, cells, earliest, stats };
  }

  /** 回傳快取有沒有變。 */
  private async updateFile(
    source: UsageSource,
    file: string,
    known: Record<string, FileEntry>,
    dayOf: (ms: number) => string,
    stats: UsageHistoryStats,
  ): Promise<boolean> {
    const info = await stat(file);
    const key = pathKey(file);
    const old = known[key];
    if (old && old.size === info.size && old.mtimeMs === info.mtimeMs) {
      stats.reused += 1;
      return false;
    }
    let base: FileEntry | undefined;
    if (old && info.size > old.size && old.offset > 0) {
      // 只往後加的話，讀過的最後一段不會變。
      if ((await readTail(file, old.offset)) === old.tail) base = old;
    }
    const start = base?.offset ?? 0;
    const agg = new FileAggregate(base);
    const reader: FileReader & { state?: () => CodexReaderState } =
      source === 'codex'
        ? codexFile(file, null, base?.codex ? { ...base.codex, cwd: null } : undefined)
        : { sessionId: null, parse: parseLine };
    const dayNums = new Map<string, number>();
    const { consumed, bytes } = await readLines(file, start, NEEDLES[source], (line) => {
      const parsed = reader.parse(line);
      // 沒有時間的行排不進哪一天（和細項一樣，只有 30 天總數算它）。
      if (!parsed || parsed.at === null) return;
      const day = dayOf(parsed.at);
      let n = dayNums.get(day);
      if (n === undefined) {
        n = dayToNum(day);
        dayNums.set(day, n);
      }
      agg.add(parsed, n);
    });
    stats.bytesRead += bytes;
    if (base) stats.appended += 1;
    else stats.rescanned += 1;
    const codexState = reader.state?.();
    known[key] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: consumed,
      tail: consumed > 0 ? await readTail(file, consumed) : '',
      models: agg.models,
      cells: agg.cells,
      entries: agg.entries,
      ...(codexState
        ? { codex: { model: codexState.model, previousTotal: codexState.previousTotal } }
        : {}),
    };
    return true;
  }

  private async save(cache: CacheData): Promise<void> {
    const tmp = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
      await rename(tmp, this.cachePath);
    } catch {
      // 寫不進去只影響下次重啟要重掃；記憶體裡照樣有。
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

/** 把快取彙總成「日期 × 來源 × 模型」：有 key 的跨檔去重（只出現在一個檔的直接加，重複的各欄取最大）。 */
function assemble(cache: CacheData): Pick<UsageHistoryScan, 'cells' | 'earliest'> {
  const out: UsageHistoryCell[] = [];
  const earliest: Record<UsageSource, string | null> = { claude: null, codex: null };
  for (const source of ['claude', 'codex'] as const) {
    const files = Object.keys(cache.sources[source]).sort();
    const entries = files.map((f) => cache.sources[source][f]!);
    const seen = new Set<number>();
    const dup = new Set<number>();
    for (const e of entries) {
      for (let i = 0; i < e.entries.length; i += ENTRY) {
        const h = e.entries[i]!;
        if (seen.has(h)) dup.add(h);
        else seen.add(h);
      }
    }
    seen.clear();
    const sums = new Map<string, UsageHistoryCell>();
    let minDay: number | null = null;
    const add = (day: number, model: string, i: number, o: number, r: number, w: number) => {
      if (i + o + r + w === 0) return;
      if (minDay === null || day < minDay) minDay = day;
      const key = `${day}\0${model}`;
      let cell = sums.get(key);
      if (!cell) {
        cell = {
          day: numToDay(day),
          source,
          model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        sums.set(key, cell);
      }
      cell.inputTokens += i;
      cell.outputTokens += o;
      cell.cacheReadTokens += r;
      cell.cacheCreationTokens += w;
    };
    const best = new Map<number, { day: number; model: string; c: number[] }>();
    for (const e of entries) {
      for (let i = 0; i < e.cells.length; i += CELL) {
        const c = e.cells;
        add(c[i]!, e.models[c[i + 1]!] ?? '', c[i + 2]!, c[i + 3]!, c[i + 4]!, c[i + 5]!);
      }
      for (let i = 0; i < e.entries.length; i += ENTRY) {
        const x = e.entries;
        const model = e.models[x[i + 2]!] ?? '';
        if (!dup.has(x[i]!)) {
          add(x[i + 1]!, model, x[i + 3]!, x[i + 4]!, x[i + 5]!, x[i + 6]!);
          continue;
        }
        const b = best.get(x[i]!);
        if (!b) {
          best.set(x[i]!, {
            day: x[i + 1]!,
            model,
            c: [x[i + 3]!, x[i + 4]!, x[i + 5]!, x[i + 6]!],
          });
          continue;
        }
        for (let k = 0; k < 4; k += 1) b.c[k] = Math.max(b.c[k]!, x[i + 3 + k]!);
        if (b.model === '' && model !== '') b.model = model;
      }
    }
    for (const b of best.values()) add(b.day, b.model, b.c[0]!, b.c[1]!, b.c[2]!, b.c[3]!);
    earliest[source] = minDay === null ? null : numToDay(minDay);
    out.push(
      ...[...sums.values()].sort((a, b) =>
        a.day < b.day ? -1 : a.day > b.day ? 1 : a.model < b.model ? -1 : 1,
      ),
    );
  }
  return { cells: out, earliest };
}

/** 這條 hub 連線送過什麼（連上時清空，所以每次連上都會回填一次全部）。 */
export interface HistorySendState {
  /** `來源\0日期\0模型` → 四個數字（送出成功後才記）。 */
  sent: Map<string, string>;
  /** 已經送過一次「全部日子」。 */
  complete: boolean;
}

export const newHistorySendState = (): HistorySendState => ({ sent: new Map(), complete: false });

export interface HistoryDelta {
  history: UsageHistory;
  /** 送出成功後呼叫，記下送了什麼。 */
  commit(): void;
}

/**
 * 決定這次要送哪些歷史列：還沒送過（hub 確認寫入）或數字變了的，加上最近 `USAGE_HISTORY_RECENT_DAYS` 天
 * （一定重送）。新的日子先送，一則最多 `limit` 列、`USAGE_HISTORY_MODEL_LIMIT` 個模型，放不下的下次再送。
 * 全部都送過了（第一次的回填完成）才標 complete。沒東西可送時也回傳一則 `rows: []`（hub 才知道這台是新 daemon、
 * 不拿 90 天細項寫歷史，CONTRACTS §28.2）。
 */
export function historyDelta(
  scan: Pick<UsageHistoryScan, 'timeZone' | 'cells'>,
  today: string,
  state: HistorySendState,
  limit = USAGE_HISTORY_ROW_LIMIT,
  id?: string,
): HistoryDelta {
  const recentFrom = shiftUsageDay(today, -(USAGE_HISTORY_RECENT_DAYS - 1));
  const sig = (c: UsageHistoryCell) =>
    `${c.inputTokens},${c.outputTokens},${c.cacheReadTokens},${c.cacheCreationTokens}`;
  const keyOf = (c: UsageHistoryCell) => `${c.source}\0${c.day}\0${c.model}`;
  const pending = scan.cells
    .filter((c) => c.day >= recentFrom || state.sent.get(keyOf(c)) !== sig(c))
    .sort((a, b) => (a.day > b.day ? -1 : a.day < b.day ? 1 : 0));
  const days: string[] = [];
  const dayIndex = new Map<string, number>();
  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const index = (list: string[], map: Map<string, number>, value: string) => {
    let i = map.get(value);
    if (i === undefined) {
      i = list.length;
      list.push(value);
      map.set(value, i);
    }
    return i;
  };
  const picked: UsageHistoryCell[] = [];
  const rows: UsageHistoryRow[] = [];
  for (const c of pending) {
    if (rows.length >= Math.max(0, limit)) break;
    // 模型名稱超過上限：這格留到下一則（新模型下次再送）。
    if (!modelIndex.has(c.model) && models.length >= USAGE_HISTORY_MODEL_LIMIT) continue;
    picked.push(c);
    rows.push([
      index(days, dayIndex, c.day),
      index(models, modelIndex, c.model),
      c.source === 'codex' ? 1 : 0,
      c.inputTokens,
      c.outputTokens,
      c.cacheReadTokens,
      c.cacheCreationTokens,
    ]);
  }
  const complete = !state.complete && picked.length === pending.length;
  return {
    history: {
      version: USAGE_HISTORY_VERSION,
      timeZone: scan.timeZone,
      today,
      complete,
      ...(id ? { id } : {}),
      days,
      models,
      rows,
    },
    commit() {
      for (const c of picked) state.sent.set(keyOf(c), sig(c));
      if (complete) state.complete = true;
    },
  };
}
