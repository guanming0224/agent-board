// `agent-board-hub reset-password <帳號>`：唯一的管理員忘記密碼時，在 hub 那台電腦上直接改資料庫。
// 能讀寫 hub.db 的人本來就擁有整個 hub，所以這裡不再驗證身分；網頁上的重設仍然只限 owner。
// 不印任何秘密：密碼只從終端機（不回顯）或 stdin 讀，雜湊後寫入，輸出只有帳號名稱與登出了幾個裝置。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_PASSWORD_LENGTH } from '@agent-board/protocol';
import { DEFAULT_PASSWORD_PARAMS, hashPassword, type PasswordParams } from './auth';
import { dataDirFromEnv, DEFAULT_HOST } from './config';
import { openDatabase } from './db';
import { Store } from './store';

export const RESET_PASSWORD_USAGE = `Usage: agent-board-hub reset-password <name>

Sets a new password for <name> directly in the hub database and signs that
user out everywhere. Run it on the hub machine, as the account that runs the hub.

  - In a terminal it asks for the new password twice (nothing is shown).
  - Otherwise it reads the first line of stdin, e.g.
      printf '%s\\n' "$NEW_PASSWORD" | agent-board-hub reset-password <name>

The database is $AGENT_BOARD_DATA_DIR/hub.db (default ~/.agent-board/hub.db).
Set AGENT_BOARD_DATA_DIR the same way the hub service does if you changed it.`;

/** 讀密碼的來源。終端機與管線分開，測試可以替換。 */
export interface PasswordSource {
  isTTY: boolean;
  /** 終端機：顯示提示、不回顯，讀一行。使用者按 Ctrl+C／Ctrl+D 時回 null。 */
  promptHidden(question: string): Promise<string | null>;
  /** 非終端機：讀完整個 stdin。 */
  readAll(): Promise<string>;
}

export interface ResetPasswordIo {
  env: NodeJS.ProcessEnv;
  input: PasswordSource;
  out: (line: string) => void;
  err: (line: string) => void;
  /** 測試用較快的 argon2 參數；正式一律用預設值。 */
  passwordParams?: PasswordParams;
  now?: () => Date;
}

class UsageError extends Error {}

async function readNewPassword(input: PasswordSource): Promise<string | null> {
  if (input.isTTY) {
    const first = await input.promptHidden('New password: ');
    if (first === null) return null;
    const second = await input.promptHidden('Repeat new password: ');
    if (second === null) return null;
    if (first !== second) throw new UsageError('The two passwords do not match. Nothing changed.');
    return first;
  }
  // 管線：只取第一行，行尾的 \r\n 不算密碼的一部分。
  const text = await input.readAll();
  return text.split(/\r?\n/, 1)[0] ?? '';
}

/** 回傳結束碼：0 成功、1 執行失敗（找不到資料庫或帳號、密碼不合規則）、2 用法錯誤、130 使用者取消。 */
export async function runResetPassword(args: string[], io: ResetPasswordIo): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    io.out(RESET_PASSWORD_USAGE);
    return 0;
  }
  const [name, ...extra] = args;
  if (!name || extra.length > 0 || name.startsWith('-')) {
    io.err(RESET_PASSWORD_USAGE);
    return 2;
  }

  // 資料庫不存在就停：openDatabase 會建新檔，在錯的資料夾建一個空的 hub.db 只會讓人更困惑。
  const dbPath = join(dataDirFromEnv(io.env), 'hub.db');
  if (!existsSync(dbPath)) {
    io.err(
      `No hub database at ${dbPath}. Run this on the hub machine; if the hub uses another data folder, set AGENT_BOARD_DATA_DIR to it.`,
    );
    return 1;
  }

  const db = openDatabase(dbPath, { log: io.out });
  try {
    const store = new Store(db, DEFAULT_HOST);
    const found = store.userCredentials(name);
    if (!found) {
      const names = store.listUsers().map((u) => u.name);
      io.err(
        names.length > 0
          ? `No user named "${name}". Users: ${names.join(', ')}`
          : `No user named "${name}". The hub has no users yet; open it in a browser to create the first owner.`,
      );
      return 1;
    }

    let password: string | null;
    try {
      password = await readNewPassword(io.input);
    } catch (error) {
      if (error instanceof UsageError) {
        io.err(error.message);
        return 1;
      }
      throw error;
    }
    if (password === null) {
      io.err('Cancelled. Nothing changed.');
      return 130;
    }
    if ([...password].length < MIN_PASSWORD_LENGTH) {
      io.err(`The password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing changed.`);
      return 1;
    }

    const passwordHash = await hashPassword(password, io.passwordParams ?? DEFAULT_PASSWORD_PARAMS);
    const { user } = found;
    const signedOut = db.transaction(() => {
      store.updateUser(user.id, { passwordHash });
      const count = store.deleteUserAuthSessions(user.id, null);
      // 沒有登入的使用者在操作，記成系統；via 讓人看得出是在 hub 機器上改的。
      store.insertAudit({
        id: randomUUID(),
        userId: null,
        sessionId: null,
        action: 'user.password_reset',
        detail: JSON.stringify({ id: user.id, name: user.name, via: 'cli' }),
        at: (io.now?.() ?? new Date()).toISOString(),
      });
      return count;
    })();
    io.out(
      `Password for "${user.name}" was reset and ${signedOut} login session(s) were signed out. ` +
        'Pages already open lose their connection within about 30 seconds and need to log in again.',
    );
    return 0;
  } finally {
    db.close();
  }
}

/** 真的終端機與 stdin。不回顯：raw mode 下自己處理按鍵，Enter 結束、Ctrl+C／Ctrl+D 取消。 */
export function processPasswordSource(
  stdin: NodeJS.ReadStream = process.stdin,
  stderr: NodeJS.WriteStream = process.stderr,
): PasswordSource {
  return {
    isTTY: Boolean(stdin.isTTY),
    promptHidden: (question) =>
      new Promise((resolve) => {
        // 提示寫到 stderr：stdout 被導到檔案時也看得到，且 stdout 只留結果。
        stderr.write(question);
        let value = '';
        const finish = (result: string | null) => {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write('\n');
          resolve(result);
        };
        const onData = (chunk: Buffer | string) => {
          for (const ch of chunk.toString()) {
            if (ch === '\r' || ch === '\n') return finish(value);
            if (ch === '\u0003' || ch === '\u0004') return finish(null);
            if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
            else if (ch >= ' ') value += ch;
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
      }),
    readAll: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}
