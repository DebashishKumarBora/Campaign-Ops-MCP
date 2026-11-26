import type { AdsBackend } from '../backends/backend.js';
import type { Campaign, DailyMetric } from '../types.js';
import { UserError } from '../types.js';
import { money, round2 } from '../util/format.js';

/**
 * Pulse: day-by-day alarms that a monthly report misses.
 *
 * The most expensive failures in an ad account are silent: conversion
 * tracking breaks, a campaign stops spending, or spend jumps overnight.
 * Pulse reads each campaign's daily numbers and raises an alarm only when the
 * pattern is very unlikely to be chance. Every alarm says how unlikely, using
 * a Poisson model of leads per click, so a person can judge how much to trust it.
 *
 * Pulse never changes anything. It explains what to check.
 */

export type PulseKind = 'tracking_outage' | 'stopped_spending' | 'spend_spike' | 'lead_drop';

export interface PulseAlarm {
  id: string;
  kind: PulseKind;
  severity: 'high' | 'medium';
  campaignId: string;
  campaignName: string;
  title: string;
  detail: string;
  /** How unlikely the pattern is by chance, in plain words, when it can be computed. */
  odds?: string;
  /** The daily series behind the alarm, for a chart. The suspicious part starts at highlightFrom. */
  evidence: { dates: string[]; clicks: number[]; conversions: number[]; cost: number[]; highlightFrom: number };
  nextSteps: string[];
}

export interface PulseReport {
  account: { id: string; name: string; mode: string; numbers?: string };
  period: { days: number; from: string; to: string };
  checkedCampaigns: number;
  alarms: PulseAlarm[];
  headline: string;
  notes: string[];
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** 2026-11-23 becomes "Nov 23", which reads better in a chat and on the console. */
function day(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** P(X <= k) for a Poisson variable with mean lambda. */
export function poissonCdf(k: number, lambda: number): number {
  if (lambda <= 0) return 1;
  let term = Math.exp(-lambda);
  let total = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    total += term;
  }
  return Math.min(1, total);
}

function oddsLabel(p: number): string {
  if (p < 0.001) return 'under 1 in 1,000';
  if (p < 0.01) return `about 1 in ${Math.round(1 / p).toLocaleString('en-US')}`;
  if (p < 0.05) return `about 1 in ${Math.round(1 / p)}`;
  return `about ${Math.round(p * 100)}%`;
}

function evidence(rows: DailyMetric[], highlightFrom: number): PulseAlarm['evidence'] {
  const tail = rows.slice(-21);
  const offset = rows.length - tail.length;
  return {
    dates: tail.map((r) => r.date),
    clicks: tail.map((r) => r.clicks),
    conversions: tail.map((r) => r.conversions),
    cost: tail.map((r) => r.cost),
    highlightFrom: Math.max(0, highlightFrom - offset),
  };
}

function check(c: Campaign, rows: DailyMetric[], currency: string): Omit<PulseAlarm, 'id'>[] {
  const out: Omit<PulseAlarm, 'id'>[] = [];
  const m = (n: number) => money(n, currency);
  if (rows.length < 14) return out;

  // 1. Tracking outage: leads stop while clicks keep coming.
  let tail = 0;
  for (let i = rows.length - 1; i >= 0 && tail < 7 && rows[i].conversions === 0; i--) tail++;
  let outage = false;
  if (tail >= 2) {
    const base = rows.slice(0, rows.length - tail);
    const recent = rows.slice(rows.length - tail);
    const baseConv = sum(base.map((r) => r.conversions));
    const baseClicks = sum(base.map((r) => r.clicks));
    const tailClicks = sum(recent.map((r) => r.clicks));
    if (base.length >= 10 && baseConv >= 5 && baseClicks > 0) {
      const rate = baseConv / baseClicks;
      const expected = tailClicks * rate;
      const trafficHeld = tailClicks / tail >= 0.5 * (baseClicks / base.length);
      if (expected >= 3 && trafficHeld) {
        const p = Math.exp(-expected);
        outage = true;
        out.push({
          kind: 'tracking_outage',
          severity: p < 0.02 ? 'high' : 'medium',
          campaignId: c.id,
          campaignName: c.name,
          title: `${c.name}: no leads for ${tail} days while clicks kept coming`,
          detail: `${tailClicks} clicks since ${day(recent[0].date)} and no leads. At its usual rate of ${(rate * 100).toFixed(1)} leads per 100 clicks, about ${expected.toFixed(1)} were expected. The chance of zero by bad luck is ${oddsLabel(p)}, so broken conversion tracking is the likely cause, not the ads.`,
          odds: oddsLabel(p),
          evidence: evidence(rows, rows.length - tail),
          nextSteps: [
            'Submit a test lead on the website and confirm it reaches Google Ads within a few hours.',
            'In Google Ads, check the status of the lead conversion action under Goals.',
            `Ask whether the website, the lead form or the tracking tags changed around ${day(recent[0].date)}.`,
            'Hold budget and bid changes on this campaign until tracking is confirmed. Automated bidding learns from conversions and will react to the false drop.',
          ],
        });
      }
    }
  }

  // 2. Stopped spending: an enabled campaign that suddenly spends nothing.
  if (c.status === 'ENABLED') {
    const base = rows.slice(0, -2);
    const last2 = rows.slice(-2);
    const baseAvg = sum(base.map((r) => r.cost)) / Math.max(1, base.length);
    if (baseAvg >= 5 && last2.every((r) => r.cost === 0)) {
      out.push({
        kind: 'stopped_spending',
        severity: 'high',
        campaignId: c.id,
        campaignName: c.name,
        title: `${c.name} stopped spending 2 days ago`,
        detail: `It spent about ${m(round2(baseAvg))} a day, then nothing since ${day(last2[0].date)}, while the campaign is still enabled.`,
        evidence: evidence(rows, rows.length - 2),
        nextSteps: [
          'Check the ads in this campaign for disapprovals or limited status.',
          'Check the account billing page for a payment problem.',
          'Check the campaign end date, ad schedule and budget.',
        ],
      });
    }
  }

  // 3. Spend spike: yesterday far above the usual daily spend.
  {
    const prev = rows.slice(-15, -1);
    const last = rows[rows.length - 1];
    const avg = sum(prev.map((r) => r.cost)) / Math.max(1, prev.length);
    if (avg > 0 && last.cost >= 1.6 * avg && last.cost - avg >= 20) {
      out.push({
        kind: 'spend_spike',
        severity: last.cost >= 2.5 * avg ? 'high' : 'medium',
        campaignId: c.id,
        campaignName: c.name,
        title: `${c.name} spent ${(last.cost / avg).toFixed(1)} times its usual amount yesterday`,
        detail: `${m(last.cost)} on ${day(last.date)}, against an average of ${m(round2(avg))} a day over the previous two weeks.`,
        evidence: evidence(rows, rows.length - 1),
        nextSteps: [
          "Look at yesterday's search terms for this campaign for new, irrelevant searches.",
          'Check the change history for new keywords, broader match types or a bid strategy change.',
          'If the spend is not paying off, propose a budget cut or negative keywords through Campaign Ops.',
        ],
      });
    }
  }

  // 4. Lead drop: far fewer leads per click this week than before (skipped when tracking is already flagged).
  if (!outage && rows.length >= 28) {
    const base = rows.slice(-28, -7);
    const week = rows.slice(-7);
    const baseConv = sum(base.map((r) => r.conversions));
    const baseClicks = sum(base.map((r) => r.clicks));
    const weekClicks = sum(week.map((r) => r.clicks));
    const weekConv = sum(week.map((r) => r.conversions));
    if (baseClicks > 0 && baseConv >= 10) {
      const expected = weekClicks * (baseConv / baseClicks);
      const p = poissonCdf(Math.floor(weekConv), expected);
      if (expected >= 6 && weekConv <= 0.5 * expected && p < 0.05) {
        out.push({
          kind: 'lead_drop',
          severity: p < 0.005 ? 'high' : 'medium',
          campaignId: c.id,
          campaignName: c.name,
          title: `${c.name}: leads fell to ${round2(weekConv)} this week (about ${expected.toFixed(1)} expected)`,
          detail: `Clicks held up (${weekClicks} in 7 days), but leads per click fell by more than half. The chance of a drop this large by luck is ${oddsLabel(p)}.`,
          odds: oddsLabel(p),
          evidence: evidence(rows, rows.length - 7),
          nextSteps: [
            'Open the landing page on a phone and submit the form to make sure it still works.',
            'Check whether the offer, prices or availability on the page changed this week.',
            'Compare this week\'s search terms with last month\'s for a shift in intent.',
          ],
        });
      }
    }
  }
  return out;
}

export async function checkPulse(backend: AdsBackend, accountId: string, opts: { days?: number } = {}): Promise<PulseReport> {
  const account = await backend.getAccount(accountId);
  if (!account) throw new UserError(`Unknown account ${accountId}. Call list_accounts for valid IDs.`);
  const days = Math.max(14, Math.min(60, Math.round(opts.days ?? 28)));
  const campaigns = (await backend.listCampaigns(accountId)).filter((c) => c.status === 'ENABLED');
  const found: Omit<PulseAlarm, 'id'>[] = [];
  let from = '';
  let to = '';
  for (const c of campaigns) {
    const rows = await backend.getDailyMetrics(accountId, c.id, days);
    if (rows.length) {
      if (!from || rows[0].date < from) from = rows[0].date;
      if (!to || rows[rows.length - 1].date > to) to = rows[rows.length - 1].date;
    }
    found.push(...check(c, rows, account.currency));
  }
  const order = { high: 0, medium: 1 } as const;
  const kindOrder: Record<PulseKind, number> = { tracking_outage: 0, stopped_spending: 1, spend_spike: 2, lead_drop: 3 };
  found.sort((a, b) => order[a.severity] - order[b.severity] || kindOrder[a.kind] - kindOrder[b.kind]);
  const alarms: PulseAlarm[] = found.map((a, i) => ({ ...a, id: `A${i + 1}` }));

  const notes: string[] = [];
  const outages = alarms.filter((a) => a.kind === 'tracking_outage');
  const starts = new Set(outages.map((a) => a.evidence.dates[a.evidence.highlightFrom]));
  if (outages.length >= 2 && starts.size === 1) notes.push('Several campaigns stopped recording leads on the same day. That points to one site-wide tracking problem, not separate campaign problems.');
  if (account.numbers === 'simulated') notes.push('Google Ads test accounts never serve ads, so these numbers are simulated. The alarms show how Pulse works on a real account.');
  if (account.numbers === 'synthetic') notes.push('Sandbox account: all data is synthetic, with problems planted on purpose.');
  notes.push('Pulse never changes anything. Each alarm lists what to check, and any fix still goes through a proposal and human approval.');

  const headline = alarms.length
    ? `${alarms.length} alarm${alarms.length === 1 ? '' : 's'} in ${new Set(alarms.map((a) => a.campaignId)).size} campaign${new Set(alarms.map((a) => a.campaignId)).size === 1 ? '' : 's'}: ${alarms[0].title}.`
    : `All quiet. No tracking outages, stalled campaigns, spend spikes or lead drops in the last ${days} days.`;

  return {
    account: { id: account.id, name: account.name, mode: account.mode, numbers: account.numbers },
    period: { days, from, to },
    checkedCampaigns: campaigns.length,
    alarms,
    headline,
    notes,
  };
}
