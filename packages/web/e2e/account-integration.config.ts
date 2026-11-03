// 用量、改密碼、操作紀錄的端對端：真 hub、真 daemon、真瀏覽器；不開 session，用不到 claude。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export const PORT = 5191;
const hubDataDir =
  process.env.AB_ACCOUNT_E2E_HUB_DIR ?? mkdtempSync(join(tmpdir(), 'ab-account-e2e-hub-'));
process.env.AB_ACCOUNT_E2E_HUB_DIR = hubDataDir;

export default defineConfig({
  testDir: '.',
  testMatch: 'account-integration.spec.ts',
  outputDir: '../test-results/account-integration',
  workers: 1,
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: 'zh-TW' },
  webServer: {
    command: 'corepack pnpm exec vite build && corepack pnpm exec tsx ../hub/src/main.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/auth/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      AGENT_BOARD_HOST: '127.0.0.1',
      AGENT_BOARD_PORT: String(PORT),
      AGENT_BOARD_DATA_DIR: hubDataDir,
    },
  },
});
