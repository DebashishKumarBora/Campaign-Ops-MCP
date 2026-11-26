import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ab, b64urlDecode, b64urlEncode, concat, fromUtf8, sha256Bytes, utf8, type CryptoKeyPair, type JsonWebKey } from '../src/cloud/bytes.js';
import { decodeCbor } from '../src/cloud/cbor.js';
import { bindChallenge, derToRawEcdsa, PasskeyError, verifyAssertion, verifyRegistration, type CoseAlg, type StoredCredential } from '../src/cloud/webauthn.js';
import { readCookie, sessionCookie, signSession, verifySession } from '../src/cloud/session.js';
import { encryptPayload, generateVapidKeys, isValidSubscription, sendPush, vapidAuthorization } from '../src/cloud/push.js';

// ---------- a tiny CBOR encoder and a software authenticator, standing in for a phone ----------

function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number): Uint8Array => {
    if (n < 24) return new Uint8Array([(major << 5) | n]);
    if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
    if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
    return new Uint8Array([(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const b = utf8(value);
    return concat(head(3, b.length), b);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error('test encoder: unsupported');
}

/** WebAuthn wants DER-encoded ECDSA signatures; WebCrypto gives raw r||s. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let out: Uint8Array = v.slice(i);
    if (out[0] & 0x80) out = concat(new Uint8Array([0]), out);
    return concat(new Uint8Array([2, out.length]), out);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const RP = 'ops.example.workers.dev';
const ORIGIN = `https://${RP}`;

async function authenticator(alg: CoseAlg) {
  const keys = (alg === -7
    ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const credId = crypto.getRandomValues(new Uint8Array(32));
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const cose =
    alg === -7
      ? new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, b64urlDecode(jwk.x!)], [-3, b64urlDecode(jwk.y!)]])
      : new Map<number, unknown>([[1, 3], [3, -257], [-1, b64urlDecode(jwk.n!)], [-2, b64urlDecode(jwk.e!)]]);
  let counter = 0;
  const flagsFor = (uv: boolean) => 0x01 | (uv ? 0x04 : 0);
  return {
    id: b64urlEncode(credId),
    useCounter: false,
    async register(challenge: Uint8Array, opts: { origin?: string; rpId?: string; uv?: boolean } = {}) {
      const rpIdHash = await sha256Bytes(utf8(opts.rpId ?? RP));
      const authData = concat(rpIdHash, new Uint8Array([flagsFor(opts.uv !== false) | 0x40, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, credId.length]), credId, cbor(cose));
      const clientData = utf8(JSON.stringify({ type: 'webauthn.create', challenge: b64urlEncode(challenge), origin: opts.origin ?? ORIGIN, crossOrigin: false }));
      return { id: b64urlEncode(credId), type: 'public-key', response: { clientDataJSON: b64urlEncode(clientData), attestationObject: b64urlEncode(cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal', 'hybrid'] } };
    },
    async sign(challenge: Uint8Array, opts: { origin?: string; rpId?: string; uv?: boolean; type?: string } = {}) {
      if (this.useCounter) counter += 1;
      const rpIdHash = await sha256Bytes(utf8(opts.rpId ?? RP));
      const authData = concat(rpIdHash, new Uint8Array([flagsFor(opts.uv !== false), (counter >>> 24) & 255, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255]));
      const clientData = utf8(JSON.stringify({ type: opts.type ?? 'webauthn.get', challenge: b64urlEncode(challenge), origin: opts.origin ?? ORIGIN, crossOrigin: false }));
      const signed = concat(authData, await sha256Bytes(clientData));
      const sig =
        alg === -7
          ? rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, ab(signed))))
          : new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, ab(signed)));
      return { id: b64urlEncode(credId), type: 'public-key', response: { clientDataJSON: b64urlEncode(clientData), authenticatorData: b64urlEncode(authData), signature: b64urlEncode(sig) } };
    },
  };
}

const expected = (challenge: Uint8Array) => ({ challenge, origin: ORIGIN, rpId: RP, requireUserVerification: true });

describe('bytes and CBOR', () => {
  test('base64url round trips and rejects junk', () => {
    const bytes = concat(crypto.getRandomValues(new Uint8Array(60_000)), crypto.getRandomValues(new Uint8Array(10_000)));
    assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);
    assert.equal(b64urlEncode(utf8('hi?')), 'aGk_');
    assert.throws(() => b64urlDecode('a$b'));
  });
  test('CBOR decodes maps, negative keys, byte strings and reports its length', () => {
    const data = cbor(new Map<unknown, unknown>([[1, 2], [-2, new Uint8Array([9, 8])], ['fmt', 'none']]));
    const { value, length } = decodeCbor(concat(data, new Uint8Array([0xff])));
    assert.equal(length, data.length);
    assert.ok(value instanceof Map);
    assert.equal(value.get(1), 2);
    assert.deepEqual(value.get(-2), new Uint8Array([9, 8]));
    assert.equal(value.get('fmt'), 'none');
    assert.throws(() => decodeCbor(new Uint8Array([0x5a, 0, 0, 0, 9])), /ends early/);
  });
});

describe('passkeys', () => {
  for (const alg of [-7, -257] as CoseAlg[]) {
    test(`registers and signs in with a ${alg === -7 ? 'P-256 (Face ID, Touch ID, Android)' : 'RSA (Windows Hello)'} passkey`, async () => {
      const a = await authenticator(alg);
      const regChallenge = crypto.getRandomValues(new Uint8Array(32));
      const reg = await verifyRegistration(await a.register(regChallenge), expected(regChallenge));
      assert.equal(reg.credentialId, a.id);
      assert.equal(reg.alg, alg);
      assert.equal(reg.userVerified, true);
      assert.deepEqual(reg.transports, ['internal', 'hybrid']);
      const cred: StoredCredential = { id: reg.credentialId, publicKey: reg.publicKey, alg: reg.alg, signCount: reg.signCount, name: 'Test phone', createdAt: new Date().toISOString() };
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const out = await verifyAssertion(await a.sign(challenge), cred, expected(challenge));
      assert.equal(out.userVerified, true);
    });
  }

  test('refuses the wrong site, the wrong challenge, no face or fingerprint check, and a forged signature', async () => {
    const a = await authenticator(-7);
    const c0 = crypto.getRandomValues(new Uint8Array(32));
    const reg = await verifyRegistration(await a.register(c0), expected(c0));
    const cred: StoredCredential = { id: reg.credentialId, publicKey: reg.publicKey, alg: reg.alg, signCount: 0, name: 'p', createdAt: '' };
    const c = crypto.getRandomValues(new Uint8Array(32));
    await assert.rejects(verifyAssertion(await a.sign(c, { origin: 'https://evil.example' }), cred, expected(c)), /was used on https:\/\/evil\.example/);
    await assert.rejects(verifyAssertion(await a.sign(c, { rpId: 'evil.example' }), cred, expected(c)), /different site/);
    await assert.rejects(verifyAssertion(await a.sign(crypto.getRandomValues(new Uint8Array(32))), cred, expected(c)), /signed a different request/);
    await assert.rejects(verifyAssertion(await a.sign(c, { uv: false }), cred, expected(c)), /did not check your face, fingerprint or PIN/);
    await assert.rejects(verifyAssertion(await a.sign(c, { type: 'webauthn.create' }), cred, expected(c)), /different step/);
    const good = await a.sign(c);
    const sig = b64urlDecode(good.response.signature);
    sig[sig.length - 3] ^= 0x55;
    await assert.rejects(verifyAssertion({ ...good, response: { ...good.response, signature: b64urlEncode(sig) } }, cred, expected(c)), PasskeyError);
    const other = await authenticator(-7);
    await assert.rejects(verifyAssertion(await other.sign(c), cred, expected(c)), /not the one expected/);
    await assert.rejects(verifyRegistration(await a.register(c0, { uv: false }), expected(c0)), /face, fingerprint or PIN/);
  });

  test('a counter that goes backwards is refused (a copied passkey)', async () => {
    const a = await authenticator(-7);
    a.useCounter = true;
    const c0 = crypto.getRandomValues(new Uint8Array(32));
    const reg = await verifyRegistration(await a.register(c0), expected(c0));
    const cred: StoredCredential = { id: reg.credentialId, publicKey: reg.publicKey, alg: reg.alg, signCount: 0, name: 'p', createdAt: '' };
    const c = crypto.getRandomValues(new Uint8Array(32));
    const first = await verifyAssertion(await a.sign(c), cred, expected(c));
    assert.equal(first.signCount, 1);
    cred.signCount = 5;
    await assert.rejects(verifyAssertion(await a.sign(c), cred, expected(c)), /old counter/);
  });

  test('an approval challenge names the exact change, so a signature cannot be reused', async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const a = await bindChallenge('approve', 'P-0007', 'hash-a', nonce);
    assert.equal(a.length, 32);
    assert.deepEqual(a, await bindChallenge('approve', 'P-0007', 'hash-a', nonce));
    assert.notDeepEqual(a, await bindChallenge('approve', 'P-0007', 'hash-b', nonce));
    assert.notDeepEqual(a, await bindChallenge('approve', 'P-0008', 'hash-a', nonce));
    assert.notDeepEqual(a, await bindChallenge('undo', 'P-0007', 'hash-a', nonce));
  });

  test('DER signatures with leading zeros convert to 64 raw bytes', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80;
    raw[33] = 0x01;
    const back = derToRawEcdsa(rawToDer(raw));
    assert.deepEqual(back, raw);
  });
});

describe('sessions', () => {
  const secret = 'x'.repeat(40);
  test('a signed session verifies; edits, another secret and expiry do not', async () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    const token = await signSession({ sub: 'owner', cred: 'abc', iat: now / 1000, exp: now / 1000 + 3600 }, secret);
    assert.equal((await verifySession(token, secret, now))?.cred, 'abc');
    assert.equal(await verifySession(token, 'y'.repeat(40), now), null);
    assert.equal(await verifySession(token, secret, now + 3601_000), null);
    const [body, sig] = token.split('.');
    const forged = b64urlEncode(utf8(fromUtf8(b64urlDecode(body)).replace('abc', 'xyz')));
    assert.equal(await verifySession(`${forged}.${sig}`, secret, now), null);
    assert.equal(await verifySession('', secret, now), null);
    assert.equal(await verifySession('a.b.c', secret, now), null);
    await assert.rejects(signSession({ sub: 'owner', cred: 'a', iat: 0, exp: 1 }, 'short'), /at least 32/);
  });
  test('cookies are host-only, secure, HttpOnly and same-site', () => {
    const c = sessionCookie('tok');
    for (const part of ['__Host-cops-session=tok', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(c.includes(part), part);
    assert.equal(readCookie('a=1; __Host-cops-session=tok; b=2', '__Host-cops-session'), 'tok');
    assert.equal(readCookie(null, 'x'), undefined);
  });
});

describe('web push', () => {
  // RFC 8291, section 5 and appendix A.
  const V = {
    plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const jwkFor = (pub: string, priv: string): JsonWebKey => {
    const p = b64urlDecode(pub);
    return { kty: 'EC', crv: 'P-256', x: b64urlEncode(p.slice(1, 33)), y: b64urlEncode(p.slice(33)), d: priv, ext: true };
  };

  /** Decrypts like a browser would: an independent implementation of RFC 8291 to check ours. */
  async function decrypt(body: Uint8Array, uaPublic: string, uaPrivate: JsonWebKey, auth: string): Promise<string> {
    const salt = body.slice(0, 16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const ct = body.slice(21 + idlen);
    const priv = await crypto.subtle.importKey('jwk', uaPrivate, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const pub = await crypto.subtle.importKey('raw', ab(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
    const hk = async (s: Uint8Array, k: Uint8Array, info: string | Uint8Array, len: number) =>
      new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ab(s), info: ab(typeof info === 'string' ? utf8(info) : info) }, await crypto.subtle.importKey('raw', ab(k), 'HKDF', false, ['deriveBits']), len * 8));
    const ikm = await hk(b64urlDecode(auth), secret, concat(utf8('WebPush: info\0'), b64urlDecode(uaPublic), asPublic), 32);
    const cek = await hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
    const nonce = await hk(salt, ikm, 'Content-Encoding: nonce\0', 12);
    const key = await crypto.subtle.importKey('raw', ab(cek), 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(nonce) }, key, ab(ct)));
    assert.equal(plain[plain.length - 1], 2, 'ends with the last-record delimiter');
    return fromUtf8(plain.slice(0, -1));
  }

  test("matches RFC 8291's worked example byte for byte", async () => {
    const body = await encryptPayload(b64urlDecode(V.plaintext), { endpoint: 'https://push.example/x', keys: { p256dh: V.uaPublic, auth: V.auth } }, {
      salt: b64urlDecode(V.salt),
      serverPublic: b64urlDecode(V.asPublic),
      serverPrivate: jwkFor(V.asPublic, V.asPrivate),
    });
    assert.equal(b64urlEncode(body), V.body);
  });

  test('a real message decrypts on the phone side, and the VAPID token is valid', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPublic = b64urlEncode(await crypto.subtle.exportKey('raw', ua.publicKey));
    const uaPrivate = await crypto.subtle.exportKey('jwk', ua.privateKey);
    const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const sub = { endpoint: 'https://web.push.apple.com/QGuQyavXut', keys: { p256dh: uaPublic, auth } };
    assert.ok(isValidSubscription(sub));
    assert.ok(!isValidSubscription({ ...sub, endpoint: 'http://web.push.apple.com/x' }));
    assert.ok(isValidSubscription({ ...sub, endpoint: 'http://127.0.0.1:9/x' }, { allowHttp: true }));
    // Only real push services: a subscription cannot send the server to any other site.
    assert.ok(isValidSubscription({ ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }));
    assert.ok(isValidSubscription({ ...sub, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc' }));
    assert.ok(isValidSubscription({ ...sub, endpoint: 'https://wns2-bl2p.notify.windows.com/w/?token=abc' }));
    assert.ok(!isValidSubscription({ ...sub, endpoint: 'https://example.com/push' }));
    assert.ok(!isValidSubscription({ ...sub, endpoint: 'https://fcm.googleapis.com.evil.example/push' }));
    assert.ok(!isValidSubscription({ ...sub, endpoint: 'https://169.254.169.254/latest' }));
    const vapid = await generateVapidKeys();
    let seen: { url: string; init: RequestInit } | undefined;
    const out = await sendPush(sub, { title: 'P-0007 is waiting', body: 'Raise the budget $40 to $48', url: '/#p=P-0007', tag: 'P-0007' }, vapid, 'https://ops.example.workers.dev', async (url, init) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    });
    assert.deepEqual(out, { ok: true, status: 201, gone: false });
    const headers = seen!.init.headers as Record<string, string>;
    assert.equal(headers['Content-Encoding'], 'aes128gcm');
    assert.equal(headers.Topic, 'P-0007');
    const message = JSON.parse(await decrypt(new Uint8Array(seen!.init.body as ArrayBuffer), uaPublic, uaPrivate, auth));
    assert.equal(message.url, '/#p=P-0007');

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization)!;
    assert.equal(m[2], vapid.publicKey);
    const [h, c, s] = m[1].split('.');
    const claims = JSON.parse(fromUtf8(b64urlDecode(c)));
    assert.equal(claims.aud, 'https://web.push.apple.com');
    assert.equal(claims.sub, 'https://ops.example.workers.dev');
    const pub = await crypto.subtle.importKey('raw', ab(b64urlDecode(vapid.publicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, ab(b64urlDecode(s)), ab(utf8(`${h}.${c}`))));

    const gone = await sendPush(sub, { title: 't', body: 'b', url: '/' }, vapid, 'https://x.example', async () => new Response(null, { status: 410 }));
    assert.equal(gone.gone, true);
    assert.ok((await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 'mailto:a@b.c')).startsWith('vapid t='));
  });
});
