import { defineConfig } from '@playwright/test';

// 全尺寸終端機與完成提示。自己的埠，不會連到其他 worktree 的 dev server。
const PORT = 5191;

export default defineConfig({
  testDir: '.',
  testMatch: 'expanded.spec.ts',
  outputDir: '../test-results/expanded',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'zh-TW',
    // 和 terminal.spec 一樣讓無頭 Chromium 有 WebGL2（軟體繪製）。
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: `corepack pnpm exec vite --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    env: { VITE_AGENT_BOARD_DEMO: '1' },
  },
});
