/**
 * The Campaign Ops app as a live demo, running entirely in the browser.
 *
 * This is the same approval app the cloud and the local console serve
 * (console-ui/app.js), on top of the same engine, sandbox, Autopilot and
 * console API. Only three things differ from the real thing:
 *   - the file system lives in memory (web/shims), so a reload starts fresh
 *   - the page's requests to /api/... are answered here instead of a server
 *   - the AI's words are pre-written (in the cloud, Workers AI writes them),
 *     and notifications appear inside the page instead of on a phone
 */
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { Autopilot } from '../src/autopilot/autopilot.js';
import { ConsoleApi } from '../src/console/api.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { UserError } from '../src/types.js';
import type { AiBrain } from '../src/autopilot/ai.js';
import type { Notice } from '../src/autopilot/types.js';
import * as memfs from './shims/fs.js';
import pkg from '../package.json';

const DATA = '/demo';
const WHO = 'You (demo)';

// ---------- the AI's words, pre-written for the sandbox's planted problems ----------

/** Replacement lines for the sandbox ad that breaks Fair Housing rules. Each passes the same copy checks the AI's lines must pass. */
const REWRITES: Record<string, string[]> = {
  'Ideal for Young Professionals': ['Resort-Style Pool Community', 'Modern Downtown Studios'],
  'Quiet adults-only community near downtown with a resort-style pool.': [
    'Community near downtown with a resort-style pool.',
    'Studios near downtown with a resort-style pool and modern finishes.',
  ],
};

const demoBrain: AiBrain = {
  model: 'demo (pre-written)',
  async checkTerms({ terms }) {
    // A search someone moving in might type is kept; the rest are cleared to block.
    const keep = terms.filter((t) => /furniture|moving|storage/i.test(t));
    return { exclude: terms.filter((t) => !keep.includes(t)), keep: keep.map((term) => ({ term, why: 'Someone moving in may search for this.' })) };
  },
  async rewriteLines({ flagged }) {
    return flagged.map((f) => ({ field: f.field, options: REWRITES[f.text] ?? [] }));
  },
  async moreCopy({ headlines, descriptions, addHeadlines, addDescriptions }) {
    // Only reshuffles what the ad already says, so no new facts appear.
    const words = [...headlines, ...descriptions].join(' ');
    const lines: string[] = [];
    if (/downtown/i.test(words) && /studio/i.test(words)) lines.push('Downtown Studios');
    if (/tour/i.test(words)) lines.push('Tour Today');
    if (/leasing/i.test(words)) lines.push('Now Leasing');
    return { headlines: lines.slice(0, addHeadlines), descriptions: descriptions.slice(0, Math.min(1, addDescriptions)).map((d) => d.replace(/\s+/g, ' ')) };
  },
};

// ---------- notifications, drawn inside the page ----------

type Shown = (n: Notice) => void;
let showNotice: Shown = () => undefined;
const heldAtStart: Notice[] = [];
let started = false;

function notify(notices: Notice[]): void {
  if (!started) {
    heldAtStart.push(...notices);
    return;
  }
  // The most important one is enough; a phone would stack the rest.
  const top = notices.find((n) => n.urgent) ?? notices[0];
  if (top) showNotice(top);
}

// ---------- the stack ----------

memfs.reset();
const backend = new SandboxBackend(`${DATA}/sandbox.json`);
backend.ensure();
const engine = new Engine({ backend, dataDir: DATA, policy: DEFAULT_POLICY, scope: 'execute' });
const autopilot = new Autopilot({ engine, backend, dataDir: DATA, brain: demoBrain, notify, fetchPage: async () => ({ status: 200 }) });
const api = new ConsoleApi({ engine, backend, version: String((pkg as { version?: string }).version ?? '0.0.0'), autopilot });

/** One request at a time, the way a small server would answer them. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sandbox's history before the visitor arrives: two attempts the guardrails stopped, then a morning review. */
async function seed(): Promise<void> {
  const account = (await backend.listAccounts())[0];
  let zone = 'America/Chicago';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || zone;
  } catch {
    // keep the default
  }
  await autopilot.updateSettings({ timezone: zone, quiet: { on: false } }, 'demo setup');
  // What an AI agent tried earlier, and the guardrails refused.
  await engine.propose({
    accountId: account.id,
    change: { type: 'set_campaign_budget', campaignId: 'c-201', newDailyBudget: 150 },
    reason: 'Northlight Lofts brand searches convert well, so spend six times more on them every day.',
    requestedBy: 'Claude',
  });
  await engine.propose({
    accountId: account.id,
    change: {
      type: 'update_ad_text',
      adId: 'a-2011',
      headlines: ['Northlight Lofts', 'Adults Only Loft Living', 'Lofts Near Light Rail', 'Book a Tour Today'],
      descriptions: ['Quiet adults only lofts near light rail.', 'Exposed brick and tall windows. Book a tour today.'],
    },
    reason: 'Residents here say they like the quiet, so say it in the ad.',
    requestedBy: 'Claude',
  }).catch(() => undefined);
  // This morning's review, as if it ran at the usual hour.
  await autopilot.runAll(await autopilot.checkNow(account.id));
}

const ready = serial(seed);

// ---------- answering the app's requests ----------

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function answer(method: string, url: URL, raw: unknown): Promise<Response> {
  await ready;
  if (url.pathname === '/mode') return reply(200, { mode: 'demo' });
  let body: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return reply(400, { error: 'That request was not valid JSON.' });
    }
  }
  // Changes take a moment, as they would against Google; reading is instant.
  if (method === 'POST') await wait(url.pathname.endsWith('/check') ? 900 : 420);
  try {
    const out = await serial(() => api.handle({ method, pathname: url.pathname, query: url.searchParams, body, who: WHO }));
    return out ? reply(out.status, out.body) : reply(404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof UserError) return reply(400, { error: e.message });
    console.error(e);
    return reply(500, { error: 'Something went wrong in the demo. Reload to start again.' });
  }
}

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, location.href);
  if (url.origin === location.origin && (url.pathname === '/mode' || url.pathname.startsWith('/api/'))) {
    return answer(String(init?.method || 'GET').toUpperCase(), url, init?.body);
  }
  return realFetch(input as RequestInfo, init);
};

/** Hooks for the page: draw a notification, and replay the one from this morning's review once the app is up. */
export function onNotice(fn: Shown): void {
  showNotice = fn;
}
export async function start(): Promise<void> {
  await ready;
  started = true;
  // The urgent one first: it opens straight onto the change that needs a person.
  const first = heldAtStart.find((n) => n.urgent && /#p=/.test(n.url)) ?? heldAtStart.find((n) => /approve/i.test(n.title)) ?? heldAtStart[0];
  heldAtStart.length = 0;
  if (first) showNotice(first);
}
export const version = String((pkg as { version?: string }).version ?? '0.0.0');
