// 配對後保存的機器憑證。內含長期 token：只存在資料夾內、權限 0600，內容不可印出。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Id } from '@agent-board/protocol';
import { z } from 'zod';

const MachineCredentials = z.object({
  machineId: Id,
  token: z.string().min(1),
  /** 配對時的 hub origin。 */
  hubUrl: z.string().min(1),
});
export type MachineCredentials = z.infer<typeof MachineCredentials>;

export const credentialsPath = (dataDir: string): string => join(dataDir, 'machine.json');

export function readCredentials(dataDir: string): MachineCredentials | null {
  const path = credentialsPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return MachineCredentials.parse(JSON.parse(raw));
  } catch {
    // 錯誤訊息不帶原始內容，裡面可能有 token。
    throw new Error(
      `機器憑證 ${path} 內容損壞，無法讀取。請到中控台產生新的配對碼，重新執行 agent-board-daemon pair。`,
    );
  }
}

export function writeCredentials(dataDir: string, credentials: MachineCredentials): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  // 暫存檔一建立就是 0600，rename 後舊檔的寬鬆權限也不會留下。
  writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
