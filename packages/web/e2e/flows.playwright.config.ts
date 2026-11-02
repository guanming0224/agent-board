// 流程畫面專用：自己的 port，不和其他 worktree 的 dev server 共用 5173（reuseExistingServer 會連錯）。
import { defineConfig } from '@playwright/test';

const PORT = 5183;

export default defineConfig({
  testDir: '.',
  testMatch: 'flows*.spec.ts',
  outputDir: '../test-results/flows',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `corepack pnpm exec vite --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
  },
});
