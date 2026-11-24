import type { Account, Ad, BackendMode, Campaign, Change, DailyMetric, NegativeKeyword, SearchTermRow } from '../types.js';

export interface MutateResult {
  ok: boolean;
  errors: string[];
}

/**
 * The only thing the governance layer knows about an ad platform.
 * The sandbox implements it with synthetic data; a Google Ads test-account
 * backend implements the same interface against the real API.
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
  /**
   * Applies one change. With validateOnly the backend checks the change and
   * reports errors without writing anything (the Google Ads API calls this validate_only).
   */
  mutate(accountId: string, change: Change, opts: { validateOnly: boolean }): Promise<MutateResult>;
}
