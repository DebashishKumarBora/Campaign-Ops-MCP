import type { Change, DailyMetric } from '../types.js';
import { poissonCdf } from '../governance/pulse.js';
import { money, round2 } from '../util/format.js';

/**
 * The results check: a week after a change, did it help?
 *
 * It compares the days after the change with the two weeks before, using the
 * same Poisson odds as Pulse, so "worse" means worse beyond bad luck. Only
 * accounts with real numbers are judged; simulated numbers never move.
 */

export interface Totals {
  days: number;
  cost: number;
  clicks: number;
  conversions: number;
}

export function totals(rows: DailyMetric[]): Totals {
  return {
    days: rows.length,
    cost: round2(rows.reduce((s, r) => s + r.cost, 0)),
    clicks: rows.reduce((s, r) => s + r.clicks, 0),
    conversions: round2(rows.reduce((s, r) => s + r.conversions, 0)),
  };
}

export type OutcomeKind = 'budget' | 'negatives' | 'ad_text' | 'ad_paused' | 'campaign_paused';

export interface Judgment {
  verdict: 'better' | 'same' | 'worse' | 'unclear';
  /** One sentence for the feed. */
  why: string;
}

export function outcomeKind(change: Change): OutcomeKind | undefined {
  switch (change.type) {
    case 'set_campaign_budget':
      return 'budget';
    case 'add_negative_keywords':
      return 'negatives';
    case 'update_ad_text':
      return 'ad_text';
    case 'set_ad_status':
      return change.newStatus === 'PAUSED' ? 'ad_paused' : undefined;
    case 'set_campaign_status':
      return change.newStatus === 'PAUSED' ? 'campaign_paused' : undefined;
    default:
      return undefined;
  }
}

const perLead = (t: Totals) => (t.conversions > 0 ? t.cost / t.conversions : null);

/**
 * Judges one change. For a paused campaign, pass the other campaigns'
 * numbers: the question is whether pausing it cost leads elsewhere.
 */
export function judge(kind: OutcomeKind, before: Totals, after: Totals, currency = 'USD'): Judgment {
  const m = (n: number) => money(round2(n), currency);
  if (after.days < 7) return { verdict: 'unclear', why: 'Less than a week of numbers since the change.' };
  if (before.conversions < 5) return { verdict: 'unclear', why: 'Too few leads before the change to compare against.' };

  // What "no change" would look like, scaled to the days or the spend after the change.
  let expected: number;
  if (kind === 'budget') expected = after.cost * (before.conversions / Math.max(0.01, before.cost));
  else if (kind === 'ad_text') expected = after.clicks * (before.conversions / Math.max(1, before.clicks));
  else expected = (before.conversions / before.days) * after.days;

  const p = poissonCdf(Math.floor(after.conversions), expected);
  const cplBefore = perLead(before);
  const cplAfter = perLead(after);
  const cpl = cplBefore !== null && cplAfter !== null ? ` Cost per lead went from ${m(cplBefore)} to ${m(cplAfter)}.` : '';

  if (expected >= 3 && after.conversions < 0.7 * expected && p < 0.05) {
    const label = kind === 'campaign_paused' ? 'The other campaigns' : 'It';
    return { verdict: 'worse', why: `${label} brought ${round2(after.conversions)} leads where about ${expected.toFixed(1)} were expected, a drop that big happens by luck ${p < 0.01 ? 'less than 1 time in 100' : `about ${Math.max(1, Math.round(p * 100))} times in 100`}.${cpl}` };
  }
  const cheaper = cplBefore !== null && cplAfter !== null && cplAfter <= cplBefore * 0.9;
  const more = after.conversions >= expected * 1.1;
  if (kind === 'negatives' || kind === 'ad_paused' || kind === 'campaign_paused') {
    const spendBefore = before.cost / before.days;
    const spendAfter = after.cost / after.days;
    if (after.conversions >= 0.9 * expected && spendAfter < spendBefore * 0.97) {
      return { verdict: 'better', why: `Leads held at about ${round2(after.conversions / after.days)} a day while spend fell from ${m(spendBefore)} to ${m(spendAfter)} a day.${cpl}` };
    }
  }
  if (cheaper || more) return { verdict: 'better', why: `${round2(after.conversions)} leads against about ${expected.toFixed(1)} expected.${cpl}` };
  return { verdict: 'same', why: `About as many leads as expected (${round2(after.conversions)} against ${expected.toFixed(1)}).${cpl}` };
}
