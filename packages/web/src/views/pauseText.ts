// 全部暫停（P2 項目三）的文字組合：純函式，畫面與單元測試共用。
import type { BoardHeld, BoardInterruptResult, Session } from '@agent-board/protocol';
import type { useT } from '../shared/i18n';

type T = ReturnType<typeof useT>;

/** 「立刻中斷」會送 Esc 的 session：還在、狀態是 RUN（PERM／PLAN／ASK／ERR 不動）。 */
export function runningCount(sessions: Session[]): number {
  return sessions.filter((s) => !s.archived && s.endedAt === null && s.status === 'running').length;
}

/** 排隊中的項目（數字為 0 的不列，規格 §3.2）。全部是 0 時回傳 null。 */
export function heldParts(held: BoardHeld, t: T): string | null {
  const parts = [
    held.deliveries > 0 ? t('views.pause.held.deliveries', { n: held.deliveries }) : null,
    held.sessions > 0 ? t('views.pause.held.sessions', { n: held.sessions }) : null,
    held.autoContinues > 0 ? t('views.pause.held.autoContinues', { n: held.autoContinues }) : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(t('views.pause.held.sep')) : null;
}

/** 「全部繼續」前顯示的「會放出：…」。 */
export function releaseText(held: BoardHeld, t: T): string {
  const parts = heldParts(held, t);
  return parts ? t('views.pause.release', { parts }) : t('views.pause.releaseNone');
}

/** 「全部繼續」之後的結果。 */
export function releasedText(released: BoardHeld, t: T): string {
  const parts = heldParts(released, t);
  return parts ? t('views.pause.resumed', { parts }) : t('views.pause.resumedNone');
}

/** 「立刻中斷」的結果：「已中斷 7 個；1 個失聯沒送到」。unsupported 另列（daemon 太舊，為了不按成拒絕權限而沒送）。 */
export function interruptText(results: BoardInterruptResult[], t: T): string {
  const count = (r: BoardInterruptResult['result']) => results.filter((x) => x.result === r).length;
  const requested = count('requested');
  const offline = count('offline');
  const unsupported = count('unsupported');
  const parts = [t('views.pause.interrupted', { n: requested })];
  if (offline > 0) parts.push(t('views.pause.interruptOffline', { n: offline }));
  if (unsupported > 0) parts.push(t('views.pause.interruptUnsupported', { n: unsupported }));
  return parts.join(t('views.pause.interruptSep'));
}

/** 沒送到的那幾個 session 名稱（失聯、daemon 太舊），提示列上列出來讓人知道要自己處理。 */
export function notSentNames(results: BoardInterruptResult[]): string[] {
  return results.filter((x) => x.result !== 'requested').map((x) => x.name);
}
