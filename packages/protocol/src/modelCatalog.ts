// 內建模型目錄（GM 2026-11-18，CONTRACTS §26.11）：新增 session 的模型下拉、設定頁的隱藏／釘選都用這裡。
// 以後模型改版只要改這個檔。
import type { CodexModels } from './modelOptions';

/** 一句說明（中英各一）。 */
export interface ModelNote {
  zh: string;
  en: string;
}

export interface BuiltinClaudeModel {
  /** 帶進 `--model` 的名稱。 */
  name: string;
  /** alias：永遠指最新版（CLI 別名）；version：固定版本的完整名稱。 */
  kind: 'alias' | 'version';
  label: string;
  note: ModelNote;
}

// Fable 的能力 repo 裡沒有依據，只寫中性的「Fable 系列」，不自己編描述（GM 2026-11-18）。
const FABLE: ModelNote = { zh: 'Fable 系列', en: 'Fable family' };
const OPUS: ModelNote = {
  zh: '能力最強，較慢、較耗額度',
  en: 'Most capable; slower and uses more quota',
};
const SONNET: ModelNote = { zh: '速度與能力平衡', en: 'Balances speed and capability' };
const HAIKU: ModelNote = { zh: '最快、最省額度', en: 'Fastest; uses the least quota' };

/**
 * Claude Code 沒有列出模型的指令，所以這份是內建的。別名（`--model opus` 這類）永遠指最新版；
 * 完整版本固定在那一版（claude 2.1.326 的 `--help` 寫 `--model` 收別名或完整名稱）。
 */
export const CLAUDE_MODEL_CATALOG: readonly BuiltinClaudeModel[] = [
  { name: 'fable', kind: 'alias', label: 'Fable', note: FABLE },
  { name: 'opus', kind: 'alias', label: 'Opus', note: OPUS },
  { name: 'sonnet', kind: 'alias', label: 'Sonnet', note: SONNET },
  { name: 'haiku', kind: 'alias', label: 'Haiku', note: HAIKU },
  { name: 'claude-fable-5-1', kind: 'version', label: 'Fable 5.1', note: FABLE },
  { name: 'claude-opus-5-5', kind: 'version', label: 'Opus 5.5', note: OPUS },
  { name: 'claude-sonnet-5-5', kind: 'version', label: 'Sonnet 5.5', note: SONNET },
  { name: 'claude-haiku-5-5', kind: 'version', label: 'Haiku 5.5', note: HAIKU },
];

/**
 * daemon 抓不到 `codex debug models`（舊 daemon、沒裝 codex、指令失敗）時網頁用的 Codex 名單：2026-11-18 在開發機
 * 用 codex-cli 0.167.0 實際跑 `codex debug models` 看到的 visibility=list 模型。目錄會因帳號與版本不同，所以只拿來
 * 列名稱；強度不在這裡判斷（`efforts: null`＝看那台的白名單），預設強度也不標。
 */
export const CODEX_MODELS_FALLBACK: CodexModels = {
  codexVersion: null,
  models: [
    ['gpt-6.2-sol', 'GPT-6.2-Sol'],
    ['gpt-6.2-astra', 'GPT-6.2-Astra'],
    ['gpt-6.1-terra', 'GPT-6.1 Terra'],
    ['gpt-6.1-sol', 'GPT-6.1-Sol'],
    ['gpt-6-astra', 'GPT-6-Astra'],
    ['gpt-6-sol', 'GPT-6-Sol'],
    ['gpt-6-luna', 'GPT-6-Luna'],
    ['gpt-5.6-sol', 'GPT-5.6-Sol'],
    ['gpt-5.6-terra', 'GPT-5.6-Terra'],
    ['gpt-5.6-luna', 'GPT-5.6-Luna'],
  ].map(([slug, displayName]) => ({
    slug: slug!,
    displayName: displayName!,
    defaultEffort: null,
    efforts: null,
    visibility: 'list' as const,
  })),
};

/** Codex 模型的系列（下拉分組用）：`gpt-6.2-sol` → `GPT-6.2`；認不出來回 null。 */
export function codexSeries(slug: string): string | null {
  const match = /^gpt-(\d+(?:\.\d+)?)(?:-|$)/i.exec(slug);
  return match ? `GPT-${match[1]}` : null;
}
