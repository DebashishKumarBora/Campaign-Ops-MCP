import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCloud, type CloudContext } from '../scripts/cloud.js';
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { DEFAULT_POLICY } from '../src/config.js';

/**
 * npm run cloud:setup against a stand-in for Cloudflare: a fake Wrangler that
 * records every command (and creates the OAuth store on first deploy, like the
 * real one), and a fake Worker that answers the setup check and the history move.
 */

const FAKE_WRANGLER = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_CF_DIR;
const args = process.argv.slice(2);
const secretsFile = path.join(dir, 'secrets.json');
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {};
const log = (entry) => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(entry) + '\\n');
const cmd = args.join(' ');
if (cmd === 'whoami') {
  log({ cmd });
  console.log('You are logged in with an OAuth Token, associated with the email deb@example.com.');
} else if (cmd === 'deploy') {
  const cfgPath = path.join(process.cwd(), 'wrangler.jsonc');
  let cfg = fs.readFileSync(cfgPath, 'utf8');
  log({ cmd, config: cfg });
  if (!cfg.includes('"id"')) {
    cfg = cfg.replace('{ "binding": "OAUTH_KV" }', '{ "binding": "OAUTH_KV", "id": "aaaabbbbccccddddeeeeffff00001111" }');
    fs.writeFileSync(cfgPath, cfg);
  }
  console.log('Total Upload: 1931.18 KiB / gzip: 365.97 KiB');
  console.log('Deployed campaign-ops triggers (1.02 sec)');
  console.log('  https://campaign-ops.deb-test.workers.dev');
  console.log('  schedule: 17 * * * *');
} else if (cmd === 'secret list --format json') {
  log({ cmd });
  console.log(JSON.stringify(Object.keys(secrets).map((name) => ({ name, type: 'secret_text' }))));
} else if (cmd === 'secret bulk') {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const body = JSON.parse(input);
    log({ cmd, keys: Object.keys(body) });
    for (const [k, v] of Object.entries(body)) {
      if (v === null) delete secrets[k];
      else secrets[k] = v;
    }
    fs.writeFileSync(secretsFile, JSON.stringify(secrets));
    console.log('Finished processing secrets file: ' + Object.keys(body).length + ' secrets successfully uploaded');
  });
} else {
  log({ cmd });
  process.exit(1);
}
`;

async function laptop(root: string): Promise<number> {
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const sandbox = new SandboxBackend(path.join(data, 'sandbox.json'));
  sandbox.ensure();
  const engine = new Engine({ backend: sandbox, dataDir: data, policy: DEFAULT_POLICY, scope: 'execute' });
  const account = (await sandbox.listAccounts())[0];
  const c = (await sandbox.listCampaigns(account.id)).find((x) => x.status === 'ENABLED')!;
  const p = await engine.propose({ accountId: account.id, change: { type: 'set_campaign_budget', campaignId: c.id, newDailyBudget: c.dailyBudget + 2 }, reason: 'History made on the laptop before the move.', requestedBy: 'agent (laptop)' });
  await engine.approve(p.id, { by: 'Deb (console)', channel: 'console' });
  await engine.apply(p.id, { actor: 'agent (laptop)' });
  return fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').length;
}

test('npm run cloud:setup, cloud:code and cloud:deploy against a stand-in for Cloudflare', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-setup-'));
  try {
    fs.mkdirSync(path.join(root, 'cloud'));
    fs.copyFileSync(path.join(process.cwd(), 'cloud', 'wrangler.base.jsonc'), path.join(root, 'cloud', 'wrangler.base.jsonc'));
    const fakeDir = path.join(root, 'fake-cf');
    fs.mkdirSync(fakeDir);
    fs.writeFileSync(path.join(fakeDir, 'wrangler.cjs'), FAKE_WRANGLER);
    const entries = await laptop(root);
    // The robot key and settings live outside the project, as on Deb's computer.
    const secretsDir = path.join(root, 'campaign-ops-secrets');
    fs.mkdirSync(secretsDir);
    const key = JSON.stringify({ type: 'service_account', client_email: 'robot@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', token_uri: 'https://oauth2.googleapis.com/token' });
    fs.writeFileSync(path.join(secretsDir, 'google-ads-key.json'), key);
    fs.writeFileSync(path.join(secretsDir, 'google-ads.json'), JSON.stringify({ managerId: '111-222-3333', apiVersion: 'v26', accounts: [{ id: '444-555-6666', name: 'Demo Apartments', currency: 'USD', timezone: 'America/Chicago', testAccount: true }] }));

    const imports: Array<{ auth: string; body: { audit: string; proposals: string; sandbox: string } }> = [];
    const lines: string[] = [];
    const secrets = () => JSON.parse(fs.readFileSync(path.join(fakeDir, 'secrets.json'), 'utf8')) as Record<string, string>;
    const calls = () => fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cmd: string; keys?: string[]; config?: string });
    const ctx: CloudContext = {
      root,
      wranglerJs: path.join(fakeDir, 'wrangler.cjs'),
      env: { ...process.env, FAKE_CF_DIR: fakeDir, CAMPAIGN_OPS_SECRETS_DIR: secretsDir, CAMPAIGN_OPS_DATA_DIR: '' },
      print: (l) => lines.push(l),
      passthrough: () => undefined,
      pollMs: 1,
      fetch: async (url, init) => {
        if (url === 'https://campaign-ops.deb-test.workers.dev/auth/session') return Response.json({ setupOpen: true });
        if (url === 'https://campaign-ops.deb-test.workers.dev/admin/import') {
          const auth = String((init?.headers as Record<string, string>).Authorization);
          const body = JSON.parse(String(init?.body));
          imports.push({ auth, body });
          // The first try reaches a Cloudflare location that has not seen the new key yet.
          if (imports.length === 1 || auth !== `Bearer ${secrets().IMPORT_TOKEN}`) return Response.json({ error: 'Wrong or missing import token.' }, { status: 401 });
          return Response.json({ ok: true, entries: body.audit.trim().split('\n').length, proposals: JSON.parse(body.proposals).proposals.length });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    };

    // First run
    assert.equal(await runCloud('setup', [], ctx), 0, lines.join('\n'));
    const out = lines.join('\n');
    assert.match(out, /Signed in to Cloudflare as deb@example\.com/);
    assert.match(out, /Live at https:\/\/campaign-ops\.deb-test\.workers\.dev/);
    assert.match(out, new RegExp(`Moved your history to the cloud: 1 proposals and ${entries} audit entries`));
    assert.match(out, /URL: https:\/\/campaign-ops\.deb-test\.workers\.dev\/mcp/);
    const code = /^ {7}([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})$/m.exec(out)?.[1];
    assert.ok(code, 'the setup code is printed on its own line');
    const s = secrets();
    assert.deepEqual(Object.keys(s).sort(), ['GOOGLE_ADS_KEY', 'GOOGLE_ADS_SETTINGS', 'IMPORT_TOKEN', 'SESSION_SECRET', 'SETUP_CODE', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY']);
    assert.equal(s.GOOGLE_ADS_KEY, key, 'the key goes up exactly as it is on disk');
    assert.equal(JSON.parse(s.GOOGLE_ADS_SETTINGS).keyFile, undefined, 'no path from this computer goes up');
    assert.equal(JSON.parse(s.SETUP_CODE).hash, crypto.createHash('sha256').update(`campaign-ops-setup:${code!.replace(/-/g, '')}`).digest('base64url'));
    assert.equal(imports.length, 2, 'a refused first try is retried');
    assert.equal(imports[1].body.audit, fs.readFileSync(path.join(root, 'data', 'audit.jsonl'), 'utf8'));
    assert.ok(imports[1].body.sandbox.length > 1000, 'the sandbox comes along');
    assert.match(fs.readFileSync(path.join(root, 'cloud', 'wrangler.jsonc'), 'utf8'), /"id": "aaaabbbbccccddddeeeeffff00001111"/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'cloud', '.deployed.json'), 'utf8')).url, 'https://campaign-ops.deb-test.workers.dev');
    for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
      if (f.includes('fake-cf') || f.includes('campaign-ops-secrets')) continue;
      const text = fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), 'utf8') : '';
      assert.ok(!text.includes(s.SESSION_SECRET) && !text.includes('BEGIN PRIVATE KEY'), `a secret was written to ${f}`);
    }

    // Second run: session and notification keys are kept, history is not moved twice
    const firstSession = s.SESSION_SECRET;
    const firstVapid = s.VAPID_PUBLIC_KEY;
    lines.length = 0;
    assert.equal(await runCloud('setup', [], ctx), 0, lines.join('\n'));
    const bulk = calls().filter((c) => c.cmd === 'secret bulk').pop()!;
    assert.deepEqual(bulk.keys!.sort(), ['GOOGLE_ADS_KEY', 'GOOGLE_ADS_SETTINGS', 'IMPORT_TOKEN', 'SETUP_CODE']);
    assert.equal(secrets().SESSION_SECRET, firstSession);
    assert.equal(secrets().VAPID_PUBLIC_KEY, firstVapid);
    assert.equal(imports.length, 2);
    assert.match(lines.join('\n'), /history was moved earlier/);

    // A new setup code touches only the setup code
    lines.length = 0;
    assert.equal(await runCloud('code', [], ctx), 0, lines.join('\n'));
    assert.deepEqual(calls().filter((c) => c.cmd === 'secret bulk').pop()!.keys, ['SETUP_CODE']);
    assert.match(lines.join('\n'), /New setup code/);

    // An update keeps the OAuth store
    lines.length = 0;
    assert.equal(await runCloud('deploy', [], ctx), 0, lines.join('\n'));
    const lastDeploy = calls().filter((c) => c.cmd === 'deploy').pop()!;
    assert.match(lastDeploy.config!, /"id": "aaaabbbbccccddddeeeeffff00001111"/);

    // --no-google removes the Google secrets
    lines.length = 0;
    assert.equal(await runCloud('setup', ['--no-google'], ctx), 0, lines.join('\n'));
    assert.equal(secrets().GOOGLE_ADS_KEY, undefined);
    assert.equal(secrets().GOOGLE_ADS_SETTINGS, undefined);

    // Unknown command
    lines.length = 0;
    assert.equal(await runCloud('nope', [], ctx), 1);
    assert.match(lines.join('\n'), /Unknown command/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cloud:code before setup says what to run first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-setup-'));
  try {
    fs.mkdirSync(path.join(root, 'cloud'));
    const lines: string[] = [];
    const code = await runCloud('code', [], { root, wranglerJs: '/nowhere.js', env: {}, print: (l) => lines.push(l), passthrough: () => undefined, pollMs: 1, fetch: async () => new Response('') });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /not in the cloud yet[\s\S]*npm run cloud:setup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
