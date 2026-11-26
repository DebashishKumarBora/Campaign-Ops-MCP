import type { AdsBackend } from '../backends/backend.js';
import type { Account, Ad, Campaign, Change, Policy, Proposal } from '../types.js';
import type { DiagnosticsReport } from '../governance/diagnostics.js';
import { categoryLabel, lintAd, normalizeForLint } from '../governance/fairHousing.js';
import { addDays, money, normalizeKeyword, round2, share } from '../util/format.js';
import { dayInZone } from '../util/time.js';
import type { Candidate } from './types.js';

/**
 * The fix skills: each turns what it finds into candidates (changes Autopilot
 * wants to propose). Candidates still pass every check in the engine, and a
 * person approves each one.
 */

const DAY = 86_400_000;

// ---------- memory ----------

export interface Memory {
  /** Keys not to propose now, with the reason (rejected, blocked, waiting, recently applied, AI said keep). */
  skip: Map<string, string>;
  /** "accountId|targetKey" for proposals that are waiting or approved. */
  openTargets: Set<string>;
  /** Campaigns with a pause waiting or approved. */
  pausing: Set<string>;
  /** Open proposals written by Autopilot. */
  openByAutopilot: number;
}

const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * What Autopilot must not propose right now, worked out from the proposals
 * themselves: a change you rejected or undid is left alone for 30 days, a
 * blocked one for 7, an expired one for 3, and anything already waiting is
 * not asked twice.
 */
export function buildMemory(proposals: Proposal[], extra: Record<string, { until: string; why: string }>, now: number): Memory {
  const skip = new Map<string, string>();
  const openTargets = new Set<string>();
  const pausing = new Set<string>();
  let openByAutopilot = 0;
  for (const p of proposals) {
    const open = p.status === 'pending_approval' || p.status === 'approved';
    if (open) {
      openTargets.add(`${p.accountId}|${p.targetKey}`);
      if (p.change.type === 'set_campaign_status' && p.change.newStatus === 'PAUSED') pausing.add(p.change.campaignId);
      if (p.insight) openByAutopilot++;
    }
    const keys = p.insight?.keys ?? [];
    if (!keys.length) continue;
    const decided = Date.parse(p.rejection?.at ?? p.appliedAt ?? p.createdAt);
    const age = now - decided;
    let why: string | undefined;
    if (open) why = `${p.id} is already waiting for you`;
    else if (p.status === 'rejected' && age < 30 * DAY) why = `you turned down ${p.id} on ${shortDay(p.rejection!.at)}`;
    else if (p.status === 'rolled_back' && age < 30 * DAY) why = `you undid ${p.id}`;
    else if (p.status === 'blocked' && age < 7 * DAY) why = `a check blocked ${p.id}`;
    else if (p.status === 'expired' && age < 3 * DAY) why = `${p.id} expired without an answer`;
    else if (p.status === 'applied' && age < 7 * DAY) why = `${p.id} changed it recently`;
    if (why) for (const k of keys) if (!skip.has(k)) skip.set(k, why);
  }
  for (const [k, v] of Object.entries(extra)) if (Date.parse(v.until) > now && !skip.has(k)) skip.set(k, v.why);
  return { skip, openTargets, pausing, openByAutopilot };
}

export function skippedBy(memory: Memory, keys: string[]): string | undefined {
  for (const k of keys) {
    const why = memory.skip.get(k);
    if (why) return why;
  }
  return undefined;
}

// ---------- context ----------

export interface ScanContext {
  backend: AdsBackend;
  policy: Policy;
  account: Account;
  campaigns: Campaign[];
  memory: Memory;
  proposals: Proposal[];
  now: number;
}

const mFor = (account: Account) => (n: number) => money(round2(n), account.currency);
/** Whole currency units for estimates: "$360", not "$360.00". */
export const roughly = (n: number, currency: string) => money(Math.round(n), currency).replace(/\.00$/, '');

// ---------- Fair Housing ----------

/** The current ad, minus the risky phrases, as the only facts new copy may use. */
export function safeSource(community: string, ad: Pick<Ad, 'headlines' | 'descriptions'>): string {
  const report = lintAd(ad.headlines, ad.descriptions);
  const lines = [...ad.headlines, ...ad.descriptions].map((line) => {
    let text = normalizeForLint(line);
    for (const f of report.findings) if (normalizeForLint(f.text) === text) text = text.replace(f.match, ' ');
    return text;
  });
  return [community, ...lines].join('\n');
}

function appliedFairHousingPause(proposals: Proposal[], adId: string): Proposal | undefined {
  return [...proposals]
    .reverse()
    .find((p) => p.status === 'applied' && p.insight?.skill === 'fair_housing' && p.change.type === 'set_ad_status' && p.change.adId === adId && p.change.newStatus === 'PAUSED');
}

export async function fairHousingCandidates(ctx: ScanContext, ads: Ad[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const A = ctx.policy.adCopy;
  for (const ad of ads) {
    const campaign = ctx.campaigns.find((c) => c.id === ad.campaignId);
    if (!campaign) continue;
    const report = lintAd(ad.headlines, ad.descriptions);

    if (report.status === 'clean') {
      // An ad Autopilot paused for its copy, now fixed: turn it back on.
      const pause = ad.status === 'PAUSED' ? appliedFairHousingPause(ctx.proposals, ad.id) : undefined;
      if (pause) {
        out.push({
          skill: 'fair_housing',
          accountId: ctx.account.id,
          campaignId: campaign.id,
          change: { type: 'set_ad_status', adId: ad.id, newStatus: 'ENABLED' },
          reason: `The copy of ad ${ad.id} now passes the Fair Housing screen, so it can run again. ${pause.id} paused it while the copy was fixed.`,
          insight: { skill: 'fair_housing', impact: 'Puts the fixed ad back in front of searchers', evidence: ['Every headline and description passes the Fair Housing screen.', `${pause.id} paused it on ${shortDay(pause.appliedAt!)}.`], keys: [`adenable:${ad.id}:${pause.id}`] },
          priority: 15,
        });
      }
      continue;
    }

    const flagged: Array<{ field: string; text: string; problem: string }> = [];
    for (const f of report.findings) {
      if (flagged.some((x) => x.field === f.field)) continue;
      flagged.push({ field: f.field, text: f.text, problem: `${f.message} (${categoryLabel(f.category)}; "${f.match}")` });
    }
    const evidence = flagged.map((f) => `${f.field}: "${f.text.replace(/[.!?]+$/, '')}". ${f.problem}`);

    if (ad.status === 'ENABLED' && report.status === 'block') {
      const siblings = ads.filter((x) => x.id !== ad.id && x.status === 'ENABLED' && x.campaignId === ad.campaignId && (ad.adGroupId ? x.adGroupId === ad.adGroupId : x.adGroupName === ad.adGroupName)).length;
      const caution = siblings
        ? `The other ${siblings === 1 ? 'ad' : `${siblings} ads`} in the ad group keep${siblings === 1 ? 's' : ''} running. Autopilot proposes new copy separately and turns this ad back on once the copy is fixed.`
        : 'This is the only active ad in its ad group, so the ad group stops showing until the fixed copy is approved. Autopilot proposes the new copy separately and turns the ad back on once it is fixed.';
      out.push({
        skill: 'fair_housing',
        accountId: ctx.account.id,
        campaignId: campaign.id,
        change: { type: 'set_ad_status', adId: ad.id, newStatus: 'PAUSED' },
        reason: `Ad ${ad.id} in ${campaign.name} has copy that risks a Fair Housing violation. Pausing it stops the copy from showing while compliant copy is approved.`,
        insight: { skill: 'fair_housing', impact: 'Stops risky copy from showing right away', evidence, caution, keys: [`adpause:${ad.id}`] },
        priority: 0,
        urgent: true,
      });
    }

    // The fallback: drop the flagged lines, if the ad still has enough of them.
    const flaggedFields = new Set(flagged.map((f) => f.field));
    const keepH = ad.headlines.filter((_, i) => !flaggedFields.has(`Headline ${i + 1}`));
    const keepD = ad.descriptions.filter((_, i) => !flaggedFields.has(`Description ${i + 1}`));
    const fallback: Change | undefined = keepH.length >= A.minHeadlines && keepD.length >= A.minDescriptions ? { type: 'update_ad_text', adId: ad.id, headlines: keepH, descriptions: keepD } : undefined;

    out.push({
      skill: 'fair_housing',
      accountId: ctx.account.id,
      campaignId: campaign.id,
      change: fallback ?? { type: 'update_ad_text', adId: ad.id, headlines: ad.headlines, descriptions: ad.descriptions },
      reason: `Replaces the ${flagged.length === 1 ? 'line' : `${flagged.length} lines`} in ad ${ad.id} (${campaign.name}) that failed the Fair Housing screen. The new copy describes the home, not who should live there.`,
      insight: { skill: 'fair_housing', impact: report.status === 'block' ? 'Removes a Fair Housing violation risk' : 'Removes wording a reviewer would question', evidence, keys: [`adtext:${ad.id}`] },
      priority: 5,
      urgent: report.status === 'block',
      ai: { kind: 'rewrite', community: campaign.community, adId: ad.id, headlines: ad.headlines, descriptions: ad.descriptions, flagged },
      fallback,
    });
  }
  return out;
}

// ---------- findings from the health check ----------

export async function findingCandidates(ctx: ScanContext, report: DiagnosticsReport, skills: { wasted: boolean; zero: boolean; budget: boolean }): Promise<Candidate[]> {
  const m = mFor(ctx.account);
  const out: Candidate[] = [];
  const days = report.overview.period.days || 30;
  const perMonth = (n: number) => round2((n / days) * 30);

  for (const f of report.findings) {
    const change = f.suggestedChange;
    if (!change) continue;

    if (f.kind === 'wasted_spend' && skills.wasted && change.type === 'add_negative_keywords') {
      const campaign = ctx.campaigns.find((c) => c.id === change.campaignId);
      if (!campaign) continue;
      const rows = await ctx.backend.getSearchTerms(ctx.account.id, { campaignId: campaign.id, days });
      const byTerm = new Map(rows.map((r) => [normalizeKeyword(r.term), r]));
      const terms = change.keywords
        .map((k) => normalizeKeyword(k.text))
        .filter((t) => !ctx.memory.skip.has(`neg:${campaign.id}:${t}`))
        .map((t) => ({ term: t, cost: byTerm.get(t)?.cost ?? 0, clicks: byTerm.get(t)?.clicks ?? 0 }));
      if (!terms.length) continue;
      const cost = round2(terms.reduce((s, t) => s + t.cost, 0));
      const examples = rows
        .filter((r) => r.conversions > 0)
        .sort((a, b) => b.conversions - a.conversions)
        .slice(0, 6)
        .map((r) => r.term);
      out.push({
        skill: 'wasted_searches',
        accountId: ctx.account.id,
        campaignId: campaign.id,
        change: { type: 'add_negative_keywords', campaignId: campaign.id, keywords: terms.map((t) => ({ text: t.term, matchType: 'PHRASE' as const })) },
        reason: `These searches spent ${m(cost)} in the last ${days} days in ${campaign.name} and never brought a lead. None of them is about renting a home at ${campaign.community}.`,
        insight: {
          skill: 'wasted_searches',
          impact: `About ${roughly(perMonth(cost), ctx.account.currency)} a month saved`,
          impactMonthly: perMonth(cost),
          evidence: terms.map((t) => `"${t.term}": ${m(t.cost)}, ${t.clicks} clicks, no leads`),
          keys: terms.map((t) => `neg:${campaign.id}:${t.term}`),
        },
        priority: 20,
        ai: { kind: 'search_terms', community: campaign.community, campaign: campaign.name, examples, terms },
      });
    }

    if (f.kind === 'zero_conversion_campaign' && skills.zero && change.type === 'set_campaign_status') {
      const c = report.overview.campaigns.find((x) => x.id === change.campaignId);
      if (!c) continue;
      out.push({
        skill: 'zero_leads',
        accountId: ctx.account.id,
        campaignId: c.id,
        change,
        reason: f.suggestedReason ?? `${c.name} spends without leads.`,
        insight: {
          skill: 'zero_leads',
          impact: `About ${roughly(perMonth(c.cost), ctx.account.currency)} a month saved`,
          impactMonthly: perMonth(c.cost),
          evidence: [`${m(c.cost)} spent in ${days} days`, `${c.clicks.toLocaleString('en-US')} clicks and ${c.impressions.toLocaleString('en-US')} impressions`, 'No leads in that time'],
          caution: 'If this campaign is meant to build awareness rather than bring leads, turn it down and Autopilot will not ask again for 30 days.',
          keys: [`status:${c.id}:PAUSED`],
        },
        priority: 30,
      });
    }

    if (f.kind === 'budget_limited_winner' && skills.budget && change.type === 'set_campaign_budget') {
      const c = report.overview.campaigns.find((x) => x.id === change.campaignId);
      if (!c || c.cpa === null) continue;
      const extra = round2((change.newDailyBudget - c.dailyBudget) * 30);
      const leads = Math.round(extra / c.cpa);
      out.push({
        skill: 'budget_winners',
        accountId: ctx.account.id,
        campaignId: c.id,
        change,
        reason: f.suggestedReason ?? `${c.name} converts well but runs out of budget.`,
        insight: {
          skill: 'budget_winners',
          impact: leads > 0 ? `About ${leads} more lead${leads === 1 ? '' : 's'} a month for up to ${roughly(extra, ctx.account.currency)} more spend` : `Up to ${roughly(extra, ctx.account.currency)} more a month in spend`,
          evidence: [
            `Cost per lead ${m(c.cpa)}, against ${report.overview.totals.cpa !== null ? m(report.overview.totals.cpa) : 'n/a'} for the account`,
            `Spends ${share(c.budgetUtilization)} of its ${m(c.dailyBudget)} daily budget`,
            `Loses about ${share(c.searchLostIsBudget ?? 0)} of possible impressions because the budget runs out`,
          ],
          keys: [`budget:${c.id}:up`],
        },
        priority: 40,
      });
    }
  }
  return out;
}

// ---------- monthly pacing ----------

export interface PaceResult {
  candidates: Candidate[];
  /** A line for the feed, whether or not anything is proposed. */
  note?: { level: 'info' | 'warn' | 'good'; title: string; detail: string };
}

export async function pacingCandidates(ctx: ScanContext, target: number): Promise<PaceResult> {
  const m = mFor(ctx.account);
  const today = dayInZone(ctx.now, ctx.account.timezone);
  const monthStart = `${today.slice(0, 8)}01`;
  const yesterday = addDays(today, -1);
  const dayOfMonth = Number(today.slice(8, 10));
  const [y, mo] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const elapsed = dayOfMonth - 1;
  if (elapsed < 3) return { candidates: [] };
  const enabled = ctx.campaigns.filter((c) => c.status === 'ENABLED');
  const stats: Array<{ c: Campaign; mtd: number; daily: number; conv: number; cost30: number }> = [];
  for (const c of enabled) {
    const rows = await ctx.backend.getDailyMetrics(ctx.account.id, c.id, 31);
    const month = rows.filter((r) => r.date >= monthStart && r.date <= yesterday);
    const last7 = rows.slice(-7);
    stats.push({
      c,
      mtd: month.reduce((s, r) => s + r.cost, 0),
      daily: last7.length ? last7.reduce((s, r) => s + r.cost, 0) / last7.length : 0,
      conv: rows.reduce((s, r) => s + r.conversions, 0),
      cost30: rows.reduce((s, r) => s + r.cost, 0),
    });
  }
  const mtd = round2(stats.reduce((s, x) => s + x.mtd, 0));
  const daily = stats.reduce((s, x) => s + x.daily, 0);
  const remaining = daysInMonth - elapsed;
  const projected = round2(mtd + daily * remaining);
  const detail = `${m(mtd)} spent so far this month. At the last week's pace the month ends near ${m(projected)}, against your target of ${m(target)}.`;
  if (projected <= target * 1.05) {
    return projected < target * 0.85
      ? { candidates: [], note: { level: 'info', title: `Spending under your ${m(target)} monthly target`, detail: `${detail} Raising budgets only helps where campaigns run out of money; Budget for winners proposes that when it does.` } }
      : { candidates: [], note: { level: 'good', title: `On pace for your ${m(target)} monthly target`, detail } };
  }

  let toCut = (projected - target) / remaining;
  const P = ctx.policy.budgets;
  const month = today.slice(0, 7);
  const candidates: Candidate[] = [];
  // The least efficient campaigns give up budget first; a campaign with no leads is the least efficient.
  const cplOf = (s: { conv: number; cost30: number }) => (s.conv > 0 ? s.cost30 / s.conv : Number.POSITIVE_INFINITY);
  const order = stats
    .filter((s) => s.daily > 0)
    .sort((a, b) => {
      const ca = cplOf(a);
      const cb = cplOf(b);
      if (ca === cb) return b.daily - a.daily;
      return ca > cb ? -1 : 1;
    });
  for (const s of order) {
    if (toCut <= 0.5 || candidates.length >= 3) break;
    const keys = [`pace:${s.c.id}:${month}`];
    if (ctx.memory.skip.has(keys[0]) || ctx.memory.pausing.has(s.c.id)) continue;
    const floor = Math.max(P.minCampaignDailyBudget, round2(s.c.dailyBudget * (1 - P.maxDecreasePct / 100)));
    const wanted = round2(Math.min(s.c.dailyBudget, s.daily) - toCut);
    const next = Math.max(floor, Math.round(wanted));
    if (next >= s.c.dailyBudget - 0.5) continue;
    const saved = Math.max(0, s.daily - next);
    toCut -= saved;
    const cpl = s.conv ? m(s.cost30 / s.conv) : 'no leads';
    candidates.push({
      skill: 'pacing',
      accountId: ctx.account.id,
      campaignId: s.c.id,
      change: { type: 'set_campaign_budget', campaignId: s.c.id, newDailyBudget: next },
      reason: `${ctx.account.name} is on track to spend ${m(projected)} this month against a ${m(target)} target. ${s.c.name} has the weakest cost per lead (${cpl}), so it gives up budget first.`,
      insight: {
        skill: 'pacing',
        impact: `About ${roughly(saved * remaining, ctx.account.currency)} less spend by the end of the month`,
        impactMonthly: round2(saved * 30),
        evidence: [detail, `${s.c.name}: ${m(s.daily)} a day over the last week, cost per lead ${cpl}`],
        keys,
      },
      priority: 35,
    });
  }
  return {
    candidates,
    note: { level: 'warn', title: `Heading over your ${m(target)} monthly target`, detail: candidates.length ? `${detail} Autopilot proposes trimming ${candidates.length === 1 ? 'one budget' : `${candidates.length} budgets`}.` : `${detail} No budget can be trimmed within your guardrails, so this needs a person.` },
  };
}

// ---------- fuller ads ----------

export function refreshCandidate(ctx: ScanContext, ads: Ad[], spendByCampaign: Map<string, number>): Candidate | undefined {
  const A = ctx.policy.adCopy;
  const wantH = Math.min(A.maxHeadlines, 8);
  const wantD = Math.min(A.maxDescriptions, 4);
  const options = ads
    .filter((ad) => ad.status === 'ENABLED')
    .filter((ad) => {
      const c = ctx.campaigns.find((x) => x.id === ad.campaignId);
      return c && c.status === 'ENABLED' && c.channel === 'SEARCH';
    })
    .filter((ad) => lintAd(ad.headlines, ad.descriptions).status === 'clean')
    .filter((ad) => ad.headlines.length < Math.min(6, wantH) || ad.descriptions.length < Math.min(3, wantD))
    .filter((ad) => !ctx.memory.skip.has(`refresh:${ad.id}`) && !ctx.memory.skip.has(`adtext:${ad.id}`) && !ctx.memory.openTargets.has(`${ctx.account.id}|ad:${ad.id}:text`))
    .sort((a, b) => (spendByCampaign.get(b.campaignId) ?? 0) - (spendByCampaign.get(a.campaignId) ?? 0));
  const ad = options[0];
  if (!ad) return undefined;
  const campaign = ctx.campaigns.find((c) => c.id === ad.campaignId)!;
  const addHeadlines = Math.max(0, wantH - ad.headlines.length);
  const addDescriptions = Math.max(0, wantD - ad.descriptions.length);
  return {
    skill: 'ad_refresh',
    accountId: ctx.account.id,
    campaignId: campaign.id,
    change: { type: 'update_ad_text', adId: ad.id, headlines: ad.headlines, descriptions: ad.descriptions },
    reason: `Ad ${ad.id} in ${campaign.name} has ${ad.headlines.length} headlines and ${ad.descriptions.length} descriptions. Google mixes and matches lines, so more good lines give it more ways to match each search. The new lines only restate what the ad already says.`,
    insight: { skill: 'ad_refresh', impact: 'More combinations for Google to test', evidence: [`Now: ${ad.headlines.length} headlines, ${ad.descriptions.length} descriptions`, `Google allows up to ${A.maxHeadlines} headlines and ${A.maxDescriptions} descriptions`], keys: [`refresh:${ad.id}`] },
    priority: 60,
    ai: { kind: 'more_copy', community: campaign.community, adId: ad.id, headlines: ad.headlines, descriptions: ad.descriptions, addHeadlines, addDescriptions },
  };
}
