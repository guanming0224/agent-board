// 表單草稿（GM 2026-11-14，STYLE §5.2）：浮動對話框開著時背後可以操作，點了會換網址的東西
// （收件匣、團隊框、卡片選單、全尺寸終端機…）會把表單卸載。填到一半的內容放在這裡，
// 再打開同一個表單時還原；只有使用者明確關掉（✕、Esc、手機的返回）或送出成功才清。
// 只放在記憶體（重新整理就沒了），不寫 localStorage：表單裡可能有路徑、第一個指令這類內容。
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { create } from 'zustand';

type Draft = Record<string, unknown>;

interface DraftState {
  drafts: Record<string, Draft>;
}

export const useDrafts = create<DraftState>(() => ({ drafts: {} }));

/** 新增 session 完整表單（#/new）。 */
export const NEW_SESSION_DRAFT = 'new-session';
/** 新增團隊表單（桌面浮動框與手機內嵌共用：跨 640px 換畫法也還原）。 */
export const NEW_TEAM_DRAFT = 'new-team';

export function readDraft<T>(form: string, field: string): T | undefined {
  const draft = useDrafts.getState().drafts[form];
  return draft && field in draft ? (draft[field] as T) : undefined;
}

export function writeDraft(form: string, field: string, value: unknown): void {
  useDrafts.setState((s) => ({
    drafts: { ...s.drafts, [form]: { ...s.drafts[form], [field]: value } },
  }));
}

export function clearDraft(form: string): void {
  useDrafts.setState((s) => {
    if (!(form in s.drafts)) return s;
    const drafts = { ...s.drafts };
    delete drafts[form];
    return { drafts };
  });
}

export function hasDraft(form: string): boolean {
  return form in useDrafts.getState().drafts;
}

/**
 * 和 useState 一樣用，但每次改都寫進草稿；掛載時有草稿就用草稿的值。
 * form 為 null 時就是普通的 useState（同一個元件在別處用、不需要草稿）。
 */
export function useDraftState<T>(
  form: string | null,
  field: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const saved = form === null ? undefined : readDraft<T>(form, field);
    if (saved !== undefined) return saved;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  // 目前的值另外記一份：算新值、寫草稿都在事件處理裡做，不放進 React 的 updater（render 期間不碰別的 store）。
  const current = useRef(value);
  current.current = value;
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(current.current) : next;
      current.current = resolved;
      setValue(resolved);
      if (form !== null) writeDraft(form, field, resolved);
    },
    [form, field],
  );
  return [value, set];
}
