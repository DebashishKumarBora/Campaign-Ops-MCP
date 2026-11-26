import type { webcrypto } from 'node:crypto';

/**
 * Small byte helpers that work the same in Node and in Cloudflare Workers
 * (no Buffer, only standard Web APIs).
 */

// WebCrypto types (type-only: nothing from node:crypto is loaded at run time).
export type CryptoKey = webcrypto.CryptoKey;
export type CryptoKeyPair = webcrypto.CryptoKeyPair;
export type JsonWebKey = webcrypto.JsonWebKey;

/**
 * Web Crypto, typed the same way everywhere. Node and Cloudflare Workers run the
 * same standard API, but their TypeScript definitions differ in small ways, so
 * this code is checked against one of them (Node's) in both builds.
 */
export const subtle = (crypto as unknown as webcrypto.Crypto).subtle;

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  const clean = String(text ?? '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('Not base64url.');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A standalone ArrayBuffer copy, which every WebCrypto implementation accepts. */
export function ab(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', ab(data)));
}
