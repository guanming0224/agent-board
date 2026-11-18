// 新增 session 的模型下拉（GM 2026-11-17，CONTRACTS §26）：表單狀態 → SessionSpec 的 model／effort／fallbackModel。
// 不碰 React，NewSessionPage 與 QuickCreate 共用，單元測試直接測。
import {
  allowedModelOptions,
  CLAUDE_MODEL_CATALOG,
  CODEX_MODELS_FALLBACK,
  codexEffortsFor,
  codexSeries,
  effortsFor,
  findCodexModel,
  isSafeModelName,
  sameModel,
  supportsFallbackModel,
  type AgentKind,
  type CodexModels,
  type Machine,
  type ModelLists,
  type ModelNote,
  type SessionEffort,
} from '@agent-board/protocol';

/** 一個模型下拉的狀態：選了清單裡的（custom false），或「自訂…」（custom true，value 是輸入框的字）。 */
export interface ModelPick {
  value: string;
  custom: boolean;
}

export const NO_MODEL: ModelPick = { value: '', custom: false };

/** 下拉選單的 value：清單沒有的名稱（例如範本帶來的）也當「自訂…」顯示。 */
export const CUSTOM = '__custom__';
export function selectValue(pick: ModelPick, list: readonly string[]): string {
  if (pick.custom) return CUSTOM;
  if (pick.value === '' || list.includes(pick.value)) return pick.value;
  return CUSTOM;
}

// ── 下拉的分組（§26.11） ───────────────────────────────────────────
/** 一個選項：value 是帶進 CLI 的名稱。 */
export interface MenuItem {
  value: string;
  /** 顯示名稱（Opus、GPT-6.2-Sol…）；自己加的名稱沒有。 */
  label: string | null;
  note: ModelNote | null;
  /** Codex 目錄裡這個模型的預設強度（只有真的抓到目錄才有）。 */
  defaultEffort: string | null;
}
/**
 * pinned：釘選；alias／version：Claude 內建的別名、完整版本；series：Codex 目錄依系列（`series` 是 GPT-6.2 這種）；
 * codexOther：目錄裡認不出系列的；codexHidden：目錄標 visibility=hide（Codex 自己的選單不列）；mine：自己加的。
 */
export type MenuGroupKey =
  'pinned' | 'alias' | 'version' | 'series' | 'codexOther' | 'codexHidden' | 'mine';
export interface MenuGroup {
  key: MenuGroupKey;
  series: string | null;
  items: MenuItem[];
}
export interface ModelMenu {
  groups: MenuGroup[];
  /** 下拉裡所有名稱（selectValue／pickForAgent 用）。 */
  names: string[];
}

/** 這台機器的 Codex 目錄；沒有（舊 daemon、抓不到）回 null。 */
export const machineCodexCatalog = (machine: Machine | undefined): CodexModels | null =>
  machine?.capabilities.codexModels ?? null;

/** 下拉用的 Codex 目錄：那台抓到的，沒有就內建名單（`source` 給畫面提示）。 */
export function codexCatalogFor(machine: Machine | undefined): {
  catalog: CodexModels;
  source: 'machine' | 'builtin';
} {
  const own = machineCodexCatalog(machine);
  return own && own.models.length > 0
    ? { catalog: own, source: 'machine' }
    : { catalog: CODEX_MODELS_FALLBACK, source: 'builtin' };
}

/** 設定頁用：所有機器抓到的 Codex 目錄合在一起（同 slug 留第一個）；都沒有就內建名單。 */
export function mergedCodexCatalog(machines: readonly Machine[]): CodexModels {
  const models: CodexModels['models'] = [];
  for (const machine of machines) {
    for (const model of machineCodexCatalog(machine)?.models ?? []) {
      if (!models.some((m) => sameModel(m.slug, model.slug))) models.push(model);
    }
  }
  return models.length > 0 ? { codexVersion: null, models } : CODEX_MODELS_FALLBACK;
}

/** 內建目錄（Claude 的內建清單、Codex 的目錄）轉成分組前的項目。 */
export function catalogItems(
  agent: AgentKind,
  codexCatalog: CodexModels,
): { item: MenuItem; key: MenuGroupKey; series: string | null }[] {
  if (agent === 'claude') {
    return CLAUDE_MODEL_CATALOG.map((m) => ({
      item: { value: m.name, label: m.label, note: m.note, defaultEffort: null },
      key: m.kind === 'alias' ? 'alias' : 'version',
      series: null,
    }));
  }
  return codexCatalog.models.map((m) => {
    const series = codexSeries(m.slug);
    return {
      item: {
        value: m.slug,
        label: m.displayName === m.slug ? null : m.displayName,
        note: null,
        defaultEffort: m.defaultEffort,
      },
      key: m.visibility === 'hide' ? 'codexHidden' : series ? 'series' : 'codexOther',
      series: m.visibility === 'hide' ? null : series,
    };
  });
}

const has = (list: readonly string[] | undefined, name: string) =>
  (list ?? []).some((n) => sameModel(n, name));

/**
 * 新增 session 的模型下拉：釘選的在最上面（照釘的順序），接著內建目錄（Claude：別名、完整版本；Codex：依系列、
 * 再來目錄標隱藏的），最後自己加的；設定頁隱藏的拿掉。名稱比對不分大小寫，同一個名稱只出現一次。
 */
export function modelMenu(
  agent: AgentKind,
  lists: ModelLists,
  codexCatalog: CodexModels,
): ModelMenu {
  const hidden = lists.hidden?.[agent];
  const pinned = lists.pinned?.[agent] ?? [];
  const catalog = catalogItems(agent, codexCatalog);
  const mine = lists[agent].filter((name) => !catalog.some((c) => sameModel(c.item.value, name)));
  const find = (name: string): MenuItem =>
    catalog.find((c) => sameModel(c.item.value, name))?.item ?? {
      value: mine.find((n) => sameModel(n, name)) ?? name,
      label: null,
      note: null,
      defaultEffort: null,
    };

  const groups: MenuGroup[] = [];
  const push = (key: MenuGroupKey, series: string | null, item: MenuItem) => {
    let group = groups.find((g) => g.key === key && g.series === series);
    if (!group) {
      group = { key, series, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  };
  for (const name of pinned) if (!has(hidden, name)) push('pinned', null, find(name));
  const shown = (name: string) => !has(hidden, name) && !has(pinned, name);
  // Codex 的系列照目錄出現的順序；隱藏的（visibility=hide）、認不出系列的放在系列後面。
  const order: MenuGroupKey[] = ['alias', 'version', 'series', 'codexOther', 'codexHidden'];
  for (const key of order) {
    for (const c of catalog) if (c.key === key && shown(c.item.value)) push(key, c.series, c.item);
  }
  for (const name of mine) if (shown(name)) push('mine', null, find(name));
  return { groups, names: groups.flatMap((g) => g.items.map((i) => i.value)) };
}

/**
 * 設定頁「自己加的」上下移（§26.11）：畫面只列 `shown`（完整清單去掉目錄已有的），移動時在完整清單 `full` 裡
 * 交換那兩個名稱的位置，其他（目錄已有、畫面沒列的）原地不動、不會被刪掉。
 */
export function moveShown(
  full: readonly string[],
  shown: readonly string[],
  index: number,
  by: -1 | 1,
): string[] {
  const a = shown[index];
  const b = shown[index + by];
  const next = [...full];
  if (a === undefined || b === undefined) return next;
  const ia = next.indexOf(a);
  const ib = next.indexOf(b);
  if (ia === -1 || ib === -1) return next;
  next[ia] = b;
  next[ib] = a;
  return next;
}

/** 目錄（或內建清單）裡這個名稱的資料；自己打的名稱回 null。 */
export function menuItemFor(
  agent: AgentKind,
  codexCatalog: CodexModels,
  name: string | null,
): MenuItem | null {
  if (!name) return null;
  return catalogItems(agent, codexCatalog).find((c) => sameModel(c.item.value, name))?.item ?? null;
}

/** 下拉選單換選項。選「自訂…」時保留目前的字（從清單項目切過去就帶著那個名稱，方便改版本號）。 */
export function onSelect(pick: ModelPick, selected: string): ModelPick {
  if (selected === CUSTOM) return { value: pick.value, custom: true };
  return { value: selected, custom: false };
}

/** 送出用的名稱：去前後空白，空的是 null（不指定）。 */
export const pickedName = (pick: ModelPick): string | null => pick.value.trim() || null;

/** 名稱的錯誤代碼：自訂卻沒填（empty）、有不允許的字元（name）。 */
export function pickError(pick: ModelPick): 'empty' | 'name' | null {
  const name = pickedName(pick);
  if (name === null) return pick.custom ? 'empty' : null;
  return isSafeModelName(name) ? null : 'name';
}

/** 換 agent 時：清單項目（別人家的別名）清掉回「預設」；使用者自己打的自訂名稱留著。 */
export function pickForAgent(pick: ModelPick, list: readonly string[]): ModelPick {
  if (pick.custom || pick.value === '' || list.includes(pick.value)) return pick;
  return NO_MODEL;
}

/** 這台的 Codex 目錄說這個模型的預設強度（標「此模型預設」用）；目錄沒有就 null。 */
export const codexDefaultEffort = (
  machine: Machine | undefined,
  model: string | null,
): string | null => findCodexModel(machineCodexCatalog(machine), model)?.defaultEffort ?? null;

/** 那台機器實際能帶的強度與備援，以及帶不了的原因（畫面提示用）。 */
export interface OptionSupport {
  efforts: readonly SessionEffort[];
  fallback: boolean;
  /** old_daemon：daemon 不認得這兩個欄位；old_claude：那台 claude 不認得（部分）參數（§26.10）。 */
  reason: 'old_daemon' | 'old_claude' | null;
}

/**
 * 看機器的 capabilities：daemon 太舊（沒有 modelOptions）都不行；Claude 再看 `claudeFlags`（`claude --help` 偵測）。
 * 沒選機器時照白名單、不提示。hub 用同一個 `allowedModelOptions` 拿掉，畫面、預覽、實際送出才一致。
 */
export function optionSupport(
  machine: Machine | undefined,
  agent: AgentKind,
  /** 主模型（Codex 的強度依模型，§26.11）。 */
  model: string | null = null,
): OptionSupport {
  if (machine === undefined) {
    return {
      efforts: agent === 'codex' ? codexEffortsFor(model, null) : effortsFor(agent),
      fallback: supportsFallbackModel(agent),
      reason: null,
    };
  }
  if (machine.capabilities.modelOptions !== true) {
    return { efforts: [], fallback: false, reason: 'old_daemon' };
  }
  // daemon 帶了 codexModels 這個鍵（就算是 null）＝認得依模型的 Codex 強度；沒有＝舊白名單（hub 也只送那幾個）。
  const allowed = allowedModelOptions(agent, machine.capabilities.claudeFlags, {
    model,
    catalog: machineCodexCatalog(machine),
    byModel: machine.capabilities.codexModels !== undefined,
  });
  const full =
    agent === 'codex' ||
    (allowed.fallback && allowed.efforts.length === effortsFor('claude').length);
  return { ...allowed, reason: full ? null : 'old_claude' };
}

/**
 * 實際要送的三個欄位。強度只留這台能用的；備援只有支援時、和主模型相同（不分大小寫）不送（表單另外顯示錯誤）。
 */
export function modelSpec(input: {
  model: ModelPick;
  effort: string;
  fallback: ModelPick;
  support: OptionSupport;
}): { model: string | null; effort?: SessionEffort; fallbackModel?: string } {
  const model = pickedName(input.model);
  const effort = (input.support.efforts as readonly string[]).includes(input.effort)
    ? (input.effort as SessionEffort)
    : undefined;
  const fallback = input.support.fallback ? pickedName(input.fallback) : null;
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(fallback && !sameModel(fallback, model) ? { fallbackModel: fallback } : {}),
  };
}
