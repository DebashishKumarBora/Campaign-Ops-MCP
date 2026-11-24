import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Policy, Scope } from './types.js';
import { projectRoot } from './util/root.js';
import { ensureDir } from './util/fsx.js';

export const DEFAULT_POLICY: Policy = {
  approvals: { approvalTtlMinutes: 60, proposalTtlHours: 24 },
  budgets: { maxIncreasePct: 30, maxDecreasePct: 50, minCampaignDailyBudget: 5, maxCampaignDailyBudget: 250, maxAccountDailyTotal: 400 },
  rateLimits: { maxAppliedPerHour: 10, maxAppliedPerDay: 40, entityCooldownMinutes: 30 },
  negatives: { maxPerProposal: 20, maxConversionsBlockedPct: 20 },
  adCopy: { headlineMaxChars: 30, descriptionMaxChars: 90, minHeadlines: 3, maxHeadlines: 15, minDescriptions: 2, maxDescriptions: 4 },
  status: { allowPause: true, allowEnable: true },
};

const num = (min: number, max: number) => z.number().min(min).max(max);

const PolicySchema = z.object({
  approvals: z.object({ approvalTtlMinutes: num(1, 1440), proposalTtlHours: num(1, 168) }),
  budgets: z.object({
    maxIncreasePct: num(1, 200),
    maxDecreasePct: num(1, 100),
    minCampaignDailyBudget: num(0.01, 100000),
    maxCampaignDailyBudget: num(1, 1000000),
    maxAccountDailyTotal: num(1, 10000000),
  }),
  rateLimits: z.object({ maxAppliedPerHour: num(1, 1000), maxAppliedPerDay: num(1, 10000), entityCooldownMinutes: num(0, 1440) }),
  negatives: z.object({ maxPerProposal: num(1, 200), maxConversionsBlockedPct: num(0, 100) }),
  adCopy: z.object({
    headlineMaxChars: num(1, 90),
    descriptionMaxChars: num(1, 200),
    minHeadlines: num(1, 15),
    maxHeadlines: num(1, 15),
    minDescriptions: num(1, 4),
    maxDescriptions: num(1, 4),
  }),
  status: z.object({ allowPause: z.boolean(), allowEnable: z.boolean() }),
});

export interface AppConfig {
  root: string;
  dataDir: string;
  scope: Scope;
  consolePort: number;
  consoleToken: string;
  forceKillSwitch: boolean;
  policy: Policy;
  policySource: string;
}

/** Minimal .env reader so the project needs no extra dependency. Real environment variables win. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[key] === undefined) env[key] = value;
  }
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (k.startsWith('$') || k.startsWith('_')) continue; // allow "$comment"-style notes in policy.json
    const current = out[k];
    out[k] = current && typeof current === 'object' && !Array.isArray(current) ? deepMerge(current, v) : v;
  }
  return out as T;
}

export function loadPolicy(file: string): { policy: Policy; source: string } {
  if (!fs.existsSync(file)) return { policy: DEFAULT_POLICY, source: 'built-in defaults' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`policy.json is not valid JSON: ${(e as Error).message}`);
  }
  const merged = deepMerge(DEFAULT_POLICY, parsed);
  const result = PolicySchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`policy.json has invalid values: ${issues}`);
  }
  const policy = result.data as Policy;
  if (policy.adCopy.minHeadlines > policy.adCopy.maxHeadlines || policy.adCopy.minDescriptions > policy.adCopy.maxDescriptions) {
    throw new Error('policy.json: minimum counts cannot be larger than maximum counts.');
  }
  return { policy, source: path.basename(file) };
}

function readOrCreateToken(dataDir: string): string {
  const file = path.join(dataDir, 'console-token.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 24) return existing;
  } catch {
    // create below
  }
  ensureDir(dataDir);
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = projectRoot();
  loadDotEnv(path.join(root, '.env'), env);

  const dataDir = env.CAMPAIGN_OPS_DATA_DIR?.trim() ? path.resolve(root, env.CAMPAIGN_OPS_DATA_DIR.trim()) : path.join(root, 'data');
  ensureDir(dataDir);

  const scopeRaw = (env.CAMPAIGN_OPS_SCOPE ?? 'execute').trim().toLowerCase();
  if (!['read', 'propose', 'execute'].includes(scopeRaw)) throw new Error(`CAMPAIGN_OPS_SCOPE must be read, propose or execute (got "${scopeRaw}").`);

  const portRaw = (env.CAMPAIGN_OPS_CONSOLE_PORT ?? '4848').trim();
  const consolePort = Number(portRaw);
  if (!Number.isInteger(consolePort) || consolePort < 0 || consolePort > 65535) throw new Error(`CAMPAIGN_OPS_CONSOLE_PORT must be a port number or 0 (got "${portRaw}").`);

  const tokenFromEnv = env.CAMPAIGN_OPS_CONSOLE_TOKEN?.trim();
  if (tokenFromEnv && tokenFromEnv.length < 16) throw new Error('CAMPAIGN_OPS_CONSOLE_TOKEN must be at least 16 characters.');

  const policyFile = env.CAMPAIGN_OPS_POLICY_FILE?.trim() ? path.resolve(root, env.CAMPAIGN_OPS_POLICY_FILE.trim()) : path.join(root, 'policy.json');
  const { policy, source } = loadPolicy(policyFile);

  return {
    root,
    dataDir,
    scope: scopeRaw as Scope,
    consolePort,
    consoleToken: tokenFromEnv || readOrCreateToken(dataDir),
    forceKillSwitch: ['1', 'true', 'yes', 'on'].includes((env.CAMPAIGN_OPS_KILL_SWITCH ?? '').trim().toLowerCase()),
    policy,
    policySource: source,
  };
}
