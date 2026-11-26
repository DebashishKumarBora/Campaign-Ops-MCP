import path from 'node:path';
import type { AdsBackend } from '../backends/backend.js';
import type { Account, ApprovalChannel, Change, Check, Policy, Proposal, ProposalStatus, Scope } from '../types.js';
import { UserError } from '../types.js';
import { AuditLog, type AuditType } from './audit.js';
import { ControlStore, ProposalStore, type ChangeWindow } from './stores.js';
import { evaluate, inverseOf, normalizeChange, readTargetState } from './changes.js';
import { DirLock } from '../util/fsx.js';
import { witnessCheck, type WitnessReport } from './witness.js';
import { canonical, sameState, sha256 } from '../util/hash.js';
import { cleanText } from '../util/format.js';

export interface EngineOptions {
  backend: AdsBackend;
  dataDir: string;
  policy: Policy;
  scope: Scope;
  /** When true (from the environment), every change is refused no matter what the console says. */
  forceKillSwitch?: boolean;
  /** Injectable clock in milliseconds, for tests. */
  clock?: () => number;
}

export type ApplyStatus =
  | 'applied'
  | 'verify_failed'
  | 'conflict'
  | 'failed'
  | 'refused'
  | 'awaiting_approval'
  | 'already_applied'
  | 'not_applicable';

export interface ApplyOutcome {
  status: ApplyStatus;
  message: string;
  proposal?: Proposal;
}

export interface ProposeInput {
  accountId: string;
  change: Change;
  reason: string;
  requestedBy: string;
  rollbackOf?: string;
}

const OPEN: ProposalStatus[] = ['pending_approval', 'approved'];

/** Whether an account needs a change window, and whether one is open. */
export interface LiveAccess {
  required: boolean;
  open: boolean;
  until?: string;
  openedBy?: string;
  openedAt?: string;
  hours?: number;
}

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
const utcLabel = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The governance engine. Every change, including an undo, follows one path:
 * propose (policy checks + dry run) → human approval → apply (re-check,
 * drift check, execute) → verify. There is deliberately no way for the AI to
 * approve: approve() and reject() are only called from human channels.
 */
export class Engine {
  readonly store: ProposalStore;
  readonly audit: AuditLog;
  readonly control: ControlStore;
  private readonly lock: DirLock;

  constructor(private readonly opts: EngineOptions) {
    this.lock = new DirLock(path.join(opts.dataDir, '.lock'));
    this.store = new ProposalStore(path.join(opts.dataDir, 'proposals.json'));
    this.audit = new AuditLog(path.join(opts.dataDir, 'audit.jsonl'));
    this.control = new ControlStore(path.join(opts.dataDir, 'control.json'));
  }

  get policy(): Policy {
    return this.opts.policy;
  }

  get scope(): Scope {
    return this.opts.scope;
  }

  get backend(): AdsBackend {
    return this.opts.backend;
  }

  now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private bindingOf(p: Pick<Proposal, 'id' | 'accountId' | 'change' | 'before' | 'after' | 'rollbackOf'>): string {
    return sha256(canonical({ id: p.id, accountId: p.accountId, change: p.change, before: p.before, after: p.after, rollbackOf: p.rollbackOf ?? null }));
  }

  private log(type: AuditType, actor: string, proposalId: string | undefined, details: Record<string, unknown> = {}): void {
    this.audit.append({ ts: this.iso(), type, actor, proposalId, details });
  }

  killSwitchState(): { on: boolean; forcedByEnv: boolean; updatedAt?: string; updatedBy?: string } {
    const c = this.control.load();
    return { on: Boolean(this.opts.forceKillSwitch) || c.killSwitch, forcedByEnv: Boolean(this.opts.forceKillSwitch), updatedAt: c.updatedAt, updatedBy: c.updatedBy };
  }

  async setKillSwitch(on: boolean, by: string): Promise<void> {
    await this.lock.run(() => {
      const current = this.control.load();
      if (current.killSwitch === on) return;
      this.control.save({ ...current, killSwitch: on, updatedAt: this.iso(), updatedBy: by });
      this.log(on ? 'kill_switch_on' : 'kill_switch_off', by, undefined, {});
    });
  }

  // ---------- change windows for live accounts ----------

  /** The open change window for an account, or undefined if none is open right now. */
  private activeWindow(accountId: string): ChangeWindow | undefined {
    const w = this.control.load().windows?.[accountId];
    return w && Date.parse(w.until) > this.now() ? w : undefined;
  }

  private liveFor(account: Account): LiveAccess {
    if (account.mode !== 'google_ads') return { required: false, open: true };
    const w = this.activeWindow(account.id);
    return w ? { required: true, open: true, until: w.until, openedBy: w.openedBy, openedAt: w.openedAt, hours: w.hours } : { required: true, open: false };
  }

  /** Live (non-test) accounts are read-only until a person opens a change window. */
  async liveAccess(accountId: string): Promise<LiveAccess> {
    const account = await this.opts.backend.getAccount(accountId);
    if (!account) throw new UserError(`Unknown account ${accountId}.`);
    return this.liveFor(account);
  }

  /** Every change window that is open right now. */
  openWindows(): ChangeWindow[] {
    const now = this.now();
    return Object.values(this.control.load().windows ?? {}).filter((w) => Date.parse(w.until) > now);
  }

  /**
   * Human only: allows changes to one live account for a few hours. The person
   * must type the account's name, the way you confirm a dangerous action.
   * Every change still needs its own approval.
   */
  async openChangeWindow(accountId: string, input: { hours: number; confirmName: string; by: string }): Promise<ChangeWindow> {
    const account = await this.opts.backend.getAccount(accountId);
    if (!account) throw new UserError(`Unknown account ${accountId}.`);
    if (account.mode !== 'google_ads') throw new UserError(`${account.name} is not a live account, so it does not need a change window.`);
    const max = this.opts.policy.live.maxWindowHours;
    const hours = Number(input.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > max) throw new UserError(`A change window can last 1 to ${max} hours.`);
    if (!sameName(String(input.confirmName ?? ''), account.name)) throw new UserError(`Type the account name exactly as shown (${account.name}) to open a change window.`);
    const by = cleanText(input.by, 80) || 'person';
    return this.lock.run(() => {
      const current = this.control.load();
      const now = this.now();
      const window: ChangeWindow = { accountId: account.id, until: this.iso(now + hours * 3_600_000), openedAt: this.iso(now), openedBy: by, hours };
      this.control.save({ ...current, windows: { ...(current.windows ?? {}), [account.id]: window } });
      this.log('change_window_opened', by, undefined, { accountId: account.id, account: account.name, hours, until: window.until });
      return window;
    });
  }

  /** Human only: locks a live account again straight away. */
  async closeChangeWindow(accountId: string, by: string): Promise<void> {
    await this.lock.run(() => {
      const current = this.control.load();
      const w = current.windows?.[accountId];
      if (!w) return;
      const windows = { ...(current.windows ?? {}) };
      delete windows[accountId];
      this.control.save({ ...current, windows });
      if (Date.parse(w.until) > this.now()) this.log('change_window_closed', cleanText(by, 80) || 'person', undefined, { accountId, early: true });
    });
  }

  /** Marks expired proposals and approvals. Must run inside the lock. Returns true if anything changed. */
  private expireLocked(proposals: Proposal[]): boolean {
    const now = this.now();
    let changed = false;
    for (const p of proposals) {
      if (p.status === 'pending_approval' && Date.parse(p.expiresAt) <= now) {
        p.status = 'expired';
        p.error = 'Nobody approved it before it expired.';
        this.log('expired', 'system', p.id, { stage: 'pending_approval' });
        changed = true;
      } else if (p.status === 'approved' && p.approval && Date.parse(p.approval.expiresAt) <= now) {
        p.status = 'expired';
        p.error = 'The approval expired before the change was applied.';
        this.log('expired', 'system', p.id, { stage: 'approved' });
        changed = true;
      }
    }
    return changed;
  }

  async sweep(): Promise<void> {
    await this.lock.run(() => {
      const data = this.store.load();
      if (this.expireLocked(data.proposals)) this.store.save(data);
    });
  }

  async listProposals(filter: { status?: ProposalStatus; limit?: number } = {}): Promise<Proposal[]> {
    await this.sweep();
    const all = this.store.list().filter((p) => !filter.status || p.status === filter.status);
    return all.reverse().slice(0, filter.limit ?? 20);
  }

  async getProposal(id: string): Promise<Proposal | undefined> {
    await this.sweep();
    return this.store.get(id);
  }

  private cooldownRemainingMs(proposals: Proposal[], targetKey: string, excludeId?: string): number {
    const windowMs = this.opts.policy.rateLimits.entityCooldownMinutes * 60_000;
    const last = proposals
      .filter((p) => p.targetKey === targetKey && p.appliedAt && p.id !== excludeId)
      .map((p) => Date.parse(p.appliedAt!))
      .sort((a, b) => b - a)[0];
    if (!last) return 0;
    return Math.max(0, windowMs - (this.now() - last));
  }

  async propose(input: ProposeInput): Promise<Proposal> {
    if (this.opts.scope === 'read') throw new UserError('This server runs in read scope, so proposals are turned off.');
    const account = await this.opts.backend.getAccount(input.accountId);
    if (!account) throw new UserError(`Unknown account ${input.accountId}. Call list_accounts for valid IDs.`);
    const reason = cleanText(input.reason ?? '', 600);
    if (reason.length < 10) throw new UserError('Add a reason of at least one sentence. The person approving needs to know why.');
    const requestedBy = cleanText(input.requestedBy, 80) || 'agent';
    const change = normalizeChange(input.change);

    return this.lock.run(async () => {
      const data = this.store.load();
      this.expireLocked(data.proposals);

      const evaluation = await evaluate(
        { backend: this.opts.backend, accountId: account.id, policy: this.opts.policy, isRollback: Boolean(input.rollbackOf), currency: account.currency },
        change,
      );
      const checks: Check[] = [...evaluation.checks];

      const open = data.proposals.find((p) => p.accountId === account.id && p.targetKey === evaluation.targetKey && OPEN.includes(p.status));
      checks.push(
        open
          ? { id: 'open_proposal', label: 'No other open proposal for this target', status: 'fail', detail: `${open.id} is already open for this target. Approve it, reject it or let it expire first.` }
          : { id: 'open_proposal', label: 'No other open proposal for this target', status: 'pass' },
      );

      if (!input.rollbackOf) {
        const wait = this.cooldownRemainingMs(data.proposals, evaluation.targetKey);
        if (wait > 0) checks.push({ id: 'cooldown', label: 'Cooldown', status: 'warn', detail: `This target changed recently. It can be applied in about ${Math.ceil(wait / 60_000)} minutes.` });
      }

      if (this.killSwitchState().on) checks.push({ id: 'kill_switch', label: 'Changes are live', status: 'warn', detail: 'The kill switch is on. This can be approved but not applied until a person resumes changes.' });

      const access = this.liveFor(account);
      if (access.required) {
        checks.push(
          access.open
            ? { id: 'live_access', label: 'Change window open for this live account', status: 'pass', detail: `A person opened a ${access.hours}-hour window. Changes are allowed until ${utcLabel(access.until!)}.` }
            : { id: 'live_access', label: 'Change window open for this live account', status: 'warn', detail: 'This is a live Google Ads account and changes are off. It can be approved, but it cannot be applied until a person opens a change window in the approval console.' },
        );
      }

      const dry = await this.opts.backend.mutate(account.id, change, { validateOnly: true });
      checks.push(
        dry.ok
          ? { id: 'dry_run', label: 'Dry run (validate only)', status: 'pass', detail: 'The platform accepted the change without applying it.' }
          : { id: 'dry_run', label: 'Dry run (validate only)', status: 'fail', detail: dry.errors.join(' ') },
      );

      const blocked = checks.some((c) => c.status === 'fail');
      const id = `P-${String(data.nextSeq).padStart(4, '0')}`;
      data.nextSeq += 1;
      const createdMs = this.now();

      const proposal: Proposal = {
        id,
        createdAt: this.iso(createdMs),
        accountId: account.id,
        change,
        typeLabel: input.rollbackOf ? `Undo of ${input.rollbackOf}` : evaluation.typeLabel,
        targetKey: evaluation.targetKey,
        targetLabel: evaluation.targetLabel,
        reason,
        requestedBy,
        summary: evaluation.summary,
        diff: evaluation.diff,
        before: evaluation.before,
        after: evaluation.after,
        risk: evaluation.risk,
        checks,
        fairHousing: evaluation.fairHousing,
        status: blocked ? 'blocked' : 'pending_approval',
        bindingHash: '',
        expiresAt: this.iso(createdMs + this.opts.policy.approvals.proposalTtlHours * 3_600_000),
        rollbackOf: input.rollbackOf,
      };
      proposal.bindingHash = this.bindingOf(proposal);

      data.proposals.push(proposal);
      this.store.save(data);
      this.log(blocked ? 'proposal_blocked' : 'proposal_created', requestedBy, id, {
        summary: proposal.summary,
        risk: proposal.risk,
        failedChecks: checks.filter((c) => c.status === 'fail').map((c) => c.id),
        rollbackOf: input.rollbackOf,
      });
      if (input.rollbackOf && !blocked) this.log('rollback_requested', requestedBy, input.rollbackOf, { rollbackProposal: id });
      return proposal;
    });
  }

  /** Human approval. Never exposed as an AI tool. */
  async approve(id: string, by: { by: string; channel: ApprovalChannel; note?: string }): Promise<Proposal> {
    return this.lock.run(() => {
      const data = this.store.load();
      const changed = this.expireLocked(data.proposals);
      const p = data.proposals.find((x) => x.id === id);
      if (!p) {
        if (changed) this.store.save(data);
        throw new UserError(`No proposal ${id}.`);
      }
      if (p.status !== 'pending_approval') {
        if (changed) this.store.save(data);
        throw new UserError(`${id} is ${p.status.replace(/_/g, ' ')} and cannot be approved.`);
      }
      if (this.bindingOf(p) !== p.bindingHash) {
        p.status = 'failed';
        p.error = 'The stored proposal no longer matches what was proposed, so it cannot be approved.';
        this.store.save(data);
        this.log('tamper_detected', 'system', id, { stage: 'approve' });
        throw new UserError(p.error);
      }
      const now = this.now();
      p.approval = {
        by: cleanText(by.by, 80),
        channel: by.channel,
        at: this.iso(now),
        note: by.note ? cleanText(by.note, 300) : undefined,
        expiresAt: this.iso(now + this.opts.policy.approvals.approvalTtlMinutes * 60_000),
        bindingHash: p.bindingHash,
      };
      p.status = 'approved';
      this.store.save(data);
      this.log('approved', p.approval.by, id, { channel: by.channel, note: p.approval.note });
      return p;
    });
  }

  /** Human rejection. Never exposed as an AI tool. */
  async reject(id: string, by: { by: string; channel: ApprovalChannel; note?: string }): Promise<Proposal> {
    return this.lock.run(() => {
      const data = this.store.load();
      const changed = this.expireLocked(data.proposals);
      const p = data.proposals.find((x) => x.id === id);
      if (!p || !OPEN.includes(p.status)) {
        if (changed) this.store.save(data);
        throw new UserError(p ? `${id} is ${p.status.replace(/_/g, ' ')} and cannot be rejected.` : `No proposal ${id}.`);
      }
      p.rejection = { by: cleanText(by.by, 80), channel: by.channel, at: this.iso(), note: by.note ? cleanText(by.note, 300) : undefined };
      p.status = 'rejected';
      this.store.save(data);
      this.log('rejected', p.rejection.by, id, { channel: by.channel, note: p.rejection.note });
      return p;
    });
  }

  async apply(id: string, who: { actor: string; human?: boolean }): Promise<ApplyOutcome> {
    if (!who.human && this.opts.scope !== 'execute') {
      return { status: 'refused', message: `This server runs in ${this.opts.scope} scope. Applying changes needs execute scope.` };
    }
    return this.lock.run(async () => {
      const data = this.store.load();
      if (this.expireLocked(data.proposals)) this.store.save(data);
      const p = data.proposals.find((x) => x.id === id);
      if (!p) throw new UserError(`No proposal ${id}.`);

      if (p.status === 'applied') return { status: 'already_applied', proposal: p, message: `${id} was already applied at ${p.appliedAt}.` };
      if (p.status === 'pending_approval') return { status: 'awaiting_approval', proposal: p, message: `${id} is waiting for a person to approve it.` };
      if (p.status !== 'approved') return { status: 'not_applicable', proposal: p, message: `${id} is ${p.status.replace(/_/g, ' ')}, so it cannot be applied.` };

      const refuse = (message: string, details: Record<string, unknown> = {}): ApplyOutcome => {
        this.log('apply_refused', who.actor, id, { reason: message, ...details });
        return { status: 'refused', proposal: p, message };
      };

      if (this.killSwitchState().on) return refuse('Changes are paused by the kill switch. A person must resume changes in the approval console first.');

      const accountNow = await this.opts.backend.getAccount(p.accountId);
      if (!accountNow) return refuse(`Account ${p.accountId} is no longer available.`);
      const access = this.liveFor(accountNow);
      if (!access.open) return refuse(`${accountNow.name} is a live account and no change window is open. A person can open one in the approval console; then apply again.`);

      if (this.bindingOf(p) !== p.bindingHash || p.approval?.bindingHash !== p.bindingHash) {
        p.status = 'failed';
        p.error = 'The stored proposal no longer matches what was approved, so it was not applied.';
        this.store.save(data);
        this.log('tamper_detected', 'system', id, { stage: 'apply' });
        return { status: 'failed', proposal: p, message: p.error };
      }

      const now = this.now();
      const appliedTimes = data.proposals.filter((x) => x.appliedAt).map((x) => Date.parse(x.appliedAt!));
      const lastHour = appliedTimes.filter((t) => now - t < 3_600_000).length;
      const lastDay = appliedTimes.filter((t) => now - t < 86_400_000).length;
      const limits = this.opts.policy.rateLimits;
      if (lastHour >= limits.maxAppliedPerHour) return refuse(`Rate limit reached: ${lastHour} changes applied in the last hour (limit ${limits.maxAppliedPerHour}).`);
      if (lastDay >= limits.maxAppliedPerDay) return refuse(`Rate limit reached: ${lastDay} changes applied in the last 24 hours (limit ${limits.maxAppliedPerDay}).`);

      if (!p.rollbackOf) {
        const wait = this.cooldownRemainingMs(data.proposals, p.targetKey, p.id);
        if (wait > 0) return refuse(`Cooldown: this target changed recently. Try again in about ${Math.ceil(wait / 60_000)} minutes.`);
      }

      const fresh = await evaluate(
        { backend: this.opts.backend, accountId: p.accountId, policy: this.opts.policy, isRollback: Boolean(p.rollbackOf), currency: accountNow.currency },
        p.change,
      );

      if (!sameState(fresh.before, p.before)) {
        p.status = 'conflict';
        p.error = 'The live value changed after this was proposed, so it was not applied. Read the current state and propose again.';
        this.store.save(data);
        this.log('conflict', who.actor, id, { expected: p.before, found: fresh.before });
        return { status: 'conflict', proposal: p, message: p.error };
      }

      const failing = fresh.checks.filter((c) => c.status === 'fail');
      if (failing.length) return refuse(`Policy re-check failed: ${failing.map((c) => `${c.label}. ${c.detail ?? ''}`.trim()).join(' ')}`);

      const result = await this.opts.backend.mutate(p.accountId, p.change, { validateOnly: false, liveAccess: access.required && access.open });
      if (!result.ok) {
        p.status = 'failed';
        p.error = result.errors.join(' ') || 'The platform rejected the change.';
        this.store.save(data);
        this.log('apply_failed', who.actor, id, { errors: result.errors });
        return { status: 'failed', proposal: p, message: p.error };
      }

      p.appliedAt = this.iso(now);
      p.appliedBy = cleanText(who.actor, 80);
      const observed = await readTargetState(this.opts.backend, p.accountId, p.change);
      const passed = sameState(observed, p.after);
      p.verification = { status: passed ? 'passed' : 'failed', at: this.iso(), observed };
      p.status = passed ? 'applied' : 'verify_failed';

      if (passed && p.rollbackOf) {
        const original = data.proposals.find((x) => x.id === p.rollbackOf);
        if (original) {
          original.status = 'rolled_back';
          original.rolledBackBy = p.id;
        }
      }
      this.store.save(data);

      if (passed) {
        this.log('applied', p.appliedBy, id, { summary: p.summary, verified: true });
        if (p.rollbackOf) this.log('rolled_back', p.appliedBy, p.rollbackOf, { by: id });
        return { status: 'applied', proposal: p, message: `Applied and verified: ${p.summary}` };
      }
      this.log('verify_failed', p.appliedBy, id, { expected: p.after, observed });
      return { status: 'verify_failed', proposal: p, message: 'The change was sent but the account does not show the expected result. Check the account and consider an undo.' };
    });
  }

  // ---------- independent checks ----------

  /** Compares Google's own change history with this log. See witness.ts. */
  async witness(accountId: string, days = 14): Promise<WitnessReport> {
    await this.sweep();
    return witnessCheck({
      backend: this.opts.backend,
      accountId,
      days,
      proposals: this.store.list(),
      setupRuns: this.audit.readAll().filter((e) => e.type === 'setup_changes'),
      now: this.now(),
    });
  }

  /** Records changes made by npm run gads:setup, so the witness check knows they were expected. */
  async recordSetup(input: { accountId: string; from: string; to: string; changes: number; by: string }): Promise<void> {
    await this.lock.run(() => {
      this.log('setup_changes', cleanText(input.by, 80) || 'setup script', undefined, { accountId: input.accountId, from: input.from, to: input.to, changes: input.changes });
    });
  }

  /** Creates an undo proposal for an applied change. The undo needs approval like any other change. */
  async requestRollback(id: string, input: { reason?: string; requestedBy: string }): Promise<Proposal> {
    if (this.opts.scope === 'read') throw new UserError('This server runs in read scope, so rollbacks are turned off.');
    await this.sweep();
    const all = this.store.list();
    const original = all.find((p) => p.id === id);
    if (!original) throw new UserError(`No proposal ${id}.`);
    if (original.rollbackOf) throw new UserError(`${id} is itself an undo. Propose a fresh change instead.`);
    if (original.status !== 'applied') throw new UserError(`${id} is ${original.status.replace(/_/g, ' ')}. Only applied changes can be undone.`);
    const open = all.find((p) => p.rollbackOf === id && OPEN.includes(p.status));
    if (open) throw new UserError(`${open.id} is already waiting to undo ${id}.`);

    const live = await readTargetState(this.opts.backend, original.accountId, original.change);
    if (!sameState(live, original.after)) {
      throw new UserError(`The live value changed after ${id} was applied, so an automatic undo is not safe. Check the current state and propose a fresh change.`);
    }
    return this.propose({
      accountId: original.accountId,
      change: inverseOf(original.change, original.before),
      reason: input.reason && input.reason.trim().length >= 10 ? input.reason : `Undo ${id}: restore the previous value.`,
      requestedBy: input.requestedBy,
      rollbackOf: id,
    });
  }

  /** One-click undo from the human console: request, approve and apply in one step. */
  async undoNow(id: string, by: string): Promise<{ rollback: Proposal; outcome?: ApplyOutcome }> {
    const rollback = await this.requestRollback(id, { reason: `Undo ${id} from the approval console.`, requestedBy: by });
    if (rollback.status !== 'pending_approval') return { rollback };
    await this.approve(rollback.id, { by, channel: 'console', note: 'One-click undo' });
    const outcome = await this.apply(rollback.id, { actor: by, human: true });
    return { rollback: outcome.proposal ?? rollback, outcome };
  }
}
