// 本機 socket／named pipe 的互相驗證（CONTRACTS §20.7，W5）。daemon ↔ session host、daemon ↔ hook CLI／MCP server 共用。
// 做法：雙方都有同一把密鑰（600 的檔案），各自送一個隨機 nonce，對方用 HMAC-SHA256(密鑰, 角色前綴＋nonce) 證明自己拿得到密鑰。
// **伺服器先證明身分**：客戶端（daemon、hook）驗過伺服器的證明才送自己的證明或請求，密鑰本身從不經過 socket。
// 這樣別的程序搶先開了同名 pipe（或換掉 socket）也騙不到密鑰與請求內容。
// 只用 node:crypto、不 import 任何東西：hook CLI 與 MCP server 跑在每次工具呼叫的路徑上（不載入 zod），
// 也不從 index 匯出（網頁的打包會帶進 node:crypto），一律走子路徑 `@agent-board/protocol/local-auth`。
// 只用可擦除的 TypeScript 語法（node 直接執行 .ts）。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 三個角色的前綴分開：同一把密鑰算出來的證明不能拿去別的角色用（例如把 host 給 daemon 的證明原樣轉給 host）。
 */
export const LOCAL_AUTH_ROLES = {
  /** session host 向 daemon 證明自己（daemon 送的 nonce）。 */
  hostServer: 'agent-board/session-host/server/v1\n',
  /** daemon 向 session host 證明自己（host 送的 nonce）。 */
  hostClient: 'agent-board/session-host/client/v1\n',
  /** daemon 向 hook CLI／MCP server 證明自己（hook 送的 nonce）。 */
  hookServer: 'agent-board/hook/server/v1\n',
} as const;
export type LocalAuthRole = keyof typeof LOCAL_AUTH_ROLES;

/** nonce：32 bytes 的 base64url（43 字）。收到的只接受 base64url、16–128 字。 */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** 證明：HMAC-SHA256 的 base64url（43 字）。 */
export const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 伺服器記住最近用過的 nonce 數量（同一個 nonce 再來一次就拒絕，擋重送）。 */
export const NONCE_MEMORY = 4096;

export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

/** HMAC-SHA256(密鑰, 角色前綴＋nonce)，base64url。 */
export function localProof(secret: string, role: LocalAuthRole, nonce: string): string {
  return createHmac('sha256', secret)
    .update(LOCAL_AUTH_ROLES[role] + nonce)
    .digest('base64url');
}

/** 常數時間比對；格式不對、密鑰是空的一律 false。 */
export function verifyLocalProof(
  secret: string,
  role: LocalAuthRole,
  nonce: string,
  proof: unknown,
): boolean {
  if (!secret || !isNonce(nonce) || typeof proof !== 'string' || !PROOF_PATTERN.test(proof)) {
    return false;
  }
  const expected = Buffer.from(localProof(secret, role, nonce));
  const given = Buffer.from(proof);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * 伺服器記最近用過的 nonce（先進先出，上限 NONCE_MEMORY）。`remember` 回 false＝這個 nonce 最近用過（重送），要拒絕。
 * 不用 class 欄位宣告以外的 TS 語法（node 直接執行 .ts 時只支援可擦除的語法）。
 */
export class NonceMemory {
  private readonly seen = new Set<string>();
  private readonly limit: number;

  constructor(limit: number = NONCE_MEMORY) {
    this.limit = limit;
  }

  remember(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    if (this.seen.size > this.limit) {
      // Set 照加入順序走訪：第一個就是最舊的。
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
