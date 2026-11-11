// 複查 R1：一份資料夾只能有一個 daemon（`<dataDir>/daemon.lock`）。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDaemonLock, DAEMON_LOCK_FILE, DaemonLockedError } from './daemonLock';
import { Harness, makeTempDir } from './test-support/harness';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(): string {
  const dir = makeTempDir();
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 另一個活著的程序（模擬別的 daemon）。 */
function otherProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  cleanups.push(() => child.kill('SIGKILL'));
  return child;
}

const lockPath = (dir: string) => join(dir, DAEMON_LOCK_FILE);

describe('daemon.lock', () => {
  it('拿到鎖寫 pid 與啟動時間；同一個資料夾第二個拒絕；放掉後別人才拿得到', async () => {
    const dir = tempDir();
    const first = await acquireDaemonLock(dir);
    const content = JSON.parse(readFileSync(lockPath(dir), 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.startedAt).toBe('string');
    await expect(acquireDaemonLock(dir)).rejects.toBeInstanceOf(DaemonLockedError);
    first.release();
    expect(existsSync(lockPath(dir))).toBe(false);
    const second = await acquireDaemonLock(dir);
    second.release();
  });

  it('另一個活著的 daemon（pid 在、啟動時間對得上）拿著：拒絕啟動並說明', async () => {
    const dir = tempDir();
    const child = otherProcess();
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), instance: 'x' }),
    );
    await expect(acquireDaemonLock(dir)).rejects.toThrow(new RegExp(`pid ${child.pid}`));
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(child.pid);
  });

  it('過期鎖接手：主人不在了、pid 被別的程序重用（啟動時間不對）、或是自己上次崩潰留下的', async () => {
    const dir = tempDir();
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString(), instance: 'x' }),
    );
    const a = await acquireDaemonLock(dir);
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    a.release();

    const child = otherProcess();
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: child.pid, startedAt: '2020-01-01T00:00:00.000Z', instance: 'x' }),
    );
    const b = await acquireDaemonLock(dir);
    expect(JSON.parse(readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    b.release();

    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), instance: 'old' }),
    );
    const c = await acquireDaemonLock(dir);
    c.release();
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it('壞掉的鎖檔：剛建立的不搶，舊的接手', async () => {
    const dir = tempDir();
    writeFileSync(lockPath(dir), '');
    await expect(acquireDaemonLock(dir)).rejects.toBeInstanceOf(DaemonLockedError);
    const { utimesSync } = await import('node:fs');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(dir), old, old);
    const lock = await acquireDaemonLock(dir);
    lock.release();
  });

  it('兩個 daemon 同一個資料夾：第二個拒絕啟動，第一個照常；第一個停了第二個才起得來', async () => {
    const h = new Harness();
    try {
      const first = await h.start();
      await expect(h.startDaemon()).rejects.toBeInstanceOf(DaemonLockedError);
      expect(first.hookSocketPath).toBeTruthy();
      await h.restartDaemon();
    } finally {
      await h.cleanup();
    }
  });

  it('只放自己的鎖：被別人接手後 release 不刪別人的', async () => {
    const dir = tempDir();
    const lock = await acquireDaemonLock(dir);
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), instance: 'someone' }),
    );
    lock.release();
    expect(existsSync(lockPath(dir))).toBe(true);
  });
});
