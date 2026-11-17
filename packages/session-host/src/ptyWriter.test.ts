// PtyWriter：fd 編號被關掉又分給別的檔案時，不能把輸入寫進那個檔案（事故 9，CONTRACTS §20.8）。
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyWriter } from './ptyWriter';

describe.skipIf(process.platform === 'win32')('PtyWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ab-ptywriter-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('照順序寫進 fd', () => {
    const file = join(dir, 'a');
    const fd = openSync(file, 'w');
    const writer = new PtyWriter(fd, 'test', { warn: () => {} });
    writer.write('hello ');
    writer.write('世界');
    closeSync(fd);
    expect(readFileSync(file, 'utf8')).toBe('hello 世界');
    expect(writer.pendingBytes).toBe(0);
  });

  it('fd 被關掉、編號分給別的檔案：不寫進去，記一筆後停止', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    const fd = openSync(a, 'w');
    const warnings: string[] = [];
    const writer = new PtyWriter(fd, 'test', { warn: (m) => warnings.push(m) });
    writer.write('x');
    closeSync(fd);
    const reused = openSync(b, 'w');
    try {
      expect(reused).toBe(fd);
      writer.write('不該出現');
      writer.write('也不該');
    } finally {
      closeSync(reused);
    }
    expect(readFileSync(a, 'utf8')).toBe('x');
    expect(readFileSync(b, 'utf8')).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PTY 已經關閉');
    expect(warnings[0]).not.toContain('不該出現');
  });

  it('close 之後的寫入直接丟掉', () => {
    const file = join(dir, 'a');
    const fd = openSync(file, 'w');
    const writer = new PtyWriter(fd, 'test', { warn: () => {} });
    writer.close();
    writer.write('x');
    closeSync(fd);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
