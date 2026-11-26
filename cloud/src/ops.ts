import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { sqlFileStore, unlinkSync, useFileStore, writeFileSync } from '../../src/cloud/fs-shim.js';
import type { Env } from './env.js';
import { SandboxBackend } from '../../src/backends/sandbox.js';
import { RouterBackend } from '../../src/backends/router.js';
import type { AdsBackend } from '../../src/backends/backend.js';
import { GoogleAdsBackend } from '../../src/backends/googleAds/backend.js';
import { GoogleAdsClient } from '../../src/backends/googleAds/client.js';
import { ServiceAccountAuth, type ServiceAccountKey } from '../../src/backends/googleAds/auth.js';
import { normalizeSettings } from '../../src/backends/googleAds/settings.js';
import { Engine } from '../../src/governance/engine.js';
import { parsePolicy, type AppConfig } from '../../src/config.js';
import { createMcpServer } from '../../src/server.js';
import { ConsoleApi, classifyConsoleRequest } from '../../src/console/api.js';
import { checkPulse } from '../../src/governance/pulse.js';
import { AuditLog } from '../../src/governance/audit.js';
import { UserError, type Proposal } from '../../src/types.js';
import { safeEqual } from '../../src/util/hash.js';
import { assertionOptions, bindChallenge, PasskeyError, registrationOptions, verifyAssertion, verifyRegistration, type AssertionResponseJSON, type RegistrationResponseJSON, type StoredCredential } from '../../src/cloud/webauthn.js';
import { clearSessionCookie, readCookie, SESSION_COOKIE, SESSION_HOURS, sessionCookie, signSession, verifySession, type SessionPayload } from '../../src/cloud/session.js';
import { isValidSubscription, sendPush, type PushMessage, type PushSubscriptionJSON, type VapidKeys } from '../../src/cloud/push.js';
import { b64urlDecode, b64urlEncode, randomBytes, sha256Bytes, utf8 } from '../../src/cloud/bytes.js';
import policyJson from '../../policy.json';
import pkg from '../../package.json';

/**
 * Campaign Ops in the cloud: one Durable Object holds the engine, the
 * sandbox, the proposals, the audit log, the passkeys and the notification
 * subscriptions, in its own SQLite database. Being a single instance, it gives
 * every change one ordered history, like the data folder on a laptop.
 *
 * The Worker in front of it (worker.ts) checks OAuth tokens for the MCP
 * endpoint. This object checks console sessions and passkey signatures.
 */

const DATA = '/data';
const CHALLENGE_MS = 5 * 60_000;
const SETUP_TRIES = 5;
const SETUP_WINDOW_MS = 15 * 60_000;
const ADD_PASSKEY_FRESH_MS = 10 * 60_000;
const MAX_CHALLENGES = 50;
/** Daily limits for the two OAuth steps anyone can start (see allowOAuthWrite). */
const OAUTH_DAILY = { authorize: 60, register: 20 } as const;

interface Challenge {
  purpose: string;
  target: string;
  binding: string;
  nonce: string;
  challenge: string;
  expiresAt: number;
}

interface Subscription extends PushSubscriptionJSON {
  device: string;
  createdAt: string;
}

interface WatchState {
  /** Alarms already sent, so a phone is not told the same thing every morning. */
  sent: Record<string, string>;
}

interface Built {
  engine: Engine;
  backend: AdsBackend;
  api: ConsoleApi;
  config: AppConfig;
  googleNote?: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers } });
}

const clean = (s: unknown, max = 60) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export class CampaignOps extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private built?: Built;
  private origin?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    useFileStore(sqlFileStore(this.sql));
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  // ---------- small storage helpers ----------

  private get<T>(key: string, fallback: T): T {
    const row = this.sql.exec('SELECT value FROM kv WHERE key = ?', key).toArray()[0];
    if (!row) return fallback;
    try {
      return JSON.parse(String(row.value)) as T;
    } catch {
      return fallback;
    }
  }

  private put(key: string, value: unknown): void {
    this.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  private credentials(): StoredCredential[] {
    return this.get<StoredCredential[]>('credentials', []);
  }

  private ownerName(): string {
    return this.get<{ name?: string }>('owner', {}).name || 'Owner';
  }

  private rememberOrigin(origin: string): void {
    if (this.origin === origin) return;
    this.origin = origin;
    if (this.get<string | null>('origin', null) !== origin) this.put('origin', origin);
  }

  private knownOrigin(): string {
    return this.origin ?? this.get<string>('origin', 'https://campaign-ops.invalid');
  }

  // ---------- the engine ----------

  private build(): Built {
    if (this.built) return this.built;
    const policy = parsePolicy(policyJson);
    const sandbox = new SandboxBackend(`${DATA}/sandbox.json`);
    sandbox.ensure();
    const parts: AdsBackend[] = [sandbox];
    let googleNote: string | undefined;
    if (this.env.GOOGLE_ADS_KEY && this.env.GOOGLE_ADS_SETTINGS) {
      try {
        const key = JSON.parse(this.env.GOOGLE_ADS_KEY) as ServiceAccountKey;
        if (key.type !== 'service_account' || !key.client_email || !key.private_key) throw new Error('GOOGLE_ADS_KEY is not a service account key.');
        const settings = normalizeSettings(JSON.parse(this.env.GOOGLE_ADS_SETTINGS), {});
        if (settings && settings.accounts.length) {
          const client = new GoogleAdsClient({
            auth: new ServiceAccountAuth(key),
            apiVersion: settings.apiVersion,
            loginCustomerId: settings.managerId || undefined,
            baseUrl: this.env.GOOGLE_ADS_API_BASE_URL || undefined,
          });
          parts.push(new GoogleAdsBackend({ settings, client }));
        }
      } catch (e) {
        googleNote = `Google Ads is not connected in the cloud: ${(e as Error).message}`;
      }
    }
    const backend = new RouterBackend(parts);
    const engine = new Engine({ backend, dataDir: DATA, policy, scope: 'execute' });
    const version = String((pkg as { version?: string }).version ?? '0.0.0');
    const api = new ConsoleApi({
      engine,
      backend,
      version,
      extraState: () => ({
        cloud: {
          owner: this.ownerName(),
          passkeys: this.credentials().map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
          push: { publicKey: this.env.VAPID_PUBLIC_KEY ?? null, devices: this.get<Subscription[]>('subscriptions', []).map((s) => ({ device: s.device, createdAt: s.createdAt, endpointHost: new URL(s.endpoint).host })) },
          googleNote,
        },
      }),
    });
    const config: AppConfig = { root: '/', dataDir: DATA, scope: 'execute', consolePort: 0, consoleToken: '', forceKillSwitch: false, policy, policySource: 'policy.json (cloud)' };
    this.built = { engine, backend, api, config, googleNote };
    return this.built;
  }

  // ---------- passkey challenges ----------

  private async newChallenge(purpose: string, target: string, binding: string): Promise<{ id: string; challenge: Uint8Array }> {
    const now = Date.now();
    // Unexpired challenges only, and at most the newest 49, so a flood of sign-in attempts cannot grow this row.
    const kept = Object.entries(this.get<Record<string, Challenge>>('challenges', {}))
      .filter(([, c]) => c.expiresAt > now)
      .sort((a, b) => b[1].expiresAt - a[1].expiresAt)
      .slice(0, MAX_CHALLENGES - 1);
    const all = Object.fromEntries(kept);
    const nonce = randomBytes(16);
    const challenge = await bindChallenge(purpose, target, binding, nonce);
    const id = b64urlEncode(randomBytes(16));
    all[id] = { purpose, target, binding, nonce: b64urlEncode(nonce), challenge: b64urlEncode(challenge), expiresAt: now + CHALLENGE_MS };
    this.put('challenges', all);
    return { id, challenge };
  }

  /** Single use: a challenge is gone after this, whatever happens next. */
  private takeChallenge(id: unknown, purpose: string, target: string): Challenge {
    const all = this.get<Record<string, Challenge>>('challenges', {});
    const c = typeof id === 'string' ? all[id] : undefined;
    if (typeof id === 'string' && all[id]) {
      delete all[id];
      this.put('challenges', all);
    }
    if (!c || c.expiresAt <= Date.now()) throw new PasskeyError('That passkey request expired. Try again.');
    if (c.purpose !== purpose || c.target !== target) throw new PasskeyError('That passkey signature was for a different action.');
    return c;
  }

  private expected(origin: string, c: Challenge) {
    return { challenge: b64urlDecode(c.challenge), origin, rpId: new URL(origin).hostname, requireUserVerification: true };
  }

  /** Checks a passkey signature for one action and returns the evidence stored with it. */
  private async prove(origin: string, proof: unknown, purpose: string, target: string, binding: string): Promise<{ evidence: Record<string, unknown>; credential: StoredCredential }> {
    const p = proof as { challengeId?: string; assertion?: AssertionResponseJSON } | undefined;
    if (!p || !p.assertion) throw new PasskeyError('This needs your passkey. Try again.');
    const c = this.takeChallenge(p.challengeId, purpose, target);
    if (c.binding !== binding) throw new PasskeyError('What you signed no longer matches the change. Look at it again and sign again.');
    const creds = this.credentials();
    const credential = creds.find((x) => x.id === p.assertion!.id);
    if (!credential) throw new PasskeyError('That passkey is not registered here.');
    const out = await verifyAssertion(p.assertion, credential, this.expected(origin, c));
    credential.signCount = out.signCount;
    credential.lastUsedAt = new Date().toISOString();
    this.put('credentials', creds);
    return {
      credential,
      evidence: {
        kind: 'passkey',
        credentialId: credential.id,
        credentialName: credential.name,
        purpose,
        target,
        binding,
        nonce: c.nonce,
        origin,
        authenticatorData: p.assertion.response.authenticatorData,
        clientDataJSON: p.assertion.response.clientDataJSON,
        signature: p.assertion.response.signature,
        userVerified: out.userVerified,
      },
    };
  }

  // ---------- sessions ----------

  private async session(request: Request): Promise<SessionPayload | null> {
    if (!this.env.SESSION_SECRET) return null;
    const s = await verifySession(readCookie(request.headers.get('Cookie'), SESSION_COOKIE), this.env.SESSION_SECRET);
    if (!s || !this.credentials().some((c) => c.id === s.cred)) return null; // a removed passkey ends its sessions
    return s;
  }

  private async startSession(credential: StoredCredential): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sessionCookie(await signSession({ sub: 'owner', cred: credential.id, iat: now, exp: now + SESSION_HOURS * 3600 }, this.env.SESSION_SECRET));
  }

  private setupState(): { open: boolean; epoch?: string; hash?: string; expiresAt?: number } {
    let code: { hash?: string; expiresAt?: number; epoch?: string } = {};
    try {
      code = JSON.parse(this.env.SETUP_CODE ?? '{}');
    } catch {
      code = {};
    }
    const used = this.get<string | null>('setupEpochUsed', null);
    const open = Boolean(code.hash && code.epoch && code.expiresAt && code.expiresAt > Date.now() && used !== code.epoch);
    return { open, epoch: code.epoch, hash: code.hash, expiresAt: code.expiresAt };
  }

  // ---------- HTTP entry (called by the Worker) ----------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.rememberOrigin(url.origin);
    try {
      if (url.pathname === '/mcp') {
        if (request.headers.get('x-ops-via') !== 'oauth') return json(403, { error: 'MCP requests must come through the OAuth gate.' });
        // Stateless server: no standing event stream to hold open (it would keep this object awake all day).
        if (request.method !== 'POST') return json(405, { error: 'Use POST.' }, { Allow: 'POST' });
        return await this.mcp(request, url.origin);
      }
      if (request.method === 'POST') {
        const origin = request.headers.get('Origin');
        if (url.pathname !== '/admin/import' && origin !== url.origin) return json(403, { error: 'Cross-site request refused.' });
        if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return json(415, { error: 'Content-Type must be application/json.' });
      }
      const body = request.method === 'POST' ? await this.readJson(request) : {};
      if (url.pathname.startsWith('/auth/')) return await this.auth(request, url, body);
      if (url.pathname.startsWith('/api/')) return await this.api(request, url, body);
      if (url.pathname === '/admin/import' && request.method === 'POST') return await this.importHistory(request, body);
      return json(404, { error: 'Not found.' });
    } catch (e) {
      if (e instanceof UserError || e instanceof PasskeyError) return json(400, { error: e.message });
      console.error('campaign-ops error', e);
      return json(500, { error: 'Unexpected error. Check the Worker logs in Cloudflare.' });
    }
  }

  private async readJson(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text();
    if (text.length > 64_000) throw new UserError('Request body too large.');
    if (!text) return {};
    try {
      const v = JSON.parse(text);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      throw new UserError('Body must be JSON.');
    }
  }

  // ---------- sign-in and setup ----------

  private async auth(request: Request, url: URL, body: Record<string, unknown>): Promise<Response> {
    const origin = url.origin;
    const rpId = url.hostname;
    const path = url.pathname;

    if (request.method === 'GET' && path === '/auth/session') {
      const s = await this.session(request);
      return json(200, { mode: 'cloud', signedIn: Boolean(s), owner: s ? this.ownerName() : undefined, hasPasskeys: this.credentials().length > 0, setupOpen: this.setupState().open });
    }
    if (request.method !== 'POST') return json(404, { error: 'Not found.' });

    if (path === '/auth/setup/options') {
      const setup = this.setupState();
      if (!setup.open) throw new UserError('Setup is closed. Run "npm run cloud:code" on your computer for a new setup code.');
      const tries = this.get<{ count: number; since: number }>('setupTries', { count: 0, since: Date.now() });
      if (Date.now() - tries.since > SETUP_WINDOW_MS) Object.assign(tries, { count: 0, since: Date.now() });
      if (tries.count >= SETUP_TRIES) throw new UserError('Too many wrong codes. Wait 15 minutes and try again.');
      const code = String(body.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const hash = b64urlEncode(await sha256Bytes(utf8(`campaign-ops-setup:${code}`)));
      if (!code || !setup.hash || !safeEqual(hash, setup.hash)) {
        tries.count += 1;
        this.put('setupTries', tries);
        throw new UserError('That setup code is not right. Check the code printed on your computer.');
      }
      const name = clean(body.name, 40) || this.ownerName();
      this.put('owner', { name });
      const { id, challenge } = await this.newChallenge('register', 'setup', setup.epoch ?? '');
      const userId = this.get<string | null>('userId', null) ?? b64urlEncode(randomBytes(16));
      this.put('userId', userId);
      return json(200, {
        challengeId: id,
        options: registrationOptions({ rpId, rpName: 'Campaign Ops', userId: b64urlDecode(userId), userName: `campaign-ops-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, displayName: `${name} (Campaign Ops)`, challenge, exclude: this.credentials() }),
      });
    }

    if (path === '/auth/setup/finish' || path === '/auth/passkeys/add/finish') {
      const adding = path === '/auth/passkeys/add/finish';
      if (adding) {
        const s = await this.session(request);
        if (!s || Date.now() / 1000 - s.iat > ADD_PASSKEY_FRESH_MS / 1000) throw new UserError('Sign in again with an existing passkey first, then add this device within 10 minutes.');
      }
      const setup = this.setupState();
      const c = this.takeChallenge(body.challengeId, 'register', adding ? 'add' : 'setup');
      if (!adding && (!setup.open || c.binding !== setup.epoch)) throw new UserError('Setup is closed. Run "npm run cloud:code" on your computer for a new setup code.');
      const reg = await verifyRegistration(body.credential as RegistrationResponseJSON, this.expected(origin, c));
      const creds = this.credentials();
      if (creds.some((x) => x.id === reg.credentialId)) throw new UserError('That passkey is already registered.');
      const credential: StoredCredential = { id: reg.credentialId, publicKey: reg.publicKey, alg: reg.alg, signCount: reg.signCount, name: clean(body.device, 40) || 'Passkey', createdAt: new Date().toISOString(), transports: reg.transports };
      creds.push(credential);
      this.put('credentials', creds);
      if (!adding) this.put('setupEpochUsed', setup.epoch);
      await this.build().engine.recordEvent('passkey_added', `${this.ownerName()} (passkey on ${credential.name})`, { passkey: credential.name, how: adding ? 'added from a signed-in device' : 'setup code' });
      return json(200, { ok: true, passkey: credential.name }, { 'Set-Cookie': await this.startSession(credential) });
    }

    if (path === '/auth/passkeys/add/options') {
      const s = await this.session(request);
      if (!s || Date.now() / 1000 - s.iat > ADD_PASSKEY_FRESH_MS / 1000) throw new UserError('Sign in again with an existing passkey first, then add this device within 10 minutes.');
      const { id, challenge } = await this.newChallenge('register', 'add', '');
      const userId = this.get<string | null>('userId', null) ?? b64urlEncode(randomBytes(16));
      this.put('userId', userId);
      const name = this.ownerName();
      return json(200, {
        challengeId: id,
        options: registrationOptions({ rpId, rpName: 'Campaign Ops', userId: b64urlDecode(userId), userName: `campaign-ops-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, displayName: `${name} (Campaign Ops)`, challenge, exclude: this.credentials() }),
      });
    }

    if (path === '/auth/login/options' || path === '/auth/consent/options') {
      const creds = this.credentials();
      if (!creds.length) throw new UserError('No passkey is set up yet. Open the console and use your setup code first.');
      const consent = path === '/auth/consent/options';
      const target = consent ? clean(body.handle, 200) : 'console';
      if (consent && !target) throw new UserError('Missing consent handle.');
      const { id, challenge } = await this.newChallenge(consent ? 'consent' : 'login', target, '');
      return json(200, { challengeId: id, options: assertionOptions({ rpId, challenge, allow: creds }) });
    }

    if (path === '/auth/login/finish') {
      const { credential } = await this.prove(origin, { challengeId: body.challengeId, assertion: body.assertion }, 'login', 'console', '');
      return json(200, { ok: true, owner: this.ownerName() }, { 'Set-Cookie': await this.startSession(credential) });
    }

    if (path === '/auth/logout') return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return json(404, { error: 'Not found.' });
  }

  /** Called by the Worker when the person allows Claude on the OAuth consent page. */
  async verifyConsent(origin: string, handle: string, challengeId: string, assertion: AssertionResponseJSON): Promise<{ ok: boolean; passkey?: string; owner?: string; error?: string }> {
    try {
      const { credential } = await this.prove(origin, { challengeId, assertion }, 'consent', handle, '');
      const { engine } = this.build();
      await engine.recordEvent('connector_authorized', `${this.ownerName()} (passkey on ${credential.name})`, { client: 'MCP connector' });
      return { ok: true, passkey: credential.name, owner: this.ownerName() };
    } catch (e) {
      return { ok: false, error: e instanceof PasskeyError || e instanceof UserError ? e.message : 'The passkey check failed.' };
    }
  }

  // ---------- the console API ----------

  private async api(request: Request, url: URL, body: Record<string, unknown>): Promise<Response> {
    const s = await this.session(request);
    if (!s) return json(401, { error: 'Sign in with your passkey.', signIn: true });
    const { api, engine } = this.build();
    const origin = url.origin;
    const owner = this.ownerName();
    const credName = this.credentials().find((c) => c.id === s.cred)?.name ?? 'passkey';
    const path = url.pathname;

    if (request.method === 'POST' && path === '/api/passkey/options') {
      const purpose = String(body.purpose ?? '');
      const target = clean(body.target, 60);
      const binding = await this.bindingFor(purpose, target, body);
      const { id, challenge } = await this.newChallenge(purpose, target, binding);
      return json(200, { challengeId: id, options: assertionOptions({ rpId: url.hostname, challenge, allow: this.credentials() }) });
    }

    if (request.method === 'GET' && path === '/api/signatures') return json(200, await this.checkSignatures());

    if (request.method === 'POST' && path.startsWith('/api/push/')) return this.pushApi(path, body, origin);

    if (request.method === 'POST' && path === '/api/passkeys/remove') {
      const id = clean(body.id, 200);
      await this.prove(origin, body.proof, 'remove_passkey', id, '');
      const creds = this.credentials();
      if (creds.length <= 1) throw new UserError('This is your only passkey. Add another device before removing it.');
      const gone = creds.find((c) => c.id === id);
      if (!gone) throw new UserError('No such passkey.');
      this.put('credentials', creds.filter((c) => c.id !== id));
      await engine.recordEvent('passkey_removed', `${owner} (passkey on ${credName})`, { passkey: gone.name });
      return json(200, { ok: true });
    }

    const action = classifyConsoleRequest(request.method, path, body);
    let who = `${owner} (console)`;
    let approval: { evidence?: Record<string, unknown>; bindingHash?: string } | undefined;
    if (action.powerful) {
      const binding = await this.bindingFor(action.kind, action.target ?? '', body);
      const proved = await this.prove(origin, body.proof, action.kind, action.target ?? '', binding);
      who = `${owner} (passkey on ${proved.credential.name})`;
      if (action.kind === 'approve' || action.kind === 'undo') approval = { evidence: proved.evidence, bindingHash: action.kind === 'approve' ? binding : undefined };
    }
    const result = await api.handle({ method: request.method, pathname: path, query: url.searchParams, body, who, approval });
    if (!result) return json(404, { error: 'Not found.' });
    return json(result.status, result.body);
  }

  /** What a passkey signs for each action: the exact change for approvals, the hours for a change window. */
  private async bindingFor(purpose: string, target: string, body: Record<string, unknown>): Promise<string> {
    const { engine } = this.build();
    switch (purpose) {
      case 'approve': {
        const p = await engine.getProposal(target);
        if (!p || p.status !== 'pending_approval') throw new UserError(`${target} is not waiting for approval.`);
        return p.bindingHash;
      }
      case 'undo': {
        const p = await engine.getProposal(target);
        if (!p || p.status !== 'applied') throw new UserError(`${target} is not an applied change.`);
        return p.bindingHash;
      }
      case 'open_window': {
        const hours = Number(body.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw new UserError('Choose how many hours first.');
        return `${hours}h`;
      }
      case 'resume_all':
      case 'remove_passkey':
        return '';
      default:
        throw new UserError('That action does not use a passkey.');
    }
  }

  /** Re-checks every passkey signature stored with an approval. */
  private async checkSignatures(): Promise<Record<string, unknown>> {
    const { engine } = this.build();
    const creds = this.credentials();
    const out: Array<{ proposalId: string; passkey: string; valid: boolean; reason?: string }> = [];
    for (const p of engine.store.list()) {
      const ev = p.approval?.evidence as Record<string, string> | undefined;
      if (!ev || ev.kind !== 'passkey') continue;
      const cred = creds.find((c) => c.id === ev.credentialId);
      if (!cred) {
        out.push({ proposalId: p.id, passkey: ev.credentialName ?? 'removed passkey', valid: false, reason: 'The passkey was removed, so its public key is gone.' });
        continue;
      }
      try {
        if (ev.purpose === 'approve' && ev.binding !== p.bindingHash) throw new PasskeyError('The signature names a different change.');
        if (ev.purpose === 'undo') {
          const original = engine.store.list().find((x) => x.id === ev.target);
          if (p.rollbackOf !== ev.target || !original || original.bindingHash !== ev.binding) throw new PasskeyError('The signature names a different change.');
        }
        const challenge = await bindChallenge(ev.purpose, ev.target, ev.binding, b64urlDecode(ev.nonce));
        await verifyAssertion(
          { id: cred.id, type: 'public-key', response: { authenticatorData: ev.authenticatorData, clientDataJSON: ev.clientDataJSON, signature: ev.signature } },
          cred,
          { challenge, origin: ev.origin, rpId: new URL(ev.origin).hostname, requireUserVerification: true },
          { checkCounter: false },
        );
        out.push({ proposalId: p.id, passkey: cred.name, valid: true });
      } catch (e) {
        out.push({ proposalId: p.id, passkey: cred.name, valid: false, reason: (e as Error).message });
      }
    }
    return { total: out.length, valid: out.filter((x) => x.valid).length, signatures: out.reverse() };
  }

  // ---------- notifications ----------

  private vapid(): VapidKeys | undefined {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return undefined;
    try {
      return { publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: JSON.parse(this.env.VAPID_PRIVATE_KEY) };
    } catch {
      return undefined;
    }
  }

  private async pushApi(path: string, body: Record<string, unknown>, origin: string): Promise<Response> {
    const subs = this.get<Subscription[]>('subscriptions', []);
    if (path === '/api/push/subscribe') {
      if (!this.vapid()) throw new UserError('Notifications are not set up on this server. Run npm run cloud:setup again.');
      const sub = body.subscription;
      if (!isValidSubscription(sub, { allowHttp: this.env.ALLOW_INSECURE_TEST_ENDPOINTS === '1' })) throw new UserError('That notification subscription is not valid.');
      const kept = subs.filter((s) => s.endpoint !== sub.endpoint).slice(-9);
      kept.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: clean(body.device, 40) || 'This device', createdAt: new Date().toISOString() });
      this.put('subscriptions', kept);
      return json(200, { ok: true, devices: kept.length });
    }
    if (path === '/api/push/unsubscribe') {
      const endpoint = String(body.endpoint ?? '');
      this.put('subscriptions', subs.filter((s) => s.endpoint !== endpoint));
      return json(200, { ok: true });
    }
    if (path === '/api/push/test') {
      const sent = await this.notify({ title: 'Campaign Ops', body: 'Notifications work. You will hear from me when a change needs you.', url: '/', tag: 'test' }, origin);
      return json(200, { ok: sent.sent > 0, ...sent });
    }
    return json(404, { error: 'Not found.' });
  }

  private async notify(message: PushMessage, origin = this.knownOrigin()): Promise<{ sent: number; failed: number }> {
    const vapid = this.vapid();
    const subs = this.get<Subscription[]>('subscriptions', []);
    if (!vapid || !subs.length) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    const keep: Subscription[] = [];
    for (const s of subs) {
      try {
        const r = await sendPush(s, message, vapid, origin);
        if (r.ok) sent++;
        else failed++;
        if (!r.gone) keep.push(s);
      } catch {
        failed++;
        keep.push(s);
      }
    }
    if (keep.length !== subs.length) this.put('subscriptions', keep);
    return { sent, failed };
  }

  private waitingMessage(p: Proposal): PushMessage {
    const prefix = p.risk === 'high' ? 'High risk: ' : '';
    return { title: `${prefix}${p.typeLabel} needs you`, body: `${p.id}: ${p.summary}`.slice(0, 180), url: `/#p=${p.id}`, tag: p.id };
  }

  // ---------- MCP ----------

  private async mcp(request: Request, origin: string): Promise<Response> {
    const { engine, backend, config } = this.build();
    const server = createMcpServer({
      engine,
      backend,
      config,
      version: String((pkg as { version?: string }).version ?? '0.0.0'),
      consoleUrl: () => `${origin}/`,
      agentName: () => 'AI agent (cloud connector)',
      passkeyOnly: true,
      onWaiting: (p) => {
        this.ctx.waitUntil(this.notify(this.waitingMessage(p), origin).catch(() => undefined));
      },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      this.ctx.waitUntil(server.close().catch(() => undefined));
    }
  }

  // ---------- daily watch (called by the Worker's cron) ----------

  async accountIds(): Promise<string[]> {
    return (await this.build().backend.listAccounts()).map((a) => a.id);
  }

  /** Runs Pulse and the witness check for one account and tells the phone about anything new. */
  async watchAccount(accountId: string): Promise<{ alarms: number; notified: number }> {
    const { engine, backend } = this.build();
    const account = await backend.getAccount(accountId);
    if (!account) return { alarms: 0, notified: 0 };
    const state = this.get<WatchState>('watch', { sent: {} });
    const now = Date.now();
    for (const [k, at] of Object.entries(state.sent)) if (now - Date.parse(at) > 14 * 86_400_000) delete state.sent[k];
    const messages: PushMessage[] = [];
    let alarms = 0;
    try {
      const pulse = await checkPulse(backend, accountId, { days: 28 });
      for (const a of pulse.alarms) {
        alarms++;
        const key = `pulse:${accountId}:${a.kind}:${a.campaignId}:${a.evidence.dates[a.evidence.highlightFrom] ?? ''}`;
        if (state.sent[key]) continue;
        state.sent[key] = new Date(now).toISOString();
        messages.push({ title: `Pulse: ${account.name}`, body: a.title.slice(0, 180), url: `/#a=${encodeURIComponent(accountId)}`, tag: `pulse-${a.kind}` });
      }
    } catch {
      // Pulse problems show in the console; the watch keeps going
    }
    try {
      const w = await engine.witness(accountId, 14);
      if (w.verdict === 'alarm') {
        alarms++;
        const key = `witness:${accountId}:${w.unexplained.map((e) => `${e.resourceName}@${e.at}`).join('|')}`;
        if (!state.sent[key]) {
          state.sent[key] = new Date(now).toISOString();
          messages.push({ title: `Unapproved change in ${account.name}`, body: w.headline.slice(0, 180), url: `/#a=${encodeURIComponent(accountId)}`, tag: 'witness' });
        }
      }
    } catch {
      // as above
    }
    this.put('watch', state);
    let notified = 0;
    for (const m of messages) notified += (await this.notify(m)).sent;
    return { alarms, notified };
  }

  async knownPublicOrigin(): Promise<string> {
    return this.knownOrigin();
  }

  /**
   * Opening the connect page and registering an app each write to the OAuth
   * store, which allows 1,000 writes a day on the free plan. Anyone can call
   * those two, so they get a daily budget here; token refreshes need a valid
   * token and are not counted.
   */
  async allowOAuthWrite(kind: 'authorize' | 'register'): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const budget = this.get<{ day: string; authorize: number; register: number }>('oauthBudget', { day, authorize: 0, register: 0 });
    if (budget.day !== day) Object.assign(budget, { day, authorize: 0, register: 0 });
    if (budget[kind] >= OAUTH_DAILY[kind]) return false;
    budget[kind] += 1;
    this.put('oauthBudget', budget);
    return true;
  }

  // ---------- moving history from a laptop ----------

  private async importHistory(request: Request, body: Record<string, unknown>): Promise<Response> {
    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!this.env.IMPORT_TOKEN || !token || !safeEqual(token, this.env.IMPORT_TOKEN)) return json(401, { error: 'Wrong or missing import token.' });
    if (this.get<boolean>('imported', false)) return json(409, { error: 'History was already moved to the cloud. It can only happen once.' });
    const { engine } = this.build();
    if (engine.store.list().length || engine.audit.readAll().length) return json(409, { error: 'The cloud already has its own history, so nothing was imported.' });
    const proposals = typeof body.proposals === 'string' ? body.proposals : '';
    const audit = typeof body.audit === 'string' ? body.audit : '';
    const sandbox = typeof body.sandbox === 'string' ? body.sandbox : '';
    if (!audit.trim()) return json(400, { error: 'Nothing to import.' });
    for (const [name, text] of [['proposals.json', proposals], ['sandbox.json', sandbox]]) {
      try {
        if (text) JSON.parse(text);
      } catch {
        return json(400, { error: `${name} is not valid JSON.` });
      }
    }
    const check = new AuditLog(`${DATA}/import-check.jsonl`);
    writeFileSync(`${DATA}/import-check.jsonl`, audit);
    const chain = check.verify();
    unlinkSync(`${DATA}/import-check.jsonl`);
    if (!chain.ok) return json(400, { error: `The audit log on your computer is broken (${chain.problem}), so it was not imported.` });
    if (proposals) writeFileSync(`${DATA}/proposals.json`, proposals);
    if (sandbox) writeFileSync(`${DATA}/sandbox.json`, sandbox);
    writeFileSync(`${DATA}/audit.jsonl`, audit);
    this.put('imported', true);
    await engine.recordEvent('history_imported', 'npm run cloud:setup', { entries: chain.count, proposals: engine.store.list().length });
    return json(200, { ok: true, entries: chain.count, proposals: engine.store.list().length });
  }
}
