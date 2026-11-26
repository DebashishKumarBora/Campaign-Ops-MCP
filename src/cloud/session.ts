import { ab, b64urlDecode, b64urlEncode, fromUtf8, subtle, utf8, type CryptoKey } from './bytes.js';

/**
 * Signed session cookies for the cloud console. The cookie holds who signed
 * in, with which passkey, and when it ends, signed with HMAC-SHA-256 using a
 * secret only the Worker knows. Nothing is stored on the server.
 */

export const SESSION_COOKIE = '__Host-cops-session';
/**
 * A week, like a phone app. Signing in only lets you look, reject and pause:
 * approving, undoing, opening a change window and resuming each ask for the
 * passkey again, every time.
 */
export const SESSION_HOURS = 7 * 24;

export interface SessionPayload {
  /** Always "owner": Campaign Ops in the cloud has one person who signs off. */
  sub: string;
  /** The passkey used to sign in. */
  cred: string;
  iat: number;
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  return subtle.importKey('raw', ab(utf8(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64urlEncode(utf8(JSON.stringify(payload)));
  const sig = await subtle.sign('HMAC', await hmacKey(secret), ab(utf8(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

/** The session, or null if the token is missing, forged or expired. */
export async function verifySession(token: string | undefined, secret: string, nowMs = Date.now()): Promise<SessionPayload | null> {
  if (!token || token.length > 2048) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  let ok = false;
  try {
    ok = await subtle.verify('HMAC', await hmacKey(secret), ab(b64urlDecode(sig)), ab(utf8(body)));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const p = JSON.parse(fromUtf8(b64urlDecode(body))) as SessionPayload;
    if (typeof p.exp !== 'number' || p.exp * 1000 <= nowMs || p.sub !== 'owner' || typeof p.cred !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** __Host- cookies must be Secure, Path=/ and have no Domain, so no other site or subdomain can set or read them. */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_HOURS * 3600): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
