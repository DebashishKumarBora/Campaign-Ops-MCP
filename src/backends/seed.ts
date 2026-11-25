import type { Account, Ad, Campaign, DailyMetric, NegativeKeyword, SearchTermRow } from '../types.js';
import { addDays, isoDay, round2 } from '../util/format.js';

/**
 * Synthetic data for the sandbox account. Every community, number and
 * search term here is invented. The patterns are planted on purpose so the
 * agent has real problems to find:
 *   - Juniper Yard Generic wastes money on irrelevant searches.
 *   - Northlight Lofts Generic converts well but runs out of budget every day.
 *   - Ashgrove Commons Display spends every day and never produces a lead.
 *   - An Ashgrove Commons ad contains Fair Housing problems.
 *   - Two zero-conversion search terms relate to protected groups, so a naive
 *     optimizer would wrongly exclude them.
 */

export interface SandboxState {
  version: 1;
  generatedAt: string;
  endDate: string;
  account: Account;
  campaigns: Campaign[];
  metrics: Record<string, DailyMetric[]>;
  searchTerms: SearchTermRow[];
  searchTermDays: number;
  negatives: Record<string, NegativeKeyword[]>;
  ads: Ad[];
}

export const SANDBOX_ACCOUNT_ID = '123-456-7890';
export const SANDBOX_DAYS = 30;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(lambda: number, rand: () => number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit && k < 1000);
  return k - 1;
}

export interface CampaignSpec {
  id: string;
  community: string;
  name: string;
  channel: Campaign['channel'];
  budget: number;
  spendRate: number; // average share of budget spent per day
  cpc: number;
  cvr: number; // conversions per click
  ctr: number;
  lostIs: number; // search impression share lost to budget
}

export const SPECS: CampaignSpec[] = [
  { id: 'c-101', community: 'Juniper Yard', name: 'Juniper Yard | Search | Brand', channel: 'SEARCH', budget: 30, spendRate: 0.62, cpc: 1.9, cvr: 0.16, ctr: 0.11, lostIs: 0.02 },
  { id: 'c-102', community: 'Juniper Yard', name: 'Juniper Yard | Search | Generic', channel: 'SEARCH', budget: 60, spendRate: 0.97, cpc: 3.4, cvr: 0.045, ctr: 0.05, lostIs: 0.08 },
  { id: 'c-201', community: 'Northlight Lofts', name: 'Northlight Lofts | Search | Brand', channel: 'SEARCH', budget: 25, spendRate: 0.55, cpc: 1.6, cvr: 0.18, ctr: 0.12, lostIs: 0.01 },
  { id: 'c-202', community: 'Northlight Lofts', name: 'Northlight Lofts | Search | Generic', channel: 'SEARCH', budget: 40, spendRate: 0.99, cpc: 2.6, cvr: 0.12, ctr: 0.06, lostIs: 0.38 },
  { id: 'c-301', community: 'Ashgrove Commons', name: 'Ashgrove Commons | Search | Generic', channel: 'SEARCH', budget: 50, spendRate: 0.9, cpc: 3.1, cvr: 0.06, ctr: 0.05, lostIs: 0.05 },
  { id: 'c-302', community: 'Ashgrove Commons', name: 'Ashgrove Commons | Display | Prospecting', channel: 'DISPLAY', budget: 20, spendRate: 1.0, cpc: 0.55, cvr: 0, ctr: 0.004, lostIs: 0 },
];

// 30-day search term totals: [term, clicks, cost, conversions]
export const TERMS: Record<string, Array<[string, number, number, number]>> = {
  'c-101': [
    ['juniper yard apartments', 210, 380, 42],
    ['juniper yard', 95, 165, 21],
  ],
  'c-102': [
    ['apartments for rent near me', 128, 430, 9],
    ['2 bedroom apartments', 90, 300, 6],
    ['luxury apartments with rooftop', 49, 170, 3],
    ['pet friendly apartments', 55, 190, 4],
    ['apartments with gym', 33, 112, 2],
    ['apartment jobs', 38, 126, 0],
    ['how to become a leasing agent', 21, 72, 0],
    ['storage units near me', 19, 63, 0],
    ['apartment cleaning services', 17, 58, 0],
    ['free furniture pickup', 14, 41, 0],
    ['wheelchair accessible apartments', 12, 44, 0],
    ['section 8 apartments', 15, 49, 0],
  ],
  'c-201': [
    ['northlight lofts', 160, 250, 31],
    ['northlight lofts reviews', 30, 48, 4],
  ],
  'c-202': [
    ['lofts for rent', 150, 420, 20],
    ['apartments near light rail', 88, 230, 10],
    ['industrial loft apartments', 52, 140, 6],
    ['loft apartments', 110, 300, 14],
  ],
  'c-301': [
    ['apartments downtown', 88, 290, 5],
    ['1 bedroom apartment', 70, 225, 4],
    ['studio apartments', 45, 140, 3],
    ['apartment hotel nightly', 22, 70, 0],
    ['property management jobs', 18, 61, 0],
    ['family friendly apartments', 16, 52, 0],
  ],
};

export const ADS: Ad[] = [
  {
    id: 'a-1011', campaignId: 'c-101', adGroupName: 'Brand', status: 'ENABLED',
    headlines: ['Juniper Yard Apartments', 'Official Site', 'Tour Juniper Yard Today'],
    descriptions: ['Modern 1 to 3 bedroom homes with in-unit laundry and a rooftop lounge.', 'See floor plans, check availability and book a tour online.'],
    finalUrl: 'https://example.com/juniper-yard',
  },
  {
    id: 'a-1021', campaignId: 'c-102', adGroupName: 'Apartments', status: 'ENABLED',
    headlines: ['Apartments With Rooftop Views', 'Pet Friendly Living', 'Tour Juniper Yard Today', 'In-Unit Laundry'],
    descriptions: ['Modern 1 to 3 bedroom homes with in-unit laundry and a rooftop lounge. Tour today.', 'Walk to cafes and transit. Reserve your new home at Juniper Yard.'],
    finalUrl: 'https://example.com/juniper-yard',
  },
  {
    id: 'a-2011', campaignId: 'c-201', adGroupName: 'Brand', status: 'ENABLED',
    headlines: ['Northlight Lofts', 'Official Site', 'Industrial Loft Living'],
    descriptions: ['Open loft floor plans with exposed brick and big windows.', 'Check availability and book a tour online in minutes.'],
    finalUrl: 'https://example.com/northlight-lofts',
  },
  {
    id: 'a-2021', campaignId: 'c-202', adGroupName: 'Lofts', status: 'ENABLED',
    headlines: ['Lofts for Rent Near Light Rail', 'Exposed Brick and Tall Windows', 'Book a Tour Today'],
    descriptions: ['Open loft floor plans steps from the light rail. See pricing and availability.', 'Studios to 2 bedrooms with modern kitchens. Schedule your tour online.'],
    finalUrl: 'https://example.com/northlight-lofts',
  },
  {
    id: 'a-3011', campaignId: 'c-301', adGroupName: 'Apartments', status: 'ENABLED',
    headlines: ['Ashgrove Commons', 'Ideal for Young Professionals', 'Downtown Studios and 1 Beds', 'Book a Tour Today'],
    descriptions: ['Quiet adults-only community near downtown with a resort-style pool.', 'Studios and 1 bedrooms with modern finishes. Schedule your tour today.'],
    finalUrl: 'https://example.com/ashgrove-commons',
  },
  {
    id: 'a-3021', campaignId: 'c-302', adGroupName: 'Prospecting', status: 'ENABLED',
    headlines: ['Ashgrove Commons', 'Now Leasing Downtown'],
    descriptions: ['Studios and 1 bedrooms near downtown. Tour today.'],
    finalUrl: 'https://example.com/ashgrove-commons',
  },
];

export const NEGATIVES: Record<string, NegativeKeyword[]> = {
  'c-101': [],
  'c-102': [{ text: 'craigslist', matchType: 'PHRASE' }],
  'c-201': [],
  'c-202': [],
  'c-301': [{ text: 'for sale', matchType: 'PHRASE' }],
  'c-302': [],
};

export function defaultEndDate(now = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDay(d);
}

export function buildSandboxState(opts: { endDate?: string; seed?: number; now?: Date } = {}): SandboxState {
  const endDate = opts.endDate ?? defaultEndDate(opts.now);
  const rand = mulberry32(opts.seed ?? 20261121);
  const account: Account = {
    id: SANDBOX_ACCOUNT_ID,
    name: 'Demo Property Group (Sandbox)',
    currency: 'USD',
    timezone: 'America/Chicago',
    mode: 'sandbox',
  };

  const campaigns: Campaign[] = SPECS.map((s) => ({
    id: s.id,
    accountId: account.id,
    name: s.name,
    community: s.community,
    channel: s.channel,
    status: 'ENABLED',
    dailyBudget: s.budget,
  }));

  const metrics: Record<string, DailyMetric[]> = {};
  for (const s of SPECS) {
    const rows: DailyMetric[] = [];
    for (let i = SANDBOX_DAYS - 1; i >= 0; i--) {
      const date = addDays(endDate, -i);
      const spendNoise = 0.88 + rand() * 0.22;
      const cost = round2(Math.min(s.budget * 1.02, s.budget * s.spendRate * spendNoise));
      const cpcNoise = 0.9 + rand() * 0.2;
      const clicks = Math.max(0, Math.round(cost / (s.cpc * cpcNoise)));
      const ctrNoise = 0.85 + rand() * 0.3;
      const impressions = Math.max(clicks, Math.round(clicks / (s.ctr * ctrNoise)));
      const conversions = s.cvr > 0 ? poisson(clicks * s.cvr, rand) : 0;
      const row: DailyMetric = { date, impressions, clicks, cost, conversions };
      if (s.channel === 'SEARCH') {
        row.searchLostIsBudget = Math.max(0, Math.min(0.9, round2(s.lostIs * (0.8 + rand() * 0.4))));
      }
      rows.push(row);
    }
    metrics[s.id] = rows;
  }

  const searchTerms: SearchTermRow[] = [];
  for (const [campaignId, rows] of Object.entries(TERMS)) {
    const spec = SPECS.find((s) => s.id === campaignId)!;
    for (const [term, clicks, cost, conversions] of rows) {
      searchTerms.push({ campaignId, term, clicks, cost, conversions, impressions: Math.round(clicks / spec.ctr) });
    }
  }

  return {
    version: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    endDate,
    account,
    campaigns,
    metrics,
    searchTerms,
    searchTermDays: SANDBOX_DAYS,
    negatives: structuredClone(NEGATIVES),
    ads: structuredClone(ADS),
  };
}
