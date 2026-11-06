// 任務卡上「自動執行做到哪」的文字（GM 2026-11-06）。純函式：回傳訊息鍵與參數，畫面再翻譯。
import { TASK_REJECT_LIMIT, type Task } from '@agent-board/protocol';

export interface StatusLine {
  key: string;
  params: Record<string, string | number>;
}

/** 卡片顯示用的短名：拿掉「團隊名-」前綴（T-BD1 → BD1），不是這個格式就原樣。 */
export function shortName(name: string, teamName: string): string {
  const prefix = `${teamName}-`;
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

/**
 * 最後一步（例：已送給 BD1・等回覆）加上退回次數（RV 退回 1/3）。沒有自動執行過、也沒退回過就是空的。
 * `nameOf` 把 session id 換成短名；找不到（已刪）回 null，顯示「?」。
 */
export function taskStatusLines(
  task: Pick<Task, 'auto' | 'rejectCount' | 'reviewerSessionId' | 'needsUser'>,
  nameOf: (sessionId: string | null) => string | null,
  limit: number = TASK_REJECT_LIMIT,
): StatusLine[] {
  const lines: StatusLine[] = [];
  const auto = task.auto;
  if (auto) {
    const name = nameOf(auto.sessionId) ?? '?';
    if (auto.state === 'limit') {
      lines.push({ key: 'team.tasks.auto.limit', params: { name, n: task.rejectCount, limit } });
    } else if (auto.state === 'dropped') {
      const reason = auto.note ?? 'unknown';
      lines.push({ key: 'team.tasks.auto.dropped', params: { name, reason } });
    } else {
      lines.push({ key: `team.tasks.auto.${auto.state}`, params: { name } });
    }
  }
  if (task.rejectCount > 0 && auto?.state !== 'limit') {
    const name = nameOf(task.reviewerSessionId) ?? '?';
    lines.push({
      key: 'team.tasks.auto.rejects',
      params: { name, n: task.rejectCount, limit },
    });
  }
  return lines;
}

/** dropped 的原因代碼 → 訊息鍵；認不得的用通用說法。 */
export const DROP_REASONS = [
  'automation_off',
  'task_moved',
  'task_deleted',
  'target_ended',
  'target_busy',
  'hub_restarted',
] as const;

export const dropReasonKey = (reason: string): string =>
  (DROP_REASONS as readonly string[]).includes(reason)
    ? `team.tasks.drop.${reason}`
    : 'team.tasks.drop.unknown';
