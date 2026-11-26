import fs from 'node:fs';
import type { AdsBackend, MutateOptions, MutateResult } from './backend.js';
import type { Account, Ad, Campaign, Change, ChangeEvent, DailyMetric, NegativeKeyword, SearchTermRow } from '../types.js';
import { buildSandboxState, type SandboxState } from './seed.js';
import { readJson, writeJsonAtomic } from '../util/fsx.js';
import { money, normalizeKeyword, round2 } from '../util/format.js';

/**
 * A fake Google Ads account stored in one JSON file. It behaves like the real
 * API where it matters for safety: it validates before writing, supports
 * validate-only dry runs, rejects bad input with readable errors and keeps
 * its own change history, like Google's, for the witness check.
 */

export interface SandboxOptions {
  /** Injectable clock in milliseconds, so recorded change times match the engine's clock in tests. */
  clock?: () => number;
}

/** How long the sandbox keeps its change history, like Google Ads. */
const HISTORY_DAYS = 30;
const ROBOT = 'Campaign Ops robot (sandbox)';

export class SandboxBackend implements AdsBackend {
  readonly mode = 'sandbox' as const;

  constructor(
    private readonly file: string,
    private readonly opts: SandboxOptions = {},
  ) {}

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** Creates the sandbox account on first run. */
  ensure(opts: { endDate?: string; now?: Date } = {}): void {
    if (!fs.existsSync(this.file)) writeJsonAtomic(this.file, buildSandboxState({ now: new Date(this.now()), ...opts }));
  }

  reset(opts: { endDate?: string; now?: Date } = {}): void {
    writeJsonAtomic(this.file, buildSandboxState({ now: new Date(this.now()), ...opts }));
  }

  load(): SandboxState {
    this.ensure();
    const state = readJson<SandboxState | null>(this.file, null);
    if (!state || state.version !== 1) throw new Error('The sandbox file is missing or from another version. Run npm run reset.');
    if (!state.changeHistory) {
      // A sandbox from an earlier version: its own record of changes starts now.
      state.changeHistory = [];
      state.historyStartedAt = new Date(this.now()).toISOString();
      this.save(state);
    }
    return state;
  }

  private save(state: SandboxState): void {
    writeJsonAtomic(this.file, state);
  }

  /** Simulates someone editing the account outside this tool (used by tests and the demo). */
  externalEdit(edit: (state: SandboxState) => void): void {
    const state = this.load();
    edit(state);
    this.save(state);
  }

  private requireAccount(state: SandboxState, accountId: string): void {
    if (state.account.id !== accountId) throw new Error(`Unknown account ${accountId}`);
  }

  private withNumbers(a: Account): Account {
    return { ...a, numbers: 'synthetic' };
  }

  async listAccounts(): Promise<Account[]> {
    return [this.withNumbers(this.load().account)];
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const state = this.load();
    return state.account.id === accountId ? this.withNumbers(state.account) : undefined;
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    const state = this.load();
    this.requireAccount(state, accountId);
    return state.campaigns;
  }

  async getCampaign(accountId: string, campaignId: string): Promise<Campaign | undefined> {
    const state = this.load();
    if (state.account.id !== accountId) return undefined;
    return state.campaigns.find((c) => c.id === campaignId);
  }

  async getDailyMetrics(accountId: string, campaignId: string, days: number): Promise<DailyMetric[]> {
    const state = this.load();
    this.requireAccount(state, accountId);
    const rows = state.metrics[campaignId] ?? [];
    return rows.slice(Math.max(0, rows.length - days));
  }

  async getSearchTerms(accountId: string, opts: { campaignId?: string; days: number }): Promise<SearchTermRow[]> {
    const state = this.load();
    this.requireAccount(state, accountId);
    const factor = Math.min(1, opts.days / state.searchTermDays);
    return state.searchTerms
      .filter((t) => !opts.campaignId || t.campaignId === opts.campaignId)
      .map((t) => ({
        ...t,
        impressions: Math.round(t.impressions * factor),
        clicks: Math.round(t.clicks * factor),
        cost: round2(t.cost * factor),
        conversions: Math.round(t.conversions * factor),
      }));
  }

  async listAds(accountId: string, campaignId?: string): Promise<Ad[]> {
    const state = this.load();
    this.requireAccount(state, accountId);
    return state.ads.filter((a) => !campaignId || a.campaignId === campaignId);
  }

  async getAd(accountId: string, adId: string): Promise<Ad | undefined> {
    const state = this.load();
    if (state.account.id !== accountId) return undefined;
    return state.ads.find((a) => a.id === adId);
  }

  async listNegatives(accountId: string, campaignId: string): Promise<NegativeKeyword[]> {
    const state = this.load();
    this.requireAccount(state, accountId);
    return state.negatives[campaignId] ?? [];
  }

  async mutate(accountId: string, change: Change, opts: MutateOptions): Promise<MutateResult> {
    const state = this.load();
    const errors = validate(state, accountId, change);
    if (errors.length > 0 || opts.validateOnly) return { ok: errors.length === 0, errors };
    const events = describe(state, change, new Date(this.now()).toISOString());
    applyChange(state, change);
    const cutoff = this.now() - HISTORY_DAYS * 86_400_000;
    state.changeHistory = [...(state.changeHistory ?? []), ...events].filter((e) => Date.parse(e.at) >= cutoff);
    this.save(state);
    return { ok: true, errors: [] };
  }

  /** The sandbox's record starts when it was built: changes made to an earlier sandbox are not in it. */
  async changeHistoryStart(accountId: string): Promise<string | undefined> {
    const state = this.load();
    this.requireAccount(state, accountId);
    return state.historyStartedAt ?? state.generatedAt;
  }

  async getChangeHistory(accountId: string, opts: { days: number }): Promise<ChangeEvent[]> {
    const state = this.load();
    this.requireAccount(state, accountId);
    const since = this.now() - Math.min(opts.days, HISTORY_DAYS) * 86_400_000;
    return (state.changeHistory ?? [])
      .filter((e) => Date.parse(e.at) >= since && Date.parse(e.at) <= this.now() + 60_000)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .map((e) => ({ ...e, fields: [...e.fields] }));
  }
}

function sameKeyword(a: NegativeKeyword, b: NegativeKeyword): boolean {
  return a.matchType === b.matchType && normalizeKeyword(a.text) === normalizeKeyword(b.text);
}

function validate(state: SandboxState, accountId: string, change: Change): string[] {
  if (state.account.id !== accountId) return [`Unknown account ${accountId}`];
  const errors: string[] = [];
  switch (change.type) {
    case 'set_campaign_budget': {
      const c = state.campaigns.find((x) => x.id === change.campaignId);
      if (!c) return [`Unknown campaign ${change.campaignId}`];
      if (!Number.isFinite(change.newDailyBudget) || change.newDailyBudget <= 0) errors.push('Budget must be greater than zero.');
      if (Math.abs(Math.round(change.newDailyBudget * 100) - change.newDailyBudget * 100) > 1e-6) errors.push('Budget can have at most two decimal places.');
      break;
    }
    case 'set_campaign_status': {
      if (!state.campaigns.some((x) => x.id === change.campaignId)) return [`Unknown campaign ${change.campaignId}`];
      if (change.newStatus !== 'ENABLED' && change.newStatus !== 'PAUSED') errors.push('Status must be ENABLED or PAUSED.');
      break;
    }
    case 'add_negative_keywords':
    case 'remove_negative_keywords': {
      if (!state.campaigns.some((x) => x.id === change.campaignId)) return [`Unknown campaign ${change.campaignId}`];
      const existing = state.negatives[change.campaignId] ?? [];
      for (const k of change.keywords) {
        if (!k.text.trim()) errors.push('Keyword text cannot be empty.');
        if (k.text.length > 80) errors.push(`Keyword "${k.text}" is longer than 80 characters.`);
        const present = existing.some((e) => sameKeyword(e, k));
        if (change.type === 'add_negative_keywords' && present) errors.push(`"${k.text}" (${k.matchType}) is already a negative keyword.`);
        if (change.type === 'remove_negative_keywords' && !present) errors.push(`"${k.text}" (${k.matchType}) is not a negative keyword.`);
      }
      break;
    }
    case 'update_ad_text': {
      const ad = state.ads.find((a) => a.id === change.adId);
      if (!ad) return [`Unknown ad ${change.adId}`];
      if (change.headlines.some((h) => !h.trim())) errors.push('Headlines cannot be empty.');
      if (change.descriptions.some((d) => !d.trim())) errors.push('Descriptions cannot be empty.');
      if (change.headlines.some((h) => h.length > 30)) errors.push('Google Ads headlines can be at most 30 characters.');
      if (change.descriptions.some((d) => d.length > 90)) errors.push('Google Ads descriptions can be at most 90 characters.');
      break;
    }
    case 'set_ad_status': {
      if (!state.ads.some((a) => a.id === change.adId)) return [`Unknown ad ${change.adId}`];
      if (change.newStatus !== 'ENABLED' && change.newStatus !== 'PAUSED') errors.push('Status must be ENABLED or PAUSED.');
      break;
    }
    default: {
      const never: never = change;
      errors.push(`Unsupported change ${(never as { type: string }).type}`);
    }
  }
  return errors;
}

const statusWord = (s: string) => (s === 'ENABLED' ? 'Enabled' : 'Paused');

/** The change-history entries a change produces, recorded the way Google records them. */
function describe(state: SandboxState, change: Change, at: string): ChangeEvent[] {
  const prefix = `customers/${state.account.id.replace(/\D/g, '')}`;
  const base = { at, actor: ROBOT, byRobot: true, client: 'Campaign Ops API' };
  const campaignName = (id: string) => state.campaigns.find((c) => c.id === id)?.name ?? id;
  switch (change.type) {
    case 'set_campaign_budget': {
      const c = state.campaigns.find((x) => x.id === change.campaignId)!;
      return [{ ...base, operation: 'UPDATE', resourceType: 'CAMPAIGN_BUDGET', resourceName: `${prefix}/campaignBudgets/${c.id}`, campaignId: c.id, fields: ['amount_micros'], summary: `Daily budget of ${c.name} changed from ${money(c.dailyBudget)} to ${money(change.newDailyBudget)}` }];
    }
    case 'set_campaign_status': {
      const c = state.campaigns.find((x) => x.id === change.campaignId)!;
      return [{ ...base, operation: 'UPDATE', resourceType: 'CAMPAIGN', resourceName: `${prefix}/campaigns/${c.id}`, campaignId: c.id, fields: ['status'], summary: `${c.name} changed from ${statusWord(c.status)} to ${statusWord(change.newStatus)}` }];
    }
    case 'add_negative_keywords':
    case 'remove_negative_keywords': {
      const adding = change.type === 'add_negative_keywords';
      return change.keywords.map((k, i) => ({
        ...base,
        operation: adding ? ('CREATE' as const) : ('REMOVE' as const),
        resourceType: 'CAMPAIGN_CRITERION',
        resourceName: `${prefix}/campaignCriteria/${change.campaignId}~${normalizeKeyword(k.text).replace(/\s+/g, '-')}-${i}`,
        campaignId: change.campaignId,
        fields: adding ? ['keyword.text', 'keyword.match_type', 'negative'] : [],
        summary: `${adding ? 'Added' : 'Removed'} negative keyword "${normalizeKeyword(k.text)}" (${k.matchType.toLowerCase()}) ${adding ? 'to' : 'from'} ${campaignName(change.campaignId)}`,
      }));
    }
    case 'update_ad_text': {
      const ad = state.ads.find((a) => a.id === change.adId)!;
      const changed =
        change.headlines.filter((h, i) => ad.headlines[i] !== h).length +
        Math.max(0, ad.headlines.length - change.headlines.length) +
        change.descriptions.filter((d, i) => ad.descriptions[i] !== d).length +
        Math.max(0, ad.descriptions.length - change.descriptions.length);
      return [{ ...base, operation: 'UPDATE', resourceType: 'AD', resourceName: `${prefix}/ads/${ad.id}`, campaignId: ad.campaignId, adId: ad.id, fields: ['responsive_search_ad.headlines', 'responsive_search_ad.descriptions'], summary: `Copy of ad ${ad.id} in ${campaignName(ad.campaignId)} updated (${changed} line${changed === 1 ? '' : 's'})` }];
    }
    case 'set_ad_status': {
      const ad = state.ads.find((a) => a.id === change.adId)!;
      return [{ ...base, operation: 'UPDATE', resourceType: 'AD_GROUP_AD', resourceName: `${prefix}/adGroupAds/${ad.adGroupName.replace(/\s+/g, '-')}~${ad.id}`, campaignId: ad.campaignId, adId: ad.id, fields: ['status'], summary: `Ad ${ad.id} in ${campaignName(ad.campaignId)} changed from ${statusWord(ad.status)} to ${statusWord(change.newStatus)}` }];
    }
  }
}

function applyChange(state: SandboxState, change: Change): void {
  switch (change.type) {
    case 'set_campaign_budget': {
      state.campaigns.find((c) => c.id === change.campaignId)!.dailyBudget = change.newDailyBudget;
      break;
    }
    case 'set_campaign_status': {
      state.campaigns.find((c) => c.id === change.campaignId)!.status = change.newStatus;
      break;
    }
    case 'add_negative_keywords': {
      const list = (state.negatives[change.campaignId] ??= []);
      for (const k of change.keywords) list.push({ text: normalizeKeyword(k.text), matchType: k.matchType });
      break;
    }
    case 'remove_negative_keywords': {
      const list = state.negatives[change.campaignId] ?? [];
      state.negatives[change.campaignId] = list.filter((e) => !change.keywords.some((k) => sameKeyword(e, k)));
      break;
    }
    case 'update_ad_text': {
      const ad = state.ads.find((a) => a.id === change.adId)!;
      ad.headlines = [...change.headlines];
      ad.descriptions = [...change.descriptions];
      break;
    }
    case 'set_ad_status': {
      state.ads.find((a) => a.id === change.adId)!.status = change.newStatus;
      break;
    }
  }
}
