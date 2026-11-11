// agent-board-session-host 入口（CONTRACTS §20）。由 launchd／工作排程器以獨立服務啟動，不是 daemon 的子程序：
// launchd 停 daemon 時會殺掉整個程序群組，agent 要活下來就只能掛在另一個服務底下。
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import {
  consoleLogger,
  HostAlreadyRunningError,
  HostImpostorError,
  SessionHostServer,
} from './server';

async function main(): Promise<void> {
  const dataDir = process.env.AGENT_BOARD_DATA_DIR || join(homedir(), '.agent-board');
  const server = new SessionHostServer({ dataDir, version: pkg.version });
  try {
    await server.start();
  } catch (error) {
    if (error instanceof HostAlreadyRunningError) {
      // 另一份已經在跑：正常結束（launchd 的 KeepAlive 只在失敗時重啟，不會一直撞）。
      consoleLogger.warn(error.message);
      process.exit(0);
    }
    if (error instanceof HostImpostorError) {
      // 別的程式占了名稱（審查 W3）：失敗結束，排程器會重試，紀錄看得到。daemon 那邊連上會收到 unauthorized 並報給 hub。
      consoleLogger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    consoleLogger.info(`收到 ${signal}，結束所有 agent 後關閉`);
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // host 沒有終端機；SIGHUP 不該讓它結束。
  process.on('SIGHUP', () => {});
  // 開好之後的意外（某個連線的處理出錯）記下來繼續跑：host 一掛，所有 agent 都會跟著結束。
  // 啟動階段的錯誤照舊讓程序失敗（launchd 會重試）。
  process.on('uncaughtException', (error) => {
    consoleLogger.error(
      `未預期的錯誤（繼續執行）：${error instanceof Error ? error.stack : String(error)}`,
    );
  });
  process.on('unhandledRejection', (error) => {
    consoleLogger.error(`未處理的 Promise 錯誤（繼續執行）：${String(error)}`);
  });
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    consoleLogger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
