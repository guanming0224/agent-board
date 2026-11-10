// 端對端：真 hub、真 session host、真 daemon、真 hook CLI，只有 claude 是假的（不花額度）。
// 驗證 session host 拆分（CONTRACTS §20）：agent 跑到一半重啟 daemon，agent 不中斷、畫面不缺、狀態正確。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export const PORT = 5217;
const hubDataDir = process.env.AB_HOST_E2E_HUB_DIR ?? mkdtempSync(join(tmpdir(), 'ab-e2e-hub-'));
process.env.AB_HOST_E2E_HUB_DIR = hubDataDir;

export default defineConfig({
  testDir: '.',
  testMatch: 'session-host.spec.ts',
  outputDir: '../test-results/session-host',
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
