// 全域搜尋的深層（P3 ③b，docs/p3-spec.md §3.6、CONTRACTS §16）：在這台機器上搜活著的 session 的終端機畫面
// （headless xterm 的緩衝，只在記憶體）與 Claude Code 的對話紀錄 JSONL（本機磁碟）。只讀、只回片段：
// 不送任何字進 session、不對外連線、不在任何地方建索引或落地。
//
// 對話紀錄可達數十 MB、一台機器 7 天內可達數百 MB（實測一台約 400MB）：一塊一塊（1MB）讀、自己切行，不整檔載入；
// 一行太長（超過 MAX_LINE_CHARS 的 3 倍位元組）就丟掉不組字串；修改時間在時間範圍之前的檔不讀；
// 每 session、每台的筆數上限、讀檔總量上限、時間上限（deadline）每讀一塊檢查一次，到了就停並回報
// 「只搜了 N／M 個 session」；取消時下一塊就停止讀檔。開檔用 O_NOFOLLOW（不跟符號連結，沒有先檢查再開的空窗）。
// 和對話紀錄檢視（transcript.ts 的 readQueue，同時只讀一份）分開排隊：搜尋不會讓 GM 打開對話紀錄要等。
// hub 是可信端，但 daemon 自己再收斂一次：上限有天花板、session 數有上限、accountProfile 只認這台用過的帳號設定目錄。
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  makeSnippet,
  type DaemonToHub,
  type DeepSearchTarget,
  type HubToDaemon,
  type SearchItem,
} from '@agent-board/protocol';
import { errorMessage, log } from './log';
import { maskSecrets } from './secretPatterns';
import { indexTranscripts, type TranscriptIndexEntry } from './sessionFiles';
import { countEntries, MAX_LINE_CHARS, mayHaveEntries, parseLine } from './transcript';

export type SearchRequest = Extract<HubToDaemon, { type: 'search.request' }>;

/** 畫面切段：連續非空白行算一段，一段最多幾行（命中處前後的片段才不會跨太遠）。 */
const SCREEN_CHUNK_LINES = 20;
/** 讀檔的區塊大小：每讀一塊檢查一次取消、時間與讀檔量（超過上限最多多讀一塊）。 */
export const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * 一行超過這麼多位元組就整行丟掉、不組字串（記憶體上限）。對話紀錄檢視是「字串長度 > MAX_LINE_CHARS」才略過，
 * UTF-8 一個 UTF-16 字元最多 3 位元組：3 倍以內的照樣解碼再用同一條規則判斷，序號才和檢視器一致。
 */
const MAX_LINE_BYTES = MAX_LINE_CHARS * 3;

/**
 * daemon 自己的天花板：hub 送來的上限再大也只照這個（hub 有 bug 也不會讓 daemon 長時間讀檔）。
 * 讀檔量與時間是規格預設值的上限；session 數遠大於一台機器在時間範圍內會有的量。
 */
export const DEEP_HARD_LIMITS = {
  perSession: 10,
  perMachine: 500,
  maxBytes: 1024 * 1024 * 1024,
  deadlineMs: 60_000,
  sessions: 2_000,
} as const;

export interface DeepSearchDeps {
  /** daemon 的預設 CLAUDE_CONFIG_DIR（session 沒帶 accountProfile 時用）。 */
  configDir: string;
  /**
   * accountProfile（CLAUDE_CONFIG_DIR）是不是這台 daemon 開 session 時用過的帳號設定目錄。
   * 不是的話那個 session 只搜畫面、不讀對話紀錄（不讓 hub 帶來的路徑把 daemon 導去讀不相干的資料夾）。
   */
  knownProfile(profile: string): boolean;
  /** 活著的 session 的畫面（邏輯行）；不是這台的或已結束回 null。 */
  screen(sessionId: string): string[] | null;
  send(message: DaemonToHub): void;
  now?: () => number;
}

/** 一次搜尋的進度與上限。 */
export interface Budget {
  /** 新的搜尋進來時改成現在（讓位：正在跑的這個在下一塊就停，回部分結果）。 */
  deadline: number;
  readonly maxBytes: number;
  bytes: number;
  cancelled: boolean;
}

/** 一次搜尋跑完的統計（測試與效能量測用；hub 看不到）。 */
export interface DeepRunStats {
  /** 實際讀了多少位元組（對話紀錄）。 */
  bytes: number;
  /** 提早停下的原因；搜完是 null。 */
  stopped: StopReason | null;
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

/** 依最後活動時間新到舊；沒有時間的排最後。 */
const byActivity = (a: DeepSearchTarget, b: DeepSearchTarget) =>
  (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '');

/** hub 送來的請求收斂到 daemon 自己的天花板以內。 */
export function clampRequest(request: SearchRequest): SearchRequest {
  const { limits } = request;
  return {
    ...request,
    sessions: request.sessions.slice(0, DEEP_HARD_LIMITS.sessions),
    limits: {
      perSession: Math.min(limits.perSession, DEEP_HARD_LIMITS.perSession),
      perMachine: Math.min(limits.perMachine, DEEP_HARD_LIMITS.perMachine),
      maxBytes: Math.min(limits.maxBytes, DEEP_HARD_LIMITS.maxBytes),
      deadlineMs: Math.min(limits.deadlineMs, DEEP_HARD_LIMITS.deadlineMs),
    },
  };
}

/**
 * 一台機器的深層搜尋。同一時間只跑一個（排隊）；新的請求進來，正在跑與排隊中的會「讓位」：
 * 在下一塊就停、送出已找到的部分並回 timeout（hub 只會取消同一個使用者的舊搜尋，不同使用者的不會互相卡到逾時）。
 * 取消的不回 result／done。和對話紀錄檢視的 readQueue 是兩條獨立的佇列，兩邊都是逐塊非同步讀，會交錯進行。
 */
export class DeepSearcher {
  private queue: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, Budget>();
  private readonly now: () => number;

  constructor(private readonly deps: DeepSearchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 收到 hub 的 search.request：排進佇列（等待的時間也算在 deadline 裡）。 */
  start(raw: SearchRequest): Promise<DeepRunStats> {
    const request = clampRequest(raw);
    this.cancel(request.searchId);
    for (const other of this.running.values()) other.deadline = 0; // 讓位
    const budget: Budget = {
      deadline: this.now() + request.limits.deadlineMs,
      maxBytes: request.limits.maxBytes,
      bytes: 0,
      cancelled: false,
    };
    this.running.set(request.searchId, budget);
    const run = this.queue.then(async (): Promise<DeepRunStats> => {
      if (budget.cancelled) return { bytes: 0, stopped: 'cancelled' };
      try {
        const stopped = await this.run(request, budget);
        return { bytes: budget.bytes, stopped };
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
        return { bytes: budget.bytes, stopped: budget.cancelled ? 'cancelled' : 'deadline' };
      } finally {
        if (this.running.get(request.searchId) === budget) this.running.delete(request.searchId);
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
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

  /** 回提早停下的原因（搜完是 null）。 */
  private async run(request: SearchRequest, budget: Budget): Promise<StopReason | null> {
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

    // 2. 對話紀錄：每個帳號設定目錄只掃一次檔案清單；依最後活動時間新到舊一份一份讀，每讀完一份就送那一份的結果。
    const indexes = new Map<string, Map<string, TranscriptIndexEntry>>();
    const shouldStop = () => budget.cancelled || this.now() > budget.deadline;
    const fileOf = async (target: DeepSearchTarget, build: boolean) => {
      const configDir = this.configDirOf(target);
      if (configDir === null || target.claudeSessionId === null) return null;
      let index = indexes.get(configDir);
      if (!index) {
        if (!build) return undefined; // 還沒掃過、現在也不掃：不知道
        index = await indexTranscripts(configDir, shouldStop);
        if (shouldStop()) return undefined; // 掃到一半停了：清單不完整，不當成「沒有檔」
        indexes.set(configDir, index);
      }
      const entry = index.get(target.claudeSessionId.toLowerCase());
      // 修改時間在範圍之前：不必讀（裡面不會有範圍內的那幾則）。
      return entry && entry.mtimeMs >= sinceMs ? entry.path : null;
    };

    let scanned = 0;
    let stopped: StopReason | null = null;
    let full = false; // 到每台筆數上限
    let next = 0;
    /** 停下時 targets[next] 已經讀了一部分（不算搜過，也不能再算成「不必讀」）。 */
    let partial = false;
    for (; next < targets.length; next += 1) {
      const target = targets[next]!;
      if (budget.cancelled) return 'cancelled';
      if (sent >= limits.perMachine) {
        full = true;
        break;
      }
      if (this.now() > budget.deadline) {
        stopped = 'deadline';
        break;
      }
      if (budget.bytes >= budget.maxBytes) {
        stopped = 'bytes';
        break;
      }
      const room = limits.perSession - (perSession.get(target.sessionId) ?? 0);
      const file = room > 0 ? await fileOf(target, true) : null;
      if (budget.cancelled) return 'cancelled';
      if (file === undefined) {
        stopped = 'deadline';
        break;
      }
      if (file) {
        const scan = await scanTranscriptFile(file, target.sessionId, {
          terms,
          mask,
          sinceMs,
          maxHits: room,
          budget,
          now: this.now,
        });
        if (scan.stopped === 'cancelled' || budget.cancelled) return 'cancelled';
        if (!send(scan.hits)) {
          full = true; // 這個 session 的結果沒送完，不算搜完
          partial = true;
          break;
        }
        if (scan.stopped !== null) {
          stopped = scan.stopped;
          partial = true;
          break;
        }
      }
      scanned += 1;
    }
    // 停下之後：剩下的 session 裡本來就不必讀檔的（沒有對話紀錄、或修改時間在範圍之前）也算搜過，
    // 「只搜了 N／M」才不會把根本不在範圍內的算成漏掉。只用已經掃好的檔案清單判斷，不再碰磁碟。
    if (stopped !== null || full) {
      for (let rest = partial ? next + 1 : next; rest < targets.length; rest += 1) {
        const target = targets[rest]!;
        const room = limits.perSession - (perSession.get(target.sessionId) ?? 0);
        if (room <= 0 || (await fileOf(target, false)) === null) scanned += 1;
      }
    }
    if (budget.cancelled) return 'cancelled';
    this.deps.send({
      type: 'search.done',
      searchId,
      state: stopped === null ? 'done' : 'timeout',
      scannedSessions: scanned,
      totalSessions: targets.length,
    });
    return stopped;
  }

  /** 這個 session 的 CLAUDE_CONFIG_DIR；不是這台用過的帳號設定目錄（或不是絕對路徑）回 null：不讀對話紀錄。 */
  private configDirOf(target: DeepSearchTarget): string | null {
    const profile = target.accountProfile;
    if (!profile) return this.deps.configDir;
    if (!isAbsolute(profile)) return null;
    if (profile === this.deps.configDir || this.deps.knownProfile(profile)) return profile;
    return null;
  }
}
