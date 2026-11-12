// 資料保留：session_events 到期直接刪；audit 一定先寫成 CSV 再刪（DISPATCH §7「可查詢、可匯出」）。
import { closeSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditToCsv } from './audit';
import type { RetentionDays } from './config';
import { ReviewStore } from './reviews';
import type { Store } from './store';

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** 一輪最多處理的筆數；清不完留到下一輪，不要一次卡住事件迴圈太久。 */
export const AUDIT_BATCH = 50_000;
/** 每個 session 的畫面只讀最新 1000 筆，這個總量上限防的是事件暴衝。 */
export const MAX_EVENT_ROWS = 2_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  eventsDeleted: number;
  /** 交叉審查（schema v11）：和事件同一個保留期限，只刪已結束的。 */
  reviewsDeleted: number;
  auditDeleted: number;
  /** 這一輪寫出的封存檔；沒有就是 null。 */
  archive: string | null;
}

/** 封存檔含終端機輸入，和資料庫一樣只給擁有者讀。先寫暫存檔再改名，看到的封存檔一定完整。 */
function writeArchive(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return path;
}

export const archiveDir = (dbPath: string): string => join(dirname(dbPath), 'audit-archive');

export function runRetention(
  store: Store,
  days: RetentionDays,
  dbPath: string,
  now: Date,
): RetentionResult {
  const cutoff = (n: number) => new Date(now.getTime() - n * DAY_MS).toISOString();
  const result: RetentionResult = {
    eventsDeleted: 0,
    reviewsDeleted: 0,
    auditDeleted: 0,
    archive: null,
  };
  if (days.eventDays > 0) {
    result.eventsDeleted = store.pruneEvents(cutoff(days.eventDays), MAX_EVENT_ROWS);
    result.reviewsDeleted = new ReviewStore(store).prune(cutoff(days.eventDays));
  }
  // 記憶體資料庫沒有地方放封存檔，不清。
  if (days.auditDays > 0 && dbPath !== ':memory:') {
    const batch = store.auditOlderThan(cutoff(days.auditDays), AUDIT_BATCH);
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (first && last) {
      const stamp = (at: string) => at.replace(/[:.]/g, '-');
      const name = `audit-${stamp(first.at)}--${stamp(last.at)}-${batch.length}.csv`;
      result.archive = writeArchive(archiveDir(dbPath), name, auditToCsv(batch));
      store.deleteAudit(batch.map((entry) => entry.id));
      result.auditDeleted = batch.length;
    }
  }
  return result;
}
