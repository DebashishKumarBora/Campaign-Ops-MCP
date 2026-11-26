import { UserError } from '../types.js';
import type { AutopilotSettings, SkillId, SkillInfo } from './types.js';

/** Everything Autopilot can do, in the order Settings shows it. */
export const SKILLS: SkillInfo[] = [
  { id: 'tracking', name: 'Lead tracking', kind: 'watch', when: 'daily', does: 'Spots when leads stop being recorded while clicks keep coming, and holds changes on that campaign until tracking works again.' },
  { id: 'stalled', name: 'Stalled campaigns', kind: 'watch', when: 'daily', does: 'Tells you when a running campaign suddenly stops spending.' },
  { id: 'spend_spike', name: 'Spend spikes', kind: 'watch', when: 'daily', does: 'Tells you when a campaign spends far more than usual in a day.' },
  { id: 'lead_drop', name: 'Lead drops', kind: 'watch', when: 'daily', does: 'Tells you when leads per click fall well below normal, with the odds it is luck.' },
  { id: 'outside_changes', name: 'Outside changes', kind: 'watch', when: 'hourly', does: "Reads Google's own change history every hour. Edits by people are listed; a robot change nobody approved raises the alarm." },
  { id: 'ad_policy', name: 'Ad approvals', kind: 'watch', when: 'hourly', does: 'Checks every hour whether Google disapproved or limited one of your ads.', needs: 'Google Ads accounts' },
  { id: 'landing_pages', name: 'Landing pages', kind: 'fix', when: 'hourly', does: 'Opens your ad pages every hour. If one is down, it proposes pausing the campaign that sends people there, and turning it back on once the page is back.' },
  { id: 'fair_housing', name: 'Fair Housing copy', kind: 'fix', when: 'daily', ai: true, does: 'Screens every ad. Risky copy gets an immediate pause, then compliant replacement copy, then the ad back on.' },
  { id: 'wasted_searches', name: 'Wasted searches', kind: 'fix', when: 'daily', ai: true, does: 'Finds searches that cost money and never bring a lead, double-checks them with the AI and proposes blocking them. Searches tied to a protected group are never blocked.' },
  { id: 'zero_leads', name: 'Spend without leads', kind: 'fix', when: 'daily', does: 'Proposes pausing a campaign that spends for weeks without a single lead.' },
  { id: 'budget_winners', name: 'Budget for winners', kind: 'fix', when: 'daily', does: 'Raises the budget of a campaign that brings cheap leads but runs out of money every day.' },
  { id: 'pacing', name: 'Monthly pacing', kind: 'fix', when: 'daily', does: 'Keeps spend on track for a monthly target you set, trimming the least efficient campaigns first.', needs: 'A monthly target for the account' },
  { id: 'ad_refresh', name: 'Fuller ads', kind: 'fix', when: 'daily', ai: true, does: 'Gives thin ads more headlines and descriptions, written by the AI only from facts already in the ad.', needs: 'The free AI (in the cloud)' },
  { id: 'outcomes', name: 'Results check', kind: 'fix', when: 'daily', does: 'Looks at every change a week later. If it made things worse, it proposes the undo.', needs: 'Live accounts with real numbers' },
];

export const SKILL_IDS = SKILLS.map((s) => s.id);

export function skillName(id: string): string {
  return SKILLS.find((s) => s.id === id)?.name ?? id;
}

export const DEFAULT_TIMEZONE = 'America/Chicago';

export function defaultSettings(): AutopilotSettings {
  return {
    on: true,
    reviewHour: 7,
    timezone: DEFAULT_TIMEZONE,
    quiet: { on: true, from: 22, to: 7, urgentAnyway: true },
    skills: Object.fromEntries(SKILL_IDS.map((id) => [id, true])) as Record<SkillId, boolean>,
    monthlyTargets: {},
    accounts: {},
    maxPerRun: 6,
  };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

const hour = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new UserError(`${name} must be a whole hour from 0 to 23.`);
  return n;
};

/** Fills gaps in stored settings (a skill added in a later version starts on). */
export function completeSettings(stored: Partial<AutopilotSettings> | undefined): AutopilotSettings {
  const d = defaultSettings();
  if (!stored || typeof stored !== 'object') return d;
  const skills = { ...d.skills };
  for (const id of SKILL_IDS) if (typeof stored.skills?.[id] === 'boolean') skills[id] = stored.skills[id];
  return {
    ...d,
    ...stored,
    quiet: { ...d.quiet, ...(stored.quiet ?? {}) },
    skills,
    monthlyTargets: { ...(stored.monthlyTargets ?? {}) },
    accounts: { ...(stored.accounts ?? {}) },
  };
}

/**
 * Applies a change from the console to the current settings, checking every
 * value. Unknown fields are ignored; a wrong value is refused with a message
 * the person can act on.
 */
export function applySettingsPatch(current: AutopilotSettings, patch: unknown): AutopilotSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new UserError('Send the settings to change as an object.');
  const p = patch as Record<string, unknown>;
  const next: AutopilotSettings = structuredClone(current);
  if ('on' in p) {
    if (typeof p.on !== 'boolean') throw new UserError('"on" must be true or false.');
    next.on = p.on;
  }
  if ('reviewHour' in p) next.reviewHour = hour(p.reviewHour, 'The daily review time');
  if ('timezone' in p) {
    const tz = String(p.timezone ?? '').trim();
    if (!tz || tz.length > 60 || !validTimeZone(tz)) throw new UserError('Choose a time zone from the list, for example America/Chicago.');
    next.timezone = tz;
  }
  if ('quiet' in p) {
    const q = p.quiet as Record<string, unknown> | null;
    if (!q || typeof q !== 'object') throw new UserError('Quiet hours must be an object.');
    if ('on' in q) {
      if (typeof q.on !== 'boolean') throw new UserError('Quiet hours "on" must be true or false.');
      next.quiet.on = q.on;
    }
    if ('from' in q) next.quiet.from = hour(q.from, 'Quiet hours start');
    if ('to' in q) next.quiet.to = hour(q.to, 'Quiet hours end');
    if ('urgentAnyway' in q) {
      if (typeof q.urgentAnyway !== 'boolean') throw new UserError('"urgentAnyway" must be true or false.');
      next.quiet.urgentAnyway = q.urgentAnyway;
    }
  }
  if ('skills' in p) {
    const s = p.skills as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') throw new UserError('Skills must be an object of true or false values.');
    for (const [id, on] of Object.entries(s)) {
      if (!SKILL_IDS.includes(id as SkillId)) throw new UserError(`There is no skill called ${id}.`);
      if (typeof on !== 'boolean') throw new UserError(`Skill ${id} must be true or false.`);
      next.skills[id as SkillId] = on;
    }
  }
  if ('monthlyTargets' in p) {
    const t = p.monthlyTargets as Record<string, unknown> | null;
    if (!t || typeof t !== 'object') throw new UserError('Monthly targets must be an object of account IDs and amounts.');
    for (const [accountId, value] of Object.entries(t)) {
      if (!/^[A-Za-z0-9-]{3,40}$/.test(accountId)) throw new UserError('Unknown account in monthly targets.');
      if (value === null || value === 0 || value === '') {
        delete next.monthlyTargets[accountId];
        continue;
      }
      const n = Math.round(Number(value) * 100) / 100;
      if (!Number.isFinite(n) || n < 10 || n > 10_000_000) throw new UserError('A monthly target must be between 10 and 10,000,000.');
      next.monthlyTargets[accountId] = n;
    }
  }
  if ('accounts' in p) {
    const a = p.accounts as Record<string, unknown> | null;
    if (!a || typeof a !== 'object') throw new UserError('Accounts must be an object of account IDs and true or false.');
    for (const [accountId, on] of Object.entries(a)) {
      if (!/^[A-Za-z0-9-]{3,40}$/.test(accountId)) throw new UserError('Unknown account.');
      if (typeof on !== 'boolean') throw new UserError('Each account must be true or false.');
      next.accounts[accountId] = on;
    }
  }
  if ('maxPerRun' in p) {
    const n = Number(p.maxPerRun);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new UserError('Changes per review must be from 1 to 10.');
    next.maxPerRun = n;
  }
  return next;
}

/** Whether Autopilot looks after this account (see AutopilotSettings.accounts). */
export function watches(settings: AutopilotSettings, account: { id: string; mode: string }, all: Array<{ mode: string }>): boolean {
  const chosen = settings.accounts[account.id];
  if (typeof chosen === 'boolean') return chosen;
  return account.mode !== 'sandbox' || all.every((a) => a.mode === 'sandbox');
}

/** True when the hour (0 to 23) is inside quiet hours. A window can cross midnight, for example 22 to 7. */
export function inQuiet(q: AutopilotSettings['quiet'], hourNow: number): boolean {
  if (!q.on || q.from === q.to) return false;
  return q.from < q.to ? hourNow >= q.from && hourNow < q.to : hourNow >= q.from || hourNow < q.to;
}
