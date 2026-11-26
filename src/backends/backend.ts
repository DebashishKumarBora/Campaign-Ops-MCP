import type { Account, Ad, AdPolicyIssue, BackendMode, Campaign, Change, ChangeEvent, DailyMetric, NegativeKeyword, SearchTermRow } from '../types.js';

export interface MutateResult {
  ok: boolean;
  errors: string[];
}

export interface MutateOptions {
  /** Check the change and report errors without writing anything (Google calls this validate_only). */
  validateOnly: boolean;
  /**
   * Set only by the governance engine, and only while a person has an open
   * change window for a live (non-test) account. Backends refuse real writes
   * to live accounts without it.
   */
  liveAccess?: boolean;
}

/**
 * The only thing the governance layer knows about an ad platform.
 * The sandbox implements it with synthetic data; the Google Ads backend
 * implements the same interface against the real API.
 * Every method is async because real backends make network calls.
 */
export interface AdsBackend {
  readonly mode: BackendMode;
  listAccounts(): Promise<Account[]>;
  getAccount(accountId: string): Promise<Account | undefined>;
  listCampaigns(accountId: string): Promise<Campaign[]>;
  getCampaign(accountId: string, campaignId: string): Promise<Campaign | undefined>;
  getDailyMetrics(accountId: string, campaignId: string, days: number): Promise<DailyMetric[]>;
  getSearchTerms(accountId: string, opts: { campaignId?: string; days: number }): Promise<SearchTermRow[]>;
  listAds(accountId: string, campaignId?: string): Promise<Ad[]>;
  getAd(accountId: string, adId: string): Promise<Ad | undefined>;
  listNegatives(accountId: string, campaignId: string): Promise<NegativeKeyword[]>;
  /** Applies one change, or with validateOnly checks it without writing. */
  mutate(accountId: string, change: Change, opts: MutateOptions): Promise<MutateResult>;
  /**
   * The platform's own record of changes, newest first. Optional: a backend
   * without one reports nothing and the witness check says so.
   */
  getChangeHistory?(accountId: string, opts: { days: number }): Promise<ChangeEvent[]>;
  /**
   * When the platform's record begins, if later than its normal retention
   * (a sandbox rebuilt today has no record of last week). ISO time.
   */
  changeHistoryStart?(accountId: string): Promise<string | undefined>;
  /** Running ads the platform disapproved or limited. Optional: the sandbox has no policy review. */
  getAdPolicyIssues?(accountId: string): Promise<AdPolicyIssue[]>;
}
