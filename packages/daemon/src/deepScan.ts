// 深層搜尋的「讀一份對話紀錄」這一段（P3 ③b）：切行、先篩、JSON 解析、比對、遮蔽。
// 主執行緒（deepSearch.ts 的 DeepSearcher）和 worker（deepSearchWorker.ts）共用同一份程式：
// 平常在 worker 裡跑，大檔的 JSON 解析不會卡住 daemon 主執行緒（PTY 轉送、hub 連線）；
// 測試注入假時鐘時才在主執行緒跑（時鐘不能跨執行緒）。
// 這裡只能 import 純函式（protocol、transcript、secretPatterns），worker 會載入整個依賴樹。
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { makeSnippet, type SearchItem } from '@agent-board/protocol';
import { maskSecrets } from './secretPatterns';
import { countEntries, MAX_LINE_CHARS, mayHaveEntries, parseLine } from './transcript';

/** 讀檔的區塊大小：每讀一塊檢查一次取消、時間與讀檔量（超過上限最多多讀一塊）。 */
export const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * 一行超過這麼多位元組就整行丟掉、不組字串（記憶體上限）。對話紀錄檢視是「字串長度 > MAX_LINE_CHARS」才略過，
 * UTF-8 一個 UTF-16 字元最多 3 位元組：3 倍以內的照樣解碼再用同一條規則判斷，序號才和檢視器一致。
 */
const MAX_LINE_BYTES = MAX_LINE_CHARS * 3;

/** 一次搜尋的進度與上限。 */
export interface Budget {
  /** 新的搜尋進來時改成現在（讓位：正在跑的這個在下一塊就停，回部分結果）。 */
  deadline: number;
  readonly maxBytes: number;
  bytes: number;
  cancelled: boolean;
}

export type StopReason = 'deadline' | 'bytes' | 'cancelled';

export interface FileScan {
  /** 這份檔的命中（最新的 maxHits 筆，依序號由舊到新）。 */
  hits: SearchItem[];
  /** 實際讀了多少位元組。 */
  bytes: number;
  /** 提早停下的原因；讀完是 null。 */
  stopped: StopReason | null;
}

/** SharedBudget 的欄位位置（BigInt64Array，用 Atomics 讀寫，兩個執行緒看到的一定是完整的值）。 */
const SLOT = { deadline: 0, maxBytes: 1, bytes: 2, cancelled: 3 } as const;

/**
 * 放在 SharedArrayBuffer 裡的 Budget：主執行緒取消、讓位（deadline 改成 0）時，worker 讀下一塊前就看得到；
 * worker 讀了多少，主執行緒也直接看得到（讀檔上限跨檔累計）。毫秒與位元組都取整數存。
 */
export class SharedBudget implements Budget {
  readonly buffer: SharedArrayBuffer;
  private readonly slots: BigInt64Array;

  constructor(init: { deadline: number; maxBytes: number } | SharedArrayBuffer) {
    if (init instanceof SharedArrayBuffer) {
      this.buffer = init;
      this.slots = new BigInt64Array(init);
      return;
    }
    this.buffer = new SharedArrayBuffer(4 * BigInt64Array.BYTES_PER_ELEMENT);
    this.slots = new BigInt64Array(this.buffer);
    this.deadline = init.deadline;
    Atomics.store(this.slots, SLOT.maxBytes, toInt(init.maxBytes));
  }

  get deadline(): number {
    return Number(Atomics.load(this.slots, SLOT.deadline));
  }
  set deadline(value: number) {
    Atomics.store(this.slots, SLOT.deadline, toInt(value));
  }
  get maxBytes(): number {
    return Number(Atomics.load(this.slots, SLOT.maxBytes));
  }
  get bytes(): number {
    return Number(Atomics.load(this.slots, SLOT.bytes));
  }
  set bytes(value: number) {
    Atomics.store(this.slots, SLOT.bytes, toInt(value));
  }
  get cancelled(): boolean {
    return Atomics.load(this.slots, SLOT.cancelled) !== 0n;
  }
  set cancelled(value: boolean) {
    Atomics.store(this.slots, SLOT.cancelled, value ? 1n : 0n);
  }
}

/** 毫秒、位元組轉成 BigInt64 存得下的整數（假時鐘可能有小數；無限大當成最大值）。 */
function toInt(value: number): bigint {
  if (!Number.isFinite(value)) return value > 0 ? BigInt(Number.MAX_SAFE_INTEGER) : 0n;
  return BigInt(Math.trunc(value));
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

/**
 * 一塊一塊（READ_CHUNK_BYTES）讀一份檔、自己切行，每一行（去掉行尾的 \r）交給 onLine。
 * 開檔用 O_NOFOLLOW：路徑最後一段是符號連結就開不起來（不跟），也沒有「先 lstat 再開」的空窗。
 * 每讀一塊前檢查取消、時間與讀檔量；太長的行（> MAX_LINE_BYTES）不組字串、丟到下一個換行為止。
 */
export async function readLines(
  file: string,
  budget: Budget,
  now: () => number,
  onLine: (line: string) => void,
): Promise<{ bytes: number; stopped: StopReason | null }> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { bytes: 0, stopped: null }; // 剛好被刪掉、或是符號連結
  }
  let bytes = 0;
  let stopped: StopReason | null = null;
  try {
    if (!(await handle.stat()).isFile()) return { bytes: 0, stopped: null };
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    /** 上一塊沒收尾的那一段（複製出來，buffer 會被下一塊蓋掉）。 */
    let carry: Buffer[] = [];
    let carryBytes = 0;
    /** 這一行已經太長：丟到下一個換行為止。 */
    let skipping = false;
    const emit = (line: Buffer) => {
      const end = line.length > 0 && line[line.length - 1] === 0x0d ? line.length - 1 : line.length;
      onLine(line.toString('utf8', 0, end));
    };
    for (;;) {
      if (budget.cancelled) {
        stopped = 'cancelled';
        break;
      }
      if (now() > budget.deadline) {
        stopped = 'deadline';
        break;
      }
      if (budget.bytes >= budget.maxBytes) {
        stopped = 'bytes';
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      budget.bytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      while (from < chunk.length) {
        const newline = chunk.indexOf(0x0a, from);
        const end = newline < 0 ? chunk.length : newline;
        if (!skipping) {
          if (carryBytes + (end - from) > MAX_LINE_BYTES) {
            skipping = true;
            carry = [];
            carryBytes = 0;
          } else if (newline < 0) {
            carry.push(Buffer.from(chunk.subarray(from, end)));
            carryBytes += end - from;
          } else if (carry.length > 0) {
            carry.push(chunk.subarray(from, end));
            emit(Buffer.concat(carry));
            carry = [];
            carryBytes = 0;
          } else {
            emit(chunk.subarray(from, end));
          }
        }
        if (newline < 0) break;
        skipping = false;
        from = newline + 1;
      }
      if (budget.cancelled) {
        stopped = 'cancelled';
        break;
      }
    }
    // 最後一行沒有換行
    if (stopped === null && !skipping && carry.length > 0) emit(Buffer.concat(carry));
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { bytes, stopped };
}

/**
 * 掃一份 JSONL，序號（transcriptIndex）和對話紀錄檢視（readTranscriptFile）一樣算，⌘Enter 才捲得到那則。
 * 先篩沒過的行只算這行有幾則（countEntries，不組搜尋全文）；sinceMs 之前的那幾則不算命中。命中只留最新的 maxHits 筆。
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
  let index = 0;
  const { bytes, stopped } = await readLines(file, budget, now, (line) => {
    // 同 readTranscriptFile 的略過規則（序號才一致）。
    if (line.length > MAX_LINE_CHARS || !mayHaveEntries(line)) return;
    if (!quick(line)) {
      index += countEntries(line);
      return;
    }
    for (const { raw, search } of parseLine(line)) {
      const at = index;
      index += 1;
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
  });
  return { hits, bytes, stopped };
}
