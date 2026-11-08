// 全域搜尋的深層（P3 ③b，docs/p3-spec.md §3.6、CONTRACTS §16）：在這台機器上搜活著的 session 的終端機畫面
// （headless xterm 的緩衝，只在記憶體）與 Claude Code 的對話紀錄 JSONL（本機磁碟）。只讀、只回片段：
// 不送任何字進 session、不對外連線、不在任何地方建索引或落地。
//
// 對話紀錄可達數十 MB、一台機器 7 天內可達數百 MB（實測一台約 400MB）：逐行串流讀，不整檔載入；
// 修改時間在時間範圍之前的檔不讀；每 session、每台的筆數上限、讀檔總量上限、時間上限（deadline），
// 到了就停並回報「只搜了 N／M 個 session」；取消時立刻停止讀檔。
// 和對話紀錄檢視（transcript.ts 的 readQueue，同時只讀一份）分開排隊：搜尋不會讓 GM 打開對話紀錄要等。
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  makeSnippet,
  type DaemonToHub,
  type DeepSearchTarget,
  type HubToDaemon,
  type SearchItem,
} from '@agent-board/protocol';
import { errorMessage, log } from './log';
import { maskSecrets } from './secretPatterns';
import { claudeConfigFor, findTranscriptFiles } from './sessionFiles';
import { MAX_LINE_CHARS, mayHaveEntries, parseLine } from './transcript';

export type SearchRequest = Extract<HubToDaemon, { type: 'search.request' }>;

/** 每讀幾行看一次時鐘與讀檔量（每行都看太貴）。取消旗標每行都看（只是讀一個布林）。 */
const CHECK_EVERY_LINES = 64;
/** 畫面切段：連續非空白行算一段，一段最多幾行（命中處前後的片段才不會跨太遠）。 */
const SCREEN_CHUNK_LINES = 20;
/** 讀檔的區塊大小：大一點，readline 與事件迴圈的來回少一點。 */
const READ_CHUNK_BYTES = 1024 * 1024;

export interface DeepSearchDeps {
  /** daemon 的預設 CLAUDE_CONFIG_DIR（session 沒帶 accountProfile 時用）。 */
  configDir: string;
  /** 活著的 session 的畫面（邏輯行）；不是這台的或已結束回 null。 */
  screen(sessionId: string): string[] | null;
  send(message: DaemonToHub): void;
  now?: () => number;
}

/** 一次搜尋的進度與上限。 */
interface Budget {
  readonly deadline: number;
  readonly maxBytes: number;
  bytes: number;
  cancelled: boolean;
}

type StopReason = 'deadline' | 'bytes' | 'cancelled';

export interface FileScan {
  /** 這份檔的命中（最新的 maxHits 筆，依序號由舊到新）。 */
  hits: SearchItem[];
  /** 實際讀了多少位元組。 */
  bytes: number;
  /** 提早停下的原因；讀完是 null。 */
  stopped: StopReason | null;
}

/** 字裡有 JSON 會跳脫的字元（引號、反斜線、控制字元）或大小寫轉換不對稱的字：原始 JSON 行裡長得不一樣，不拿來先篩。 */
function prefilterable(word: string): boolean {
  for (const ch of word) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === '\\' || code < 0x20 || ch === 'σ' || ch === 'ς') return false;
    if (ch.toLowerCase() !== ch) return false; // foldCase 保留原樣的字（小寫後會變長）
  }
  return true;
}

/**
 * 先篩：每個詞拆成單字（片語裡的空白在原文可能是換行），只要有一個單字不在這段文字裡就一定不符合。
 * 只會多放、不會漏（最後一律用 makeSnippet 確認）。
 */
export function makePrefilter(terms: readonly string[]): (text: string) => boolean {
  const words = [...new Set(terms.flatMap((t) => t.split(' ')).filter((w) => w !== ''))];
  const ascii = words.filter((w) => prefilterable(w) && /^[\x20-\x7e]*$/.test(w));
  const other = words.filter((w) => prefilterable(w) && !/^[\x20-\x7e]*$/.test(w));
  if (ascii.length === 0 && other.length === 0) return () => true;
  return (text) => {
    const lower = text.toLowerCase();
    if (!ascii.every((w) => lower.includes(w))) return false;
    // 非 ASCII 的字在 JSON 裡可能寫成 \uXXXX：有這種跳脫的行不篩。
    if (other.length > 0 && !other.every((w) => lower.includes(w)) && !text.includes('\\u')) {
      return false;
    }
    return true;
  };
}

/** 比對一段文字（遮蔽模式先遮好整段，金鑰不會被比對到、位置也是遮蔽後的）。 */
function matcher(terms: readonly string[], mask: boolean) {
  const quick = makePrefilter(terms);
  return (text: string): Pick<SearchItem, 'snippet' | 'matchRanges'> | null => {
    if (!quick(text)) return null;
    return makeSnippet(mask ? maskSecrets(text) : text, terms);
  };
}

/**
 * 搜一個 session 的畫面：連續非空白行切成一段（最多 SCREEN_CHUNK_LINES 行），由下（新）往上找，最多 max 筆。
 */
export function searchScreen(
  lines: readonly string[],
  terms: readonly string[],
  mask: boolean,
  max: number,
): Pick<SearchItem, 'snippet' | 'matchRanges'>[] {
  const match = matcher(terms, mask);
  const found: Pick<SearchItem, 'snippet' | 'matchRanges'>[] = [];
  let chunk: string[] = [];
  const flush = () => {
    if (chunk.length === 0 || found.length >= max) return;
    const hit = match(chunk.reverse().join('\n'));
    chunk = [];
    if (hit) found.push(hit);
  };
  for (let y = lines.length - 1; y >= 0 && found.length < max; y -= 1) {
    const line = lines[y]!.trimEnd();
    if (line === '') flush();
    else {
      chunk.push(line);
      if (chunk.length >= SCREEN_CHUNK_LINES) flush();
    }
  }
  flush();
  return found;
}

/**
 * 逐行串流讀一份 JSONL，序號（transcriptIndex）和對話紀錄檢視（readTranscriptFile）一樣算，⌘Enter 才捲得到那則。
 * sinceMs 之前的那幾則不算命中（還是要讀過才知道序號）。命中只留最新的 maxHits 筆。
 */
export async function scanTranscriptFile(
  file: string,
  sessionId: string,
  options: {
    terms: readonly string[];
    mask: boolean;
    sinceMs: number;
    maxHits: number;
    budget: Budget;
    now: () => number;
  },
): Promise<FileScan> {
  const { terms, mask, sinceMs, maxHits, budget, now } = options;
  const quick = makePrefilter(terms);
  const hits: SearchItem[] = [];
  const input = createReadStream(file, { encoding: 'utf8', highWaterMark: READ_CHUNK_BYTES });
  const opened = new Promise<boolean>((resolve) => {
    input.once('open', () => resolve(true));
    input.once('error', () => resolve(false));
  });
  if (!(await opened)) return { hits, bytes: 0, stopped: null }; // 剛好被刪掉之類
  const startBytes = budget.bytes;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let stopped: StopReason | null = null;
  let index = 0;
  let count = 0;
  try {
    for await (const line of lines) {
      if (budget.cancelled) {
        stopped = 'cancelled';
        break;
      }
      count += 1;
      if (count % CHECK_EVERY_LINES === 0) {
        budget.bytes = startBytes + input.bytesRead;
        if (now() > budget.deadline) {
          stopped = 'deadline';
          break;
        }
        if (budget.bytes > budget.maxBytes) {
          stopped = 'bytes';
          break;
        }
      }
      if (line.length > MAX_LINE_CHARS || !mayHaveEntries(line)) continue;
      // 序號要算到每一行的每一則，所以符合 type 的行一律解析；先篩只省下比對與擷取片段。
      const maybe = quick(line);
      for (const { raw, search } of parseLine(line)) {
        const at = index;
        index += 1;
        if (!maybe) continue;
        if (raw.at !== null && Date.parse(raw.at) < sinceMs) continue;
        if (!quick(search)) continue;
        const hit = makeSnippet(mask ? maskSecrets(search) : search, terms);
        if (!hit) continue;
        hits.push({
          kind: 'transcript',
          sessionId,
          ...hit,
          ...(raw.at !== null ? { at: raw.at } : {}),
          transcriptIndex: at,
        });
        if (hits.length > maxHits) hits.shift();
      }
    }
  } finally {
    budget.bytes = startBytes + input.bytesRead;
    lines.close();
    input.destroy();
  }
  return { hits, bytes: budget.bytes - startBytes, stopped };
}

/** 依最後活動時間新到舊；沒有時間的排最後。 */
const byActivity = (a: DeepSearchTarget, b: DeepSearchTarget) =>
  (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');

/**
 * 一台機器的深層搜尋。同一時間只跑一個（排隊）；取消的不回 result／done。
 * 和對話紀錄檢視的 readQueue 是兩條獨立的佇列，兩邊都是逐塊非同步讀，會交錯進行。
 */
export class DeepSearcher {
  private queue: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, Budget>();
  private readonly now: () => number;

  constructor(private readonly deps: DeepSearchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 收到 hub 的 search.request：排進佇列（等待的時間也算在 deadline 裡）。 */
  start(request: SearchRequest): Promise<void> {
    this.cancel(request.searchId);
    const budget: Budget = {
      deadline: this.now() + request.limits.deadlineMs,
      maxBytes: request.limits.maxBytes,
      bytes: 0,
      cancelled: false,
    };
    this.running.set(request.searchId, budget);
    const run = this.queue.then(async () => {
      if (budget.cancelled) return;
      try {
        await this.run(request, budget);
      } catch (error) {
        // 不讓 hub 乾等到逾時：當成這台只搜了一部分。
        log.warn(`深層搜尋失敗：${errorMessage(error)}`);
        if (!budget.cancelled) {
          this.deps.send({
            type: 'search.done',
            searchId: request.searchId,
            state: 'timeout',
            scannedSessions: 0,
            totalSessions: request.sessions.length,
          });
        }
      } finally {
        if (this.running.get(request.searchId) === budget) this.running.delete(request.searchId);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  cancel(searchId: string): void {
    const budget = this.running.get(searchId);
    if (!budget) return;
    budget.cancelled = true;
    this.running.delete(searchId);
  }

  /** hub 斷線：進行中的全部停掉（hub 那邊已當成失聯）。 */
  cancelAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  private async run(request: SearchRequest, budget: Budget): Promise<void> {
    const { searchId, terms, mask, limits } = request;
    const sinceMs = Date.parse(request.since);
    const targets = [...request.sessions].sort(byActivity);
    const perSession = new Map<string, number>();
    let sent = 0;
    /** 送出一批；超過每台上限的部分丟掉並回 false（那個 session 不算搜完）。 */
    const send = (items: SearchItem[]): boolean => {
      const room = Math.max(0, limits.perMachine - sent);
      const batch = items.slice(0, room);
      if (batch.length > 0 && !budget.cancelled) {
        sent += batch.length;
        this.deps.send({ type: 'search.result', searchId, items: batch });
      }
      return batch.length === items.length;
    };

    // 1. 畫面（快，只在記憶體）：一次送一批。
    const screenItems: SearchItem[] = [];
    for (const target of targets) {
      const lines = this.deps.screen(target.sessionId);
      if (!lines) continue;
      const found = searchScreen(lines, terms, mask, limits.perSession);
      perSession.set(target.sessionId, found.length);
      for (const hit of found) {
        screenItems.push({ kind: 'screen', sessionId: target.sessionId, ...hit });
      }
    }
    send(screenItems);

    // 2. 對話紀錄：依最後活動時間新到舊，一份一份讀，每讀完一份就送那一份的結果。
    let scanned = 0;
    let state: 'done' | 'timeout' = 'done';
    for (const target of targets) {
      if (budget.cancelled) return;
      if (sent >= limits.perMachine) break; // 到每台上限：照樣算 done，畫面顯示只搜了 N／M
      if (this.now() > budget.deadline || budget.bytes >= budget.maxBytes) {
        state = 'timeout';
        break;
      }
      const room = limits.perSession - (perSession.get(target.sessionId) ?? 0);
      const file = room > 0 ? await this.transcriptFile(target, sinceMs) : null;
      if (file) {
        const scan = await scanTranscriptFile(file, target.sessionId, {
          terms,
          mask,
          sinceMs,
          maxHits: room,
          budget,
          now: this.now,
        });
        if (scan.stopped === 'cancelled' || budget.cancelled) return;
        if (!send(scan.hits)) break; // 到每台上限：這個 session 的結果沒送完，不算搜完
        if (scan.stopped !== null) {
          state = 'timeout';
          break;
        }
      }
      scanned += 1;
    }
    if (budget.cancelled) return;
    this.deps.send({
      type: 'search.done',
      searchId,
      state,
      scannedSessions: scanned,
      totalSessions: targets.length,
    });
  }

  /** 這個 session 目前的對話紀錄檔；沒有 claude id、找不到、或修改時間在範圍之前（不必讀）回 null。 */
  private async transcriptFile(target: DeepSearchTarget, sinceMs: number): Promise<string | null> {
    if (!target.claudeSessionId) return null;
    let configDir: string;
    try {
      configDir = claudeConfigFor(target.accountProfile, this.deps.configDir);
    } catch {
      return null; // accountProfile 不是絕對路徑：不猜
    }
    const { jsonl } = await findTranscriptFiles(configDir, target.claudeSessionId);
    const file = jsonl[0];
    if (file === undefined) return null;
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < sinceMs) return null;
    return file;
  }
}
