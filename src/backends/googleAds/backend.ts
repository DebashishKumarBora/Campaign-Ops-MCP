import type { AdsBackend, MutateOptions, MutateResult } from '../backend.js';
import type { Account, Ad, AdPolicyIssue, BackendMode, Campaign, Change, ChangeEvent, ChannelType, DailyMetric, MatchType, NegativeKeyword, SearchTermRow } from '../../types.js';
import { UserError } from '../../types.js';
import { buildSandboxState, defaultEndDate, SPECS, type SandboxState } from '../seed.js';
import { addDays, money, normalizeKeyword, round2 } from '../../util/format.js';
import { dayInZone, localInZone, zonedToUtcMs } from '../../util/time.js';
import type { GoogleAdsClient } from './client.js';
import { explain } from './errors.js';
import { dashed, digits, type GoogleAdsAccountSetting, type GoogleAdsSettings } from './settings.js';

/**
 * A real Google Ads account behind the same interface as the sandbox.
 *
 * Campaigns, budgets, statuses, negative keywords, ads and ad copy are read
 * from and written to Google Ads, with Google's own validate-only dry run.
 *
 * Performance numbers:
 *  - Live accounts: real numbers from Google (metrics and search terms).
 *  - Test accounts: simulated. Test accounts never serve ads, so Google has no
 *    clicks or cost to report. Campaigns created by npm run gads:setup carry
 *    the sandbox names and take their history from the same seeded simulation.
 *
 * Writes:
 *  - Test accounts: allowed once Google confirms the account is a test account.
 *  - Live accounts: refused unless the governance engine says a person has an
 *    open change window (MutateOptions.liveAccess). Dry runs are always allowed
 *    because they never change anything.
 */

export interface GoogleAdsBackendOptions {
  settings: GoogleAdsSettings;
  client: GoogleAdsClient;
  now?: () => Date;
  /** How long fetched performance numbers are reused, in milliseconds. */
  cacheMs?: number;
}

interface CampaignRow {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string; resourceName?: string };
  campaignBudget?: { amountMicros?: string | number; resourceName?: string; referenceCount?: string | number };
}

interface AdRow {
  adGroupAd?: {
    resourceName?: string;
    status?: string;
    ad?: { id?: string; finalUrls?: string[]; responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> } };
  };
  adGroup?: { id?: string; name?: string };
  campaign?: { id?: string };
}

interface PolicyRow {
  adGroupAd?: {
    status?: string;
    ad?: { id?: string };
    policySummary?: { approvalStatus?: string; reviewStatus?: string; policyTopicEntries?: Array<{ topic?: string; type?: string }> };
  };
  adGroup?: { name?: string };
  campaign?: { id?: string };
}

interface CriterionRow {
  campaignCriterion?: { resourceName?: string; status?: string; keyword?: { text?: string; matchType?: string } };
}

interface MetricRow {
  campaign?: { id?: string };
  segments?: { date?: string };
  metrics?: { impressions?: string | number; clicks?: string | number; costMicros?: string | number; conversions?: number | string; searchBudgetLostImpressionShare?: number | string };
}

interface TermRow {
  searchTermView?: { searchTerm?: string };
  campaign?: { id?: string };
  metrics?: { impressions?: string | number; clicks?: string | number; costMicros?: string | number; conversions?: number | string };
}

interface ChangeRow {
  changeEvent?: {
    changeDateTime?: string;
    changeResourceType?: string;
    changeResourceName?: string;
    clientType?: string;
    userEmail?: string;
    resourceChangeOperation?: string;
    changedFields?: string;
    campaign?: string;
    oldResource?: Record<string, any>;
    newResource?: Record<string, any>;
  };
}

type Plan = { resource: string; operations: unknown[] } | { errors: string[] };

const CHANNELS: Record<string, ChannelType> = {
  SEARCH: 'SEARCH',
  DISPLAY: 'DISPLAY',
  PERFORMANCE_MAX: 'PERFORMANCE_MAX',
  VIDEO: 'VIDEO',
  DEMAND_GEN: 'DEMAND_GEN',
  DISCOVERY: 'DEMAND_GEN',
  SHOPPING: 'SHOPPING',
};
const MATCH_TYPES: MatchType[] = ['EXACT', 'PHRASE', 'BROAD'];

const CLIENTS: Record<string, string> = {
  GOOGLE_ADS_API: 'Google Ads API',
  GOOGLE_ADS_WEB_CLIENT: 'Google Ads web',
  GOOGLE_ADS_EDITOR: 'Google Ads Editor',
  GOOGLE_ADS_MOBILE_APP: 'Google Ads app',
  GOOGLE_ADS_SCRIPTS: 'Google Ads scripts',
  GOOGLE_ADS_AUTOMATED_RULE: 'Automated rule',
  GOOGLE_ADS_BULK_UPLOAD: 'Bulk upload',
  GOOGLE_ADS_RECOMMENDATIONS: 'Google recommendations',
  GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: 'Auto-applied recommendation',
  SEARCH_ADS_360_SYNC: 'Search Ads 360',
  SEARCH_ADS_360_POST: 'Search Ads 360',
  INTERNAL_TOOL: 'Google support',
};

/** IDs go straight into queries, so only plain digits are accepted. */
const numericId = (id: string): string | null => (/^\d{1,20}$/.test(String(id ?? '').trim()) ? String(id).trim() : null);
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const statusWord = (s?: string) => (s === 'ENABLED' ? 'Enabled' : s === 'PAUSED' ? 'Paused' : s === 'REMOVED' ? 'Removed' : String(s ?? 'unknown').toLowerCase());
const camelToSnake = (f: string) => f.trim().replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** DESTINATION_NOT_WORKING becomes "Destination not working". */
const humanTopic = (topic: string) => {
  const t = topic.trim().replace(/_/g, ' ').toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
};

export class GoogleAdsBackend implements AdsBackend {
  readonly mode: BackendMode;
  private readonly client: GoogleAdsClient;
  private readonly names = new Map<string, string>();
  private readonly confirmedTest = new Map<string, boolean>();
  private readonly metricCache = new Map<string, { at: number; rows: Map<string, DailyMetric[]>; dates: string[] }>();
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
    return {
      id: dashed(a.id),
      name: a.name,
      currency: a.currency,
      timezone: a.timezone,
      mode: a.testAccount ? 'google_ads_test' : 'google_ads',
      numbers: a.testAccount ? 'simulated' : 'live',
    };
  }

  private login(a: GoogleAdsAccountSetting): { login?: string } {
    return a.loginCustomerId ? { login: a.loginCustomerId } : {};
  }

  /** Reads from Google; any API problem becomes a plain-English UserError. */
  private async search<T>(a: GoogleAdsAccountSetting, query: string): Promise<T[]> {
    try {
      return await this.client.search<T>(digits(a.id), query, this.login(a));
    } catch (e) {
      throw new UserError(explain(e));
    }
  }

  private toCampaign(a: GoogleAdsAccountSetting, row: CampaignRow): Campaign | undefined {
    const c = row.campaign;
    if (!c?.id || !c.name) return undefined;
    const channel = CHANNELS[String(c.advertisingChannelType ?? '')] ?? 'OTHER';
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
      adGroupId: row.adGroup?.id ? String(row.adGroup.id) : undefined,
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

  /** The last `days` complete days in the account's time zone, oldest first. */
  private window(a: GoogleAdsAccountSetting, days: number): { from: string; to: string; dates: string[] } {
    const n = Math.max(1, Math.min(90, Math.round(days)));
    const to = addDays(dayInZone(this.now().getTime(), a.timezone), -1);
    const from = addDays(to, -(n - 1));
    const dates: string[] = [];
    for (let i = 0; i < n; i++) dates.push(addDays(from, i));
    return { from, to, dates };
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

  /** Real daily numbers for every campaign in one query, reused for a short while. */
  private async liveMetrics(a: GoogleAdsAccountSetting, days: number): Promise<{ rows: Map<string, DailyMetric[]>; dates: string[] }> {
    const w = this.window(a, days);
    const key = `${a.id}:${w.from}:${w.to}`;
    const hit = this.metricCache.get(key);
    if (hit && this.now().getTime() - hit.at < (this.opts.cacheMs ?? 120_000)) return hit;
    const raw = await this.search<MetricRow>(
      a,
      `SELECT campaign.id, campaign.advertising_channel_type, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros,
              metrics.conversions, metrics.search_budget_lost_impression_share
       FROM campaign
       WHERE segments.date BETWEEN '${w.from}' AND '${w.to}' AND campaign.status != 'REMOVED'`,
    );
    const byCampaign = new Map<string, Map<string, DailyMetric>>();
    for (const r of raw) {
      const id = r.campaign?.id ? String(r.campaign.id) : '';
      const date = r.segments?.date;
      if (!id || !date) continue;
      if (!byCampaign.has(id)) byCampaign.set(id, new Map());
      const m = r.metrics ?? {};
      const row: DailyMetric = {
        date,
        impressions: num(m.impressions),
        clicks: num(m.clicks),
        cost: round2(num(m.costMicros) / 1_000_000),
        conversions: round2(num(m.conversions)),
      };
      const channel = (r as { campaign?: { advertisingChannelType?: string } }).campaign?.advertisingChannelType;
      if (channel === 'SEARCH' && row.impressions > 0) row.searchLostIsBudget = round2(num(m.searchBudgetLostImpressionShare));
      byCampaign.get(id)!.set(date, row);
    }
    const rows = new Map<string, DailyMetric[]>();
    for (const [id, byDate] of byCampaign) {
      rows.set(id, w.dates.map((d) => byDate.get(d) ?? { date: d, impressions: 0, clicks: 0, cost: 0, conversions: 0 }));
    }
    const entry = { at: this.now().getTime(), rows, dates: w.dates };
    this.metricCache.set(key, entry);
    return entry;
  }

  async getDailyMetrics(accountId: string, campaignId: string, days: number): Promise<DailyMetric[]> {
    const a = this.need(accountId);
    if (!a.testAccount) {
      const live = await this.liveMetrics(a, days);
      return (live.rows.get(String(campaignId)) ?? live.dates.map((d) => ({ date: d, impressions: 0, clicks: 0, cost: 0, conversions: 0 }))).map((r) => ({ ...r }));
    }
    const name = await this.campaignName(a, campaignId);
    const spec = name ? this.specIdFor(name) : undefined;
    const rows = spec ? (this.sim().metrics[spec] ?? []) : [];
    return rows.slice(Math.max(0, rows.length - days)).map((r) => ({ ...r }));
  }

  async getSearchTerms(accountId: string, opts: { campaignId?: string; days: number }): Promise<SearchTermRow[]> {
    const a = this.need(accountId);
    if (!a.testAccount) return this.liveSearchTerms(a, opts);
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

  /** Real search terms, summed per campaign (Google reports them per ad group). */
  private async liveSearchTerms(a: GoogleAdsAccountSetting, opts: { campaignId?: string; days: number }): Promise<SearchTermRow[]> {
    const w = this.window(a, opts.days);
    let where = `segments.date BETWEEN '${w.from}' AND '${w.to}' AND metrics.cost_micros > 0`;
    if (opts.campaignId !== undefined) {
      const id = numericId(opts.campaignId);
      if (!id) return [];
      where += ` AND campaign.id = ${id}`;
    }
    const raw = await this.search<TermRow>(
      a,
      `SELECT search_term_view.search_term, campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
       FROM search_term_view WHERE ${where} ORDER BY metrics.cost_micros DESC LIMIT 5000`,
    );
    const merged = new Map<string, SearchTermRow>();
    for (const r of raw) {
      const term = r.searchTermView?.searchTerm;
      const campaignId = r.campaign?.id ? String(r.campaign.id) : '';
      if (!term || !campaignId) continue;
      const key = `${campaignId}|${term.toLowerCase()}`;
      const m = r.metrics ?? {};
      const row = merged.get(key) ?? { campaignId, term, impressions: 0, clicks: 0, cost: 0, conversions: 0 };
      row.impressions += num(m.impressions);
      row.clicks += num(m.clicks);
      row.cost = round2(row.cost + num(m.costMicros) / 1_000_000);
      row.conversions = round2(row.conversions + num(m.conversions));
      merged.set(key, row);
    }
    return [...merged.values()].sort((x, y) => y.cost - x.cost);
  }

  private adQuery(where: string): string {
    return `SELECT ad_group_ad.resource_name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
              ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status, ad_group.id, ad_group.name, campaign.id
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

  /** Running ads Google disapproved or limited, with its policy topics in plain words. */
  async getAdPolicyIssues(accountId: string): Promise<AdPolicyIssue[]> {
    const a = this.need(accountId);
    const rows = await this.search<PolicyRow>(
      a,
      `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
              ad_group_ad.policy_summary.policy_topic_entries, ad_group.name, campaign.id
       FROM ad_group_ad
       WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
    );
    const out: AdPolicyIssue[] = [];
    for (const r of rows) {
      const id = r.adGroupAd?.ad?.id;
      const status = r.adGroupAd?.policySummary?.approvalStatus;
      if (!id || !r.campaign?.id) continue;
      const approval = status === 'DISAPPROVED' ? 'DISAPPROVED' : status === 'APPROVED_LIMITED' || status === 'AREA_OF_INTEREST_ONLY' ? 'LIMITED' : undefined;
      if (!approval) continue;
      const topics = [...new Set((r.adGroupAd?.policySummary?.policyTopicEntries ?? []).map((t) => humanTopic(t.topic ?? '')).filter(Boolean))];
      out.push({ adId: String(id), campaignId: String(r.campaign.id), adGroupName: r.adGroup?.name ?? '', approval, topics });
    }
    return out;
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

  // ---------- Google's own change history ----------

  /**
   * Google Ads keeps every change for 30 days: who made it, with what tool,
   * and the values before and after. Campaign Ops checks itself against it.
   */
  async getChangeHistory(accountId: string, opts: { days: number }): Promise<ChangeEvent[]> {
    const a = this.need(accountId);
    const days = Math.max(1, Math.min(28, Math.round(opts.days)));
    const nowMs = this.now().getTime();
    const start = localInZone(nowMs - days * 86_400_000, a.timezone);
    const end = localInZone(nowMs + 60_000, a.timezone);
    const rows = await this.search<ChangeRow>(
      a,
      `SELECT change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, change_event.client_type,
              change_event.user_email, change_event.resource_change_operation, change_event.changed_fields, change_event.campaign,
              change_event.old_resource, change_event.new_resource
       FROM change_event
       WHERE change_event.change_date_time >= '${start}' AND change_event.change_date_time <= '${end}'
       ORDER BY change_event.change_date_time DESC
       LIMIT 10000`,
    );
    const robot = this.client.robotEmail.toLowerCase();
    const out: ChangeEvent[] = [];
    for (const r of rows) {
      const e = r.changeEvent;
      if (!e?.changeDateTime || !e.changeResourceName) continue;
      const ms = zonedToUtcMs(e.changeDateTime, a.timezone);
      if (!Number.isFinite(ms)) continue;
      const op = e.resourceChangeOperation === 'CREATE' || e.resourceChangeOperation === 'REMOVE' ? e.resourceChangeOperation : 'UPDATE';
      const campaignId = e.campaign?.split('/').pop() || /campaigns\/(\d+)/.exec(e.changeResourceName)?.[1] || /campaignCriteria\/(\d+)~/.exec(e.changeResourceName)?.[1];
      const adId = /\/ads\/(\d+)$/.exec(e.changeResourceName)?.[1] ?? /adGroupAds\/\d+~(\d+)$/.exec(e.changeResourceName)?.[1];
      const actor = String(e.userEmail ?? '').trim() || 'unknown';
      const event: ChangeEvent = {
        at: new Date(ms).toISOString(),
        actor,
        byRobot: actor.toLowerCase() === robot,
        client: CLIENTS[String(e.clientType ?? '')] ?? String(e.clientType ?? 'Other').replace(/_/g, ' ').toLowerCase(),
        operation: op,
        resourceType: String(e.changeResourceType ?? 'UNKNOWN'),
        resourceName: e.changeResourceName,
        campaignId: campaignId || undefined,
        adId: adId || undefined,
        fields: String(e.changedFields ?? '')
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
          .map(camelToSnake),
        summary: '',
      };
      event.summary = await this.summarize(a, event, e.oldResource ?? {}, e.newResource ?? {});
      out.push(event);
    }
    return out;
  }

  private async summarize(a: GoogleAdsAccountSetting, e: ChangeEvent, before: Record<string, any>, after: Record<string, any>): Promise<string> {
    const name = e.campaignId ? (this.names.get(`${a.id}:${e.campaignId}`) ?? (await this.campaignName(a, e.campaignId).catch(() => undefined)) ?? `campaign ${e.campaignId}`) : '';
    const of = name ? ` of ${name}` : '';
    switch (e.resourceType) {
      case 'CAMPAIGN_BUDGET': {
        const old = before.campaignBudget?.amountMicros;
        const now = after.campaignBudget?.amountMicros;
        if (e.operation === 'CREATE') return `Created a budget of ${money(num(now) / 1_000_000, a.currency)}`;
        if (old !== undefined && now !== undefined) return `Daily budget${of} changed from ${money(num(old) / 1_000_000, a.currency)} to ${money(num(now) / 1_000_000, a.currency)}`;
        return `Budget${of} updated`;
      }
      case 'CAMPAIGN': {
        if (e.operation === 'CREATE') return `Created campaign ${after.campaign?.name ?? name}`;
        if (e.operation === 'REMOVE') return `Removed campaign ${name || e.resourceName}`;
        if (e.fields.includes('status')) return `${name || 'Campaign'} changed from ${statusWord(before.campaign?.status)} to ${statusWord(after.campaign?.status)}`;
        return `${name || 'Campaign'} settings updated (${e.fields.map((f) => f.replace(/[_.]/g, ' ')).join(', ') || 'details'})`;
      }
      case 'CAMPAIGN_CRITERION': {
        const k = after.campaignCriterion?.keyword ?? before.campaignCriterion?.keyword;
        const neg = (after.campaignCriterion ?? before.campaignCriterion)?.negative;
        const what = k?.text ? `${neg ? 'negative keyword' : 'keyword'} "${k.text}"${k.matchType ? ` (${String(k.matchType).toLowerCase()})` : ''}` : 'a campaign setting';
        if (e.operation === 'CREATE') return `Added ${what}${name ? ` to ${name}` : ''}`;
        if (e.operation === 'REMOVE') return `Removed ${what}${name ? ` from ${name}` : ''}`;
        return `Updated ${what}${name ? ` in ${name}` : ''}`;
      }
      case 'AD':
        return `Copy of ad ${e.adId ?? ''}${name ? ` in ${name}` : ''} updated`.replace(/\s+/g, ' ');
      case 'AD_GROUP_AD': {
        if (e.operation === 'CREATE') return `Created ad ${e.adId ?? ''}${name ? ` in ${name}` : ''}`.replace(/\s+/g, ' ');
        if (e.fields.includes('status')) return `Ad ${e.adId ?? ''}${name ? ` in ${name}` : ''} changed from ${statusWord(before.adGroupAd?.status)} to ${statusWord(after.adGroupAd?.status)}`.replace(/\s+/g, ' ');
        return `Ad ${e.adId ?? ''} updated`.replace(/\s+/g, ' ');
      }
      default: {
        const thing = e.resourceType.toLowerCase().replace(/_/g, ' ');
        const verb = e.operation === 'CREATE' ? 'Created' : e.operation === 'REMOVE' ? 'Removed' : 'Updated';
        return `${verb} ${thing}${name ? ` in ${name}` : ''}`;
      }
    }
  }

  // ---------- changes ----------

  /** Google's answer to "is this a test account?", asked once per account. */
  private async isTestAccount(a: GoogleAdsAccountSetting): Promise<boolean> {
    let isTest = this.confirmedTest.get(a.id);
    if (isTest === undefined) {
      const rows = await this.search<{ customer?: { testAccount?: boolean } }>(a, 'SELECT customer.id, customer.test_account FROM customer LIMIT 1');
      isTest = Boolean(rows[0]?.customer?.testAccount);
      this.confirmedTest.set(a.id, isTest);
    }
    return isTest;
  }

  async mutate(accountId: string, change: Change, opts: MutateOptions): Promise<MutateResult> {
    const a = this.find(accountId);
    if (!a) return { ok: false, errors: [`Unknown account ${accountId}`] };
    try {
      if (a.testAccount) {
        // Saved as a test account: Google must agree, or nothing is sent at all (not even a dry run).
        if (!(await this.isTestAccount(a))) {
          throw new UserError(
            `Google says ${a.name} (${dashed(a.id)}) is a live Google Ads account, not a test account, but it was saved as a test account. Nothing was sent. To manage it as a live account, run npm run gads:add: it stays read-only until a person opens a change window.`,
          );
        }
      } else if (!opts.validateOnly && !opts.liveAccess) {
        throw new UserError(
          `${a.name} (${dashed(a.id)}) is a live Google Ads account and no change window is open, so nothing was sent. A person can open a change window in the approval console.`,
        );
      }
      const plan = await this.plan(a, change);
      if ('errors' in plan) return { ok: false, errors: plan.errors };
      await this.client.mutate(digits(a.id), plan.resource, plan.operations, { validateOnly: opts.validateOnly, ...this.login(a) });
      if (!opts.validateOnly) this.metricCache.clear();
      return { ok: true, errors: [] };
    } catch (e) {
      return { ok: false, errors: [e instanceof UserError ? e.message : explain(e)] };
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

      case 'set_ad_status': {
        const id = numericId(change.adId);
        const ad = id ? await this.getAd(a.id, id) : undefined;
        if (!id || !ad) return { errors: [`Unknown ad ${change.adId}`] };
        if (!ad.adGroupId) return { errors: [`Google did not report the ad group for ad ${change.adId}.`] };
        if (change.newStatus !== 'ENABLED' && change.newStatus !== 'PAUSED') return { errors: ['Status must be ENABLED or PAUSED.'] };
        return {
          resource: 'adGroupAds',
          operations: [{ update: { resourceName: `customers/${customer}/adGroupAds/${ad.adGroupId}~${id}`, status: change.newStatus }, updateMask: 'status' }],
        };
      }

      default: {
        const never: never = change;
        return { errors: [`Unsupported change ${(never as { type: string }).type}`] };
      }
    }
  }
}
