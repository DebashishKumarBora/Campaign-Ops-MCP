import type { Change, ProposalInsight } from '../types.js';

/**
 * Autopilot: Campaign Ops watching an account on its own, around the clock.
 *
 * It finds problems, writes the fix as a normal proposal and tells your
 * phone. Nothing changes until you approve it with your passkey; then the
 * change is applied and verified straight away. Autopilot never approves.
 */

export type SkillId =
  | 'tracking'
  | 'stalled'
  | 'spend_spike'
  | 'lead_drop'
  | 'outside_changes'
  | 'ad_policy'
  | 'landing_pages'
  | 'wasted_searches'
  | 'fair_housing'
  | 'budget_winners'
  | 'zero_leads'
  | 'pacing'
  | 'ad_refresh'
  | 'outcomes';

export interface SkillInfo {
  id: SkillId;
  name: string;
  /** One plain sentence, shown in Settings. */
  does: string;
  /** "watch" skills tell you about something; "fix" skills also write the change. */
  kind: 'watch' | 'fix';
  when: 'hourly' | 'daily';
  /** Uses the free AI when it is available. */
  ai?: boolean;
  /** Needs something only some accounts have, shown under the skill. */
  needs?: string;
}

export interface QuietHours {
  on: boolean;
  /** Hour quiet starts, 0 to 23, in the Autopilot time zone. */
  from: number;
  /** Hour quiet ends. */
  to: number;
  /** Urgent alerts (a broken page, broken tracking, risky ad copy) still come through. */
  urgentAnyway: boolean;
}

export interface AutopilotSettings {
  on: boolean;
  /** Hour of the daily full review, 0 to 23. */
  reviewHour: number;
  /** IANA time zone for the review hour and quiet hours. */
  timezone: string;
  quiet: QuietHours;
  skills: Record<SkillId, boolean>;
  /** Optional monthly spend target per account ID, used by pacing. */
  monthlyTargets: Record<string, number>;
  /**
   * Which accounts Autopilot looks after, by account ID. An account not listed
   * is watched, except the sandbox once a real account is connected (its
   * numbers are the same simulation, so it would only repeat itself).
   */
  accounts: Record<string, boolean>;
  /** At most this many new proposals per review (urgent ones always go through). */
  maxPerRun: number;
  updatedAt?: string;
  updatedBy?: string;
}

export type Level = 'urgent' | 'warn' | 'info' | 'good';

/** One line in Autopilot's activity feed. */
export interface FeedItem {
  id: string;
  at: string;
  kind: 'alert' | 'found' | 'applied' | 'outcome' | 'review' | 'note';
  level: Level;
  skill?: SkillId;
  accountId?: string;
  title: string;
  detail?: string;
  steps?: string[];
  proposalIds?: string[];
}

/** A phone or desktop notification. */
export interface Notice {
  title: string;
  body: string;
  /** Where tapping it goes, for example "/#p=P-0012". */
  url: string;
  tag: string;
  urgent: boolean;
}

/** Work for the free AI, attached to a candidate until it is done. */
export type AiTask =
  | { kind: 'search_terms'; community: string; campaign: string; examples: string[]; terms: Array<{ term: string; cost: number; clicks: number }> }
  | { kind: 'rewrite'; community: string; adId: string; headlines: string[]; descriptions: string[]; flagged: Array<{ field: string; text: string; problem: string }> }
  | { kind: 'more_copy'; community: string; adId: string; headlines: string[]; descriptions: string[]; addHeadlines: number; addDescriptions: number };

/** A change Autopilot wants to propose, before it becomes a proposal. */
export interface Candidate {
  skill: SkillId;
  accountId: string;
  /** The campaign the change touches, for holds and conflicts. */
  campaignId?: string;
  change: Change;
  reason: string;
  insight: ProposalInsight & { skill: SkillId; keys: string[] };
  /** Lower goes first. */
  priority: number;
  /** Goes out even past the per-review limit, and may ring the phone in quiet hours. */
  urgent?: boolean;
  /** Set for an undo: the applied proposal it reverses. */
  rollbackOf?: string;
  ai?: AiTask;
  /** A deterministic answer used when the AI is not available or fails. */
  fallback?: Change;
  /** Set when the AI step decided not to propose it after all. */
  drop?: boolean;
}

export type ReviewStep = 'pulse' | 'scan' | 'ai' | 'propose' | 'finish';

/** A daily review in progress. Kept between steps so each step stays small. */
export interface ReviewWork {
  runId: string;
  accountId: string;
  startedAt: string;
  manual: boolean;
  step: ReviewStep;
  /** Campaign IDs where changes are on hold (broken tracking); "*" holds the whole account. */
  holds: string[];
  candidates: Candidate[];
  proposed: string[];
  /** Proposals already sent to the phone as urgent. */
  notified: string[];
  alerts: number;
  notes: string[];
}

export type Job =
  | { kind: 'watch'; accountId: string }
  | { kind: 'review'; accountId: string; manual?: boolean }
  | { kind: 'apply_approved' }
  | { kind: 'deliver' };

/** What Autopilot remembers about one landing page. */
export interface PageState {
  url: string;
  state: 'up' | 'down' | 'unsure';
  status?: number;
  error?: string;
  failures: number;
  checkedAt: string;
  downSince?: string;
}

export interface OutcomeState {
  at: string;
  verdict: 'better' | 'same' | 'worse' | 'unclear' | 'skipped';
  title: string;
}

export interface AutopilotReport {
  settings: AutopilotSettings;
  skills: SkillInfo[];
  ai: { available: boolean; model?: string; callsToday: number; limit: number };
  status: {
    on: boolean;
    running: string[];
    lastWatch?: string;
    reviewed: Record<string, string>;
    nextReview?: string;
    /** The daily review is due and runs at the next hourly check. */
    reviewDue: boolean;
    quietNow: boolean;
    held: number;
  };
  impact: { monthly: number; applied: number };
  feed: FeedItem[];
  pages: PageState[];
}
