import type { AdsBackend } from '../backends/backend.js';
import type { Campaign, Change, DailyMetric, Policy } from '../types.js';
import { UserError } from '../types.js';
import { categoryLabel, lintAd, protectedTermIn } from './fairHousing.js';
import { negativeMatches } from './changes.js';
import { money, round2, share } from '../util/format.js';

export const GOOGLE_ADS_LIVE_NOTE =
  'Live Google Ads account: these are real numbers from Google. Changes stay off until a person opens a time-limited change window in the approval console, and every change still needs approval.';

export const GOOGLE_ADS_TEST_NOTE =
  'Google Ads test account: campaigns, budgets, keywords and ads are real, and every change goes to Google. Performance numbers (spend, clicks, leads, search terms) are simulated, because test accounts never show ads.';

/**
 * Deterministic diagnostics. The tools do the math so the AI can focus on
 * judgment and explanation, and so results are the same on every run.
 */

export interface CampaignSummary {
  id: string;
  name: string;
  community: string;
  channel: Campaign['channel'];
  status: Campaign['status'];
  dailyBudget: number;
  cost: number;
  avgDailyCost: number;
  budgetUtilization: number;
  clicks: number;
  impressions: number;
  conversions: number;
  cpa: number | null;
  searchLostIsBudget: number | null;
}

export interface AccountOverview {
  account: { id: string; name: string; currency: string; mode: string };
  period: { days: number; from: string; to: string };
  totals: { cost: number; clicks: number; conversions: number; cpa: number | null; enabledDailyBudget: number };
  campaigns: CampaignSummary[];
}

export type FindingKind = 'ad_copy_compliance' | 'wasted_spend' | 'budget_limited_winner' | 'zero_conversion_campaign';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  estimatedMonthlyImpact?: string;
  suggestedChange?: Change;
  suggestedReason?: string;
  needsCopywriting?: { adId: string; currentHeadlines: string[]; currentDescriptions: string[]; flagged: string[] };
  /** A quick, reversible way to stop the risk while the proper fix is prepared (for example pausing a flagged ad). */
  stopgapChange?: Change;
  stopgapReason?: string;
}

export interface DiagnosticsReport {
  overview: AccountOverview;
  findings: Finding[];
  protectedTermsNotNegated: Array<{ campaign: string; term: string; cost: number; protectedCategory: string; note: string }>;
  notes: string[];
}

function summarize(c: Campaign, rows: DailyMetric[]): CampaignSummary {
  const cost = round2(rows.reduce((s, r) => s + r.cost, 0));
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const conversions = rows.reduce((s, r) => s + r.conversions, 0);
  const lost = rows.filter((r) => typeof r.searchLostIsBudget === 'number');
  const avgDailyCost = rows.length ? round2(cost / rows.length) : 0;
  return {
    id: c.id,
    name: c.name,
    community: c.community,
    channel: c.channel,
    status: c.status,
    dailyBudget: c.dailyBudget,
    cost,
    avgDailyCost,
    budgetUtilization: c.dailyBudget > 0 ? round2(avgDailyCost / c.dailyBudget) : 0,
    clicks,
    impressions,
    conversions,
    cpa: conversions > 0 ? round2(cost / conversions) : null,
    searchLostIsBudget: lost.length ? round2(lost.reduce((s, r) => s + (r.searchLostIsBudget ?? 0), 0) / lost.length) : null,
  };
}

export async function accountOverview(backend: AdsBackend, accountId: string, days: number): Promise<AccountOverview> {
  const account = await backend.getAccount(accountId);
  if (!account) throw new UserError(`Unknown account ${accountId}. Call list_accounts for valid IDs.`);
  const campaigns = await backend.listCampaigns(accountId);
  const summaries: CampaignSummary[] = [];
  let from = '';
  let to = '';
  for (const c of campaigns) {
    const rows = await backend.getDailyMetrics(accountId, c.id, days);
    if (rows.length) {
      if (!from || rows[0].date < from) from = rows[0].date;
      if (!to || rows[rows.length - 1].date > to) to = rows[rows.length - 1].date;
    }
    summaries.push(summarize(c, rows));
  }
  const cost = round2(summaries.reduce((s, c) => s + c.cost, 0));
  const conversions = summaries.reduce((s, c) => s + c.conversions, 0);
  return {
    account: { id: account.id, name: account.name, currency: account.currency, mode: account.mode },
    period: { days, from, to },
    totals: {
      cost,
      clicks: summaries.reduce((s, c) => s + c.clicks, 0),
      conversions,
      cpa: conversions > 0 ? round2(cost / conversions) : null,
      enabledDailyBudget: round2(campaigns.filter((c) => c.status === 'ENABLED').reduce((s, c) => s + c.dailyBudget, 0)),
    },
    campaigns: summaries,
  };
}

export async function runDiagnostics(backend: AdsBackend, policy: Policy, accountId: string, days: number): Promise<DiagnosticsReport> {
  const overview = await accountOverview(backend, accountId, days);
  const currency = overview.account.currency;
  const m = (n: number) => money(n, currency);
  const monthly = (cost: number) => round2((cost / days) * 30);
  const findings: Finding[] = [];
  const protectedTerms: DiagnosticsReport['protectedTermsNotNegated'] = [];
  const accountCpa = overview.totals.cpa;

  // 1. Ad copy compliance (checked first: risk before optimization)
  const ads = await backend.listAds(accountId);
  for (const ad of ads.filter((a) => a.status === 'ENABLED')) {
    const report = lintAd(ad.headlines, ad.descriptions);
    if (report.status === 'clean') continue;
    const campaign = overview.campaigns.find((c) => c.id === ad.campaignId);
    const flagged = report.findings.map((f) => `${f.field}: "${f.text}" (${f.severity === 'block' ? 'violation risk' : 'review'}: ${categoryLabel(f.category)})`);
    findings.push({
      id: '',
      kind: 'ad_copy_compliance',
      severity: report.status === 'block' ? 'high' : 'medium',
      title: `Fair Housing ${report.status === 'block' ? 'risk' : 'review'} in ad ${ad.id} (${campaign?.name ?? ad.campaignId})`,
      detail: `${flagged.join('; ')}. Write replacement copy that describes the home and amenities, check it with check_ad_copy, then propose update_ad_text with the full list of headlines and descriptions.`,
      needsCopywriting: { adId: ad.id, currentHeadlines: ad.headlines, currentDescriptions: ad.descriptions, flagged },
      stopgapChange: report.status === 'block' ? { type: 'set_ad_status', adId: ad.id, newStatus: 'PAUSED' } : undefined,
      stopgapReason: report.status === 'block' ? `Pause ad ${ad.id} right away so the flagged copy stops showing while compliant copy is written and approved.` : undefined,
    });
  }

  // 2. Wasted spend on irrelevant searches
  const terms = await backend.getSearchTerms(accountId, { days });
  const byCampaign = new Map<string, typeof terms>();
  for (const t of terms) {
    if (!byCampaign.has(t.campaignId)) byCampaign.set(t.campaignId, []);
    byCampaign.get(t.campaignId)!.push(t);
  }
  for (const [campaignId, rows] of byCampaign) {
    const campaign = overview.campaigns.find((c) => c.id === campaignId);
    if (!campaign || campaign.status !== 'ENABLED') continue;
    const brand = campaign.community.toLowerCase();
    const candidates = rows.filter((t) => t.conversions === 0 && t.cost >= 40 && t.clicks >= 10 && !t.term.toLowerCase().includes(brand));
    if (candidates.length === 0) continue;
    // Searches an existing negative already blocks are done: the report covers the period before it was added.
    const negatives = await backend.listNegatives(accountId, campaignId);
    const waste = candidates.filter((t) => !negatives.some((n) => negativeMatches(n, t.term)));
    const usable: typeof rows = [];
    for (const t of waste) {
      const hit = protectedTermIn(t.term);
      if (hit) {
        protectedTerms.push({
          campaign: campaign.name,
          term: t.term,
          cost: t.cost,
          protectedCategory: categoryLabel(hit.category),
          note: 'No conversions yet, but excluding it can keep a protected group from seeing your ads. Leave it running or improve the landing page instead.',
        });
      } else {
        usable.push(t);
      }
    }
    if (usable.length === 0) continue;
    const cost = round2(usable.reduce((s, t) => s + t.cost, 0));
    findings.push({
      id: '',
      kind: 'wasted_spend',
      severity: monthly(cost) >= 200 ? 'high' : 'medium',
      title: `${m(cost)} spent on ${usable.length} irrelevant searches in ${campaign.name}`,
      detail: `No conversions in the last ${days} days from: ${usable.map((t) => `"${t.term}" (${m(t.cost)})`).join(', ')}.`,
      estimatedMonthlyImpact: `About ${m(monthly(cost))} per month saved`,
      suggestedChange: { type: 'add_negative_keywords', campaignId, keywords: usable.map((t) => ({ text: t.term, matchType: 'PHRASE' as const })) },
      suggestedReason: `These searches spent ${m(cost)} in the last ${days} days with zero leads and are unrelated to renting at ${campaign.community}.`,
    });
  }

  // 3. Converting campaigns that run out of budget
  for (const c of overview.campaigns) {
    if (c.status !== 'ENABLED' || c.channel !== 'SEARCH' || c.cpa === null || accountCpa === null) continue;
    const limited = c.budgetUtilization >= 0.9 && (c.searchLostIsBudget ?? 0) >= 0.15;
    if (!limited || c.cpa > accountCpa) continue;
    const step = Math.min(policy.budgets.maxIncreasePct, 25) / 100;
    const suggested = Math.min(policy.budgets.maxCampaignDailyBudget, Math.round(c.dailyBudget * (1 + step)));
    if (suggested <= c.dailyBudget) continue;
    findings.push({
      id: '',
      kind: 'budget_limited_winner',
      severity: 'medium',
      title: `${c.name} converts well but runs out of budget`,
      detail: `Cost per lead ${m(c.cpa)} vs account average ${m(accountCpa)}. It spends ${share(c.budgetUtilization)} of its ${m(c.dailyBudget)} daily budget and loses about ${share(c.searchLostIsBudget ?? 0)} of impressions to budget.`,
      estimatedMonthlyImpact: `Up to ${m(round2((suggested - c.dailyBudget) * 30))} more per month in spend at a strong cost per lead`,
      suggestedChange: { type: 'set_campaign_budget', campaignId: c.id, newDailyBudget: suggested },
      suggestedReason: `${c.name} has the strongest cost per lead (${m(c.cpa)} vs ${m(accountCpa)}) and loses about ${share(c.searchLostIsBudget ?? 0)} of impressions because the budget runs out.`,
    });
  }

  // 4. Campaigns that spend without results
  for (const c of overview.campaigns) {
    if (c.status !== 'ENABLED' || c.conversions > 0 || c.cost < 300) continue;
    findings.push({
      id: '',
      kind: 'zero_conversion_campaign',
      severity: 'high',
      title: `${c.name} spent ${m(c.cost)} with zero leads`,
      detail: `No conversions in ${days} days at about ${m(c.avgDailyCost)} per day. Pausing stops the spend; check whether it is meant for awareness before pausing.`,
      estimatedMonthlyImpact: `About ${m(monthly(c.cost))} per month saved`,
      suggestedChange: { type: 'set_campaign_status', campaignId: c.id, newStatus: 'PAUSED' },
      suggestedReason: `${c.name} spent ${m(c.cost)} in the last ${days} days without a single lead.`,
    });
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  const kindOrder: Record<FindingKind, number> = { ad_copy_compliance: 0, wasted_spend: 1, zero_conversion_campaign: 2, budget_limited_winner: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || kindOrder[a.kind] - kindOrder[b.kind]);
  findings.forEach((f, i) => (f.id = `F${i + 1}`));

  const notes = [
    `Period: last ${days} days (${overview.period.from} to ${overview.period.to}).`,
    'Suggested changes are starting points. Each one still goes through policy checks, a dry run and human approval.',
  ];
  if (overview.account.mode === 'sandbox') notes.unshift('Sandbox account: all data is synthetic.');
  if (overview.account.mode === 'google_ads_test') notes.unshift(GOOGLE_ADS_TEST_NOTE);
  if (overview.account.mode === 'google_ads') notes.unshift(GOOGLE_ADS_LIVE_NOTE);
  return { overview, findings, protectedTermsNotNegated: protectedTerms, notes };
}
