import type { Policy } from './types.js';

/** Default guardrails. policy.json overrides these values. Kept in its own file so the browser demo can use it. */
export const DEFAULT_POLICY: Policy = {
  approvals: { approvalTtlMinutes: 60, proposalTtlHours: 24 },
  budgets: { maxIncreasePct: 30, maxDecreasePct: 50, minCampaignDailyBudget: 5, maxCampaignDailyBudget: 250, maxAccountDailyTotal: 400 },
  rateLimits: { maxAppliedPerHour: 10, maxAppliedPerDay: 40, entityCooldownMinutes: 30 },
  negatives: { maxPerProposal: 20, maxConversionsBlockedPct: 20 },
  adCopy: { headlineMaxChars: 30, descriptionMaxChars: 90, minHeadlines: 3, maxHeadlines: 15, minDescriptions: 2, maxDescriptions: 4 },
  status: { allowPause: true, allowEnable: true },
  live: { maxWindowHours: 8 },
};
