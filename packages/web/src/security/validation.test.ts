// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { listenAddressError } from '../flows/validation';

describe('listenAddressError stays in line with the hub', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.128.0.1',
    '172.32.0.1',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
  ])('public: %s', (host) => {
    expect(listenAddressError(host)).toBe('public');
  });

  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.5',
    '100.64.0.5',
    '100.100.100.100',
    'fd7a:115c:a1e0::1',
    'fe80::1',
    '::ffff:192.168.1.1',
  ])('private: %s', (host) => {
    expect(listenAddressError(host)).toBeNull();
  });
});
