// 推播：真 hub、真 service worker、真通知權限。只在 127.0.0.1，不連任何外部推播服務。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 5191;
const hubDataDir = process.env.AB_PUSH_HUB_DIR ?? mkdtempSync(join(tmpdir(), 'ab-push-hub-'));
process.env.AB_PUSH_HUB_DIR = hubDataDir;

export default defineConfig({
  testDir: '.',
  testMatch: 'push.spec.ts',
  outputDir: '../test-results/push',
  workers: 1,
  // 舊的 headless shell 給了權限 Notification.permission 還是 'denied'；完整 Chromium 的新 headless 才對。
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: 'zh-TW', channel: 'chromium' },
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
