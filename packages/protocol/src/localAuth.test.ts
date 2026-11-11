import { describe, expect, it } from 'vitest';
import {
  isNonce,
  LOCAL_AUTH_ROLES,
  localProof,
  newNonce,
  NONCE_MEMORY,
  NonceMemory,
  verifyLocalProof,
} from './localAuth';

describe('本機驗證（W5）', () => {
  it('同一把密鑰、同一個角色與 nonce 才驗得過', () => {
    const nonce = newNonce();
    expect(isNonce(nonce)).toBe(true);
    const proof = localProof('secret-a', 'hostServer', nonce);
    expect(verifyLocalProof('secret-a', 'hostServer', nonce, proof)).toBe(true);
    expect(verifyLocalProof('secret-b', 'hostServer', nonce, proof)).toBe(false);
    expect(verifyLocalProof('secret-a', 'hostServer', newNonce(), proof)).toBe(false);
  });

  it('三個角色的前綴分開：一個角色的證明不能拿去別的角色用', () => {
    expect(new Set(Object.values(LOCAL_AUTH_ROLES)).size).toBe(3);
    const nonce = newNonce();
    const proof = localProof('k', 'hostServer', nonce);
    expect(verifyLocalProof('k', 'hostClient', nonce, proof)).toBe(false);
    expect(verifyLocalProof('k', 'hookServer', nonce, proof)).toBe(false);
  });

  it('格式不對、空密鑰一律不過', () => {
    const nonce = newNonce();
    const proof = localProof('k', 'hookServer', nonce);
    expect(verifyLocalProof('', 'hookServer', nonce, proof)).toBe(false);
    expect(verifyLocalProof('k', 'hookServer', 'short', proof)).toBe(false);
    expect(verifyLocalProof('k', 'hookServer', nonce, proof.slice(1))).toBe(false);
    expect(verifyLocalProof('k', 'hookServer', nonce, 42)).toBe(false);
    expect(isNonce('has space in it, sixteen+')).toBe(false);
  });

  it('伺服器記最近的 nonce（預設 4096 個）：重送拒絕，最舊的會被擠掉', () => {
    expect(NONCE_MEMORY).toBe(4096);
    const memory = new NonceMemory(3);
    expect(memory.remember('a')).toBe(true);
    expect(memory.remember('a')).toBe(false);
    memory.remember('b');
    memory.remember('c');
    memory.remember('d');
    expect(memory.size).toBe(3);
    // a 已被擠掉
    expect(memory.remember('a')).toBe(true);
    expect(memory.remember('d')).toBe(false);
  });

  it('不 import node:crypto 以外的東西（hook CLI 直接用 node 執行）', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('./localAuth.ts', import.meta.url), 'utf8');
    const imports = [...text.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:crypto']);
  });
});
