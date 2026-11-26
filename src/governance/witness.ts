import type { AdsBackend } from '../backends/backend.js';
import type { Change, ChangeEvent, Proposal } from '../types.js';
import type { AuditEntry } from './audit.js';

/**
 * The witness check.
 *
 * Campaign Ops keeps its own tamper-evident log, but a log can only prove what
 * it recorded. Google Ads keeps an independent change history: every change,
 * who made it, with which tool, and when. This compares the two:
 *
 *  - every change Google saw from the Campaign Ops robot should match an
 *    approved, applied proposal (anything else is an alarm: someone used the
 *    key outside the approval flow);
 *  - every applied proposal should appear in Google's record;
 *  - changes by people and other tools are listed, so nobody is surprised by
 *    edits made outside Campaign Ops.
 */

export interface WitnessMatch {
  proposalId: string;
  summary: string;
  appliedAt: string;
  googleAt: string;
  events: number;
}

export interface WitnessReport {
  accountId: string;
  accountName: string;
  available: boolean;
  source: 'google_ads_change_history' | 'sandbox_change_history' | 'none';
  days: number;
  checkedAt: string;
  verdict: 'clean' | 'attention' | 'alarm' | 'unavailable';
  headline: string;
  robot: { total: number; matched: number; setup: number; unexplained: number };
  matches: WitnessMatch[];
  /** Applied proposals Google has no record of. */
  missing: Array<{ proposalId: string; summary: string; appliedAt: string }>;
  /** Applied too recently for Google's record to be expected yet. */
  pending: Array<{ proposalId: string; summary: string; appliedAt: string }>;
  /** Changes made with the robot's credentials that match no approved proposal. */
  unexplained: ChangeEvent[];
  setup: { count: number; from?: string; to?: string };
  /** Changes by people and other tools, newest first (at most 50). */
  outside: ChangeEvent[];
  outsideCount: number;
  note?: string;
}

/** How far apart Campaign Ops' clock and Google's record may be for the same change. */
const MATCH_WINDOW_MS = 10 * 60_000;
/** Google can take a few minutes to record a change. */
const RECORD_LAG_MS = 15 * 60_000;

function compatible(change: Change, e: ChangeEvent): boolean {
  switch (change.type) {
    case 'set_campaign_budget':
      return e.resourceType === 'CAMPAIGN_BUDGET' && e.operation === 'UPDATE' && (!e.campaignId || e.campaignId === change.campaignId);
    case 'set_campaign_status':
      return e.resourceType === 'CAMPAIGN' && e.operation === 'UPDATE' && e.campaignId === change.campaignId;
    case 'add_negative_keywords':
      return e.resourceType === 'CAMPAIGN_CRITERION' && e.operation === 'CREATE' && e.campaignId === change.campaignId;
    case 'remove_negative_keywords':
      return e.resourceType === 'CAMPAIGN_CRITERION' && e.operation === 'REMOVE' && e.campaignId === change.campaignId;
    case 'update_ad_text':
      return (e.resourceType === 'AD' || e.resourceType === 'AD_GROUP_AD') && e.operation === 'UPDATE' && e.adId === change.adId;
    case 'set_ad_status':
      return e.resourceType === 'AD_GROUP_AD' && e.operation === 'UPDATE' && e.adId === change.adId;
  }
}

/** How many change-history entries one applied change produces. */
function expectedEvents(change: Change): number {
  return change.type === 'add_negative_keywords' || change.type === 'remove_negative_keywords' ? change.keywords.length : 1;
}

export interface WitnessInput {
  backend: AdsBackend & { hasChangeHistory?(accountId: string): Promise<boolean> };
  accountId: string;
  days: number;
  proposals: Proposal[];
  /** setup_changes entries from the audit log: robot changes made by npm run gads:setup. */
  setupRuns: AuditEntry[];
  now: number;
}

export async function witnessCheck(input: WitnessInput): Promise<WitnessReport> {
  const { backend, accountId, now } = input;
  const days = Math.max(1, Math.min(28, Math.round(input.days)));
  const account = await backend.getAccount(accountId);
  const base: WitnessReport = {
    accountId,
    accountName: account?.name ?? accountId,
    available: false,
    source: 'none',
    days,
    checkedAt: new Date(now).toISOString(),
    verdict: 'unavailable',
    headline: '',
    robot: { total: 0, matched: 0, setup: 0, unexplained: 0 },
    matches: [],
    missing: [],
    pending: [],
    unexplained: [],
    setup: { count: 0 },
    outside: [],
    outsideCount: 0,
  };
  if (!account) return { ...base, headline: `Unknown account ${accountId}.` };
  const canRead = backend.hasChangeHistory ? await backend.hasChangeHistory(accountId) : Boolean(backend.getChangeHistory);
  if (!canRead || !backend.getChangeHistory) return { ...base, headline: 'This account has no independent change history to check against.' };

  let events: ChangeEvent[];
  try {
    events = await backend.getChangeHistory(accountId, { days });
  } catch (e) {
    return { ...base, headline: `Could not read the change history: ${(e as Error).message}` };
  }

  const source: WitnessReport['source'] = account.mode === 'sandbox' ? 'sandbox_change_history' : 'google_ads_change_history';
  // Proposals applied before the platform's record begins cannot be in it (for example, a rebuilt sandbox).
  const recordStart = backend.changeHistoryStart ? await backend.changeHistoryStart(accountId).catch(() => undefined) : undefined;
  const since = Math.max(now - days * 86_400_000, recordStart ? Date.parse(recordStart) : -Infinity);
  const mine = input.proposals.filter((p) => p.accountId === account.id);
  const applied = mine.filter((p) => p.appliedAt && Date.parse(p.appliedAt) >= since && Date.parse(p.appliedAt) <= now + MATCH_WINDOW_MS);
  const robotEvents = events.filter((e) => e.byRobot);
  const outside = events.filter((e) => !e.byRobot);

  // Give each robot change to the closest compatible applied proposal.
  const counts = new Map<string, { n: number; at: string }>();
  const unmatched: ChangeEvent[] = [];
  for (const e of robotEvents) {
    const t = Date.parse(e.at);
    let best: Proposal | undefined;
    let bestGap = Infinity;
    for (const p of applied) {
      const gap = Math.abs(t - Date.parse(p.appliedAt!));
      if (gap > MATCH_WINDOW_MS || gap >= bestGap || !compatible(p.change, e)) continue;
      const used = counts.get(p.id)?.n ?? 0;
      if (used >= expectedEvents(p.change)) continue;
      best = p;
      bestGap = gap;
    }
    if (best) {
      const c = counts.get(best.id);
      counts.set(best.id, { n: (c?.n ?? 0) + 1, at: c?.at && c.at > e.at ? c.at : e.at });
    } else {
      unmatched.push(e);
    }
  }

  // Robot changes made by the setup script are expected, not suspicious.
  const runs = input.setupRuns
    .filter((r) => r.type === 'setup_changes' && String(r.details.accountId ?? '') === account.id)
    .map((r) => ({ from: Date.parse(String(r.details.from)) - 120_000, to: Date.parse(String(r.details.to)) + 120_000 }));
  const firstProposalAt = mine.length ? Math.min(...mine.map((p) => Date.parse(p.createdAt))) : Infinity;
  const setup: ChangeEvent[] = [];
  const unexplained: ChangeEvent[] = [];
  for (const e of unmatched) {
    const t = Date.parse(e.at);
    const inRun = runs.some((r) => t >= r.from && t <= r.to);
    const beforeAnyProposal = e.operation === 'CREATE' && t < firstProposalAt;
    (inRun || beforeAnyProposal ? setup : unexplained).push(e);
  }

  const matches: WitnessMatch[] = [];
  const missing: WitnessReport['missing'] = [];
  const pending: WitnessReport['pending'] = [];
  for (const p of applied) {
    const c = counts.get(p.id);
    if (c) matches.push({ proposalId: p.id, summary: p.summary, appliedAt: p.appliedAt!, googleAt: c.at, events: c.n });
    else if (now - Date.parse(p.appliedAt!) < RECORD_LAG_MS) pending.push({ proposalId: p.id, summary: p.summary, appliedAt: p.appliedAt! });
    else missing.push({ proposalId: p.id, summary: p.summary, appliedAt: p.appliedAt! });
  }
  matches.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));

  const robot = { total: robotEvents.length, matched: robotEvents.length - unmatched.length, setup: setup.length, unexplained: unexplained.length };
  const verdict: WitnessReport['verdict'] = unexplained.length ? 'alarm' : missing.length ? 'attention' : 'clean';
  const who = source === 'sandbox_change_history' ? "The sandbox's own record" : "Google's own record";
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const outsideLine = outside.length ? ` ${plural(outside.length, 'change was', 'changes were')} made by people or other tools outside Campaign Ops.` : '';

  let headline: string;
  if (verdict === 'alarm') {
    headline = `${plural(unexplained.length, 'change was', 'changes were')} made with the Campaign Ops robot's credentials but match${unexplained.length === 1 ? 'es' : ''} no approved proposal. Check who has access to the robot key.${outsideLine}`;
  } else if (verdict === 'attention') {
    headline = `${who} has no entry yet for ${missing.map((m) => m.proposalId).join(', ')}. Check the account to confirm ${missing.length === 1 ? 'it' : 'they'} landed.${outsideLine}`;
  } else if (applied.length === 0 && robot.matched === 0) {
    headline = `${who} shows no changes by Campaign Ops in the last ${days} days.${outsideLine}`;
  } else {
    headline = `${who} matches: every change made with the robot's credentials in the last ${days} days was approved and applied through Campaign Ops (${plural(matches.length, 'proposal')}).${outsideLine}`;
  }

  return {
    ...base,
    available: true,
    source,
    verdict,
    headline,
    robot,
    matches,
    missing,
    pending,
    unexplained: unexplained.slice(0, 50),
    setup: { count: setup.length, from: setup.length ? setup[setup.length - 1].at : undefined, to: setup.length ? setup[0].at : undefined },
    outside: outside.slice(0, 50),
    outsideCount: outside.length,
    note:
      source === 'google_ads_change_history'
        ? 'Google Ads keeps change history for 30 days and can take a few minutes to record a change.'
        : 'The sandbox keeps a change history the same way Google Ads does, so this check works in the demo too.',
  };
}
