// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskSecrets, StreamMasker, TerminalMaskGate } from './mask';
import { secretRanges } from './secretPatterns';

const KEY = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF';
const STARS = '*'.repeat(KEY.length);

/** 假的金鑰形狀，組字避免掃描工具誤判。 */
const samples: [string, string][] = [
  ['anthropic', KEY],
  ['openai project', `sk-proj-${'a'.repeat(30)}`],
  ['github classic', `ghp_${'A1'.repeat(18)}`],
  ['github fine-grained', `github_pat_${'A1_'.repeat(12)}`],
  ['gitlab', `glpat-${'x'.repeat(20)}`],
  ['slack', `xoxb-${'1'.repeat(12)}-${'a'.repeat(12)}`],
  ['aws', `AKIA${'A'.repeat(16)}`],
  ['google', `AIza${'a'.repeat(35)}`],
  ['npm', `npm_${'a'.repeat(36)}`],
  ['huggingface', `hf_${'a'.repeat(34)}`],
  ['stripe', `sk_live_${'a'.repeat(24)}`],
  ['agent board machine', `abm_${'a'.repeat(43)}`],
  ['agent board login', `abs_${'a'.repeat(43)}`],
  ['jwt', `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`],
];

describe('maskSecrets', () => {
  it.each(samples)('%s', (_name, secret) => {
    const masked = maskSecrets(`before ${secret} after`);
    expect(masked).toBe(`before ${'*'.repeat(secret.length)} after`);
  });

  it.each([
    ['env', 'GITHUB_TOKEN=abc123def', 'GITHUB_TOKEN=*********'],
    ['colon', 'password: hunter2', 'password: *******'],
    ['json', '{"api_key": "abc123"}', '{"api_key": "******"}'],
    ['flag-like', 'DB_PASSWORD="p4ss"', 'DB_PASSWORD="****"'],
    ['bearer', 'Authorization: Bearer abcdefghij123', 'Authorization: Bearer *************'],
    ['url', 'https://me:hunter2@host.example/x', 'https://me:*******@host.example/x'],
    ['pair code', 'pair --hub x --code ABCDE-12345', 'pair --hub x --code ***********'],
    ['wide chars keep width', 'password=密碼abc', 'password=*******'],
  ])('labelled value: %s', (_name, input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it('private key block keeps its line count', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----`;
    const masked = maskSecrets(`x\n${pem}\ny`);
    expect(masked.split('\n')).toHaveLength(6);
    expect(masked).not.toContain('abc');
    expect(masked.startsWith('x\n')).toBe(true);
    expect(masked.endsWith('\ny')).toBe(true);
  });

  it.each([
    'git log -1 --format=%H',
    'commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'tokens: 12,345',
    'max_tokens=1024',
    'risk-free',
    'task-1234',
    'ls -la /tmp',
    '請輸入指令',
    'password',
    'see the token handling',
    'sk-short',
  ])('leaves ordinary text alone: %s', (text) => {
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('StreamMasker', () => {
  const run = (chunks: string[]) => {
    const masker = new StreamMasker();
    return chunks.map((c) => masker.push(c)).join('') + masker.flush();
  };

  it('every split position of a key: the key never appears, width is preserved', () => {
    const line = `key ${KEY} end\r\n`;
    for (let cut = 1; cut < line.length; cut += 1) {
      const out = run([line.slice(0, cut), line.slice(cut)]);
      // 切在金鑰還沒長到可辨識的地方時，前幾個字可能先露出；秘密本體不可以。
      expect(out, `cut ${cut}`).not.toContain('AAAABBBB');
      expect(out, `cut ${cut}`).toHaveLength(line.length);
      expect(out, `cut ${cut}`).toContain(' end\r\n');
    }
  });

  it('one byte at a time: only the part before the prefix is recognizable may show', () => {
    const line = `key ${KEY} end\r\n`;
    const out = run([...line]);
    expect(out).toBe(`key sk${STARS.slice(2)} end\r\n`);
  });

  it('keys split by color codes', () => {
    const out = run([`\x1b[31msk-ant-api03-\x1b[1mAAAABBBB\x1b[0mCCCCDDDD done\r\n`]);
    expect(out).not.toContain('AAAABBBB');
    expect(out).not.toContain('CCCCDDDD');
    expect(out).toContain('\x1b[31m');
    expect(out).toContain('\x1b[1m');
    expect(out).toContain('\x1b[0m');
    expect(out).toContain(' done');
  });

  it('escape sequence cut across chunks is not corrupted', () => {
    expect(run(['a\x1b', '[3', '1mb\r\n'])).toBe('a\x1b[31mb\r\n');
    expect(run(['\x1b]0;tit', 'le\x07x'])).toBe('\x1b]0;title\x07x');
  });

  it('labelled value split right after the label', () => {
    const out = run(['pass', 'word=', 'hun', 'ter2 ok\r\n']);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('hun');
    expect(out).toContain(' ok\r\n');
  });

  it('flush holds nothing back and still masks a value that was in progress', () => {
    const masker = new StreamMasker();
    expect(masker.push('sk-abc')).toBe('');
    expect(masker.holding).toBe(true);
    expect(masker.flush()).toBe('******');
    // 下一段接著同一把金鑰也要遮。
    const rest = masker.push('def'.repeat(10) + ' ok\r\n');
    expect(rest).toContain(' ok');
    expect(rest).not.toContain('def');
  });

  it('a short lookalike is released once it ends', () => {
    expect(run(['sk-short', ' text\r\n'])).toBe('sk-short text\r\n');
  });

  it('ordinary output is not delayed', () => {
    const masker = new StreamMasker();
    expect(masker.push('hello world')).toBe('hello world');
    expect(masker.holding).toBe(false);
  });

  it('a key wrapped by the TUI onto the next line', () => {
    const head = KEY.slice(0, 20);
    const tail = KEY.slice(20);
    const out = run([`${head}\r\n`, `  ${tail}\r\n`, 'next line\r\n']);
    expect(out).not.toContain(tail);
    expect(out).toContain('next line');
  });

  it('a key wrapped over three lines, and with cursor moves in between', () => {
    const long = `sk-ant-api03-${'A'.repeat(20)}`;
    const out = run([
      `${long}\r\n`,
      `\x1b[2K${'B'.repeat(30)}\r\n`,
      `\x1b[2K${'C'.repeat(12)}\r\n`,
      'done here\r\n',
    ]);
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('BBBB');
    expect(out).not.toContain('CCCC');
    expect(out).toContain('done here');
  });

  it('a normal short word after a key that ended the line stays visible', () => {
    const out = run([`${KEY}\r\n`, 'ok then\r\n']);
    expect(out).toContain('ok then');
  });

  it('multi-line private key arriving in pieces', () => {
    const out = run([
      '-----BEGIN PRIVATE',
      ' KEY-----\r\n',
      'SECRETLINEONE\r\n',
      'SECRETLINETWO\r\n',
      '-----END PRIVATE KEY-----\r\n',
      'after\r\n',
    ]);
    expect(out).not.toContain('SECRETLINE');
    expect(out).toContain('after');
  });

  it('a private key with a lost END does not mask forever', () => {
    const masker = new StreamMasker();
    let out = masker.push('-----BEGIN PRIVATE KEY-----\r\n');
    for (let i = 0; i < 2000; i += 1) out += masker.push(`${'x'.repeat(64)}\r\n`);
    out += masker.push('visible again\r\n');
    expect(out).toContain('visible again');
  });

  it('CJK and emoji pass through intact', () => {
    expect(run(['中文', '輸出 🙂\r\n'])).toBe('中文輸出 🙂\r\n');
  });
});

describe('TerminalMaskGate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('off: passes through untouched, nothing is held', () => {
    const written: string[] = [];
    const gate = new TerminalMaskGate(
      (d) => written.push(d),
      () => false,
    );
    gate.output(KEY);
    expect(written).toEqual([KEY]);
    expect(gate.snapshot(KEY)).toBe(KEY);
  });

  it('on: held data is flushed masked after a pause, so the screen never hangs', () => {
    const written: string[] = [];
    const gate = new TerminalMaskGate(
      (d) => written.push(d),
      () => true,
      40,
    );
    gate.output('prompt sk-ant-api0');
    expect(written.join('')).toBe('prompt ');
    vi.advanceTimersByTime(40);
    expect(written.join('')).toBe(`prompt ${'*'.repeat('sk-ant-api0'.length)}`);
  });

  it('on: more data before the timer cancels the flush and completes the match', () => {
    const written: string[] = [];
    const gate = new TerminalMaskGate(
      (d) => written.push(d),
      () => true,
      40,
    );
    gate.output(KEY.slice(0, 10));
    vi.advanceTimersByTime(20);
    gate.output(`${KEY.slice(10)} ok`);
    vi.advanceTimersByTime(100);
    expect(written.join('')).toBe(`${STARS} ok`);
  });

  it('on: a snapshot is fully masked and drops whatever was held', () => {
    const written: string[] = [];
    const gate = new TerminalMaskGate(
      (d) => written.push(d),
      () => true,
      40,
    );
    gate.output('sk-ant-');
    expect(gate.snapshot(`\x1b[1m${KEY}\x1b[0m\r\n$ `)).toBe(`\x1b[1m${STARS}\x1b[0m\r\n$ `);
    vi.advanceTimersByTime(100);
    expect(written).toEqual([]);
  });

  it('dispose cancels the timer', () => {
    const written: string[] = [];
    const gate = new TerminalMaskGate(
      (d) => written.push(d),
      () => true,
      40,
    );
    gate.output('sk-ant-');
    gate.dispose();
    vi.advanceTimersByTime(100);
    expect(written).toEqual([]);
  });
});

describe('secretPatterns', () => {
  it('hub and web carry the same file', () => {
    const read = (path: string) =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    expect(read('./secretPatterns.ts')).toBe(read('../../../hub/src/secretPatterns.ts'));
  });

  it('ranges are sorted and merged', () => {
    const ranges = secretRanges(`token=${KEY} and ${KEY}`);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]![0]).toBeLessThan(ranges[1]![0]);
  });
});
