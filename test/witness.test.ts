import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { ACCOUNT, AGENT, PERSON, REASON, budgetChange, makeRig, tempDir } from './helpers.js';

test('a fresh sandbox: nothing by the robot, and the planted outside edits are listed', async () => {
  const rig = makeRig();
  try {
    const w = await rig.engine.witness(ACCOUNT, 14);
    assert.equal(w.available, true);
    assert.equal(w.source, 'sandbox_change_history');
    assert.equal(w.verdict, 'clean');
    assert.match(w.headline, /shows no changes by Campaign Ops/);
    assert.equal(w.outsideCount, 2);
    assert.deepEqual(w.outside.map((e) => e.actor).sort(), ['jordan@demoproperty.example', 'sam@demoproperty.example']);
    assert.ok(w.outside.some((e) => e.client === 'Google Ads Editor' && /craigslist/.test(e.summary)));
  } finally {
    rig.cleanup();
  }
});

test('an applied change is matched; a robot change with no approval raises the alarm', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(46), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    rig.clock.advanceMinutes(1);
    assert.equal((await rig.engine.apply(p.id, { actor: AGENT })).status, 'applied');
    rig.clock.advanceMinutes(20);
    const w = await rig.engine.witness(ACCOUNT, 14);
    assert.equal(w.verdict, 'clean');
    assert.deepEqual(w.robot, { total: 1, matched: 1, setup: 0, unexplained: 0 });
    assert.equal(w.matches[0].proposalId, p.id);
    assert.match(w.headline, /matches: every change made with the robot's credentials/);

    // the robot key used outside the approval flow
    await rig.backend.mutate(ACCOUNT, { type: 'set_campaign_status', campaignId: 'c-101', newStatus: 'PAUSED' }, { validateOnly: false });
    const alarm = await rig.engine.witness(ACCOUNT, 14);
    assert.equal(alarm.verdict, 'alarm');
    assert.equal(alarm.unexplained.length, 1);
    assert.match(alarm.unexplained[0].summary, /Juniper Yard \| Search \| Brand/);
  } finally {
    rig.cleanup();
  }
});

test('a rebuilt sandbox does not report older changes as missing', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(46), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    assert.equal((await rig.engine.apply(p.id, { actor: AGENT })).status, 'applied');
    rig.clock.advanceMinutes(30);
    rig.backend.reset({ endDate: '2026-11-20' });
    const w = await rig.engine.witness(ACCOUNT, 14);
    assert.equal(w.verdict, 'clean', w.headline);
    assert.deepEqual(w.missing, []);
  } finally {
    rig.cleanup();
  }
});

test('a sandbox file from version 0.2 starts its record when first opened', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'sandbox.json');
    let now = Date.parse('2026-11-21T15:00:00Z');
    const old = new SandboxBackend(file, { clock: () => now });
    old.ensure({ endDate: '2026-11-20' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.changeHistory;
    fs.writeFileSync(file, JSON.stringify(raw));

    const engine = new Engine({ backend: old, dataDir: dir, policy: DEFAULT_POLICY, scope: 'execute', clock: () => now });
    now += 3_600_000;
    const w = await engine.witness(ACCOUNT, 14);
    assert.equal(w.verdict, 'clean');
    assert.equal(w.outsideCount, 0, 'an old file has no history to show');
    const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(migrated.changeHistory, []);
    assert.equal(migrated.historyStartedAt, new Date(now).toISOString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
