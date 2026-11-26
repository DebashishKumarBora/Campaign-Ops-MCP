import { test, describe } from 'node:test';
import { Autopilot } from '../src/autopilot/autopilot.js';
import type { Notice } from '../src/autopilot/types.js';
import assert from 'node:assert/strict';
import { checkPulse } from '../src/governance/pulse.js';
import { LIVE, LIVE_D, MGR, REASON, START, days, liveRig, person } from './liveRig.js';

describe('live accounts: real numbers', () => {
  test('reads real daily numbers and search terms from Google, through the manager login', async () => {
    const r = await liveRig();
    try {
      const accounts = await r.google.listAccounts();
      assert.deepEqual(accounts.map((a) => [a.mode, a.numbers]), [['google_ads', 'live']]);
      const c = await r.campaign('Northlight Lofts | Search | Generic');
      const series = days('2026-11-20', 7, (i) => (i === 2 ? { impressions: 0, clicks: 0, cost: 0, conversions: 0 } : { conversions: i === 4 ? 0 : 2, lostIs: 0.31 }));
      r.fake.setDailyMetrics(LIVE, c.id, series);
      const rows = await r.google.getDailyMetrics(LIVE_D, c.id, 7);
      assert.equal(rows.length, 7);
      assert.equal(rows[0].date, '2026-11-14');
      assert.equal(rows[6].date, '2026-11-20');
      assert.deepEqual(rows[2], { date: '2026-11-16', impressions: 0, clicks: 0, cost: 0, conversions: 0 }, 'a day Google leaves out is filled with zeros');
      assert.equal(rows[4].conversions, 0, 'a zero Google leaves out of a row reads as zero');
      assert.equal(rows[0].cost, 80);
      assert.equal(rows[0].searchLostIsBudget, 0.31);

      r.fake.addSearchTerm(LIVE, { campaignId: c.id, adGroupId: '1', term: 'loft apartments downtown', impressions: 50, clicks: 6, cost: 12.5, conversions: 1 });
      r.fake.addSearchTerm(LIVE, { campaignId: c.id, adGroupId: '2', term: 'loft apartments downtown', impressions: 30, clicks: 4, cost: 7.5, conversions: 0 });
      r.fake.addSearchTerm(LIVE, { campaignId: c.id, adGroupId: '1', term: 'apartment jobs', impressions: 20, clicks: 5, cost: 11, conversions: 0 });
      const terms = await r.google.getSearchTerms(LIVE_D, { campaignId: c.id, days: 30 });
      assert.deepEqual(terms[0], { campaignId: c.id, term: 'loft apartments downtown', impressions: 80, clicks: 10, cost: 20, conversions: 1 });
      assert.equal(terms.length, 2);

      const search = r.fake.requests.filter((q) => q.path.endsWith('googleAds:search')).at(-1)!;
      assert.equal(search.headers['login-customer-id'], MGR);
    } finally {
      r.cleanup();
    }
  });

  test('Pulse reads real numbers: a spend spike and a stalled campaign are flagged', async () => {
    const r = await liveRig();
    try {
      const spike = await r.campaign('Northlight Lofts | Search | Generic');
      const stalled = await r.campaign('Juniper Yard | Search | Generic');
      r.fake.setDailyMetrics(LIVE, spike.id, days('2026-11-20', 28, (i) => (i === 27 ? { cost: 260, clicks: 120 } : {})));
      r.fake.setDailyMetrics(LIVE, stalled.id, days('2026-11-20', 28, (i) => (i >= 26 ? { impressions: 0, clicks: 0, cost: 0, conversions: 0 } : {})));
      const report = await checkPulse(r.google, LIVE_D, { days: 28 });
      const kinds = report.alarms.map((a) => `${a.kind}:${a.campaignId}`).sort();
      assert.deepEqual(kinds, [`spend_spike:${spike.id}`, `stopped_spending:${stalled.id}`].sort());
      const s = report.alarms.find((a) => a.kind === 'spend_spike')!;
      assert.equal(s.severity, 'high');
      assert.match(s.detail, /\$260\.00 on Nov 20/);
      assert.ok(!report.notes.some((n) => /simulated/.test(n)), 'real numbers are not called simulated');
    } finally {
      r.cleanup();
    }
  });
});

describe('live accounts: change windows', () => {
  test('read-only until a person opens a window; the window expires; the kill switch still wins', async () => {
    const r = await liveRig();
    try {
      const c = await r.campaign('Northlight Lofts | Search | Generic');
      const writesBefore = r.fake.writes().length;
      const p = await r.engine.propose({ accountId: LIVE_D, change: { type: 'set_campaign_budget', campaignId: c.id, newDailyBudget: 44 }, reason: REASON, requestedBy: 'agent' });
      assert.equal(p.status, 'pending_approval');
      const check = p.checks.find((k) => k.id === 'live_access')!;
      assert.equal(check.status, 'warn');
      assert.equal(r.fake.mutations().at(-1)!.body.validateOnly, true, 'the dry run still runs on a live account');

      await r.engine.approve(p.id, person);
      const refused = await r.engine.apply(p.id, { actor: 'agent' });
      assert.equal(refused.status, 'refused');
      assert.match(refused.message, /no change window is open/);
      assert.equal(r.fake.writes().length, writesBefore, 'nothing was written');

      const direct = await r.google.mutate(LIVE_D, { type: 'set_campaign_status', campaignId: c.id, newStatus: 'PAUSED' }, { validateOnly: false });
      assert.equal(direct.ok, false, 'the backend itself refuses a live write without a window');
      assert.match(direct.errors[0], /no change window is open/);
      assert.equal(r.fake.writes().length, writesBefore);

      await assert.rejects(r.engine.openChangeWindow(LIVE_D, { hours: 2, confirmName: 'Acme', by: 'Deb' }), /Type the account name exactly/);
      await assert.rejects(r.engine.openChangeWindow(LIVE_D, { hours: 0, confirmName: 'Acme Apartments', by: 'Deb' }), /1 to 8 hours/);
      await assert.rejects(r.engine.openChangeWindow(LIVE_D, { hours: 9, confirmName: 'Acme Apartments', by: 'Deb' }), /1 to 8 hours/);
      await assert.rejects(r.engine.openChangeWindow('123-456-7890', { hours: 2, confirmName: 'Demo Property Group (Sandbox)', by: 'Deb' }), /not a live account/);

      const w = await r.engine.openChangeWindow(LIVE_D, { hours: 2, confirmName: '  acme   APARTMENTS ', by: 'Deb' });
      assert.equal(w.until, new Date(START + 2 * 3_600_000).toISOString());
      assert.deepEqual((await r.engine.liveAccess(LIVE_D)).open, true);
      const out = await r.engine.apply(p.id, { actor: 'agent' });
      assert.equal(out.status, 'applied', out.message);
      assert.equal(out.proposal!.verification!.status, 'passed');
      assert.equal((await r.campaign('Northlight Lofts | Search | Generic')).dailyBudget, 44);

      // the kill switch still stops everything inside a window
      const other = await r.campaign('Juniper Yard | Search | Brand');
      const p2 = await r.engine.propose({ accountId: LIVE_D, change: { type: 'set_campaign_budget', campaignId: other.id, newDailyBudget: 33 }, reason: REASON, requestedBy: 'agent' });
      assert.equal(p2.checks.find((k) => k.id === 'live_access')!.status, 'pass');
      await r.engine.approve(p2.id, person);
      await r.engine.setKillSwitch(true, 'Deb');
      assert.equal((await r.engine.apply(p2.id, { actor: 'agent' })).status, 'refused');
      await r.engine.setKillSwitch(false, 'Deb');

      // the window ends on its own
      r.clock.advanceMinutes(125);
      assert.equal((await r.engine.liveAccess(LIVE_D)).open, false);
      await r.engine.approve((await r.engine.propose({ accountId: LIVE_D, change: { type: 'set_campaign_budget', campaignId: (await r.campaign('Juniper Yard | Search | Generic')).id, newDailyBudget: 66 }, reason: REASON, requestedBy: 'agent' })).id, person).then(async (approved) => {
        const late = await r.engine.apply(approved.id, { actor: 'agent' });
        assert.equal(late.status, 'refused');
      });

      // a person can lock it again early
      await r.engine.openChangeWindow(LIVE_D, { hours: 1, confirmName: 'Acme Apartments', by: 'Deb' });
      await r.engine.closeChangeWindow(LIVE_D, 'Deb');
      assert.equal((await r.engine.liveAccess(LIVE_D)).open, false);
      const types = r.engine.audit.readAll().map((e) => e.type);
      assert.equal(types.filter((t) => t === 'change_window_opened').length, 2);
      assert.equal(types.filter((t) => t === 'change_window_closed').length, 1);
      assert.equal(r.engine.audit.verify().ok, true);
    } finally {
      r.cleanup();
    }
  });

  test('pausing one ad: a single status write, undo works, and a flagged ad cannot be re-enabled', async () => {
    const r = await liveRig({ direct: true });
    try {
      await r.engine.openChangeWindow(LIVE_D, { hours: 4, confirmName: 'Acme Apartments', by: 'Deb' });
      const ads = await r.google.listAds(LIVE_D);
      const flagged = ads.find((a) => a.headlines.includes('Ideal for Young Professionals'))!;
      const clean = ads.find((a) => a.id !== flagged.id)!;

      const p = await r.engine.propose({ accountId: LIVE_D, change: { type: 'set_ad_status', adId: clean.id, newStatus: 'PAUSED' }, reason: REASON, requestedBy: 'agent' });
      assert.equal(p.status, 'pending_approval');
      assert.ok(['low', 'high'].includes(p.risk));
      await r.engine.approve(p.id, person);
      const out = await r.engine.apply(p.id, { actor: 'agent' });
      assert.equal(out.status, 'applied', out.message);
      const write = r.fake.writes().at(-1)!;
      assert.equal(write.path, `/v26/customers/${LIVE}/adGroupAds:mutate`);
      assert.equal(write.headers['login-customer-id'], LIVE);
      assert.equal(write.body.operations[0].updateMask, 'status');
      assert.equal(write.body.operations[0].update.resourceName, `customers/${LIVE}/adGroupAds/${clean.adGroupId}~${clean.id}`);
      assert.equal((await r.google.getAd(LIVE_D, clean.id))!.status, 'PAUSED');
      const undo = await r.engine.undoNow(p.id, 'Deb');
      assert.equal(undo.outcome?.status, 'applied');
      assert.equal((await r.google.getAd(LIVE_D, clean.id))!.status, 'ENABLED');

      r.clock.advanceMinutes(5);
      const stop = await r.engine.propose({ accountId: LIVE_D, change: { type: 'set_ad_status', adId: flagged.id, newStatus: 'PAUSED' }, reason: 'Stopgap: the ad has Fair Housing problems.', requestedBy: 'agent' });
      await r.engine.approve(stop.id, person);
      assert.equal((await r.engine.apply(stop.id, { actor: 'agent' })).status, 'applied');
      const back = await r.engine.undoNow(stop.id, 'Deb');
      assert.equal(back.rollback.status, 'blocked', 'turning a flagged ad back on is blocked until its copy is fixed');
      assert.ok(back.rollback.checks.some((k) => k.id === 'fair_housing_copy' && k.status === 'fail'));
      assert.equal((await r.google.getAd(LIVE_D, flagged.id))!.status, 'PAUSED');
    } finally {
      r.cleanup();
    }
  });
});

describe("Google as witness", () => {
  test("matches every robot change in Google's change history to an approval, and lists everyone else's", async () => {
    const r = await liveRig();
    try {
      await r.engine.openChangeWindow(LIVE_D, { hours: 8, confirmName: 'Acme Apartments', by: 'Deb' });
      const c = await r.campaign('Juniper Yard | Search | Generic');
      r.clock.advanceMinutes(2);
      const p = await r.engine.propose({ accountId: LIVE_D, change: { type: 'add_negative_keywords', campaignId: c.id, keywords: [{ text: 'apartment jobs', matchType: 'PHRASE' }, { text: 'storage units near me', matchType: 'PHRASE' }] }, reason: REASON, requestedBy: 'agent' });
      await r.engine.approve(p.id, person);
      assert.equal((await r.engine.apply(p.id, { actor: 'agent' })).status, 'applied');

      r.fake.addEvent(LIVE, { at: START - 3 * 86_400_000, userEmail: 'jordan@acme.example', clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'CAMPAIGN_BUDGET', resourceName: `customers/${LIVE}/campaignBudgets/77`, operation: 'UPDATE', changedFields: 'amountMicros', campaignId: c.id, oldResource: { campaignBudget: { amountMicros: '50000000' } }, newResource: { campaignBudget: { amountMicros: '60000000' } } });
      r.fake.addEvent(LIVE, { at: START - 86_400_000, userEmail: 'ads-recommendations@google.com', clientType: 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION', resourceType: 'CAMPAIGN', resourceName: `customers/${LIVE}/campaigns/${c.id}`, operation: 'UPDATE', changedFields: 'biddingStrategyType', campaignId: c.id });
      r.clock.advanceMinutes(20);

      const w = await r.engine.witness(LIVE_D, 14);
      assert.equal(w.source, 'google_ads_change_history');
      assert.equal(w.verdict, 'clean', w.headline);
      assert.deepEqual(w.robot, { total: 2, matched: 2, setup: 0, unexplained: 0 });
      assert.equal(w.matches[0].proposalId, p.id);
      assert.equal(w.matches[0].events, 2);
      assert.equal(w.outsideCount, 2);
      const budget = w.outside.find((e) => e.actor === 'jordan@acme.example')!;
      assert.equal(budget.client, 'Google Ads web');
      assert.match(budget.summary, /Daily budget of Juniper Yard \| Search \| Generic changed from \$50\.00 to \$60\.00/);
      assert.equal(w.outside.find((e) => e.actor.includes('recommendations'))!.client, 'Auto-applied recommendation');

      // someone uses the robot key outside Campaign Ops
      await r.google.mutate(LIVE_D, { type: 'set_campaign_status', campaignId: c.id, newStatus: 'PAUSED' }, { validateOnly: false, liveAccess: true });
      r.clock.advanceMinutes(1);
      const alarm = await r.engine.witness(LIVE_D, 14);
      assert.equal(alarm.verdict, 'alarm');
      assert.equal(alarm.unexplained.length, 1);
      assert.match(alarm.unexplained[0].summary, /changed from Enabled to Paused/);
      assert.match(alarm.headline, /match no approved proposal|matches no approved proposal/);
    } finally {
      r.cleanup();
    }
  });

  test('a change Google has no record of is flagged once Google has had time to record it', async () => {
    const r = await liveRig();
    try {
      await r.engine.openChangeWindow(LIVE_D, { hours: 8, confirmName: 'Acme Apartments', by: 'Deb' });
      const c = await r.campaign('Northlight Lofts | Search | Generic');
      const p = await r.engine.propose({ accountId: LIVE_D, change: { type: 'set_campaign_budget', campaignId: c.id, newDailyBudget: 46 }, reason: REASON, requestedBy: 'agent' });
      await r.engine.approve(p.id, person);
      assert.equal((await r.engine.apply(p.id, { actor: 'agent' })).status, 'applied');
      r.fake.account(LIVE).events.length = 0; // Google has not recorded it

      r.clock.advanceMinutes(5);
      const early = await r.engine.witness(LIVE_D, 14);
      assert.equal(early.verdict, 'clean');
      assert.deepEqual(early.pending.map((x) => x.proposalId), [p.id]);

      r.clock.advanceMinutes(20);
      const late = await r.engine.witness(LIVE_D, 14);
      assert.equal(late.verdict, 'attention');
      assert.deepEqual(late.missing.map((x) => x.proposalId), [p.id]);
    } finally {
      r.cleanup();
    }
  });

  test('robot changes made by the setup script are expected, not unexplained', async () => {
    const r = await liveRig();
    try {
      const from = new Date(r.clock.now).toISOString();
      const c = await r.campaign('Northlight Lofts | Search | Generic');
      // a robot change with no proposal: unexplained unless a setup run covers it
      await r.google.mutate(LIVE_D, { type: 'set_campaign_status', campaignId: c.id, newStatus: 'PAUSED' }, { validateOnly: false, liveAccess: true });
      r.clock.advanceMinutes(1);
      const to = new Date(r.clock.now).toISOString();
      assert.equal((await r.engine.witness(LIVE_D, 14)).verdict, 'alarm');
      await r.engine.recordSetup({ accountId: LIVE_D, from, to, changes: 1, by: 'npm run gads:setup' });
      const w = await r.engine.witness(LIVE_D, 14);
      assert.equal(w.verdict, 'clean');
      assert.equal(w.setup.count, 1);
    } finally {
      r.cleanup();
    }
  });
});

describe('Explorer access', () => {
  test('a Cloud project with Test access gets a plain explanation for a live account', async () => {
    const r = await liveRig();
    try {
      r.fake.accessLevel = 'test';
      await assert.rejects(r.google.listCampaigns(LIVE_D), /real \(production\) Google Ads account/);
    } finally {
      r.cleanup();
    }
  });
});

test('live account: ads Google disapproved or limited reach Autopilot, once', async () => {
  const r = await liveRig();
  try {
    const live = r.fake.account(LIVE);
    const ads = [...live.ads.values()];
    ads[0].policy = { approvalStatus: 'DISAPPROVED', topics: ['DESTINATION_NOT_WORKING'] };
    ads[1].policy = { approvalStatus: 'APPROVED_LIMITED', topics: ['HOUSING_PERSONALIZED_ADS'] };
    const issues = await r.router.getAdPolicyIssues(LIVE_D);
    assert.equal(issues.length, 2);
    const off = issues.find((i) => i.approval === 'DISAPPROVED')!;
    assert.equal(off.adId, ads[0].id);
    assert.deepEqual(off.topics, ['Destination not working']);
    assert.equal(issues.find((i) => i.approval === 'LIMITED')!.topics[0], 'Housing personalized ads');
    assert.deepEqual(await r.router.getAdPolicyIssues('123-456-7890'), [], 'the sandbox has no policy review');

    const sent: Array<{ title: string; urgent: boolean }> = [];
    const autopilot = new Autopilot({ engine: r.engine, backend: r.router, dataDir: r.dir, notify: (n: Notice[]) => void sent.push(...n), clock: () => r.clock.now, fetchPage: async () => ({ status: 200 }) });
    await autopilot.updateSettings({ quiet: { on: false } }, 'Deb');
    await autopilot.run({ kind: 'watch', accountId: LIVE_D });
    assert.ok(sent.some((n) => n.urgent && /Google disapproved ad/.test(n.title)));
    assert.ok(sent.some((n) => !n.urgent && /Google limited ad/.test(n.title)));
    const count = sent.length;
    r.clock.advanceMinutes(60);
    await autopilot.run({ kind: 'watch', accountId: LIVE_D });
    assert.equal(sent.filter((n) => /Google (disapproved|limited)/.test(n.title)).length, 2, 'the same verdict is not sent every hour');
    assert.ok(sent.length >= count);
  } finally {
    r.cleanup();
  }
});
