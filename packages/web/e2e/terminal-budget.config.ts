import { defineConfig } from '@playwright/test';

// 畫布終端機名額（25 個 session 反覆縮放）。自己的埠，不連到其他 worktree 的 dev server。
export default defineConfig({
  testDir: '.',
  testMatch: 'terminal-budget.spec.ts',
  outputDir: '../test-results/terminal-budget',
  use: { baseURL: 'http://127.0.0.1:5221', locale: 'zh-TW' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'corepack pnpm exec vite --port 5221 --strictPort',
    cwd: '..',
    url: 'http://127.0.0.1:5221',
    reuseExistingServer: false,
    env: { VITE_AGENT_BOARD_DEMO: '1' },
  },
});
