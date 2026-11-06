// agent-board-daemon 入口。見 CONTRACTS.md。
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installHooks } from '@agent-board/hook';
import { loadConfig, resolveDataDir } from './config';
import { Daemon } from './daemon';
import { errorMessage, log } from './log';
import { pairMachine, parsePairArgs } from './pair';
import { probeCapabilities } from './resources';
import { createStatusTracker } from './status';

export { Daemon, type DaemonDeps } from './daemon';
export { loadConfig, type DaemonConfig } from './config';

/** 沒有指定 hook 路徑時，用這個套件自己依賴的那一支，使用者不必另外裝到 PATH。 */
function useBundledHook(): void {
  if (process.env.AGENT_BOARD_HOOK_BIN) return;
  const bundled = fileURLToPath(new URL('../node_modules/.bin/agent-board-hook', import.meta.url));
  if (existsSync(bundled)) process.env.AGENT_BOARD_HOOK_BIN = bundled;
}

/**
 * 派工 MCP server（CONTRACTS §11）：發布檔裡和 daemon 打包在一起（dist/agent-board-mcp.mjs）；
 * 開發時直接用 hook 套件的原始碼（node 原生 type stripping，同 agent-board-hook）。
 */
function useBundledMcpServer(): void {
  if (process.env.AGENT_BOARD_MCP_SERVER) return;
  for (const candidate of ['./agent-board-mcp.mjs', '../../hook/src/mcp.ts']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      process.env.AGENT_BOARD_MCP_SERVER = path;
      return;
    }
  }
}

async function pair(argv: string[]): Promise<void> {
  const { hub, code } = parsePairArgs(argv);
  const { machineId, path } = await pairMachine({
    hub,
    code,
    name: process.env.AGENT_BOARD_MACHINE_NAME || undefined,
    dataDir: resolveDataDir(process.env),
    capabilities: await probeCapabilities(
      process.env.AGENT_BOARD_CLAUDE_BIN || 'claude',
      process.env,
    ),
  });
  console.log(
    `配對成功。機器 ID：${machineId}；憑證已存到 ${path}。現在可以啟動 agent-board-daemon。`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'pair') return pair(rest);
  if (command !== undefined) {
    throw new Error(
      `不認得的指令「${command}」。可用：agent-board-daemon、agent-board-daemon pair`,
    );
  }
  useBundledHook();
  useBundledMcpServer();
  const config = loadConfig();
  // 讀完就清掉，git hook、nvidia-smi 等所有子程序才不會繼承到 token。
  delete process.env.AGENT_BOARD_MACHINE_TOKEN;
  const daemon = new Daemon({
    config,
    createStatusTracker,
    installHooks,
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
