// 交接規則的純函式：觸發條件的欄位、雙向（來回）一次建兩條、依序建立並回報失敗（GM 2026-11-06）。
import { HANDOFF_MAX_ROUNDS, handoffRuleProblem, type HandoffRule } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';

/** 寫作要補實驗時在回覆裡寫的標記（研究團隊的預設，TEAM.md 範本也用同一個字串）。 */
export const DEFAULT_MARKER = '[需要實驗]';
/** 雙向交接預設來回幾輪。 */
export const TWO_WAY_DEFAULT_ROUNDS = 3;
export const ROUND_OPTIONS = Array.from({ length: HANDOFF_MAX_ROUNDS }, (_, i) => i + 1);

export type Trigger = HandoffRule['trigger'];
export type RuleInput = Omit<HandoffRule, 'id' | 'teamId'>;

/** 一個方向的觸發條件：on_file 用 filePattern、on_marker 用 marker，其他忽略。 */
export interface TriggerChoice {
  trigger: Trigger;
  filePattern: string;
  marker: string;
}

export const triggerChoice = (trigger: Trigger, over: Partial<TriggerChoice> = {}) => ({
  trigger,
  filePattern: '',
  marker: trigger === 'on_marker' ? DEFAULT_MARKER : '',
  ...over,
});

/** 組 action：只帶這個觸發條件用得到的欄位；maxRounds 沒有就是單向（原本的防迴圈）。 */
export function ruleAction(
  toSessionId: string,
  choice: TriggerChoice,
  maxRounds?: number,
): HandoffRule['action'] {
  const pattern = choice.filePattern.trim();
  const marker = choice.marker.trim();
  return {
    toSessionId,
    ...(choice.trigger === 'on_file' && pattern ? { filePattern: pattern } : {}),
    ...(choice.trigger === 'on_marker' && marker ? { marker } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  };
}

/** 改觸發條件、標記、樣式或輪數時，用目前的 action 換掉其中一項（hub 的 PATCH 整個換掉 action）。 */
export function patchAction(
  action: HandoffRule['action'],
  patch: { filePattern?: string; marker?: string; maxRounds?: number | null },
): HandoffRule['action'] {
  const next: HandoffRule['action'] = { ...action };
  if (patch.filePattern !== undefined) {
    if (patch.filePattern.trim()) next.filePattern = patch.filePattern.trim();
    else delete next.filePattern;
  }
  if (patch.marker !== undefined) {
    if (patch.marker.trim()) next.marker = patch.marker.trim();
    else delete next.marker;
  }
  if (patch.maxRounds !== undefined) {
    if (patch.maxRounds === null) delete next.maxRounds;
    else next.maxRounds = patch.maxRounds;
  }
  return next;
}

/** 送出前的檢查，和 hub 相同（protocol 的 handoffRuleProblem）。 */
export const choiceProblem = (choice: TriggerChoice) =>
  handoffRuleProblem({ trigger: choice.trigger, action: ruleAction('x', choice) });

/**
 * 雙向：A→B、B→A 兩條，各自的觸發條件，共用輪數上限。
 * 新規則一律先關著：開啟才會花額度，要使用者自己按。
 */
export function twoWayRules(
  a: string,
  b: string,
  aToB: TriggerChoice,
  bToA: TriggerChoice,
  maxRounds: number,
): [RuleInput, RuleInput] {
  return [
    {
      fromSessionId: a,
      trigger: aToB.trigger,
      action: ruleAction(b, aToB, maxRounds),
      enabled: false,
    },
    {
      fromSessionId: b,
      trigger: bToA.trigger,
      action: ruleAction(a, bToA, maxRounds),
      enabled: false,
    },
  ];
}

export interface RuleFailure {
  input: RuleInput;
  error: unknown;
}

/** 依序建立；某一條失敗就記下來繼續下一條，已建立的保留（不回頭刪）。 */
export async function createRules(
  backend: Pick<BoardBackend, 'createHandoffRule'>,
  teamId: string,
  inputs: readonly RuleInput[],
): Promise<{ created: HandoffRule[]; failed: RuleFailure[] }> {
  const created: HandoffRule[] = [];
  const failed: RuleFailure[] = [];
  for (const input of inputs) {
    try {
      created.push(await backend.createHandoffRule(teamId, input));
    } catch (error) {
      failed.push({ input, error });
    }
  }
  return { created, failed };
}
