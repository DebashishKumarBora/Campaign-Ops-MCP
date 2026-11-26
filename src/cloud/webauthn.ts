import { ab, b64urlDecode, b64urlEncode, bytesEqual, concat, fromUtf8, sha256Bytes, subtle, utf8, type CryptoKey } from './bytes.js';
import { decodeCbor, type CborValue } from './cbor.js';

/**
 * Passkeys (WebAuthn) without a library: registration and sign-in
 * verification for ES256 and RS256 keys, which covers Face ID, Touch ID,
 * Android, Windows Hello and security keys.
 *
 * In the cloud console every action that can change an account (approve,
 * undo, open a change window, resume changes) needs a fresh passkey
 * signature over a challenge built from that exact change. The signature is
 * stored with the approval, so it can be checked again later.
 */

export type CoseAlg = -7 | -257;
export const SUPPORTED_ALGS: CoseAlg[] = [-7, -257];

export interface StoredCredential {
  /** Credential ID, base64url. */
  id: string;
  /** Public key as SPKI, base64url. */
  publicKey: string;
  alg: CoseAlg;
  signCount: number;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  transports?: string[];
}

export interface RegistrationResponseJSON {
  id: string;
  rawId?: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface AssertionResponseJSON {
  id: string;
  rawId?: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}

export interface Expected {
  challenge: Uint8Array;
  origin: string;
  rpId: string;
  requireUserVerification: boolean;
}

export class PasskeyError extends Error {}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; publicKeyCose: Map<CborValue, CborValue> };
}

export function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new PasskeyError('The passkey response is too short.');
  const rpIdHash = data.slice(0, 32);
  const flags = data[32];
  const signCount = ((data[33] << 24) >>> 0) + (data[34] << 16) + (data[35] << 8) + data[36];
  const out: AuthData = { rpIdHash, flags, signCount };
  if (flags & FLAG_AT) {
    if (data.length < 55) throw new PasskeyError('The passkey response is missing its key.');
    const aaguid = data.slice(37, 53);
    const len = (data[53] << 8) | data[54];
    if (data.length < 55 + len) throw new PasskeyError('The passkey response is missing its key.');
    const credentialId = data.slice(55, 55 + len);
    const { value } = decodeCbor(data, 55 + len);
    if (!(value instanceof Map)) throw new PasskeyError('The passkey public key could not be read.');
    out.attested = { aaguid, credentialId, publicKeyCose: value };
  }
  return out;
}

/** WebAuthn ES256 signatures are DER encoded; WebCrypto wants the raw r and s, 32 bytes each. */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array {
  let at = 0;
  const expect = (tag: number) => {
    if (der[at++] !== tag) throw new PasskeyError('The passkey signature is not valid DER.');
  };
  const length = (): number => {
    let n = der[at++];
    if (n & 0x80) {
      const count = n & 0x7f;
      n = 0;
      for (let i = 0; i < count; i++) n = (n << 8) | der[at++];
    }
    return n;
  };
  expect(0x30);
  length();
  const part = (): Uint8Array => {
    expect(0x02);
    const n = length();
    let v = der.slice(at, at + n);
    at += n;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) throw new PasskeyError('The passkey signature is not valid DER.');
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  return concat(part(), part());
}

async function importVerifyKey(spki: string, alg: CoseAlg): Promise<CryptoKey> {
  const params = alg === -7 ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  return subtle.importKey('spki', ab(b64urlDecode(spki)), params, false, ['verify']);
}

async function coseToSpki(cose: Map<CborValue, CborValue>): Promise<{ spki: string; alg: CoseAlg }> {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    const crv = cose.get(-1);
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw new PasskeyError('This passkey uses an elliptic curve Campaign Ops does not support.');
    const key = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    return { spki: b64urlEncode(await subtle.exportKey('spki', key)), alg: -7 };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256) throw new PasskeyError('This passkey uses an RSA key Campaign Ops does not support.');
    const key = await subtle.importKey('jwk', { kty: 'RSA', n: b64urlEncode(n), e: b64urlEncode(e), alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']);
    return { spki: b64urlEncode(await subtle.exportKey('spki', key)), alg: -257 };
  }
  throw new PasskeyError('This passkey uses a key type Campaign Ops does not support.');
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function checkClientData(raw: Uint8Array, type: string, expected: Expected): ClientData {
  let data: ClientData;
  try {
    data = JSON.parse(fromUtf8(raw)) as ClientData;
  } catch {
    throw new PasskeyError('The passkey response could not be read.');
  }
  if (data.type !== type) throw new PasskeyError('The passkey response is for a different step.');
  if (data.challenge !== b64urlEncode(expected.challenge)) throw new PasskeyError('The passkey signed a different request. Try again.');
  if (data.origin !== expected.origin) throw new PasskeyError(`The passkey was used on ${data.origin}, not ${expected.origin}.`);
  if (data.crossOrigin === true) throw new PasskeyError('The passkey was used inside another site.');
  return data;
}

async function checkAuthFlags(auth: AuthData, expected: Expected): Promise<boolean> {
  if (!bytesEqual(auth.rpIdHash, await sha256Bytes(utf8(expected.rpId)))) throw new PasskeyError('The passkey belongs to a different site.');
  if (!(auth.flags & FLAG_UP)) throw new PasskeyError('The passkey did not confirm a person was present.');
  const verified = Boolean(auth.flags & FLAG_UV);
  if (expected.requireUserVerification && !verified) throw new PasskeyError('The passkey did not check your face, fingerprint or PIN.');
  return verified;
}

export async function verifyRegistration(
  res: RegistrationResponseJSON,
  expected: Expected,
): Promise<{ credentialId: string; publicKey: string; alg: CoseAlg; signCount: number; userVerified: boolean; transports?: string[] }> {
  if (!res || res.type !== 'public-key' || !res.response) throw new PasskeyError('That was not a passkey response.');
  checkClientData(b64urlDecode(res.response.clientDataJSON), 'webauthn.create', expected);
  const { value } = decodeCbor(b64urlDecode(res.response.attestationObject));
  if (!(value instanceof Map)) throw new PasskeyError('The passkey attestation could not be read.');
  const authBytes = value.get('authData');
  if (!(authBytes instanceof Uint8Array)) throw new PasskeyError('The passkey attestation has no authenticator data.');
  const auth = parseAuthData(authBytes);
  const userVerified = await checkAuthFlags(auth, expected);
  if (!auth.attested) throw new PasskeyError('The passkey did not include its public key.');
  const credentialId = b64urlEncode(auth.attested.credentialId);
  if (b64urlEncode(b64urlDecode(res.id)) !== credentialId) throw new PasskeyError('The passkey ID does not match its key.');
  const { spki, alg } = await coseToSpki(auth.attested.publicKeyCose);
  const transports = Array.isArray(res.response.transports) ? res.response.transports.filter((t) => typeof t === 'string').slice(0, 6) : undefined;
  return { credentialId, publicKey: spki, alg, signCount: auth.signCount, userVerified, transports };
}

export async function verifyAssertion(
  res: AssertionResponseJSON,
  cred: StoredCredential,
  expected: Expected,
  opts: { checkCounter?: boolean } = {},
): Promise<{ signCount: number; userVerified: boolean }> {
  if (!res || res.type !== 'public-key' || !res.response) throw new PasskeyError('That was not a passkey response.');
  if (b64urlEncode(b64urlDecode(res.id)) !== cred.id) throw new PasskeyError('That passkey is not the one expected.');
  const clientDataRaw = b64urlDecode(res.response.clientDataJSON);
  checkClientData(clientDataRaw, 'webauthn.get', expected);
  const authBytes = b64urlDecode(res.response.authenticatorData);
  const auth = parseAuthData(authBytes);
  const userVerified = await checkAuthFlags(auth, expected);
  const signed = concat(authBytes, await sha256Bytes(clientDataRaw));
  const sigRaw = b64urlDecode(res.response.signature);
  const key = await importVerifyKey(cred.publicKey, cred.alg);
  const ok =
    cred.alg === -7
      ? await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, ab(derToRawEcdsa(sigRaw)), ab(signed))
      : await subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, ab(sigRaw), ab(signed));
  if (!ok) throw new PasskeyError('The passkey signature is not valid.');
  if (opts.checkCounter !== false && (auth.signCount > 0 || cred.signCount > 0) && auth.signCount <= cred.signCount) {
    throw new PasskeyError('This passkey reported an old counter, which can mean it was copied. Remove it and add it again.');
  }
  return { signCount: auth.signCount, userVerified };
}

/**
 * The challenge a passkey signs for one action. It is built from the action,
 * its target, a binding (for an approval: the hash of the exact change) and a
 * random nonce, so a signature cannot be replayed for anything else.
 */
export async function bindChallenge(purpose: string, target: string, binding: string, nonce: Uint8Array): Promise<Uint8Array> {
  return sha256Bytes(concat(utf8(`campaign-ops\n${purpose}\n${target}\n${binding}\n`), nonce));
}

export function registrationOptions(input: {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  displayName: string;
  challenge: Uint8Array;
  exclude: StoredCredential[];
}): Record<string, unknown> {
  return {
    rp: { id: input.rpId, name: input.rpName },
    user: { id: b64urlEncode(input.userId), name: input.userName, displayName: input.displayName },
    challenge: b64urlEncode(input.challenge),
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
    timeout: 120_000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: input.exclude.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports })),
  };
}

export function assertionOptions(input: { rpId: string; challenge: Uint8Array; allow: StoredCredential[] }): Record<string, unknown> {
  return {
    rpId: input.rpId,
    challenge: b64urlEncode(input.challenge),
    timeout: 120_000,
    userVerification: 'required',
    allowCredentials: input.allow.map((c) => ({ type: 'public-key', id: c.id, transports: c.transports })),
  };
}
