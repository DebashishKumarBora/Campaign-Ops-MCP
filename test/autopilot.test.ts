import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autopilot } from '../src/autopilot/autopilot.js';
import type { AiBrain } from '../src/autopilot/ai.js';
import { checkLine, parseJsonLoose, pickLines, textOf, workersAiBrain } from '../src/autopilot/ai.js';
import { applySettingsPatch, defaultSettings, inQuiet } from '../src/autopilot/settings.js';
import { judge } from '../src/autopilot/outcomes.js';
import { classify, pageKey, skipReason } from '../src/autopilot/landing.js';
import type { Job, Notice } from '../src/autopilot/types.js';
import type { PageResult } from '../src/autopilot/landing.js';
import type { AdsBackend } from '../src/backends/backend.js';
import type { Account, DailyMetric } from '../src/types.js';
import { DEFAULT_POLICY } from '../src/config.js';
import { lintAd } from '../src/governance/fairHousing.js';
import { ACCOUNT, PERSON, makeRig, type TestRig } from './helpers.js';

const brain = (): AiBrain & { calls: string[] } => {
  const calls: string[] = [];
  return {
    model: 'test-model',
    calls,
    async checkTerms({ terms }) {
      calls.push('terms');
      return { exclude: terms.filter((t) => t !== 'free furniture pickup'), keep: terms.includes('free furniture pickup') ? [{ term: 'free furniture pickup', why: 'someone moving in may search this' }] : [] };
    },
    async rewriteLines({ flagged }) {
      calls.push('rewrite');
      return flagged.map((f) => ({ field: f.field, options: f.field.startsWith('Headline') ? ['Perfect for Singles Downtown', 'Ideal Downtown Location'] : ['Community near downtown with a resort-style pool.'] }));
    },
    async moreCopy() {
      calls.push('more');
      return { headlines: ['Rooftop Lounge', 'In-Unit Laundry', 'Free Month of Rent', 'Modern 1 to 3 Bedroom Homes', 'Book a Tour Online'], descriptions: ['See floor plans and book a tour online today.'] };
    },
  };
};

function pilot(rig: TestRig, opts: { brain?: AiBrain; pages?: (url: string) => PageResult; backend?: AdsBackend } = {}) {
  const sent: Notice[] = [];
  const ap = new Autopilot({
    engine: rig.engine,
    backend: opts.backend ?? rig.backend,
    dataDir: rig.dir,
    brain: opts.brain,
    fetchPage: async (url) => (opts.pages ? opts.pages(url) : { status: 200 }),
    notify: (n) => {
      sent.push(...n);
    },
    clock: () => rig.clock.now,
  });
  return { ap, sent };
}

const review = async (ap: Autopilot) => ap.runAll(await ap.checkNow(ACCOUNT));

test('a review of the sandbox finds the planted problems and writes each fix as a proposal', async () => {
  const rig = makeRig();
  try {
    const { ap, sent } = pilot(rig);
    await review(ap);
    const ps = rig.engine.store.list();
    const by = (type: string, id?: string) => ps.find((p) => p.change.type === type && (!id || JSON.stringify(p.change).includes(id)));

    const pause = by('set_ad_status', 'a-3011');
    assert.ok(pause, 'pauses the ad with risky copy');
    assert.equal(pause!.status, 'pending_approval');
    assert.equal(pause!.requestedBy, 'Autopilot');
    assert.equal(pause!.insight?.skill, 'fair_housing');

    const wasted = ps.filter((p) => p.change.type === 'add_negative_keywords');
    assert.equal(wasted.length, 2, 'one set of negatives per campaign');
    const c102 = wasted.find((p) => p.targetKey === 'campaign:c-102:negatives')!;
    assert.ok(c102.insight?.impactMonthly && c102.insight.impactMonthly > 300);
    for (const p of wasted) for (const k of (p.change as { keywords: Array<{ text: string }> }).keywords) assert.ok(!/section 8|wheelchair|family/.test(k.text), `never blocks a protected search (${k.text})`);

    assert.ok(by('set_campaign_status', 'c-302'), 'pauses the display campaign with no leads');
    assert.ok(by('set_campaign_budget', 'c-202'), 'raises the budget of the capped winner');
    assert.ok(!ps.some((p) => JSON.stringify(p.change).includes('c-101')), 'no change on the campaign with broken tracking');
    assert.ok(ps.every((p) => p.status === 'pending_approval'), 'nothing is applied without a person');
    assert.ok(!by('update_ad_text'), 'without the AI, copy that cannot simply lose a line is left for a person');

    const report = await ap.report();
    assert.ok(report.feed.some((f) => f.kind === 'alert' && f.skill === 'tracking'), 'the broken tracking is in the feed');
    assert.ok(report.feed.some((f) => f.kind === 'note' && /needs new copy/.test(f.title)));
    assert.ok(report.feed.some((f) => f.kind === 'review' && /changes? for you to approve/.test(f.title)));
    assert.ok(sent.some((n) => n.urgent && /Leads stopped recording/.test(n.title)), 'the phone hears about broken tracking');
    assert.ok(sent.some((n) => n.urgent && n.url === `/#p=${pause!.id}`), 'and about the risky ad, linked straight to it');
    assert.ok(sent.some((n) => !n.urgent && /changes for you to approve/.test(n.title)), 'then one summary for the rest');
  } finally {
    rig.cleanup();
  }
});

test('the AI double-checks searches, rewrites risky copy and fills thin ads, and every line is checked', async () => {
  const rig = makeRig();
  try {
    const b = brain();
    const { ap } = pilot(rig, { brain: b });
    await review(ap);
    const ps = rig.engine.store.list();
    const c102 = ps.find((p) => p.targetKey === 'campaign:c-102:negatives')!;
    const words = (c102.change as { keywords: Array<{ text: string }> }).keywords.map((k) => k.text);
    assert.ok(!words.includes('free furniture pickup'), 'a search the AI kept is not blocked');
    assert.equal(words.length, 4);
    assert.match(c102.insight!.ai!, /double-checked/);
    assert.ok(c102.insight!.evidence!.some((e) => e.startsWith('Kept "free furniture pickup"')));

    const rewrite = ps.find((p) => p.change.type === 'update_ad_text' && p.change.adId === 'a-3011')!;
    assert.ok(rewrite, 'compliant copy is proposed');
    const ch = rewrite.change as { headlines: string[]; descriptions: string[] };
    assert.equal(lintAd(ch.headlines, ch.descriptions).status, 'clean');
    assert.ok(ch.headlines.includes('Ideal Downtown Location'), 'the risky option was refused and the clean one used');
    assert.ok(!ch.headlines.some((h) => /singles/i.test(h)));

    const fuller = ps.find((p) => p.change.type === 'update_ad_text' && p.change.adId === 'a-1021')!;
    assert.ok(fuller, 'the busiest thin ad gets more lines');
    const f = fuller.change as { headlines: string[]; descriptions: string[] };
    assert.ok(f.headlines.includes('Rooftop Lounge'));
    assert.ok(!f.headlines.some((h) => /free/i.test(h)), 'an offer the ad never made is refused');
    assert.equal(f.headlines.filter((h) => h === 'In-Unit Laundry').length, 1, 'no repeated lines');

    // The AI's decision to keep a search is remembered: it is not asked again tomorrow.
    await rig.engine.reject(c102.id, { by: PERSON, channel: 'console' });
    rig.clock.advanceMinutes(24 * 60);
    const before = b.calls.length;
    await review(ap);
    assert.ok(!rig.engine.store.list().some((p) => p.id !== c102.id && p.targetKey === 'campaign:c-102:negatives' && p.status === 'pending_approval'), 'a rejected change is not proposed again');
    assert.ok(b.calls.length - before <= 2);
  } finally {
    rig.cleanup();
  }
});

test('approve, apply, then the next review turns the fixed ad back on', async () => {
  const rig = makeRig();
  try {
    const { ap } = pilot(rig, { brain: brain() });
    await review(ap);
    const ps = rig.engine.store.list();
    const pause = ps.find((p) => p.change.type === 'set_ad_status' && p.change.adId === 'a-3011')!;
    const rewrite = ps.find((p) => p.change.type === 'update_ad_text' && p.change.adId === 'a-3011')!;
    for (const p of [pause, rewrite]) {
      await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
      // approve means apply: Autopilot applies what a person approved
      await ap.run({ kind: 'apply_approved' });
      rig.clock.advanceMinutes(31);
    }
    assert.equal((await rig.engine.getProposal(pause.id))!.status, 'applied');
    assert.equal((await rig.engine.getProposal(rewrite.id))!.status, 'applied');
    rig.clock.advanceMinutes(24 * 60);
    await review(ap);
    const back = rig.engine.store.list().find((p) => p.change.type === 'set_ad_status' && p.change.adId === 'a-3011' && p.change.newStatus === 'ENABLED');
    assert.ok(back, 'the ad comes back once its copy is clean');
    assert.match(back!.reason, new RegExp(pause.id));
    assert.ok((await ap.report()).feed.some((f) => f.kind === 'applied' && f.level === 'good'));
  } finally {
    rig.cleanup();
  }
});

test('approved changes held up by Pause all are applied once changes resume', async () => {
  const rig = makeRig();
  try {
    const { ap, sent } = pilot(rig);
    await review(ap);
    const p = rig.engine.store.list().find((x) => x.change.type === 'set_campaign_status')!;
    await rig.engine.setKillSwitch(true, PERSON);
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await ap.run({ kind: 'apply_approved' });
    assert.equal((await rig.engine.getProposal(p.id))!.status, 'approved');
    await rig.engine.setKillSwitch(false, PERSON);
    await ap.run({ kind: 'apply_approved' });
    const done = (await rig.engine.getProposal(p.id))!;
    assert.equal(done.status, 'applied');
    assert.equal(done.verification?.status, 'passed');
    assert.match(done.appliedBy!, /Autopilot, approved by/);
    assert.ok(sent.some((n) => n.title === 'Applied and verified'));
  } finally {
    rig.cleanup();
  }
});

test('broken tracking holds changes on the affected campaign', async () => {
  const rig = makeRig();
  try {
    rig.backend.externalEdit((s) => {
      for (const r of s.metrics['c-301'].slice(-7)) r.conversions = 0;
    });
    const { ap } = pilot(rig);
    await review(ap);
    const ps = rig.engine.store.list();
    assert.ok(!ps.some((p) => p.targetKey === 'campaign:c-301:negatives'), 'no negatives while leads are not being recorded');
    assert.ok(ps.some((p) => p.targetKey === 'campaign:c-102:negatives'), 'other campaigns carry on');
    assert.ok(ps.some((p) => p.change.type === 'set_ad_status'), 'Fair Housing fixes are never held');
    const review1 = (await ap.report()).feed.find((f) => f.kind === 'review')!;
    assert.match(review1.detail ?? '', /Held changes to Ashgrove Commons \| Search \| Generic/);
  } finally {
    rig.cleanup();
  }
});

test('a page that fails twice gets its campaign paused, and comes back when the page does', async () => {
  const rig = makeRig();
  try {
    rig.backend.externalEdit((s) => {
      for (const ad of s.ads) ad.finalUrl = ad.campaignId === 'c-201' ? 'https://homes.acme-living.dev/northlight' : `https://homes.acme-living.dev/${ad.campaignId}?utm_source=google`;
    });
    let down = true;
    const { ap, sent } = pilot(rig, { pages: (url) => (url.includes('northlight') && down ? { status: 503 } : { status: 200 }) });
    await ap.run({ kind: 'watch', accountId: ACCOUNT });
    assert.equal(rig.engine.store.list().length, 0, 'one failure is not enough');
    rig.clock.advanceMinutes(60);
    await ap.run({ kind: 'watch', accountId: ACCOUNT });
    const pause = rig.engine.store.list().find((p) => p.change.type === 'set_campaign_status' && p.change.campaignId === 'c-201');
    assert.ok(pause, 'the second failure proposes the pause');
    assert.ok(pause!.insight!.keys!.includes('page:https://homes.acme-living.dev/northlight'));
    assert.ok(sent.some((n) => n.urgent && n.title === 'Landing page down'));
    assert.equal(rig.engine.store.list().length, 1, 'only the campaign behind the broken page');

    await rig.engine.approve(pause!.id, { by: PERSON, channel: 'console' });
    await ap.run({ kind: 'apply_approved' });
    rig.clock.advanceMinutes(60);
    down = false;
    await ap.run({ kind: 'watch', accountId: ACCOUNT });
    const back = rig.engine.store.list().find((p) => p.change.type === 'set_campaign_status' && p.change.campaignId === 'c-201' && p.change.newStatus === 'ENABLED');
    assert.ok(back, 'back up: Autopilot proposes turning it on again');
    assert.equal(pageKey('https://a.dev/x?utm_source=g&id=2#top'), 'https://a.dev/x?id=2');
  } finally {
    rig.cleanup();
  }
});

test('quiet hours hold ordinary news, let urgent news through, then send one summary', async () => {
  const rig = makeRig();
  try {
    rig.clock.now = Date.parse('2026-11-21T05:00:00Z'); // 11 at night in Chicago
    const { ap, sent } = pilot(rig);
    await review(ap);
    assert.ok(sent.length > 0 && sent.every((n) => n.urgent), 'only urgent alerts at night');
    const held = ap.store.load().held.length;
    assert.ok(held > 0);
    rig.clock.now = Date.parse('2026-11-21T14:00:00Z'); // 8 in the morning
    const count = sent.length;
    await ap.run({ kind: 'deliver' });
    assert.equal(sent.length, count + 1);
    assert.equal(ap.store.load().held.length, 0);
  } finally {
    rig.cleanup();
  }
});

test('the hourly tick plans the daily review once, at the review hour', async () => {
  const rig = makeRig();
  try {
    const { ap } = pilot(rig);
    rig.clock.now = Date.parse('2026-11-21T11:00:00Z'); // 5 in the morning in Chicago
    let jobs = await ap.plan();
    assert.ok(!jobs.some((j) => j.kind === 'review'), 'not before the review hour');
    assert.ok(jobs.some((j) => j.kind === 'watch'));
    rig.clock.now = Date.parse('2026-11-21T13:17:00Z');
    jobs = await ap.plan();
    assert.ok(jobs.some((j) => j.kind === 'review'));
    // run the review in single steps, the way the cloud does
    let queue: Job[] = jobs.filter((j) => j.kind === 'review');
    let steps = 0;
    while (queue.length) {
      steps++;
      queue = [...(await ap.run(queue[0])), ...queue.slice(1)];
    }
    assert.ok(steps >= 4, 'a review is several small steps');
    jobs = await ap.plan();
    assert.ok(!jobs.some((j) => j.kind === 'review'), 'once a day');
    await ap.updateSettings({ on: false }, PERSON);
    assert.deepEqual(await ap.plan(), [{ kind: 'apply_approved' }], 'off means only finishing what a person approved');
  } finally {
    rig.cleanup();
  }
});

test('monthly pacing trims the least efficient budget when spend runs over the target', async () => {
  const rig = makeRig();
  try {
    const { ap } = pilot(rig);
    await ap.updateSettings({ monthlyTargets: { [ACCOUNT]: 4000 }, skills: { zero_leads: false } }, PERSON);
    await review(ap);
    const cut = rig.engine.store.list().find((p) => p.insight?.skill === 'pacing');
    assert.ok(cut, 'a budget cut is proposed');
    assert.equal(cut!.change.type, 'set_campaign_budget');
    assert.equal((cut!.change as { campaignId: string }).campaignId, 'c-302', 'the campaign with no leads gives up budget first');
    assert.ok((await ap.report()).feed.some((f) => f.skill === 'pacing' && /over your/.test(f.title)));
  } finally {
    rig.cleanup();
  }
});

test('a week after a change on a live account, a change that hurt gets an undo proposal', async () => {
  const rig = makeRig();
  try {
    const base = rig.backend;
    const applied = { day: '' };
    const live: AdsBackend = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      async getAccount(id: string): Promise<Account | undefined> {
        const a = await base.getAccount(id);
        return a ? { ...a, numbers: 'live' } : a;
      },
      async listAccounts() {
        return (await base.listAccounts()).map((a) => ({ ...a, numbers: 'live' as const }));
      },
      async getDailyMetrics(accountId: string, campaignId: string, days: number): Promise<DailyMetric[]> {
        const rows = await base.getDailyMetrics(accountId, campaignId, days);
        if (campaignId !== 'c-202' || !applied.day) return rows;
        const out: DailyMetric[] = [];
        const end = new Date(rig.clock.now - 86_400_000).toISOString().slice(0, 10);
        for (let i = days - 1; i >= 0; i--) {
          const date = new Date(Date.parse(`${end}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
          out.push({ date, impressions: 400, clicks: 16, cost: date > applied.day ? 50 : 39.6, conversions: date > applied.day ? (i % 3 === 0 ? 1 : 0) : 2 });
        }
        return out;
      },
    });
    const { ap } = pilot(rig, { backend: live });
    const p = await rig.engine.propose({ accountId: ACCOUNT, change: { type: 'set_campaign_budget', campaignId: 'c-202', newDailyBudget: 50 }, reason: 'Give the winner more room to run.', requestedBy: 'Autopilot', insight: { skill: 'budget_winners', keys: ['budget:c-202:up'] } });
    await rig.engine.approve(p.id, { by: PERSON, channel: 'console' });
    await rig.engine.apply(p.id, { actor: PERSON, human: true });
    applied.day = '2026-11-21';
    rig.clock.advanceMinutes(8 * 24 * 60 + 120);
    await ap.updateSettings({ accounts: { [ACCOUNT]: true }, skills: { wasted_searches: false, zero_leads: false, budget_winners: false, fair_housing: false } }, PERSON);
    await review(ap);
    const undo = rig.engine.store.list().find((x) => x.rollbackOf === p.id);
    assert.ok(undo, 'the undo is proposed');
    assert.equal(undo!.insight?.skill, 'outcomes');
    assert.equal(undo!.status, 'pending_approval');
    assert.ok((await ap.report()).feed.some((f) => f.kind === 'outcome' && f.level === 'warn'));
  } finally {
    rig.cleanup();
  }
});

test('settings are checked before they are saved', async () => {
  const s = defaultSettings();
  assert.throws(() => applySettingsPatch(s, { reviewHour: 25 }), /0 to 23/);
  assert.throws(() => applySettingsPatch(s, { timezone: 'Mars/Olympus' }), /time zone/);
  assert.throws(() => applySettingsPatch(s, { skills: { mind_reading: true } }), /no skill/);
  assert.throws(() => applySettingsPatch(s, { monthlyTargets: { '123-456-7890': 3 } }), /between/);
  const next = applySettingsPatch(s, { quiet: { from: 21, to: 6 }, skills: { pacing: false }, monthlyTargets: { '123-456-7890': 4000 } });
  assert.equal(next.quiet.from, 21);
  assert.equal(next.skills.pacing, false);
  assert.equal(next.monthlyTargets['123-456-7890'], 4000);
  assert.equal(inQuiet({ on: true, from: 22, to: 7, urgentAnyway: true }, 23), true);
  assert.equal(inQuiet({ on: true, from: 22, to: 7, urgentAnyway: true }, 7), false);
  assert.equal(inQuiet({ on: false, from: 22, to: 7, urgentAnyway: true }, 23), false);
  const rig = makeRig();
  try {
    const { ap } = pilot(rig);
    await assert.rejects(ap.updateSettings({ monthlyTargets: { '999-999-9999': 500 } }, PERSON), /Unknown account/);
    await ap.updateSettings({ reviewHour: 8 }, PERSON);
    assert.ok(rig.engine.audit.readAll().some((e) => e.type === 'autopilot_settings'), 'settings changes are in the audit log');
  } finally {
    rig.cleanup();
  }
});

test('AI copy is accepted only when it is clean, fits and says nothing new', () => {
  const ctx = { source: 'Juniper Yard\nModern 1 to 3 bedroom homes with in-unit laundry and a rooftop lounge.\nTour Juniper Yard Today', existing: ['Tour Juniper Yard Today'], limits: DEFAULT_POLICY.adCopy };
  assert.equal(checkLine('Rooftop Lounge', 'headline', ctx).ok, true);
  assert.equal(checkLine('Modern 1 to 3 Bedroom Homes', 'headline', ctx).ok, true);
  const no = (text: string, kind: 'headline' | 'description', why: RegExp) => {
    const r = checkLine(text, kind, ctx);
    assert.equal(r.ok, false, text);
    if (!r.ok) assert.match(r.why, why);
  };
  no('Rooftop Lounge Awaits You Today!', 'headline', /exclamation|characters/);
  no('2 Months Free', 'headline', /number 2/);
  no('Free Rooftop Lounge Access', 'headline', /free/);
  no('Ideal for Young Professionals', 'headline', /Fair Housing/);
  no('Great for Families', 'headline', /families|Fair Housing/);
  no('Fitness Center and Pool', 'headline', /fitness|pool/);
  no('Tour Juniper Yard Today', 'headline', /repeats/);
  no('Modern homes with in-unit laundry and a rooftop lounge, plus a very long line of text here.', 'description', /characters/);
  const picked = pickLines(['Free Parking', 'Rooftop Lounge', 'In-Unit Laundry'], 2, 'headline', ctx);
  assert.deepEqual(picked.lines, ['Rooftop Lounge', 'In-Unit Laundry']);
});

test('model answers are read in any of the shapes Workers AI uses', async () => {
  assert.deepEqual(parseJsonLoose('Sure! ```json\n{"exclude": ["a"], "keep": []}\n```'), { exclude: ['a'], keep: [] });
  assert.deepEqual(parseJsonLoose('thinking {not json} then {"ok": {"nested": true}}'), { ok: { nested: true } });
  assert.equal(parseJsonLoose('no json here'), undefined);
  assert.equal(textOf({ response: 'hi' }), 'hi');
  assert.equal(textOf({ choices: [{ message: { content: 'hello' } }] }), 'hello');
  let asked = '';
  const b = workersAiBrain({
    async run(model, input) {
      asked = model;
      if (model.includes('gemma')) throw new Error('capacity');
      assert.ok('max_tokens' in input);
      return { response: '{"exclude": ["apartment jobs", "made up term"], "keep": [{"term": "pet friendly apartments", "why": "renters search this"}]}' };
    },
  });
  const out = await b.checkTerms({ community: 'Juniper Yard', campaign: 'Generic', examples: [], terms: ['apartment jobs', 'pet friendly apartments', 'storage units near me'] });
  assert.match(asked, /llama/, 'falls back to the second model');
  assert.deepEqual(out.exclude, ['apartment jobs'], 'the AI can only remove terms from the list, never add one');
  assert.ok(out.keep.some((k) => k.term === 'storage units near me'), 'a term the AI did not clear stays');
});

test('results check: worse beyond luck, better, or no clear change', () => {
  const t = (days: number, cost: number, clicks: number, conversions: number) => ({ days, cost, clicks, conversions });
  assert.equal(judge('budget', t(14, 560, 220, 28), t(7, 350, 120, 3)).verdict, 'worse');
  assert.equal(judge('negatives', t(14, 840, 250, 14), t(7, 360, 110, 7)).verdict, 'better');
  assert.equal(judge('ad_text', t(14, 500, 200, 20), t(7, 250, 100, 10)).verdict, 'same');
  assert.equal(judge('budget', t(14, 100, 40, 2), t(7, 50, 20, 0)).verdict, 'unclear');
  assert.equal(judge('budget', t(14, 560, 220, 28), t(5, 200, 80, 1)).verdict, 'unclear');
});

test('landing page rules', () => {
  assert.equal(classify({ status: 200 }), 'up');
  assert.equal(classify({ status: 301 }), 'up');
  assert.equal(classify({ status: 404 }), 'down');
  assert.equal(classify({ status: 503 }), 'down');
  assert.equal(classify({ status: 403 }), 'unsure', 'a page that refuses robots is not down');
  assert.equal(classify({ error: 'timeout' }), 'down');
  assert.ok(skipReason('https://example.com/juniper-yard'));
  assert.ok(skipReason('http://127.0.0.1/x'));
  assert.equal(skipReason('https://debashishkumarbora.github.io/campaign-ops/'), undefined);
});
