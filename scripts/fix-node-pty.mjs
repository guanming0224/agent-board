// node-pty 1.1.0 附帶的 spawn-helper 沒有執行權限，少了它每次開 PTY 都會
// 失敗（posix_spawnp failed）。安裝後補上；Windows 沒有這個檔案，不需處理。
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const store = join(import.meta.dirname, '..', 'node_modules', '.pnpm');
if (process.platform !== 'win32' && existsSync(store)) {
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('node-pty@')) continue;
    const prebuilds = join(store, entry, 'node_modules', 'node-pty', 'prebuilds');
    if (!existsSync(prebuilds)) continue;
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  }
}
