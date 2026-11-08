// schema 升級前自動備份：舊版資料庫先備份（0600、內容是舊版）再升級；新資料庫不備份；備份失敗就不升級。
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestBackup, openDatabase, SCHEMA_VERSION } from '../db';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-board-backup-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = () => new Date(2026, 10, 8, 9, 5, 7);
const STAMP = '20261108-090507';

/** 做一個 v7 的資料庫（拿掉 v8 加的欄位），裡面放一筆資料，確認備份帶得到。 */
function makeV7(path: string): void {
  const db = openDatabase(path);
  db.exec('ALTER TABLE sessions DROP COLUMN dispatched_by');
  db.exec('ALTER TABLE sessions DROP COLUMN dispatch_work');
  db.exec(
    `INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m', 'm', 'darwin', 'h', '{}')`,
  );
  db.pragma('user_version = 7');
  db.close();
}

const backups = () => readdirSync(dir).filter((name) => name.includes('.bak-'));

describe('backup before schema upgrade', () => {
  it('backs up an older database (0600, opens, still the old version) before migrating, and logs the path', () => {
    expect(SCHEMA_VERSION).toBe(8);
    const path = join(dir, 'hub.db');
    makeV7(path);
    const lines: string[] = [];
    const db = openDatabase(path, { log: (line) => lines.push(line), now: NOW });
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();

    const target = join(dir, `hub.db.bak-${STAMP}-v7`);
    expect(backups()).toEqual([`hub.db.bak-${STAMP}-v7`]);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const saved = new Database(target, { readonly: true });
    expect(saved.pragma('user_version', { simple: true })).toBe(7);
    expect(saved.prepare('SELECT id FROM machines').all()).toEqual([{ id: 'm' }]);
    const columns = saved.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('dispatched_by');
    saved.close();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(target);

    // 已經是最新版，再開不會多備份。
    openDatabase(path, { log: (line) => lines.push(line), now: NOW }).close();
    expect(backups()).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it('never overwrites an existing backup from the same second', () => {
    const path = join(dir, 'hub.db');
    writeFileSync(join(dir, `hub.db.bak-${STAMP}-v7`), 'older backup');
    makeV7(path);
    openDatabase(path, { log: () => undefined, now: NOW }).close();
    expect(backups().sort()).toEqual([`hub.db.bak-${STAMP}-2-v7`, `hub.db.bak-${STAMP}-v7`]);
  });

  it('does not back up a brand-new database', () => {
    const path = join(dir, 'hub.db');
    const lines: string[] = [];
    const db = openDatabase(path, { log: (line) => lines.push(line), now: NOW });
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.close();
    expect(backups()).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('does not back up an existing empty (v0) file', () => {
    const path = join(dir, 'hub.db');
    writeFileSync(path, '');
    openDatabase(path, { log: () => undefined, now: NOW }).close();
    expect(backups()).toEqual([]);
  });

  it('stops the upgrade with a clear error when the backup fails, leaving the database and no partial backup', () => {
    const path = join(dir, 'hub.db');
    makeV7(path);
    expect(() =>
      openDatabase(path, {
        log: () => undefined,
        now: NOW,
        backup: () => {
          throw new Error('disk I/O error');
        },
      }),
    ).toThrow(/Could not back up .*hub\.db \(schema v7\).*disk I\/O error.*not changed/);
    expect(backups()).toEqual([]);
    const db = new Database(path, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    db.close();
  });

  it('rejects a backup that does not hold the old version', () => {
    const path = join(dir, 'hub.db');
    makeV7(path);
    expect(() =>
      openDatabase(path, {
        log: () => undefined,
        now: NOW,
        // 「成功」但寫出空的資料庫：驗證抓得到，不能當成備份過了。
        backup: () => undefined,
      }),
    ).toThrow(/expected v7/);
    expect(backups()).toEqual([]);
  });

  it('names the newest usable backup when the database is newer than this hub', () => {
    const path = join(dir, 'hub.db');
    const db = openDatabase(path);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    writeFileSync(join(dir, `hub.db.bak-20261101-120000-v${SCHEMA_VERSION}`), '');
    writeFileSync(join(dir, `hub.db.bak-20261105-120000-v${SCHEMA_VERSION}`), '');
    // 比這版 hub 新的備份不能拿來還原，不列。
    writeFileSync(join(dir, `hub.db.bak-20261107-120000-v${SCHEMA_VERSION + 1}`), '');
    const newest = join(dir, `hub.db.bak-20261105-120000-v${SCHEMA_VERSION}`);
    expect(latestBackup(path)).toBe(newest);
    let message = '';
    try {
      openDatabase(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/newer than this hub/);
    expect(message).toContain(newest);
    expect(existsSync(path)).toBe(true);
  });

  it('says so when there is no backup to restore', () => {
    const path = join(dir, 'hub.db');
    const db = openDatabase(path);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer than this hub.*No backup/);
  });
});
