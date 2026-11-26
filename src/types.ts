/**
 * Shared domain types for Campaign Ops MCP.
 * Money values are in account currency units (for example 50 means $50.00).
 */

export type Scope = 'read' | 'propose' | 'execute';

export type BackendMode = 'sandbox' | 'google_ads_test' | 'google_ads';

export interface Account {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  mode: BackendMode;
  /**
   * Where performance numbers come from: synthetic (sandbox), simulated
   * (Google Ads test accounts never serve ads) or live (real numbers from Google).
   */
  numbers?: 'synthetic' | 'simulated' | 'live';
}

export type CampaignStatus = 'ENABLED' | 'PAUSED';
export type ChannelType = 'SEARCH' | 'DISPLAY' | 'PERFORMANCE_MAX' | 'VIDEO' | 'DEMAND_GEN' | 'SHOPPING' | 'OTHER';

export interface Campaign {
  id: string;
  accountId: string;
  name: string;
  community: string;
  channel: ChannelType;
  status: CampaignStatus;
  dailyBudget: number;
}

export interface DailyMetric {
  date: string; // YYYY-MM-DD
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  /** Share of impressions lost because the budget ran out (0 to 1). Search only. */
  searchLostIsBudget?: number;
}

export interface SearchTermRow {
  campaignId: string;
  term: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
}

export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';

export interface NegativeKeyword {
  text: string;
  matchType: MatchType;
}

export interface Ad {
  id: string;
  campaignId: string;
  /** Set by backends that know the ad group's ID (Google Ads). */
  adGroupId?: string;
  adGroupName: string;
  status: CampaignStatus;
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
}

/** Every change the system can make. All but the last are open to the AI; remove_negative_keywords exists for rollbacks. */
export type Change =
  | { type: 'set_campaign_budget'; campaignId: string; newDailyBudget: number }
  | { type: 'set_campaign_status'; campaignId: string; newStatus: CampaignStatus }
  | { type: 'add_negative_keywords'; campaignId: string; keywords: NegativeKeyword[] }
  | { type: 'update_ad_text'; adId: string; headlines: string[]; descriptions: string[] }
  | { type: 'set_ad_status'; adId: string; newStatus: CampaignStatus }
  | { type: 'remove_negative_keywords'; campaignId: string; keywords: NegativeKeyword[] };

/**
 * One entry from the platform's own change history (Google Ads keeps 30 days).
 * Used to check Campaign Ops against an independent record.
 */
export interface ChangeEvent {
  /** When the platform recorded it, ISO 8601 in UTC. */
  at: string;
  /** Who made it, as the platform reports it (an email address for people and for the robot). */
  actor: string;
  /** True when it was made with the Campaign Ops credentials. */
  byRobot: boolean;
  /** How it was made, for example "Google Ads API" or "Google Ads web". */
  client: string;
  operation: 'CREATE' | 'UPDATE' | 'REMOVE';
  /** For example CAMPAIGN_BUDGET, CAMPAIGN, CAMPAIGN_CRITERION, AD, AD_GROUP_AD. */
  resourceType: string;
  resourceName: string;
  campaignId?: string;
  adId?: string;
  fields: string[];
  /** Plain-English description, for example "Daily budget $25.00 to $30.00". */
  summary: string;
}

/** An ad Google disapproved or limited, from its own policy review. */
export interface AdPolicyIssue {
  adId: string;
  campaignId: string;
  adGroupName: string;
  /** DISAPPROVED ads do not run; LIMITED ones run in fewer places or to fewer people. */
  approval: 'DISAPPROVED' | 'LIMITED';
  /** Google's policy topics in plain words, for example "Destination not working". */
  topics: string[];
}

export type ChangeType = Change['type'];

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
  delta?: string;
}

export type Risk = 'low' | 'medium' | 'high';

export type ProposalStatus =
  | 'blocked'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'rolled_back'
  | 'verify_failed'
  | 'conflict'
  | 'failed'
  | 'expired';

export type ApprovalChannel = 'console' | 'elicitation';

export interface Approval {
  by: string;
  channel: ApprovalChannel;
  at: string;
  note?: string;
  expiresAt: string;
  bindingHash: string;
  /**
   * Proof that a person approved, when the channel can give one: for a
   * passkey approval, the WebAuthn assertion that signed this exact change.
   * Anyone with the passkey's public key can check it again later.
   */
  evidence?: Record<string, unknown>;
}

export interface Rejection {
  by: string;
  channel: ApprovalChannel;
  at: string;
  note?: string;
}

export interface Verification {
  status: 'passed' | 'failed';
  at: string;
  observed: unknown;
}

export interface FairHousingFinding {
  ruleId: string;
  category: string;
  severity: 'block' | 'warn';
  field: string;
  text: string;
  match: string;
  message: string;
  suggestion: string;
}

export interface FairHousingReport {
  status: 'clean' | 'warn' | 'block';
  findings: FairHousingFinding[];
  disclaimer: string;
}

/**
 * Why a proposal exists, when Autopilot wrote it: which skill found it, what
 * it is worth and the facts behind it. Shown to the person, never signed:
 * the signature covers the change itself.
 */
export interface ProposalInsight {
  /** The Autopilot skill that found it, for example "wasted_searches". */
  skill: string;
  /** Plain-English money effect, for example "About $360 a month saved". */
  impact?: string;
  /** Monthly money effect in account currency. Positive means saved or gained. */
  impactMonthly?: number;
  /** Short facts behind the proposal, shown under Details. */
  evidence?: string[];
  /** Something to weigh before approving. */
  caution?: string;
  /** Set when the AI helped, for example "The AI double-checked each search". */
  ai?: string;
  /**
   * What Autopilot remembers this proposal by, for example "neg:c-102:apartment jobs".
   * A rejected proposal's keys are not proposed again for 30 days.
   */
  keys?: string[];
}

export interface Proposal {
  id: string;
  createdAt: string;
  accountId: string;
  change: Change;
  typeLabel: string;
  targetKey: string;
  targetLabel: string;
  reason: string;
  requestedBy: string;
  summary: string;
  diff: DiffRow[];
  before: unknown;
  after: unknown;
  risk: Risk;
  checks: Check[];
  fairHousing?: FairHousingReport;
  status: ProposalStatus;
  bindingHash: string;
  expiresAt: string;
  rollbackOf?: string;
  rolledBackBy?: string;
  approval?: Approval;
  rejection?: Rejection;
  appliedAt?: string;
  appliedBy?: string;
  verification?: Verification;
  error?: string;
  /** Set when Autopilot wrote the proposal. */
  insight?: ProposalInsight;
}

export interface Policy {
  approvals: { approvalTtlMinutes: number; proposalTtlHours: number };
  budgets: {
    maxIncreasePct: number;
    maxDecreasePct: number;
    minCampaignDailyBudget: number;
    maxCampaignDailyBudget: number;
    maxAccountDailyTotal: number;
  };
  rateLimits: { maxAppliedPerHour: number; maxAppliedPerDay: number; entityCooldownMinutes: number };
  negatives: { maxPerProposal: number; maxConversionsBlockedPct: number };
  adCopy: {
    headlineMaxChars: number;
    descriptionMaxChars: number;
    minHeadlines: number;
    maxHeadlines: number;
    minDescriptions: number;
    maxDescriptions: number;
  };
  status: { allowPause: boolean; allowEnable: boolean };
  /** Live (non-test) accounts: changes stay off until a person opens a change window in the console. */
  live: { maxWindowHours: number };
}

/** An error whose message is safe and useful to show to the AI or the person. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
