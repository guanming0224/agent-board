import { describe, expect, it } from 'vitest';
import { parseRateLimitReset } from '../rateLimitReset';

const since = new Date('2026-11-03T10:00:00Z');
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('parseRateLimitReset', () => {
  it('reads a time of day as the next occurrence after entering the limit, in the given zone', () => {
    expect(iso(parseRateLimitReset("You've hit your limit · resets 3pm (UTC)", since))).toBe(
      '2026-11-03T15:00:00.000Z',
    );
    // 台北 15:30 = UTC 07:30，已經比 since 早，所以是隔天。
    expect(
      iso(parseRateLimitReset("You've hit your 5-hour limit · resets 3:30pm (Asia/Taipei)", since)),
    ).toBe('2026-11-04T07:30:00.000Z');
    expect(iso(parseRateLimitReset('Usage limit reached · limit resets 12am (UTC)', since))).toBe(
      '2026-11-04T00:00:00.000Z',
    );
  });

  it('reads dates, with and without a year, across the new year', () => {
    expect(
      iso(parseRateLimitReset("You've hit your weekly limit · resets Nov 5, 3pm (UTC)", since)),
    ).toBe('2026-11-05T15:00:00.000Z');
    expect(
      iso(
        parseRateLimitReset(
          'resets Jan 2, 9am (America/New_York)',
          new Date('2026-12-30T00:00:00Z'),
        ),
      ),
    ).toBe('2027-01-02T14:00:00.000Z');
    expect(iso(parseRateLimitReset('resets Feb 1, 2027, 1:05am (UTC)', since))).toBe(
      '2027-02-01T01:05:00.000Z',
    );
  });

  it('accepts the narrow no-break space toLocaleString may emit', () => {
    expect(iso(parseRateLimitReset('resets 3 pm (UTC)', since))).toBe('2026-11-03T15:00:00.000Z');
  });

  it.each([
    null,
    '',
    '429 Too Many Requests',
    'Usage limit reached · continuing automatically',
    'resets 3pm', // 沒有時區就不知道是哪個 3pm
    'resets 13pm (UTC)',
    'resets 3pm (Not/AZone)',
    'resets Foo 5, 3pm (UTC)',
  ])('returns null when it cannot tell: %s', (detail) => {
    expect(parseRateLimitReset(detail, since)).toBeNull();
  });
});
