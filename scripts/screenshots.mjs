// 用 demo 模式（?demo=1）產生 README 的截圖到 docs/screenshots/。畫面上全是 fakeBackend 的假資料。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const webDir = join(root, 'packages/web');
const { chromium } = createRequire(join(webDir, 'package.json'))('@playwright/test');
const outDir = join(root, 'docs/screenshots');
mkdirSync(outDir, { recursive: true });

const port = await new Promise((done) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => done(free));
  });
});

const preview = spawn(
  'corepack',
  ['pnpm', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: webDir, stdio: 'ignore', detached: true },
);
const base = `http://127.0.0.1:${port}`;

async function waitForServer() {
  for (let i = 0; i < 100; i += 1) {
    if ((await fetch(base).catch(() => null))?.ok) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('vite 沒有啟動');
}

const SHOTS = [
  { file: 'canvas', hash: 'canvas', locale: 'en', viewport: { width: 1440, height: 900 } },
  { file: 'canvas.zh-TW', hash: 'canvas', locale: 'zh-TW', viewport: { width: 1440, height: 900 } },
  { file: 'review', hash: 'review', locale: 'en', viewport: { width: 1280, height: 800 } },
  { file: 'review.zh-TW', hash: 'review', locale: 'zh-TW', viewport: { width: 1280, height: 800 } },
  { file: 'onboarding', hash: 'onboarding', locale: 'en', viewport: { width: 1280, height: 800 } },
  {
    file: 'onboarding.zh-TW',
    hash: 'onboarding',
    locale: 'zh-TW',
    viewport: { width: 1280, height: 800 },
  },
  { file: 'inbox', hash: 'inbox', locale: 'en', viewport: { width: 390, height: 780 } },
  { file: 'inbox.zh-TW', hash: 'inbox', locale: 'zh-TW', viewport: { width: 390, height: 780 } },
];

try {
  await waitForServer();
  const browser = await chromium.launch();
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      locale: shot.locale,
      viewport: shot.viewport,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    await page.goto(`${base}/?demo=1#/${shot.hash}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_200);
    await page.screenshot({ path: join(outDir, `${shot.file}.png`) });
    await context.close();
    console.log(`${shot.file}.png`);
  }
  await browser.close();
} finally {
  process.kill(-preview.pid);
}
