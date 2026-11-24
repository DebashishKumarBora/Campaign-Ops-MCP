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
}

export type CampaignStatus = 'ENABLED' | 'PAUSED';
export type ChannelType = 'SEARCH' | 'DISPLAY' | 'PERFORMANCE_MAX';

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
  adGroupName: string;
  status: CampaignStatus;
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
}

/** Every change the system can make. The first four are open to the AI; the last exists for rollbacks. */
export type Change =
  | { type: 'set_campaign_budget'; campaignId: string; newDailyBudget: number }
  | { type: 'set_campaign_status'; campaignId: string; newStatus: CampaignStatus }
  | { type: 'add_negative_keywords'; campaignId: string; keywords: NegativeKeyword[] }
  | { type: 'update_ad_text'; adId: string; headlines: string[]; descriptions: string[] }
  | { type: 'remove_negative_keywords'; campaignId: string; keywords: NegativeKeyword[] };

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
}

/** An error whose message is safe and useful to show to the AI or the person. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
