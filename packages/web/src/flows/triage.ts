// 收件匣（#/inbox，原本的待處理與審核中心合併）的列、分組、排序。純函式，畫面只負責畫。
// 「等你」的數量一律用 protocol attention.ts 的 waitingSessions，和頁首同一份定義。
import {
  isAwaitingTeam,
  isIdleStart,
  waitingSessions,
  type Approval,
  type Session,
  type SessionStatus,
} from '@agent-board/protocol';
import type { WorkItem } from './workItems';

/** 待處理的四組，照 GM 指定的順序（2026-11-06）：要你決定 → 等你回覆 → 出問題 → 其他。 */
export const TRIAGE_GROUPS = ['decide', 'reply', 'trouble', 'other'] as const;
export type TriageGroup = (typeof TRIAGE_GROUPS)[number];

/** 一列是哪一種事；決定徽章文字與可以直接做的動作。 */
export type TriageKind =
  | 'danger'
  | 'permission'
  | 'plan'
  | 'question'
  | 'reply'
  | 'error'
  | 'stuck'
  | 'rate_limited'
  | 'idle';

export interface TriageItem {
  session: Session;
  /** 這列代表的 approval：危險指令優先，否則最早的一筆。沒有就是 null。 */
  approval: Approval | null;
  kind: TriageKind;
  group: TriageGroup;
  /** 從什麼時候開始等（approval 建立或狀態改變的時間）。 */
  since: string;
  /** 算不算在頁首的「等你 N」（attention.ts）。 */
  counted: boolean;
}

const GROUP_OF: Record<TriageKind, TriageGroup> = {
  danger: 'decide',
  permission: 'decide',
  plan: 'decide',
  question: 'reply',
  reply: 'reply',
  error: 'trouble',
  stuck: 'trouble',
  rate_limited: 'trouble',
  idle: 'other',
};

/** 頁面會列出來的狀態；其他（工作中、排隊、完成、失聯）沒有要你處理的事。 */
const LISTED: readonly SessionStatus[] = [
  'waiting_permission',
  'waiting_input',
  'plan_review',
  'error',
  'stuck',
  'rate_limited',
];

/** 同一個 session 的 approval 取一筆代表：危險指令優先，其餘取最早的。 */
export function leadApproval(approvals: readonly Approval[], sessionId: string): Approval | null {
  const mine = approvals
    .filter((a) => a.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return mine.find((a) => a.kind === 'danger') ?? mine[0] ?? null;
}

function kindOf(session: Session, approval: Approval | null): TriageKind | null {
  if (approval) {
    if (approval.kind === 'danger') return 'danger';
    if (approval.kind === 'plan') return 'plan';
    if (approval.kind === 'question') return 'question';
    return 'permission';
  }
  switch (session.status) {
    case 'waiting_permission':
      return 'permission';
    case 'plan_review':
      return 'plan';
    case 'waiting_input':
      return isIdleStart(session) ? 'idle' : 'reply';
    case 'error':
      return 'error';
    case 'stuck':
      return 'stuck';
    case 'rate_limited':
      return 'rate_limited';
    default:
      return null;
  }
}

/**
 * 每個 session 一列（和頁首的「等你」一樣以 session 計）。順序：組別 → 危險指令置頂 → 等最久的在前。
 */
export function triageItems(
  sessions: readonly Session[],
  approvals: readonly Approval[],
): TriageItem[] {
  const counted = new Set(waitingSessions(sessions, approvals).map((s) => s.id));
  const items: TriageItem[] = [];
  for (const session of sessions) {
    if (session.archived) continue;
    const approval = leadApproval(approvals, session.id);
    if (!approval && !LISTED.includes(session.status)) continue;
    // 等隊長／等成員結果（派工，GM 2026-11-11）：結果會自動送進去，不是要你處理的事，不列。
    if (!approval && isAwaitingTeam(session)) continue;
    const kind = kindOf(session, approval);
    if (!kind) continue;
    items.push({
      session,
      approval,
      kind,
      group: GROUP_OF[kind],
      since: approval?.createdAt ?? session.statusSince,
      counted: counted.has(session.id),
    });
  }
  const groupRank = (item: TriageItem) => TRIAGE_GROUPS.indexOf(item.group);
  return items.sort(
    (a, b) =>
      groupRank(a) - groupRank(b) ||
      Number(b.kind === 'danger') - Number(a.kind === 'danger') ||
      a.since.localeCompare(b.since),
  );
}

export interface Grouped<G extends string, V> {
  group: G;
  items: V[];
}

/** 依組別分好；沒有項目的組也留著（畫面要顯示那一組是空的）。 */
export function groupTriage(items: readonly TriageItem[]): Grouped<TriageGroup, TriageItem>[] {
  return TRIAGE_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  }));
}

/**
 * 收件匣「依急迫」（GM 2026-11-08 Q1 預設）：⛔ 危險指令 → ERR（錯誤、卡住）→ PERM → PLAN／ASK，
 * 同一級等最久的在前；和「下一個等我的」（N 鍵）同一個順序。只排算「等你」的列。
 */
const URGENCY: Record<TriageKind, number> = {
  danger: 0,
  error: 1,
  stuck: 1,
  permission: 2,
  plan: 3,
  question: 3,
  reply: 3,
  rate_limited: 9,
  idle: 9,
};

export function urgencyOrder(items: readonly TriageItem[]): TriageItem[] {
  return [...items].sort(
    (a, b) => URGENCY[a.kind] - URGENCY[b.kind] || a.since.localeCompare(b.since),
  );
}

/** 收件匣的列：只列算「等你」的（ASK、PERM、PLAN、ERR），和頁首「等你 N」一樣多；NEW、額度用完不列。 */
export function inboxItems(
  sessions: readonly Session[],
  approvals: readonly Approval[],
): TriageItem[] {
  return triageItems(sessions, approvals).filter((item) => item.counted);
}

/** 篩選：團隊（成員的 session id）與機器。null 表示不篩。 */
export function filterTriage(
  items: readonly TriageItem[],
  filter: { teamMembers: ReadonlySet<string> | null; machineId: string | null },
): TriageItem[] {
  return items.filter(
    (item) =>
      (filter.teamMembers === null || filter.teamMembers.has(item.session.id)) &&
      (filter.machineId === null || item.session.machineId === filter.machineId),
  );
}

/** 一行摘要：在問什麼、要跑什麼，或最後一行輸出。呼叫端負責遮蔽。 */
export function contextLine(item: Pick<TriageItem, 'approval' | 'session'>): string {
  const { approval, session } = item;
  const input = approval?.toolInput ?? null;
  const command = input?.['command'];
  if (typeof command === 'string' && command.trim()) return oneLine(command);
  const questions = input?.['questions'];
  if (Array.isArray(questions)) {
    const first = questions[0] as { question?: unknown } | undefined;
    if (typeof first?.question === 'string') return oneLine(first.question);
  }
  const plan = input?.['plan'];
  if (typeof plan === 'string' && plan.trim()) return firstLine(plan);
  const file = input?.['file_path'];
  if (typeof file === 'string') return file;
  if (approval?.message) return oneLine(approval.message);
  const last = [...session.lastLines].reverse().find((line) => line.trim());
  return last ? oneLine(last) : '';
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const firstLine = (text: string) => oneLine(text.split('\n').find((line) => line.trim()) ?? text);

/** 審核卡的種類：同一種決定一句說明（審核卡上的「為什麼要你決定」）。 */
export type ReviewGroup = 'danger' | 'permission' | 'plan' | 'question' | 'reply';

export function reviewGroupOf(item: WorkItem): ReviewGroup {
  return item.approval ? item.approval.kind : 'reply';
}

/**
 * 選中的項目處理掉（從清單消失）後要選哪一個：原本位置的下一個，沒有就上一個。
 * 選中的還在就不變；清單空了回 null。
 */
export function keepSelection(
  before: readonly string[],
  after: readonly string[],
  selected: string | null,
): string | null {
  if (after.length === 0) return null;
  if (selected !== null && after.includes(selected)) return selected;
  const at = selected === null ? -1 : before.indexOf(selected);
  if (at < 0) return after[0] ?? null;
  // 原本在它後面、現在還在的第一個；都沒了就取原本在它前面的最後一個。
  const later = before.slice(at + 1).find((key) => after.includes(key));
  if (later) return later;
  const earlier = before
    .slice(0, at)
    .reverse()
    .find((key) => after.includes(key));
  return earlier ?? after[0] ?? null;
}
