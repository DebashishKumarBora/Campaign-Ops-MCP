import fs from 'node:fs';
import type { AdsBackend, MutateResult } from './backend.js';
import type { Account, Ad, Campaign, Change, DailyMetric, NegativeKeyword, SearchTermRow } from '../types.js';
import { buildSandboxState, type SandboxState } from './seed.js';
import { readJson, writeJsonAtomic } from '../util/fsx.js';
import { normalizeKeyword, round2 } from '../util/format.js';

/**
 * A fake Google Ads account stored in one JSON file. It behaves like the real
 * API where it matters for safety: it validates before writing, supports
 * validate-only dry runs and rejects bad input with readable errors.
 */
export class SandboxBackend implements AdsBackend {
  readonly mode = 'sandbox' as const;

  constructor(private readonly file: string) {}

  /** Creates the sandbox account on first run. */
  ensure(opts: { endDate?: string; now?: Date } = {}): void {
    if (!fs.existsSync(this.file)) writeJsonAtomic(this.file, buildSandboxState(opts));
  }

  reset(opts: { endDate?: string; now?: Date } = {}): void {
    writeJsonAtomic(this.file, buildSandboxState(opts));
  }

  load(): SandboxState {
    this.ensure();
    const state = readJson<SandboxState | null>(this.file, null);
    if (!state || state.version !== 1) throw new Error('The sandbox file is missing or from another version. Run npm run reset.');
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

  async listAccounts(): Promise<Account[]> {
    return [this.load().account];
  }

  async getAccount(accountId: string): Promise<Account | undefined> {
    const state = this.load();
    return state.account.id === accountId ? state.account : undefined;
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

  async mutate(accountId: string, change: Change, opts: { validateOnly: boolean }): Promise<MutateResult> {
    const state = this.load();
    const errors = validate(state, accountId, change);
    if (errors.length > 0 || opts.validateOnly) return { ok: errors.length === 0, errors };
    applyChange(state, change);
    this.save(state);
    return { ok: true, errors: [] };
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
    default: {
      const never: never = change;
      errors.push(`Unsupported change ${(never as { type: string }).type}`);
    }
  }
  return errors;
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
  }
}
