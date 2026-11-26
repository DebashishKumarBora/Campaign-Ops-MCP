import path from 'node:path';
import type { Engine } from '../governance/engine.js';
import type { AdsBackend } from '../backends/backend.js';
import type { Account, Ad, Campaign, Change, Proposal } from '../types.js';
import { UserError } from '../types.js';
import { checkPulse, type PulseAlarm } from '../governance/pulse.js';
import { runDiagnostics, type DiagnosticsReport } from '../governance/diagnostics.js';
import { lintAd } from '../governance/fairHousing.js';
import { inverseOf, targetKeyOf } from '../governance/changes.js';
import { addDays, money, round2 } from '../util/format.js';
import { dayInZone, partsInZone, zonedToUtcMs } from '../util/time.js';
import { AutopilotStore } from './store.js';
import { applySettingsPatch, inQuiet, SKILLS, skillName, watches } from './settings.js';
import { AI_DAILY_LIMIT, pickLines, type AiBrain, type CopyContext } from './ai.js';
import { classify, fetchPage as defaultFetchPage, pageKey, skipReason, type PageFetcher } from './landing.js';
import { buildMemory, fairHousingCandidates, findingCandidates, pacingCandidates, refreshCandidate, roughly, safeSource, skippedBy, type Memory, type ScanContext } from './skills.js';
import { judge, outcomeKind, totals } from './outcomes.js';
import { shortTitle } from './words.js';
import type { AiTask, AutopilotReport, AutopilotSettings, Candidate, Job, Level, Notice, ReviewWork, SkillId } from './types.js';

/** How Autopilot signs its proposals. */
export const AUTOPILOT = 'Autopilot';

const DAY = 86_400_000;
/** Open Autopilot proposals at once, so the approvals list never floods. */
const MAX_OPEN = 12;
/** Work per step, small enough for the free plan's per-request limits. */
const AI_PER_STEP = 2;
const PROPOSE_PER_STEP = 3;
const PAGES_PER_WATCH = 8;
/** A review that stopped halfway (the server restarted) starts over after this. */
const STALE_WORK_MS = 2 * 3_600_000;
/** "Check now" at most this often (a review already running also says no). */
export const MANUAL_GAP_MS = 10_000;

const PULSE_SKILL: Record<PulseAlarm['kind'], SkillId> = { tracking_outage: 'tracking', stopped_spending: 'stalled', spend_spike: 'spend_spike', lead_drop: 'lead_drop' };

export interface AutopilotOptions {
  engine: Engine;
  backend: AdsBackend;
  dataDir: string;
  /** The free AI (Workers AI in the cloud). Without it Autopilot uses rules only. */
  brain?: AiBrain;
  /** Opens landing pages. Defaults to a plain fetch. */
  fetchPage?: PageFetcher;
  /** Sends phone and desktop notifications (the cloud). */
  notify?: (notices: Notice[]) => Promise<void> | void;
  /** Which pages are never opened, and why. Defaults to example, test and private addresses. */
  pageFilter?: (url: string) => string | undefined;
  clock?: () => number;
}

/**
 * Autopilot runs as small jobs, so the cloud can spread a review over several
 * short requests:
 *
 *   watch           every hour: outside changes, ad approvals, landing pages
 *   review          once a day, in steps: pulse, scan, ai, propose, finish
 *   apply_approved  applies anything approved that could not be applied yet
 *   deliver         sends notifications held during quiet hours
 *
 * On a computer, runAll() simply runs the jobs one after another.
 */
export class Autopilot {
  readonly store: AutopilotStore;

  constructor(private readonly opts: AutopilotOptions) {
    this.store = new AutopilotStore(path.join(opts.dataDir, 'autopilot.json'), () => this.now());
  }

  now(): number {
    return this.opts.clock ? this.opts.clock() : this.opts.engine.now();
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  get hasAi(): boolean {
    return Boolean(this.opts.brain);
  }

  settings(): AutopilotSettings {
    return this.store.load().settings;
  }

  private local(settings = this.settings()): { day: string; hour: number } {
    return { day: dayInZone(this.now(), settings.timezone), hour: partsInZone(this.now(), settings.timezone).h };
  }

  /** Changes settings from the console. Recorded in the audit log, because it changes what gets proposed. */
  async updateSettings(patch: unknown, by: string): Promise<AutopilotSettings> {
    const accounts = await this.opts.backend.listAccounts();
    const ids = new Set(accounts.map((a) => a.id));
    const p = (patch ?? {}) as Record<string, Record<string, unknown> | undefined>;
    for (const id of [...Object.keys(p.monthlyTargets ?? {}), ...Object.keys(p.accounts ?? {})]) if (!ids.has(id)) throw new UserError(`Unknown account ${id}.`);
    const next = this.store.update((f) => {
      const s = applySettingsPatch(f.settings, patch);
      s.updatedAt = this.iso();
      s.updatedBy = by;
      f.settings = s;
      return s;
    });
    await this.opts.engine.recordEvent('autopilot_settings', by, { changed: Object.keys(p).filter((k) => k !== 'proof'), on: next.on });
    return next;
  }

  // ---------- planning ----------

  /** What the hourly tick should do now. */
  async plan(): Promise<Job[]> {
    const f = this.store.load();
    const s = f.settings;
    const jobs: Job[] = [{ kind: 'apply_approved' }];
    if (!s.on) return jobs;
    jobs.push({ kind: 'deliver' });
    const all = await this.opts.backend.listAccounts();
    const mine = all.filter((a) => watches(s, a, all));
    const { day, hour } = this.local(s);
    for (const a of mine) jobs.push({ kind: 'watch', accountId: a.id });
    for (const a of mine) {
      if (f.work[a.id] || (hour >= s.reviewHour && f.reviewed[a.id] !== day)) jobs.push({ kind: 'review', accountId: a.id });
    }
    return jobs;
  }

  /** "Check now": a full review right away, of one account or every watched one. */
  async checkNow(accountId?: string): Promise<Job[]> {
    const f = this.store.load();
    const all = await this.opts.backend.listAccounts();
    const targets = accountId ? all.filter((a) => a.id === accountId) : all.filter((a) => watches(f.settings, a, all));
    const busy = targets.some((a) => f.work[a.id] && this.now() - Date.parse(f.work[a.id].startedAt) < STALE_WORK_MS);
    if (busy || (f.manualAt && this.now() - Date.parse(f.manualAt) < MANUAL_GAP_MS)) throw new UserError('Autopilot is already checking. Give it a minute.');
    if (!targets.length) throw new UserError(accountId ? `Unknown account ${accountId}.` : 'Autopilot is not looking after any account. Turn one on in Settings.');
    this.store.update((x) => {
      x.manualAt = this.iso();
    });
    return [{ kind: 'apply_approved' }, ...targets.map((a): Job => ({ kind: 'watch', accountId: a.id })), ...targets.map((a): Job => ({ kind: 'review', accountId: a.id, manual: true }))];
  }

  // ---------- running ----------

  /** Runs one job (one step of a review) and returns the jobs that follow from it. */
  async run(job: Job): Promise<Job[]> {
    switch (job.kind) {
      case 'watch':
        await this.watch(job.accountId);
        return [];
      case 'review':
        return this.reviewStep(job.accountId, Boolean(job.manual));
      case 'apply_approved':
        await this.applyApproved();
        return [];
      case 'deliver':
        await this.deliverHeld();
        return [];
    }
  }

  /** Runs jobs and everything they lead to, one after another. Used on a computer and in tests. */
  async runAll(jobs: Job[], maxSteps = 400): Promise<void> {
    const queue = [...jobs];
    let steps = 0;
    while (queue.length && steps++ < maxSteps) {
      const job = queue.shift()!;
      try {
        queue.unshift(...(await this.run(job)));
      } catch (e) {
        this.note('autopilot-error', `Autopilot could not finish a step: ${(e as Error).message}`);
      }
    }
  }

  // ---------- notifications ----------

  private async send(notices: Notice[]): Promise<void> {
    if (!notices.length) return;
    const s = this.settings();
    const quiet = inQuiet(s.quiet, this.local(s).hour);
    const now: Notice[] = [];
    const hold: Notice[] = [];
    for (const n of notices) (quiet && !(n.urgent && s.quiet.urgentAnyway) ? hold : now).push(n);
    if (hold.length) {
      this.store.update((f) => {
        f.held.push(...hold);
      });
    }
    if (now.length && this.opts.notify) {
      try {
        await this.opts.notify(now);
      } catch {
        // a notification problem never stops the work
      }
    }
  }

  private async deliverHeld(): Promise<void> {
    const s = this.settings();
    if (inQuiet(s.quiet, this.local(s).hour)) return;
    const held = this.store.update((f) => {
      const h = f.held;
      f.held = [];
      return h;
    });
    if (!held.length || !this.opts.notify) return;
    const one = held.length === 1;
    const notice: Notice = one
      ? held[0]
      : { title: 'Autopilot while you were away', body: `${held.length} updates: ${held.slice(0, 3).map((h) => h.title).join('; ')}`.slice(0, 180), url: '/#home', tag: 'autopilot-digest', urgent: false };
    try {
      await this.opts.notify([notice]);
    } catch {
      // as above
    }
  }

  private note(key: string, text: string, level: Level = 'info'): void {
    const { day } = this.local();
    this.store.update((f) => {
      const k = `note:${key}:${day}`;
      if (f.sent[k]) return;
      f.sent[k] = this.iso();
      AutopilotStore.push(f, { at: this.iso(), kind: 'note', level, title: text });
    });
  }

  // ---------- hourly watch ----------

  private async watch(accountId: string): Promise<void> {
    const s = this.settings();
    const account = await this.opts.backend.getAccount(accountId);
    if (!account) return;
    const notices: Notice[] = [];
    if (s.skills.outside_changes) notices.push(...(await this.safely('outside changes', () => this.watchOutside(account))));
    if (s.skills.ad_policy) notices.push(...(await this.safely('ad approvals', () => this.watchPolicy(account))));
    if (s.skills.landing_pages) notices.push(...(await this.safely('landing pages', () => this.watchPages(account))));
    this.store.update((f) => {
      f.lastWatch = this.iso();
    });
    await this.send(notices);
  }

  private async safely(what: string, fn: () => Promise<Notice[]>): Promise<Notice[]> {
    try {
      return await fn();
    } catch (e) {
      this.note(`watch:${what}`, `Could not check ${what}: ${(e as Error).message}`);
      return [];
    }
  }

  private async watchOutside(account: Account): Promise<Notice[]> {
    const w = await this.opts.engine.witness(account.id, 14);
    if (w.verdict === 'unavailable') return [];
    const out: Notice[] = [];
    const now = this.now();
    this.store.update((f) => {
      if (w.verdict === 'alarm') {
        const key = `witness:${account.id}:${w.unexplained.map((e) => `${e.resourceName}@${e.at}`).join('|')}`;
        if (!f.sent[key]) {
          f.sent[key] = this.iso();
          AutopilotStore.push(f, {
            at: this.iso(),
            kind: 'alert',
            level: 'urgent',
            skill: 'outside_changes',
            accountId: account.id,
            title: `A change nobody approved in ${account.name}`,
            detail: w.headline,
            steps: ['Open the account and read what Google recorded.', 'If you do not recognize it, turn on Pause all, then replace the robot key in Google Cloud.'],
          });
          out.push({ title: `Unapproved change in ${account.name}`, body: w.headline.slice(0, 180), url: `/#a=${encodeURIComponent(account.id)}`, tag: `witness-${account.id}`, urgent: true });
        }
      }
      const fresh: string[] = [];
      for (const e of w.outside) {
        const key = `outside:${account.id}:${e.resourceName}@${e.at}`;
        if (f.sent[key]) continue;
        f.sent[key] = this.iso();
        const when = new Date(e.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: f.settings.timezone });
        AutopilotStore.push(f, { at: this.iso(), kind: 'alert', level: 'info', skill: 'outside_changes', accountId: account.id, title: `Changed outside Campaign Ops: ${e.summary}`, detail: `${e.actor} with ${e.client}, ${when}.` });
        if (now - Date.parse(e.at) < 2 * DAY) fresh.push(e.summary);
      }
      if (fresh.length) {
        out.push({ title: fresh.length === 1 ? 'A change made outside Campaign Ops' : `${fresh.length} changes made outside Campaign Ops`, body: fresh.slice(0, 2).join('; ').slice(0, 180), url: '/#activity', tag: `outside-${account.id}`, urgent: false });
      }
    });
    return out;
  }

  private async watchPolicy(account: Account): Promise<Notice[]> {
    if (!this.opts.backend.getAdPolicyIssues) return [];
    const issues = await this.opts.backend.getAdPolicyIssues(account.id);
    if (!issues.length) return [];
    const campaigns = await this.opts.backend.listCampaigns(account.id);
    const out: Notice[] = [];
    this.store.update((f) => {
      for (const i of issues) {
        const key = `policy:${account.id}:${i.adId}:${i.approval}:${i.topics.join(',')}`;
        if (f.sent[key]) continue;
        f.sent[key] = this.iso();
        const off = i.approval === 'DISAPPROVED';
        const where = campaigns.find((c) => c.id === i.campaignId)?.name ?? `campaign ${i.campaignId}`;
        const title = `Google ${off ? 'disapproved' : 'limited'} ad ${i.adId} in ${where}`;
        const detail = `${i.topics.length ? `Google's reason: ${i.topics.join(', ')}. ` : ''}${off ? 'A disapproved ad does not run at all.' : 'A limited ad shows in fewer places or to fewer people.'}`;
        AutopilotStore.push(f, {
          at: this.iso(),
          kind: 'alert',
          level: off ? 'urgent' : 'warn',
          skill: 'ad_policy',
          accountId: account.id,
          title,
          detail,
          steps: ['Open the ad in Google Ads and read the policy details.', 'Fix the ad and Google reviews it again, or appeal there if the decision looks wrong.'],
        });
        out.push({ title, body: detail.slice(0, 180), url: `/#a=${encodeURIComponent(account.id)}`, tag: `policy-${i.adId}`, urgent: off });
      }
    });
    return out;
  }

  /** Applied pauses that landing pages made, by page. */
  private pagePauses(proposals: Proposal[], accountId: string): Map<string, Proposal[]> {
    const out = new Map<string, Proposal[]>();
    for (const p of proposals) {
      if (p.accountId !== accountId || p.status !== 'applied' || p.insight?.skill !== 'landing_pages') continue;
      const pausing = (p.change.type === 'set_campaign_status' || p.change.type === 'set_ad_status') && p.change.newStatus === 'PAUSED';
      if (!pausing) continue;
      for (const k of p.insight.keys ?? []) {
        if (!k.startsWith('page:')) continue;
        const url = k.slice(5);
        out.set(url, [...(out.get(url) ?? []), p]);
      }
    }
    return out;
  }

  private async watchPages(account: Account): Promise<Notice[]> {
    const backend = this.opts.backend;
    const [ads, campaigns] = await Promise.all([backend.listAds(account.id), backend.listCampaigns(account.id)]);
    const proposals = this.opts.engine.store.list();
    const paused = this.pagePauses(proposals, account.id);
    const enabled = new Set(campaigns.filter((c) => c.status === 'ENABLED').map((c) => c.id));
    const live = ads.filter((a) => a.status === 'ENABLED' && enabled.has(a.campaignId) && a.finalUrl);
    const skip = this.opts.pageFilter ?? skipReason;
    const urls = [...new Set([...live.map((a) => pageKey(a.finalUrl)), ...paused.keys()])].filter((u) => !skip(u));
    if (!urls.length) return [];
    const known = this.store.load().pages;
    urls.sort((a, b) => Date.parse(known[a]?.checkedAt ?? '1970-01-01') - Date.parse(known[b]?.checkedAt ?? '1970-01-01'));
    const fetcher = this.opts.fetchPage ?? defaultFetchPage;
    const results = await Promise.all(urls.slice(0, PAGES_PER_WATCH).map(async (url) => ({ url, r: await fetcher(url) })));

    const wentDown: string[] = [];
    const cameBack: string[] = [];
    const notices: Notice[] = [];
    const pages = this.store.update((f) => {
      for (const { url, r } of results) {
        const state = classify(r);
        const prev = f.pages[url];
        const failures = state === 'down' ? (prev?.failures ?? 0) + 1 : 0;
        const wasDown = prev?.state === 'down' && (prev.failures ?? 0) >= 2;
        f.pages[url] = { url, state, status: r.status, error: r.error, failures, checkedAt: this.iso(), downSince: state === 'down' ? (prev?.downSince ?? this.iso()) : undefined };
        if (state === 'down' && failures === 2) wentDown.push(url);
        if (wasDown && state === 'up') cameBack.push(url);
      }
      for (const url of wentDown) {
        const p = f.pages[url];
        const why = p.error ?? `the server answered ${p.status}`;
        AutopilotStore.push(f, { at: this.iso(), kind: 'alert', level: 'urgent', skill: 'landing_pages', accountId: account.id, title: `Landing page down: ${url}`, detail: `It failed the last two checks (${why}). People who click your ads land on a broken page.`, steps: ['Open the page yourself to confirm.', 'Tell whoever runs the website.', 'Approve the pause Autopilot proposed so no more money goes to a broken page.'] });
        notices.push({ title: 'Landing page down', body: `${url} failed two checks in a row (${why}).`.slice(0, 180), url: '/#approvals', tag: `page-${url}`, urgent: true });
      }
      for (const url of cameBack) {
        AutopilotStore.push(f, { at: this.iso(), kind: 'alert', level: 'good', skill: 'landing_pages', accountId: account.id, title: `Landing page back up: ${url}` });
      }
      return f.pages;
    });

    const m = (n: number) => money(n, account.currency);
    const down = new Set(Object.values(pages).filter((p) => p.state === 'down' && p.failures >= 2).map((p) => p.url));
    const candidates: Candidate[] = [];
    if (wentDown.length) {
      for (const c of campaigns.filter((x) => x.status === 'ENABLED')) {
        const cAds = live.filter((a) => a.campaignId === c.id);
        if (!cAds.length) continue;
        const cUrls = [...new Set(cAds.map((a) => pageKey(a.finalUrl)))];
        if (!cUrls.some((u) => wentDown.includes(u))) continue;
        if (cUrls.every((u) => down.has(u))) {
          candidates.push({
            skill: 'landing_pages',
            accountId: account.id,
            campaignId: c.id,
            change: { type: 'set_campaign_status', campaignId: c.id, newStatus: 'PAUSED' },
            reason: `Every ad in ${c.name} sends people to ${cUrls.join(', ')}, which failed the last two checks. Each click until it is fixed pays for a broken page. Autopilot proposes turning the campaign back on once the page works.`,
            insight: { skill: 'landing_pages', impact: `Stops up to ${m(c.dailyBudget)} a day going to a broken page`, evidence: cUrls.map((u) => `${u}: ${pages[u]?.error ?? `answered ${pages[u]?.status}`}`), keys: [`pagepause:${c.id}`, ...cUrls.map((u) => `page:${u}`)] },
            priority: 1,
            urgent: true,
          });
        } else {
          for (const ad of cAds.filter((a) => down.has(pageKey(a.finalUrl))).slice(0, 4)) {
            const u = pageKey(ad.finalUrl);
            candidates.push({
              skill: 'landing_pages',
              accountId: account.id,
              campaignId: c.id,
              change: { type: 'set_ad_status', adId: ad.id, newStatus: 'PAUSED' },
              reason: `Ad ${ad.id} in ${c.name} sends people to ${u}, which failed the last two checks. The campaign's other ads point to working pages and keep running.`,
              insight: { skill: 'landing_pages', impact: 'Stops paying for clicks to a broken page', evidence: [`${u}: ${pages[u]?.error ?? `answered ${pages[u]?.status}`}`], keys: [`pagead:${ad.id}`, `page:${u}`] },
              priority: 1,
              urgent: true,
            });
          }
        }
      }
    }
    for (const url of cameBack) {
      for (const p of paused.get(url) ?? []) {
        const change = p.change;
        if (change.type === 'set_campaign_status') {
          const c = campaigns.find((x) => x.id === change.campaignId);
          if (!c || c.status !== 'PAUSED') continue;
          candidates.push({
            skill: 'landing_pages',
            accountId: account.id,
            campaignId: c.id,
            change: { type: 'set_campaign_status', campaignId: c.id, newStatus: 'ENABLED' },
            reason: `${url} works again, so ${c.name} can run again. ${p.id} paused it while the page was down.`,
            insight: { skill: 'landing_pages', impact: `Brings ${c.name} back`, evidence: [`${url} answered normally on the last check.`], keys: [`pageenable:${c.id}:${p.id}`] },
            priority: 2,
          });
        } else if (change.type === 'set_ad_status') {
          const ad = ads.find((a) => a.id === change.adId);
          if (!ad || ad.status !== 'PAUSED') continue;
          candidates.push({
            skill: 'landing_pages',
            accountId: account.id,
            campaignId: ad.campaignId,
            change: { type: 'set_ad_status', adId: ad.id, newStatus: 'ENABLED' },
            reason: `${url} works again, so ad ${ad.id} can run again. ${p.id} paused it while the page was down.`,
            insight: { skill: 'landing_pages', impact: 'Brings the ad back', evidence: [`${url} answered normally on the last check.`], keys: [`pageenable:${ad.id}:${p.id}`] },
            priority: 2,
          });
        }
      }
    }
    if (candidates.length) {
      const memory = buildMemory(proposals, this.store.load().memory, this.now());
      for (const c of candidates) {
        if (skippedBy(memory, c.insight.keys) || memory.openTargets.has(`${account.id}|${targetKeyOf(c.change)}`)) continue;
        const p = await this.proposeOne(c, []);
        if (p && p.status === 'pending_approval' && c.urgent) notices.push(this.urgentNotice(p));
      }
    }
    return notices;
  }

  // ---------- daily review ----------

  private async reviewStep(accountId: string, manual: boolean): Promise<Job[]> {
    const account = await this.opts.backend.getAccount(accountId);
    if (!account) {
      this.store.update((f) => {
        delete f.work[accountId];
      });
      return [];
    }
    this.currencies.set(account.id, account.currency);
    let work: ReviewWork | undefined = this.store.load().work[accountId];
    if (work && this.now() - Date.parse(work.startedAt) > STALE_WORK_MS) work = undefined;
    const w: ReviewWork = work ?? {
      runId: `R-${this.now().toString(36)}`,
      accountId,
      startedAt: this.iso(),
      manual,
      step: 'pulse',
      holds: [],
      candidates: [],
      proposed: [],
      notified: [],
      alerts: 0,
      notes: [],
    };
    const step = w.step;
    try {
      switch (step) {
        case 'pulse':
          await this.stepPulse(account, w);
          w.step = 'scan';
          break;
        case 'scan':
          await this.stepScan(account, w);
          w.step = w.candidates.some((c) => c.ai) ? 'ai' : 'propose';
          break;
        case 'ai':
          await this.stepAi(w);
          if (!w.candidates.some((c) => c.ai)) w.step = 'propose';
          break;
        case 'propose':
          await this.stepPropose(w);
          if (!w.candidates.length) w.step = 'finish';
          break;
        case 'finish':
          await this.stepFinish(account, w);
          return [];
      }
    } catch (e) {
      w.notes.push(`The ${step} step stopped early: ${(e as Error).message}`);
      if (step === 'pulse') w.step = 'scan';
      else if (step === 'scan') w.step = 'finish';
      else if (step === 'ai') {
        for (const c of w.candidates) if (c.ai) this.fallBack(c, w);
        w.candidates = w.candidates.filter((c) => !c.drop);
        w.step = 'propose';
      } else w.step = 'finish';
    }
    this.store.update((f) => {
      f.work[accountId] = w;
    });
    return [{ kind: 'review', accountId, ...(manual ? { manual } : {}) }];
  }

  private async stepPulse(account: Account, w: ReviewWork): Promise<void> {
    const s = this.settings();
    if (!(s.skills.tracking || s.skills.stalled || s.skills.spend_spike || s.skills.lead_drop)) return;
    const pulse = await checkPulse(this.opts.backend, account.id, { days: 28 });
    const holds = new Set<string>();
    if (s.skills.tracking) {
      const outages = pulse.alarms.filter((a) => a.kind === 'tracking_outage');
      for (const a of outages) holds.add(a.campaignId);
      const starts = new Set(outages.map((a) => a.evidence.dates[a.evidence.highlightFrom]));
      if (outages.length >= 2 && starts.size === 1) holds.add('*');
    }
    w.holds = [...holds];
    const notices: Notice[] = [];
    this.store.update((f) => {
      for (const a of pulse.alarms) {
        const skill = PULSE_SKILL[a.kind];
        if (!s.skills[skill]) continue;
        const key = `pulse:${account.id}:${a.kind}:${a.campaignId}:${a.evidence.dates[a.evidence.highlightFrom] ?? ''}`;
        if (f.sent[key]) continue;
        f.sent[key] = this.iso();
        w.alerts++;
        const level: Level = a.kind === 'tracking_outage' || a.kind === 'stopped_spending' || a.severity === 'high' ? 'urgent' : 'warn';
        const hold = a.kind === 'tracking_outage' && holds.size ? ' Autopilot holds budget, bid and pause changes on this campaign until leads are recorded again.' : '';
        AutopilotStore.push(f, { at: this.iso(), kind: 'alert', level, skill, accountId: account.id, title: a.title, detail: `${a.detail}${hold}`, steps: a.nextSteps });
        const label: Record<PulseAlarm['kind'], string> = { tracking_outage: 'Leads stopped recording', stopped_spending: 'A campaign stopped spending', spend_spike: 'Spend spike', lead_drop: 'Leads dropped' };
        notices.push({ title: label[a.kind], body: a.title.slice(0, 180), url: `/#a=${encodeURIComponent(account.id)}`, tag: `pulse-${a.kind}-${a.campaignId}`, urgent: level === 'urgent' });
      }
    });
    await this.send(notices);
  }

  private async stepScan(account: Account, w: ReviewWork): Promise<void> {
    const s = this.settings();
    const { engine, backend } = this.opts;
    const proposals = engine.store.list();
    const memory = buildMemory(proposals, this.store.load().memory, this.now());
    const campaigns = await backend.listCampaigns(account.id);
    const ctx: ScanContext = { backend, policy: engine.policy, account, campaigns, memory, proposals, now: this.now() };
    const all: Candidate[] = [];

    let report: DiagnosticsReport | undefined;
    if (s.skills.wasted_searches || s.skills.zero_leads || s.skills.budget_winners || s.skills.ad_refresh) report = await runDiagnostics(backend, engine.policy, account.id, 30);
    let ads: Ad[] | undefined;
    if (s.skills.fair_housing || s.skills.ad_refresh) ads = await backend.listAds(account.id);

    if (s.skills.fair_housing && ads) all.push(...(await fairHousingCandidates(ctx, ads)));
    if (report) all.push(...(await findingCandidates(ctx, report, { wasted: s.skills.wasted_searches, zero: s.skills.zero_leads, budget: s.skills.budget_winners })));
    const target = s.monthlyTargets[account.id];
    if (s.skills.pacing && target) {
      const pace = await pacingCandidates(ctx, target);
      all.push(...pace.candidates);
      if (pace.note) {
        const note = pace.note;
        const { day } = this.local(s);
        this.store.update((f) => {
          const key = `pace:${account.id}:${day}`;
          if (f.sent[key]) return;
          f.sent[key] = this.iso();
          AutopilotStore.push(f, { at: this.iso(), kind: 'alert', level: note.level, skill: 'pacing', accountId: account.id, title: note.title, detail: note.detail });
        });
      }
    }
    if (s.skills.ad_refresh && this.opts.brain && ads && report) {
      const spend = new Map(report.overview.campaigns.map((c) => [c.id, c.cost]));
      const c = refreshCandidate(ctx, ads, spend);
      if (c) all.push(c);
    }
    if (s.skills.outcomes) all.push(...(await this.outcomeCandidates(account, campaigns, proposals, memory)));
    w.candidates = this.select(account, campaigns, all, memory, w, s);
  }

  /** Picks what to propose: most important first, nothing already asked or turned down, within the limits. */
  private select(account: Account, campaigns: Campaign[], all: Candidate[], memory: Memory, w: ReviewWork, s: AutopilotSettings): Candidate[] {
    const holds = new Set(w.holds);
    const chosen: Candidate[] = [];
    const targets = new Set<string>();
    const pausing = new Set(memory.pausing);
    for (const c of all) if (c.change.type === 'set_campaign_status' && c.change.newStatus === 'PAUSED' && c.campaignId) pausing.add(c.campaignId);
    let normal = 0;
    let open = memory.openByAutopilot;
    const heldNamed = new Set<string>();
    for (const c of [...all].sort((a, b) => a.priority - b.priority)) {
      const exempt = c.skill === 'fair_housing' || c.skill === 'landing_pages';
      if (!exempt && (holds.has('*') || (c.campaignId && holds.has(c.campaignId)))) {
        const name = holds.has('*') ? account.name : (campaigns.find((x) => x.id === c.campaignId)?.name ?? c.campaignId!);
        if (!heldNamed.has(name)) w.notes.push(`Held changes to ${name} while lead tracking is broken.`);
        heldNamed.add(name);
        continue;
      }
      if (skippedBy(memory, c.insight.keys)) continue;
      const target = `${account.id}|${targetKeyOf(c.change)}`;
      if (memory.openTargets.has(target) || targets.has(target)) continue;
      if (c.change.type === 'set_campaign_budget' && c.campaignId && pausing.has(c.campaignId)) continue;
      if (!c.urgent) {
        if (normal >= s.maxPerRun || open >= MAX_OPEN) continue;
        normal++;
      }
      open++;
      targets.add(target);
      chosen.push(c);
    }
    return chosen;
  }

  // ---------- the AI step ----------

  private takeAiCall(): boolean {
    return this.store.update((f) => {
      const day = dayInZone(this.now(), f.settings.timezone);
      if (f.ai.day !== day) f.ai = { day, calls: 0 };
      if (f.ai.calls >= AI_DAILY_LIMIT) return false;
      f.ai.calls += 1;
      return true;
    });
  }

  private async stepAi(w: ReviewWork): Promise<void> {
    let done = 0;
    for (const c of w.candidates) {
      if (!c.ai) continue;
      if (done >= AI_PER_STEP) break;
      done++;
      await this.resolveAi(c, w);
    }
    w.candidates = w.candidates.filter((c) => !c.drop);
  }

  /** What happens to a candidate when the AI cannot help: rules for searches, the fallback for copy, otherwise nothing. */
  private fallBack(c: Candidate, w: ReviewWork): void {
    const task = c.ai;
    c.ai = undefined;
    if (!task) return;
    if (task.kind === 'search_terms') return;
    if (task.kind === 'rewrite' && c.fallback) {
      c.change = c.fallback;
      c.insight.evidence = [...(c.insight.evidence ?? []), 'The flagged lines are removed and the rest of the ad stays as it is.'];
      return;
    }
    c.drop = true;
    if (task.kind === 'rewrite') this.note(`copy:${task.adId}`, `Ad ${task.adId} needs new copy that passes the Fair Housing screen. Autopilot paused it if needed; ask Claude to write new lines with check_ad_copy.`, 'warn');
    else w.notes.push(`Skipped fuller copy for ad ${task.adId}: the AI is not available.`);
  }

  private async resolveAi(c: Candidate, w: ReviewWork): Promise<void> {
    const task = c.ai as AiTask;
    const brain = this.opts.brain;
    if (!brain || !this.takeAiCall()) return this.fallBack(c, w);
    try {
      if (task.kind === 'search_terms') {
        const answer = await brain.checkTerms({ community: task.community, campaign: task.campaign, examples: task.examples, terms: task.terms.map((t) => t.term) });
        c.ai = undefined;
        if (answer.keep.length) {
          const until = this.iso(this.now() + 30 * DAY);
          this.store.update((f) => {
            for (const k of answer.keep) f.memory[`neg:${c.campaignId}:${k.term}`] = { until, why: `the AI judged it could come from a renter (${k.why || 'no reason given'})` };
          });
        }
        const excluded = task.terms.filter((t) => answer.exclude.includes(t.term));
        if (!excluded.length) {
          c.drop = true;
          w.notes.push(`The AI kept every flagged search in ${task.campaign}: each could come from someone looking for a home.`);
          return;
        }
        const currency = this.accountCurrency(c.accountId);
        const m = (n: number) => money(round2(n), currency);
        const cost = round2(excluded.reduce((s, t) => s + t.cost, 0));
        c.change = { type: 'add_negative_keywords', campaignId: c.campaignId!, keywords: excluded.map((t) => ({ text: t.term, matchType: 'PHRASE' as const })) };
        c.reason = `These searches spent ${m(cost)} in the last 30 days in ${task.campaign} and never brought a lead. The AI double-checked each one: none is about renting a home at ${task.community}.`;
        c.insight.impact = `About ${roughly(cost, currency)} a month saved`;
        c.insight.impactMonthly = cost;
        c.insight.evidence = [...excluded.map((t) => `"${t.term}": ${m(t.cost)}, ${t.clicks} clicks, no leads`), ...answer.keep.map((k) => `Kept "${k.term}": ${k.why || 'could be a renter'}`)].slice(0, 8);
        c.insight.keys = excluded.map((t) => `neg:${c.campaignId}:${t.term}`);
        c.insight.ai = `The AI double-checked ${task.terms.length} searches and cleared ${excluded.length}.`;
        return;
      }
      if (task.kind === 'rewrite') {
        const limits = this.opts.engine.policy.adCopy;
        const ctx: CopyContext = { source: safeSource(task.community, task), existing: [], limits };
        const options = await brain.rewriteLines({ community: task.community, headlines: task.headlines, descriptions: task.descriptions, flagged: task.flagged });
        const change = buildRewrite(task, options, ctx, limits);
        if (!change) return this.fallBack(c, w);
        c.ai = undefined;
        c.change = change;
        c.insight.ai = 'The AI wrote the new lines. Each one passed the Fair Housing screen and uses only facts already in the ad.';
        return;
      }
      const answer = await brain.moreCopy({ community: task.community, headlines: task.headlines, descriptions: task.descriptions, addHeadlines: task.addHeadlines, addDescriptions: task.addDescriptions });
      const ctx: CopyContext = { source: [task.community, ...task.headlines, ...task.descriptions].join('\n'), existing: [...task.headlines, ...task.descriptions], limits: this.opts.engine.policy.adCopy };
      const h = pickLines(answer.headlines, task.addHeadlines, 'headline', ctx);
      const d = pickLines(answer.descriptions, task.addDescriptions, 'description', { ...ctx, existing: [...ctx.existing, ...h.lines] });
      c.ai = undefined;
      if (h.lines.length + d.lines.length < 2) {
        c.drop = true;
        w.notes.push(`Skipped fuller copy for ad ${task.adId}: the AI's lines did not pass the copy checks.`);
        return;
      }
      c.change = { type: 'update_ad_text', adId: task.adId, headlines: [...task.headlines, ...h.lines], descriptions: [...task.descriptions, ...d.lines] };
      const turnedDown = h.rejected.length + d.rejected.length;
      c.insight.ai = `The AI wrote ${h.lines.length + d.lines.length} new lines from what the ad already says.${turnedDown ? ` The copy checks turned down ${turnedDown} more.` : ''}`;
      c.insight.evidence = [...(c.insight.evidence ?? []), ...h.lines.map((l) => `New headline: "${l}"`), ...d.lines.map((l) => `New description: "${l}"`)].slice(0, 8);
    } catch (e) {
      c.ai = task;
      this.note('ai-error', `The free AI did not answer (${(e as Error).message.slice(0, 100)}). Autopilot used its rules instead.`);
      this.fallBack(c, w);
    }
  }

  private currencies = new Map<string, string>();
  private accountCurrency(accountId: string): string {
    return this.currencies.get(accountId) ?? 'USD';
  }

  // ---------- proposing ----------

  private urgentNotice(p: Proposal): Notice {
    return { title: 'Urgent: a change needs you', body: clip(`${p.id}: ${shortTitle(p)}. ${p.insight?.impact ?? ''}`.trim(), 180), url: `/#p=${p.id}`, tag: p.id, urgent: true };
  }

  private async proposeOne(c: Candidate, notes: string[]): Promise<Proposal | undefined> {
    const engine = this.opts.engine;
    try {
      const p = c.rollbackOf
        ? await engine.requestRollback(c.rollbackOf, { reason: c.reason, requestedBy: AUTOPILOT, insight: c.insight })
        : await engine.propose({ accountId: c.accountId, change: c.change, reason: c.reason, requestedBy: AUTOPILOT, insight: c.insight });
      const blocked = p.status === 'blocked';
      this.store.update((f) => {
        AutopilotStore.push(f, {
          at: this.iso(),
          kind: 'found',
          level: blocked ? 'info' : c.urgent ? 'urgent' : 'warn',
          skill: c.skill,
          accountId: c.accountId,
          title: blocked ? `Checked and stopped: ${shortTitle(p)}` : shortTitle(p),
          detail: blocked
            ? `A guardrail stopped it: ${p.checks
                .filter((x) => x.status === 'fail')
                .map((x) => x.detail ?? x.label)
                .join(' ')}`
            : c.insight.impact,
          proposalIds: [p.id],
        });
      });
      return p;
    } catch (e) {
      notes.push(`Could not propose ${skillName(c.skill).toLowerCase()}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async stepPropose(w: ReviewWork): Promise<void> {
    const notices: Notice[] = [];
    let n = 0;
    while (w.candidates.length && n < PROPOSE_PER_STEP) {
      const c = w.candidates.shift()!;
      n++;
      const p = await this.proposeOne(c, w.notes);
      if (!p) continue;
      w.proposed.push(p.id);
      if (c.urgent && p.status === 'pending_approval') {
        notices.push(this.urgentNotice(p));
        w.notified.push(p.id);
      }
    }
    await this.send(notices);
  }

  private async stepFinish(account: Account, w: ReviewWork): Promise<void> {
    const mine = new Set(w.proposed);
    const proposals = this.opts.engine.store.list().filter((p) => mine.has(p.id));
    const waiting = proposals.filter((p) => p.status === 'pending_approval');
    const saving = round2(waiting.reduce((s, p) => s + Math.max(0, p.insight?.impactMonthly ?? 0), 0));
    const m = (n: number) => roughly(n, account.currency);
    const title = waiting.length ? `${waiting.length} change${waiting.length === 1 ? '' : 's'} for you to approve in ${account.name}` : `Nothing needs you in ${account.name}`;
    const parts: string[] = [];
    if (w.alerts) parts.push(`${w.alerts} new alert${w.alerts === 1 ? '' : 's'}.`);
    if (saving > 0) parts.push(`About ${m(saving)} a month to save.`);
    parts.push(...w.notes.slice(0, 5));
    const { day } = this.local();
    this.store.update((f) => {
      AutopilotStore.push(f, { at: this.iso(), kind: 'review', level: waiting.length ? 'warn' : 'good', accountId: account.id, title: `${w.manual ? 'Check' : 'Daily review'}: ${title}`, detail: parts.join(' ') || undefined, proposalIds: waiting.map((p) => p.id) });
      f.reviewed[account.id] = day;
      delete f.work[account.id];
    });
    const rest = waiting.filter((p) => !w.notified.includes(p.id));
    if (rest.length) {
      const one = rest.length === 1;
      await this.send([
        {
          title: one ? `Autopilot: ${rest[0].typeLabel.toLowerCase()} for you to approve` : `Autopilot: ${rest.length} changes for you to approve`,
          body: clip(one ? `${rest[0].id}: ${shortTitle(rest[0])}` : `${saving > 0 ? `About ${m(saving)} a month to save. ` : ''}${rest.map((p) => shortTitle(p)).join('; ')}.`, 180),
          url: one ? `/#p=${rest[0].id}` : '/#approvals',
          tag: `review-${account.id}`,
          urgent: false,
        },
      ]);
    }
  }

  // ---------- results check ----------

  private async outcomeCandidates(account: Account, campaigns: Campaign[], proposals: Proposal[], memory: Memory): Promise<Candidate[]> {
    const now = this.now();
    const judged = this.store.load().outcomes;
    const due = proposals.filter((p) => {
      if (p.accountId !== account.id || p.status !== 'applied' || p.rollbackOf || !p.appliedAt || judged[p.id]) return false;
      const age = now - Date.parse(p.appliedAt);
      return age >= 7 * DAY + 3_600_000 && age <= 35 * DAY;
    });
    if (!due.length) return [];
    if (account.numbers !== 'live') {
      this.store.update((f) => {
        for (const p of due) f.outcomes[p.id] = { at: this.iso(), verdict: 'skipped', title: 'Simulated numbers do not react to changes, so there is nothing to judge.' };
      });
      return [];
    }
    const out: Candidate[] = [];
    const backend = this.opts.backend;
    for (const p of due.slice(0, 5)) {
      const kind = outcomeKind(p.change);
      const skip = !kind || p.insight?.skill === 'fair_housing' || p.insight?.skill === 'landing_pages';
      if (skip) {
        this.store.update((f) => {
          f.outcomes[p.id] = { at: this.iso(), verdict: 'skipped', title: 'Not judged on numbers: it was a safety or compliance change.' };
        });
        continue;
      }
      let campaignId: string | undefined;
      if (p.change.type === 'update_ad_text' || p.change.type === 'set_ad_status') campaignId = (await backend.getAd(account.id, p.change.adId))?.campaignId;
      else campaignId = p.change.campaignId;
      if (!campaignId) continue;
      const appliedDay = dayInZone(Date.parse(p.appliedAt!), account.timezone);
      const series = async (ids: string[]) => {
        const byDate = new Map<string, { date: string; impressions: number; clicks: number; cost: number; conversions: number }>();
        for (const id of ids) {
          for (const r of await backend.getDailyMetrics(account.id, id, 45)) {
            const x = byDate.get(r.date) ?? { date: r.date, impressions: 0, clicks: 0, cost: 0, conversions: 0 };
            x.impressions += r.impressions;
            x.clicks += r.clicks;
            x.cost += r.cost;
            x.conversions += r.conversions;
            byDate.set(r.date, x);
          }
        }
        return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      };
      const ids = kind === 'campaign_paused' ? campaigns.filter((c) => c.id !== campaignId && c.status === 'ENABLED').map((c) => c.id) : [campaignId];
      if (!ids.length) continue;
      const rows = await series(ids);
      const before = totals(rows.filter((r) => r.date < appliedDay).slice(-14));
      const after = totals(rows.filter((r) => r.date > appliedDay));
      const j = judge(kind!, before, after, account.currency);
      const age = now - Date.parse(p.appliedAt!);
      if (j.verdict === 'unclear' && age < 21 * DAY) continue;
      const word = { better: 'worked', same: 'made no clear difference', worse: 'made things worse', unclear: 'cannot be judged yet' }[j.verdict];
      this.store.update((f) => {
        f.outcomes[p.id] = { at: this.iso(), verdict: j.verdict, title: j.why };
        AutopilotStore.push(f, { at: this.iso(), kind: 'outcome', level: j.verdict === 'worse' ? 'warn' : j.verdict === 'better' ? 'good' : 'info', skill: 'outcomes', accountId: account.id, title: `${p.id} ${word}: ${shortTitle(p)}`, detail: j.why, proposalIds: [p.id] });
      });
      if (j.verdict === 'worse' && !memory.skip.has(`undo:${p.id}`)) {
        out.push({
          skill: 'outcomes',
          accountId: account.id,
          campaignId,
          change: inverseOf(p.change, p.before),
          rollbackOf: p.id,
          reason: `A week after ${p.id}: ${j.why} Undoing it restores the setting from before.`,
          insight: { skill: 'outcomes', impact: 'Restores what worked before', evidence: [j.why, `${p.id}: ${p.summary}`], keys: [`undo:${p.id}`] },
          priority: 10,
        });
      }
    }
    return out;
  }

  // ---------- approve means apply ----------

  /** Applies approved changes that could not be applied at the time (a cooldown, the rate limit or Pause all). */
  private async applyApproved(): Promise<void> {
    const engine = this.opts.engine;
    const approved = await engine.listProposals({ status: 'approved', limit: 50 });
    if (!approved.length) return;
    const notices: Notice[] = [];
    for (const p of approved.reverse()) {
      if (!p.approval || Date.parse(p.approval.expiresAt) <= this.now()) continue;
      const signed = (p.approval.evidence as { kind?: string } | undefined)?.kind === 'passkey';
      let outcome;
      try {
        outcome = await engine.apply(p.id, { actor: `${AUTOPILOT}, approved by ${p.approval.by}`, human: true, signedLive: signed });
      } catch {
        continue;
      }
      if (outcome.status === 'applied') {
        this.store.update((f) => {
          AutopilotStore.push(f, { at: this.iso(), kind: 'applied', level: 'good', skill: p.insight?.skill as SkillId | undefined, accountId: p.accountId, title: `Applied and checked: ${shortTitle(p)}`, proposalIds: [p.id] });
        });
        notices.push({ title: 'Applied and verified', body: clip(`${p.id}: ${shortTitle(p)}`, 180), url: `/#p=${p.id}`, tag: p.id, urgent: false });
      } else if (outcome.status === 'failed' || outcome.status === 'verify_failed' || outcome.status === 'conflict') {
        this.store.update((f) => {
          AutopilotStore.push(f, { at: this.iso(), kind: 'applied', level: 'warn', accountId: p.accountId, title: `${p.id} was not applied`, detail: outcome.message, proposalIds: [p.id] });
        });
        notices.push({ title: `${p.id} was not applied`, body: outcome.message.slice(0, 180), url: `/#p=${p.id}`, tag: p.id, urgent: false });
      }
    }
    await this.send(notices);
  }

  // ---------- the report ----------

  async report(): Promise<AutopilotReport> {
    const f = this.store.load();
    const s = f.settings;
    const proposals = this.opts.engine.store.list();
    const since = this.now() - 90 * DAY;
    const applied = proposals.filter((p) => p.status === 'applied' && p.insight && !p.rollbackOf && p.appliedAt && Date.parse(p.appliedAt) >= since);
    const monthly = round2(applied.reduce((sum, p) => sum + Math.max(0, p.insight?.impactMonthly ?? 0), 0));
    const { day, hour } = this.local(s);
    let nextReview: string | undefined;
    let reviewDue = false;
    if (s.on) {
      const all = await this.opts.backend.listAccounts().catch(() => [] as Account[]);
      const mine = all.filter((a) => watches(s, a, all));
      reviewDue = hour >= s.reviewHour && mine.some((a) => f.reviewed[a.id] !== day);
      const nextDay = hour < s.reviewHour ? day : addDays(day, 1);
      nextReview = reviewDue ? this.iso(this.now() + 60 * 60_000) : this.iso(zonedToUtcMs(`${nextDay} ${String(s.reviewHour).padStart(2, '0')}:00:00`, s.timezone));
    }
    return {
      settings: s,
      skills: SKILLS,
      ai: { available: this.hasAi, model: this.opts.brain?.model, callsToday: f.ai.day === day ? f.ai.calls : 0, limit: AI_DAILY_LIMIT },
      status: { on: s.on, running: Object.keys(f.work), lastWatch: f.lastWatch, reviewed: f.reviewed, nextReview, reviewDue, quietNow: inQuiet(s.quiet, hour), held: f.held.length },
      impact: { monthly, applied: applied.length },
      feed: [...f.feed].reverse().slice(0, 80),
      pages: Object.values(f.pages)
        .sort((a, b) => a.url.localeCompare(b.url))
        .slice(0, 20),
    };
  }
}

/** Shortens text at a word boundary for a notification. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}\u2026`;
}

/** Builds the rewritten ad from the AI's options, or undefined if the result would not be clean and complete. */
export function buildRewrite(task: Extract<AiTask, { kind: 'rewrite' }>, options: Array<{ field: string; options: string[] }>, ctx: CopyContext, limits: CopyContext['limits']): Change | undefined {
  const H: Array<string | null> = [...task.headlines];
  const D: Array<string | null> = [...task.descriptions];
  const flaggedText = new Set(task.flagged.map((f) => f.text));
  const others = [...task.headlines, ...task.descriptions].filter((t) => !flaggedText.has(t));
  const added: string[] = [];
  for (const fl of task.flagged) {
    const match = /^(Headline|Description) (\d+)$/.exec(fl.field);
    if (!match) return undefined;
    const kind = match[1] === 'Headline' ? 'headline' : 'description';
    const index = Number(match[2]) - 1;
    const list = kind === 'headline' ? H : D;
    if (index < 0 || index >= list.length) return undefined;
    const pick = pickLines(options.find((o) => o.field === fl.field)?.options ?? [], 1, kind, { ...ctx, existing: [...others, ...added] });
    if (pick.lines.length) {
      list[index] = pick.lines[0];
      added.push(pick.lines[0]);
    } else list[index] = null;
  }
  const headlines = H.filter((x): x is string => x !== null);
  const descriptions = D.filter((x): x is string => x !== null);
  if (headlines.length < limits.minHeadlines || descriptions.length < limits.minDescriptions) return undefined;
  if (lintAd(headlines, descriptions).status !== 'clean') return undefined;
  if (JSON.stringify(headlines) === JSON.stringify(task.headlines) && JSON.stringify(descriptions) === JSON.stringify(task.descriptions)) return undefined;
  return { type: 'update_ad_text', adId: task.adId, headlines, descriptions };
}

