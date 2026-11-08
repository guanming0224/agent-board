// 疊加層的狀態（App 依網址寫入）與開關的動作。頁首、收件匣、團隊面板都從這裡開關，不各自改網址規則。
import { create } from 'zustand';
import { closeStep, inboxHash, type ModalKind, type RightPanel } from './overlay';

interface OverlayState {
  right: RightPanel | null;
  modal: ModalKind | null;
}

export const useOverlay = create<OverlayState>(() => ({ right: null, modal: null }));

/** 每筆歷史記著「從哪個網址來」：判斷關面板時能不能直接上一頁。 */
interface HistoryMark {
  /** null：開頁時的第一筆，沒有上一筆。'' 是沒有 hash 的網址（畫布）。 */
  abFrom?: string | null;
}

const mark = (): HistoryMark => (history.state as HistoryMark | null) ?? {};

/** 開頁時的那一筆沒有上一筆（null）；之後推進來的記上一筆網址。已經記過的（上一頁回來的）不改。 */
export function markHistory(oldHash: string | null): void {
  if (mark().abFrom !== undefined) return;
  history.replaceState({ ...mark(), abFrom: oldHash }, '');
}

export function cameFrom(): string | null {
  return mark().abFrom ?? null;
}

/**
 * 換網址但不留歷史（舊網址轉址、關面板）。保留這一筆的來源記號，
 * 並照常發 hashchange，聽網址的元件（設定分類、收件匣目標）才會跟著換。
 */
export function replaceHash(hash: string): void {
  const oldURL = location.href;
  if (location.hash === hash) return;
  history.replaceState(history.state, '', hash);
  dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
}

export function closeModal(): void {
  const step = closeStep(cameFrom(), 'modal', useOverlay.getState().right);
  if (step.back) history.back();
  else replaceHash(step.to);
}

export function closeRight(): void {
  const step = closeStep(cameFrom(), 'right', null);
  if (step.back) history.back();
  else replaceHash(step.to);
}

/** 頁首收件匣鈕與 `I`：開著就收，沒開就打開（團隊面板會被換掉，右側一次一個）。 */
export function toggleInbox(): void {
  if (useOverlay.getState().right?.kind === 'inbox') closeRight();
  else location.hash = inboxHash();
}
