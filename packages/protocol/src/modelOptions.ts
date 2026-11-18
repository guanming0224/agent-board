// 新增 session 的模型細部設定（GM 2026-11-17，CONTRACTS §26）：推理強度、備援模型、設定頁的模型清單。
// 值會原樣進 CLI 的 argv（daemon 一律陣列、不經 shell），所以只收白名單或安全字元。
import { z } from 'zod';
// 白名單本身（CLAUDE_EFFORTS、CODEX_EFFORTS）在 leadGuide.ts：那個檔不 import zod，hook 的 MCP server 直接用。
import { CLAUDE_EFFORTS, CODEX_EFFORTS, CODEX_LEGACY_EFFORTS } from './leadGuide';

/**
 * 兩邊的聯集：SessionSpec 只能先用聯集驗，哪個 agent 能用哪些另外看 `validEffort`。
 * `ultra`（Codex 才有，§26.11）是 0.1.15 加的：舊 daemon 的 SessionSpec 不認得，hub 對沒宣告
 * `session.codexEffortsByModel` 的 daemon 只送 `CODEX_LEGACY_EFFORTS`（`supportedSpec`）。
 */
export const SessionEffort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export type SessionEffort = z.infer<typeof SessionEffort>;

/**
 * 模型名稱的安全字元：英數與 `. _ : / @ - [ ]`（`[ ]` 是 Claude 的 `opus[1m]`、`@` 是 Vertex 的
 * `claude-opus-4-1@20250805` 這類寫法），1–100 字，不能以 `-` 開頭（才不會被 CLI 當成參數）。
 * 空白、引號、逗號、`=`、`$` 都不收。
 */
export const MODEL_NAME_RE = /^(?!-)[A-Za-z0-9._:/@[\]-]{1,100}$/;
export const ModelName = z.string().regex(MODEL_NAME_RE);

export const isSafeModelName = (value: string): boolean => MODEL_NAME_RE.test(value);

/** 備援和主模型是不是同一個（不分大小寫；別名對完整名稱不比，claude 不接受時靠 §26.10 的補救）。 */
export const sameModel = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

type Agent = 'claude' | 'codex';

/** 這個 agent 的安全字元白名單（照 CLI 的順序，低到高）。Codex 實際能用哪些還要看模型（`codexEffortsFor`）。 */
export function effortsFor(agent: Agent): readonly SessionEffort[] {
  return agent === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
}

export function validEffort(agent: Agent, effort: string | null | undefined): boolean {
  return typeof effort === 'string' && (effortsFor(agent) as readonly string[]).includes(effort);
}

/** 備援模型只有 Claude Code 有（`--fallback-model`）；Codex 沒有對應參數。 */
export const supportsFallbackModel = (agent: Agent): boolean => agent === 'claude';

/**
 * 這台機器上的 claude 認得哪些參數（daemon 開機與 claude 版本變了時跑 `claude --help` 解析，§26.10）。
 * `efforts`：說明括號裡列的級別（只留 CLAUDE_EFFORTS 裡的）；括號讀不到＝null（照白名單）。
 * `fallbackModel`：說明寫「只能配 --print」的舊版當作互動模式不支援。
 */
export const ClaudeFlags = z.object({
  effort: z.boolean(),
  efforts: z.array(z.string().max(20)).max(20).nullable(),
  fallbackModel: z.boolean(),
});
export type ClaudeFlags = z.infer<typeof ClaudeFlags>;

/** `claude --help` 裡某個選項的說明（選項那一行加上縮排的續行）；沒有這個選項回 null。 */
function optionBlock(help: string, flag: string): string | null {
  const lines = help.split(/\r?\n/);
  const head = new RegExp(`^\\s*(?:-\\w,\\s*)?${flag}(?=[\\s=<,]|$)`);
  const start = lines.findIndex((line) => head.test(line));
  if (start === -1) return null;
  const block = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    // 下一個選項（縮排後是 -）或不縮排的段落標題：這個選項的說明結束。
    if (/^\s*-/.test(line) || /^\S/.test(line) || line.trim() === '') break;
    block.push(line);
  }
  return block.join(' ').replace(/\s+/g, ' ');
}

export function parseClaudeHelp(help: string): ClaudeFlags {
  const effortBlock = optionBlock(help, '--effort');
  let efforts: string[] | null = null;
  if (effortBlock) {
    for (const [, inside] of effortBlock.matchAll(/\(([^)]*)\)/g)) {
      const levels = inside!
        .split(/[\s,|/]+/)
        .filter((word) => (CLAUDE_EFFORTS as readonly string[]).includes(word));
      if (levels.length > 0) efforts = levels;
    }
  }
  const fallbackBlock = optionBlock(help, '--fallback-model');
  return {
    effort: effortBlock !== null,
    efforts,
    fallbackModel: fallbackBlock !== null && !/only[^.]*--print/i.test(fallbackBlock),
  };
}

/** `allowedModelOptions` 的 Codex 部分：主模型、那台的模型目錄、daemon 認不認得依模型的強度。 */
export interface CodexEffortContext {
  model: string | null | undefined;
  catalog: CodexModels | null | undefined;
  /** daemon 宣告了 `session.codexEffortsByModel`（網頁看 `capabilities.codexModels !== undefined`）；false＝舊白名單。 */
  byModel: boolean;
}

/**
 * 實際能帶的推理強度與備援（hub、daemon、網頁共用）。Codex 看模型目錄（§26.11，沒給 codex＝當成舊 daemon）；
 * Claude 還要看這台 claude 認不認得：claudeFlags 沒有（偵測失敗、舊 daemon）＝都不帶。
 */
export function allowedModelOptions(
  agent: Agent,
  claudeFlags: ClaudeFlags | null | undefined,
  codex?: CodexEffortContext,
): { efforts: readonly SessionEffort[]; fallback: boolean } {
  if (agent === 'codex') {
    return {
      efforts: codex?.byModel ? codexEffortsFor(codex.model, codex.catalog) : CODEX_LEGACY_EFFORTS,
      fallback: false,
    };
  }
  if (!claudeFlags) return { efforts: [], fallback: false };
  const efforts = !claudeFlags.effort
    ? []
    : claudeFlags.efforts === null
      ? CLAUDE_EFFORTS
      : CLAUDE_EFFORTS.filter((level) => claudeFlags.efforts!.includes(level));
  return { efforts, fallback: claudeFlags.fallbackModel };
}

/**
 * daemon 在 hello `features` 宣告：認得 `SessionSpec.effort`／`fallbackModel`。舊 daemon 不認得（zod 會丟掉多的欄位，
 * session 照開、只是沒帶參數），hub 對它們一律不送也不記，網頁看 `MachineCapabilities.modelOptions` 提示「太舊」。
 */
export const MODEL_OPTIONS_FEATURE = 'session.modelOptions';

// ── Codex 模型目錄（`codex debug models`，GM 2026-11-18，CONTRACTS §26.11） ─────────────
/**
 * daemon 在 hello `features` 宣告：Codex 推理強度依模型目錄驗（收 `xhigh`／`max`／`ultra`），capabilities 帶
 * `codexModels`。沒宣告的舊 daemon 只收 `CODEX_LEGACY_EFFORTS`，hub 只送那幾個。
 */
export const CODEX_EFFORTS_BY_MODEL_FEATURE = 'session.codexEffortsByModel';
/** 目錄最多留幾個模型（本機實測 12 個）。 */
export const CODEX_MODELS_MAX = 60;
/** `codex debug models` 的輸出上限（本機實測約 830KB，含每個模型的完整系統提示）。超過就當抓不到。 */
export const CODEX_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

const CodexEffort = z.enum(CODEX_EFFORTS);
/**
 * 目錄裡一個模型：只留 slug、顯示名稱、預設強度、支援的強度、visibility，其他欄位（系統提示、價格、帳號相關）
 * 一律丟掉（`parseCodexModelCatalog`）。`efforts` null＝目錄沒列（當作不知道，收整份白名單）。
 */
export const CodexModelInfo = z.object({
  slug: ModelName,
  displayName: z.string().min(1).max(80),
  defaultEffort: CodexEffort.nullable(),
  efforts: z.array(CodexEffort).max(CODEX_EFFORTS.length).nullable(),
  /** `list`：Codex 自己的選單會列；`hide`：目錄裡有但 Codex 不列（例如審查專用模型）。 */
  visibility: z.enum(['list', 'hide']),
});
export type CodexModelInfo = z.infer<typeof CodexModelInfo>;
export const CodexModels = z.object({
  /** 抓目錄時的 `codex --version`（版本變了才重抓）。 */
  codexVersion: z.string().max(60).nullable(),
  models: z.array(CodexModelInfo).max(CODEX_MODELS_MAX),
});
export type CodexModels = z.infer<typeof CodexModels>;

const isCodexEffort = (value: unknown): value is (typeof CODEX_EFFORTS)[number] =>
  typeof value === 'string' && (CODEX_EFFORTS as readonly string[]).includes(value);

/**
 * 解析 `codex debug models` 的 stdout（`{"models":[…]}`）。只取上面五個欄位；slug 不是安全字元的整筆略過；
 * `supported_reasoning_levels` 的元素可能是字串或 `{ effort, description }`，只留白名單裡的級別。讀不懂回 null。
 */
export function parseCodexModelCatalog(stdout: string): CodexModelInfo[] | null {
  if (stdout.length > CODEX_CATALOG_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = (raw as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return null;
  const out: CodexModelInfo[] = [];
  for (const item of list) {
    if (out.length >= CODEX_MODELS_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const slug = entry.slug;
    if (typeof slug !== 'string' || !isSafeModelName(slug)) continue;
    if (out.some((m) => sameModel(m.slug, slug))) continue;
    const name =
      typeof entry.display_name === 'string'
        ? // 控制字元與格式字元（含雙向控制字元 U+202E 這類）拿掉、壓成一行；顯示用，不進 argv。
          entry.display_name
            .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
        : '';
    // 目錄有列級別（非空陣列）＝已知：和白名單交集，交集是空的就是空陣列（這個模型沒有能帶的強度）；
    // 沒列或空陣列＝不知道（null）。
    const listed =
      Array.isArray(entry.supported_reasoning_levels) &&
      entry.supported_reasoning_levels.length > 0;
    const levels = listed
      ? (entry.supported_reasoning_levels as unknown[])
          .map((level: unknown) =>
            typeof level === 'string'
              ? level
              : level && typeof level === 'object'
                ? (level as { effort?: unknown }).effort
                : null,
          )
          .filter(isCodexEffort)
      : [];
    const efforts = CODEX_EFFORTS.filter((level) => levels.includes(level));
    out.push({
      slug,
      displayName: name || slug,
      defaultEffort: isCodexEffort(entry.default_reasoning_level)
        ? entry.default_reasoning_level
        : null,
      efforts: listed ? efforts : null,
      visibility: entry.visibility === 'list' ? 'list' : 'hide',
    });
  }
  return out;
}

/** 目錄裡的這個模型（不分大小寫）；沒有目錄或找不到回 undefined。 */
export function findCodexModel(
  catalog: CodexModels | null | undefined,
  model: string | null | undefined,
): CodexModelInfo | undefined {
  if (!catalog || !model) return undefined;
  return catalog.models.find((m) => sameModel(m.slug, model));
}

/**
 * Codex 這個模型能用的推理強度（§26.11，hub、daemon、網頁共用）。值一律只有安全字元白名單裡的：
 * - 沒有目錄（舊 daemon、抓不到）：舊安全集合 `CODEX_LEGACY_EFFORTS`（minimal～high）。
 * - 模型不指定（Codex 預設）：目錄裡 visibility=list、有列級別的模型共同支援的級別（交集）；一個都沒有＝舊安全集合。
 * - 模型在目錄而且有列級別：白名單與它的交集（可能是空的＝這個模型帶不了強度）。
 * - 模型不在目錄（自訂名稱）或目錄沒列它的級別：舊安全集合。
 */
export function codexEffortsFor(
  model: string | null | undefined,
  catalog: CodexModels | null | undefined,
): readonly SessionEffort[] {
  if (!catalog) return CODEX_LEGACY_EFFORTS;
  if (!model) {
    const known = catalog.models.filter((m) => m.visibility === 'list' && m.efforts !== null);
    if (known.length === 0) return CODEX_LEGACY_EFFORTS;
    return CODEX_EFFORTS.filter((level) => known.every((m) => m.efforts!.includes(level)));
  }
  const info = findCodexModel(catalog, model);
  if (!info?.efforts) return CODEX_LEGACY_EFFORTS;
  return CODEX_EFFORTS.filter((level) => info.efforts!.includes(level));
}

// ── 設定頁的模型清單（存 hub settings `modelLists`，不升 schema） ─────────────
export const MODEL_LIST_MAX = 30;
const ModelList = z.array(ModelName).max(MODEL_LIST_MAX);
/** 釘選／隱藏的名稱上限（目錄＋自己加的，每個 agent 各一份）。 */
export const MODEL_PREF_MAX = 100;
const ModelPref = z.object({
  claude: z.array(ModelName).max(MODEL_PREF_MAX),
  codex: z.array(ModelName).max(MODEL_PREF_MAX),
});
export type ModelPref = z.infer<typeof ModelPref>;
/**
 * `claude`／`codex`：自己加的名稱（§26 起就有；內建目錄裡已有的名稱在下拉只出現一次）。
 * `pinned`／`hidden`（§26.11，選填）：釘在下拉最上面（照釘的順序）、從下拉拿掉的名稱，內建目錄與自己加的都適用。
 * 舊資料沒有這兩個鍵＝都沒有；舊 hub 存檔時會丟掉（zod 預設丟多的欄位），不會壞。
 */
export const ModelLists = z.object({
  claude: ModelList,
  codex: ModelList,
  pinned: ModelPref.optional(),
  hidden: ModelPref.optional(),
});
export type ModelLists = z.infer<typeof ModelLists>;
/**
 * 「自己加的」預設是空的（§26.11）：Claude 的別名與完整版本在 `CLAUDE_MODEL_CATALOG`，Codex 的模型從各機器的
 * `codex debug models` 目錄來（`modelCatalog.ts`）。§26（0.1.14）的預設是 Claude 四個別名＋Codex `gpt-6-luna`；
 * 存過那份的設定照讀，內建目錄已有的名稱在下拉只出現一次。
 */
export const MODEL_LISTS_DEFAULT: ModelLists = { claude: [], codex: [] };

export const EMPTY_MODEL_PREF: ModelPref = { claude: [], codex: [] };

/** 存之前整理：去前後空白、不分大小寫去重、去空字串（順序照使用者排的）。 */
export function normalizeModelList(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const value = raw.trim();
    // 不分大小寫去重（Opus 和 opus 是同一個別名），留第一次出現的寫法。
    if (value && !out.some((name) => sameModel(name, value))) out.push(value);
  }
  return out;
}
