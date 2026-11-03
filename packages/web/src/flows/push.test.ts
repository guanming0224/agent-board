// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pushSupport, sameKey, subscriptionBody, vapidKeyBytes, type PushEnv } from './push';

const desktop: PushEnv = {
  isSecureContext: true,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0',
  platform: 'MacIntel',
  maxTouchPoints: 0,
  standalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
};
const iphone: PushEnv = {
  ...desktop,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
  hasPushManager: false,
  hasNotification: false,
};

describe('pushSupport', () => {
  it('desktop browser over HTTPS or localhost is ok', () => {
    expect(pushSupport(desktop)).toBe('ok');
  });

  it('plain http over the network says HTTPS, not "unsupported"', () => {
    expect(pushSupport({ ...desktop, isSecureContext: false, hasServiceWorker: false })).toBe(
      'insecure',
    );
    expect(pushSupport({ ...iphone, isSecureContext: false })).toBe('insecure');
  });

  it('iPhone in a Safari tab must be added to the Home Screen first', () => {
    expect(pushSupport(iphone)).toBe('ios-install');
  });

  it('iPadOS reports itself as a Mac but has touch points', () => {
    const ipad = { ...desktop, userAgent: 'Mozilla/5.0 (Macintosh) Safari', maxTouchPoints: 5 };
    expect(pushSupport({ ...ipad, hasPushManager: false })).toBe('ios-install');
    expect(pushSupport({ ...ipad, standalone: true })).toBe('ok');
  });

  it('Home Screen app on iOS 16.4+ is ok; older iOS is unsupported', () => {
    expect(
      pushSupport({ ...iphone, standalone: true, hasPushManager: true, hasNotification: true }),
    ).toBe('ok');
    expect(pushSupport({ ...iphone, standalone: true })).toBe('unsupported');
  });

  it('missing any piece is unsupported', () => {
    expect(pushSupport({ ...desktop, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...desktop, hasServiceWorker: false })).toBe('unsupported');
    expect(pushSupport({ ...desktop, hasNotification: false })).toBe('unsupported');
  });
});

describe('vapidKeyBytes', () => {
  it('decodes base64url without padding into the 65-byte uncompressed P-256 key', () => {
    const key =
      'BGFytsGGh7T9Tx6fiDSmrbB3n0Y_cmHcn6AA6kEE_rz2bzBRefjIZZ2RAGw92MUS2pHU30Zae8RAFRArPZYiDH0';
    const bytes = vapidKeyBytes(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
    expect(Buffer.from(bytes).toString('base64url')).toBe(key);
  });

  it('handles - and _ and every padding length', () => {
    for (const raw of ['', 'a', 'ab', 'abc', '\xfb\xff\xfe']) {
      const encoded = Buffer.from(raw, 'latin1').toString('base64url');
      expect(Buffer.from(vapidKeyBytes(encoded)).toString('latin1')).toBe(raw);
    }
  });
});

describe('sameKey', () => {
  it('compares the existing subscription key byte by byte', () => {
    const wanted = new Uint8Array([4, 1, 2, 3]);
    expect(sameKey(new Uint8Array([4, 1, 2, 3]).buffer, wanted)).toBe(true);
    expect(sameKey(new Uint8Array([4, 1, 2, 9]).buffer, wanted)).toBe(false);
    expect(sameKey(new Uint8Array([4, 1, 2]).buffer, wanted)).toBe(false);
    expect(sameKey(null, wanted)).toBe(false);
  });
});

describe('subscriptionBody', () => {
  it('keeps only what the hub route accepts', () => {
    expect(
      subscriptionBody({
        endpoint: 'https://push.example/abc',
        expirationTime: null,
        keys: { p256dh: 'p', auth: 'a' },
      }),
    ).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('rejects a subscription missing its keys', () => {
    expect(subscriptionBody({ endpoint: 'https://push.example/abc' })).toBeNull();
    expect(
      subscriptionBody({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p' } }),
    ).toBeNull();
    expect(subscriptionBody({ keys: { p256dh: 'p', auth: 'a' } })).toBeNull();
  });
});
