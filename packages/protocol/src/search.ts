// 全域搜尋（P3 項目三，docs/p3-spec.md §3）。快速層只搜 hub 已有的資料；深層（③b）由各台 daemon 即時搜對話紀錄
// 與終端機畫面，結果只回片段（hub 不建索引、不落地）。比對、片段擷取是純函式：hub、daemon 與假後端用同一份，結果才會一樣。
import { z } from 'zod';
import { ClaudeSessionId, Id, IsoTime } from './models';

/** 查詢字最多幾個字（§3.3）。 */
export const SEARCH_QUERY_MAX = 200;
/** 少於這麼多字不搜（§3.3：至少 2 字）。 */
export const SEARCH_MIN_CHARS = 2;
/** 片段最長幾個字（命中處前後共 ≤ 160 字，含省略號）。 */
export const SEARCH_SNIPPET_MAX = 160;
/** 快速層：每組最多取幾筆、總共最多幾筆、查詢逾時（§3.6）。 */
export const SEARCH_GROUP_LIMIT = 50;
export const SEARCH_TOTAL_LIMIT = 200;
export const SEARCH_TIMEOUT_MS = 2000;
/** 輸入停多久才送快速層請求（§3.3）。 */
export const SEARCH_DEBOUNCE_MS = 250;

/** 範圍：目前工作區或全部工作區。 */
export const SearchScope = z.enum(['zone', 'all']);
export type SearchScope = z.infer<typeof SearchScope>;
/** 時間範圍（只套用在有時間的來源：檔案改動、回覆、交接／派工／任務摘要、送出的指令）。 */
export const SearchSince = z.enum(['24h', '7d', '30d']);
export type SearchSince = z.infer<typeof SearchSince>;
export const SEARCH_SINCE_MS: Record<SearchSince, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
/** 預設：全部工作區、7 天、不含封存（§3.3、D8）。 */
export const SEARCH_DEFAULTS = { scope: 'all', since: '7d', archived: false } as const satisfies {
  scope: SearchScope;
  since: SearchSince;
  archived: boolean;
};

/**
 * 一筆結果是什麼：file 檔案改動、progress 進度卡（項目一）、team 團隊文字、task 任務標題、
 * session（名稱、資料夾、分支、最後幾行，以及每回合最後回覆與交接／派工／任務摘要）、input GM 送出的指令、
 * transcript／screen 深層（對話紀錄、終端機畫面，之後才有）。
 */
export const SearchItemKind = z.enum([
  'file',
  'progress',
  'team',
  'task',
  'session',
  'input',
  'transcript',
  'screen',
]);
export type SearchItemKind = z.infer<typeof SearchItemKind>;

/**
 * 結果分組，順序就是畫面上的順序（§3.3）：檔案改動 → 進度卡與團隊 → session → GM 送出的指令 → 對話與終端機。
 * transcript 組只有深層會填。
 */
export const SearchGroupKind = z.enum(['file', 'team', 'session', 'input', 'transcript']);
export type SearchGroupKind = z.infer<typeof SearchGroupKind>;
export const SEARCH_GROUP_ORDER = SearchGroupKind.options;

/** 每種結果放在哪一組。 */
export const SEARCH_GROUP_OF: Record<SearchItemKind, SearchGroupKind> = {
  file: 'file',
  progress: 'team',
  team: 'team',
  task: 'team',
  session: 'session',
  input: 'input',
  transcript: 'transcript',
  screen: 'transcript',
};

/**
 * 片段來自哪個欄位（畫面上的小標）。path 檔案路徑；name／cwd／branch／worktree／lastLines 是 session 的欄位；
 * reply 每回合最後回覆；handoff／dispatch／taskEvent 是交接、派工、任務的摘要；goal／doneCriteria／contextMd 團隊文字；
 * title 任務標題；progress 進度卡；input 送出的指令。
 */
export const SearchField = z.enum([
  'path',
  'name',
  'cwd',
  'branch',
  'worktree',
  'lastLines',
  'reply',
  'handoff',
  'dispatch',
  'taskEvent',
  'goal',
  'doneCriteria',
  'contextMd',
  'title',
  'progress',
  'input',
]);
export type SearchField = z.infer<typeof SearchField>;

/** 片段裡的命中位置 [開始, 結束)（UTF-16 位置，同 JS 字串）。 */
export const SearchRange = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export type SearchRange = z.infer<typeof SearchRange>;

export const SearchItem = z.object({
  kind: SearchItemKind,
  sessionId: Id.optional(),
  teamId: Id.optional(),
  field: SearchField.optional(),
  /** 命中處前後的片段（≤ SEARCH_SNIPPET_MAX 字）；遮蔽模式開著時 hub 已經遮好。檔案改動是相對 repo 的路徑。 */
  snippet: z.string(),
  matchRanges: z.array(SearchRange),
  at: IsoTime.optional(),
  machineId: Id.optional(),
  /** 深層：對話紀錄裡的序號（`TranscriptEntry.index`），⌘Enter 開對話紀錄時捲到這則。 */
  transcriptIndex: z.number().int().nonnegative().optional(),
  /** 檔案改動：時間範圍內改了幾次。 */
  count: z.number().int().positive().optional(),
});
export type SearchItem = z.infer<typeof SearchItem>;

export const SearchGroup = z.object({
  kind: SearchGroupKind,
  /** 這組回了幾筆（每組最多取 SEARCH_GROUP_LIMIT 筆，所以最多就是這個數）。不另外算總數（多一次 COUNT 太慢）。 */
  total: z.number().int().nonnegative(),
  /** 這組被截斷了：符合的不只 total 筆（畫面顯示「50+」）。 */
  capped: z.boolean(),
  items: z.array(SearchItem),
});
export type SearchGroup = z.infer<typeof SearchGroup>;

export const SearchResults = z.object({
  /** 只放有結果的組，照 SEARCH_GROUP_ORDER 排。 */
  groups: z.array(SearchGroup),
  /** 查詢逾時（SEARCH_TIMEOUT_MS），或有任何一組、任何一個來源被上限截斷：回的是已經找到的部分。 */
  partial: z.boolean(),
});
export type SearchResults = z.infer<typeof SearchResults>;

/**
 * `GET /api/search` 的參數（快速層）。zoneId 只在 scope=zone 時用，而且 scope=zone 一定要帶（不帶回 400，
 * 不會默默退回搜全部）；帶了不存在的工作區回空結果。
 */
export const SearchQuery = z
  .object({
    q: z.string().max(SEARCH_QUERY_MAX),
    scope: SearchScope.default(SEARCH_DEFAULTS.scope),
    zoneId: Id.optional(),
    since: SearchSince.default(SEARCH_DEFAULTS.since),
    archived: z.stringbool().default(SEARCH_DEFAULTS.archived),
    /** 遮蔽模式開著：片段在 hub 就遮好，金鑰不會傳到裝置上（§3.5、D9）。 */
    mask: z.stringbool().default(false),
  })
  .refine((query) => query.scope !== 'zone' || query.zoneId !== undefined, {
    message: 'scope=zone 要帶 zoneId',
    path: ['zoneId'],
  });
export type SearchQuery = z.infer<typeof SearchQuery>;

// ── 比對規則（§3.3）：不分大小寫子字串；空白分隔的多個詞每個都要出現；雙引號包起來是完整片語 ──

/** 換成小寫但長度不變（少數字元小寫後會變長，那些維持原樣），命中位置才能直接對回原字串。 */
export function foldCase(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}

/** 連續空白（含換行）換成一個空白並去頭尾：片段是一行字，片語跨行也比得到。 */
export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 把查詢字拆成詞（已轉小寫）。`"…"` 是一個片語；沒收尾的引號當片語到結尾。空字串的詞丟掉。
 * 字數不夠（合計少於 SEARCH_MIN_CHARS）回空陣列：不搜。
 */
export function parseSearchTerms(q: string): string[] {
  const terms: string[] = [];
  for (const match of q.slice(0, SEARCH_QUERY_MAX).matchAll(/"([^"]*)(?:"|$)|([^\s"]+)/g)) {
    const term = foldCase(collapseSpace(match[1] ?? match[2] ?? ''));
    if (term !== '' && !terms.includes(term)) terms.push(term);
  }
  const chars = terms.reduce((n, term) => n + [...term].length, 0);
  return chars >= SEARCH_MIN_CHARS ? terms : [];
}

/** 每個詞在 text 裡出現的位置（排序、合併）；有任何一個詞沒出現就回 null（AND）。text 要先 foldCase。 */
export function findTerms(folded: string, terms: readonly string[]): SearchRange[] | null {
  if (terms.length === 0) return null;
  const ranges: SearchRange[] = [];
  for (const term of terms) {
    let from = 0;
    let found = false;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      found = true;
      ranges.push([at, at + term.length]);
      from = at + term.length;
    }
    if (!found) return null;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: SearchRange[] = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** at 落在一個字（surrogate pair）的中間：從這裡切會把字切成兩半。 */
function splitsPair(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 符合所有詞就回傳命中處前後的片段（≤ max 字，被截掉的那邊加「…」）與片段裡的命中位置；不符合回 null。
 * 呼叫端要遮蔽就先遮好整段文字再傳進來（金鑰不會被比對到，位置也是遮蔽後的）。
 */
export function makeSnippet(
  text: string,
  terms: readonly string[],
  max = SEARCH_SNIPPET_MAX,
): { snippet: string; matchRanges: SearchRange[] } | null {
  const flat = collapseSpace(text);
  const ranges = findTerms(foldCase(flat), terms);
  if (!ranges) return null;
  if (flat.length <= max) return { snippet: flat, matchRanges: ranges };
  const [hitStart, hitEnd] = ranges[0]!;
  const budget = max - 2; // 前後各留一個「…」的位置
  // 命中處放在前三分之一，後面的字通常比較有用（例如「已把 risk.py 的上限改成…」）。
  let start = Math.max(0, hitStart - Math.floor(Math.max(0, budget - (hitEnd - hitStart)) / 3));
  let end = Math.min(flat.length, start + budget);
  start = Math.max(0, end - budget);
  if (start > 0 && splitsPair(flat, start)) start += 1;
  if (end < flat.length && splitsPair(flat, end)) end -= 1;
  const head = start > 0 ? '…' : '';
  const tail = end < flat.length ? '…' : '';
  const shift = head.length - start;
  const matchRanges = ranges
    .filter(([a, b]) => b > start && a < end)
    .map(([a, b]): SearchRange => [Math.max(a, start) + shift, Math.min(b, end) + shift]);
  return { snippet: head + flat.slice(start, end) + tail, matchRanges };
}

// ── 深層（③b，§3.6、§3.7）：hub 扇出給各台 daemon，daemon 搜對話紀錄 JSONL 與活著的 session 的終端機畫面 ──

/** 深層：每個 session 最多幾筆、每台機器最多幾筆、每台讀檔總量上限、每台的時間上限（§3.6）。 */
export const SEARCH_DEEP_PER_SESSION = 3;
export const SEARCH_DEEP_PER_MACHINE = 100;
export const SEARCH_DEEP_MAX_BYTES = 300 * 1024 * 1024;
export const SEARCH_DEEP_DEADLINE_MS = 15_000;
/** hub 等 daemon 的 `search.done` 比 daemon 自己的 deadline 多等這麼久；再沒回就當逾時並送取消。 */
export const SEARCH_DEEP_GRACE_MS = 3_000;

/** daemon 支援深層搜尋的功能旗標（`daemon.hello.features`）。沒有的機器標「版本太舊不支援」、不送請求。 */
export const SEARCH_DEEP_FEATURE = 'search.v1';

/**
 * 一台機器的深層搜尋結束時的狀態：done 搜完（可能因每台筆數上限提早停，見 scanned／total）；
 * offline 機器失聯（沒送出或搜到一半斷線）；unsupported 舊版 daemon；timeout 時間或讀檔量到上限，只搜了一部分。
 */
export const DeepSearchState = z.enum(['done', 'offline', 'unsupported', 'timeout']);
export type DeepSearchState = z.infer<typeof DeepSearchState>;

/** 瀏覽器 → hub：`search.deep` 的條件（同快速層，scope=zone 要帶 zoneId）。searchId 由瀏覽器產生。 */
export const DeepSearchRequest = z
  .object({
    searchId: Id,
    q: z.string().max(SEARCH_QUERY_MAX),
    scope: SearchScope.default(SEARCH_DEFAULTS.scope),
    zoneId: Id.optional(),
    since: SearchSince.default(SEARCH_DEFAULTS.since),
    archived: z.boolean().default(SEARCH_DEFAULTS.archived),
    /** 遮蔽模式：片段在 daemon（hub 轉送前再檢查一次）就遮好，金鑰不會傳到裝置上。 */
    mask: z.boolean().default(false),
  })
  .refine((query) => query.scope !== 'zone' || query.zoneId !== undefined, {
    message: 'scope=zone 要帶 zoneId',
    path: ['zoneId'],
  });
export type DeepSearchRequest = z.infer<typeof DeepSearchRequest>;

/** 深層搜尋開始時，hub 告訴瀏覽器要搜哪幾台機器、各有幾個 session（畫面先列「搜尋中」）。 */
export const DeepSearchMachine = z.object({
  machineId: Id,
  totalSessions: z.number().int().nonnegative(),
});
export type DeepSearchMachine = z.infer<typeof DeepSearchMachine>;

/** hub → daemon：要搜的 session（hub 從資料庫帶齊，daemon 不必還記得它）。 */
export const DeepSearchTarget = z.object({
  sessionId: Id,
  /** 對話紀錄是 `<config>/projects/*\/<claudeSessionId>.jsonl`；沒有就只搜畫面。 */
  claudeSessionId: ClaudeSessionId.nullable(),
  /** CLAUDE_CONFIG_DIR（絕對路徑）；null 是 daemon 的預設。 */
  accountProfile: z.string().nullable(),
  /** 最後活動時間：daemon 依新到舊讀檔。 */
  lastActivityAt: IsoTime.nullable(),
});
export type DeepSearchTarget = z.infer<typeof DeepSearchTarget>;

/** hub → daemon：上限（daemon 照這個停；舊 hub 沒帶的欄位用預設）。 */
export const DeepSearchLimits = z.object({
  perSession: z.number().int().positive().default(SEARCH_DEEP_PER_SESSION),
  perMachine: z.number().int().positive().default(SEARCH_DEEP_PER_MACHINE),
  maxBytes: z.number().int().positive().default(SEARCH_DEEP_MAX_BYTES),
  deadlineMs: z.number().int().positive().default(SEARCH_DEEP_DEADLINE_MS),
});
export type DeepSearchLimits = z.infer<typeof DeepSearchLimits>;
