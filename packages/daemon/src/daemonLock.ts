// 一份資料夾只能有一個 daemon（複查 R1）：`<dataDir>/daemon.lock` 記 pid 與啟動時間。
// 以前只靠 hook socket「連得上就是另一個 daemon」判斷；Windows 的 hook pipe 被占時會改用備用名稱，
// 如果另一個合法 daemon 只是回應慢，就會變成同一份資料夾兩個 daemon 用同一個機器 token 搶 host 與 session。
// 所以先拿這把鎖：拿得到才確定這份資料夾沒有其他活著的 daemon。Mac／Linux 一樣套用（hook socket 的判斷照舊保留）。
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentStillRunning, type StartTimeOptions } from './processCheck';

export const DAEMON_LOCK_FILE = 'daemon.lock';
/** 鎖檔是空的或讀不懂、而且 10 秒內才建立：當成別人正在寫，不搶。 */
const FRESH_MS = 10_000;

interface LockContent {
  pid: number;
  startedAt: string;
  instance: string;
}

/** 這個程序裡拿著的鎖（同一個程序開兩個 Daemon 時 pid 相同，靠這個分辨；測試會這樣做）。 */
const heldHere = new Map<string, string>();

export class DaemonLockedError extends Error {}

const processStartedAt = () => new Date(Date.now() - process.uptime() * 1000).toISOString();

function readLock(path: string): LockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockContent>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      instance: String(parsed.instance ?? ''),
    };
  } catch {
    return null;
  }
}

export interface DaemonLock {
  path: string;
  release(): void;
}

/**
 * 拿 `<dataDir>/daemon.lock`。另一個活著的 daemon 拿著（pid 在、啟動時間對得上）就丟 DaemonLockedError；
 * 鎖的主人不在了（過期鎖）就接手。先寫 `daemon.lock.<instance>` 再改名蓋過去，改完再讀一次確認是自己的。
 */
export async function acquireDaemonLock(
  dataDir: string,
  options: StartTimeOptions = {},
): Promise<DaemonLock> {
  const path = resolve(join(dataDir, DAEMON_LOCK_FILE));
  const mine: LockContent = {
    pid: process.pid,
    startedAt: processStartedAt(),
    instance: randomUUID(),
  };
  const text = `${JSON.stringify(mine)}\n`;
  const lock: DaemonLock = {
    path,
    release: () => {
      if (heldHere.get(path) !== mine.instance) return;
      heldHere.delete(path);
      if (readLock(path)?.instance === mine.instance) rmSync(path, { force: true });
    },
  };
  if (heldHere.has(path)) {
    throw new DaemonLockedError(`這個程序裡已經有 daemon 在使用 ${dataDir}`);
  }
  try {
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    heldHere.set(path, mine.instance);
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const existing = readLock(path);
  if (existing === null) {
    let age = Infinity;
    try {
      age = Date.now() - statSync(path).mtimeMs;
    } catch {
      // 剛被刪掉：下面照樣接手
    }
    if (age < FRESH_MS) {
      throw new DaemonLockedError(`${path} 剛被另一個 daemon 建立，不搶；稍後再試`);
    }
  } else if (existing.pid !== process.pid) {
    if (await agentStillRunning(existing.pid, existing.startedAt, options)) {
      throw new DaemonLockedError(
        `已有 daemon（pid ${existing.pid}）在使用 ${dataDir}，不再啟動第二個（同一份資料夾兩個 daemon 會用同一個機器 token 搶 session）。先停掉它。`,
      );
    }
  }
  // 過期鎖（主人不在了；或同一個 pid 但不是這個程序裡拿著的＝上次崩潰留下的）：接手。
  const temp = `${path}.${mine.instance}`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
  if (readLock(path)?.instance !== mine.instance) {
    throw new DaemonLockedError(`${path} 同時被另一個 daemon 接手了，不搶`);
  }
  heldHere.set(path, mine.instance);
  return lock;
}
