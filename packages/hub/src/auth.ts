// 密碼、權杖與限速。長期權杖與配對碼是高熵亂數，存 SHA-256 即可；密碼才用 argon2。
import { createHash, randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';

export interface PasswordParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** OWASP 建議範圍內的 argon2id 參數。 */
export const DEFAULT_PASSWORD_PARAMS: PasswordParams = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

export const hashPassword = (password: string, params: PasswordParams): Promise<string> =>
  argon2.hash(password, { type: argon2.argon2id, ...params });

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const randomToken = (prefix: string): string =>
  `${prefix}${randomBytes(32).toString('base64url')}`;

// Crockford base32：去掉容易看錯的 I、L、O、U。10 碼約 50 bits，搭配短效與限速。
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomPairingCode(): string {
  const chars = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** 固定視窗計數。key 由外部給，超過 maxKeys 時先清掉過期的，再不夠就整批清（寧可放行也不吃爆記憶體）。 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}

  /** 回傳還要等幾秒；0 表示可以繼續。 */
  retryAfterSeconds(key: string): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= this.now() || entry.count < this.max) return 0;
    return Math.ceil((entry.resetAt - this.now()) / 1000);
  }

  hit(key: string): void {
    const now = this.now();
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return;
    }
    if (this.hits.size >= this.maxKeys) this.sweep(now);
    this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

/**
 * 判斷請求來源是否可信。設了 publicOrigin 就比對它；沒設就要求與 Host 同源。
 * 無論如何都接受 loopback 的同源請求，避免 publicOrigin 設錯時把 owner 鎖在外面。
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  publicOrigin: string | null,
): boolean {
  if (!origin || !host) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const sameHost = parsed.host === host;
  if (publicOrigin === null) return sameHost;
  if (parsed.origin === new URL(publicOrigin).origin) return true;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  return sameHost && loopback;
}
