// 新增 session 的模型、推理強度、備援模型欄位（GM 2026-11-17，CONTRACTS §26）。NewSessionPage 與 QuickCreate 共用。
// 模型下拉（§26.11 起分組）：預設（CLI 預設）＋釘選＋內建目錄（Claude 別名／完整版本；Codex 依那台 `codex debug models`
// 的目錄分系列）＋自己加的＋「自訂…」（切成輸入框）。清單與隱藏／釘選從 GET /api/model-lists 讀，讀不到用內建清單。
import { useCallback } from 'react';
import {
  MODEL_LISTS_DEFAULT,
  sameModel,
  type AgentKind,
  type Machine,
  type ModelLists,
  type ModelNote,
} from '@agent-board/protocol';
import { useLocale } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useLoad, type T } from './common';
import {
  codexCatalogFor,
  codexDefaultEffort,
  CUSTOM,
  menuItemFor,
  modelMenu,
  onSelect,
  optionSupport,
  pickedName,
  pickError,
  selectValue,
  type MenuGroup,
  type MenuItem,
  type ModelMenu,
  type ModelPick,
  type OptionSupport,
} from './modelChoice';
import { Field } from './sessionForm';

/** 設定頁的模型清單；還沒讀到或讀失敗就用內建清單（表單照樣能用）。 */
export function useModelLists(): ModelLists {
  const backend = useBoard((s) => s.backend);
  const lists = useLoad(useCallback(() => backend.getModelLists(), [backend]));
  return lists.data ?? MODEL_LISTS_DEFAULT;
}

/** 欄位錯誤（擋送出）：模型、備援的名稱，備援和主模型相同（不分大小寫）。備援帶不了（隱藏）時不檢查。 */
export function modelFieldErrors(
  t: T,
  support: OptionSupport,
  model: ModelPick,
  fallback: ModelPick,
): { model: string | null; fallback: string | null } {
  const nameError = (pick: ModelPick) => {
    const code = pickError(pick);
    return code === 'empty'
      ? t('flows.new.err.modelEmpty')
      : code === 'name'
        ? t('flows.new.err.modelName')
        : null;
  };
  return {
    model: nameError(model),
    fallback: !support.fallback
      ? null
      : (nameError(fallback) ??
        (sameModel(pickedName(fallback), pickedName(model))
          ? t('flows.new.err.fallbackSame')
          : null)),
  };
}

/** 說明文字照介面語言。 */
export function useNoteText(): (note: ModelNote | null) => string | null {
  const locale = useLocale((s) => s.locale);
  return (note) => (note ? (locale === 'zh-TW' ? note.zh : note.en) : null);
}

/** 分組標題（optgroup label）。 */
export function groupLabel(t: T, group: Pick<MenuGroup, 'key' | 'series'>): string {
  if (group.key === 'series') return group.series ?? '';
  return t(`flows.new.modelGroup.${group.key}`);
}

/** 選項文字：`Opus · opus — 能力最強…`；顯示名稱和名稱一樣時只寫一次。 */
export function optionText(item: MenuItem, note: string | null): string {
  const head = item.label ? `${item.label} · ${item.value}` : item.value;
  return note ? `${head} — ${note}` : head;
}

function ModelSelect({
  id,
  pick,
  menu,
  defaultLabel,
  customPlaceholder,
  onChange,
  t,
}: {
  id: string;
  pick: ModelPick;
  menu: ModelMenu;
  defaultLabel: string;
  customPlaceholder: string;
  onChange: (next: ModelPick) => void;
  t: T;
}) {
  const value = selectValue(pick, menu.names);
  const noteText = useNoteText();
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(onSelect(pick, e.target.value))}>
        <option value="">{defaultLabel}</option>
        {menu.groups.map((group) => (
          <optgroup
            key={`${group.key}:${group.series ?? ''}`}
            label={groupLabel(t, group)}
            data-group={group.key}
          >
            {group.items.map((item) => (
              <option key={item.value} value={item.value}>
                {optionText(item, noteText(item.note))}
              </option>
            ))}
          </optgroup>
        ))}
        <optgroup label={t('flows.new.modelGroup.custom')} data-group="custom">
          <option value={CUSTOM}>{t('flows.new.modelCustom')}</option>
        </optgroup>
      </select>
      {value === CUSTOM && (
        <input
          id={`${id}-custom`}
          className="mono"
          aria-label={t('flows.new.modelCustomLabel')}
          placeholder={customPlaceholder}
          value={pick.value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange({ value: e.target.value, custom: true })}
        />
      )}
    </>
  );
}

export function ModelFields({
  idPrefix,
  agent,
  lists,
  machine,
  model,
  setModel,
  effort,
  setEffort,
  fallback,
  setFallback,
  t,
}: {
  idPrefix: string;
  agent: AgentKind;
  lists: ModelLists;
  machine: Machine | undefined;
  model: ModelPick;
  setModel: (next: ModelPick) => void;
  effort: string;
  setEffort: (next: string) => void;
  fallback: ModelPick;
  setFallback: (next: ModelPick) => void;
  t: T;
}) {
  const codex = agent === 'codex';
  const { catalog: codexCatalog, source } = codexCatalogFor(machine);
  const menu = modelMenu(agent, lists, codexCatalog);
  const support = optionSupport(machine, agent, pickedName(model));
  const errors = modelFieldErrors(t, support, model, fallback);
  const efforts = support.efforts as readonly string[];
  // 目錄說的這個模型預設強度（Codex 才有）：標在那個級別旁邊。
  const defaultEffort = codex ? codexDefaultEffort(machine, pickedName(model)) : null;
  const noteText = useNoteText();
  const chosen = menuItemFor(agent, codexCatalog, pickedName(model));
  const chooseModel = (next: ModelPick) => {
    setModel(next);
    // 換模型時目前的強度新模型不支援就清掉（Codex 依模型，§26.11）；草稿一起清。
    if (
      effort &&
      !(optionSupport(machine, agent, pickedName(next)).efforts as readonly string[]).includes(
        effort,
      )
    ) {
      setEffort('');
    }
  };
  return (
    <>
      <Field
        label={t('flows.new.model')}
        htmlFor={`${idPrefix}-model`}
        hint={t(codex ? 'flows.new.modelHintCodex' : 'flows.new.modelHint')}
        error={errors.model}
      >
        <ModelSelect
          id={`${idPrefix}-model`}
          pick={model}
          menu={menu}
          defaultLabel={t(codex ? 'flows.new.modelDefaultCodex' : 'flows.new.modelDefault')}
          customPlaceholder={t(
            codex ? 'flows.new.modelCustomPlaceholderCodex' : 'flows.new.modelCustomPlaceholder',
          )}
          onChange={chooseModel}
          t={t}
        />
        {chosen && (chosen.note || chosen.label) && (
          <p className="hint" data-testid={`${idPrefix}-model-note`}>
            {[chosen.label, noteText(chosen.note)].filter(Boolean).join('：')}
          </p>
        )}
        {codex && machine && source === 'builtin' && (
          <p className="hint" data-testid="codex-catalog-builtin">
            {t('flows.new.codexCatalogBuiltin', { machine: machine.name })}
          </p>
        )}
      </Field>
      <Field
        label={t('flows.new.effort')}
        htmlFor={`${idPrefix}-effort`}
        hint={t(codex ? 'flows.new.effortHintCodex' : 'flows.new.effortHint')}
      >
        <select
          id={`${idPrefix}-effort`}
          // 這台用不了的強度（換了 agent、claude 太舊）：顯示成「跟 CLI 預設」（送出時也不帶）。
          value={efforts.includes(effort) ? effort : ''}
          disabled={efforts.length === 0}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">{t('flows.new.effortDefault')}</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level === defaultEffort ? t('flows.new.effortModelDefault', { level }) : level}
            </option>
          ))}
        </select>
      </Field>
      {/* 備援模型只有 Claude Code 有（--fallback-model），而且那台 claude 要認得；不然不顯示。 */}
      {!codex && support.fallback && (
        <Field
          label={t('flows.new.fallback')}
          htmlFor={`${idPrefix}-fallback`}
          hint={t('flows.new.fallbackHint')}
          error={errors.fallback}
        >
          <ModelSelect
            id={`${idPrefix}-fallback`}
            pick={fallback}
            menu={menu}
            defaultLabel={t('flows.new.fallbackDefault')}
            customPlaceholder={t('flows.new.modelCustomPlaceholder')}
            onChange={setFallback}
            t={t}
          />
        </Field>
      )}
      {support.reason === 'old_daemon' && machine && (
        <p className="field-error" role="status" data-testid="model-options-old">
          {t('flows.new.modelOptionsOld', { machine: machine.name })}
        </p>
      )}
      {support.reason === 'old_claude' && machine && (
        <p className="field-error" role="status" data-testid="model-options-old-claude">
          {t('flows.new.modelOptionsOldClaude', { machine: machine.name })}
        </p>
      )}
    </>
  );
}
