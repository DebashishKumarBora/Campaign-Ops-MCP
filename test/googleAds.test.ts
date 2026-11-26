import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeGoogleAds } from './fakeGoogleAds.js';
import { ServiceAccountAuth, signJwt } from '../src/backends/googleAds/auth.js';
import { GoogleAdsClient } from '../src/backends/googleAds/client.js';
import { GoogleAdsBackend } from '../src/backends/googleAds/backend.js';
import { explain, GoogleAdsApiError } from '../src/backends/googleAds/errors.js';
import { seedAccount } from '../src/backends/googleAds/seeder.js';
import { loadGoogleAdsBackend } from '../src/backends/googleAds/index.js';
import { saveSettings, type GoogleAdsSettings } from '../src/backends/googleAds/settings.js';
import { RouterBackend } from '../src/backends/router.js';
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { runDiagnostics } from '../src/governance/diagnostics.js';
import { DEFAULT_POLICY } from '../src/policy.js';

const MANAGER = '7248000350';
const CLIENT = '1112223333';
const ACCOUNT = '111-222-3333';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cops-gads-'));

function rig(opts: { clientIsTest?: boolean } = {}) {
  const fake = new FakeGoogleAds();
  fake.addCustomer({ id: MANAGER, name: 'Campaign Ops Lab', manager: true });
  fake.addCustomer({ id: CLIENT, name: 'Demo Apartments', parent: MANAGER, testAccount: opts.clientIsTest ?? true });
  fake.accessible = [MANAGER];
  const auth = new ServiceAccountAuth(fake.serviceAccountKey(), fake.fetch);
  const client = new GoogleAdsClient({ auth, apiVersion: 'v26', loginCustomerId: '724-800-0350', fetchImpl: fake.fetch, sleep: async () => undefined });
  const settings: GoogleAdsSettings = {
    keyFile: 'unused',
    managerId: '724-800-0350',
    apiVersion: 'v26',
    accounts: [{ id: ACCOUNT, name: 'Demo Apartments', currency: 'USD', timezone: 'America/Chicago', testAccount: true }],
  };
  const google = new GoogleAdsBackend({ settings, client, now: () => new Date('2026-11-21T12:00:00Z') });
  return { fake, auth, client, google, settings };
}

async function seeded() {
  const r = rig();
  await seedAccount(r.client, CLIENT);
  return r;
}

describe('robot login', () => {
  test('signs a JWT Google can verify, and reuses the access token', async () => {
    const { fake, auth } = rig();
    const jwt = signJwt(fake.serviceAccountKey(), Date.parse('2026-11-25T00:00:00Z'));
    const [h, c] = jwt.split('.').slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()));
    assert.equal(h.alg, 'RS256');
    assert.equal(h.kid, 'key-1');
    assert.equal(c.scope, 'https://www.googleapis.com/auth/adwords');
    assert.equal(c.exp - c.iat, 3600);
    assert.equal(await auth.accessToken(), 'fake-access-token');
    await Promise.all([auth.accessToken(), auth.accessToken()]);
    assert.equal(fake.tokenRequests, 1);
  });

  test('a damaged key is refused with a plain explanation', async () => {
    const { fake } = rig();
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const auth = new ServiceAccountAuth({ ...fake.serviceAccountKey(), private_key: other }, fake.fetch);
    await assert.rejects(auth.accessToken(), /Google refused the robot login/);
  });
});

describe('API client', () => {
  test('sends the right headers, no developer token, and pages through results', async () => {
    const { fake, client } = await seeded();
    fake.pageSize = 2;
    const rows = await client.search(CLIENT, "SELECT campaign.id FROM campaign WHERE campaign.status != 'REMOVED'");
    assert.equal(rows.length, 6);
    const searches = fake.requests.filter((r) => r.path.endsWith('googleAds:search'));
    const last = searches[searches.length - 1];
    assert.equal(last.path, `/v26/customers/${CLIENT}/googleAds:search`);
    assert.equal(last.headers['login-customer-id'], MANAGER);
    assert.equal(last.headers.authorization, 'Bearer fake-access-token');
    assert.equal(last.headers['developer-token'], undefined);
    assert.ok(searches.some((r) => r.body.page_token === '2'));
  });

  test('retries a busy search, but never resends a write', async () => {
    const { fake, client } = rig();
    fake.injected.push({ status: 503, body: { error: { code: 503, message: 'busy', status: 'UNAVAILABLE' } } });
    const rows = await client.search(CLIENT, 'SELECT customer.id FROM customer LIMIT 1');
    assert.equal(rows.length, 1);
    fake.injected.push({ status: 500, body: { error: { code: 500, message: 'internal', status: 'INTERNAL' } } });
    const before = fake.mutations().length;
    await assert.rejects(client.mutate(CLIENT, 'campaignBudgets', [{ create: { name: 'x', amountMicros: '1000000' } }]), GoogleAdsApiError);
    assert.equal(fake.mutations().length, before + 1);
  });

  test('explains a real account that a Test-access project cannot touch', async () => {
    const { fake, client } = rig();
    fake.production.add(MANAGER);
    const err = await client.search(MANAGER, 'SELECT customer.id FROM customer').catch((e) => e);
    assert.ok(err instanceof GoogleAdsApiError);
    assert.ok(err.has('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'));
    assert.match(explain(err), /real \(production\) Google Ads account/);
    assert.match(explain(err), /fake-request-1/);
  });
});

describe('building the sample campaigns', () => {
  test('mirrors the sandbox account and is safe to run twice', async () => {
    const { fake, client } = rig();
    const first = await seedAccount(client, CLIENT);
    assert.equal(first.created.length, 6);
    assert.deepEqual(first.warnings, []);
    const a = fake.account(CLIENT);
    assert.equal(a.campaigns.size, 6);
    assert.equal(a.ads.size, 5);
    assert.ok([...a.campaigns.values()].every((c) => c.eu === 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'));
    assert.equal([...a.criteria.values()].length, 2);
    const second = await seedAccount(client, CLIENT);
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 6);
    const fresh = await seedAccount(client, CLIENT, { fresh: true });
    assert.equal(fresh.removed.length, 6);
    assert.equal(fresh.created.length, 6);
  });
});

describe('Google Ads backend', () => {
  test('reads campaigns, ads and negatives from Google, with simulated performance', async () => {
    const { google } = await seeded();
    const campaigns = await google.listCampaigns(ACCOUNT);
    assert.equal(campaigns.length, 6);
    const northlight = campaigns.find((c) => c.name === 'Northlight Lofts | Search | Generic')!;
    assert.equal(northlight.dailyBudget, 40);
    assert.equal(northlight.community, 'Northlight Lofts');
    assert.equal(campaigns.find((c) => c.channel === 'DISPLAY')!.name, 'Ashgrove Commons | Display | Prospecting');
    const ads = await google.listAds(ACCOUNT);
    assert.equal(ads.length, 5);
    assert.ok(ads.some((a) => a.headlines.includes('Ideal for Young Professionals')));
    const juniper = campaigns.find((c) => c.name === 'Juniper Yard | Search | Generic')!;
    assert.deepEqual(await google.listNegatives(ACCOUNT, juniper.id), [{ text: 'craigslist', matchType: 'PHRASE' }]);
    const metrics = await google.getDailyMetrics(ACCOUNT, northlight.id, 30);
    assert.equal(metrics.length, 30);
    const terms = await google.getSearchTerms(ACCOUNT, { campaignId: juniper.id, days: 30 });
    assert.ok(terms.some((t) => t.term === 'apartment jobs' && t.campaignId === juniper.id));
  });

  test('the agent finds the same planted problems as in the sandbox', async () => {
    const { google } = await seeded();
    const report = await runDiagnostics(google, DEFAULT_POLICY, ACCOUNT, 30);
    const kinds = new Set(report.findings.map((f) => f.kind));
    for (const k of ['ad_copy_compliance', 'wasted_spend', 'zero_conversion_campaign', 'budget_limited_winner']) assert.ok(kinds.has(k as never), k);
    assert.match(report.notes[0], /simulated/);
  });

  test('refuses every change, even a dry run, when an account saved as a test account is live', async () => {
    const { fake, google } = await seeded();
    // Google answers the "is this a test account?" read with false (omitted, as proto3 JSON does)
    const real = fake.handle.bind(fake);
    fake.handle = (m, u, h, b) => (b.includes('customer.test_account') ? { status: 200, body: { results: [{ customer: { id: CLIENT } }] } } : real(m, u, h, b));
    const campaigns = await google.listCampaigns(ACCOUNT);
    const before = fake.mutations().length;
    const res = await google.mutate(ACCOUNT, { type: 'set_campaign_status', campaignId: campaigns[0].id, newStatus: 'PAUSED' }, { validateOnly: true });
    assert.equal(res.ok, false);
    assert.match(res.errors[0], /live Google Ads account, not a test account/);
    assert.match(res.errors[0], /npm run gads:add/);
    assert.equal(fake.mutations().length, before);
  });
});

describe('full approval flow on a Google Ads test account', () => {
  let r: Awaited<ReturnType<typeof seeded>>;
  let engine: Engine;
  let router: RouterBackend;
  let dir: string;

  before(async () => {
    r = await seeded();
    dir = tmp();
    const sandbox = new SandboxBackend(path.join(dir, 'sandbox.json'));
    sandbox.ensure({ endDate: '2026-11-20' });
    router = new RouterBackend([sandbox, r.google]);
    engine = new Engine({ backend: router, dataDir: dir, policy: DEFAULT_POLICY, scope: 'execute' });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const campaign = async (name: string) => (await router.listCampaigns(ACCOUNT)).find((c) => c.name === name)!;
  const person = { by: 'Deb', channel: 'console' as const };

  test('both accounts are listed with their modes', async () => {
    const accounts = await router.listAccounts();
    assert.deepEqual(accounts.map((a) => [a.id, a.mode]), [['123-456-7890', 'sandbox'], [ACCOUNT, 'google_ads_test']]);
  });

  test('budget raise: dry run writes nothing, approval applies it in Google and verifies', async () => {
    const c = await campaign('Northlight Lofts | Search | Generic');
    const p = await engine.propose({ accountId: ACCOUNT, change: { type: 'set_campaign_budget', campaignId: c.id, newDailyBudget: 48 }, reason: 'Converts well but loses impression share to budget every day.', requestedBy: 'agent' });
    assert.equal(p.status, 'pending_approval');
    const dry = r.fake.mutations().at(-1)!;
    assert.equal(dry.body.validateOnly, true);
    assert.equal(dry.body.operations[0].updateMask, 'amount_micros');
    assert.equal(dry.body.operations[0].update.amountMicros, '48000000');
    assert.equal((await campaign('Northlight Lofts | Search | Generic')).dailyBudget, 40);
    await engine.approve(p.id, person);
    const out = await engine.apply(p.id, { actor: 'agent' });
    assert.equal(out.status, 'applied');
    assert.equal(out.proposal!.verification!.status, 'passed');
    assert.equal((await campaign('Northlight Lofts | Search | Generic')).dailyBudget, 48);
  });

  test('Fair Housing still blocks excluding a protected search', async () => {
    const c = await campaign('Juniper Yard | Search | Generic');
    const p = await engine.propose({ accountId: ACCOUNT, change: { type: 'add_negative_keywords', campaignId: c.id, keywords: [{ text: 'wheelchair accessible apartments', matchType: 'PHRASE' }] }, reason: 'Zero conversions from this search in 30 days.', requestedBy: 'agent' });
    assert.equal(p.status, 'blocked');
    assert.ok(p.checks.some((k) => k.id === 'fair_housing_negatives' && k.status === 'fail'));
    assert.deepEqual((await router.listNegatives(ACCOUNT, c.id)).map((n) => n.text), ['craigslist']);
  });

  test('negatives are added, then undone with one approval', async () => {
    const c = await campaign('Juniper Yard | Search | Generic');
    const p = await engine.propose({ accountId: ACCOUNT, change: { type: 'add_negative_keywords', campaignId: c.id, keywords: [{ text: 'apartment jobs', matchType: 'PHRASE' }, { text: 'storage units near me', matchType: 'PHRASE' }] }, reason: 'These searches spent money with zero leads.', requestedBy: 'agent' });
    assert.equal(p.status, 'pending_approval');
    await engine.approve(p.id, person);
    assert.equal((await engine.apply(p.id, { actor: 'agent' })).status, 'applied');
    assert.equal((await router.listNegatives(ACCOUNT, c.id)).length, 3);
    const undo = await engine.undoNow(p.id, 'Deb');
    assert.equal(undo.outcome?.status, 'applied');
    assert.deepEqual((await router.listNegatives(ACCOUNT, c.id)).map((n) => n.text), ['craigslist']);
  });

  test('the Fair Housing ad fix goes to Google as an in-place ad update', async () => {
    const ad = (await router.listAds(ACCOUNT)).find((a) => a.headlines.includes('Ideal for Young Professionals'))!;
    const p = await engine.propose({
      accountId: ACCOUNT,
      change: { type: 'update_ad_text', adId: ad.id, headlines: ['Ashgrove Commons', 'Resort-Style Pool Community', 'Downtown Studios and 1 Beds', 'Book a Tour Today'], descriptions: ['Studios and 1 bedrooms near downtown with a resort-style pool. Schedule a tour today.', 'Studios and 1 bedrooms with modern finishes. Schedule your tour today.'] },
      reason: 'Removes age-signaling and adults-only wording that Fair Housing rules do not allow.',
      requestedBy: 'agent',
    });
    assert.equal(p.status, 'pending_approval');
    await engine.approve(p.id, person);
    assert.equal((await engine.apply(p.id, { actor: 'agent' })).status, 'applied');
    const write = r.fake.mutations().filter((m) => m.path.endsWith('/ads:mutate') && !m.body.validateOnly).at(-1)!;
    assert.equal(write.body.operations[0].update.resourceName, `customers/${CLIENT}/ads/${ad.id}`);
    assert.ok(!(await router.getAd(ACCOUNT, ad.id))!.headlines.includes('Ideal for Young Professionals'));
  });

  test('pausing the campaign that never converts', async () => {
    const c = await campaign('Ashgrove Commons | Display | Prospecting');
    const p = await engine.propose({ accountId: ACCOUNT, change: { type: 'set_campaign_status', campaignId: c.id, newStatus: 'PAUSED' }, reason: 'It spends every day and has produced no leads in 30 days.', requestedBy: 'agent' });
    await engine.approve(p.id, person);
    assert.equal((await engine.apply(p.id, { actor: 'agent' })).status, 'applied');
    assert.equal((await campaign('Ashgrove Commons | Display | Prospecting')).status, 'PAUSED');
  });

  test('someone editing the budget in Google Ads first causes a conflict, not an overwrite', async () => {
    const c = await campaign('Juniper Yard | Search | Brand');
    const p = await engine.propose({ accountId: ACCOUNT, change: { type: 'set_campaign_budget', campaignId: c.id, newDailyBudget: 33 }, reason: 'Small test of a higher brand budget.', requestedBy: 'agent' });
    await engine.approve(p.id, person);
    const a = r.fake.account(CLIENT);
    const budget = a.budgets.get(a.campaigns.get(c.id)!.budget)!;
    budget.amountMicros = 31_000_000; // edited in the Google Ads UI
    const out = await engine.apply(p.id, { actor: 'agent' });
    assert.equal(out.status, 'conflict');
    assert.equal(budget.amountMicros, 31_000_000);
  });
});

describe('turning the connection on', () => {
  test('off by default, on after setup saves an account, and off when switched off', () => {
    const dir = tmp();
    try {
      const env = { CAMPAIGN_OPS_SECRETS_DIR: dir } as NodeJS.ProcessEnv;
      assert.equal(loadGoogleAdsBackend(env).status, 'not_set_up');
      const fake = new FakeGoogleAds();
      fs.writeFileSync(path.join(dir, 'google-ads-key.json'), JSON.stringify(fake.serviceAccountKey()));
      saveSettings({ keyFile: path.join(dir, 'google-ads-key.json'), managerId: MANAGER, apiVersion: 'v26', accounts: [{ id: CLIENT, name: 'Demo Apartments', currency: 'USD', timezone: 'America/Chicago', testAccount: true }] }, env);
      const ready = loadGoogleAdsBackend(env);
      assert.equal(ready.status, 'ready');
      assert.equal(ready.backend?.mode, 'google_ads_test');
      assert.equal(loadGoogleAdsBackend({ ...env, CAMPAIGN_OPS_GOOGLE_ADS: 'off' }).status, 'off');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('npm run gads:check and gads:setup', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const script = (name: string) => path.join(root, 'dist', 'scripts', `${name}.js`);

  async function runScript(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script(name), ...args], { env, cwd: root });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  test('check, then setup creates the test account, builds campaigns and saves the connection', async () => {
    const fake = new FakeGoogleAds();
    const server = await fake.listen();
    const dir = tmp();
    const data = tmp();
    try {
      fake.addCustomer({ id: MANAGER, name: 'Campaign Ops Lab', manager: true });
      fake.accessible = [MANAGER];
      fs.writeFileSync(path.join(dir, 'google-ads-key.json'), JSON.stringify(fake.serviceAccountKey()));
      const env = { ...process.env, CAMPAIGN_OPS_SECRETS_DIR: dir, CAMPAIGN_OPS_DATA_DIR: data, GOOGLE_ADS_API_BASE_URL: server.url, GOOGLE_ADS_KEY_FILE: '', GOOGLE_ADS_SETUP_POLL_MS: '50' };

      const missing = await runScript('gads-check', [], env);
      assert.equal(missing.code, 1);
      assert.match(missing.out, /test manager account number/);

      const check = await runScript('gads-check', ['724-800-0350'], env);
      assert.equal(check.code, 0, check.out);
      assert.match(check.out, /Google confirms 724-800-0350 "Campaign Ops Lab" is a TEST manager account/);

      const setup = await runScript('gads-setup', [], env);
      assert.equal(setup.code, 0, setup.out);
      assert.match(setup.out, /Created \d{3}-\d{3}-\d{4} "Demo Apartments"/);
      assert.match(setup.out, /6 campaigns created/);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'google-ads.json'), 'utf8'));
      assert.equal(saved.managerId, '724-800-0350');
      assert.equal(saved.accounts.length, 1);
      assert.equal(saved.accounts[0].testAccount, true);
      const audit = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const setupEntry = audit.find((e) => e.type === 'setup_changes');
      assert.ok(setupEntry, 'the setup run is noted in the audit log for the witness check');
      assert.equal(setupEntry.details.accountId, saved.accounts[0].id);
      assert.equal(setupEntry.details.changes, 6, 'six campaigns built');

      const again = await runScript('gads-setup', [], env);
      assert.equal(again.code, 0, again.out);
      assert.match(again.out, /already there/);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  test('a real (production) manager account is refused with clear next steps', async () => {
    const fake = new FakeGoogleAds();
    const server = await fake.listen();
    const dir = tmp();
    const data = tmp();
    try {
      fake.addCustomer({ id: MANAGER, name: 'Campaign Ops Lab', manager: true, testAccount: false });
      fake.accessible = [MANAGER];
      fs.writeFileSync(path.join(dir, 'google-ads-key.json'), JSON.stringify(fake.serviceAccountKey()));
      const env = { ...process.env, CAMPAIGN_OPS_SECRETS_DIR: dir, CAMPAIGN_OPS_DATA_DIR: data, GOOGLE_ADS_API_BASE_URL: server.url, GOOGLE_ADS_KEY_FILE: '', GOOGLE_ADS_SETUP_POLL_MS: '50' };
      const res = await runScript('gads-check', ['724-800-0350'], env);
      assert.equal(res.code, 1);
      assert.match(res.out, /is a REAL account, not a test account/);
      assert.match(res.out, /Nothing was changed in Google Ads/);
      assert.equal(fake.mutations().length, 0);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  test('a robot that was never added to the account gets the exact fix', async () => {
    const fake = new FakeGoogleAds();
    const server = await fake.listen();
    const dir = tmp();
    const data = tmp();
    try {
      fake.addCustomer({ id: MANAGER, name: 'Campaign Ops Lab', manager: true });
      fake.accessible = [];
      fs.writeFileSync(path.join(dir, 'google-ads-key.json'), JSON.stringify(fake.serviceAccountKey()));
      const env = { ...process.env, CAMPAIGN_OPS_SECRETS_DIR: dir, CAMPAIGN_OPS_DATA_DIR: data, GOOGLE_ADS_API_BASE_URL: server.url, GOOGLE_ADS_KEY_FILE: '', GOOGLE_ADS_SETUP_POLL_MS: '50' };
      const res = await runScript('gads-check', ['724-800-0350'], env);
      assert.equal(res.code, 1);
      assert.match(res.out, /The robot cannot see account 724-800-0350 yet/);
      assert.match(res.out, /campaign-ops-agent@campaign-ops-test\.iam\.gserviceaccount\.com/);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});

void spawnSync;
