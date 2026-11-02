import { describe, expect, it } from 'vitest';
import { InputLineBuffer, auditToCsv } from '../audit';
import { isAllowedOrigin, randomPairingCode, RateLimiter } from '../auth';
import { inQuietHours } from '../push';

describe('InputLineBuffer', () => {
  const lines = (...chunks: string[]) => {
    const buffer = new InputLineBuffer();
    return chunks.flatMap((c) => buffer.push(c));
  };

  it('splits on Enter and treats CRLF as one', () => {
    expect(lines('a', 'b', '\r')).toEqual(['ab']);
    expect(lines('one\rtwo\r\nthree\n')).toEqual(['one', 'two', 'three']);
    expect(lines('x\r', '\ny\r')).toEqual(['x', 'y']);
  });

  it('records a bare Enter (it confirms menus)', () => {
    expect(lines('\r')).toEqual(['']);
  });

  it('applies line editing', () => {
    expect(lines('helo\x7flo\r')).toEqual(['hello']);
    expect(lines('中文\x7f\r')).toEqual(['中']);
    expect(lines('secret\x15safe\r')).toEqual(['safe']);
    expect(lines('rm -rf foo\x17bar\r')).toEqual(['rm -rf bar']);
    expect(lines('oops\x03ok\r')).toEqual(['ok']);
  });

  it('strips escape sequences, including when split across chunks', () => {
    expect(lines('a\x1b[Ab\r')).toEqual(['ab']);
    expect(lines('a\x1b[1;5Cb\r')).toEqual(['ab']);
    expect(lines('a\x1bOPb\r')).toEqual(['ab']);
    expect(lines('a\x1b]0;title\x07b\r')).toEqual(['ab']);
    expect(lines('a\x1b[', '1;5', 'Cb\r')).toEqual(['ab']);
  });

  it('a lone Esc keypress does not swallow the next character', () => {
    expect(lines('a\x1b', 'b\r')).toEqual(['ab']);
  });

  it('newlines in a bracketed paste are not Enter', () => {
    expect(lines('\x1b[200~line1\nline2\x1b[201~\r')).toEqual(['line1\nline2']);
    expect(lines('\x1b[200~a\r', 'b\x1b[201~', '\r')).toEqual(['a\nb']);
  });

  it('Alt+Enter is a newline, not a submit', () => {
    expect(lines('a\x1b\rb\r')).toEqual(['a\nb']);
  });

  it('caps very long lines', () => {
    const [line] = lines('x'.repeat(100_000) + '\r');
    expect(line!.length).toBeLessThan(17_000);
    expect(line).toContain('[truncated]');
  });

  it('flush returns the unfinished line once', () => {
    const buffer = new InputLineBuffer();
    buffer.push('half');
    expect(buffer.flush()).toBe('half');
    expect(buffer.flush()).toBeNull();
  });
});

describe('auditToCsv', () => {
  const row = (detail: string) => ({
    id: '1',
    userId: null,
    sessionId: null,
    action: 'a',
    detail,
    at: '2026-01-01T00:00:00.000Z',
  });
  const cell = (detail: string) =>
    auditToCsv([row(detail)])
      .split('\r\n')[1]!
      .split(',')
      .slice(5)
      .join(',');

  it.each(['=1+1', '+1', '-1', '@x', '  =1', '\t=1', '\r=1', '＝1'])('neutralizes %j', (value) => {
    expect(cell(value).startsWith(`"'`)).toBe(true);
  });

  it('leaves ordinary values alone and escapes quotes and newlines', () => {
    expect(cell('git status')).toBe('"git status"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(auditToCsv([row('a\nb')])).toContain('"a\nb"');
  });

  it('starts with a BOM and a header', () => {
    expect(auditToCsv([]).startsWith('﻿"id","at"')).toBe(true);
  });
});

describe('isAllowedOrigin', () => {
  it('without publicOrigin requires the same host', () => {
    expect(isAllowedOrigin('http://a.example:1', 'a.example:1', null)).toBe(true);
    expect(isAllowedOrigin('http://b.example:1', 'a.example:1', null)).toBe(false);
    expect(isAllowedOrigin(undefined, 'a', null)).toBe(false);
    expect(isAllowedOrigin('null', 'a', null)).toBe(false);
    expect(isAllowedOrigin('file://a', 'a', null)).toBe(false);
  });

  it('with publicOrigin matches it exactly, keeps loopback same-host', () => {
    const pub = 'https://b.example.ts.net';
    expect(isAllowedOrigin(pub, 'whatever', pub)).toBe(true);
    expect(isAllowedOrigin('http://b.example.ts.net', 'whatever', pub)).toBe(false);
    expect(isAllowedOrigin('https://b.example.ts.net.evil.com', 'x', pub)).toBe(false);
    expect(isAllowedOrigin('http://10.0.0.1:1', '10.0.0.1:1', pub)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:1', '127.0.0.1:1', pub)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:2', '127.0.0.1:1', pub)).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('blocks at the limit and recovers after the window', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 1000, () => t);
    limiter.hit('k');
    expect(limiter.retryAfterSeconds('k')).toBe(0);
    limiter.hit('k');
    expect(limiter.retryAfterSeconds('k')).toBe(1);
    expect(limiter.retryAfterSeconds('other')).toBe(0);
    t = 1000;
    expect(limiter.retryAfterSeconds('k')).toBe(0);
  });

  it('does not grow without bound', () => {
    const limiter = new RateLimiter(2, 1000, () => 0, 10);
    for (let i = 0; i < 100; i += 1) limiter.hit(`k${i}`);
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(
      10,
    );
  });
});

describe('quiet hours', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  it('handles same-day and overnight ranges', () => {
    const night = { start: '22:00', end: '07:00' };
    expect(inQuietHours(night, at(23))).toBe(true);
    expect(inQuietHours(night, at(3))).toBe(true);
    expect(inQuietHours(night, at(7))).toBe(false);
    expect(inQuietHours(night, at(12))).toBe(false);
    const day = { start: '09:00', end: '17:30' };
    expect(inQuietHours(day, at(17, 29))).toBe(true);
    expect(inQuietHours(day, at(17, 30))).toBe(false);
    expect(inQuietHours(null, at(3))).toBe(false);
    expect(inQuietHours({ start: '09:00', end: '09:00' }, at(9))).toBe(false);
  });
});

describe('pairing code', () => {
  it('is uppercase, unambiguous and unique', () => {
    const codes = new Set(Array.from({ length: 200 }, randomPairingCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });
});
