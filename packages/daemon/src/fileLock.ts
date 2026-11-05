// 同一個檔案的讀改寫要排隊：hook 安裝（開 session）與移除（刪 session）可能同時碰同一個設定檔（CONTRACTS §9.6）。
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const chains = new Map<string, Promise<void>>();

/** 同一個 key 依序執行；前一個失敗不影響下一個。 */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** hook 設定檔的鎖：cwd 先解開符號連結，經過不同路徑進同一個資料夾也是同一把鎖。 */
export async function hookSettingsLockKey(cwd: string): Promise<string> {
  const dir = await realpath(cwd).catch(() => resolve(cwd));
  return join(dir, '.claude', 'settings.local.json');
}
