// 新增 session 的模型下拉（GM 2026-11-17，CONTRACTS §26）：表單狀態 → SessionSpec 的 model／effort／fallbackModel。
// 不碰 React，NewSessionPage 與 QuickCreate 共用，單元測試直接測。
import {
  isSafeModelName,
  supportsFallbackModel,
  validEffort,
  type AgentKind,
  type Machine,
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

/** 機器的 daemon 認不認得推理強度與備援（舊 daemon 不回報 capabilities.modelOptions）。沒選機器時不提示。 */
export const modelOptionsSupported = (machine: Machine | undefined): boolean =>
  machine === undefined || machine.capabilities.modelOptions === true;

/**
 * 實際要送的三個欄位。強度只留這個 agent 能用的；備援只有 Claude、和主模型相同不送（表單另外顯示錯誤）；
 * daemon 太舊就都不送（hub 也會拿掉，畫面與預覽才一致）。
 */
export function modelSpec(input: {
  agent: AgentKind;
  model: ModelPick;
  effort: string;
  fallback: ModelPick;
  supported: boolean;
}): { model: string | null; effort?: SessionEffort; fallbackModel?: string } {
  const model = pickedName(input.model);
  if (!input.supported) return { model };
  const effort = validEffort(input.agent, input.effort)
    ? (input.effort as SessionEffort)
    : undefined;
  const fallback = supportsFallbackModel(input.agent) ? pickedName(input.fallback) : null;
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(fallback && fallback !== model ? { fallbackModel: fallback } : {}),
  };
}
