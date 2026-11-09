// Codex 節點端對端（CONTRACTS §19）：真 hub、真 daemon、真 hook CLI（--agent codex）、真瀏覽器，只有 codex 是假的（不花額度）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export const PORT = 5207;
const hubDataDir =
  process.env.AB_CODEX_E2E_HUB_DIR ?? mkdtempSync(join(tmpdir(), 'ab-codex-e2e-hub-'));
process.env.AB_CODEX_E2E_HUB_DIR = hubDataDir;

export default defineConfig({
  testDir: '.',
  testMatch: 'codex-integration.spec.ts',
  outputDir: '../test-results/codex-integration',
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
