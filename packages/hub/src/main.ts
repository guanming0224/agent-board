// hub 執行入口。監聽位址被拒絕或資料庫打不開時，訊息印出後以非零結束。
// 不帶參數（服務就是這樣啟動）才開 hub；`reset-password <帳號>` 是救援指令，打錯的參數不會意外開出第二個 hub。
import { createHub } from './server';
import { loadEnvConfig } from './config';
import { processPasswordSource, RESET_PASSWORD_USAGE, runResetPassword } from './resetPassword';

const USAGE = `Usage:
  agent-board-hub                         start the hub
  agent-board-hub reset-password <name>   set a new password (run on the hub machine)

${RESET_PASSWORD_USAGE}`;

async function main(): Promise<void> {
  const config = loadEnvConfig();
  const hub = createHub({
    dbPath: config.dbPath,
    host: config.host,
    port: config.port,
    logger: true,
    retention: config.retention,
  });
  const shutdown = () => {
    hub.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const { url } = await hub.listen();
  hub.app.log.info(`Agent Board hub listening on ${url}`);
}

const fail = (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);
if (command === undefined) {
  main().catch(fail);
} else if (command === 'reset-password') {
  runResetPassword(rest, {
    env: process.env,
    input: processPasswordSource(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then((code) => process.exit(code), fail);
} else if (command === '-h' || command === '--help' || command === 'help') {
  console.log(USAGE);
} else {
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  process.exit(2);
}
