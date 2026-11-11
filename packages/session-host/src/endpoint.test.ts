import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostEndpoint, installId } from './endpoint';

describe('位置', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ab-ep-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('installId：每份安裝一個隨機亂數，存 600 檔，之後讀回同一個', () => {
    const id = installId(dataDir);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // Windows 沒有 Unix 檔案權限。
    if (process.platform !== 'win32') {
      expect(statSync(join(dataDir, 'install-id')).mode & 0o777).toBe(0o600);
    }
    expect(installId(dataDir)).toBe(id);
    expect(readFileSync(join(dataDir, 'install-id'), 'utf8').trim()).toBe(id);
    const other = mkdtempSync(join(tmpdir(), 'ab-ep-'));
    try {
      expect(installId(other)).not.toBe(id);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('Windows：pipe 名稱含使用者與 installId（別人猜不到）；Mac 是資料夾裡的 Unix socket', () => {
    const pipe = hostEndpoint(dataDir, 'win32');
    expect(pipe.kind).toBe('pipe');
    expect(pipe.path.startsWith('\\\\.\\pipe\\agent-board-session-host-')).toBe(true);
    expect(pipe.path.endsWith(`-${installId(dataDir)}`)).toBe(true);
    const unix = hostEndpoint(dataDir, 'darwin');
    expect(unix).toMatchObject({ kind: 'unix', path: join(dataDir, 'session-host.sock') });
  });
});
