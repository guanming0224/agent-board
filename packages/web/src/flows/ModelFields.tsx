// 新增 session 的模型、推理強度、備援模型欄位（GM 2026-11-17，CONTRACTS §26）。NewSessionPage 與 QuickCreate 共用。
// 模型下拉：預設（不指定）＋設定頁的清單＋「自訂…」（切成輸入框）。清單從 GET /api/model-lists 讀，讀不到用內建清單。
import { useCallback } from 'react';
import {
  MODEL_LISTS_DEFAULT,
  sameModel,
  type AgentKind,
  type Machine,
  type ModelLists,
} from '@agent-board/protocol';
import { useBoard } from '../shared/store';
import { useLoad, type T } from './common';
import {
  CUSTOM,
  onSelect,
  optionSupport,
  pickedName,
  pickError,
  selectValue,
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

function ModelSelect({
  id,
  pick,
  list,
  defaultLabel,
  customPlaceholder,
  onChange,
  t,
}: {
  id: string;
  pick: ModelPick;
  list: readonly string[];
  defaultLabel: string;
  customPlaceholder: string;
  onChange: (next: ModelPick) => void;
  t: T;
}) {
  const value = selectValue(pick, list);
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(onSelect(pick, e.target.value))}>
        <option value="">{defaultLabel}</option>
        {list.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={CUSTOM}>{t('flows.new.modelCustom')}</option>
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
  const list = codex ? lists.codex : lists.claude;
  const support = optionSupport(machine, agent);
  const errors = modelFieldErrors(t, support, model, fallback);
  const efforts = support.efforts as readonly string[];
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
          list={list}
          defaultLabel={t('flows.new.modelDefault')}
          customPlaceholder={t(
            codex ? 'flows.new.modelCustomPlaceholderCodex' : 'flows.new.modelCustomPlaceholder',
          )}
          onChange={setModel}
          t={t}
        />
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
              {level}
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
            list={lists.claude}
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
