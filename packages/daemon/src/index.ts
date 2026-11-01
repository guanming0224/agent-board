// agent-board-daemon 入口。見 CONTRACTS.md。
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { Daemon } from './daemon';
import { errorMessage, log } from './log';
import type { CreateStatusTracker } from './status/types';

export { Daemon, type DaemonDeps } from './daemon';
export { loadConfig, type DaemonConfig } from './config';

// Phase 2 接線：換成 Agent B 的狀態機（src/status/）。
const placeholderStatusTracker: CreateStatusTracker = () => ({
  status: 'running',
  claudeSessionId: null,
  onHook: () => {},
  onOutput: () => {},
  onExit: () => {},
  setStuckMinutes: () => {},
  dispose: () => {},
});

// Phase 2 接線：換成 Agent B 的 installHooks（packages/hook）。
const placeholderInstallHooks = async (_cwd: string): Promise<void> => {};

async function main(): Promise<void> {
  const config = loadConfig();
  // 讀完就清掉，git hook、nvidia-smi 等所有子程序才不會繼承到 token。
  delete process.env.AGENT_BOARD_MACHINE_TOKEN;
  const daemon = new Daemon({
    config,
    createStatusTracker: placeholderStatusTracker,
    installHooks: placeholderInstallHooks,
  });
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，關閉中`);
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await daemon.start();
  log.info('已啟動');
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    log.error(errorMessage(error));
    process.exit(1);
  });
}
