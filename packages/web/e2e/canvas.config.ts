import { defineConfig } from '@playwright/test';

// 多個 worktree 可能同時跑 5173，reuseExistingServer 會連到別人的畫面，所以這份測試用自己的埠。
export default defineConfig({
  testDir: '.',
  testMatch: 'canvas.spec.ts',
  outputDir: '../test-results/canvas',
  use: { baseURL: 'http://127.0.0.1:5174', locale: 'zh-TW' },
  webServer: {
    command: 'corepack pnpm exec vite --port 5174 --strictPort',
    cwd: '..',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: { VITE_AGENT_BOARD_DEMO: '1' },
  },
});
