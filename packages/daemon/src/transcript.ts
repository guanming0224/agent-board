// 讀 Claude Code 的對話紀錄（JSONL）給「舊資料頁」看（CONTRACTS §9.3）。
// 檔案可達數十 MB：逐行串流解析，只留下這一頁要回的內容。讀不懂的行一律略過。
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { IsoTime, type TranscriptEntry, type TranscriptPage } from '@agent-board/protocol';
import { findTranscriptFiles } from './sessionFiles';

export const MAX_TEXT = 4_000;
export const MAX_TOOL_TEXT = 1_000;
const TOOL_INPUT_PREVIEW = 300;

type Raw = Omit<TranscriptEntry, 'index'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 超過就截斷加 …；不切開 surrogate pair。 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** 顯示用只取參數前 300 字；搜尋用完整參數（§9.3 搜尋比對截斷前的全文）。 */
function toolUseText(block: Record<string, unknown>): { text: string; search: string } {
  const name = typeof block.name === 'string' ? block.name : '?';
  let input = '';
  try {
    input = JSON.stringify(block.input ?? {}) ?? '';
  } catch {
    // 循環參照不會出現在 JSON 解析出來的資料，保險起見
  }
  return {
    text: `→ ${name} ${truncate(input, TOOL_INPUT_PREVIEW)}`,
    search: `→ ${name} ${input}`,
  };
}

interface ParsedEntry {
  raw: Raw;
  /** 搜尋比對用的全文（截斷前）。 */
  search: string;
}

/**
 * 一行 JSONL → 0 到多則。user 的字串或 text block → user；assistant 的 text block → assistant；
 * tool_use、tool_result block → tool。isMeta、其他 type（summary、system 等）與 thinking、image 略過。
 */
export function entriesOfLine(line: string): Raw[] {
  return parseLine(line).map((p) => p.raw);
}

function parseLine(line: string): ParsedEntry[] {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(record) || record.isMeta === true) return [];
  const type = record.type;
  if (type !== 'user' && type !== 'assistant') return [];
  const at =
    typeof record.timestamp === 'string' && IsoTime.safeParse(record.timestamp).success
      ? record.timestamp
      : null;
  const content = isRecord(record.message) ? record.message.content : undefined;
  const out: ParsedEntry[] = [];
  const push = (role: Raw['role'], text: string, search = text) => {
    if (text.trim() !== '') out.push({ raw: { role, at, text }, search });
  };
  if (typeof content === 'string') {
    push(type, content);
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') push(type, block.text);
    else if (block.type === 'tool_use') {
      const { text, search } = toolUseText(block);
      push('tool', text, search);
    } else if (block.type === 'tool_result') push('tool', toolResultText(block.content));
  }
  return out;
}

export interface TranscriptQuery {
  cursor: number;
  limit: number;
  /** 不分大小寫的子字串；比對的是截斷前的全文。 */
  query: string | null;
}

const MISSING: TranscriptPage = {
  entries: [],
  total: 0,
  matched: null,
  nextCursor: null,
  missing: true,
};

/** 跟 hub 的 sessionFilesTimeoutMs 一樣：hub 不等了，這邊也不用再讀。 */
export const TRANSCRIPT_DEADLINE_MS = 20_000;
/** 單行超過這個長度（字元數，約略等於位元組）就跳過，不 JSON.parse。 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** 只有這兩種 type 會產生內容；其他行（大量的 progress、summary 等）連 JSON.parse 都省掉。 */
const mayHaveEntries = (line: string): boolean =>
  line.includes('"type":"user"') || line.includes('"type":"assistant"');

export class TranscriptTimeoutError extends Error {
  constructor() {
    super('transcript read timed out');
    this.name = 'TranscriptTimeoutError';
  }
}

/**
 * 解析一份 JSONL。`cursor` 是篩選後清單的位置，`index` 保留在整份對話裡的序號。
 * 搜尋比對的是截斷前的全文（§9.3），所以符合的那則顯示出來時，命中處可能在截斷之後。
 * deadline（epoch ms）到了就停止讀檔並丟 TranscriptTimeoutError。
 */
export async function readTranscriptFile(
  file: string,
  { cursor, limit, query }: TranscriptQuery,
  deadline = Date.now() + TRANSCRIPT_DEADLINE_MS,
): Promise<TranscriptPage> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TranscriptTimeoutError();
  const needle = query ? query.toLowerCase() : null;
  const entries: TranscriptEntry[] = [];
  let total = 0;
  let matched = 0;
  const input = createReadStream(file, 'utf8');
  const opened = new Promise<boolean>((resolve) => {
    input.once('open', () => resolve(true));
    input.once('error', () => resolve(false));
  });
  if (!(await opened)) return MISSING; // 剛好被刪掉之類
  const lines = createInterface({ input, crlfDelay: Infinity });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    lines.close();
    input.destroy();
  }, remaining);
  try {
    for await (const line of lines) {
      if (timedOut) break;
      if (line.length > MAX_LINE_CHARS || !mayHaveEntries(line)) continue;
      for (const { raw, search } of parseLine(line)) {
        const index = total;
        total += 1;
        if (needle !== null && !search.toLowerCase().includes(needle)) continue;
        const position = matched;
        matched += 1;
        if (position < cursor || position >= cursor + limit) continue;
        const max = raw.role === 'tool' ? MAX_TOOL_TEXT : MAX_TEXT;
        entries.push({ index, ...raw, text: truncate(raw.text, max) });
      }
    }
  } finally {
    clearTimeout(timer);
    input.destroy();
  }
  if (timedOut) throw new TranscriptTimeoutError();
  return {
    entries,
    total,
    matched: needle === null ? null : matched,
    nextCursor: cursor + limit < matched ? cursor + limit : null,
    missing: false,
  };
}

/** 同時只讀一份（§9.6）：大檔很吃 CPU 與記憶體，排隊等的時間也算在 deadline 裡。 */
let readQueue: Promise<void> = Promise.resolve();

/** 找 `<config>/projects/*\/<id>.jsonl`（有好幾份就讀最新的）；找不到回 missing。 */
export function readTranscript(
  configDir: string,
  claudeSessionId: string,
  query: TranscriptQuery,
  deadlineMs = TRANSCRIPT_DEADLINE_MS,
): Promise<TranscriptPage> {
  const deadline = Date.now() + deadlineMs;
  const run = readQueue.then(async () => {
    const { jsonl } = await findTranscriptFiles(configDir, claudeSessionId);
    const file = jsonl[0];
    return file === undefined ? MISSING : readTranscriptFile(file, query, deadline);
  });
  readQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
