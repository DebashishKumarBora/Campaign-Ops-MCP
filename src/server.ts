import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AdsBackend } from './backends/backend.js';
import type { Engine, ApplyOutcome } from './governance/engine.js';
import { accountOverview, runDiagnostics } from './governance/diagnostics.js';
import { checkPulse } from './governance/pulse.js';
import { lintAd } from './governance/fairHousing.js';
import type { AppConfig } from './config.js';
import type { Change, Proposal, ProposalStatus } from './types.js';
import { UserError } from './types.js';
import { sleep } from './util/fsx.js';

export const SERVER_INSTRUCTIONS = `Campaign Ops lets you analyze a Google Ads account and change it under human control.
How to work:
1. Start with run_diagnostics (or get_account_overview) and explain what you find in plain language with dollar amounts. run_diagnostics also returns Pulse alarms (tracking outages, stalled campaigns, spend spikes); mention any alarm first, because a tracking outage makes every other number misleading.
2. Every change goes through propose_change. You cannot approve changes. A person approves in their app's approval prompt or in the Campaign Ops approval console.
3. Always give a clear reason. The person approving reads it.
4. After proposing, show the person the approve_link from the result so they can approve in one click, then call apply_change. It applies the change only if a person has approved it, then verifies the result.
5. Never say a change is live until apply_change returns status "applied" with verification "passed".
6. If a proposal is blocked, read the failed checks and adjust. Never try to work around Fair Housing or policy blocks, and never re-word a protected-group exclusion to slip past the check.
7. Check each account's mode in list_accounts. "sandbox" means all data is synthetic. "google_ads_test" means a real Google Ads test account: campaigns, budgets, keywords and ads are real and every change goes to Google, but performance numbers are simulated because test accounts never show ads. "google_ads" means a live account with real numbers and real money: it is read-only until a person opens a change window in the approval console, so proposals can be approved but not applied until then. Say which kind of account you are reporting on.
8. For an ad with a Fair Housing problem, the fastest safe step is set_ad_status PAUSED (the stopgap_change in run_diagnostics), then propose compliant copy with update_ad_text.
9. verify_with_google compares Google's own change history with the approval log. Use it when the person asks whether anything changed without approval, or after applying changes.`;

type Json = Record<string, unknown>;

function ok(summary: string, data: Json): CallToolResult {
  return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UserError) return fail(e.message);
    console.error('[campaign-ops] unexpected error:', e);
    return fail(`Unexpected error: ${(e as Error).message}`);
  }
}

// ---------- input conversion (snake_case for the AI, camelCase inside) ----------

const NegativeKeywordInput = z.object({
  text: z.string().min(1).max(80).describe('The search words to exclude, for example "apartment jobs".'),
  match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']).default('PHRASE').describe('EXACT blocks only that search, PHRASE blocks searches containing these words in order, BROAD blocks searches containing all the words.'),
});

const ChangeInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_campaign_budget'),
    campaign_id: z.string().describe('Campaign ID from get_account_overview, for example "c-202".'),
    new_daily_budget: z.number().positive().describe('New average daily budget in account currency, for example 50.'),
  }),
  z.object({
    type: z.literal('set_campaign_status'),
    campaign_id: z.string(),
    new_status: z.enum(['ENABLED', 'PAUSED']),
  }),
  z.object({
    type: z.literal('add_negative_keywords'),
    campaign_id: z.string(),
    keywords: z.array(NegativeKeywordInput).min(1).max(50),
  }),
  z.object({
    type: z.literal('update_ad_text'),
    ad_id: z.string().describe('Ad ID from get_ads, for example "a-3011".'),
    headlines: z.array(z.string()).min(1).max(20).describe('The complete new list of headlines (each at most 30 characters).'),
    descriptions: z.array(z.string()).min(1).max(6).describe('The complete new list of descriptions (each at most 90 characters).'),
  }),
  z.object({
    type: z.literal('set_ad_status'),
    ad_id: z.string().describe('Ad ID from get_ads.'),
    new_status: z.enum(['ENABLED', 'PAUSED']).describe('PAUSED stops one ad; the rest of its ad group keeps running.'),
  }),
]);

type ChangeInputT = z.infer<typeof ChangeInput>;

export function toChange(input: ChangeInputT): Change {
  switch (input.type) {
    case 'set_campaign_budget':
      return { type: 'set_campaign_budget', campaignId: input.campaign_id, newDailyBudget: input.new_daily_budget };
    case 'set_campaign_status':
      return { type: 'set_campaign_status', campaignId: input.campaign_id, newStatus: input.new_status };
    case 'add_negative_keywords':
      return { type: 'add_negative_keywords', campaignId: input.campaign_id, keywords: input.keywords.map((k) => ({ text: k.text, matchType: k.match_type })) };
    case 'update_ad_text':
      return { type: 'update_ad_text', adId: input.ad_id, headlines: input.headlines, descriptions: input.descriptions };
    case 'set_ad_status':
      return { type: 'set_ad_status', adId: input.ad_id, newStatus: input.new_status };
  }
}

export function fromChange(change: Change): Json {
  switch (change.type) {
    case 'set_campaign_budget':
      return { type: change.type, campaign_id: change.campaignId, new_daily_budget: change.newDailyBudget };
    case 'set_campaign_status':
      return { type: change.type, campaign_id: change.campaignId, new_status: change.newStatus };
    case 'add_negative_keywords':
    case 'remove_negative_keywords':
      return { type: change.type, campaign_id: change.campaignId, keywords: change.keywords.map((k) => ({ text: k.text, match_type: k.matchType })) };
    case 'update_ad_text':
      return { type: change.type, ad_id: change.adId, headlines: change.headlines, descriptions: change.descriptions };
    case 'set_ad_status':
      return { type: change.type, ad_id: change.adId, new_status: change.newStatus };
  }
}

// ---------- output shaping ----------

export function nextStep(p: Proposal): string {
  switch (p.status) {
    case 'blocked':
      return 'Blocked by policy. Read the failed checks, adjust the change and propose again. Do not try to work around Fair Housing blocks.';
    case 'pending_approval':
      return `A person must approve ${p.id}. Show them the approve_link (it opens the approval console on this proposal), then call apply_change: if your app supports approval prompts the person can approve there; otherwise call apply_change again once they approve (or pass wait_seconds).`;
    case 'approved':
      return `Approved by a person. Call apply_change with proposal_id "${p.id}".`;
    case 'applied':
      return 'Live and verified. Report the result. If it needs reverting, call request_rollback.';
    case 'rolled_back':
      return `Reverted by ${p.rolledBackBy}.`;
    case 'rejected':
      return 'A person rejected this. Do not propose the same change again unless they ask.';
    case 'conflict':
      return 'The live value changed after the proposal. Read the account again and propose a fresh change.';
    case 'expired':
      return 'Expired without being applied. Propose again if it still makes sense.';
    case 'verify_failed':
      return 'The account does not show the expected result. Tell the person and suggest a rollback or a manual check.';
    case 'failed':
      return 'The change failed. Tell the person what happened.';
  }
}

/** A link that opens the approval console on one proposal. It carries no secret: the console asks for its key. */
export function approveLink(p: Proposal, consoleUrl?: string): string | undefined {
  if (!consoleUrl || p.status !== 'pending_approval') return undefined;
  return `${consoleUrl.replace(/\/?$/, '/')}#p=${p.id}`;
}

export function proposalView(p: Proposal, consoleUrl?: string): Json {
  return {
    id: p.id,
    status: p.status,
    approve_link: approveLink(p, consoleUrl),
    type: p.typeLabel,
    target: p.targetLabel,
    summary: p.summary,
    risk: p.risk,
    reason: p.reason,
    requested_by: p.requestedBy,
    created_at: p.createdAt,
    expires_at: p.status === 'pending_approval' ? p.expiresAt : undefined,
    diff: p.diff,
    checks: p.checks.map((c) => ({ check: c.label, result: c.status, detail: c.detail })),
    fair_housing: p.fairHousing && p.fairHousing.status !== 'clean' ? { status: p.fairHousing.status, findings: p.fairHousing.findings.map((f) => ({ field: f.field, phrase: f.match, severity: f.severity, why: f.message, fix: f.suggestion })) } : undefined,
    rollback_of: p.rollbackOf,
    rolled_back_by: p.rolledBackBy,
    approval: p.approval ? { by: p.approval.by, channel: p.approval.channel, at: p.approval.at, note: p.approval.note } : undefined,
    rejection: p.rejection ? { by: p.rejection.by, channel: p.rejection.channel, at: p.rejection.at, note: p.rejection.note } : undefined,
    applied_at: p.appliedAt,
    verification: p.verification?.status,
    error: p.error,
    next_step: nextStep(p),
  };
}

function approvalPrompt(p: Proposal): string {
  const passed = p.checks.filter((c) => c.status === 'pass').length;
  const warns = p.checks.filter((c) => c.status === 'warn');
  const lines = [
    `Approve change ${p.id}?`,
    '',
    p.summary,
    '',
    ...p.diff.slice(0, 6).map((d) => `${d.field}: ${d.before} → ${d.after}${d.delta ? ` (${d.delta})` : ''}`),
    '',
    `Why: ${p.reason}`,
    `Risk: ${p.risk}. Checks: ${passed} passed${warns.length ? `, ${warns.length} warning${warns.length === 1 ? '' : 's'}: ${warns.map((w) => w.detail ?? w.label).join(' ')}` : ', no warnings'}.`,
  ];
  return lines.join('\n');
}

// ---------- server ----------

export interface ServerDeps {
  engine: Engine;
  backend: AdsBackend;
  config: AppConfig;
  version: string;
  consoleUrl?: () => string | undefined;
}

export function createMcpServer(deps: ServerDeps): McpServer {
  const { engine, backend, config } = deps;
  const mcp = new McpServer({ name: 'campaign-ops-mcp', title: 'Campaign Ops MCP', version: deps.version }, { instructions: SERVER_INSTRUCTIONS });

  const agentLabel = () => {
    const client = mcp.server.getClientVersion();
    return client?.name ? `agent via ${client.name}` : 'agent';
  };

  const days = z.union([z.literal(7), z.literal(14), z.literal(30)]).default(30).describe('Lookback window in days: 7, 14 or 30.');
  const accountId = z.string().describe('Account ID from list_accounts, for example "123-456-7890".');
  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  mcp.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        'Lists the ad accounts this server can reach, with their mode: sandbox (synthetic data), google_ads_test (a real Google Ads test account with simulated performance numbers) or google_ads (a live account with real numbers, read-only until a person opens a change window). For live accounts it also says whether changes are currently allowed.',
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guard(async () => {
        const accounts = await backend.listAccounts();
        const rows = [];
        for (const a of accounts) {
          const access = await engine.liveAccess(a.id);
          rows.push({
            ...a,
            changes: access.required ? (access.open ? `allowed until ${access.until} (change window opened by ${access.openedBy})` : 'off: read-only until a person opens a change window in the approval console') : 'allowed with approval',
          });
        }
        return ok(`${rows.length} account${rows.length === 1 ? '' : 's'} available.`, { accounts: rows });
      }),
  );

  mcp.registerTool(
    'get_account_overview',
    {
      title: 'Account overview',
      description: 'Campaign-level performance for a period: spend, clicks, conversions (leads), cost per lead, daily budget, budget utilization and impression share lost to budget.',
      inputSchema: { account_id: accountId, days },
      annotations: READ,
    },
    ({ account_id, days: d }) =>
      guard(async () => {
        const overview = await accountOverview(backend, account_id, d);
        return ok(`Overview for ${overview.account.name}, last ${d} days.`, overview as unknown as Json);
      }),
  );

  mcp.registerTool(
    'get_search_terms',
    {
      title: 'Search terms',
      description: 'What people actually searched before clicking, with cost and conversions. Use it to find wasted spend.',
      inputSchema: {
        account_id: accountId,
        campaign_id: z.string().optional().describe('Limit to one campaign.'),
        min_cost: z.number().min(0).default(0).describe('Only return terms that cost at least this much.'),
        days,
      },
      annotations: READ,
    },
    ({ account_id, campaign_id, min_cost, days: d }) =>
      guard(async () => {
        const terms = (await backend.getSearchTerms(account_id, { campaignId: campaign_id, days: d })).filter((t) => t.cost >= min_cost).sort((a, b) => b.cost - a.cost);
        return ok(`${terms.length} search terms.`, { days: d, terms });
      }),
  );

  mcp.registerTool(
    'get_ads',
    {
      title: 'Ads',
      description: 'Lists ads with their headlines and descriptions, plus a Fair Housing screening result for each.',
      inputSchema: { account_id: accountId, campaign_id: z.string().optional().describe('Limit to one campaign.') },
      annotations: READ,
    },
    ({ account_id, campaign_id }) =>
      guard(async () => {
        const ads = await backend.listAds(account_id, campaign_id);
        const rows = ads.map((a) => {
          const fh = lintAd(a.headlines, a.descriptions);
          return { ...a, fair_housing: { status: fh.status, findings: fh.findings.map((f) => ({ field: f.field, phrase: f.match, severity: f.severity, why: f.message, fix: f.suggestion })) } };
        });
        return ok(`${rows.length} ads.`, { ads: rows });
      }),
  );

  mcp.registerTool(
    'run_diagnostics',
    {
      title: 'Run diagnostics',
      description: 'Finds the most valuable issues in an account: Fair Housing risks in ad copy, wasted spend on irrelevant searches, campaigns spending without leads, and strong campaigns limited by budget. Each finding includes a suggested change you can pass to propose_change. Also lists zero-conversion searches that must not be excluded because they relate to protected groups.',
      inputSchema: { account_id: accountId, days },
      annotations: READ,
    },
    ({ account_id, days: d }) =>
      guard(async () => {
        const report = await runDiagnostics(backend, engine.policy, account_id, d);
        const findings = report.findings.map((f) => ({
          id: f.id,
          kind: f.kind,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          estimated_monthly_impact: f.estimatedMonthlyImpact,
          suggested_change: f.suggestedChange ? fromChange(f.suggestedChange) : undefined,
          suggested_reason: f.suggestedReason,
          needs_copywriting: f.needsCopywriting
            ? { ad_id: f.needsCopywriting.adId, current_headlines: f.needsCopywriting.currentHeadlines, current_descriptions: f.needsCopywriting.currentDescriptions, flagged: f.needsCopywriting.flagged }
            : undefined,
          stopgap_change: f.stopgapChange ? fromChange(f.stopgapChange) : undefined,
          stopgap_reason: f.stopgapReason,
        }));
        let pulse: Json | undefined;
        try {
          const pr = await checkPulse(backend, account_id, { days: 28 });
          pulse = { headline: pr.headline, alarms: pr.alarms.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, title: a.title, detail: a.detail, next_steps: a.nextSteps })) };
        } catch (e) {
          pulse = { headline: `Pulse could not run: ${(e as Error).message}`, alarms: [] };
        }
        const alarmCount = Array.isArray(pulse.alarms) ? pulse.alarms.length : 0;
        return ok(`${findings.length} findings for ${report.overview.account.name}${alarmCount ? `, plus ${alarmCount} Pulse alarm${alarmCount === 1 ? '' : 's'}` : ''}.`, {
          account: report.overview.account,
          period: report.overview.period,
          totals: report.overview.totals,
          pulse_alarms: pulse,
          findings,
          protected_terms_not_negated: report.protectedTermsNotNegated,
          notes: report.notes,
        });
      }),
  );

  mcp.registerTool(
    'check_ad_copy',
    {
      title: 'Check ad copy',
      description: 'Screens draft ad copy before you propose it: Fair Housing risk patterns, Google Ads character limits and headline punctuation. Changes nothing.',
      inputSchema: {
        headlines: z.array(z.string()).min(1).max(20),
        descriptions: z.array(z.string()).max(6).default([]),
      },
      annotations: READ,
    },
    ({ headlines, descriptions }) =>
      guard(async () => {
        const fh = lintAd(headlines, descriptions);
        const A = engine.policy.adCopy;
        const lengthIssues = [
          ...headlines.map((h, i) => ({ field: `Headline ${i + 1}`, length: h.length, max: A.headlineMaxChars })),
          ...descriptions.map((d, i) => ({ field: `Description ${i + 1}`, length: d.length, max: A.descriptionMaxChars })),
        ].filter((x) => x.length > x.max);
        const punctuation = headlines.filter((h) => h.includes('!')).map((h) => `Exclamation mark in headline: "${h}"`);
        const verdict = fh.status === 'block' || lengthIssues.length || punctuation.length ? 'fix_required' : fh.status === 'warn' ? 'review_recommended' : 'looks_good';
        return ok(`Verdict: ${verdict.replace(/_/g, ' ')}.`, {
          verdict,
          fair_housing: { status: fh.status, findings: fh.findings.map((f) => ({ field: f.field, phrase: f.match, severity: f.severity, why: f.message, fix: f.suggestion })), disclaimer: fh.disclaimer },
          length_issues: lengthIssues,
          punctuation_issues: punctuation,
        });
      }),
  );

  mcp.registerTool(
    'get_policy',
    {
      title: 'Policy and controls',
      description: 'Shows the guardrails in force: scope, budget caps, rate limits, approval rules and whether the kill switch is on. The AI can read these but never change them.',
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guard(async () => {
        const kill = engine.killSwitchState();
        const accounts = await backend.listAccounts();
        const live = [];
        for (const a of accounts) {
          const access = await engine.liveAccess(a.id);
          live.push({ id: a.id, name: a.name, mode: a.mode, numbers: a.numbers, change_window: access.required ? (access.open ? { open: true, until: access.until, opened_by: access.openedBy } : { open: false }) : 'not needed' });
        }
        return ok('Current guardrails.', {
          mode: backend.mode,
          accounts: live,
          live_accounts: `Live accounts are read-only until a person opens a change window (1 to ${engine.policy.live.maxWindowHours} hours) in the approval console by typing the account name. Every change still needs its own approval.`,
          scope: engine.scope,
          kill_switch: kill.on,
          kill_switch_forced_by_environment: kill.forcedByEnv,
          approvals: { required: true, approval_channels: ['approval prompt in your app (MCP elicitation)', 'Campaign Ops approval console'], ...engine.policy.approvals },
          policy: engine.policy,
          policy_source: config.policySource,
          fair_housing: 'Ad copy with violation-risk phrases and negative keywords that exclude protected groups are always blocked. This cannot be turned off in config.',
        });
      }),
  );

  const statusEnum = z.enum(['blocked', 'pending_approval', 'approved', 'rejected', 'applied', 'rolled_back', 'verify_failed', 'conflict', 'failed', 'expired']);

  mcp.registerTool(
    'list_proposals',
    {
      title: 'List proposals',
      description: 'Lists recent change proposals and their status, newest first.',
      inputSchema: { status: statusEnum.optional().describe('Only this status.'), limit: z.number().int().min(1).max(50).default(10) },
      annotations: READ,
    },
    ({ status, limit }) =>
      guard(async () => {
        const list = await engine.listProposals({ status: status as ProposalStatus | undefined, limit });
        return ok(`${list.length} proposals.`, { proposals: list.map((p) => proposalView(p, deps.consoleUrl?.())) });
      }),
  );

  mcp.registerTool(
    'get_proposal',
    { title: 'Get proposal', description: 'Full detail for one proposal, including every check and the next step.', inputSchema: { proposal_id: z.string().describe('For example "P-0003".') }, annotations: READ },
    ({ proposal_id }) =>
      guard(async () => {
        const p = await engine.getProposal(proposal_id.trim().toUpperCase());
        if (!p) return fail(`No proposal ${proposal_id}. Call list_proposals to see IDs.`);
        return ok(`${p.id}: ${p.status.replace(/_/g, ' ')}.`, proposalView(p, deps.consoleUrl?.()));
      }),
  );

  mcp.registerTool(
    'get_audit_log',
    {
      title: 'Audit log',
      description: 'Recent entries from the tamper-evident audit log, and whether the hash chain is intact.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(20), proposal_id: z.string().optional() },
      annotations: READ,
    },
    ({ limit, proposal_id }) =>
      guard(async () => {
        const chain = engine.audit.verify();
        const entries = engine.audit.recent(limit, proposal_id?.trim().toUpperCase()).map((e) => ({ seq: e.seq, at: e.ts, type: e.type, actor: e.actor, proposal: e.proposalId, details: e.details, hash: e.hash.slice(0, 12) }));
        return ok(chain.ok ? `Audit chain intact (${chain.count} entries).` : `Audit chain BROKEN: ${chain.problem}`, { chain, entries });
      }),
  );

  mcp.registerTool(
    'check_pulse',
    {
      title: 'Pulse alarms',
      description:
        'Day-by-day alarms a monthly report misses: conversion tracking that stopped recording leads while clicks kept coming, enabled campaigns that stopped spending, overnight spend spikes and sudden lead drops. Each alarm says how unlikely the pattern is by chance and what to check. Changes nothing.',
      inputSchema: { account_id: accountId, days: z.number().int().min(14).max(60).default(28).describe('How many days of history to read (14 to 60).') },
      annotations: READ,
    },
    ({ account_id, days: d }) =>
      guard(async () => {
        const report = await checkPulse(backend, account_id, { days: d });
        return ok(report.headline, report as unknown as Json);
      }),
  );

  mcp.registerTool(
    'verify_with_google',
    {
      title: "Check Google's own record",
      description:
        "Compares the platform's independent change history (Google Ads keeps 30 days) with the Campaign Ops approval log. Confirms every change made with the Campaign Ops credentials was approved and applied through Campaign Ops, flags any that were not, and lists edits made by people or other tools outside Campaign Ops. Changes nothing.",
      inputSchema: { account_id: accountId, days: z.number().int().min(1).max(28).default(14).describe('How many days back to check (1 to 28).') },
      annotations: READ,
    },
    ({ account_id, days: d }) =>
      guard(async () => {
        const w = await engine.witness(account_id, d);
        return ok(w.headline, {
          verdict: w.verdict,
          source: w.source,
          days: w.days,
          robot_changes: w.robot,
          matched_proposals: w.matches.map((m) => ({ proposal: m.proposalId, summary: m.summary, applied_at: m.appliedAt, recorded_by_google_at: m.googleAt, entries: m.events })),
          missing_from_google: w.missing,
          too_recent_to_check: w.pending,
          unexplained_robot_changes: w.unexplained.map((e) => ({ at: e.at, what: e.summary, tool: e.client })),
          setup_changes: w.setup,
          outside_changes: w.outside.map((e) => ({ at: e.at, who: e.actor, tool: e.client, what: e.summary })),
          outside_change_count: w.outsideCount,
          note: w.note,
        });
      }),
  );

  if (config.scope !== 'read') {
    mcp.registerTool(
      'propose_change',
      {
        title: 'Propose a change',
        description:
          'The only way to request a change. Runs policy checks (budget caps, step limits, Fair Housing, brand protection, collateral damage), a validate-only dry run, and records the proposal for human approval. Returns status "pending_approval" or "blocked" with the failed checks. Nothing changes in the account until a person approves and apply_change runs.',
        inputSchema: {
          account_id: accountId,
          change: ChangeInput.describe('Exactly one change. Use suggested_change from run_diagnostics when it fits.'),
          reason: z.string().min(10).max(600).describe('One or two plain sentences explaining why, with numbers. The person approving reads this.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      ({ account_id, change, reason }) =>
        guard(async () => {
          const p = await engine.propose({ accountId: account_id, change: toChange(change), reason, requestedBy: agentLabel() });
          const failed = p.checks.filter((c) => c.status === 'fail');
          const link = approveLink(p, deps.consoleUrl?.());
          const head =
            p.status === 'blocked'
              ? `${p.id} BLOCKED: ${failed.map((c) => c.detail ?? c.label).join(' ')}`
              : `${p.id} is waiting for human approval: ${p.summary}${link ? ` Approve or reject it here: ${link}` : ''}`;
          return ok(head, proposalView(p, deps.consoleUrl?.()));
        }),
    );

    mcp.registerTool(
      'request_rollback',
      {
        title: 'Request a rollback',
        description: 'Creates an undo proposal that restores the state before an applied change. The undo is checked and needs human approval like any other change; then call apply_change on the new proposal.',
        inputSchema: { proposal_id: z.string().describe('The applied proposal to undo, for example "P-0003".'), reason: z.string().min(10).max(600) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      ({ proposal_id, reason }) =>
        guard(async () => {
          const p = await engine.requestRollback(proposal_id.trim().toUpperCase(), { reason, requestedBy: agentLabel() });
          const failed = p.checks.filter((c) => c.status === 'fail');
          const link = approveLink(p, deps.consoleUrl?.());
          const head = p.status === 'blocked' ? `Undo ${p.id} BLOCKED: ${failed.map((c) => c.detail ?? c.label).join(' ')}` : `Undo ${p.id} is waiting for human approval.${link ? ` Approve or reject it here: ${link}` : ''}`;
          return ok(head, proposalView(p, deps.consoleUrl?.()));
        }),
    );
  }

  if (config.scope === 'execute') {
    mcp.registerTool(
      'apply_change',
      {
        title: 'Apply an approved change',
        description:
          'Applies a proposal only if a person approved it. If it is still pending and your app supports approval prompts, the person is asked right there. Otherwise it returns "awaiting_approval"; pass wait_seconds (up to 110) to wait while they approve in the console. Before writing it re-checks policy, the kill switch, rate limits and cooldowns, and refuses if the live value changed since the proposal (conflict). After writing it reads the account back to verify.',
        inputSchema: {
          proposal_id: z.string().describe('For example "P-0003".'),
          wait_seconds: z.number().int().min(0).max(110).default(0).describe('How long to wait for a console approval before returning. 0 returns immediately.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      ({ proposal_id, wait_seconds }, extra) =>
        guard(async () => {
          const id = proposal_id.trim().toUpperCase();
          let p = await engine.getProposal(id);
          if (!p) return fail(`No proposal ${proposal_id}. Call list_proposals to see IDs.`);

          if (p.status === 'pending_approval') {
            const caps = mcp.server.getClientCapabilities();
            if (caps?.elicitation?.form) {
              try {
                const res = await mcp.server.elicitInput(
                  {
                    mode: 'form',
                    message: approvalPrompt(p),
                    requestedSchema: {
                      type: 'object',
                      properties: {
                        decision: { type: 'string', title: 'Decision', enum: ['Approve', 'Reject'] },
                        note: { type: 'string', title: 'Note (optional)', maxLength: 300 },
                      },
                      required: ['decision'],
                    },
                  },
                  { timeout: 10 * 60_000, signal: extra.signal },
                );
                if (res.action === 'accept' && res.content?.decision === 'Approve') {
                  p = await engine.approve(id, { by: 'person (approval prompt)', channel: 'elicitation', note: typeof res.content.note === 'string' ? res.content.note : undefined });
                } else if (res.action === 'accept' || res.action === 'decline') {
                  p = await engine.reject(id, { by: 'person (approval prompt)', channel: 'elicitation', note: typeof res.content?.note === 'string' ? res.content.note : undefined });
                  return ok(`${id} was rejected by the person.`, { status: 'rejected', proposal: proposalView(p) });
                }
              } catch (e) {
                if (e instanceof UserError) throw e;
                console.error('[campaign-ops] approval prompt failed, falling back to the console:', (e as Error).message);
              }
            }
          }

          p = (await engine.getProposal(id))!;
          if (p.status === 'pending_approval' && wait_seconds > 0) {
            const deadline = Date.now() + wait_seconds * 1000;
            const progressToken = extra._meta?.progressToken;
            let tick = 0;
            while (Date.now() < deadline && !extra.signal.aborted) {
              await sleep(1000);
              tick++;
              p = (await engine.getProposal(id))!;
              if (p.status !== 'pending_approval') break;
              if (progressToken !== undefined) {
                await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: tick, total: wait_seconds, message: `Waiting for approval of ${id} in the console` } }).catch(() => undefined);
              }
            }
          }

          if (p.status === 'pending_approval') {
            const link = approveLink(p, deps.consoleUrl?.());
            const where = link ? ` here: ${link}` : ' in the approval console (run "npm run console" on the computer running Campaign Ops)';
            return ok(`${id} is waiting for human approval.${link ? ` Approve it here: ${link}` : ''}`, {
              status: 'awaiting_approval',
              approve_link: link,
              next_step: `Ask the person to approve ${id}${where}. Then call apply_change again, or call it with wait_seconds to wait.`,
              proposal: proposalView(p, deps.consoleUrl?.()),
            });
          }
          if (p.status === 'rejected') return ok(`${id} was rejected by a person.`, { status: 'rejected', proposal: proposalView(p) });

          const outcome: ApplyOutcome = await engine.apply(id, { actor: agentLabel() });
          const view = outcome.proposal ? proposalView(outcome.proposal) : undefined;
          return ok(outcome.message, { status: outcome.status, verification: outcome.proposal?.verification?.status, proposal: view });
        }),
    );
  }

  mcp.registerPrompt(
    'account_health_check',
    {
      title: 'Account health check',
      description: 'Find the biggest problems in an account and propose fixes for approval.',
      argsSchema: { account_id: z.string().optional().describe('Leave empty to use the first account.') },
    },
    ({ account_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Run a health check on ${account_id ? `account ${account_id}` : 'my ad account (use the first one from list_accounts)'}.
1. Call run_diagnostics and summarize the top issues in plain English with dollar amounts.
2. Mention any searches the tool says must not be excluded, and why.
3. Propose at most three changes with clear reasons, starting with compliance risks.
4. For ad copy problems, write compliant replacement copy, check it with check_ad_copy, then propose it.
5. After proposing, tell me what to approve and call apply_change for each one.`,
          },
        },
      ],
    }),
  );

  mcp.registerPrompt(
    'fix_wasted_spend',
    {
      title: 'Fix wasted spend',
      description: 'Find irrelevant searches that waste money and propose negative keywords.',
      argsSchema: { account_id: z.string().optional() },
    },
    ({ account_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Find wasted spend in ${account_id ? `account ${account_id}` : 'my ad account'}: call run_diagnostics, show me the irrelevant searches with their cost, propose negative keywords for them with a clear reason, and call apply_change once I approve. Never exclude searches the tool marks as protected.`,
          },
        },
      ],
    }),
  );

  return mcp;
}
