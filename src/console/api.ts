import type { Engine } from '../governance/engine.js';
import type { AdsBackend } from '../backends/backend.js';
import { UserError } from '../types.js';
import { checkPulse } from '../governance/pulse.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import type { Job } from '../autopilot/types.js';
import { watches } from '../autopilot/settings.js';

/**
 * The approval console's API, without any web server attached.
 *
 * The local console (src/console/server.ts) and the cloud version
 * (cloud/src/ops.ts) both put their own security in front of it: the local one
 * checks the console key, the Host header and the request origin; the cloud one
 * checks the signed-in session and asks for a passkey signature before any
 * action that can change an account.
 */

export type ConsoleActionKind =
  | 'state'
  | 'insights'
  | 'approve'
  | 'reject'
  | 'undo'
  | 'pause_all'
  | 'resume_all'
  | 'open_window'
  | 'close_window'
  | 'unknown';

export interface ConsoleAction {
  kind: ConsoleActionKind;
  /** Proposal ID or account ID the action is about. */
  target?: string;
  /** True when a person must prove it is them (in the cloud: a passkey signature). */
  powerful: boolean;
}

/** Works out what a request is asking for, so the caller can demand the right proof first. */
export function classifyConsoleRequest(method: string, pathname: string, body: Record<string, unknown> = {}): ConsoleAction {
  if (method === 'GET' && pathname === '/api/state') return { kind: 'state', powerful: false };
  if (method === 'GET' && pathname === '/api/insights') return { kind: 'insights', powerful: false };
  if (method !== 'POST') return { kind: 'unknown', powerful: false };
  const p = /^\/api\/proposals\/(P-\d{4,})\/(approve|reject|undo)$/.exec(pathname);
  if (p) {
    const kind = p[2] as 'approve' | 'reject' | 'undo';
    return { kind, target: p[1], powerful: kind !== 'reject' };
  }
  if (pathname === '/api/kill-switch') {
    return body.on === false ? { kind: 'resume_all', target: 'all', powerful: true } : { kind: 'pause_all', target: 'all', powerful: false };
  }
  const w = /^\/api\/accounts\/([A-Za-z0-9-]{3,40})\/window(\/close)?$/.exec(pathname);
  if (w) return w[2] ? { kind: 'close_window', target: w[1], powerful: false } : { kind: 'open_window', target: w[1], powerful: true };
  return { kind: 'unknown', powerful: false };
}

export interface ConsoleApiOptions {
  engine: Engine;
  backend: AdsBackend;
  version: string;
  /** Extra fields merged into /api/state (the cloud adds sign-in and notification details). */
  extraState?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  clock?: () => number;
  /**
   * Approving in the console also applies and verifies the change straight
   * away. On unless set to false.
   */
  applyOnApprove?: boolean;
  /** Autopilot, when this console runs it. */
  autopilot?: Autopilot;
  /** Runs Autopilot jobs for "Check now": the cloud queues them, a computer runs them straight away. */
  runAutopilot?: (jobs: Job[]) => Promise<void>;
}

export interface ConsoleRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Who is acting, as written to the audit log. */
  who: string;
  /** Proof attached to an approval (a verified passkey signature), stored with the approval. */
  approval?: { evidence?: Record<string, unknown>; bindingHash?: string };
}

export interface ConsoleResult {
  status: number;
  body: Record<string, unknown>;
}

/** How long Pulse and witness results are reused. Both read the ad platform, which has daily limits. */
const INSIGHT_TTL_MS = 5 * 60_000;
/** "Check again" is ignored for results younger than this, so repeated clicks cannot burn through the daily limit. */
const INSIGHT_MIN_REFRESH_MS = 20_000;

export class ConsoleApi {
  private readonly insights = new Map<string, { at: number; sig: string; data: Record<string, unknown> }>();

  constructor(private readonly opts: ConsoleApiOptions) {}

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /** Changes whenever a change is applied, so cached results never hide a fresh change. */
  private appliedSignature(accountId: string): string {
    const applied = this.opts.engine.store.list().filter((p) => p.accountId === accountId && p.appliedAt);
    return `${applied.length}:${applied.map((p) => p.appliedAt).sort().pop() ?? ''}`;
  }

  async insightsFor(accountId: string, refresh: boolean): Promise<Record<string, unknown>> {
    const { engine, backend } = this.opts;
    const account = await backend.getAccount(accountId);
    if (!account) throw new UserError(`Unknown account ${accountId}.`);
    const now = this.now();
    const sig = this.appliedSignature(account.id);
    const hit = this.insights.get(account.id);
    if (hit && hit.sig === sig && now - hit.at < (refresh ? INSIGHT_MIN_REFRESH_MS : INSIGHT_TTL_MS)) return { ...hit.data, cached: true };
    const [pulse, witness] = await Promise.all([
      checkPulse(backend, account.id, { days: 28 }).catch((e: Error) => ({ error: e.message })),
      engine.witness(account.id, 14).catch((e: Error) => ({ error: e.message })),
    ]);
    const data = { accountId: account.id, checkedAt: new Date(now).toISOString(), pulse, witness };
    this.insights.set(account.id, { at: now, sig, data });
    return { ...data, cached: false };
  }

  async state(): Promise<Record<string, unknown>> {
    const { engine, backend } = this.opts;
    const listed = await backend.listAccounts();
    const accounts = [];
    for (const a of listed) accounts.push({ ...a, access: await engine.liveAccess(a.id) });
    const proposals = await engine.listProposals({ limit: 80 });
    const chain = engine.audit.verify();
    const recent = engine.audit.recent(14);
    const since = engine.now() - 86_400_000;
    const all = engine.store.list();
    return {
      app: { name: 'Campaign Ops', version: this.opts.version },
      applyOnApprove: this.opts.applyOnApprove !== false,
      autopilot: await this.autopilotSummary(),
      mode: backend.mode,
      account: accounts[0] ?? null,
      accounts,
      scope: engine.scope,
      killSwitch: engine.killSwitchState(),
      policy: engine.policy,
      counts: {
        pending: all.filter((p) => p.status === 'pending_approval').length,
        appliedToday: all.filter((p) => p.appliedAt && Date.parse(p.appliedAt) >= since).length,
        blocked: all.filter((p) => p.status === 'blocked').length,
      },
      proposals,
      audit: { ok: chain.ok, count: chain.count, problem: chain.problem, recent },
      serverTime: new Date(engine.now()).toISOString(),
      ...(this.opts.extraState ? await this.opts.extraState() : {}),
    };
  }

  /** The few Autopilot facts the home screen shows, kept small because the page asks every few seconds. */
  private async autopilotSummary(): Promise<Record<string, unknown> | null> {
    const ap = this.opts.autopilot;
    if (!ap) return null;
    const r = await ap.report();
    return { on: r.status.on, running: r.status.running, lastWatch: r.status.lastWatch, nextReview: r.status.nextReview, reviewDue: r.status.reviewDue, quietNow: r.status.quietNow, held: r.status.held, impact: r.impact, ai: r.ai.available, latest: r.feed.slice(0, 12) };
  }

  /** Everything Autopilot knows, for its own screens. */
  private async autopilotReport(): Promise<Record<string, unknown>> {
    const ap = this.opts.autopilot!;
    const report = await ap.report();
    const all = await this.opts.backend.listAccounts();
    return { ...report, accounts: all.map((a) => ({ id: a.id, name: a.name, mode: a.mode, numbers: a.numbers, watched: watches(report.settings, a, all), target: report.settings.monthlyTargets[a.id] ?? null })) };
  }

  /** Answers one API request. Throws UserError for a person's mistake; the caller turns it into a 400. */
  async handle(req: ConsoleRequest): Promise<ConsoleResult | undefined> {
    const { engine } = this.opts;
    const { method, pathname, body, who } = req;

    if (method === 'GET' && pathname === '/api/insights') {
      const id = req.query.get('account') ?? '';
      if (!/^[A-Za-z0-9-]{3,40}$/.test(id)) return { status: 400, body: { error: 'Pass ?account= with an account ID.' } };
      return { status: 200, body: await this.insightsFor(id, req.query.get('refresh') === '1') };
    }
    if (method === 'GET' && pathname === '/api/state') return { status: 200, body: await this.state() };
    if (pathname.startsWith('/api/autopilot')) {
      const ap = this.opts.autopilot;
      if (!ap) return { status: 404, body: { error: 'Autopilot is not running here.' } };
      if (method === 'GET' && pathname === '/api/autopilot') return { status: 200, body: await this.autopilotReport() };
      if (method === 'POST' && pathname === '/api/autopilot/settings') {
        await ap.updateSettings(body.settings, who);
        return { status: 200, body: { ok: true, ...(await this.autopilotReport()) } };
      }
      if (method === 'POST' && pathname === '/api/autopilot/check') {
        const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined;
        const jobs = await ap.checkNow(accountId);
        if (this.opts.runAutopilot) await this.opts.runAutopilot(jobs);
        else await ap.runAll(jobs);
        return { status: 200, body: { ok: true, ...(await this.autopilotReport()) } };
      }
      return undefined;
    }
    if (method !== 'POST') return undefined;

    const note = typeof body.note === 'string' ? body.note : undefined;
    const match = /^\/api\/proposals\/(P-\d{4,})\/(approve|reject|undo)$/.exec(pathname);
    if (match) {
      const [, id, action] = match;
      if (action === 'approve') {
        const proposal = await engine.approve(id, { by: who, channel: 'console', note, evidence: req.approval?.evidence, bindingHash: req.approval?.bindingHash });
        if (this.opts.applyOnApprove === false) return { status: 200, body: { ok: true, proposal } };
        const outcome = await engine.apply(id, { actor: who, human: true, signedLive: Boolean(req.approval?.evidence) });
        return {
          status: 200,
          body: { ok: true, proposal: outcome.proposal ?? proposal, applied: outcome.status === 'applied', outcome: { status: outcome.status, message: outcome.message } },
        };
      }
      if (action === 'reject') return { status: 200, body: { ok: true, proposal: await engine.reject(id, { by: who, channel: 'console', note }) } };
      const result = await engine.undoNow(id, who, req.approval?.evidence);
      const blocked = result.rollback.status === 'blocked';
      const applied = result.outcome?.status === 'applied';
      return {
        status: 200,
        body: {
          ok: applied,
          rollback: result.rollback,
          outcome: result.outcome ? { status: result.outcome.status, message: result.outcome.message } : undefined,
          message: blocked
            ? `Undo blocked: ${result.rollback.checks.filter((c) => c.status === 'fail').map((c) => c.detail ?? c.label).join(' ')}`
            : result.outcome?.message ?? 'Undo requested.',
        },
      };
    }

    if (pathname === '/api/kill-switch') {
      if (typeof body.on !== 'boolean') return { status: 400, body: { error: 'Send {"on": true} or {"on": false}.' } };
      await engine.setKillSwitch(body.on, who);
      return { status: 200, body: { ok: true, killSwitch: engine.killSwitchState() } };
    }

    const win = /^\/api\/accounts\/([A-Za-z0-9-]{3,40})\/window(\/close)?$/.exec(pathname);
    if (win) {
      const [, accountId, close] = win;
      if (close) {
        await engine.closeChangeWindow(accountId, who);
        return { status: 200, body: { ok: true, access: await engine.liveAccess(accountId) } };
      }
      const window = await engine.openChangeWindow(accountId, { hours: Number(body.hours), confirmName: typeof body.confirm === 'string' ? body.confirm : '', by: who });
      return { status: 200, body: { ok: true, window, access: await engine.liveAccess(accountId) } };
    }
    return undefined;
  }
}
