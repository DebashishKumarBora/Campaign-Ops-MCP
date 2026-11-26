import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPulse, poissonCdf } from '../src/governance/pulse.js';
import type { AdsBackend, MutateResult } from '../src/backends/backend.js';
import type { Account, Ad, Campaign, DailyMetric, NegativeKeyword, SearchTermRow } from '../src/types.js';
import { addDays } from '../src/util/format.js';
import { ACCOUNT, makeRig } from './helpers.js';

/** A tiny backend with hand-made daily numbers, to test each alarm in isolation. */
class Numbers implements AdsBackend {
  readonly mode = 'google_ads' as const;
  readonly account: Account = { id: '111-111-1111', name: 'Numbers', currency: 'USD', timezone: 'America/Chicago', mode: 'google_ads', numbers: 'live' };
  readonly campaigns: Campaign[] = [];
  readonly metrics = new Map<string, DailyMetric[]>();
  add(name: string, rows: DailyMetric[], status: Campaign['status'] = 'ENABLED'): string {
    const id = String(this.campaigns.length + 1);
    this.campaigns.push({ id, accountId: this.account.id, name, community: name, channel: 'SEARCH', status, dailyBudget: 100 });
    this.metrics.set(id, rows);
    return id;
  }
  async listAccounts() { return [this.account]; }
  async getAccount(id: string) { return id === this.account.id ? this.account : undefined; }
  async listCampaigns() { return this.campaigns; }
  async getCampaign(_a: string, id: string) { return this.campaigns.find((c) => c.id === id); }
  async getDailyMetrics(_a: string, id: string, days: number) { return (this.metrics.get(id) ?? []).slice(-days); }
  async getSearchTerms(): Promise<SearchTermRow[]> { return []; }
  async listAds(): Promise<Ad[]> { return []; }
  async getAd(): Promise<Ad | undefined> { return undefined; }
  async listNegatives(): Promise<NegativeKeyword[]> { return []; }
  async mutate(): Promise<MutateResult> { return { ok: false, errors: ['read only'] }; }
}

/** n days ending 2026-11-20, from a function of the day index (0 = oldest). */
function series(n: number, f: (i: number) => Partial<DailyMetric>): DailyMetric[] {
  return Array.from({ length: n }, (_, i) => ({ date: addDays('2026-11-20', i - (n - 1)), impressions: 500, clicks: 40, cost: 90, conversions: 3, ...f(i) }));
}

test('the sandbox has one planted alarm: tracking on Juniper Yard Brand stopped, with the odds', async () => {
  const rig = makeRig();
  try {
    const report = await checkPulse(rig.backend, ACCOUNT, { days: 28 });
    assert.equal(report.alarms.length, 1, report.alarms.map((a) => a.title).join(' | '));
    const a = report.alarms[0];
    assert.equal(a.kind, 'tracking_outage');
    assert.equal(a.severity, 'high');
    assert.equal(a.campaignId, 'c-101');
    assert.match(a.title, /no leads for 3 days while clicks kept coming/);
    assert.match(a.odds!, /^(about 1 in [\d,]+|under 1 in 1,000)$/);
    assert.match(a.detail, /since Nov 18/);
    assert.equal(a.evidence.dates.length, 21);
    assert.deepEqual(a.evidence.conversions.slice(a.evidence.highlightFrom), [0, 0, 0]);
    assert.ok(a.nextSteps.some((s) => /test lead/.test(s)));
    assert.ok(report.notes.some((n) => /Sandbox account/.test(n)));
    assert.match(report.headline, /^1 alarm in 1 campaign/);
  } finally {
    rig.cleanup();
  }
});

test('healthy, noisy numbers raise no alarm', async () => {
  const b = new Numbers();
  const wobble = [2, 4, 3, 1, 5, 3, 2, 4, 3, 3];
  b.add('Steady', series(28, (i) => ({ clicks: 36 + (i % 7), cost: 80 + (i % 5) * 6, conversions: wobble[i % wobble.length] })));
  b.add('Small but fine', series(28, (i) => ({ clicks: 6, cost: 12, conversions: i % 4 === 0 ? 1 : 0 })));
  b.add('Paused one', series(28, () => ({ clicks: 0, cost: 0, conversions: 0 })), 'PAUSED');
  const report = await checkPulse(b, b.account.id, { days: 28 });
  assert.deepEqual(report.alarms, []);
  assert.equal(report.checkedCampaigns, 2, 'paused campaigns are not checked');
  assert.match(report.headline, /^All quiet/);
});

test('a lead drop with steady clicks is flagged with how unlikely it is', async () => {
  const b = new Numbers();
  const id = b.add('Dropping', series(28, (i) => (i >= 21 ? { conversions: i % 2 ? 1 : 0, clicks: 42 } : { conversions: 4, clicks: 40 })));
  const report = await checkPulse(b, b.account.id, { days: 28 });
  assert.equal(report.alarms.length, 1);
  const a = report.alarms[0];
  assert.equal(a.kind, 'lead_drop');
  assert.equal(a.campaignId, id);
  assert.equal(a.severity, 'high');
  assert.match(a.detail, /fell by more than half/);
  assert.ok(a.odds);
});

test('a site-wide outage is called one problem, not many', async () => {
  const b = new Numbers();
  b.add('One', series(28, (i) => (i >= 25 ? { conversions: 0 } : {})));
  b.add('Two', series(28, (i) => (i >= 25 ? { conversions: 0 } : {})));
  const report = await checkPulse(b, b.account.id, { days: 28 });
  assert.deepEqual(report.alarms.map((a) => a.kind), ['tracking_outage', 'tracking_outage']);
  assert.ok(report.notes.some((n) => /one site-wide tracking problem/.test(n)));
});

test('short histories are skipped rather than guessed at', async () => {
  const b = new Numbers();
  b.add('New', series(10, (i) => (i >= 8 ? { conversions: 0, cost: 0 } : {})));
  const report = await checkPulse(b, b.account.id, { days: 28 });
  assert.deepEqual(report.alarms, []);
});

test('poisson odds', () => {
  assert.ok(Math.abs(poissonCdf(0, 2) - Math.exp(-2)) < 1e-12);
  assert.ok(Math.abs(poissonCdf(2, 2) - 5 * Math.exp(-2)) < 1e-12);
  assert.equal(poissonCdf(3, 0), 1);
});
