import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // node-pty 是原生模組，不能跑在 worker thread。
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
