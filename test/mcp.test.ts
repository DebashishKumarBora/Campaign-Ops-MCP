import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { projectRoot } from '../src/util/root.js';
import { makeRig, tempDir, PERSON } from './helpers.js';

const SERVER = path.join(projectRoot(), 'dist', 'src', 'index.js');
const ACCOUNT = '123-456-7890';

type ElicitHandler = (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string> };

async function connect(dataDir: string, opts: { scope?: string; elicit?: ElicitHandler } = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...(process.env as Record<string, string>),
      CAMPAIGN_OPS_DATA_DIR: dataDir,
      CAMPAIGN_OPS_CONSOLE_PORT: '0',
      CAMPAIGN_OPS_SCOPE: opts.scope ?? 'execute',
      CAMPAIGN_OPS_KILL_SWITCH: '0',
      CAMPAIGN_OPS_POLICY_FILE: 'no-such-policy-file.json',
      // keep tests independent of a Google Ads connection on this computer
      CAMPAIGN_OPS_GOOGLE_ADS: 'off',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'campaign-ops-test', version: '1.0.0' }, { capabilities: opts.elicit ? { elicitation: { form: {} } } : {} });
  if (opts.elicit) {
    const handler = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (req) => handler((req.params as { message: string }).message));
  }
  await client.connect(transport);
  return client;
}

const made: string[] = [];
function freshDir(): string {
  const d = tempDir();
  made.push(d);
  return d;
}

after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function data(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent;
}

test('MCP: tools, diagnostics, proposal, and approval from another process', async () => {
  const dir = freshDir();
  const client = await connect(dir);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['apply_change', 'check_ad_copy', 'check_pulse', 'get_account_overview', 'get_ads', 'get_audit_log', 'get_autopilot_report', 'get_policy', 'get_proposal', 'get_search_terms', 'list_accounts', 'list_proposals', 'propose_change', 'request_autopilot_check', 'request_rollback', 'run_diagnostics', 'verify_with_google']);
    const apply = (await client.listTools()).tools.find((t) => t.name === 'apply_change')!;
    assert.equal(apply.annotations?.destructiveHint, true);

    const diag = data(await client.callTool({ name: 'run_diagnostics', arguments: { account_id: ACCOUNT } }));
    assert.equal(diag.findings.length, 5);
    assert.deepEqual(
      diag.protected_terms_not_negated.map((t: { term: string }) => t.term).sort(),
      ['family friendly apartments', 'section 8 apartments', 'wheelchair accessible apartments'],
    );
    const budgetFinding = diag.findings.find((f: { kind: string }) => f.kind === 'budget_limited_winner');

    const proposed = data(await client.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: budgetFinding.suggested_change, reason: budgetFinding.suggested_reason } }));
    assert.equal(proposed.status, 'pending_approval');

    const waiting = data(await client.callTool({ name: 'apply_change', arguments: { proposal_id: proposed.id } }));
    assert.equal(waiting.status, 'awaiting_approval');

    // A person approves through a separate process sharing the same data folder (like the console).
    const human = makeRig({ dir, realTime: true });
    await human.engine.approve(proposed.id, { by: PERSON, channel: 'console' });

    const applied = data(await client.callTool({ name: 'apply_change', arguments: { proposal_id: proposed.id } }));
    assert.equal(applied.status, 'applied');
    assert.equal(applied.verification, 'passed');

    const audit = data(await client.callTool({ name: 'get_audit_log', arguments: {} }));
    assert.equal(audit.chain.ok, true);

    const bad = await client.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: { type: 'set_campaign_budget', campaign_id: 'c-999', new_daily_budget: 10 }, reason: 'Testing an unknown campaign id here.' } });
    assert.equal((bad as { isError?: boolean }).isError, true);
  } finally {
    await client.close();
  }
});

test('MCP: read scope exposes no write tools', async () => {
  const client = await connect(freshDir(), { scope: 'read' });
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ['propose_change', 'apply_change', 'request_rollback', 'request_autopilot_check']) assert.ok(!tools.includes(name), `${name} must be hidden`);
    assert.ok(tools.includes('get_autopilot_report'), 'reading what Autopilot found is fine in read scope');
  } finally {
    await client.close();
  }
});

test('MCP: approval prompt (elicitation) approves or rejects in the chat app', async () => {
  let prompt = '';
  const approving = await connect(freshDir(), {
    elicit: (message) => {
      prompt = message;
      return { action: 'accept', content: { decision: 'Approve', note: 'ok from the prompt' } };
    },
  });
  try {
    const p = data(await approving.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: { type: 'set_campaign_budget', campaign_id: 'c-202', new_daily_budget: 50 }, reason: 'Best cost per lead and limited by budget.' } }));
    const out = data(await approving.callTool({ name: 'apply_change', arguments: { proposal_id: p.id } }));
    assert.equal(out.status, 'applied');
    assert.equal(out.proposal.approval.channel, 'elicitation');
    assert.match(prompt, /\$40\.00 → \$50\.00/);
  } finally {
    await approving.close();
  }

  const rejecting = await connect(freshDir(), { elicit: () => ({ action: 'accept', content: { decision: 'Reject' } }) });
  try {
    const p = data(await rejecting.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: { type: 'set_campaign_status', campaign_id: 'c-302', new_status: 'PAUSED' }, reason: 'Spent about $590 with zero leads.' } }));
    const out = data(await rejecting.callTool({ name: 'apply_change', arguments: { proposal_id: p.id } }));
    assert.equal(out.status, 'rejected');
  } finally {
    await rejecting.close();
  }
});

test('MCP: wait_seconds picks up a console approval while waiting', async () => {
  const dir = freshDir();
  const client = await connect(dir);
  try {
    const p = data(await client.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: { type: 'set_campaign_budget', campaign_id: 'c-202', new_daily_budget: 48 }, reason: 'Small step up for the best campaign.' } }));
    const human = makeRig({ dir, realTime: true });
    setTimeout(() => void human.engine.approve(p.id, { by: PERSON, channel: 'console' }), 1200);
    const started = Date.now();
    const out = data(await client.callTool({ name: 'apply_change', arguments: { proposal_id: p.id, wait_seconds: 10 } }));
    assert.equal(out.status, 'applied');
    assert.ok(Date.now() - started < 8000, 'returns soon after approval, not at the timeout');
  } finally {
    await client.close();
  }
});

function text(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
}

test('MCP: Pulse, the witness check, the stopgap pause and live-account rules', async () => {
  const client = await connect(freshDir());
  try {
    const pulse = data(await client.callTool({ name: 'check_pulse', arguments: { account_id: ACCOUNT } }));
    assert.equal(pulse.alarms.length, 1);
    assert.equal(pulse.alarms[0].kind, 'tracking_outage');

    const diag = data(await client.callTool({ name: 'run_diagnostics', arguments: { account_id: ACCOUNT } }));
    assert.equal(diag.findings.length, 5);
    assert.equal(diag.pulse_alarms.alarms.length, 1);
    const ad = diag.findings.find((f: { kind: string }) => f.kind === 'ad_copy_compliance');
    assert.deepEqual(ad.stopgap_change, { type: 'set_ad_status', ad_id: 'a-3011', new_status: 'PAUSED' });
    assert.ok(ad.stopgap_reason.length > 20);

    const pause = data(await client.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: ad.stopgap_change, reason: ad.stopgap_reason } }));
    assert.equal(pause.status, 'pending_approval');
    assert.equal(pause.type, 'Ad status change');
    assert.match(pause.summary, /^Pause ad a-3011 in Ashgrove Commons/);
    assert.deepEqual(pause.diff, [{ field: 'Ad a-3011 status', before: 'Enabled', after: 'Paused' }]);

    const witness = data(await client.callTool({ name: 'verify_with_google', arguments: { account_id: ACCOUNT } }));
    assert.equal(witness.verdict, 'clean');
    assert.equal(witness.source, 'sandbox_change_history');
    assert.equal(witness.outside_change_count, 2);

    const accounts = data(await client.callTool({ name: 'list_accounts', arguments: {} }));
    assert.equal(accounts.accounts[0].changes, 'allowed with approval');
    const policy = data(await client.callTool({ name: 'get_policy', arguments: {} }));
    assert.match(policy.live_accounts, /change window/);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => /window/.test(t)), 'no tool can open a change window');
  } finally {
    await client.close();
  }
});

test('MCP: approve links open the console on the exact proposal', async () => {
  const rig = makeRig({ realTime: true });
  const config = loadConfig({ ...process.env, CAMPAIGN_OPS_DATA_DIR: rig.dir, CAMPAIGN_OPS_SCOPE: 'execute', CAMPAIGN_OPS_POLICY_FILE: 'no-such-policy-file.json', CAMPAIGN_OPS_GOOGLE_ADS: 'off' });
  const server = createMcpServer({ engine: rig.engine, backend: rig.backend, config, version: 'test', consoleUrl: () => 'http://127.0.0.1:4848/' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'campaign-ops-test', version: '1.0.0' });
  await client.connect(clientSide);
  try {
    const res = await client.callTool({ name: 'propose_change', arguments: { account_id: ACCOUNT, change: { type: 'set_campaign_budget', campaign_id: 'c-202', new_daily_budget: 46 }, reason: 'Best cost per lead and limited by budget.' } });
    const p = data(res);
    assert.equal(p.approve_link, `http://127.0.0.1:4848/#p=${p.id}`);
    assert.match(text(res), new RegExp(`Approve or reject it here: http://127\\.0\\.0\\.1:4848/#p=${p.id}`));
    assert.ok(!text(res).includes(config.consoleToken), 'the link never carries the console key');

    const waiting = data(await client.callTool({ name: 'apply_change', arguments: { proposal_id: p.id } }));
    assert.equal(waiting.status, 'awaiting_approval');
    assert.equal(waiting.approve_link, `http://127.0.0.1:4848/#p=${p.id}`);

    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    const applied = data(await client.callTool({ name: 'apply_change', arguments: { proposal_id: p.id } }));
    assert.equal(applied.status, 'applied');
    assert.equal(applied.proposal.approve_link, undefined, 'no link once nothing is waiting');
  } finally {
    await client.close();
    rig.cleanup();
  }
});
