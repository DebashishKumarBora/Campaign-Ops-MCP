import { ab, b64urlDecode, b64urlEncode, concat, randomBytes, subtle, utf8, type CryptoKey, type CryptoKeyPair, type JsonWebKey } from './bytes.js';

/**
 * Web Push without a library: payload encryption (RFC 8291, aes128gcm) and
 * VAPID sign-in (RFC 8292). It is what lets the cloud console tell a phone
 * "a change is waiting for you" through Apple's, Google's or Mozilla's push
 * service, for free. The push service only ever sees encrypted bytes.
 */

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what browsers call applicationServerKey). */
  publicKey: string;
  /** The private key as a JWK. Kept as a Worker secret. */
  privateKey: JsonWebKey;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping the notification goes, for example "/#p=P-0007". */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag?: string;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(info) }, key, length * 8));
}

/**
 * The push services of the browsers people use: Chrome, Samsung Internet and
 * most Android browsers (Google), Safari (Apple), Firefox (Mozilla) and Edge
 * (Microsoft). The server only ever sends to these, so a subscription cannot
 * point it at any other site.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function isPushServiceHost(host: string): boolean {
  return PUSH_HOSTS.some((re) => re.test(host.toLowerCase()));
}

/** allowHttp is only for tests on this computer: it accepts a plain-http endpoint on any host. */
export function isValidSubscription(sub: unknown, opts: { allowHttp?: boolean } = {}): sub is PushSubscriptionJSON {
  const s = sub as PushSubscriptionJSON;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !s.keys) return false;
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return false;
  }
  const testing = opts.allowHttp && url.protocol === 'http:';
  if (!testing && (url.protocol !== 'https:' || !isPushServiceHost(url.hostname))) return false;
  try {
    return b64urlDecode(s.keys.p256dh).length === 65 && b64urlDecode(s.keys.auth).length === 16;
  } catch {
    return false;
  }
}

/** Encrypts one push message for one subscription. `fixed` is only for checking against the RFC's worked example. */
export async function encryptPayload(
  plaintext: Uint8Array,
  sub: PushSubscriptionJSON,
  fixed?: { salt: Uint8Array; serverPublic: Uint8Array; serverPrivate: JsonWebKey },
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.keys.p256dh);
  const authSecret = b64urlDecode(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('The push subscription keys are not valid.');
  if (plaintext.length > 3000) throw new Error('Push messages must be short.');

  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (fixed) {
    asPublic = fixed.serverPublic;
    asPrivate = await subtle.importKey('jwk', fixed.serverPrivate, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    asPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await subtle.importKey('raw', ab(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await subtle.importKey('raw', ab(cek), 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // one record, so it ends with the last-record delimiter
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce), tagLength: 128 }, key, ab(padded)));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/** The Authorization header that proves to the push service who is sending (VAPID). */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // A fresh token for every message, valid one hour: well inside the 24 hours RFC 8292 allows, and what Apple's push service expects.
  const claims = b64urlEncode(utf8(JSON.stringify({ aud, exp: nowSeconds + 3600, sub: subject })));
  const key = await subtle.importKey('jwk', vapid.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, ab(utf8(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export async function sendPush(
  sub: PushSubscriptionJSON,
  message: PushMessage,
  vapid: VapidKeys,
  subject: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const body = await encryptPayload(utf8(JSON.stringify(message)), sub);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
      ...(message.tag ? { Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'cops' } : {}),
      Authorization: await vapidAuthorization(sub.endpoint, vapid, subject),
    },
    body: ab(body),
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}

/** Makes a VAPID key pair. Run once by the setup script; the private half becomes a Worker secret. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64urlEncode(raw), privateKey: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y } };
}
