// 新增 session 的模型細部設定（GM 2026-11-17，CONTRACTS §26）：推理強度、備援模型、設定頁的模型清單。
// 值會原樣進 CLI 的 argv（daemon 一律陣列、不經 shell），所以只收白名單或安全字元。
import { z } from 'zod';
// 白名單本身（CLAUDE_EFFORTS、CODEX_EFFORTS）在 leadGuide.ts：那個檔不 import zod，hook 的 MCP server 直接用。
import { CLAUDE_EFFORTS, CODEX_EFFORTS } from './leadGuide';

/** 兩邊的聯集：SessionSpec 只能先用聯集驗，哪個 agent 能用哪些另外看 `validEffort`。 */
export const SessionEffort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
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

/** 這個 agent 能用的推理強度（照 CLI 的順序，低到高）。 */
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

/**
 * 實際能帶的推理強度與備援（hub、daemon、網頁共用）。Codex 看白名單；Claude 還要看這台 claude 認不認得：
 * claudeFlags 沒有（偵測失敗、舊 daemon）＝都不帶。
 */
export function allowedModelOptions(
  agent: Agent,
  claudeFlags: ClaudeFlags | null | undefined,
): { efforts: readonly SessionEffort[]; fallback: boolean } {
  if (agent === 'codex') return { efforts: CODEX_EFFORTS, fallback: false };
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

// ── 設定頁的模型清單（存 hub settings `modelLists`，不升 schema） ─────────────
export const MODEL_LIST_MAX = 30;
const ModelList = z.array(ModelName).max(MODEL_LIST_MAX);
export const ModelLists = z.object({ claude: ModelList, codex: ModelList });
export type ModelLists = z.infer<typeof ModelLists>;
/**
 * 內建清單（GM 2026-11-17）。Claude 用 CLI 別名（永遠指最新版）。Codex 只放 repo 裡用真 codex-cli 實測過的名稱
 * （CONTRACTS §19.6、§22：`gpt-6-luna`），其他名稱不猜，要用就在設定頁加或選「自訂…」。
 */
export const MODEL_LISTS_DEFAULT: ModelLists = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-6-luna'],
};

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
