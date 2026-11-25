import type { AdsBackend, MutateResult } from '../backend.js';
import type { Account, Ad, BackendMode, Campaign, Change, ChannelType, DailyMetric, MatchType, NegativeKeyword, SearchTermRow } from '../../types.js';
import { UserError } from '../../types.js';
import { buildSandboxState, defaultEndDate, SPECS, type SandboxState } from '../seed.js';
import { normalizeKeyword, round2 } from '../../util/format.js';
import type { GoogleAdsClient } from './client.js';
import { explain } from './errors.js';
import { dashed, digits, type GoogleAdsAccountSetting, type GoogleAdsSettings } from './settings.js';

/**
 * A real Google Ads account behind the same interface as the sandbox.
 *
 * Campaigns, budgets, statuses, negative keywords and ad copy are read from
 * and written to Google Ads, with Google's own validate-only dry run.
 *
 * Performance numbers are simulated: test accounts never serve ads, so Google
 * reports no impressions, clicks or cost for them. Campaigns created by
 * npm run gads:setup carry the same names as the sandbox campaigns, and their
 * performance history comes from the same seeded simulation. Every report
 * from this backend says so.
 *
 * Changes are refused unless Google confirms the account is a test account.
 */

export interface GoogleAdsBackendOptions {
  settings: GoogleAdsSettings;
  client: GoogleAdsClient;
  /** Allow changes to live (non-test) accounts. Off unless the environment turns it on. */
  allowLive?: boolean;
  now?: () => Date;
}

interface CampaignRow {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string; resourceName?: string };
  campaignBudget?: { amountMicros?: string | number; resourceName?: string; referenceCount?: string | number };
}

interface AdRow {
  adGroupAd?: {
    status?: string;
    ad?: { id?: string; finalUrls?: string[]; responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> } };
  };
  adGroup?: { name?: string };
  campaign?: { id?: string };
}

interface CriterionRow {
  campaignCriterion?: { resourceName?: string; status?: string; keyword?: { text?: string; matchType?: string } };
}

type Plan = { resource: string; operations: unknown[] } | { errors: string[] };

const CHANNELS: Record<string, ChannelType> = { SEARCH: 'SEARCH', DISPLAY: 'DISPLAY', PERFORMANCE_MAX: 'PERFORMANCE_MAX' };
const MATCH_TYPES: MatchType[] = ['EXACT', 'PHRASE', 'BROAD'];

/** IDs go straight into queries, so only plain digits are accepted. */
const numericId = (id: string): string | null => (/^\d{1,20}$/.test(String(id ?? '').trim()) ? String(id).trim() : null);

export class GoogleAdsBackend implements AdsBackend {
  readonly mode: BackendMode;
  private readonly client: GoogleAdsClient;
  private readonly names = new Map<string, string>();
  private readonly confirmedTest = new Map<string, boolean>();
  private simState?: SandboxState;

  constructor(private readonly opts: GoogleAdsBackendOptions) {
    this.client = opts.client;
    this.mode = opts.settings.accounts.every((a) => a.testAccount) ? 'google_ads_test' : 'google_ads';
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private find(accountId: string): GoogleAdsAccountSetting | undefined {
    const d = digits(accountId);
    return d.length === 10 ? this.opts.settings.accounts.find((a) => digits(a.id) === d) : undefined;
  }

  private need(accountId: string): GoogleAdsAccountSetting {
    const a = this.find(accountId);
    if (!a) throw new UserError(`Unknown account ${accountId}. Call list_accounts for valid IDs.`);
    return a;
  }

  private toAccount(a: GoogleAdsAccountSetting): Account {
    return { id: dashed(a.id), name: a.name, currency: a.currency, timezone: a.timezone, mode: a.testAccount ? 'google_ads_test' : 'google_ads' };
  }

  /** Reads from Google; any API problem becomes a plain-English UserError. */
  private async search<T>(a: GoogleAdsAccountSetting, query: string): Promise<T[]> {
    try {
      return await this.client.search<T>(digits(a.id), query);
    } catch (e) {
      throw new UserError(explain(e));
    }
  }

  private toCampaign(a: GoogleAdsAccountSetting, row: CampaignRow): Campaign | undefined {
    const c = row.campaign;
    const channel = CHANNELS[String(c?.advertisingChannelType ?? '')];
    if (!c?.id || !c.name || !channel) return undefined;
    this.names.set(`${a.id}:${c.id}`, c.name);
    return {
      id: String(c.id),
      accountId: dashed(a.id),
      name: c.name,
      community: c.name.split('|')[0].trim() || c.name,
      channel,
      status: c.status === 'ENABLED' ? 'ENABLED' : 'PAUSED',
      dailyBudget: round2(Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000),
    };
  }

  private toAd(row: AdRow): Ad | undefined {
    const ad = row.adGroupAd?.ad;
    if (!ad?.id || !row.campaign?.id) return undefined;
    const text = (items?: Array<{ text?: string }>) => (items ?? []).map((i) => i.text ?? '').filter(Boolean);
    return {
      id: String(ad.id),
      campaignId: String(row.campaign.id),
      adGroupName: row.adGroup?.name ?? '',
      status: row.adGroupAd?.status === 'ENABLED' ? 'ENABLED' : 'PAUSED',
      headlines: text(ad.responsiveSearchAd?.headlines),
      descriptions: text(ad.responsiveSearchAd?.descriptions),
      finalUrl: ad.finalUrls?.[0] ?? '',
    };
  }

  // ---------- reads ----------

  async listAccounts(): Promise<Account[]> {
    return this.opts.settings.accounts.map((a) => this.toAccount(a));
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const a = this.find(accountId);
    return a ? this.toAccount(a) : undefined;
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    const a = this.need(accountId);
    const rows = await this.search<CampaignRow>(
      a,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros
       FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name`,
    );
    return rows.map((r) => this.toCampaign(a, r)).filter((c): c is Campaign => Boolean(c));
  }

  async getCampaign(accountId: string, campaignId: string): Promise<Campaign | undefined> {
    const a = this.find(accountId);
    const id = numericId(campaignId);
    if (!a || !id) return undefined;
    const rows = await this.search<CampaignRow>(
      a,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros
       FROM campaign WHERE campaign.id = ${id} AND campaign.status != 'REMOVED'`,
    );
    return rows.length ? this.toCampaign(a, rows[0]) : undefined;
  }

  private async campaignName(a: GoogleAdsAccountSetting, campaignId: string): Promise<string | undefined> {
    const cached = this.names.get(`${a.id}:${campaignId}`);
    if (cached) return cached;
    return (await this.getCampaign(a.id, campaignId))?.name;
  }

  private sim(): SandboxState {
    const endDate = defaultEndDate(this.now());
    if (!this.simState || this.simState.endDate !== endDate) this.simState = buildSandboxState({ endDate });
    return this.simState;
  }

  private specIdFor(name: string): string | undefined {
    const n = name.trim().toLowerCase();
    return SPECS.find((s) => s.name.toLowerCase() === n)?.id;
  }

  async getDailyMetrics(accountId: string, campaignId: string, days: number): Promise<DailyMetric[]> {
    const a = this.need(accountId);
    const name = await this.campaignName(a, campaignId);
    const spec = name ? this.specIdFor(name) : undefined;
    const rows = spec ? (this.sim().metrics[spec] ?? []) : [];
    return rows.slice(Math.max(0, rows.length - days)).map((r) => ({ ...r }));
  }

  async getSearchTerms(accountId: string, opts: { campaignId?: string; days: number }): Promise<SearchTermRow[]> {
    const campaigns = await this.listCampaigns(accountId);
    const realIdBySpec = new Map<string, string>();
    for (const c of campaigns) {
      const spec = this.specIdFor(c.name);
      if (spec) realIdBySpec.set(spec, c.id);
    }
    const sim = this.sim();
    const factor = Math.min(1, opts.days / sim.searchTermDays);
    const out: SearchTermRow[] = [];
    for (const t of sim.searchTerms) {
      const realId = realIdBySpec.get(t.campaignId);
      if (!realId || (opts.campaignId && realId !== opts.campaignId)) continue;
      out.push({
        campaignId: realId,
        term: t.term,
        impressions: Math.round(t.impressions * factor),
        clicks: Math.round(t.clicks * factor),
        cost: round2(t.cost * factor),
        conversions: Math.round(t.conversions * factor),
      });
    }
    return out;
  }

  private adQuery(where: string): string {
    return `SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
              ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status, ad_group.name, campaign.id
            FROM ad_group_ad
            WHERE ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND campaign.status != 'REMOVED'${where}`;
  }

  async listAds(accountId: string, campaignId?: string): Promise<Ad[]> {
    const a = this.need(accountId);
    let where = '';
    if (campaignId !== undefined) {
      const id = numericId(campaignId);
      if (!id) return [];
      where = ` AND campaign.id = ${id}`;
    }
    const rows = await this.search<AdRow>(a, this.adQuery(where));
    return rows.map((r) => this.toAd(r)).filter((x): x is Ad => Boolean(x));
  }

  async getAd(accountId: string, adId: string): Promise<Ad | undefined> {
    const a = this.find(accountId);
    const id = numericId(adId);
    if (!a || !id) return undefined;
    const rows = await this.search<AdRow>(a, this.adQuery(` AND ad_group_ad.ad.id = ${id}`));
    return rows.length ? this.toAd(rows[0]) : undefined;
  }

  private async negativeRows(a: GoogleAdsAccountSetting, campaignId: string): Promise<Array<NegativeKeyword & { resourceName: string }>> {
    const id = numericId(campaignId);
    if (!id) return [];
    const rows = await this.search<CriterionRow>(
      a,
      `SELECT campaign_criterion.resource_name, campaign_criterion.status, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
       FROM campaign_criterion
       WHERE campaign.id = ${id} AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'`,
    );
    const out: Array<NegativeKeyword & { resourceName: string }> = [];
    for (const r of rows) {
      const c = r.campaignCriterion;
      const matchType = c?.keyword?.matchType as MatchType | undefined;
      if (!c?.resourceName || !c.keyword?.text || !matchType || !MATCH_TYPES.includes(matchType) || c.status === 'REMOVED') continue;
      out.push({ text: normalizeKeyword(c.keyword.text), matchType, resourceName: c.resourceName });
    }
    return out;
  }

  async listNegatives(accountId: string, campaignId: string): Promise<NegativeKeyword[]> {
    const a = this.need(accountId);
    return (await this.negativeRows(a, campaignId)).map(({ text, matchType }) => ({ text, matchType }));
  }

  // ---------- changes ----------

  /** Refuses to touch an account unless Google itself says it is a test account. */
  private async assertChangeable(a: GoogleAdsAccountSetting): Promise<void> {
    if (this.opts.allowLive) return;
    let isTest = this.confirmedTest.get(a.id);
    if (isTest === undefined) {
      const rows = await this.search<{ customer?: { testAccount?: boolean } }>(a, 'SELECT customer.id, customer.test_account FROM customer LIMIT 1');
      isTest = Boolean(rows[0]?.customer?.testAccount);
      this.confirmedTest.set(a.id, isTest);
    }
    if (!isTest) {
      throw new UserError(`${a.name} (${dashed(a.id)}) is a live Google Ads account, not a test account. Campaign Ops only changes Google Ads test accounts for now, so nothing was sent.`);
    }
  }

  async mutate(accountId: string, change: Change, opts: { validateOnly: boolean }): Promise<MutateResult> {
    const a = this.find(accountId);
    if (!a) return { ok: false, errors: [`Unknown account ${accountId}`] };
    try {
      await this.assertChangeable(a);
      const plan = await this.plan(a, change);
      if ('errors' in plan) return { ok: false, errors: plan.errors };
      await this.client.mutate(digits(a.id), plan.resource, plan.operations, { validateOnly: opts.validateOnly });
      return { ok: true, errors: [] };
    } catch (e) {
      return { ok: false, errors: [explain(e)] };
    }
  }

  /** Checks the change against the live account and builds the Google Ads operations for it. */
  private async plan(a: GoogleAdsAccountSetting, change: Change): Promise<Plan> {
    const customer = digits(a.id);
    switch (change.type) {
      case 'set_campaign_budget': {
        const id = numericId(change.campaignId);
        if (!id) return { errors: [`Unknown campaign ${change.campaignId}`] };
        const rows = await this.search<CampaignRow>(
          a,
          `SELECT campaign.id, campaign_budget.resource_name, campaign_budget.reference_count
           FROM campaign WHERE campaign.id = ${id} AND campaign.status != 'REMOVED'`,
        );
        const budget = rows[0]?.campaignBudget;
        if (!rows.length || !budget?.resourceName) return { errors: [`Unknown campaign ${change.campaignId}`] };
        const errors: string[] = [];
        if (!Number.isFinite(change.newDailyBudget) || change.newDailyBudget <= 0) errors.push('Budget must be greater than zero.');
        if (Math.abs(Math.round(change.newDailyBudget * 100) - change.newDailyBudget * 100) > 1e-6) errors.push('Budget can have at most two decimal places.');
        const shared = Number(budget.referenceCount ?? 1);
        if (shared > 1) {
          errors.push(`This campaign shares its budget with ${shared - 1} other campaign${shared - 1 === 1 ? '' : 's'}. Campaign Ops only changes budgets used by one campaign, so no other campaign is affected by surprise.`);
        }
        if (errors.length) return { errors };
        return {
          resource: 'campaignBudgets',
          operations: [{ update: { resourceName: budget.resourceName, amountMicros: String(Math.round(change.newDailyBudget * 100) * 10_000) }, updateMask: 'amount_micros' }],
        };
      }

      case 'set_campaign_status': {
        const id = numericId(change.campaignId);
        if (!id || !(await this.getCampaign(a.id, id))) return { errors: [`Unknown campaign ${change.campaignId}`] };
        if (change.newStatus !== 'ENABLED' && change.newStatus !== 'PAUSED') return { errors: ['Status must be ENABLED or PAUSED.'] };
        return {
          resource: 'campaigns',
          operations: [{ update: { resourceName: `customers/${customer}/campaigns/${id}`, status: change.newStatus }, updateMask: 'status' }],
        };
      }

      case 'add_negative_keywords':
      case 'remove_negative_keywords': {
        const id = numericId(change.campaignId);
        if (!id || !(await this.getCampaign(a.id, id))) return { errors: [`Unknown campaign ${change.campaignId}`] };
        const existing = await this.negativeRows(a, id);
        const same = (k: NegativeKeyword) => existing.find((e) => e.matchType === k.matchType && e.text === normalizeKeyword(k.text));
        const errors: string[] = [];
        for (const k of change.keywords) {
          const text = normalizeKeyword(k.text);
          if (!text) errors.push('Keyword text cannot be empty.');
          if (text.length > 80) errors.push(`Keyword "${k.text}" is longer than 80 characters.`);
          if (text.split(' ').length > 10) errors.push(`Keyword "${k.text}" has more than 10 words, which Google Ads does not allow.`);
          if (!MATCH_TYPES.includes(k.matchType)) errors.push(`Match type for "${k.text}" must be EXACT, PHRASE or BROAD.`);
          const present = same(k);
          if (change.type === 'add_negative_keywords' && present) errors.push(`"${k.text}" (${k.matchType}) is already a negative keyword.`);
          if (change.type === 'remove_negative_keywords' && !present) errors.push(`"${k.text}" (${k.matchType}) is not a negative keyword.`);
        }
        if (errors.length) return { errors };
        if (change.type === 'add_negative_keywords') {
          return {
            resource: 'campaignCriteria',
            operations: change.keywords.map((k) => ({
              create: { campaign: `customers/${customer}/campaigns/${id}`, negative: true, keyword: { text: normalizeKeyword(k.text), matchType: k.matchType } },
            })),
          };
        }
        return { resource: 'campaignCriteria', operations: change.keywords.map((k) => ({ remove: same(k)!.resourceName })) };
      }

      case 'update_ad_text': {
        const id = numericId(change.adId);
        const ad = id ? await this.getAd(a.id, id) : undefined;
        if (!id || !ad) return { errors: [`Unknown ad ${change.adId}`] };
        const errors: string[] = [];
        if (change.headlines.some((h) => !h.trim())) errors.push('Headlines cannot be empty.');
        if (change.descriptions.some((d) => !d.trim())) errors.push('Descriptions cannot be empty.');
        if (change.headlines.some((h) => h.length > 30)) errors.push('Google Ads headlines can be at most 30 characters.');
        if (change.descriptions.some((d) => d.length > 90)) errors.push('Google Ads descriptions can be at most 90 characters.');
        const lower = change.headlines.map((h) => h.trim().toLowerCase());
        if (new Set(lower).size !== lower.length) errors.push('Each headline must be different. Google Ads rejects repeated headlines.');
        if (errors.length) return { errors };
        return {
          resource: 'ads',
          operations: [
            {
              update: {
                resourceName: `customers/${customer}/ads/${id}`,
                responsiveSearchAd: {
                  headlines: change.headlines.map((text) => ({ text })),
                  descriptions: change.descriptions.map((text) => ({ text })),
                },
              },
              updateMask: 'responsive_search_ad.headlines,responsive_search_ad.descriptions',
            },
          ],
        };
      }

      default: {
        const never: never = change;
        return { errors: [`Unsupported change ${(never as { type: string }).type}`] };
      }
    }
  }
}
