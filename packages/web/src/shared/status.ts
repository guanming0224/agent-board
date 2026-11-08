// 狀態的視覺語意（STYLE.md 規則一、規則二）。整個前端只從這裡取，不各寫一份。
import {
  isIdleStart,
  type PermissionMode,
  type Session,
  type SessionStatus,
} from '@agent-board/protocol';

export type BallHolder = 'you' | 'fault' | 'agent' | 'quota' | 'idle';

export const STATUS_VISUAL: Record<
  SessionStatus,
  { glyph: string; holder: BallHolder; labelKey: string }
> = {
  waiting_permission: { glyph: '◆', holder: 'you', labelKey: 'status.waiting_permission' },
  waiting_input: { glyph: '◇', holder: 'you', labelKey: 'status.waiting_input' },
  plan_review: { glyph: '▣', holder: 'you', labelKey: 'status.plan_review' },
  error: { glyph: '✕', holder: 'fault', labelKey: 'status.error' },
  stuck: { glyph: '⚠', holder: 'fault', labelKey: 'status.stuck' },
  running: { glyph: '●', holder: 'agent', labelKey: 'status.running' },
  starting: { glyph: '◌', holder: 'agent', labelKey: 'status.starting' },
  queued: { glyph: '⋯', holder: 'agent', labelKey: 'status.queued' },
  rate_limited: { glyph: '⧖', holder: 'quota', labelKey: 'status.rate_limited' },
  done: { glyph: '✓', holder: 'idle', labelKey: 'status.done' },
  offline: { glyph: '⊘', holder: 'idle', labelKey: 'status.offline' },
};

export type HandsLine = 'dotted' | 'dashed' | 'solid' | 'heavy' | 'bypass';

export const HANDS_LINE: Record<PermissionMode, HandsLine> = {
  plan: 'dotted',
  dontAsk: 'dotted',
  default: 'dashed',
  acceptEdits: 'solid',
  auto: 'heavy',
  bypassPermissions: 'bypass',
};

/**
 * 狀態代碼（GM 2026-11-08）：每張卡、每個徽章上的英文代碼，一個代碼一個顏色（tokens.css 的 --c-<code>）。
 * 順序就是側欄圖例的順序：先是算「等你」的四種，再來是其他。
 */
export const STATUS_CODES = [
  'PERM',
  'ASK',
  'PLAN',
  'ERR',
  'NEW',
  'RUN',
  'QUE',
  'QUOTA',
  'DONE',
  'OFF',
] as const;
export type StatusCode = (typeof STATUS_CODES)[number];

const CODE_OF: Record<SessionStatus, StatusCode> = {
  starting: 'NEW',
  running: 'RUN',
  waiting_input: 'ASK',
  waiting_permission: 'PERM',
  plan_review: 'PLAN',
  error: 'ERR',
  stuck: 'ERR',
  rate_limited: 'QUOTA',
  queued: 'QUE',
  done: 'DONE',
  offline: 'OFF',
};

/**
 * session 的狀態代碼。整個前端只用這一個判斷，不各寫一份。
 * waiting_input 且 statusDetail 是 idle:start（daemon 在 SessionStart startup 時標的：剛開好、還沒下指令）
 * 是 NEW，不是 ASK。
 */
export function statusCode(session: Pick<Session, 'status' | 'statusDetail'>): StatusCode {
  return isIdleStart(session) ? 'NEW' : CODE_OF[session.status];
}

/**
 * 算不算「等你」，與待處理的順序（數字小的先）：故障優先 → PERM（最急）→ PLAN／ASK。
 * 沒有 rank 的代碼不算等你（NEW、RUN、QUE、QUOTA、DONE、OFF）。
 */
const WAIT_RANK: Partial<Record<StatusCode, number>> = {
  ERR: 0,
  PERM: 1,
  PLAN: 2,
  ASK: 2,
};

export const codeWaits = (code: StatusCode): boolean => WAIT_RANK[code] !== undefined;

/** 待處理的順序；不算等你的排最後。 */
export const codeRank = (code: StatusCode): number => WAIT_RANK[code] ?? 9;

/** 這個 session 的狀態算不算「等你」（ASK、PERM、PLAN、ERR）。 */
export const waitsForYou = (session: Pick<Session, 'status' | 'statusDetail'>): boolean =>
  codeWaits(statusCode(session));

/** 這個 session 的符號：剛開好（NEW）的 waiting_input 用啟動中的符號，其餘照 STATUS_VISUAL。 */
export function statusGlyph(session: Pick<Session, 'status' | 'statusDetail'>): string {
  return isIdleStart(session) ? STATUS_VISUAL.starting.glyph : STATUS_VISUAL[session.status].glyph;
}

/** 這個 session 的完整中文（英文）說明的字串 key：分得出錯誤與卡住、啟動中與剛開好。 */
export function statusLabelKey(session: Pick<Session, 'status' | 'statusDetail'>): string {
  return isIdleStart(session) ? 'status.idle_start' : STATUS_VISUAL[session.status].labelKey;
}

/** 代碼本身的說明（側欄圖例用），例如 ERR 是「錯誤或卡住」。 */
export const codeLabelKey = (code: StatusCode): string => `code.${code}`;

/** 代碼的 CSS class（shared/styles/status.css 的 .c-<code>，設定 --sc）。 */
export const codeClass = (code: StatusCode): string => `c-${code.toLowerCase()}`;

/** 待處理順序：故障優先、再 PERM、再 PLAN／ASK，同級等最久的排前面。命中危險指令的置頂由呼叫端用 approvals 判斷。 */
export function attentionQueue(sessions: readonly Session[]): Session[] {
  const rank = (s: Session) => codeRank(statusCode(s));
  return sessions
    .filter((s) => !s.archived && waitsForYou(s))
    .sort((a, b) => rank(a) - rank(b) || a.statusSince.localeCompare(b.statusSince));
}
