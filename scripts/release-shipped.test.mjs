// corepack pnpm test:notices
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectShipped, missingNotices, noticeSections } from './release-shipped.mjs';

const root = join(import.meta.dirname, '..');

const notices = [
  '# Third-party notices',
  '### microsoft/terminal (conpty.dll)',
  '```text\nMIT\n```',
  '### a@1.0.0',
  'License: MIT',
  '```text\nCopyright (c) A\n```',
  '### @scope/b@2.0.0',
  'License: MIT',
  '_No license text found._',
].join('\n\n');

test('notices 段落以 name@version 標題切開', () => {
  assert.deepEqual([...noticeSections(notices).keys()], ['a@1.0.0', '@scope/b@2.0.0']);
});

test('漏列的套件、沒有全文的套件、版本不同都算問題', () => {
  const problems = missingNotices(notices, [
    { name: 'a', version: '1.0.0' },
    { name: '@scope/b', version: '2.0.0' },
    { name: 'a', version: '1.0.1' },
    { name: 'c', version: '3.0.0' },
  ]);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^@scope\/b@2\.0\.0：沒有授權全文/);
  assert.match(problems[1], /^a@1\.0\.1：.*沒有這個套件/);
  assert.match(problems[2], /^c@3\.0\.0：.*沒有這個套件/);
});

test('THIRD_PARTY_NOTICES.md 涵蓋目前會散布的所有套件', async () => {
  const { found, unknownWebSources } = await collectShipped(root);
  assert.deepEqual(unknownWebSources, []);
  // 打包進去的一定要有：zod 三個打包都用、web-push 是 MPL、xterm 在網頁。
  for (const name of ['zod', 'web-push', '@xterm/xterm', 'react-dom', 'node-pty']) {
    assert.ok(
      [...found.values()].some((p) => p.name === name),
      `${name} 應該在散布清單`,
    );
  }
  const text = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.deepEqual(missingNotices(text, found.values()), []);
});
