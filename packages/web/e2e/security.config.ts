// 安全檢查：demo 畫面（遮蔽、XSS）與真 hub（CSP、跨站）。只在 127.0.0.1，假資料，不碰任何外部服務。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const WEB_PORT = 5186;
const HUB_PORT = 5187;
const hubDataDir = process.env.AB_SEC_HUB_DIR ?? mkdtempSync(join(tmpdir(), 'ab-sec-hub-'));
process.env.AB_SEC_HUB_DIR = hubDataDir;

export default defineConfig({
  testDir: '.',
  testMatch: 'security.spec.ts',
  outputDir: '../test-results/security',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, locale: 'zh-TW' },
  webServer: [
    {
      command: `corepack pnpm exec vite --port ${WEB_PORT} --strictPort`,
      cwd: '..',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_AGENT_BOARD_DEMO: '1' },
    },
    {
      command: 'corepack pnpm exec vite build && corepack pnpm exec tsx ../hub/src/main.ts',
      cwd: '..',
      url: `http://127.0.0.1:${HUB_PORT}/api/auth/status`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        AGENT_BOARD_HOST: '127.0.0.1',
        AGENT_BOARD_PORT: String(HUB_PORT),
        AGENT_BOARD_DATA_DIR: hubDataDir,
      },
    },
  ],
});
