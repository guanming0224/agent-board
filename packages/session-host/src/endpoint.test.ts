import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensurePrivateDir,
  ensurePrivateSubdir,
  OWNER_COMMAND,
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

  const ME = 'S-1-5-21-111-222-333-1001';
  /** 假的 whoami／PowerShell／icacls：記下呼叫，owner 由參數決定。 */
  const fakeWindows = (owner = ME, icacls: () => string = () => '') => {
    const calls: { file: string; args: string[]; env?: Record<string, string> }[] = [];
    const run: RunSync = (file, args, extraEnv) => {
      calls.push({ file, args, ...(extraEnv ? { env: extraEnv } : {}) });
      if (file.endsWith('whoami.exe')) return `"pc\\a b","${ME}"\r\n`;
      if (file.endsWith('powershell.exe')) return `${owner}\r\n`;
      return icacls();
    };
    return { calls, run };
  };
  const env = { SystemRoot: 'C:\\Windows' };

  it('W2 Windows：自己的資料夾拿掉繼承、只給自己的 SID 與 SYSTEM（System32 絕對路徑、參數不經過 shell）；每次啟動只做一次', () => {
    forgetLockedDirs();
    const { calls, run } = fakeWindows();
    ensurePrivateDir(dataDir, { platform: 'win32', run, env });
    ensurePrivateDir(dataDir, { platform: 'win32', run, env });
    expect(calls).toEqual([
      { file: 'C:\\Windows\\System32\\whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] },
      {
        file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', OWNER_COMMAND],
        env: { AB_ACL_DIR: resolve(dataDir) },
      },
      {
        file: 'C:\\Windows\\System32\\icacls.exe',
        args: [
          resolve(dataDir),
          '/inheritance:r',
          '/grant:r',
          `*${ME}:(OI)(CI)F`,
          '/grant:r',
          '*S-1-5-18:(OI)(CI)F',
        ],
      },
    ]);
    expect(parseWhoamiSid('garbage')).toBeNull();
    forgetLockedDirs();
  });

  it('R3 Windows：資料夾的擁有者是其他使用者就拒絕啟動、不改權限', () => {
    forgetLockedDirs();
    const { calls, run } = fakeWindows('S-1-5-21-1-2-3-9999');
    expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run, env })).toThrow(
      /擁有者（S-1-5-21-1-2-3-9999）不是目前使用者/,
    );
    expect(calls.some((c) => c.file.endsWith('icacls.exe'))).toBe(false);
    forgetLockedDirs();
  });

  it.each(['S-1-5-32-544', 'S-1-5-18'])(
    'R4 Windows：擁有者是 Administrators／SYSTEM（%s，例如以系統管理員權限安裝）照樣設權限',
    (owner) => {
      forgetLockedDirs();
      const { calls, run } = fakeWindows(owner);
      expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run, env })).not.toThrow();
      expect(calls.some((c) => c.file.endsWith('icacls.exe'))).toBe(true);
      forgetLockedDirs();
    },
  );

  it('R2 Windows：失敗也記住，這次啟動不再重跑 whoami／icacls，照樣丟同一個錯', () => {
    forgetLockedDirs();
    const { calls, run } = fakeWindows(ME, () => {
      throw new Error('Access is denied.');
    });
    expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run, env })).toThrow(
      /icacls 失敗：Access is denied/,
    );
    const count = calls.length;
    expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run, env })).toThrow(
      /icacls 失敗：Access is denied/,
    );
    expect(calls.length).toBe(count);
    forgetLockedDirs();
    const noSid: RunSync = () => 'nothing';
    expect(() => ensurePrivateDir(dataDir, { platform: 'win32', run: noSid })).toThrow(/SID/);
    forgetLockedDirs();
  });

  it('R2：子資料夾只建資料夾（Windows 繼承上層的 ACL，不跑外部指令）；Mac 700', () => {
    const sub = join(dataDir, 'state');
    ensurePrivateSubdir(sub, { platform: 'win32' });
    expect(statSync(sub).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      ensurePrivateSubdir(sub);
      expect(statSync(sub).mode & 0o777).toBe(0o700);
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
