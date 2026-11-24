import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT, AGENT, COMPLIANT_COPY, PERSON, REASON, budgetChange, makeRig, wasteNegatives } from './helpers.js';
import { DEFAULT_POLICY } from '../src/config.js';

const failedIds = (p: { checks: Array<{ id: string; status: string }> }) => p.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('happy path: propose, wait for approval, approve, apply, verify', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    assert.equal(p.status, 'pending_approval');
    assert.equal(p.id, 'P-0001');
    assert.ok(p.checks.some((c) => c.id === 'dry_run' && c.status === 'pass'));

    const early = await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal(early.status, 'awaiting_approval');
    assert.equal((await rig.backend.getCampaign(ACCOUNT, 'c-202'))!.dailyBudget, 40, 'nothing changes before approval');

    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    const out = await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal(out.status, 'applied');
    assert.equal(out.proposal?.verification?.status, 'passed');
    assert.equal((await rig.backend.getCampaign(ACCOUNT, 'c-202'))!.dailyBudget, 50);

    const again = await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal(again.status, 'already_applied', 'applying twice is safe');

    const types = rig.engine.audit.readAll().map((e) => e.type);
    assert.deepEqual(types, ['proposal_created', 'approved', 'applied']);
    assert.equal(rig.engine.audit.verify().ok, true);
  } finally {
    rig.cleanup();
  }
});

test('budget step limit blocks oversized increases and names the largest allowed value', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(80), reason: REASON, requestedBy: AGENT });
    assert.equal(p.status, 'blocked');
    assert.deepEqual(failedIds(p), ['budget_step']);
    assert.match(p.checks.find((c) => c.id === 'budget_step')!.detail!, /\$52\.00/);
    await assert.rejects(rig.engine.approve(p.id, { by: PERSON, channel: 'console' }), /blocked/);
  } finally {
    rig.cleanup();
  }
});

test('account daily total cap is enforced', async () => {
  const rig = makeRig({ policy: { budgets: { ...DEFAULT_POLICY.budgets, maxAccountDailyTotal: 230 } } });
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    assert.equal(p.status, 'blocked');
    assert.deepEqual(failedIds(p), ['account_total']);
  } finally {
    rig.cleanup();
  }
});

test('Fair Housing: negatives that exclude protected groups are always blocked', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({
      accountId: ACCOUNT,
      change: { type: 'add_negative_keywords', campaignId: 'c-102', keywords: [{ text: 'Section 8 Apartments', matchType: 'PHRASE' }, { text: 'apartment jobs', matchType: 'PHRASE' }] },
      reason: REASON,
      requestedBy: AGENT,
    });
    assert.equal(p.status, 'blocked');
    assert.deepEqual(failedIds(p), ['fair_housing_negatives']);
    assert.match(p.checks.find((c) => c.id === 'fair_housing_negatives')!.detail!, /source of income/);
  } finally {
    rig.cleanup();
  }
});

test('brand protection and collateral-damage checks on negatives', async () => {
  const rig = makeRig();
  try {
    const brand = await rig.engine.propose({ accountId: ACCOUNT, change: { type: 'add_negative_keywords', campaignId: 'c-102', keywords: [{ text: 'juniper yard reviews', matchType: 'PHRASE' }] }, reason: REASON, requestedBy: AGENT });
    assert.deepEqual(failedIds(brand), ['brand_terms']);

    const broad = await rig.engine.propose({ accountId: ACCOUNT, change: { type: 'add_negative_keywords', campaignId: 'c-102', keywords: [{ text: 'apartments', matchType: 'BROAD' }] }, reason: REASON, requestedBy: AGENT });
    assert.deepEqual(failedIds(broad), ['collateral']);

    const good = await rig.engine.propose({ accountId: ACCOUNT, change: wasteNegatives(), reason: REASON, requestedBy: AGENT });
    assert.equal(good.status, 'pending_approval');
  } finally {
    rig.cleanup();
  }
});

test('ad copy: violations are blocked, compliant copy waits for approval', async () => {
  const rig = makeRig();
  try {
    const bad = await rig.engine.propose({
      accountId: ACCOUNT,
      change: { ...COMPLIANT_COPY, headlines: ['Ashgrove Commons', 'Perfect for Couples', 'Book a Tour Today'] } as typeof COMPLIANT_COPY,
      reason: REASON,
      requestedBy: AGENT,
    });
    assert.equal(bad.status, 'blocked');
    assert.ok(failedIds(bad).includes('fair_housing_copy'));

    const long = await rig.engine.propose({
      accountId: ACCOUNT,
      change: { ...COMPLIANT_COPY, headlines: ['Ashgrove Commons', 'This headline is far too long for Google', 'Book a Tour!'] } as typeof COMPLIANT_COPY,
      reason: REASON,
      requestedBy: AGENT,
    });
    assert.ok(failedIds(long).includes('ad_lengths'));
    assert.ok(failedIds(long).includes('ad_punctuation'));

    const good = await rig.engine.propose({ accountId: ACCOUNT, change: COMPLIANT_COPY, reason: REASON, requestedBy: AGENT });
    assert.equal(good.status, 'pending_approval');
    assert.equal(good.fairHousing?.status, 'clean');
  } finally {
    rig.cleanup();
  }
});

test('only one open proposal per target', async () => {
  const rig = makeRig();
  try {
    const first = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    const second = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(48), reason: REASON, requestedBy: AGENT });
    assert.equal(first.status, 'pending_approval');
    assert.deepEqual(failedIds(second), ['open_proposal']);
  } finally {
    rig.cleanup();
  }
});

test('drift: a change made outside the tool after proposing causes a conflict, not an overwrite', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    rig.backend.externalEdit((s) => {
      s.campaigns.find((c) => c.id === 'c-202')!.dailyBudget = 45;
    });
    const out = await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal(out.status, 'conflict');
    assert.equal((await rig.backend.getCampaign(ACCOUNT, 'c-202'))!.dailyBudget, 45, 'the outside edit is preserved');
  } finally {
    rig.cleanup();
  }
});

test('tampering with a stored proposal after approval is detected and nothing is applied', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    const file = path.join(rig.dir, 'proposals.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.proposals[0].change.newDailyBudget = 250;
    data.proposals[0].after = { dailyBudget: 250 };
    fs.writeFileSync(file, JSON.stringify(data));
    const out = await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal(out.status, 'failed');
    assert.equal((await rig.backend.getCampaign(ACCOUNT, 'c-202'))!.dailyBudget, 40);
    assert.ok(rig.engine.audit.readAll().some((e) => e.type === 'tamper_detected'));
  } finally {
    rig.cleanup();
  }
});

test('approvals and proposals expire', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    rig.clock.advanceMinutes(61);
    const out = await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal(out.status, 'not_applicable');
    assert.equal(out.proposal?.status, 'expired');

    const q = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    rig.clock.advanceMinutes(25 * 60);
    assert.equal((await rig.engine.getProposal(q.id))!.status, 'expired');
  } finally {
    rig.cleanup();
  }
});

test('kill switch refuses every apply, from the console or the environment', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await rig.engine.setKillSwitch(true, PERSON);
    assert.equal((await rig.engine.apply(p.id, { actor: AGENT })).status, 'refused');
    await rig.engine.setKillSwitch(false, PERSON);
    assert.equal((await rig.engine.apply(p.id, { actor: AGENT })).status, 'applied');
  } finally {
    rig.cleanup();
  }

  const forced = makeRig({ forceKillSwitch: true });
  try {
    const p = await forced.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    assert.ok(p.checks.some((c) => c.id === 'kill_switch' && c.status === 'warn'));
    await forced.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await forced.engine.setKillSwitch(false, PERSON);
    assert.equal((await forced.engine.apply(p.id, { actor: AGENT })).status, 'refused', 'the environment setting wins');
  } finally {
    forced.cleanup();
  }
});

test('cooldown stops rapid changes to the same target; rate limit caps volume', async () => {
  const rig = makeRig();
  try {
    const a = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(a.id, { by: PERSON, channel: 'console' });
    assert.equal((await rig.engine.apply(a.id, { actor: AGENT })).status, 'applied');

    const b = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(60), reason: REASON, requestedBy: AGENT });
    assert.ok(b.checks.some((c) => c.id === 'cooldown' && c.status === 'warn'));
    await rig.engine.approve(b.id, { by: PERSON, channel: 'console' });
    const refused = await rig.engine.apply(b.id, { actor: AGENT });
    assert.equal(refused.status, 'refused');
    assert.match(refused.message, /Cooldown/);
    rig.clock.advanceMinutes(31);
    assert.equal((await rig.engine.apply(b.id, { actor: AGENT })).status, 'applied');
  } finally {
    rig.cleanup();
  }

  const limited = makeRig({ policy: { rateLimits: { ...DEFAULT_POLICY.rateLimits, maxAppliedPerHour: 1 } } });
  try {
    const a = await limited.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    const b = await limited.engine.propose({ accountId: ACCOUNT, change: wasteNegatives(), reason: REASON, requestedBy: AGENT });
    await limited.engine.approve(a.id, { by: PERSON, channel: 'console' });
    await limited.engine.approve(b.id, { by: PERSON, channel: 'console' });
    assert.equal((await limited.engine.apply(a.id, { actor: AGENT })).status, 'applied');
    const out = await limited.engine.apply(b.id, { actor: AGENT });
    assert.equal(out.status, 'refused');
    assert.match(out.message, /Rate limit/);
  } finally {
    limited.cleanup();
  }
});

test('rollback is a proposal: it needs approval, then restores the previous state', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: wasteNegatives(), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await rig.engine.apply(p.id, { actor: AGENT });
    assert.equal((await rig.backend.listNegatives(ACCOUNT, 'c-102')).length, 6);

    const undo = await rig.engine.requestRollback(p.id, { requestedBy: AGENT, reason: 'Testing the rollback path end to end.' });
    assert.equal(undo.status, 'pending_approval');
    assert.equal(undo.change.type, 'remove_negative_keywords');
    assert.equal((await rig.engine.apply(undo.id, { actor: AGENT })).status, 'awaiting_approval');

    await rig.engine.approve(undo.id, { by: PERSON, channel: 'console' });
    assert.equal((await rig.engine.apply(undo.id, { actor: AGENT })).status, 'applied');
    assert.equal((await rig.backend.listNegatives(ACCOUNT, 'c-102')).length, 1);
    assert.equal((await rig.engine.getProposal(p.id))!.status, 'rolled_back');
    await assert.rejects(rig.engine.requestRollback(p.id, { requestedBy: AGENT }), /rolled back/);
  } finally {
    rig.cleanup();
  }
});

test('an undo that would restore non-compliant ad copy is blocked', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: COMPLIANT_COPY, reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await rig.engine.apply(p.id, { actor: AGENT });
    const undo = await rig.engine.requestRollback(p.id, { requestedBy: AGENT });
    assert.equal(undo.status, 'blocked');
    assert.ok(failedIds(undo).includes('fair_housing_copy'));
  } finally {
    rig.cleanup();
  }
});

test('one-click undo from the console applies immediately', async () => {
  const rig = makeRig();
  try {
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await rig.engine.apply(p.id, { actor: AGENT });
    const res = await rig.engine.undoNow(p.id, PERSON);
    assert.equal(res.outcome?.status, 'applied');
    assert.equal((await rig.backend.getCampaign(ACCOUNT, 'c-202'))!.dailyBudget, 40);
  } finally {
    rig.cleanup();
  }
});

test('scopes: read cannot propose, propose cannot apply', async () => {
  const read = makeRig({ scope: 'read' });
  try {
    await assert.rejects(read.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT }), /read scope/);
  } finally {
    read.cleanup();
  }
  const propose = makeRig({ scope: 'propose' });
  try {
    const p = await propose.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: REASON, requestedBy: AGENT });
    await propose.engine.approve(p.id, { by: PERSON, channel: 'console' });
    assert.equal((await propose.engine.apply(p.id, { actor: AGENT })).status, 'refused');
    assert.equal((await propose.engine.apply(p.id, { actor: PERSON, human: true })).status, 'applied', 'a person can still apply from the console');
  } finally {
    propose.cleanup();
  }
});

test('the audit chain detects edits and deletions', async () => {
  const rig = makeRig();
  try {
    for (const amount of [50]) {
      const p = await rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(amount), reason: REASON, requestedBy: AGENT });
      await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
      await rig.engine.apply(p.id, { actor: AGENT });
    }
    assert.equal(rig.engine.audit.verify().ok, true);
    const file = path.join(rig.dir, 'audit.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

    const edited = [...lines];
    const entry = JSON.parse(edited[1]);
    entry.actor = 'someone else';
    edited[1] = JSON.stringify(entry);
    fs.writeFileSync(file, edited.join('\n') + '\n');
    assert.deepEqual([rig.engine.audit.verify().ok, rig.engine.audit.verify().brokenAtSeq], [false, 2]);

    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
    assert.equal(rig.engine.audit.verify().ok, false);
  } finally {
    rig.cleanup();
  }
});

test('invalid input gives a clear error instead of a stored proposal', async () => {
  const rig = makeRig();
  try {
    await assert.rejects(rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50, 'c-999'), reason: REASON, requestedBy: AGENT }), /No campaign c-999/);
    await assert.rejects(rig.engine.propose({ accountId: 'nope', change: budgetChange(50), reason: REASON, requestedBy: AGENT }), /Unknown account/);
    await assert.rejects(rig.engine.propose({ accountId: ACCOUNT, change: budgetChange(50), reason: 'short', requestedBy: AGENT }), /reason/);
    assert.equal(rig.engine.store.list().length, 0);
  } finally {
    rig.cleanup();
  }
});
