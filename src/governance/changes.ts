import type { AdsBackend } from '../backends/backend.js';
import type { Campaign, Change, Check, DiffRow, FairHousingReport, NegativeKeyword, Policy, Risk, SearchTermRow } from '../types.js';
import { UserError } from '../types.js';
import { categoryLabel, lintAd, protectedTermIn } from './fairHousing.js';
import { money, normalizeKeyword, pct, round2 } from '../util/format.js';

/**
 * Per-change-type logic: what the change touches, what it looks like before
 * and after, which policy checks apply, how risky it is and how to undo it.
 */

export interface Evaluation {
  typeLabel: string;
  targetKey: string;
  targetLabel: string;
  before: unknown;
  after: unknown;
  summary: string;
  diff: DiffRow[];
  checks: Check[];
  risk: Risk;
  fairHousing?: FairHousingReport;
}

export interface EvalContext {
  backend: AdsBackend;
  accountId: string;
  policy: Policy;
  isRollback: boolean;
  currency: string;
}

const TYPE_LABELS: Record<Change['type'], string> = {
  set_campaign_budget: 'Budget change',
  set_campaign_status: 'Status change',
  add_negative_keywords: 'Negative keywords',
  remove_negative_keywords: 'Remove negative keywords',
  update_ad_text: 'Ad copy update',
  set_ad_status: 'Ad status change',
};

export function typeLabel(change: Change): string {
  return TYPE_LABELS[change.type];
}

export function targetKeyOf(change: Change): string {
  switch (change.type) {
    case 'set_campaign_budget':
      return `campaign:${change.campaignId}:budget`;
    case 'set_campaign_status':
      return `campaign:${change.campaignId}:status`;
    case 'add_negative_keywords':
    case 'remove_negative_keywords':
      return `campaign:${change.campaignId}:negatives`;
    case 'update_ad_text':
      return `ad:${change.adId}:text`;
    case 'set_ad_status':
      return `ad:${change.adId}:status`;
  }
}

function sameKeyword(a: NegativeKeyword, b: NegativeKeyword): boolean {
  return a.matchType === b.matchType && normalizeKeyword(a.text) === normalizeKeyword(b.text);
}

function keywordLabel(k: NegativeKeyword): string {
  if (k.matchType === 'EXACT') return `[${k.text}]`;
  if (k.matchType === 'PHRASE') return `"${k.text}"`;
  return k.text;
}

/** Reads only the part of the account this change touches. Used for drift checks and verification. */
export async function readTargetState(backend: AdsBackend, accountId: string, change: Change): Promise<unknown> {
  switch (change.type) {
    case 'set_campaign_budget': {
      const c = await backend.getCampaign(accountId, change.campaignId);
      if (!c) throw new UserError(`No campaign ${change.campaignId} in account ${accountId}. Call get_account_overview for valid campaign IDs.`);
      return { dailyBudget: c.dailyBudget };
    }
    case 'set_campaign_status': {
      const c = await backend.getCampaign(accountId, change.campaignId);
      if (!c) throw new UserError(`No campaign ${change.campaignId} in account ${accountId}. Call get_account_overview for valid campaign IDs.`);
      return { status: c.status };
    }
    case 'add_negative_keywords':
    case 'remove_negative_keywords': {
      const c = await backend.getCampaign(accountId, change.campaignId);
      if (!c) throw new UserError(`No campaign ${change.campaignId} in account ${accountId}. Call get_account_overview for valid campaign IDs.`);
      const existing = await backend.listNegatives(accountId, change.campaignId);
      const present = change.keywords
        .filter((k) => existing.some((e) => sameKeyword(e, k)))
        .map((k) => ({ text: normalizeKeyword(k.text), matchType: k.matchType }))
        .sort((a, b) => keywordLabel(a).localeCompare(keywordLabel(b)));
      return { present };
    }
    case 'update_ad_text': {
      const ad = await backend.getAd(accountId, change.adId);
      if (!ad) throw new UserError(`No ad ${change.adId} in account ${accountId}. Call get_ads for valid ad IDs.`);
      return { headlines: [...ad.headlines], descriptions: [...ad.descriptions] };
    }
    case 'set_ad_status': {
      const ad = await backend.getAd(accountId, change.adId);
      if (!ad) throw new UserError(`No ad ${change.adId} in account ${accountId}. Call get_ads for valid ad IDs.`);
      return { status: ad.status };
    }
  }
}

export function expectedAfter(change: Change): unknown {
  switch (change.type) {
    case 'set_campaign_budget':
      return { dailyBudget: change.newDailyBudget };
    case 'set_campaign_status':
      return { status: change.newStatus };
    case 'add_negative_keywords':
      return {
        present: change.keywords
          .map((k) => ({ text: normalizeKeyword(k.text), matchType: k.matchType }))
          .sort((a, b) => keywordLabel(a).localeCompare(keywordLabel(b))),
      };
    case 'remove_negative_keywords':
      return { present: [] };
    case 'update_ad_text':
      return { headlines: [...change.headlines], descriptions: [...change.descriptions] };
    case 'set_ad_status':
      return { status: change.newStatus };
  }
}

/** The change that restores the state before an applied change. */
export function inverseOf(change: Change, before: unknown): Change {
  switch (change.type) {
    case 'set_campaign_budget':
      return { type: 'set_campaign_budget', campaignId: change.campaignId, newDailyBudget: (before as { dailyBudget: number }).dailyBudget };
    case 'set_campaign_status':
      return { type: 'set_campaign_status', campaignId: change.campaignId, newStatus: (before as { status: Campaign['status'] }).status };
    case 'add_negative_keywords':
      return { type: 'remove_negative_keywords', campaignId: change.campaignId, keywords: change.keywords.map((k) => ({ ...k, text: normalizeKeyword(k.text) })) };
    case 'remove_negative_keywords':
      return { type: 'add_negative_keywords', campaignId: change.campaignId, keywords: change.keywords };
    case 'update_ad_text': {
      const b = before as { headlines: string[]; descriptions: string[] };
      return { type: 'update_ad_text', adId: change.adId, headlines: b.headlines, descriptions: b.descriptions };
    }
    case 'set_ad_status':
      return { type: 'set_ad_status', adId: change.adId, newStatus: (before as { status: Campaign['status'] }).status };
  }
}

/** Normalizes AI input so equal changes compare equal (trimmed text, lowercase keywords, no duplicates, cents). */
export function normalizeChange(change: Change): Change {
  switch (change.type) {
    case 'set_campaign_budget':
      return { ...change, newDailyBudget: round2(change.newDailyBudget) };
    case 'set_campaign_status':
      return { ...change };
    case 'add_negative_keywords':
    case 'remove_negative_keywords': {
      const seen = new Set<string>();
      const keywords: NegativeKeyword[] = [];
      for (const k of change.keywords) {
        const text = normalizeKeyword(k.text);
        const key = `${k.matchType}|${text}`;
        if (!text || seen.has(key)) continue;
        seen.add(key);
        keywords.push({ text, matchType: k.matchType });
      }
      return { ...change, keywords };
    }
    case 'update_ad_text':
      return { ...change, headlines: change.headlines.map((h) => h.trim()), descriptions: change.descriptions.map((d) => d.trim()) };
    case 'set_ad_status':
      return { ...change };
  }
}

function brandTermsFor(campaign: Campaign): string[] {
  const generic = new Set(['the', 'at', 'on', 'apartments', 'apartment', 'lofts', 'loft', 'flats', 'commons', 'homes', 'residences', 'place', 'yard', 'park', 'tower', 'towers']);
  const name = campaign.community.toLowerCase();
  const terms = [name];
  const first = name.split(/\s+/)[0];
  if (first && first.length >= 5 && !generic.has(first)) terms.push(first);
  return terms;
}

/** Approximates how a negative keyword matches search terms in Google Ads (no close variants for negatives). */
export function negativeMatches(negative: NegativeKeyword, searchTerm: string): boolean {
  const term = normalizeKeyword(searchTerm);
  const kw = normalizeKeyword(negative.text);
  if (negative.matchType === 'EXACT') return term === kw;
  if (negative.matchType === 'PHRASE') return ` ${term} `.includes(` ${kw} `);
  const termWords = new Set(term.split(' '));
  return kw.split(' ').every((w) => termWords.has(w));
}

async function accountEnabledTotal(ctx: EvalContext, excludeCampaignId?: string): Promise<number> {
  const campaigns = await ctx.backend.listCampaigns(ctx.accountId);
  return round2(campaigns.filter((c) => c.status === 'ENABLED' && c.id !== excludeCampaignId).reduce((sum, c) => sum + c.dailyBudget, 0));
}

export async function evaluate(ctx: EvalContext, change: Change): Promise<Evaluation> {
  const before = await readTargetState(ctx.backend, ctx.accountId, change);
  const after = expectedAfter(change);
  const checks: Check[] = [];
  const P = ctx.policy;
  const m = (n: number) => money(n, ctx.currency);

  switch (change.type) {
    case 'set_campaign_budget': {
      const campaign = (await ctx.backend.getCampaign(ctx.accountId, change.campaignId))!;
      const old = (before as { dailyBudget: number }).dailyBudget;
      const next = change.newDailyBudget;
      const ratio = old > 0 ? (next - old) / old : 1;

      if (next === old) checks.push({ id: 'no_op', label: 'Makes a change', status: 'fail', detail: `The budget is already ${m(old)}.` });

      if (next < P.budgets.minCampaignDailyBudget || next > P.budgets.maxCampaignDailyBudget) {
        checks.push({ id: 'budget_range', label: 'Budget within allowed range', status: 'fail', detail: `Daily budgets must stay between ${m(P.budgets.minCampaignDailyBudget)} and ${m(P.budgets.maxCampaignDailyBudget)}.` });
      } else {
        checks.push({ id: 'budget_range', label: 'Budget within allowed range', status: 'pass', detail: `${m(P.budgets.minCampaignDailyBudget)} to ${m(P.budgets.maxCampaignDailyBudget)} per day` });
      }

      if (ctx.isRollback) {
        checks.push({ id: 'budget_step', label: 'Change size', status: 'pass', detail: 'Undo restores the previously approved value, so step limits do not apply.' });
      } else if (ratio > 0 && ratio * 100 > P.budgets.maxIncreasePct + 1e-9) {
        const maxAllowed = round2(old * (1 + P.budgets.maxIncreasePct / 100));
        checks.push({ id: 'budget_step', label: `Increase within +${P.budgets.maxIncreasePct}%`, status: 'fail', detail: `${pct(ratio)} is above the +${P.budgets.maxIncreasePct}% limit per change. The largest allowed budget is ${m(maxAllowed)}.` });
      } else if (ratio < 0 && -ratio * 100 > P.budgets.maxDecreasePct + 1e-9) {
        const minAllowed = round2(old * (1 - P.budgets.maxDecreasePct / 100));
        checks.push({ id: 'budget_step', label: `Decrease within -${P.budgets.maxDecreasePct}%`, status: 'fail', detail: `${pct(ratio)} is beyond the -${P.budgets.maxDecreasePct}% limit per change. The lowest allowed budget is ${m(minAllowed)}.` });
      } else if (next !== old) {
        checks.push({ id: 'budget_step', label: 'Change size within limits', status: 'pass', detail: `${pct(ratio)} (limits: +${P.budgets.maxIncreasePct}% / -${P.budgets.maxDecreasePct}%)` });
      }

      if (campaign.status === 'ENABLED') {
        const total = round2((await accountEnabledTotal(ctx, campaign.id)) + next);
        checks.push(
          total > P.budgets.maxAccountDailyTotal
            ? { id: 'account_total', label: 'Account daily total within cap', status: 'fail', detail: `Enabled campaigns would total ${m(total)} per day, above the ${m(P.budgets.maxAccountDailyTotal)} cap.` }
            : { id: 'account_total', label: 'Account daily total within cap', status: 'pass', detail: `${m(total)} of ${m(P.budgets.maxAccountDailyTotal)} per day` },
        );
      }

      const risk: Risk = next < old ? 'low' : ratio <= 0.15 ? 'low' : 'medium';
      return {
        typeLabel: typeLabel(change),
        targetKey: targetKeyOf(change),
        targetLabel: campaign.name,
        before,
        after,
        summary: `${next > old ? 'Raise' : 'Lower'} the daily budget for ${campaign.name} from ${m(old)} to ${m(next)} (${pct(ratio)}).`,
        diff: [{ field: 'Daily budget', before: m(old), after: m(next), delta: pct(ratio) }],
        checks,
        risk: ctx.isRollback ? 'low' : risk,
      };
    }

    case 'set_campaign_status': {
      const campaign = (await ctx.backend.getCampaign(ctx.accountId, change.campaignId))!;
      const old = (before as { status: Campaign['status'] }).status;
      if (old === change.newStatus) checks.push({ id: 'no_op', label: 'Makes a change', status: 'fail', detail: `The campaign is already ${old.toLowerCase()}.` });
      if (change.newStatus === 'PAUSED') {
        checks.push(P.status.allowPause ? { id: 'status_allowed', label: 'Pausing allowed by policy', status: 'pass' } : { id: 'status_allowed', label: 'Pausing allowed by policy', status: 'fail', detail: 'Policy does not allow pausing campaigns.' });
      } else {
        checks.push(P.status.allowEnable ? { id: 'status_allowed', label: 'Enabling allowed by policy', status: 'pass' } : { id: 'status_allowed', label: 'Enabling allowed by policy', status: 'fail', detail: 'Policy does not allow enabling campaigns.' });
        const total = round2((await accountEnabledTotal(ctx, campaign.id)) + campaign.dailyBudget);
        checks.push(
          total > P.budgets.maxAccountDailyTotal
            ? { id: 'account_total', label: 'Account daily total within cap', status: 'fail', detail: `Enabling would bring enabled budgets to ${m(total)} per day, above the ${m(P.budgets.maxAccountDailyTotal)} cap.` }
            : { id: 'account_total', label: 'Account daily total within cap', status: 'pass', detail: `${m(total)} of ${m(P.budgets.maxAccountDailyTotal)} per day` },
        );
      }
      const pausing = change.newStatus === 'PAUSED';
      return {
        typeLabel: typeLabel(change),
        targetKey: targetKeyOf(change),
        targetLabel: campaign.name,
        before,
        after,
        summary: `${pausing ? 'Pause' : 'Enable'} ${campaign.name}${pausing ? ` (saves about ${m(campaign.dailyBudget)} per day at its current budget)` : ` (resumes spend of up to ${m(campaign.dailyBudget)} per day)`}.`,
        diff: [{ field: 'Status', before: old === 'ENABLED' ? 'Enabled' : 'Paused', after: pausing ? 'Paused' : 'Enabled' }],
        checks,
        risk: pausing ? 'high' : 'medium',
      };
    }

    case 'add_negative_keywords':
    case 'remove_negative_keywords': {
      const campaign = (await ctx.backend.getCampaign(ctx.accountId, change.campaignId))!;
      const adding = change.type === 'add_negative_keywords';
      const present = (before as { present: NegativeKeyword[] }).present;

      if (change.keywords.length === 0) checks.push({ id: 'neg_count', label: 'Has keywords', status: 'fail', detail: 'No keywords to change.' });
      else if (change.keywords.length > P.negatives.maxPerProposal) checks.push({ id: 'neg_count', label: `At most ${P.negatives.maxPerProposal} keywords per change`, status: 'fail', detail: `${change.keywords.length} keywords. Split them into smaller proposals.` });
      else checks.push({ id: 'neg_count', label: `At most ${P.negatives.maxPerProposal} keywords per change`, status: 'pass', detail: `${change.keywords.length} keyword${change.keywords.length === 1 ? '' : 's'}` });

      if (adding) {
        const dupes = change.keywords.filter((k) => present.some((p) => sameKeyword(p, k)));
        checks.push(dupes.length ? { id: 'neg_duplicate', label: 'Not already negative', status: 'fail', detail: `Already negative: ${dupes.map(keywordLabel).join(', ')}` } : { id: 'neg_duplicate', label: 'Not already negative', status: 'pass' });

        const protectedHits = change.keywords
          .map((k) => ({ k, hit: protectedTermIn(k.text) }))
          .filter((x): x is { k: NegativeKeyword; hit: { term: string; category: string } } => Boolean(x.hit));
        checks.push(
          protectedHits.length
            ? {
                id: 'fair_housing_negatives',
                label: 'Fair Housing: no protected-group exclusions',
                status: 'fail',
                detail: `Blocked: ${protectedHits.map((x) => `${keywordLabel(x.k)} relates to ${categoryLabel(x.hit.category)}`).join('; ')}. Excluding these searches can keep members of a protected group from seeing housing ads. The tool never adds them; a person can decide outside the tool.`,
              }
            : { id: 'fair_housing_negatives', label: 'Fair Housing: no protected-group exclusions', status: 'pass' },
        );

        const brand = brandTermsFor(campaign);
        const brandHits = change.keywords.filter((k) => brand.some((b) => normalizeKeyword(k.text).includes(b)));
        checks.push(brandHits.length ? { id: 'brand_terms', label: 'Does not block your own brand', status: 'fail', detail: `${brandHits.map(keywordLabel).join(', ')} would block searches for ${campaign.community}.` } : { id: 'brand_terms', label: 'Does not block your own brand', status: 'pass' });

        const terms: SearchTermRow[] = await ctx.backend.getSearchTerms(ctx.accountId, { campaignId: campaign.id, days: 30 });
        const blocked = terms.filter((t) => change.keywords.some((k) => negativeMatches(k, t.term)));
        const blockedConv = blocked.reduce((s, t) => s + t.conversions, 0);
        const totalConv = terms.reduce((s, t) => s + t.conversions, 0);
        const convShare = totalConv > 0 ? blockedConv / totalConv : 0;
        const converting = blocked.filter((t) => t.conversions > 0);
        if (converting.length === 0) {
          checks.push({ id: 'collateral', label: 'Does not block converting searches', status: 'pass', detail: blocked.length ? `Matches ${blocked.length} search term${blocked.length === 1 ? '' : 's'} with no conversions in the last 30 days.` : 'Matches no recent search terms.' });
        } else {
          const list = converting.map((t) => `"${t.term}" (${t.conversions} conv.)`).join(', ');
          checks.push(
            convShare * 100 > P.negatives.maxConversionsBlockedPct
              ? { id: 'collateral', label: 'Does not block converting searches', status: 'fail', detail: `Would block ${Math.round(convShare * 100)}% of this campaign's search-term conversions: ${list}.` }
              : { id: 'collateral', label: 'Does not block converting searches', status: 'warn', detail: `Would also block converting searches: ${list}.` },
          );
        }
      } else {
        const missing = change.keywords.filter((k) => !present.some((p) => sameKeyword(p, k)));
        checks.push(missing.length ? { id: 'neg_exists', label: 'Keywords exist', status: 'fail', detail: `Not currently negative: ${missing.map(keywordLabel).join(', ')}` } : { id: 'neg_exists', label: 'Keywords exist', status: 'pass' });
      }

      const list = change.keywords.map(keywordLabel).join(', ');
      return {
        typeLabel: typeLabel(change),
        targetKey: targetKeyOf(change),
        targetLabel: campaign.name,
        before,
        after,
        summary: adding ? `Add ${change.keywords.length} negative keyword${change.keywords.length === 1 ? '' : 's'} to ${campaign.name}: ${list}.` : `Remove ${change.keywords.length} negative keyword${change.keywords.length === 1 ? '' : 's'} from ${campaign.name}: ${list}.`,
        diff: change.keywords.map((k) => ({ field: `Negative (${k.matchType.toLowerCase()})`, before: adding ? 'Not present' : keywordLabel(k), after: adding ? keywordLabel(k) : 'Removed' })),
        checks,
        risk: ctx.isRollback ? 'low' : change.keywords.length > 10 || checks.some((c) => c.status === 'warn') ? 'medium' : 'low',
      };
    }

    case 'update_ad_text': {
      const ad = (await ctx.backend.getAd(ctx.accountId, change.adId))!;
      const campaign = await ctx.backend.getCampaign(ctx.accountId, ad.campaignId);
      const b = before as { headlines: string[]; descriptions: string[] };
      const A = P.adCopy;

      if (JSON.stringify(b.headlines) === JSON.stringify(change.headlines) && JSON.stringify(b.descriptions) === JSON.stringify(change.descriptions)) {
        checks.push({ id: 'no_op', label: 'Makes a change', status: 'fail', detail: 'The new text is the same as the current text.' });
      }

      const countProblems: string[] = [];
      if (change.headlines.length < A.minHeadlines || change.headlines.length > A.maxHeadlines) countProblems.push(`${A.minHeadlines} to ${A.maxHeadlines} headlines (got ${change.headlines.length})`);
      if (change.descriptions.length < A.minDescriptions || change.descriptions.length > A.maxDescriptions) countProblems.push(`${A.minDescriptions} to ${A.maxDescriptions} descriptions (got ${change.descriptions.length})`);
      checks.push(countProblems.length ? { id: 'ad_counts', label: 'Responsive search ad structure', status: 'fail', detail: `Needs ${countProblems.join(' and ')}.` } : { id: 'ad_counts', label: 'Responsive search ad structure', status: 'pass', detail: `${change.headlines.length} headlines, ${change.descriptions.length} descriptions` });

      const tooLong = [
        ...change.headlines.map((h, i) => ({ f: `Headline ${i + 1}`, t: h, max: A.headlineMaxChars })),
        ...change.descriptions.map((d, i) => ({ f: `Description ${i + 1}`, t: d, max: A.descriptionMaxChars })),
      ].filter((x) => x.t.length > x.max);
      checks.push(tooLong.length ? { id: 'ad_lengths', label: 'Character limits', status: 'fail', detail: tooLong.map((x) => `${x.f} is ${x.t.length}/${x.max}`).join('; ') } : { id: 'ad_lengths', label: 'Character limits', status: 'pass', detail: `Headlines up to ${A.headlineMaxChars}, descriptions up to ${A.descriptionMaxChars}` });

      const exclaim = change.headlines.filter((h) => h.includes('!'));
      checks.push(exclaim.length ? { id: 'ad_punctuation', label: 'No exclamation marks in headlines', status: 'fail', detail: 'Google Ads does not allow exclamation marks in headlines.' } : { id: 'ad_punctuation', label: 'No exclamation marks in headlines', status: 'pass' });

      const fh = lintAd(change.headlines, change.descriptions);
      if (fh.status === 'block') {
        checks.push({ id: 'fair_housing_copy', label: 'Fair Housing screening', status: 'fail', detail: fh.findings.filter((f) => f.severity === 'block').map((f) => `${f.field}: "${f.match}" (${categoryLabel(f.category)}). ${f.suggestion}`).join(' ') });
      } else if (fh.status === 'warn') {
        checks.push({ id: 'fair_housing_copy', label: 'Fair Housing screening', status: 'warn', detail: fh.findings.map((f) => `${f.field}: "${f.match}" (${categoryLabel(f.category)}). ${f.suggestion}`).join(' ') });
      } else {
        checks.push({ id: 'fair_housing_copy', label: 'Fair Housing screening', status: 'pass', detail: 'No risk patterns found.' });
      }

      const diff: DiffRow[] = [];
      const maxH = Math.max(b.headlines.length, change.headlines.length);
      for (let i = 0; i < maxH; i++) {
        const o = b.headlines[i];
        const n = change.headlines[i];
        if (o !== n) diff.push({ field: `Headline ${i + 1}`, before: o ?? '(none)', after: n ?? '(removed)' });
      }
      const maxD = Math.max(b.descriptions.length, change.descriptions.length);
      for (let i = 0; i < maxD; i++) {
        const o = b.descriptions[i];
        const n = change.descriptions[i];
        if (o !== n) diff.push({ field: `Description ${i + 1}`, before: o ?? '(none)', after: n ?? '(removed)' });
      }

      return {
        typeLabel: typeLabel(change),
        targetKey: targetKeyOf(change),
        targetLabel: `${campaign?.name ?? ad.campaignId} › ad ${ad.id}`,
        before,
        after,
        summary: `Update the copy of ad ${ad.id} in ${campaign?.name ?? ad.campaignId} (${diff.length} line${diff.length === 1 ? '' : 's'} changed).`,
        diff,
        checks,
        risk: 'medium',
        fairHousing: fh,
      };
    }

    case 'set_ad_status': {
      const ad = (await ctx.backend.getAd(ctx.accountId, change.adId))!;
      const campaign = await ctx.backend.getCampaign(ctx.accountId, ad.campaignId);
      const old = (before as { status: Campaign['status'] }).status;
      const pausing = change.newStatus === 'PAUSED';
      const where = campaign?.name ?? ad.campaignId;
      if (old === change.newStatus) checks.push({ id: 'no_op', label: 'Makes a change', status: 'fail', detail: `The ad is already ${old.toLowerCase()}.` });

      if (pausing) {
        checks.push(P.status.allowPause ? { id: 'status_allowed', label: 'Pausing allowed by policy', status: 'pass' } : { id: 'status_allowed', label: 'Pausing allowed by policy', status: 'fail', detail: 'Policy does not allow pausing.' });
      } else {
        checks.push(P.status.allowEnable ? { id: 'status_allowed', label: 'Enabling allowed by policy', status: 'pass' } : { id: 'status_allowed', label: 'Enabling allowed by policy', status: 'fail', detail: 'Policy does not allow enabling.' });
      }

      // Ads in the same ad group that keep serving if this one is paused.
      const siblings = (await ctx.backend.listAds(ctx.accountId, ad.campaignId)).filter(
        (x) => x.id !== ad.id && (ad.adGroupId ? x.adGroupId === ad.adGroupId : x.adGroupName === ad.adGroupName),
      );
      const othersLive = siblings.filter((x) => x.status === 'ENABLED').length;
      let lastAd = false;
      if (pausing) {
        lastAd = othersLive === 0 && old === 'ENABLED';
        checks.push(
          lastAd
            ? { id: 'last_ad', label: 'Ad group keeps serving', status: 'warn', detail: `This is the only active ad in its ad group (${ad.adGroupName || 'ad group'}), so the ad group stops showing ads until another ad is added or enabled.` }
            : { id: 'last_ad', label: 'Ad group keeps serving', status: 'pass', detail: `${othersLive} other active ad${othersLive === 1 ? '' : 's'} in the ad group keep${othersLive === 1 ? 's' : ''} running.` },
        );
      }

      // Re-enabling is screened like new copy: a flagged ad must be fixed before it runs again.
      const fh = lintAd(ad.headlines, ad.descriptions);
      if (!pausing) {
        if (fh.status === 'block') {
          checks.push({ id: 'fair_housing_copy', label: 'Fair Housing screening', status: 'fail', detail: `This ad has Fair Housing violation risks: ${fh.findings.filter((f) => f.severity === 'block').map((f) => `${f.field}: "${f.match}" (${categoryLabel(f.category)})`).join('; ')}. Fix the copy with update_ad_text before enabling it.` });
        } else if (fh.status === 'warn') {
          checks.push({ id: 'fair_housing_copy', label: 'Fair Housing screening', status: 'warn', detail: fh.findings.map((f) => `${f.field}: "${f.match}" (${categoryLabel(f.category)}). ${f.suggestion}`).join(' ') });
        } else {
          checks.push({ id: 'fair_housing_copy', label: 'Fair Housing screening', status: 'pass', detail: 'No risk patterns found in this ad.' });
        }
      }

      return {
        typeLabel: typeLabel(change),
        targetKey: targetKeyOf(change),
        targetLabel: `${where} › ad ${ad.id}`,
        before,
        after,
        summary: pausing
          ? `Pause ad ${ad.id} in ${where}${lastAd ? ' (the only active ad in its ad group)' : othersLive ? ` (${othersLive} other active ad${othersLive === 1 ? '' : 's'} keep running)` : ''}.`
          : `Enable ad ${ad.id} in ${where}.`,
        diff: [{ field: `Ad ${ad.id} status`, before: old === 'ENABLED' ? 'Enabled' : 'Paused', after: pausing ? 'Paused' : 'Enabled' }],
        checks,
        risk: ctx.isRollback ? 'low' : pausing ? (lastAd ? 'high' : 'low') : 'medium',
        fairHousing: !pausing ? fh : undefined,
      };
    }
  }
}
