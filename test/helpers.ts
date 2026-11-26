import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { DEFAULT_POLICY } from '../src/config.js';
import type { Change, Policy, Scope } from '../src/types.js';

export const ACCOUNT = '123-456-7890';
export const AGENT = 'agent (test)';
export const PERSON = 'person (test)';

export interface TestRig {
  dir: string;
  backend: SandboxBackend;
  engine: Engine;
  clock: { now: number; advanceMinutes(m: number): void };
  cleanup(): void;
}

export function tempDir(prefix = 'campaign-ops-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeRig(opts: { policy?: Partial<Policy>; scope?: Scope; forceKillSwitch?: boolean; dir?: string; realTime?: boolean } = {}): TestRig {
  const dir = opts.dir ?? tempDir();
  const clock = {
    now: Date.parse('2026-11-21T15:00:00Z'),
    advanceMinutes(m: number) {
      this.now += m * 60_000;
    },
  };
  const backend = new SandboxBackend(path.join(dir, 'sandbox.json'), { clock: opts.realTime ? undefined : () => clock.now });
  backend.ensure({ endDate: '2026-11-20' });
  const policy: Policy = { ...structuredClone(DEFAULT_POLICY), ...(opts.policy ?? {}) } as Policy;
  const engine = new Engine({ backend, dataDir: dir, policy, scope: opts.scope ?? 'execute', forceKillSwitch: opts.forceKillSwitch, clock: opts.realTime ? undefined : () => clock.now });
  return { dir, backend, engine, clock, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const budgetChange = (newDailyBudget: number, campaignId = 'c-202'): Change => ({ type: 'set_campaign_budget', campaignId, newDailyBudget });

export const WASTE_TERMS = ['apartment jobs', 'how to become a leasing agent', 'storage units near me', 'apartment cleaning services', 'free furniture pickup'];

export const wasteNegatives = (): Change => ({
  type: 'add_negative_keywords',
  campaignId: 'c-102',
  keywords: WASTE_TERMS.map((text) => ({ text, matchType: 'PHRASE' as const })),
});

export const COMPLIANT_COPY: Change = {
  type: 'update_ad_text',
  adId: 'a-3011',
  headlines: ['Ashgrove Commons', 'Downtown Studios and 1 Beds', 'Resort-Style Pool', 'Book a Tour Today'],
  descriptions: ['Quiet community near downtown with a resort-style pool and modern finishes.', 'Studios and 1 bedrooms with modern finishes. Schedule your tour today.'],
};

export const REASON = 'Test reason with enough words to explain the change.';
