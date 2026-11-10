// 狀態機快照（CONTRACTS §20.3）：session host 模式下 daemon 停掉時 agent 還在跑，下一個 daemon 接回時從這裡
// 拿回狀態，不必等下一個 hook。`<dataDir>/state/<id>.json`（檔案 600、資料夾 700）。
// 只有狀態與數字，不含終端機內容、prompt、工具輸入。狀態變化時就寫，daemon 崩潰（沒跑到 stop）也有最近的一份。
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Id, IsoTime, SessionStatus } from '@agent-board/protocol';
import { ensurePrivateDir, writePrivateFile } from '@agent-board/session-host';
import { z } from 'zod';
import { errorMessage, log } from './log';

export const SessionSnapshot = z.object({
  version: z.literal(1),
  sessionId: Id,
  savedAt: IsoTime,
  status: SessionStatus,
  statusDetail: z.string().nullable(),
  statusSince: IsoTime,
  claudeSessionId: z.string().min(1).nullable(),
  contextTokens: z.number().int().nonnegative().nullable(),
  hookModel: z.string().nullable(),
  transcriptModel: z.string().nullable(),
  lastOutputAt: IsoTime.nullable(),
  /** 存檔當下還在等網頁決定的審批。接回後一律改成「請在終端機回答」（hook 連線已斷）。 */
  pendingApprovalIds: z.array(z.string()),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

export const stateDir = (dataDir: string): string => join(dataDir, 'state');

/** session id 會變成檔名：只收安全的字元（UUID 一定符合）。 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

function fileFor(dataDir: string, sessionId: string): string | null {
  return SAFE_ID.test(sessionId) ? join(stateDir(dataDir), `${sessionId}.json`) : null;
}

export function writeSnapshot(dataDir: string, snapshot: SessionSnapshot): void {
  const file = fileFor(dataDir, snapshot.sessionId);
  if (!file) return;
  try {
    ensurePrivateDir(stateDir(dataDir));
    writePrivateFile(file, `${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    log.warn(`無法寫入 session ${snapshot.sessionId} 的狀態快照：${errorMessage(error)}`);
  }
}

export function readSnapshot(dataDir: string, sessionId: string): SessionSnapshot | null {
  const file = fileFor(dataDir, sessionId);
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const snapshot = SessionSnapshot.parse(JSON.parse(text));
    return snapshot.sessionId === sessionId ? snapshot : null;
  } catch (error) {
    log.warn(`session ${sessionId} 的狀態快照壞了，改用畫面判斷：${errorMessage(error)}`);
    return null;
  }
}

export function removeSnapshot(dataDir: string, sessionId: string): void {
  const file = fileFor(dataDir, sessionId);
  if (file) rmSync(file, { force: true });
}

/** 不在 keep 裡的快照都刪掉（session 已經不在了）。 */
export function pruneSnapshots(dataDir: string, keep: ReadonlySet<string>): void {
  let names: string[];
  try {
    names = readdirSync(stateDir(dataDir));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (name.endsWith('.tmp') || (name.endsWith('.json') && !keep.has(id))) {
      rmSync(join(stateDir(dataDir), name), { force: true });
    }
  }
}
