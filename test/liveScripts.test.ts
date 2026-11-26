import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FakeGoogleAds } from './fakeGoogleAds.js';
import { ServiceAccountAuth } from '../src/backends/googleAds/auth.js';
import { GoogleAdsClient } from '../src/backends/googleAds/client.js';
import { seedAccount } from '../src/backends/googleAds/seeder.js';
import { loadGoogleAdsBackend } from '../src/backends/googleAds/index.js';
import { saveSettings } from '../src/backends/googleAds/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = (name: string) => path.join(root, 'dist', 'scripts', `${name}.js`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cops-scripts-'));
const MGR = '5550001111';
const LIVE = '5550002222';

function runScript(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script(name), ...args], { env, cwd: root });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function world(opts: { access: 'test' | 'explorer'; accessible: string[] }) {
  const fake = new FakeGoogleAds();
  fake.accessLevel = opts.access;
  fake.addCustomer({ id: MGR, name: 'Acme Agency', manager: true, testAccount: false });
  fake.addCustomer({ id: LIVE, name: 'Acme Apartments', parent: MGR, testAccount: false });
  const server = await fake.listen();
  if (opts.access === 'explorer') {
    fake.accessible = [MGR];
    const builder = new GoogleAdsClient({ auth: new ServiceAccountAuth(fake.serviceAccountKey(), fake.fetch), apiVersion: 'v26', loginCustomerId: MGR, fetchImpl: fake.fetch, sleep: async () => undefined });
    await seedAccount(builder, LIVE);
    const id = [...fake.account(LIVE).campaigns.values()][0].id;
    const today = new Date().toISOString().slice(0, 10);
    const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    fake.setDailyMetrics(LIVE, id, [1, 2, 3].map((n) => ({ date: day(n), impressions: 300, clicks: 30, cost: 61.5, conversions: 2 })));
  }
  fake.accessible = opts.accessible;
  const secrets = tmp();
  const data = tmp();
  fs.writeFileSync(path.join(secrets, 'google-ads-key.json'), JSON.stringify(fake.serviceAccountKey()));
  const env = { ...process.env, CAMPAIGN_OPS_SECRETS_DIR: secrets, CAMPAIGN_OPS_DATA_DIR: data, GOOGLE_ADS_API_BASE_URL: server.url, GOOGLE_ADS_KEY_FILE: '', CAMPAIGN_OPS_GOOGLE_ADS: '' };
  return {
    fake,
    env,
    secrets,
    data,
    settings: () => JSON.parse(fs.readFileSync(path.join(secrets, 'google-ads.json'), 'utf8')),
    close: async () => {
      await server.close();
      fs.rmSync(secrets, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    },
  };
}

describe('npm run gads:add', () => {
  test('waits for Explorer access with a plain explanation, and changes nothing', async () => {
    const w = await world({ access: 'test', accessible: [MGR] });
    try {
      const res = await runScript('gads-add', ['555-000-2222'], w.env);
      assert.equal(res.code, 1, res.out);
      assert.match(res.out, /Google has not approved your Cloud project for real accounts yet/);
      assert.match(res.out, /Explorer access/);
      assert.match(res.out, /Nothing was changed in Google Ads/);
      assert.equal(w.fake.mutations().length, 0);
      assert.ok(!fs.existsSync(path.join(w.secrets, 'google-ads.json')));
    } finally {
      await w.close();
    }
  });

  test('connects a live account through its manager, read-only, and shows real numbers', async () => {
    const w = await world({ access: 'explorer', accessible: [MGR] });
    try {
      const writesBefore = w.fake.writes().length;
      const res = await runScript('gads-add', ['555-000-2222'], w.env);
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /The robot can reach 555-000-2222 through the manager account 555-000-1111/);
      assert.match(res.out, /Google confirms 555-000-2222 "Acme Apartments" is a LIVE ad account/);
      assert.match(res.out, /Read 6 campaigns \(\d+ running\)/);
      assert.match(res.out, /\$184\.50 spent, 90 clicks, 6 conversions/);
      assert.match(res.out, /Nothing can change in it until a person opens a change window/);
      assert.equal(w.fake.writes().length, writesBefore, 'connecting writes nothing');
      const saved = w.settings();
      assert.deepEqual(saved.accounts.map((a: Record<string, unknown>) => [a.id, a.testAccount, a.loginCustomerId]), [['555-000-2222', false, '555-000-1111']]);

      const loaded = loadGoogleAdsBackend(w.env);
      assert.equal(loaded.status, 'ready');
      assert.equal(loaded.backend?.mode, 'google_ads');
      assert.match(loaded.message, /live, read-only until a change window is opened/);

      const list = await runScript('gads-add', ['--list'], w.env);
      assert.match(list.out, /555-000-2222 {2}Acme Apartments {2}\(LIVE, read-only until a change window is opened\)/);

      const removed = await runScript('gads-add', ['--remove', '555-000-2222'], w.env);
      assert.equal(removed.code, 0, removed.out);
      assert.match(removed.out, /Disconnected Acme Apartments/);
      assert.deepEqual(w.settings().accounts, []);
    } finally {
      await w.close();
    }
  });

  test('uses the account itself as the login when the robot was added to it directly', async () => {
    const w = await world({ access: 'explorer', accessible: [LIVE] });
    try {
      const res = await runScript('gads-add', ['5550002222'], w.env);
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /The robot was added to 555-000-2222 directly/);
      assert.equal(w.settings().accounts[0].loginCustomerId, '555-000-2222');
    } finally {
      await w.close();
    }
  });

  test('a robot that cannot see the account gets the exact steps, Read only first', async () => {
    const w = await world({ access: 'explorer', accessible: [] });
    try {
      const res = await runScript('gads-add', ['555-000-2222'], w.env);
      assert.equal(res.code, 1);
      assert.match(res.out, /The robot cannot see account 555-000-2222 yet/);
      assert.match(res.out, /campaign-ops-agent@campaign-ops-test\.iam\.gserviceaccount\.com/);
      assert.match(res.out, /Safest start: choose Read only/);
    } finally {
      await w.close();
    }
  });

  test('a manager account number lists the ad accounts inside it', async () => {
    const w = await world({ access: 'explorer', accessible: [MGR] });
    try {
      const res = await runScript('gads-add', ['555-000-1111'], w.env);
      assert.equal(res.code, 1);
      assert.match(res.out, /is a manager account/);
      assert.match(res.out, /555-000-2222 {2}Acme Apartments/);
      assert.match(res.out, /npm run gads:add -- 555-000-2222/);
    } finally {
      await w.close();
    }
  });
});

describe('npm run reset', () => {
  test('keeps the record of real Google Ads changes unless asked with --all', async () => {
    const fake = new FakeGoogleAds();
    const secrets = tmp();
    const data = tmp();
    try {
      const env = { ...process.env, CAMPAIGN_OPS_SECRETS_DIR: secrets, CAMPAIGN_OPS_DATA_DIR: data, GOOGLE_ADS_KEY_FILE: '', CAMPAIGN_OPS_GOOGLE_ADS: '' };
      fs.writeFileSync(path.join(data, 'proposals.json'), '{"proposals":[]}');
      fs.writeFileSync(path.join(data, 'audit.jsonl'), '');

      const plain = await runScript('reset', [], env);
      assert.equal(plain.code, 0, plain.out);
      assert.match(plain.out, /Proposals, audit log, change windows and kill switch cleared/);
      assert.ok(!fs.existsSync(path.join(data, 'proposals.json')), 'no Google Ads account: everything is cleared');

      fs.writeFileSync(path.join(secrets, 'google-ads-key.json'), JSON.stringify(fake.serviceAccountKey()));
      saveSettings({ keyFile: path.join(secrets, 'google-ads-key.json'), managerId: '724-800-0350', apiVersion: 'v26', accounts: [{ id: '605-373-1925', name: 'Demo Apartments', currency: 'USD', timezone: 'America/Chicago', testAccount: true }] }, env);
      fs.writeFileSync(path.join(data, 'proposals.json'), '{"proposals":[]}');
      const kept = await runScript('reset', [], env);
      assert.equal(kept.code, 0, kept.out);
      assert.match(kept.out, /Proposals and the audit log were kept, because a Google Ads account is connected/);
      assert.ok(fs.existsSync(path.join(data, 'proposals.json')));

      const all = await runScript('reset', ['--all'], env);
      assert.equal(all.code, 0, all.out);
      assert.match(all.out, /the witness check will flag those changes as not approved/);
      assert.ok(!fs.existsSync(path.join(data, 'proposals.json')));
    } finally {
      fs.rmSync(secrets, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});
