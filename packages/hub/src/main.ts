// hub 執行入口。監聽位址被拒絕或資料庫打不開時，訊息印出後以非零結束。
import { createHub } from './server';
import { loadEnvConfig } from './config';

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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
