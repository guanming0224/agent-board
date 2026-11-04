// 操作紀錄畫面的純函式：篩選條件轉成 hub 查詢、動作清單、下載檔名（DISPATCH §7「可查詢、可匯出」）。
import { AUDIT_SYSTEM_USER } from '@agent-board/protocol';
import type { AuditFilter } from '../shared/backend';

/**
 * hub 會寫的動作（packages/hub 的 audit 呼叫）。hub 的 action 篩選是完全相符，
 * 所以下拉選單列出這些；清單外的新動作在「全部」裡照樣看得到。
 */
export const AUDIT_ACTIONS = [
  'terminal.input',
  'terminal.input.partial',
  'terminal.signal',
  'approval.decide',
  'approval.decide_forbidden',
  'approval.resolved',
  'session.create',
  'session.cancel',
  'session.stop',
  'session.resume',
  'session.mark_done',
  'handoff.fired',
  'handoff.delivered',
  'handoff.blocked',
  'handoff.dropped',
  'handoff.enter_aborted',
  'handoff_rule.create',
  'handoff_rule.update',
  'handoff_rule.delete',
  'auth.setup',
  'auth.login',
  'auth.login_failed',
  'user.create',
  'user.delete',
  'user.password_change',
  'user.password_change_failed',
  'user.password_reset',
  'machine.pairing_code',
  'machine.pair',
  'machine.pair_failed',
  'machine.delete',
  'fs.mkdir',
  'settings.update',
  'audit.export',
  'audit.retention',
] as const;

/** hub 一次最多回 1000 筆；畫面一次多載 100。 */
export const AUDIT_PAGE = 100;
export const AUDIT_MAX = 1000;

/** 「使用者」下拉的特殊值：沒有使用者的紀錄（daemon、交接引擎、登入失敗、reset-password 指令）。hub 認得這個值。 */
export const SYSTEM_USER = AUDIT_SYSTEM_USER;

export interface AuditForm {
  action: string;
  sessionId: string;
  /** '' 全部、SYSTEM_USER、或使用者 id。由 hub 篩選（列表與匯出都是）。 */
  userId: string;
  /** `<input type="datetime-local">` 的值，瀏覽器時區。 */
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FORM: AuditForm = {
  action: '',
  sessionId: '',
  userId: '',
  from: '',
  to: '',
};

/**
 * datetime-local（到分鐘）轉 ISO。結束時間要含那一整分鐘，否則選 10:05 會漏掉 10:05:30 的紀錄。
 * 格式不對回 null。
 */
export function localInputToIso(value: string, end = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value)) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  const minuteOnly = value.length === 16;
  return new Date(end && minuteOnly ? ms + 59_999 : ms).toISOString();
}

/** 表單轉成 hub 查詢；時間格式不對就不帶（畫面另外標紅）。匯出用同一份條件，畫面看到什麼就匯出什麼。 */
export function toAuditQuery(form: AuditForm, limit: number): AuditFilter {
  const filter: AuditFilter = { limit };
  if (form.action) filter.action = form.action;
  if (form.sessionId) filter.sessionId = form.sessionId;
  if (form.userId) filter.userId = form.userId;
  const from = form.from ? localInputToIso(form.from) : null;
  const to = form.to ? localInputToIso(form.to, true) : null;
  if (from) filter.from = from;
  if (to) filter.to = to;
  return filter;
}

/** 開始晚於結束：hub 會回空清單，先講清楚比較好。 */
export function rangeReversed(form: AuditForm): boolean {
  const from = form.from ? localInputToIso(form.from) : null;
  const to = form.to ? localInputToIso(form.to, true) : null;
  return from !== null && to !== null && from > to;
}

/** 下載檔名帶本地日期與時間，不同時間匯出的檔案不會同名。 */
export function exportFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `agent-board-audit-${stamp}.csv`;
}
