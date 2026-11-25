import { ADS, NEGATIVES, SPECS } from '../seed.js';
import type { MatchType, NegativeKeyword } from '../../types.js';

/**
 * The sample campaigns npm run gads:setup builds in a Google Ads test
 * account. They mirror the sandbox account (same names, budgets, ads and
 * negative keywords), so the agent finds the same planted problems:
 *   - Juniper Yard Generic wastes money on irrelevant searches.
 *   - Northlight Lofts Generic converts well but is limited by budget.
 *   - Ashgrove Commons Display spends and never produces a lead.
 *   - An Ashgrove Commons ad contains Fair Housing problems for the agent to
 *     find and fix. Test accounts never show ads, so it can never run.
 */

export interface SeedAd {
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
}

export interface SeedCampaign {
  name: string;
  channel: 'SEARCH' | 'DISPLAY';
  dailyBudget: number;
  adGroupName?: string;
  keywords: Array<{ text: string; matchType: MatchType }>;
  ads: SeedAd[];
  negatives: NegativeKeyword[];
}

const KEYWORDS: Record<string, Array<{ text: string; matchType: MatchType }>> = {
  'c-101': [
    { text: 'juniper yard', matchType: 'EXACT' },
    { text: 'juniper yard apartments', matchType: 'PHRASE' },
  ],
  'c-102': [
    { text: 'apartments for rent', matchType: 'PHRASE' },
    { text: '2 bedroom apartments', matchType: 'PHRASE' },
    { text: 'pet friendly apartments', matchType: 'PHRASE' },
    { text: 'luxury apartments', matchType: 'PHRASE' },
  ],
  'c-201': [
    { text: 'northlight lofts', matchType: 'EXACT' },
    { text: 'northlight lofts', matchType: 'PHRASE' },
  ],
  'c-202': [
    { text: 'lofts for rent', matchType: 'PHRASE' },
    { text: 'loft apartments', matchType: 'PHRASE' },
    { text: 'apartments near light rail', matchType: 'PHRASE' },
  ],
  'c-301': [
    { text: 'apartments downtown', matchType: 'PHRASE' },
    { text: 'studio apartments', matchType: 'PHRASE' },
    { text: '1 bedroom apartment', matchType: 'PHRASE' },
  ],
};

export function seedPlan(): SeedCampaign[] {
  return SPECS.filter((s) => s.channel === 'SEARCH' || s.channel === 'DISPLAY').map((s) => {
    const search = s.channel === 'SEARCH';
    const ads = search ? ADS.filter((a) => a.campaignId === s.id) : [];
    return {
      name: s.name,
      channel: search ? 'SEARCH' : 'DISPLAY',
      dailyBudget: s.budget,
      adGroupName: search ? (ads[0]?.adGroupName ?? 'Ad group 1') : undefined,
      keywords: search ? (KEYWORDS[s.id] ?? []).map((k) => ({ ...k })) : [],
      ads: ads.map((a) => ({ headlines: [...a.headlines], descriptions: [...a.descriptions], finalUrl: a.finalUrl })),
      negatives: (NEGATIVES[s.id] ?? []).map((n) => ({ ...n })),
    };
  });
}
