import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePrivateDir,
  forgetLockedDirs,
  hostEndpoint,
  installId,
  parseWhoamiSid,
  type RunSync,
} from './endpoint';

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

  it('W2 Windows：資料夾拿掉繼承、只給自己的 SID 與 SYSTEM（icacls 用絕對路徑、參數不經過 shell）；每次啟動只做一次', () => {
    forgetLockedDirs();
    const calls: { file: string; args: string[] }[] = [];
    const run: RunSync = (file, args) => {
      calls.push({ file, args });
      return file.endsWith('whoami.exe') ? '"pc\\a b","S-1-5-21-111-222-333-1001"\r\n' : '';
    };
    const env = { SystemRoot: 'C:\\Windows' };
    ensurePrivateDir(dataDir, { platform: 'win32', run, env });
    ensurePrivateDir(dataDir, { platform: 'win32', run, env });
    expect(calls).toEqual([
      { file: 'C:\\Windows\\System32\\whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] },
      {
        file: 'C:\\Windows\\System32\\icacls.exe',
        args: [
          resolve(dataDir),
          '/inheritance:r',
          '/grant:r',
          '*S-1-5-21-111-222-333-1001:(OI)(CI)F',
          '/grant:r',
          '*S-1-5-18:(OI)(CI)F',
        ],
      },
    ]);
    expect(parseWhoamiSid('garbage')).toBeNull();
    forgetLockedDirs();
  });

  it('W2 Windows：icacls 或 whoami 失敗就丟例外（呼叫端拒絕啟動），下次啟動再試', () => {
    forgetLockedDirs();
    const failing: RunSync = (file) => {
      if (file.endsWith('icacls.exe')) throw new Error('Access is denied.');
      return '"pc\\me","S-1-5-21-1-2-3-1001"';
    };
    expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run: failing })).toThrow(
      /icacls 失敗：Access is denied/,
    );
    const noSid: RunSync = () => 'nothing';
    expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run: noSid })).toThrow(/SID/);
    forgetLockedDirs();
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
