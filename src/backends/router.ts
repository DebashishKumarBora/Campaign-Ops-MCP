import type { AdsBackend, MutateOptions, MutateResult } from './backend.js';
import type { Account, Ad, BackendMode, Campaign, Change, ChangeEvent, DailyMetric, NegativeKeyword, SearchTermRow } from '../types.js';
import { UserError } from '../types.js';

/**
 * Several backends behind one interface, so the sandbox and a Google Ads
 * test account can sit side by side. Each call goes to the backend that owns
 * the account ID.
 */
export class RouterBackend implements AdsBackend {
  private readonly owners = new Map<string, AdsBackend>();

  constructor(private readonly backends: AdsBackend[]) {
    if (backends.length === 0) throw new Error('RouterBackend needs at least one backend.');
  }

  /** "sandbox" when only the sandbox is connected, otherwise the real backend's mode. */
  get mode(): BackendMode {
    return this.backends.find((b) => b.mode !== 'sandbox')?.mode ?? 'sandbox';
  }

  get parts(): readonly AdsBackend[] {
    return this.backends;
  }

  private async route(accountId: string): Promise<AdsBackend | undefined> {
    const known = this.owners.get(accountId);
    if (known) return known;
    for (const b of this.backends) {
      if (await b.getAccount(accountId)) {
        this.owners.set(accountId, b);
        return b;
      }
    }
    return undefined;
  }

  private async need(accountId: string): Promise<AdsBackend> {
    const b = await this.route(accountId);
    if (!b) throw new UserError(`Unknown account ${accountId}. Call list_accounts for valid IDs.`);
    return b;
  }

  async listAccounts(): Promise<Account[]> {
    const out: Account[] = [];
    for (const b of this.backends) {
      try {
        out.push(...(await b.listAccounts()));
      } catch (e) {
        console.error('[campaign-ops] could not list accounts for', b.mode, (e as Error).message);
      }
    }
    return out;
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const b = await this.route(accountId);
    return b ? b.getAccount(accountId) : undefined;
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    return (await this.need(accountId)).listCampaigns(accountId);
  }

  async getCampaign(accountId: string, campaignId: string): Promise<Campaign | undefined> {
    const b = await this.route(accountId);
    return b ? b.getCampaign(accountId, campaignId) : undefined;
  }

  async getDailyMetrics(accountId: string, campaignId: string, days: number): Promise<DailyMetric[]> {
    return (await this.need(accountId)).getDailyMetrics(accountId, campaignId, days);
  }

  async getSearchTerms(accountId: string, opts: { campaignId?: string; days: number }): Promise<SearchTermRow[]> {
    return (await this.need(accountId)).getSearchTerms(accountId, opts);
  }

  async listAds(accountId: string, campaignId?: string): Promise<Ad[]> {
    return (await this.need(accountId)).listAds(accountId, campaignId);
  }

  async getAd(accountId: string, adId: string): Promise<Ad | undefined> {
    const b = await this.route(accountId);
    return b ? b.getAd(accountId, adId) : undefined;
  }

  async listNegatives(accountId: string, campaignId: string): Promise<NegativeKeyword[]> {
    return (await this.need(accountId)).listNegatives(accountId, campaignId);
  }

  async mutate(accountId: string, change: Change, opts: MutateOptions): Promise<MutateResult> {
    const b = await this.route(accountId);
    if (!b) return { ok: false, errors: [`Unknown account ${accountId}`] };
    return b.mutate(accountId, change, opts);
  }

  /** Undefined when the owning backend keeps no change history, so callers can say so. */
  async getChangeHistory(accountId: string, opts: { days: number }): Promise<ChangeEvent[]> {
    const b = await this.need(accountId);
    if (!b.getChangeHistory) throw new UserError('This account has no change history to check against.');
    return b.getChangeHistory(accountId, opts);
  }

  async changeHistoryStart(accountId: string): Promise<string | undefined> {
    const b = await this.route(accountId);
    return b?.changeHistoryStart ? b.changeHistoryStart(accountId) : undefined;
  }

  /** True when the backend that owns the account can report its change history. */
  async hasChangeHistory(accountId: string): Promise<boolean> {
    const b = await this.route(accountId);
    return Boolean(b?.getChangeHistory);
  }
}
