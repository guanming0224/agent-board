// 團隊端對端：真 hub、真 daemon、真 hook CLI、真瀏覽器，只有 claude 是假的（不花額度）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export const PORT = 5197;
const hubDataDir =
  process.env.AB_TEAM_E2E_HUB_DIR ?? mkdtempSync(join(tmpdir(), 'ab-team-e2e-hub-'));
process.env.AB_TEAM_E2E_HUB_DIR = hubDataDir;

export default defineConfig({
  testDir: '.',
  testMatch: 'team-integration.spec.ts',
  outputDir: '../test-results/team-integration',
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
