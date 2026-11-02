// node-pty 1.1.0 附帶的 spawn-helper 沒有執行權限，少了它每次開 PTY 都會
// 失敗（posix_spawnp failed）。安裝後補上；Windows 沒有這個檔案，不需處理。
// 開發時由 pnpm 的 postinstall 呼叫，發布檔由 npm ci 呼叫，兩種 node_modules 結構都要認得。
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const modules = join(import.meta.dirname, '..', 'node_modules');

function packageDirs() {
  const dirs = [join(modules, 'node-pty')];
  const store = join(modules, '.pnpm');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (entry.startsWith('node-pty@')) dirs.push(join(store, entry, 'node_modules', 'node-pty'));
    }
  }
  return dirs;
}

if (process.platform !== 'win32') {
  for (const dir of packageDirs()) {
    const prebuilds = join(dir, 'prebuilds');
    if (!existsSync(prebuilds)) continue;
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
}
