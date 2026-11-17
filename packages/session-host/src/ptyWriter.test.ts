// PtyWriter：fd 編號被關掉又分給別的檔案時，不能把輸入寫進那個檔案（事故 9，CONTRACTS §20.8）。
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
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
  it('PTY 已關（isOpen 回 false）：不寫，寫入器關掉', () => {
    const file = join(dir, 'a');
    const fd = openSync(file, 'w');
    let open = true;
    const writer = new PtyWriter(fd, 'test', { warn: () => {} }, { isOpen: () => open });
    writer.write('x');
    open = false;
    writer.write('不該出現');
    closeSync(fd);
    expect(readFileSync(file, 'utf8')).toBe('x');
    expect(writer.pendingBytes).toBe(0);
  });

  // 審查 W1：macOS 關掉 ptmx 再開，fd 編號與 dev／ino／rdev 可能完全相同，fstat 擋不住；靠 isOpen 擋。
  it.skipIf(process.platform !== 'darwin')(
    'fd 被另一個 ptmx 以相同編號／rdev 重用：不會寫進新的那個',
    () => {
      const flags = fsConstants.O_RDWR | fsConstants.O_NONBLOCK;
      const first = openSync('/dev/ptmx', flags);
      const before = fstatSync(first, { bigint: true });
      let open = true;
      const warnings: string[] = [];
      const writer = new PtyWriter(
        first,
        'test',
        { warn: (m) => warnings.push(m) },
        { isOpen: () => open },
      );
      // 模擬 node-pty：讀取 socket destroy（master 關掉），exit 還沒到。
      open = false;
      closeSync(first);
      const second = openSync('/dev/ptmx', flags);
      try {
        const after = fstatSync(second, { bigint: true });
        // 記錄審查看到的情況（同編號、同 rdev）；就算這台機器沒重用到，下面的斷言照樣要成立。
        if (second === first) expect(after.ino).toBe(before.ino);
        writer.write('不該寫進新的 ptmx');
        expect(writer.pendingBytes).toBe(0);
        expect((writer as unknown as { closed: boolean }).closed).toBe(true);
      } finally {
        closeSync(second);
      }
    },
  );
});
