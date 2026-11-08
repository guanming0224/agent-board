// 團隊工作台：自己的埠，不和其他 worktree 的 dev server 共用（reuseExistingServer 會連錯）。
import { defineConfig } from '@playwright/test';

const PORT = 5185;

export default defineConfig({
  testDir: '.',
  // workspaces.spec.ts：P2 項目二（工作區＋團隊名單面板），同樣用 demo 假後端。
  testMatch: ['team.spec.ts', 'workspaces.spec.ts'],
  outputDir: '../test-results/team',
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: 'zh-TW' },
  webServer: {
    command: `corepack pnpm exec vite --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: { VITE_AGENT_BOARD_DEMO: '1' },
  },
});
