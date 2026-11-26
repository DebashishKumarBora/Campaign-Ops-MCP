// Shared by the cloud end-to-end check and the screenshot pass: runs Campaign Ops
// in wrangler dev (the same runtime as Cloudflare) next to a fake Google Ads API and
// a fake push service, all on 127.0.0.1. Nothing here reaches the internet.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => import(pathToFileURL(path.join(root, 'dist', p)).href);

export function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    console.error('This needs Playwright. Run: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
}

const { FakeGoogleAds } = await load('test/fakeGoogleAds.js');
const { ServiceAccountAuth } = await load('src/backends/googleAds/auth.js');
const { GoogleAdsClient } = await load('src/backends/googleAds/client.js');
const { seedAccount } = await load('src/backends/googleAds/seeder.js');
const { SandboxBackend } = await load('src/backends/sandbox.js');
const { Engine } = await load('src/governance/engine.js');
const { DEFAULT_POLICY } = await load('src/config.js');
const { generateVapidKeys } = await load('src/cloud/push.js');

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(what, fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---------- a push service that decrypts what it receives (RFC 8291) ----------

export function pushService() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const salt = body.subarray(0, 16);
        const idlen = body[20];
        const asPublic = body.subarray(21, 21 + idlen);
        const ciphertext = body.subarray(21 + idlen);
        const shared = ecdh.computeSecret(asPublic);
        const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
        const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, info, 32));
        const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
        const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
        const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
        decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
        const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
        const end = padded.lastIndexOf(2);
        const message = JSON.parse(padded.subarray(0, end).toString('utf8'));
        received.push({ message, headers: req.headers });
        res.writeHead(201).end();
      } catch (e) {
        received.push({ error: e.message, headers: req.headers });
        res.writeHead(400).end();
      }
    });
  });
  return {
    received,
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      return { endpoint: `http://127.0.0.1:${port}/push/e2e-phone`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------- a laptop with some history to move to the cloud ----------

export async function laptopHistory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-laptop-'));
  const sandbox = new SandboxBackend(path.join(dir, 'sandbox.json'));
  sandbox.ensure();
  const engine = new Engine({ backend: sandbox, dataDir: dir, policy: DEFAULT_POLICY, scope: 'execute' });
  const account = (await sandbox.listAccounts())[0];
  // The last enabled campaign, so the cloud's own proposals (on the first one) are not held by the cooldown.
  const campaign = (await sandbox.listCampaigns(account.id)).filter((c) => c.status === 'ENABLED').pop();
  const p = await engine.propose({ accountId: account.id, change: { type: 'set_campaign_budget', campaignId: campaign.id, newDailyBudget: Math.round(campaign.dailyBudget * 1.1) }, reason: 'Laptop history: a small raise approved before the move to the cloud.', requestedBy: 'agent (laptop)' });
  await engine.approve(p.id, { by: 'Deb (console)', channel: 'console' });
  await engine.apply(p.id, { actor: 'agent (laptop)' });
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const out = { proposals: read('proposals.json'), audit: read('audit.jsonl'), sandbox: read('sandbox.json'), entries: read('audit.jsonl').trim().split('\n').length };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---------- the fake Google Ads API with one live account ----------

export const MGR = '5550001111';
export const LIVE = '5550002222';
export const LIVE_D = '555-000-2222';
export const LIVE_NAME = 'Acme Apartments';

export async function fakeGoogle() {
  const fake = new FakeGoogleAds();
  fake.accessLevel = 'explorer';
  fake.addCustomer({ id: MGR, name: 'Acme Agency', manager: true, testAccount: false });
  fake.addCustomer({ id: LIVE, name: LIVE_NAME, parent: MGR, testAccount: false });
  fake.accessible = [MGR];
  const auth = new ServiceAccountAuth(fake.serviceAccountKey(), fake.fetch);
  const builder = new GoogleAdsClient({ auth, apiVersion: 'v26', loginCustomerId: MGR, fetchImpl: fake.fetch, sleep: async () => undefined });
  await seedAccount(builder, LIVE);
  fake.account(LIVE).events.length = 0; // people built these campaigns, not the robot
  const served = await fake.listen();
  return { fake, served };
}


// ---------- the Worker in wrangler dev ----------

export const SETUP_CODE = 'K7QM-4XPA-9RTD';

/**
 * Starts everything and returns the address. The Worker settings are the real
 * ones minus the public-internet-only fetch flag (this run talks to servers on
 * 127.0.0.1) and with a fixed local KV namespace.
 */
export async function startCloud({ log = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-cloud-'));
  const port = await freePort();
  const BASE = `http://localhost:${port}`;
  const IMPORT_TOKEN = crypto.randomBytes(24).toString('base64url');
  const push = pushService();
  const subscription = await push.start();
  const google = await fakeGoogle();
  const history = await laptopHistory();
  const configName = `wrangler.e2e-${port}.jsonc`;

  const baseConfig = fs.readFileSync(path.join(root, 'cloud', 'wrangler.base.jsonc'), 'utf8');
  const devConfig = baseConfig
    .replace('"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]', '"compatibility_flags": ["nodejs_compat"]')
    .replace('"kv_namespaces": [{ "binding": "OAUTH_KV" }]', '"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "e2e-oauth" }]');
  assert.notEqual(devConfig, baseConfig, 'cloud/wrangler.base.jsonc changed shape; update test/e2e/harness.mjs');
  fs.writeFileSync(path.join(root, 'cloud', configName), devConfig);

  const vapid = await generateVapidKeys();
  const settings = { managerId: '555-000-1111', apiVersion: 'v26', accounts: [{ id: LIVE_D, name: LIVE_NAME, currency: 'USD', timezone: 'America/Chicago', testAccount: false }] };
  const vars = {
    SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
    SETUP_CODE: JSON.stringify({ hash: crypto.createHash('sha256').update(`campaign-ops-setup:${SETUP_CODE.replace(/[^A-Z0-9]/g, '')}`).digest('base64url'), expiresAt: Date.now() + 3_600_000, epoch: 'e2e-1' }),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: JSON.stringify(vapid.privateKey),
    IMPORT_TOKEN,
    GOOGLE_ADS_KEY: JSON.stringify(google.fake.serviceAccountKey()),
    GOOGLE_ADS_SETTINGS: JSON.stringify(settings),
    GOOGLE_ADS_API_BASE_URL: google.served.url,
    ALLOW_INSECURE_TEST_ENDPOINTS: '1',
  };
  const envFile = path.join(base, 'e2e.env');
  fs.writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n'));

  const wranglerJs = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const child = spawn(process.execPath, [wranglerJs, 'dev', '-c', configName, '--port', String(port), '--ip', '127.0.0.1', '--persist-to', path.join(base, 'state'), '--env-file', envFile, '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', log ? 'info' : 'warn'], { cwd: path.join(root, 'cloud'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
    if (log) process.stdout.write(d);
  });
  child.stderr.on('data', (d) => {
    output += d;
    if (log) process.stderr.write(d);
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  const stop = async () => {
    child.kill();
    await push.close().catch(() => undefined);
    await google.served.close().catch(() => undefined);
    fs.rmSync(path.join(root, 'cloud', configName), { force: true });
    fs.rmSync(base, { recursive: true, force: true });
  };
  try {
    await waitFor('wrangler dev', async () => {
      if (exited) throw new Error(`wrangler dev stopped:\n${output}`);
      try {
        return (await fetch(`${BASE}/mode`)).ok;
      } catch {
        return false;
      }
    }, 90_000);
  } catch (e) {
    await stop();
    throw e;
  }
  return { BASE, port, IMPORT_TOKEN, push, subscription, google, history, stop, output: () => output };
}
