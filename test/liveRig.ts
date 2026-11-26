import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeGoogleAds, type FakeDay } from './fakeGoogleAds.js';
import { ServiceAccountAuth } from '../src/backends/googleAds/auth.js';
import { GoogleAdsClient } from '../src/backends/googleAds/client.js';
import { GoogleAdsBackend } from '../src/backends/googleAds/backend.js';
import { seedAccount } from '../src/backends/googleAds/seeder.js';
import { RouterBackend } from '../src/backends/router.js';
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { addDays } from '../src/util/format.js';

/**
 * A live (production) Google Ads account in the fake API, reached by a Cloud
 * project with Explorer access, next to the sandbox. Shared by the live,
 * console and MCP tests.
 */
export const MGR = '5550001111';
export const LIVE = '5550002222';
export const LIVE_D = '555-000-2222';
export const START = Date.parse('2026-11-21T15:00:00Z'); // 9:00 AM in Chicago
export const person = { by: 'Deb', channel: 'console' as const };
export const REASON = 'A clear reason with enough words for the person approving.';

export async function liveRig(opts: { direct?: boolean } = {}) {
  const fake = new FakeGoogleAds();
  fake.accessLevel = 'explorer';
  fake.addCustomer({ id: MGR, name: 'Acme Agency', manager: true, testAccount: false });
  fake.addCustomer({ id: LIVE, name: 'Acme Apartments', parent: MGR, testAccount: false });
  fake.accessible = opts.direct ? [LIVE] : [MGR];
  const clock = {
    now: START,
    advanceMinutes(m: number) {
      this.now += m * 60_000;
    },
  };
  fake.now = () => clock.now;
  const auth = new ServiceAccountAuth(fake.serviceAccountKey(), fake.fetch);
  const login = opts.direct ? LIVE : MGR;

  // The campaigns already exist in a live account; people built them, not the robot.
  const builder = new GoogleAdsClient({ auth, apiVersion: 'v26', loginCustomerId: login, fetchImpl: fake.fetch, sleep: async () => undefined });
  await seedAccount(builder, LIVE);
  fake.account(LIVE).events.length = 0;

  const client = new GoogleAdsClient({ auth, apiVersion: 'v26', fetchImpl: fake.fetch, sleep: async () => undefined });
  const google = new GoogleAdsBackend({
    settings: { keyFile: 'unused', managerId: '', apiVersion: 'v26', accounts: [{ id: LIVE_D, name: 'Acme Apartments', currency: 'USD', timezone: 'America/Chicago', testAccount: false, loginCustomerId: login }] },
    client,
    now: () => new Date(clock.now),
    cacheMs: 0,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cops-live-'));
  const sandbox = new SandboxBackend(path.join(dir, 'sandbox.json'), { clock: () => clock.now });
  sandbox.ensure({ endDate: '2026-11-20' });
  const router = new RouterBackend([sandbox, google]);
  const engine = new Engine({ backend: router, dataDir: dir, policy: DEFAULT_POLICY, scope: 'execute', clock: () => clock.now });
  const campaign = async (name: string) => (await google.listCampaigns(LIVE_D)).find((c) => c.name === name)!;
  return { fake, clock, google, router, engine, dir, campaign, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 28 ordinary days, then whatever the test needs at the end. */
export function days(end: string, n: number, make: (i: number) => Partial<FakeDay>): FakeDay[] {
  const out: FakeDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = n - 1 - i;
    out.push({ date: addDays(end, -i), impressions: 400, clicks: 40, cost: 80, conversions: 3, ...make(k) });
  }
  return out;
}

